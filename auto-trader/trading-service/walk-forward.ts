import { Backtest, type MarketHistory } from './backtest.js';
import type { BacktestConfig, Candle, RiskConfig, WalkForwardReport, WalkForwardWindow } from './types.js';

/** Default length of one evaluation window, in days. */
export const WINDOW_DAYS = 300;

/** How far each window starts after the previous one, in days. */
export const STRIDE_DAYS = 60;

const DAY = 86_400;

/** Bars of history kept before a window so indicators are warmed up. */
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

/** Seconds in one bar of the given interval. */
function intervalSeconds(interval: string): number {
  return INTERVAL_SECONDS[interval] || 3600;
}

function timingSlice(candles: MarketHistory['timing15m'], from: number, to: number, seconds: number) {
  return candles?.filter((candle) => {
    const closedAt = candle.time + seconds;
    return closedAt >= from - seconds * WARMUP_BARS && closedAt <= to;
  });
}

/**
 * Evaluate a parameter set across several overlapping windows of history.
 *
 * A single backtest answers "did this work over that stretch?", which is the
 * wrong question — any strategy can find one flattering stretch. This answers
 * the question that matters: across every 300-day period we have data for, how
 * often did it work, and how bad was the worst one?
 *
 * Windows deliberately overlap. Non-overlapping windows would give only a
 * handful of samples over two years, too few to distinguish a real edge from
 * luck; a rolling start gives many views of the same history at the cost of the
 * samples not being fully independent.
 */
export class WalkForward {
  constructor(
    private readonly markets: MarketHistory[],
    private readonly base: BacktestConfig
  ) {}

  /**
   * Run every window that fits inside the available history.
   *
   * @param risk risk overrides applied to every window.
   * @param onProgress called after each window, for UI progress.
   * @returns per-window results plus the aggregate verdict.
   */
  run(risk?: Partial<RiskConfig>, onProgress?: (done: number, total: number) => void): WalkForwardReport {
    const bounds = this.bounds();
    const starts = this.windowStarts(bounds);

    const windows: WalkForwardWindow[] = [];
    starts.forEach((from, i) => {
      const to = from + WINDOW_DAYS * DAY;
      const slice = this.slice(from, to);
      // A window with too little data would report a misleading 0% rather than
      // being obviously absent, so it is skipped entirely.
      if (!slice.length) return;

      const config: BacktestConfig = {
        ...this.base,
        from,
        to,
        risk: { ...this.base.risk, ...risk },
      };
      try {
        const result = new Backtest(slice, config, true).run();
        windows.push({
          from,
          to,
          returnPct: result.totalReturnPct,
          maxDrawdownPct: result.maxDrawdownPct,
          profitFactor: result.profitFactor,
          expectancyR: result.expectancyR,
          trades: result.trades,
        });
      } catch {
        // A window that cannot produce a run tells us nothing; excluding it is
        // honest, whereas recording it as a zero would flatter the hit rate.
      }
      onProgress?.(i + 1, starts.length);
    });

    return { windows, ...summarise(windows) };
  }

  /** Earliest and latest bar time present across all markets. */
  private bounds(): { first: number; last: number } {
    let first = Number.MAX_SAFE_INTEGER;
    let last = 0;
    for (const market of this.markets) {
      const candles = market.candles;
      if (!candles.length) continue;
      first = Math.min(first, this.closeTime(candles[0]));
      last = Math.max(last, this.closeTime(candles[candles.length - 1]));
    }
    return {
      first: Math.max(first, this.base.from),
      last: Math.min(last, this.base.to),
    };
  }

  private closeTime(candle: Candle): number {
    return candle.time + intervalSeconds(this.base.interval);
  }

  /** Window start times, spaced by the stride, that fit entirely in the data. */
  private windowStarts({ first, last }: { first: number; last: number }): number[] {
    const starts: number[] = [];
    const span = WINDOW_DAYS * DAY;
    for (let from = first; from + span <= last; from += STRIDE_DAYS * DAY) {
      starts.push(from);
    }
    // Always evaluate the most recent full window, even when the stride misses
    // it — recent behaviour is the most relevant evidence there is.
    const lastStart = last - span;
    if (lastStart > first && (!starts.length || lastStart - starts[starts.length - 1] > DAY)) {
      starts.push(lastStart);
    }
    return starts;
  }

  /**
   * Candles limited to one window, with a warm-up tail before it.
   *
   * Both ends must be trimmed. Cutting only the end leaves every window starting
   * at the beginning of history, so they grow cumulatively instead of rolling —
   * which silently turns the analysis into one long backtest reported several
   * times over, and makes the hit rate meaningless. The giveaway is trade counts
   * that climb window after window when every window is the same length.
   */
  private slice(from: number, to: number): MarketHistory[] {
    const warmupFrom = from - intervalSeconds(this.base.interval) * WARMUP_BARS;
    const higherWarmupFrom = from - intervalSeconds(this.base.higherInterval) * WARMUP_BARS;
    return this.markets
      .map((market) => ({
        symbol: market.symbol,
        candles: market.candles.filter((c) => {
          const closedAt = c.time + intervalSeconds(this.base.interval);
          return closedAt >= warmupFrom && closedAt <= to;
        }),
        higher: market.higher.filter((c) => {
          const closedAt = c.time + intervalSeconds(this.base.higherInterval);
          return closedAt >= higherWarmupFrom && closedAt <= to;
        }),
        timing15m: timingSlice(market.timing15m, from, to, 900),
        timing5m: timingSlice(market.timing5m, from, to, 300),
      }))
      .filter((market) => market.candles.filter((c) => this.closeTime(c) >= from).length > 200);
  }
}

/**
 * Reduce the per-window results to a verdict.
 *
 * @param windows the completed windows.
 * @returns hit rate, median and worst-case figures.
 */
function summarise(
  windows: WalkForwardWindow[]
): Omit<WalkForwardReport, 'windows'> {
  if (!windows.length) {
    return { windowCount: 0, positiveRate: 0, medianReturnPct: 0, worstReturnPct: 0, worstDrawdownPct: 0, medianProfitFactor: 0 };
  }
  const returns = windows.map((w) => w.returnPct).sort((a, b) => a - b);
  const factors = windows.map((w) => w.profitFactor).sort((a, b) => a - b);
  return {
    windowCount: windows.length,
    // The headline number: the share of 300-day periods that ended in profit.
    positiveRate: round(windows.filter((w) => w.returnPct > 0).length / windows.length, 3),
    medianReturnPct: round(median(returns), 4),
    worstReturnPct: round(returns[0], 4),
    worstDrawdownPct: round(Math.max(...windows.map((w) => w.maxDrawdownPct)), 4),
    medianProfitFactor: round(median(factors), 2),
  };
}

/** Middle value of a pre-sorted list. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
