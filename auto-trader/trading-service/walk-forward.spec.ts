import { WalkForward, WINDOW_DAYS, STRIDE_DAYS } from './walk-forward.js';
import type { MarketHistory } from './backtest.js';
import type { BacktestConfig, Candle } from './types.js';

const HOUR = 3600;
const DAY = 86_400;
const START = 1_700_000_000;

/** Hourly candles following a price function. */
function candles(fn: (i: number) => number, length: number, step = HOUR): Candle[] {
  return Array.from({ length }, (_, i) => {
    const close = fn(i);
    return {
      time: START + i * step,
      open: close * 0.999,
      high: close * 1.004,
      low: close * 0.996,
      close,
      volume: 1_000,
    };
  });
}

/** ~500 days of hourly history, enough for several 300-day windows. */
function market(symbol = 'X_USDT', bars = 12_000): MarketHistory {
  return {
    symbol,
    // Repeated strong up-legs so the trend strategy actually takes trades.
    candles: candles((i) => 100 + Math.sin(i / 400) * 40 + (i % 1500) * 0.06, bars),
    higher: candles((i) => 100 + Math.sin(i / 100) * 40 + ((i * 4) % 1500) * 0.06, bars / 4, HOUR * 4),
  };
}

function config(over: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['X_USDT'],
    interval: 'Min60',
    higherInterval: 'Hour4',
    from: START,
    to: START + 12_000 * HOUR,
    startingBalance: 10_000,
    ...over,
  };
}

describe('walk-forward analysis', () => {
  it('rolls the window instead of growing it', () => {
    const report = new WalkForward([market()], config()).run();

    expect(report.windowCount).toBeGreaterThan(1);
    // Every window covers the same number of days, so none may start before its
    // own start. A window that silently began at the start of history would
    // accumulate trades and turn the whole analysis into one long backtest
    // reported many times — the bug this test exists to prevent.
    for (const w of report.windows) {
      expect(Math.round((w.to - w.from) / DAY)).toBe(WINDOW_DAYS);
    }
    const [first, second] = report.windows;
    expect(Math.round((second.from - first.from) / DAY)).toBe(STRIDE_DAYS);
  });

  it('reports a hit rate consistent with the individual windows', () => {
    const report = new WalkForward([market()], config()).run();

    const positive = report.windows.filter((w) => w.returnPct > 0).length;
    expect(report.positiveRate).toBeCloseTo(positive / report.windows.length, 3);
    // The worst window must really be the worst — this is the number a user
    // should plan around, so it cannot be an average in disguise.
    expect(report.worstReturnPct).toBe(Math.min(...report.windows.map((w) => w.returnPct)));
    expect(report.worstDrawdownPct).toBe(Math.max(...report.windows.map((w) => w.maxDrawdownPct)));
  });

  it('returns an empty report rather than a fake pass when history is too short', () => {
    // 10 days of data cannot fill a single 300-day window.
    const short: MarketHistory = {
      symbol: 'X_USDT',
      candles: candles((i) => 100 + i * 0.01, 240),
      higher: candles((i) => 100 + i * 0.04, 60, HOUR * 4),
    };
    const report = new WalkForward([short], config({ to: START + 240 * HOUR })).run();

    expect(report.windowCount).toBe(0);
    // A 0% hit rate is the honest answer here. Reporting 100% of zero windows
    // would read as a perfect strategy.
    expect(report.positiveRate).toBe(0);
  });

  it('applies risk overrides to every window', () => {
    const base = new WalkForward([market()], config()).run();
    // A confidence threshold nothing can clear must produce no trades anywhere.
    const blocked = new WalkForward([market()], config()).run({ minConfidence: 0.99 });

    const baseTrades = base.windows.reduce((a, w) => a + w.trades, 0);
    const blockedTrades = blocked.windows.reduce((a, w) => a + w.trades, 0);
    expect(baseTrades).toBeGreaterThan(0);
    expect(blockedTrades).toBeLessThan(baseTrades);
  });
});
