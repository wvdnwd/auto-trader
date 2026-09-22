import { Backtest, type MarketHistory } from './backtest.js';
import { normaliseConfig } from './backtest-runner.js';
import type { BacktestConfig, Candle } from './types.js';

const STEP = 900;

function candles(fn: (i: number) => number, length = 300, startTime = 1_700_000_000): Candle[] {
  return Array.from({ length }, (_, i) => {
    const close = fn(i);
    return {
      time: startTime + i * STEP,
      open: close * 0.999,
      high: close * 1.005,
      low: close * 0.995,
      close,
      volume: 5_000,
    };
  });
}

function market(symbol: string, fn: (i: number) => number, length = 300): MarketHistory {
  const series = candles(fn, length);
  // The confirmation timeframe samples the same path, so the two agree.
  const higher = series
    .filter((_, i) => i % 4 === 0)
    .map((c) => ({ ...c, time: c.time - (c.time % 3600) }));
  return { symbol, candles: series, higher };
}

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['X_USDT'],
    interval: 'Min15',
    higherInterval: 'Min60',
    from: 1_700_000_000,
    to: 1_700_000_000 + 300 * STEP,
    startingBalance: 10_000,
    ...overrides,
  };
}

describe('backtest replay', () => {
  it('produces a complete result on a trending market', () => {
    const result = new Backtest([market('X_USDT', (i) => 100 + i * 0.4)], config()).run();
    expect(result.bars).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(result.bars);
    expect(result.finalEquity).toBeGreaterThan(0);
    // Every closed trade must be fully described — an empty log with a non-zero
    // trade count would mean the summary and the ledger disagree.
    expect(result.tradeLog.length).toBe(result.trades);
  });

  it('never leaves a position open when the run ends', () => {
    const result = new Backtest([market('X_USDT', (i) => 100 + i * 0.4)], config()).run();
    const last = result.equityCurve[result.equityCurve.length - 1];
    expect(last.openPositions).toBe(0);
  });

  it('keeps the ledger consistent with the equity curve', () => {
    const result = new Backtest([market('X_USDT', (i) => 100 + i * 0.35)], config()).run();
    const summed = result.tradeLog.reduce((a, t) => a + t.pnl, 0);
    // Final equity must equal the starting balance plus the sum of every trade.
    // Any drift here means margin or booked profit is being double counted.
    expect(result.finalEquity).toBeCloseTo(result.startingBalance + summed, 1);
  });

  it('assumes the stop filled first when a bar spans both stop and target', () => {
    // A market that rips up and then collapses through the stop inside the window.
    const whipsaw = market('X_USDT', (i) => (i < 200 ? 100 + i * 0.4 : 180 - (i - 200) * 3));
    const result = new Backtest([whipsaw], config()).run();
    const optimistic = result.tradeLog.filter(
      (t) => t.exitReason === 'TAKE_PROFIT' && t.rMultiple < 0
    );
    // A take-profit can never book a negative R — that would mean the fill was
    // credited at a price the market reached only after the stop was breached.
    expect(optimistic).toHaveLength(0);
  });

  it('charges fees on every trade', () => {
    const free = new Backtest(
      [market('X_USDT', (i) => 100 + i * 0.4)],
      config({ feeRate: 0 })
    ).run();
    const charged = new Backtest(
      [market('X_USDT', (i) => 100 + i * 0.4)],
      config({ feeRate: 0.002 })
    ).run();
    if (charged.trades > 0) {
      expect(charged.finalEquity).toBeLessThan(free.finalEquity);
    }
  });

  it('reports drawdown as a positive fraction that never exceeds one', () => {
    const result = new Backtest(
      [market('X_USDT', (i) => 100 + Math.sin(i / 9) * 25)],
      config()
    ).run();
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdownPct).toBeLessThanOrEqual(1);
    expect(result.equityCurve.every((p) => p.drawdownPct >= 0)).toBe(true);
  });

  it('respects the maximum open position limit at every bar', () => {
    const markets = ['A_USDT', 'B_USDT', 'C_USDT', 'D_USDT', 'E_USDT'].map((s, n) =>
      market(s, (i) => 100 + i * (0.3 + n * 0.05))
    );
    const result = new Backtest(
      markets,
      config({ symbols: markets.map((m) => m.symbol), risk: { maxOpenPositions: 2 } })
    ).run();
    expect(result.equityCurve.every((p) => p.openPositions <= 2)).toBe(true);
  });

  it('reports identical statistics in lean mode', () => {
    const series = () => [market('X_USDT', (i) => 100 + Math.sin(i / 11) * 18 + i * 0.25)];
    const full = new Backtest(series(), config()).run();
    const lean = new Backtest(series(), config(), true).run();

    // Lean mode exists purely to save memory during a parameter search. If it
    // changed any statistic, the optimizer would be selecting on different
    // numbers than the ones the user sees on the backtest tab.
    expect(lean.finalEquity).toBeCloseTo(full.finalEquity, 2);
    expect(lean.trades).toBe(full.trades);
    expect(lean.expectancyR).toBeCloseTo(full.expectancyR, 3);
    expect(lean.maxDrawdownPct).toBeCloseTo(full.maxDrawdownPct, 4);
    expect(lean.sharpe).toBeCloseTo(full.sharpe, 1);
    expect(lean.winRate).toBeCloseTo(full.winRate, 4);
    // ...while dropping the heavy payload.
    expect(lean.equityCurve).toHaveLength(0);
    expect(lean.tradeLog).toHaveLength(0);
  });

  it('splits the result into months that reconcile with the trade log', () => {
    // ~80 days of 15m bars with repeated up-legs, so the run spans several
    // calendar months and closes trades in more than one of them.
    const bars = 8000;
    const long = market(
      'X_USDT',
      (i) => 100 + Math.sin(i / 400) * 60 + (i % 1200) * 0.08,
      bars
    );
    const result = new Backtest([long], config({ to: 1_700_000_000 + bars * STEP })).run();

    expect(result.monthly.length).toBeGreaterThan(1);
    // The months must account for every dollar the trade log booked, otherwise
    // the consistency panel would tell a different story than the headline.
    const monthSum = result.monthly.reduce((a, m) => a + m.pnl, 0);
    const tradeSum = result.tradeLog.reduce((a, t) => a + t.pnl, 0);
    expect(monthSum).toBeCloseTo(tradeSum, 1);
    expect(result.monthly.reduce((a, m) => a + m.trades, 0)).toBe(result.trades);
    // Sorted oldest first, so the UI can render them straight through.
    const keys = result.monthly.map((m) => m.month);
    expect([...keys].sort()).toEqual(keys);
    expect(result.positiveMonthRate).toBeGreaterThanOrEqual(0);
    expect(result.positiveMonthRate).toBeLessThanOrEqual(1);
  });

  it('does not report a best-month share for a losing run', () => {
    // A steadily falling market the long-biased strategy cannot profit from.
    const result = new Backtest([market('X_USDT', (i) => 200 - i * 0.3)], config()).run();
    if (result.finalEquity < result.startingBalance) {
      // A ratio against a negative total would read as a large positive number
      // and wrongly imply concentration, so it is suppressed instead.
      expect(result.bestMonthShare).toBe(0);
    }
  });

  it('throws instead of silently returning nothing when there is no data', () => {
    expect(() => new Backtest([{ symbol: 'X_USDT', candles: [], higher: [] }], config()).run()).toThrow();
  });
});

describe('backtest configuration', () => {
  it('fills in sensible defaults', () => {
    const cfg = normaliseConfig({ symbols: ['BTC_USDT'] });
    expect(cfg.interval).toBe('Min15');
    expect(cfg.startingBalance).toBeGreaterThan(0);
    expect(cfg.to).toBeGreaterThan(cfg.from);
  });

  it('rejects a window that cannot produce a signal', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => normaliseConfig({ symbols: ['BTC_USDT'], from: now - 600, to: now })).toThrow();
    expect(() => normaliseConfig({ symbols: [] })).toThrow();
    expect(() =>
      normaliseConfig({ symbols: ['BTC_USDT'], interval: 'Min7' as string })
    ).toThrow();
  });
});
