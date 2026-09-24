import type { MarketHistory } from './backtest.js';
import { MarketData } from './market-data.js';
import { buildGrid, type Trial } from './optimizer.js';
import { normaliseConfig } from './backtest-runner.js';
import { loadReplayTimingHistory, replayWarmupStarts, REPLAY_WARMUP_BARS } from './replay-warmup.js';
import { runWorkerJob } from './worker-runner.js';
import type { BacktestConfig, OptimizeStatus, RiskConfig } from './types.js';

/**
 * Ceiling on total replay work per search, in bar-evaluations.
 *
 * A search is candidates x markets x bars, which grows fast enough to exhaust
 * memory and take the service down with it. When a request would exceed this,
 * the candidate grid is thinned rather than the run being refused — a coarser
 * search still answers the question, a dead process does not.
 */
const MAX_WORK = 120_000_000;

/** Never thin the grid below this — fewer candidates is not a search. */
const MIN_CANDIDATES = 24;

/**
 * Loads history once, then searches parameter combinations against it.
 *
 * The data download is the expensive part, so it happens a single time and every
 * candidate is scored against the same in-memory candles.
 */
export class OptimizerRunner {
  private status: OptimizeStatus = {
    state: 'idle',
    message: 'Nog geen optimalisatie gedraaid',
    progress: 0,
    trials: [],
    best: null,
  };

  private running = false;

  constructor(private readonly market: MarketData) {}

  /** Progress and results of the most recent search. */
  get state(): OptimizeStatus {
    return this.status;
  }

  /**
   * Start a parameter search.
   *
   * @param config the window and markets to optimise over.
   * @param candidateLimit how many parameter sets to try.
   * @throws when a search is already running.
   */
  start(config: Partial<BacktestConfig>, candidateLimit = 160): void {
    if (this.running) throw new Error('er draait al een optimalisatie');
    const normalised = normaliseConfig(config);
    this.running = true;
    this.status = {
      state: 'loading',
      message: 'Historische candles ophalen…',
      progress: 0,
      trials: [],
      best: null,
    };
    void this.execute(normalised, candidateLimit);
  }

  private async execute(config: BacktestConfig, candidateLimit: number): Promise<void> {
    try {
      const { entryFrom, higherFrom } = replayWarmupStarts(
        config.from,
        config.interval,
        config.higherInterval
      );
      const markets: MarketHistory[] = [];

      for (let i = 0; i < config.symbols.length; i += 1) {
        const symbol = config.symbols[i];
        this.status = {
          ...this.status,
          message: `Candles ophalen voor ${symbol} (${i + 1}/${config.symbols.length})`,
          progress: (i / config.symbols.length) * 0.25,
        };
        const [candles, higher] = await Promise.all([
          this.market.history(symbol, config.interval, entryFrom, config.to),
          this.market.history(symbol, config.higherInterval, higherFrom, config.to).catch(() => []),
        ]);
        if (candles.length < REPLAY_WARMUP_BARS + 10) continue;
        const timing = await loadReplayTimingHistory(
          this.market.history.bind(this.market),
          symbol,
          config.from,
          config.to,
          [
            { interval: config.interval, from: entryFrom, to: config.to, candles },
            { interval: config.higherInterval, from: higherFrom, to: config.to, candles: higher },
          ]
        );
        markets.push({ symbol, candles, higher, ...timing });
      }

      if (!markets.length) {
        this.fail('Geen bruikbare historische data voor deze markten en periode');
        return;
      }

      // Size the grid to the data actually loaded. Both windows get replayed per
      // candidate, so the cost is roughly two full passes over every bar.
      const totalBars = markets.reduce((a, m) => a + m.candles.length, 0);
      const perCandidate = Math.max(1, totalBars * 2);
      const affordable = Math.max(MIN_CANDIDATES, Math.floor(MAX_WORK / perCandidate));
      const grid = buildGrid(Math.min(candidateLimit, affordable));
      if (grid.length < candidateLimit) {
        this.status = {
          ...this.status,
          message: `Grote dataset — zoektocht teruggebracht naar ${grid.length} combinaties`,
        };
      }

      // Train on the first 65%, validate on the last 35% the search never sees.
      const splitAt = config.from + Math.floor((config.to - config.from) * 0.65);

      this.status = {
        ...this.status,
        state: 'running',
        message: `0 / ${grid.length} combinaties getest`,
        progress: 0.25,
      };

      // Run on a worker thread — hundreds of candidate backtests would otherwise
      // freeze the live trading loop and the dashboard for the whole search.
      const done = await runWorkerJob(
        { kind: 'optimize', markets, config, grid, splitAt },
        (d, total) => {
          this.status = {
            ...this.status,
            message: `${d} / ${total} combinaties getest`,
            progress: 0.25 + (d / total) * 0.75,
          };
        }
      );
      if (done.kind !== 'optimize') throw new Error('onverwacht workerresultaat');
      const ranked: Trial[] = done.trials;
      const best = done.best;
      this.status = {
        state: 'done',
        message: best
          ? `Beste combinatie: ${best.testResult.expectancyR.toFixed(2)}R per trade out-of-sample`
          : 'Geen enkele combinatie leverde bruikbare resultaten op',
        progress: 1,
        trials: ranked,
        best,
      };
    } catch (err) {
      this.fail((err as Error).message);
    } finally {
      this.running = false;
    }
  }

  private fail(message: string): void {
    this.status = { state: 'error', message, progress: 1, trials: [], best: null };
  }
}

/** The parameters of the best trial, ready to apply to the live engine. */
export function bestParams(status: OptimizeStatus): Partial<RiskConfig> | null {
  return status.best ? status.best.params : null;
}
