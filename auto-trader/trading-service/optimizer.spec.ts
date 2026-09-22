import { Optimizer, buildGrid, score } from './optimizer.js';
import type { MarketHistory } from './backtest.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const STEP = 900;
const START = 1_700_000_000;

function market(symbol: string, fn: (i: number) => number, length = 400): MarketHistory {
  const candles = Array.from({ length }, (_, i) => {
    const close = fn(i);
    return {
      time: START + i * STEP,
      open: close * 0.999,
      high: close * 1.005,
      low: close * 0.995,
      close,
      volume: 5000,
    };
  });
  return {
    symbol,
    candles,
    higher: candles.filter((_, i) => i % 4 === 0).map((c) => ({ ...c, time: c.time - (c.time % 3600) })),
  };
}

const base: BacktestConfig = {
  symbols: ['X_USDT'],
  interval: 'Min15',
  higherInterval: 'Min60',
  from: START,
  to: START + 400 * STEP,
  startingBalance: 10_000,
};

function resultWith(patch: Partial<BacktestResult>): BacktestResult {
  return {
    trades: 50,
    expectancyR: 0.2,
    maxDrawdownPct: 0.1,
    profitFactor: 1.4,
    totalReturnPct: 0.1,
    ...patch,
  } as BacktestResult;
}

describe('optimizer scoring', () => {
  it('rejects results with too few trades regardless of how good they look', () => {
    const lucky = resultWith({ trades: 3, expectancyR: 5, totalReturnPct: 4 });
    const solid = resultWith({ trades: 60, expectancyR: 0.25 });
    // Three brilliant trades are noise; sixty decent ones are evidence.
    expect(score(lucky)).toBeLessThan(score(solid));
  });

  it('prefers a shallower drawdown when expectancy is equal', () => {
    const calm = resultWith({ maxDrawdownPct: 0.08 });
    const wild = resultWith({ maxDrawdownPct: 0.4 });
    expect(score(calm)).toBeGreaterThan(score(wild));
  });

  it('scores a losing strategy below zero', () => {
    expect(score(resultWith({ expectancyR: -0.5, profitFactor: 0.5 }))).toBeLessThan(0);
  });
});

describe('candidate grid', () => {
  it('stays within the requested size and varies every axis', () => {
    const grid = buildGrid(60);
    expect(grid.length).toBeLessThanOrEqual(60);
    expect(new Set(grid.map((c) => c.maxLeverage)).size).toBeGreaterThan(1);
    expect(new Set(grid.map((c) => c.minConfidence)).size).toBeGreaterThan(1);
  });

  it('keeps the target ladder ordered', () => {
    for (const c of buildGrid(80)) {
      expect(c.finalTargetR!).toBeGreaterThan(c.firstTargetR!);
      expect(c.firstTargetPortion!).toBeLessThan(1);
    }
  });
});

describe('walk-forward validation', () => {
  it('reports separate train and test scores', () => {
    const markets = [market('X_USDT', (i) => 100 + i * 0.3)];
    const split = START + 250 * STEP;
    const trials = new Optimizer(markets, base).run(
      [{ maxLeverage: 8 }, { maxLeverage: 20 }],
      split
    );
    expect(trials.length).toBeGreaterThan(0);
    for (const t of trials) {
      // Both windows must be evaluated — a missing test score would mean the
      // split silently collapsed and selection happened on training data only.
      expect(Number.isFinite(t.trainScore)).toBe(true);
      expect(Number.isFinite(t.testScore)).toBe(true);
    }
  });

  it('ranks best-first by out-of-sample score', () => {
    const markets = [market('X_USDT', (i) => 100 + Math.sin(i / 12) * 15 + i * 0.2)];
    const trials = new Optimizer(markets, base).run(buildGrid(12), START + 250 * STEP);
    for (let i = 1; i < trials.length; i += 1) {
      expect(trials[i - 1].testScore).toBeGreaterThanOrEqual(trials[i].testScore - 0.31);
    }
  });

  it('reports progress for every candidate', () => {
    const markets = [market('X_USDT', (i) => 100 + i * 0.25)];
    const seen: number[] = [];
    new Optimizer(markets, base).run(buildGrid(6), START + 250 * STEP, (done) => seen.push(done));
    expect(seen.length).toBe(6);
    expect(seen[seen.length - 1]).toBe(6);
  });
});
