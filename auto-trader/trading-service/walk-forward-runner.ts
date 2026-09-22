import { type MarketHistory } from './backtest.js';
import { normaliseConfig } from './backtest-runner.js';
import { MarketData } from './market-data.js';
import { runWorkerJob } from './worker-runner.js';
import type { BacktestConfig, RiskConfig, WalkForwardReport } from './types.js';

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

/** Progress and result of a walk-forward analysis. */
export type WalkForwardStatus = {
  state: 'idle' | 'loading' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  report: WalkForwardReport | null;
};

/**
 * Runs a walk-forward analysis in the background and exposes its progress.
 *
 * Candles are downloaded once and reused for every window, because refetching
 * per window would take minutes and hit the exchange rate limit.
 */
export class WalkForwardRunner {
  private running = false;

  private status: WalkForwardStatus = {
    state: 'idle',
    message: 'Nog geen analyse gedraaid',
    progress: 0,
    report: null,
  };

  constructor(private readonly market: MarketData) {}

  /** Current progress and result. */
  get state(): WalkForwardStatus {
    return this.status;
  }

  /**
   * Start an analysis. Returns immediately; poll {@link state} for progress.
   *
   * @param config the market/timeframe setup to evaluate.
   * @param risk risk overrides applied to every window.
   * @throws when an analysis is already in flight.
   */
  start(config: Partial<BacktestConfig>, risk?: Partial<RiskConfig>): void {
    if (this.running) throw new Error('er draait al een walk-forward analyse');
    const normalised = normaliseConfig(config as BacktestConfig);
    this.running = true;
    this.status = {
      state: 'loading',
      message: 'Historische candles ophalen…',
      progress: 0,
      report: null,
    };
    void this.execute(normalised, risk);
  }

  private async execute(config: BacktestConfig, risk?: Partial<RiskConfig>): Promise<void> {
    try {
      const step = INTERVAL_SECONDS[config.interval] || 3600;
      const warmupFrom = config.from - step * WARMUP_BARS;
      const markets: MarketHistory[] = [];

      for (let i = 0; i < config.symbols.length; i += 1) {
        const symbol = config.symbols[i];
        this.status = {
          ...this.status,
          message: `Candles ophalen voor ${symbol} (${i + 1}/${config.symbols.length})`,
          progress: (i / config.symbols.length) * 0.5,
        };
        const [candles, higher] = await Promise.all([
          this.market.history(symbol, config.interval, warmupFrom, config.to),
          this.market.history(symbol, config.higherInterval, warmupFrom, config.to).catch(() => []),
        ]);
        if (candles.length < WARMUP_BARS + 10) continue;
        markets.push({ symbol, candles, higher });
      }

      if (!markets.length) {
        this.fail('Geen bruikbare historische data voor deze markten en periode');
        return;
      }

      this.status = { ...this.status, state: 'running', message: 'Vensters evalueren…', progress: 0.55 };

      // Run on a worker thread — many overlapping backtests replayed back to back
      // would otherwise freeze the live trading loop for the whole analysis.
      const done = await runWorkerJob({ kind: 'walkforward', markets, config, risk }, (d, total) => {
        this.status = {
          ...this.status,
          message: `Venster ${d} / ${total}`,
          progress: 0.55 + (d / total) * 0.45,
        };
      });
      if (done.kind !== 'walkforward') throw new Error('onverwacht workerresultaat');
      const report = done.report;

      this.status = {
        state: 'done',
        message: `${Math.round(report.positiveRate * 100)}% van ${report.windowCount} vensters winstgevend`,
        progress: 1,
        report,
      };
    } catch (err) {
      this.fail((err as Error).message);
    } finally {
      this.running = false;
    }
  }

  private fail(message: string): void {
    this.status = { state: 'error', message, progress: 1, report: null };
  }
}
