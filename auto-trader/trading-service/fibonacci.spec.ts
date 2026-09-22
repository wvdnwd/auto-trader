import { computeFibLevels, inGoldenZone } from './fibonacci.js';
import type { Candle } from './types.js';

/** Build a simple synthetic swing: price rises from `low` to `high` then pulls back. */
function swingCandles(low: number, high: number, length = 40): Candle[] {
  const mid = Math.floor(length / 2);
  return Array.from({ length }, (_, i) => {
    const t = i <= mid ? i / mid : 1 - (i - mid) / (length - mid);
    const close = low + (high - low) * t;
    return {
      time: 1_700_000_000 + i * 900,
      open: close,
      high: close + 0.01,
      low: close - 0.01,
      close,
      volume: 100,
    };
  });
}

describe('computeFibLevels', () => {
  it('returns null when there is not enough data', () => {
    expect(computeFibLevels([])).toBeNull();
  });

  it('returns null for a flat market with zero range', () => {
    const flat: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
    }));
    expect(computeFibLevels(flat)).toBeNull();
  });

  it('derives an UP direction when the low precedes the high, retracing down from it', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200);
    expect(fib).not.toBeNull();
    expect(fib!.direction).toBe('UP');
    expect(fib!.swingHigh).toBeCloseTo(200, 0);
    expect(fib!.swingLow).toBeCloseTo(100, 0);
    // 0.5 retracement of a 100->200 up-move sits at 150.
    const half = fib!.retracements.find((l) => l.ratio === 0.5)!;
    expect(half.price).toBeCloseTo(150, 0);
  });

  it('projects extensions beyond the swing extreme in the direction of the impulse', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    // A 1.618 extension of a 100-wide up-move projects to 200 + 0.618*100 = 261.8.
    const ext = fib.extensions.find((l) => l.ratio === 1.618)!;
    expect(ext.price).toBeCloseTo(261.8, 0);
    expect(ext.price).toBeGreaterThan(fib.swingHigh);
  });

  it('picks the retracement level nearest the reference price', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 150)!;
    expect(fib.nearest.ratio).toBe(0.5);
    expect(fib.distanceToNearest).toBeLessThan(0.05);
  });
});

describe('inGoldenZone', () => {
  it('accepts a price between the 0.382 and 0.618 retracement levels', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    // Golden zone for a 100->200 up-move spans roughly 138.2 to 161.8.
    expect(inGoldenZone(fib, 150)).toBe(true);
  });

  it('rejects a price outside the band', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    expect(inGoldenZone(fib, 195)).toBe(false);
    expect(inGoldenZone(fib, 105)).toBe(false);
  });
});
