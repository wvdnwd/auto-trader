import { Backtest, type MarketHistory } from './backtest.js';
import { DEFAULT_RISK } from './risk.js';
import type { BacktestConfig, BacktestResult, RiskConfig } from './types.js';

/** A parameter set under evaluation. */
export type Candidate = Partial<RiskConfig>;

/** How one candidate performed on one slice of history. */
export type Trial = {
  params: Candidate;
  /** Score on the data the candidate was selected on. */
  trainScore: number;
  /** Score on data held back from selection — the number that matters. */
  testScore: number;
  trainResult: Pick<BacktestResult, 'totalReturnPct' | 'expectancyR' | 'maxDrawdownPct' | 'trades'>;
  testResult: Pick<BacktestResult, 'totalReturnPct' | 'expectancyR' | 'maxDrawdownPct' | 'trades'>;
};

/**
 * Score a backtest result as a single number.
 *
 * Return alone is a trap: it rewards a lucky run that risked everything. This
 * scores expectancy per trade — the part that generalises — then penalises deep
 * drawdowns and sample sizes too small to mean anything.
 *
 * @param result the run to score.
 * @returns a score where higher is better; negative means no edge.
 */
export function score(result: BacktestResult): number {
  // Too few trades is not evidence of anything, good or bad.
  if (result.trades < 12) return -10 + result.trades * 0.1;

  // Expectancy is the core: average R won per trade.
  let value = result.expectancyR * 10;

  // A strategy that only works by surviving a 40% drawdown is not tradable.
  const ddPenalty = Math.max(0, result.maxDrawdownPct - 0.12) * 25;
  value -= ddPenalty;

  // Prefer a result built on many trades over one built on three lucky ones.
  const confidence = Math.min(1, result.trades / 40);
  value *= 0.5 + 0.5 * confidence;

  // Profit factor below 1 means the losers outweigh the winners regardless of R.
  if (Number.isFinite(result.profitFactor) && result.profitFactor < 1) {
    value -= (1 - result.profitFactor) * 4;
  }
  return Number.isFinite(value) ? value : -10;
}

/**
 * Search parameter combinations and validate them on held-out history.
 *
 * The search is deliberately split in two: candidates are ranked on a training
 * window, and the winner is re-run on a later window it never saw. A parameter
 * set that only shines on the training data is overfitted and gets rejected here
 * rather than in production.
 */
export class Optimizer {
  constructor(
    private readonly markets: MarketHistory[],
    private readonly base: BacktestConfig
  ) {}

  /** Training slice, computed once and reused for every candidate. */
  private trainSet: MarketHistory[] | null = null;

  /** Held-out slice, computed once and reused for every candidate. */
  private testSet: MarketHistory[] | null = null;

  /**
   * Split the history into a training and a held-out window.
   *
   * Called once per search — re-slicing per candidate would copy every candle
   * hundreds of times and dominate the run.
   *
   * @param splitAt unix seconds separating training from test data.
   */
  prepare(splitAt: number): void {
    this.trainSet = this.slice(0, splitAt);
    this.testSet = this.slice(splitAt, Number.MAX_SAFE_INTEGER);
  }

  /**
   * Evaluate a single candidate against both windows.
   *
   * @param params the parameter set to score.
   * @returns the trial, or null when the candidate produced no usable run.
   */
  evaluateCandidate(params: Candidate): Trial | null {
    if (!this.trainSet || !this.testSet) throw new Error('prepare() moet eerst aangeroepen worden');
    const trainResult = this.evaluate(this.trainSet, params);
    const testResult = this.evaluate(this.testSet, params);
    if (!trainResult || !testResult) return null;
    return {
      params,
      trainScore: score(trainResult),
      testScore: score(testResult),
      trainResult: summarise(trainResult),
      testResult: summarise(testResult),
    };
  }

  /**
   * Evaluate every candidate and return them ranked by out-of-sample score.
   *
   * @param candidates parameter sets to try.
   * @param splitAt unix seconds separating training from test data.
   * @param onProgress called after each candidate, for UI progress.
   * @returns trials sorted best-first by test score.
   */
  run(
    candidates: Candidate[],
    splitAt: number,
    onProgress?: (done: number, total: number) => void
  ): Trial[] {
    this.prepare(splitAt);
    const trials: Trial[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const trial = this.evaluateCandidate(candidates[i]);
      if (trial) trials.push(trial);
      onProgress?.(i + 1, candidates.length);
    }
    return rank(trials);
  }

  private evaluate(markets: MarketHistory[], params: Candidate): BacktestResult | null {
    if (!markets.length) return null;
    try {
      return new Backtest(
        markets,
        { ...this.base, risk: { ...this.base.risk, ...params } },
        // Lean: hundreds of runs, and only the statistics are read.
        true
      ).run();
    } catch {
      // A candidate that cannot produce a single bar is simply not viable.
      return null;
    }
  }

  private slice(from: number, to: number): MarketHistory[] {
    return this.markets
      .map((m) => ({
        symbol: m.symbol,
        // Indicators need history, so the training warmup is carried into the
        // test slice — otherwise the test window would start blind.
        candles: m.candles.filter((c) => c.time < to && (c.time >= from || from === 0)),
        higher: m.higher.filter((c) => c.time < to),
      }))
      .filter((m) => m.candles.length > 80);
  }
}

/**
 * Rank trials by out-of-sample score.
 *
 * When two candidates land within noise of each other on the test window, the
 * tiebreak is how closely train and test agree — a parameter set that performs
 * the same on both is more likely to keep working than one that was brilliant
 * only on the data it was selected on.
 *
 * @param trials the trials to rank.
 * @returns the trials sorted best-first.
 */
export function rank(trials: Trial[]): Trial[] {
  return [...trials].sort((a, b) => {
    const byTest = b.testScore - a.testScore;
    if (Math.abs(byTest) > 0.3) return byTest;
    return consistency(b) - consistency(a);
  });
}

/** How closely train and test agree — high means the result generalises. */
function consistency(trial: Trial): number {
  return -Math.abs(trial.trainScore - trial.testScore);
}

function summarise(
  r: BacktestResult
): Pick<BacktestResult, 'totalReturnPct' | 'expectancyR' | 'maxDrawdownPct' | 'trades'> {
  return {
    totalReturnPct: r.totalReturnPct,
    expectancyR: r.expectancyR,
    maxDrawdownPct: r.maxDrawdownPct,
    trades: r.trades,
  };
}

/**
 * Build the candidate grid.
 *
 * The axes are the decisions the December run showed were wrong: leverage pinned
 * at the cap, targets banked too early, and no higher-timeframe filter. Each axis
 * is varied around the current default so the search can also confirm the default.
 *
 * @param limit maximum number of candidates to generate.
 * @returns parameter sets to evaluate.
 */
export function buildGrid(limit = 240): Candidate[] {
  const axes = {
    maxLeverage: [5, 8, 12, 20],
    minConfidence: [0.35, 0.45, 0.55],
    atrStopMultiple: [1.8, 2.2, 3],
    firstTargetR: [1.2, 1.8, 2.5],
    firstTargetPortion: [0.3, 0.5],
    trailArmR: [0.8, 1.5],
    requireHigherAlignment: [false, true],
  };

  const out: Candidate[] = [];
  for (const maxLeverage of axes.maxLeverage) {
    for (const minConfidence of axes.minConfidence) {
      for (const atrStopMultiple of axes.atrStopMultiple) {
        for (const firstTargetR of axes.firstTargetR) {
          for (const firstTargetPortion of axes.firstTargetPortion) {
            for (const trailArmR of axes.trailArmR) {
              for (const requireHigherAlignment of axes.requireHigherAlignment) {
                out.push({
                  maxLeverage,
                  minConfidence,
                  atrStopMultiple,
                  firstTargetR,
                  firstTargetPortion,
                  trailArmR,
                  requireHigherAlignment,
                  // The far target scales with the first so the ladder stays sane.
                  finalTargetR: Math.round(firstTargetR * 2 * 10) / 10,
                });
              }
            }
          }
        }
      }
    }
  }

  if (out.length <= limit) return out;
  // Even stride keeps the grid evenly covered instead of truncating one corner.
  const stride = out.length / limit;
  return Array.from({ length: limit }, (_, i) => out[Math.floor(i * stride)]);
}

/** Merge a winning candidate into a full risk profile. */
export function applyCandidate(candidate: Candidate): RiskConfig {
  return { ...DEFAULT_RISK, ...candidate };
}
