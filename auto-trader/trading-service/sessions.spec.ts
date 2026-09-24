import { describe, expect, it } from 'vitest';
import { computeAsianRange, getMarketSession, sessionWeightModifiers } from './sessions.js';
import type { Candle } from './types.js';

describe('sessions', () => {
  describe('getMarketSession', () => {
    it('identifies Asian session correctly at 02:00 UTC', () => {
      const date = new Date('2026-09-19T02:00:00.000Z');
      const info = getMarketSession(date);
      expect(info.session).toBe('ASIA');
      expect(info.isAsiaOpen).toBe(true);
      expect(info.isNyOpen).toBe(false);
      expect(info.isLondonNyOverlap).toBe(false);
    });

    it('identifies London session correctly at 10:00 UTC', () => {
      const date = new Date('2026-09-19T10:00:00.000Z');
      const info = getMarketSession(date);
      expect(info.session).toBe('LONDON');
      expect(info.isNyOpen).toBe(false);
      expect(info.isLondonNyOverlap).toBe(false);
    });

    it('identifies New York session and London/NY overlap at 14:30 UTC', () => {
      const date = new Date('2026-09-19T14:30:00.000Z');
      const info = getMarketSession(date);
      expect(info.session).toBe('NEW_YORK');
      expect(info.isNyOpen).toBe(true);
      expect(info.isLondonNyOverlap).toBe(true);
    });

    it('identifies late New York session at 19:00 UTC (after London closes)', () => {
      const date = new Date('2026-09-19T19:00:00.000Z');
      const info = getMarketSession(date);
      expect(info.session).toBe('NEW_YORK');
      expect(info.isNyOpen).toBe(false);
      expect(info.isLondonNyOverlap).toBe(false);
    });

    it('identifies Off-Hours session at 22:30 UTC', () => {
      const date = new Date('2026-09-19T22:30:00.000Z');
      const info = getMarketSession(date);
      expect(info.session).toBe('OFF_HOURS');
    });
  });

  describe('computeAsianRange', () => {
    it('computes high, low, and mid from Asian session candles (00:00 - 08:00 UTC)', () => {
      const testDate = new Date('2026-09-19T14:00:00.000Z');
      const dayStartSec = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);

      // Create 8 hourly candles covering 00:00 - 08:00 UTC
      const candles: Candle[] = [];
      for (let h = 0; h < 8; h++) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 105 + h, // max will be 112 at h=7
          low: 95 - h,  // min will be 88 at h=7
          close: 100,
          volume: 1000,
        });
      }

      // Add a couple of post-Asia candles inside the range
      for (let h = 8; h < 14; h++) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 106,
          low: 94,
          close: 100,
          volume: 1000,
        });
      }

      const range = computeAsianRange(candles, testDate, 3600);
      expect(range).not.toBeNull();
      expect(range?.high).toBe(112);
      expect(range?.low).toBe(88);
      expect(range?.mid).toBe(100);
      expect(range?.swept).toBeNull();
    });

    it('detects a bullish Asian low liquidity sweep and reclaim', () => {
      const testDate = new Date('2026-09-19T14:00:00.000Z');
      const dayStartSec = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);

      const candles: Candle[] = [];
      // Asia: range between 90 and 110
      for (let h = 0; h < 8; h++) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 110,
          low: 90,
          close: 100,
          volume: 1000,
        });
      }

      // Post-Asia: candle pierces below 90 (low=87) but closes at 92 (reclaim)
      candles.push({
        time: dayStartSec + 9 * 3600,
        open: 93,
        high: 94,
        low: 87, // sweep below 90!
        close: 92, // closed back above 90!
        volume: 2500,
      });
      for (let h = 10; h < 14; h += 1) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 106,
          low: 94,
          close: 100,
          volume: 1000,
        });
      }

      const range = computeAsianRange(candles, testDate, 3600);
      expect(range?.swept).toBe('LOW');
    });

    it('detects a bearish Asian high liquidity sweep and reclaim', () => {
      const testDate = new Date('2026-09-19T14:00:00.000Z');
      const dayStartSec = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);

      const candles: Candle[] = [];
      // Asia: range between 90 and 110
      for (let h = 0; h < 8; h++) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 110,
          low: 90,
          close: 100,
          volume: 1000,
        });
      }

      // Post-Asia: candle spikes above 110 (high=115) but closes at 108 (reclaim)
      candles.push({
        time: dayStartSec + 9 * 3600,
        open: 107,
        high: 115, // sweep above 110!
        low: 106,
        close: 108, // closed back below 110!
        volume: 3000,
      });
      for (let h = 10; h < 14; h += 1) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 106,
          low: 94,
          close: 100,
          volume: 1000,
        });
      }

      const range = computeAsianRange(candles, testDate, 3600);
      expect(range?.swept).toBe('HIGH');
    });

    it('orders candles by timestamp and excludes candles from after the evaluation time', () => {
      const testDate = new Date('2026-09-19T14:00:00.000Z');
      const dayStartSec = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);
      const candles: Candle[] = Array.from({ length: 8 }, (_, h) => ({
        time: dayStartSec + h * 3600,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1000,
      }));
      candles.push(
        {
          time: dayStartSec + 9 * 3600,
          open: 107,
          high: 115,
          low: 106,
          close: 108,
          volume: 2000,
        },
        {
          time: dayStartSec + 15 * 3600,
          open: 100,
          high: 1000,
          low: 1,
          close: 500,
          volume: 5000,
        }
      );
      candles.splice(
        candles.length - 1,
        0,
        ...Array.from({ length: 4 }, (_, i) => ({
          time: dayStartSec + (10 + i) * 3600,
          open: 100,
          high: 106,
          low: 94,
          close: 100,
          volume: 1000,
        }))
      );

      const range = computeAsianRange(candles.reverse(), testDate, 3600);
      expect(range?.high).toBe(110);
      expect(range?.low).toBe(90);
      expect(range?.swept).toBe('HIGH');
    });

    it('fails closed on duplicate candle timestamps', () => {
      const testDate = new Date('2026-09-19T14:00:00.000Z');
      const time = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);
      const candles: Candle[] = Array.from({ length: 4 }, (_, i) => ({
        time: time + Math.floor(i / 2) * 3600,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1000,
      }));

      expect(computeAsianRange(candles, testDate, 3600)).toBeNull();
    });

    it('does not assign a side when one candle sweeps both Asian extremes', () => {
      const testDate = new Date('2026-09-19T14:00:00.000Z');
      const dayStartSec = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);
      const candles: Candle[] = Array.from({ length: 8 }, (_, h) => ({
        time: dayStartSec + h * 3600,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1000,
      }));
      candles.push({
        time: dayStartSec + 9 * 3600,
        open: 100,
        high: 115,
        low: 85,
        close: 100,
        volume: 2500,
      });
      for (let h = 10; h < 14; h += 1) {
        candles.push({
          time: dayStartSec + h * 3600,
          open: 100,
          high: 106,
          low: 94,
          close: 100,
          volume: 1000,
        });
      }

      expect(computeAsianRange(candles, testDate, 3600)?.swept).toBeNull();
    });

    it('excludes a possibly forming tail without duration and filters stale data with duration', () => {
      const dayStartSec = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);
      const candles: Candle[] = Array.from({ length: 8 }, (_, h) => ({
        time: dayStartSec + h * 3600,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1000,
      }));
      candles.push({
        time: dayStartSec + 9 * 3600,
        open: 93,
        high: 94,
        low: 87,
        close: 92,
        volume: 2000,
      });

      const at10 = new Date('2026-09-19T10:00:00.000Z');
      expect(computeAsianRange(candles, at10)?.swept).toBeNull();
      expect(computeAsianRange(candles, at10, 3600)?.swept).toBe('LOW');
      expect(computeAsianRange(candles, new Date('2026-09-19T13:00:00.000Z'), 3600)).toBeNull();
    });

    it('rejects an invalid explicit candle duration', () => {
      const time = Math.floor(new Date('2026-09-19T00:00:00.000Z').getTime() / 1000);
      const candles: Candle[] = Array.from({ length: 4 }, (_, i) => ({
        time: time + i * 3600,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1000,
      }));

      expect(computeAsianRange(candles, new Date('2026-09-19T14:00:00.000Z'), 0)).toBeNull();
      expect(computeAsianRange(candles, new Date('2026-09-19T14:00:00.000Z'), NaN)).toBeNull();
    });
  });

  describe('sessionWeightModifiers', () => {
    it('boosts mean reversion in Asian session', () => {
      const mods = sessionWeightModifiers('ASIA');
      expect(mods.revertWeightMultiplier).toBeGreaterThan(mods.trendWeightMultiplier);
    });

    it('boosts trend following in New York session and grants overlap bonus', () => {
      const modsNormal = sessionWeightModifiers('NEW_YORK', false);
      const modsOverlap = sessionWeightModifiers('NEW_YORK', true);
      expect(modsNormal.trendWeightMultiplier).toBeGreaterThan(1.0);
      expect(modsOverlap.confidenceMultiplier).toBeGreaterThan(modsNormal.confidenceMultiplier);
    });
  });
});
