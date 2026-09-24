import type { Signal } from './types.js';

/** Rank candidates by conviction plus the existing volume-spurt preference. */
export function rankCandidates<T extends Pick<Signal, 'symbol' | 'confidence' | 'checks'>>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    const aScore = a.confidence + (a.checks.some((check) => check.name === 'Volume Spurt' && check.passed) ? 0.05 : 0);
    const bScore = b.confidence + (b.checks.some((check) => check.name === 'Volume Spurt' && check.passed) ? 0.05 : 0);
    return bScore - aScore || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  });
}
