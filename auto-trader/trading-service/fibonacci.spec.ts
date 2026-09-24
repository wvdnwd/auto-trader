import { computeFibLevels, goldenZoneWickTouch, inGoldenZone } from './fibonacci.js';
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

  it('rejects invalid lookbacks and uses the latest equal extreme to choose the leg', () => {
    const candles = [
      { time: 0, open: 15, high: 20, low: 10, close: 15, volume: 1 },
      { time: 1, open: 13, high: 16, low: 8, close: 13, volume: 1 },
      { time: 2, open: 15, high: 20, low: 9, close: 15, volume: 1 },
      { time: 3, open: 12, high: 18, low: 5, close: 12, volume: 1 },
      { time: 4, open: 16, high: 20, low: 7, close: 16, volume: 1 },
    ];

    for (const lookback of [0, -1, 1.5, NaN, Infinity]) {
      expect(computeFibLevels(candles, undefined, lookback)).toBeNull();
    }
    expect(computeFibLevels(candles, undefined, 4)).toBeNull();
    expect(computeFibLevels(candles)?.direction).toBe('UP');

    const sameLegExtreme = candles.map((c, i) => (i === 4 ? { ...c, low: 5 } : c));
    expect(computeFibLevels(sameLegExtreme)).toBeNull();
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

describe('goldenZoneWickTouch', () => {
  const makeCandle = (time: number, high: number, low: number, close: number): Candle => ({
    time,
    open: close,
    high,
    low,
    close,
    volume: 100,
  });

  it('requires a directional rejection close after a zone touch', () => {
    const fib = computeFibLevels(swingCandles(100, 200, 30), 150)!;
    const upperBand = fib.retracements.find((level) => level.ratio === 0.382)!.price;

    expect(goldenZoneWickTouch(fib, [makeCandle(1, upperBand + 1, 150, upperBand + 0.1)])).toBe(true);
    expect(goldenZoneWickTouch(fib, [makeCandle(1, upperBand + 1, 150, 150)])).toBe(false);
  });

  it('rejects a recent close beyond the 0.786 invalidation and ambiguous timestamps', () => {
    const fib = computeFibLevels(swingCandles(100, 200, 30), 150)!;
    const upperBand = fib.retracements.find((level) => level.ratio === 0.382)!.price;
    const invalidation = fib.retracements.find((level) => level.ratio === 0.786)!.price;
    const rejection = makeCandle(1, upperBand + 1, 150, upperBand + 0.1);

    expect(
      goldenZoneWickTouch(fib, [rejection, makeCandle(2, 130, invalidation - 1, invalidation)])
    ).toBe(false);
    expect(goldenZoneWickTouch(fib, [rejection, { ...rejection, time: 1 }])).toBe(false);
  });

  it('rejects a down-swing wick that does not close back below the zone', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 150)!;
    const downFib = {
      ...fib,
      direction: 'DOWN' as const,
      retracements: fib.retracements.map((level) => ({
        ...level,
        price: fib.swingLow + (fib.swingHigh - fib.swingLow) * level.ratio,
      })),
    };
    const lowerBand = downFib.retracements.find((level) => level.ratio === 0.382)!.price;

    expect(goldenZoneWickTouch(downFib, [makeCandle(1, 150, lowerBand - 1, lowerBand - 0.1)])).toBe(true);
    expect(goldenZoneWickTouch(downFib, [makeCandle(1, 150, lowerBand - 1, 150)])).toBe(false);
  });
});
