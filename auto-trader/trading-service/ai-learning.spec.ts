import { describe, expect, it } from 'vitest';
import {
  classifyVolatilityTier,
  computeFactorWeight,
  evaluateCandidateFactorEdge,
  evaluateClusterRisk,
  evaluateSessionEdge,
  matchCheckToFactor,
  updateCoinDNA,
  updateMfeMaeStats,
  updateSessionStat,
} from './ai-learning.js';
import type { FactorStat, SessionStat } from './types.js';

describe('AI Learning Module', () => {
  describe('1. Dynamic Factor Weighting', () => {
    it('returns neutral 1.0 weight when sample size is below 3', () => {
      const stat: FactorStat = { wins: 1, losses: 1, netR: 0.5 };
      expect(computeFactorWeight(stat)).toBe(1.0);
    });

    it('boosts weight for high win-rate and positive net R', () => {
      const stat: FactorStat = { wins: 8, losses: 2, netR: 12.5 };
      const weight = computeFactorWeight(stat);
      expect(weight).toBeGreaterThan(1.1);
      expect(weight).toBeLessThanOrEqual(1.3);
    });

    it('penalizes weight for low win-rate or negative net R', () => {
      const stat: FactorStat = { wins: 1, losses: 6, netR: -4.5 };
      const weight = computeFactorWeight(stat);
      expect(weight).toBeLessThan(0.9);
      expect(weight).toBeGreaterThanOrEqual(0.7);
    });

    it('matches signal checks to known factor names', () => {
      expect(matchCheckToFactor('Volume Spurt')).toBe('Volume Spurt (Coin in Play)');
      expect(matchCheckToFactor('Fibonacci Golden Zone')).toBe('Fibonacci Golden Zone');
      expect(matchCheckToFactor('Sniper Pullback')).toBe('Sniper Pullback');
      expect(matchCheckToFactor('RSI Divergentie')).toBe('RSI Divergentie');
      expect(matchCheckToFactor('Asian Session Sweep')).toBe('Asian Session Sweep');
      expect(matchCheckToFactor('15m Reversal')).toBe('15m Ommekeer-bevestiging');
      expect(matchCheckToFactor('Unknown Factor')).toBeNull();
    });

    it('evaluates candidate edge based on historical factor performance', () => {
      const factorStats: Record<string, FactorStat> = {
        'Volume Spurt (Coin in Play)': { wins: 10, losses: 2, netR: 15, weightMultiplier: 1.25 },
        'Fibonacci Golden Zone': { wins: 8, losses: 2, netR: 10, weightMultiplier: 1.2 },
        'RSI Divergentie': { wins: 1, losses: 5, netR: -3.5, weightMultiplier: 0.75 },
      };

      const highEdgeChecks = [
        { name: 'Volume Spurt', passed: true, detail: '2.5x volume' },
        { name: 'Fibonacci Golden Zone', passed: true, detail: '0.618 bounce' },
      ];
      const resHigh = evaluateCandidateFactorEdge(highEdgeChecks, factorStats);
      expect(resHigh.bonus).toBeGreaterThan(0.03);
      expect(resHigh.matchedFactors).toContain('Volume Spurt (Coin in Play)');

      const lowEdgeChecks = [
        { name: 'RSI Divergentie', passed: true, detail: 'Bullish divergence' },
      ];
      const resLow = evaluateCandidateFactorEdge(lowEdgeChecks, factorStats);
      expect(resLow.bonus).toBeLessThan(0);
    });
  });

  describe('2. Session & Time-of-Day Intelligence Matrix', () => {
    it('updates session statistics on trade completion', () => {
      let stats: Record<string, SessionStat> = {};
      stats = updateSessionStat('LONDON', 'WIN', 2.5, stats);
      stats = updateSessionStat('LONDON', 'WIN', 1.8, stats);
      stats = updateSessionStat('LONDON', 'LOSS', -1.0, stats);

      expect(stats.LONDON.wins).toBe(2);
      expect(stats.LONDON.losses).toBe(1);
      expect(stats.LONDON.netR).toBe(3.3);
      expect(stats.LONDON.winRate).toBe(0.67);
      expect(stats.LONDON.edgeMultiplier).toBe(1.15);
    });

    it('identifies toxic sessions and flags risk dampener', () => {
      const stats: Record<string, SessionStat> = {
        OFF_HOURS: {
          session: 'OFF_HOURS',
          wins: 1,
          losses: 5,
          netR: -3.8,
          winRate: 0.17,
          edgeMultiplier: 0.75,
        },
      };

      const edge = evaluateSessionEdge('OFF_HOURS', stats);
      expect(edge.isToxic).toBe(true);
      expect(edge.multiplier).toBe(0.8);
      expect(edge.scoreAdjustment).toBeLessThan(0);
      expect(edge.reason).toContain('OFF_HOURS');
    });

    it('identifies high-edge sessions and boosts score', () => {
      const stats: Record<string, SessionStat> = {
        NEW_YORK: {
          session: 'NEW_YORK',
          wins: 7,
          losses: 2,
          netR: 8.5,
          winRate: 0.78,
          edgeMultiplier: 1.15,
        },
      };

      const edge = evaluateSessionEdge('NEW_YORK', stats);
      expect(edge.isToxic).toBe(false);
      expect(edge.multiplier).toBe(1.1);
      expect(edge.scoreAdjustment).toBeGreaterThan(0);
    });
  });

  describe('3. Coin DNA Profiling', () => {
    it('classifies volatility tiers accurately', () => {
      expect(classifyVolatilityTier('BTC_USDT')).toBe('MAJOR');
      expect(classifyVolatilityTier('ETH-USDC')).toBe('MAJOR');
      expect(classifyVolatilityTier('SOL')).toBe('MAJOR');
      expect(classifyVolatilityTier('PEPE_USDT')).toBe('MEME');
      expect(classifyVolatilityTier('DOGE')).toBe('MEME');
      expect(classifyVolatilityTier('POPCAT_USDT')).toBe('MEME');
      expect(classifyVolatilityTier('NEAR_USDT')).toBe('ALT');
      expect(classifyVolatilityTier('LINK')).toBe('ALT');
    });

    it('updates coin DNA and adapts stop-loss and take-profit multipliers', () => {
      let dna = updateCoinDNA('PEPE_USDT', 'WIN', 1.5, 45, 2.1, -0.6);
      expect(dna.PEPE_USDT.totalTrades).toBe(1);
      expect(dna.PEPE_USDT.wins).toBe(1);
      expect(dna.PEPE_USDT.volatilityTier).toBe('MEME');
      // Meme coins receive wider stop multiplier for wick protection
      expect(dna.PEPE_USDT.stopLossMultiplier).toBe(1.25);

      let btcDna = updateCoinDNA('BTC_USDT', 'WIN', 2.0, 120, 2.8, -0.2);
      btcDna = updateCoinDNA('BTC_USDT', 'WIN', 1.5, 90, 2.2, -0.1, btcDna);
      expect(btcDna.BTC_USDT.volatilityTier).toBe('MAJOR');
      expect(btcDna.BTC_USDT.winRate).toBe(1.0);
      expect(btcDna.BTC_USDT.stopLossMultiplier).toBe(0.95);
    });
  });

  describe('4. MFE / MAE Dynamic Target Calibration', () => {
    it('updates MFE/MAE stats and derives optimal realistic targets', () => {
      let stats = updateMfeMaeStats(2.4, -0.4);
      stats = updateMfeMaeStats(3.1, -0.2, stats);
      stats = updateMfeMaeStats(1.8, -0.8, stats);

      expect(stats.totalTracked).toBe(3);
      expect(stats.avgMfeR).toBeCloseTo(2.43, 1);
      expect(stats.avgMaeR).toBeCloseTo(-0.47, 1);
      expect(stats.optimalTp1R).toBeGreaterThanOrEqual(1.2);
      expect(stats.optimalTp1R).toBeLessThanOrEqual(2.2);
      expect(stats.optimalTp2R).toBeGreaterThan(stats.optimalTp1R);
    });
  });

  describe('5. Correlation & Portfolio Cluster-Risk AI', () => {
    it('returns full 1.0 multiplier when portfolio has no same-side exposure', () => {
      const res = evaluateClusterRisk({ symbol: 'SOL_USDT', side: 'LONG' }, []);
      expect(res.multiplier).toBe(1.0);
      expect(res.activeSameSide).toBe(0);
    });

    it('dampens risk as same-side exposure increases to prevent basket liquidation', () => {
      const open1 = [{ symbol: 'BTC_USDT', side: 'LONG' as const }];
      const res1 = evaluateClusterRisk({ symbol: 'NEAR_USDT', side: 'LONG' }, open1);
      expect(res1.multiplier).toBe(0.85);

      const open2 = [
        { symbol: 'BTC_USDT', side: 'LONG' as const },
        { symbol: 'SOL_USDT', side: 'LONG' as const },
      ];
      const res2 = evaluateClusterRisk({ symbol: 'NEAR_USDT', side: 'LONG' }, open2);
      expect(res2.multiplier).toBeLessThanOrEqual(0.7);

      const open3 = [
        { symbol: 'BTC_USDT', side: 'LONG' as const },
        { symbol: 'ETH_USDT', side: 'LONG' as const },
        { symbol: 'AVAX_USDT', side: 'LONG' as const },
      ];
      const res3 = evaluateClusterRisk({ symbol: 'NEAR_USDT', side: 'LONG' }, open3);
      expect(res3.multiplier).toBeLessThanOrEqual(0.55);
    });

    it('applies sector and BTC macro-trend dampeners', () => {
      const openDefi = [
        { symbol: 'UNI_USDT', side: 'LONG' as const },
        { symbol: 'AAVE_USDT', side: 'LONG' as const },
      ];
      const res = evaluateClusterRisk(
        { symbol: 'MKR_USDT', side: 'LONG' },
        openDefi,
        'TREND_DOWN'
      );
      expect(res.multiplier).toBeLessThan(0.6);
      expect(res.reason).toContain('defi');
      expect(res.reason).toContain('BTC');
    });
  });
});
