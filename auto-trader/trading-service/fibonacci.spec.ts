import { computeFibLevels, detectGoldenZoneBounce, goldenZoneWickTouch, goldenZoneLevels, inGoldenZone } from './fibonacci.js';
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

  it('anchors swing strictly from bodem to top when preferredSide is LONG', () => {
    // Construct candles where a spike happened early, but the active swing is bottom 90 -> top 180
    const candles: Candle[] = [
      { time: 1, open: 120, high: 130, low: 110, close: 125, volume: 10 },
      { time: 2, open: 125, high: 125, low: 90, close: 95, volume: 10 }, // Bodem (low = 90)
      { time: 3, open: 95, high: 140, low: 94, close: 135, volume: 10 },
      { time: 4, open: 135, high: 180, low: 130, close: 175, volume: 10 }, // Top (high = 180)
      { time: 5, open: 175, high: 175, low: 145, close: 150, volume: 10 }, // Pullback
    ];
    const fib = computeFibLevels(candles, 150, 10, 'LONG');
    expect(fib).not.toBeNull();
    expect(fib!.direction).toBe('UP');
    expect(fib!.swingLow).toBe(90);
    expect(fib!.swingHigh).toBe(180);
    const half = fib!.retracements.find((r) => r.ratio === 0.5);
    expect(half?.price).toBe(135);
  });

  it('anchors swing strictly from top to bodem when preferredSide is SHORT', () => {
    const candles: Candle[] = [
      { time: 1, open: 150, high: 155, low: 145, close: 150, volume: 10 },
      { time: 2, open: 150, high: 200, low: 148, close: 195, volume: 10 }, // Top (high = 200)
      { time: 3, open: 195, high: 195, low: 130, close: 135, volume: 10 },
      { time: 4, open: 135, high: 140, low: 100, close: 105, volume: 10 }, // Bodem (low = 100)
      { time: 5, open: 105, high: 135, low: 105, close: 130, volume: 10 }, // Pullback rally
    ];
    const fib = computeFibLevels(candles, 130, 10, 'SHORT');
    expect(fib).not.toBeNull();
    expect(fib!.direction).toBe('DOWN');
    expect(fib!.swingHigh).toBe(200);
    expect(fib!.swingLow).toBe(100);
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

describe('goldenZoneLevels', () => {
  it('correctly returns min and max bounds for UP direction', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    const { lower, upper } = goldenZoneLevels(fib);
    expect(lower).toBeCloseTo(138.2, 0); // 200 - 0.618 * 100
    expect(upper).toBeCloseTo(161.8, 0); // 200 - 0.382 * 100
  });
});

describe('detectGoldenZoneBounce', () => {
  it('detects a confirmed bounce out of the Golden Zone for LONG', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    // Golden zone is 138.2 to 161.8
    // Candle 1: dips down into 145 (inside zone)
    // Candle 2: bounces and closes at 170 (above 161.8 zone upper bound)
    const testCandles: Candle[] = [
      { time: 1000, open: 180, high: 185, low: 170, close: 175, volume: 50 },
      { time: 1900, open: 175, high: 175, low: 145, close: 148, volume: 80 }, // in zone
      { time: 2800, open: 148, high: 172, low: 146, close: 170, volume: 100 }, // bounced out
    ];

    const result = detectGoldenZoneBounce(fib, testCandles, 170);
    expect(result.touchedZone).toBe(true);
    expect(result.bouncedOut).toBe(true);
    expect(result.entryType).toBe('bounce_out');
  });

  it('detects price currently inside the Golden Zone as in_zone', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    const testCandles: Candle[] = [
      { time: 1000, open: 180, high: 185, low: 170, close: 175, volume: 50 },
      { time: 1900, open: 175, high: 175, low: 145, close: 150, volume: 80 },
    ];

    const result = detectGoldenZoneBounce(fib, testCandles, 150);
    expect(result.touchedZone).toBe(true);
    expect(result.bouncedOut).toBe(false);
    expect(result.entryType).toBe('in_zone');
  });

  it('invalidates bounce when candle closed below 0.786 invalidation level', () => {
    const candles = swingCandles(100, 200, 30);
    const fib = computeFibLevels(candles, 200)!;
    // 0.786 level is 200 - 0.786*100 = 121.4
    const testCandles: Candle[] = [
      { time: 1000, open: 180, high: 185, low: 170, close: 175, volume: 50 },
      { time: 1900, open: 175, high: 175, low: 110, close: 115, volume: 80 }, // breached 0.786
      { time: 2800, open: 115, high: 170, low: 115, close: 168, volume: 100 },
    ];

    const result = detectGoldenZoneBounce(fib, testCandles, 168);
    expect(result.bouncedOut).toBe(false);
    expect(result.entryType).toBe('none');
  });

  it('detects a confirmed rejection bounce for DOWN / SHORT swing', () => {
    // DOWN swing: 200 down to 100 (5 candles minimum)
    const downCandles: Candle[] = [
      { time: 1, open: 170, high: 175, low: 165, close: 172, volume: 10 },
      { time: 2, open: 172, high: 200, low: 170, close: 195, volume: 10 }, // Top
      { time: 3, open: 195, high: 195, low: 150, close: 155, volume: 10 },
      { time: 4, open: 155, high: 160, low: 100, close: 105, volume: 10 }, // Bodem
      { time: 5, open: 105, high: 110, low: 102, close: 108, volume: 10 },
    ];
    const fib = computeFibLevels(downCandles, 108, 10, 'SHORT')!;
    expect(fib).not.toBeNull();
    expect(fib.direction).toBe('DOWN');
    // Golden Zone retracement (0.382–0.618) of 100 wide move is 138.2 to 161.8
    // Candle rallies into 150, then drops and closes back at 120 (below 138.2)
    const testCandles: Candle[] = [
      { time: 100, open: 105, high: 155, low: 105, close: 150, volume: 50 }, // rallied into zone
      { time: 200, open: 150, high: 152, low: 118, close: 120, volume: 80 }, // rejected down below zone
    ];

    const result = detectGoldenZoneBounce(fib, testCandles, 120);
    expect(result.touchedZone).toBe(true);
    expect(result.bouncedOut).toBe(true);
    expect(result.entryType).toBe('bounce_out');
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
