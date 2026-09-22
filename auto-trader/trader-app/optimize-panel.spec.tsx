import { verdictFor } from './optimize-panel.js';
import type { OptimizeTrial } from './types.js';

function trial(
  train: { expectancyR: number; trades?: number },
  test: { expectancyR: number; trades?: number }
): OptimizeTrial {
  const window = (w: { expectancyR: number; trades?: number }) => ({
    expectancyR: w.expectancyR,
    trades: w.trades ?? 80,
    totalReturnPct: w.expectancyR * 0.5,
    maxDrawdownPct: 0.12,
  });
  return {
    params: { maxLeverage: 12 },
    trainScore: train.expectancyR * 10,
    testScore: test.expectancyR * 10,
    trainResult: window(train),
    testResult: window(test),
  };
}

describe('optimizer verdict', () => {
  it('calls it an edge only when both windows agree', () => {
    expect(verdictFor(trial({ expectancyR: 0.1 }, { expectancyR: 0.08 })).kind).toBe('edge');
  });

  it('refuses to call a lucky test window an edge', () => {
    // Losing on training and winning on test is noise, not a discovery. Reporting
    // this as success would defeat the entire reason for splitting the data.
    const verdict = verdictFor(trial({ expectancyR: -0.2 }, { expectancyR: 0.44 }));
    expect(verdict.kind).toBe('lucky');
    expect(verdict.text).toContain('geluk');
  });

  it('flags a result that only works on the training data as overfit', () => {
    expect(verdictFor(trial({ expectancyR: 0.35 }, { expectancyR: -0.02 })).kind).toBe('overfit');
  });

  it('will not judge anything on a handful of trades', () => {
    // Any expectancy is achievable over ten trades; sample size comes first.
    expect(verdictFor(trial({ expectancyR: 0.9, trades: 8 }, { expectancyR: 0.8, trades: 5 })).kind).toBe(
      'insufficient'
    );
  });

  it('stays cautious when both windows win but disagree widely', () => {
    expect(verdictFor(trial({ expectancyR: 0.5 }, { expectancyR: 0.06 })).kind).toBe('inconsistent');
  });

  it('reports no edge when both windows lose', () => {
    expect(verdictFor(trial({ expectancyR: -0.1 }, { expectancyR: -0.15 })).kind).toBe('none');
  });
});
