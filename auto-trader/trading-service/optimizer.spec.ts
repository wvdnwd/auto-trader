import { vi } from 'vitest';
import { Backtest } from './backtest.js';
import { Optimizer, buildGrid, score } from './optimizer.js';
import type { MarketHistory } from './backtest.js';
import type { BacktestConfig, BacktestResult, Candle } from './types.js';

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

function intervalCandles(interval: number, length: number, start = START): Candle[] {
  return Array.from({ length }, (_, i) => {
    const close = 100 + i * 0.01;
    return { time: start + i * interval, open: close, high: close + 0.1, low: close - 0.1, close, volume: 1 };
  });
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
  it('preserves timing warmup and caps both series at each optimizer window end', () => {
    const history = market('X_USDT', (i) => 100 + i * 0.3);
    history.timing15m = intervalCandles(900, 500, START - 100 * 900);
    history.timing5m = intervalCandles(300, 1_500, START - 100 * 300);
    const split = START + 250 * STEP;
    const optimizer = new Optimizer([history], base);
    optimizer.prepare(split);
    const { trainSet, testSet } = optimizer as unknown as {
      trainSet: MarketHistory[];
      testSet: MarketHistory[];
    };

    expect(trainSet[0].timing15m?.some((candle) => candle.time + 900 < base.from)).toBe(true);
    expect(trainSet[0].timing5m?.some((candle) => candle.time + 300 < base.from)).toBe(true);
    expect(Math.max(...trainSet[0].timing15m!.map((candle) => candle.time + 900))).toBeLessThanOrEqual(split - 1);
    expect(Math.max(...trainSet[0].timing5m!.map((candle) => candle.time + 300))).toBeLessThanOrEqual(split - 1);
    expect(testSet[0].timing15m?.some((candle) => candle.time + 900 < split)).toBe(true);
    expect(testSet[0].timing5m?.some((candle) => candle.time + 300 < split)).toBe(true);
    expect(Math.max(...testSet[0].timing15m!.map((candle) => candle.time + 900))).toBeLessThanOrEqual(base.to);
    expect(Math.max(...testSet[0].timing5m!.map((candle) => candle.time + 300))).toBeLessThanOrEqual(base.to);
  });

  it('returns the training-selected winner with train and held-out results', () => {
    const split = START + 250 * STEP;
    const run = vi.spyOn(Backtest.prototype, 'run').mockReturnValue(resultWith({ expectancyR: 0.3 }));
    try {
      const trials = new Optimizer([market('X_USDT', (i) => 100 + i * 0.3)], base).run(
        [{ maxLeverage: 8 }, { maxLeverage: 20 }],
        split
      );
      expect(trials).toHaveLength(1);
      expect(Number.isFinite(trials[0].trainScore)).toBe(true);
      expect(Number.isFinite(trials[0].testScore)).toBe(true);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      run.mockRestore();
    }
  });

  it('keeps the training winner unchanged and rejects its negative held-out result', () => {
    const split = START + 250 * STEP;
    const evaluated: BacktestConfig[] = [];
    const run = vi.spyOn(Backtest.prototype, 'run').mockImplementation(function () {
      const config = (this as unknown as { config: BacktestConfig }).config;
      evaluated.push(config);
      const leverage = config.risk?.maxLeverage;
      const testWindow = config.from === split;
      const expectancyR = testWindow
        ? leverage === 5 ? -0.2 : 1
        : leverage === 5 ? 0.8 : leverage === 8 ? 0.4 : 0.1;
      return resultWith({ expectancyR });
    });
    try {
      const optimize = () =>
        new Optimizer([market('X_USDT', (i) => 100 + i * 0.3)], base).run(
          [{ maxLeverage: 5 }, { maxLeverage: 8 }, { maxLeverage: 12 }],
          split
        );

      expect(optimize).toThrow(/negatieve out-of-sample score/);
      expect(run).toHaveBeenCalledTimes(4);
      expect(evaluated.slice(0, 3).every((config) => config.to === split - 1)).toBe(true);
      expect(evaluated[3].from).toBe(split);
      expect(evaluated[3].risk?.maxLeverage).toBe(5);
    } finally {
      run.mockRestore();
    }
  });

  it('fails validation explicitly when the selected candidate has no held-out result', () => {
    const split = START + 250 * STEP;
    const run = vi.spyOn(Backtest.prototype, 'run').mockImplementation(function () {
      const config = (this as unknown as { config: BacktestConfig }).config;
      if (config.from === split) throw new Error('held-out replay failed');
      return resultWith({ expectancyR: 0.5 });
    });
    try {
      expect(() => new Optimizer([market('X_USDT', (i) => 100 + i * 0.3)], base).run(
        [{ maxLeverage: 5 }],
        split
      )).toThrow(/kon niet out-of-sample worden gevalideerd/);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
    }
  });

  it('reports progress for every candidate', () => {
    const seen: number[] = [];
    const run = vi.spyOn(Backtest.prototype, 'run').mockReturnValue(resultWith({ expectancyR: 0.3 }));
    try {
      new Optimizer([market('X_USDT', (i) => 100 + i * 0.25)], base)
        .run(buildGrid(6), START + 250 * STEP, (done) => seen.push(done));
      expect(seen.length).toBe(6);
      expect(seen[seen.length - 1]).toBe(6);
    } finally {
      run.mockRestore();
    }
  });
});
