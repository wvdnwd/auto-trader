import { type MarketHistory } from './backtest.js';
import { MarketData } from './market-data.js';
import { runWorkerJob } from './worker-runner.js';
import type { BacktestConfig, BacktestStatus } from './types.js';

/** Bars of history loaded before the window so indicators are warmed up. */
const WARMUP_BARS = 80;

/** Interval lengths in seconds. */
const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Min60: 3600,
  Hour4: 14_400,
  Day1: 86_400,
};

/**
 * Loads historical data and runs backtests in the background.
 *
 * A run can take a while — the data download dominates — so the runner keeps a
 * single run in flight and exposes its progress for the dashboard to poll.
 */
export class BacktestRunner {
  private status: BacktestStatus = {
    state: 'idle',
    message: 'Nog geen backtest gedraaid',
    progress: 0,
    result: null,
  };

  private running = false;

  constructor(private readonly market: MarketData) {}

  /** Current progress and result of the most recent run. */
  get state(): BacktestStatus {
    return this.status;
  }

  /**
   * Start a backtest. Returns immediately; poll {@link state} for progress.
   *
   * @param config the run parameters.
   * @throws when a run is already in flight or the config is invalid.
   */
  start(config: BacktestConfig): void {
    if (this.running) throw new Error('er draait al een backtest');
    const normalised = normaliseConfig(config);
    this.running = true;
    this.status = {
      state: 'loading',
      message: 'Historische candles ophalen…',
      progress: 0,
      result: null,
    };
    void this.execute(normalised);
  }

  private async execute(config: BacktestConfig): Promise<void> {
    try {
      const step = INTERVAL_SECONDS[config.interval] || 900;
      const warmupFrom = config.from - step * WARMUP_BARS;
      const markets: MarketHistory[] = [];

      for (let i = 0; i < config.symbols.length; i += 1) {
        const symbol = config.symbols[i];
        this.status = {
          ...this.status,
          message: `Candles ophalen voor ${symbol} (${i + 1}/${config.symbols.length})`,
          progress: (i / config.symbols.length) * 0.8,
        };
        const [candles, higher] = await Promise.all([
          this.market.history(symbol, config.interval, warmupFrom, config.to),
          this.market
            .history(symbol, config.higherInterval, warmupFrom, config.to)
            .catch(() => []),
        ]);
        // A market without enough history would silently contribute nothing,
        // so it is dropped with a visible reason instead.
        if (candles.length < WARMUP_BARS + 10) continue;
        markets.push({ symbol, candles, higher });
      }

      if (!markets.length) {
        this.finishWithError('Geen bruikbare historische data voor deze markten en periode');
        return;
      }

      this.status = {
        ...this.status,
        state: 'running',
        message: `Replay van ${markets.length} markten…`,
        progress: 0.85,
      };

      // Run on a worker thread — this replay can take seconds, and it must never
      // block the live trading loop or the dashboard API on the main thread.
      const done = await runWorkerJob({ kind: 'backtest', markets, config }, () => {});
      if (done.kind !== 'backtest') throw new Error('onverwacht workerresultaat');
      const result = done.result;
      this.status = {
        state: 'done',
        message: `Klaar — ${result.trades} trades over ${markets.length} markten`,
        progress: 1,
        result,
      };
    } catch (err) {
      this.finishWithError((err as Error).message);
    } finally {
      this.running = false;
    }
  }

  private finishWithError(message: string): void {
    this.status = { state: 'error', message, progress: 1, result: null };
  }
}

/**
 * Validate and fill in a backtest configuration.
 *
 * @param config raw config, typically straight off an HTTP request.
 * @returns a config safe to run.
 * @throws when the window or symbol list is unusable.
 */
export function normaliseConfig(config: Partial<BacktestConfig>): BacktestConfig {
  const symbols = (config.symbols || [])
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .slice(0, 12);
  if (!symbols.length) throw new Error('kies minstens één markt');

  const interval = config.interval || 'Min15';
  const step = INTERVAL_SECONDS[interval];
  if (!step) throw new Error(`onbekend interval ${interval}`);

  const now = Math.floor(Date.now() / 1000);
  const to = Math.min(config.to || now, now);
  const from = config.from || to - 30 * 86_400;
  if (from >= to) throw new Error('startdatum moet vóór einddatum liggen');
  // A window shorter than the warmup cannot produce a single signal.
  if ((to - from) / step < 50) throw new Error('periode te kort voor dit interval');

  const balance = Number(config.startingBalance);
  return {
    symbols,
    interval,
    higherInterval: config.higherInterval || 'Min60',
    from: Math.floor(from),
    to: Math.floor(to),
    startingBalance: Number.isFinite(balance) && balance > 0 ? balance : 10_000,
    risk: config.risk,
    feeRate: config.feeRate,
  };
}
