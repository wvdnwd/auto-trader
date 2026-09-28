import { evaluateCandidateFactorEdge, evaluateSessionEdge } from './ai-learning.js';
import type { LearningState, Signal } from './types.js';

/**
 * Rank candidates by conviction, volume-spurt preference, and adaptive AI learning edges.
 *
 * Factors with empirically high historical win rates and positive expectancy receive
 * dynamic boosts, while underperforming factors or toxic sessions receive score penalties.
 */
export function rankCandidates<T extends Pick<Signal, 'symbol' | 'confidence' | 'checks'>>(
  candidates: readonly T[],
  learning?: LearningState | null,
  currentSession?: string
): T[] {
  const sessionAdjustment =
    currentSession && learning?.sessionStats
      ? evaluateSessionEdge(currentSession, learning.sessionStats).scoreAdjustment
      : 0;

  const computeScore = (c: T): number => {
    let score = c.confidence;
    if (c.checks.some((check) => check.name === 'Volume Spurt' && check.passed)) {
      score += 0.05;
    }
    if (learning?.factorStats) {
      const factorEdge = evaluateCandidateFactorEdge(c.checks, learning.factorStats);
      score += factorEdge.bonus;
    }
    score += sessionAdjustment;
    return score;
  };

  return [...candidates].sort((a, b) => {
    const aScore = computeScore(a);
    const bScore = computeScore(b);
    return bScore - aScore || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  });
}
