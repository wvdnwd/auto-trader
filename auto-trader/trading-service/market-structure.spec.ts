import { describe, expect, it } from 'vitest';
import type { Candle } from './types.js';
import {
  analyzeMarketStructure,
  computeVolumeProfile,
  detectFairValueGaps,
  detectLiquiditySweep,
  detectMarketStructureBreaks,
  detectOrderBlocks,
  detectSmtDivergence,
  findPivots,
  getDealingRange,
  planImbalanceScalp,
} from './market-structure.js';

function makeCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  time: number
): Candle {
  return { open, high, low, close, volume: 1000, time };
}

describe('market-structure: findPivots', () => {
  it('detects swing highs and lows with confirmation strength', () => {
    // Construct a wave pattern: low -> high -> higher low -> higher high
    const candles: Candle[] = [
      makeCandle(100, 102, 99, 101, 1000),
      makeCandle(101, 103, 100, 102, 2000),
      makeCandle(102, 115, 101, 114, 3000), // Pivot High 1 (115)
      makeCandle(114, 113, 108, 109, 4000),
      makeCandle(109, 110, 104, 105, 5000), // Pivot Low 1 (104)
      makeCandle(105, 112, 105, 111, 6000),
      makeCandle(111, 125, 110, 124, 7000), // Pivot High 2 (125, HH)
      makeCandle(124, 122, 118, 119, 8000),
      makeCandle(119, 120, 116, 117, 9000),
    ];

    const pivots = findPivots(candles, 2);
    expect(pivots.length).toBeGreaterThanOrEqual(2);

    const highPivots = pivots.filter((p) => p.type === 'HH' || p.type === 'LH');
    expect(highPivots.some((p) => p.price === 115)).toBe(true);
    expect(highPivots.some((p) => p.price === 125)).toBe(true);
  });
});

describe('market-structure: getDealingRange', () => {
  it('identifies Premium (>50%), Discount (<50%), and Equilibrium', () => {
    const candles: Candle[] = [
      makeCandle(100, 150, 100, 140, 1000),
      makeCandle(140, 200, 130, 180, 2000), // High = 200, Low = 100, Eq = 150
    ];

    const premium = getDealingRange(candles, 180);
    expect(premium.zone).toBe('PREMIUM');
    expect(premium.relativePosition).toBeGreaterThan(0.5);

    const discount = getDealingRange(candles, 120);
    expect(discount.zone).toBe('DISCOUNT');
    expect(discount.relativePosition).toBeLessThan(0.5);

    const eq = getDealingRange(candles, 150);
    expect(eq.zone).toBe('EQUILIBRIUM');
  });
});

describe('market-structure: detectFairValueGaps', () => {
  it('detects a bullish FVG between candle 1 and candle 3', () => {
    const candles: Candle[] = [
      makeCandle(100, 105, 99, 104, 1000),  // C1: high = 105
      makeCandle(104, 120, 103, 119, 2000), // C2: large impulse up
      makeCandle(119, 125, 112, 123, 3000), // C3: low = 112 -> Gap: 105 to 112
    ];

    const fvgs = detectFairValueGaps(candles);
    expect(fvgs.length).toBe(1);
    expect(fvgs[0].direction).toBe('BULLISH');
    expect(fvgs[0].bottom).toBe(105);
    expect(fvgs[0].top).toBe(112);
    expect(fvgs[0].midpoint).toBe((105 + 112) / 2);
    expect(fvgs[0].mitigated).toBe(false);
  });

  it('marks an FVG as mitigated when subsequent candles fill the gap', () => {
    const candles: Candle[] = [
      makeCandle(100, 105, 99, 104, 1000),
      makeCandle(104, 120, 103, 119, 2000),
      makeCandle(119, 125, 112, 123, 3000), // Gap: 105 to 112
      makeCandle(123, 124, 104, 106, 4000), // Low = 104 <= 105 -> Mitigated!
    ];

    const fvgs = detectFairValueGaps(candles);
    expect(fvgs.length).toBe(1);
    expect(fvgs[0].mitigated).toBe(true);
  });
});

describe('market-structure: detectLiquiditySweep', () => {
  it('detects a Buy-Side Liquidity (BSL) sweep at a swing high', () => {
    const pivots = [
      { type: 'HH' as const, price: 150, index: 2, time: 2000 },
    ];

    const candles: Candle[] = [
      makeCandle(140, 145, 138, 142, 1000),
      makeCandle(142, 150, 140, 148, 2000),
      makeCandle(148, 149, 145, 146, 3000),
      makeCandle(146, 153, 145, 147, 4000), // Wicks to 153 (>150), but closes at 147 (<150) -> BSL sweep!
    ];

    const sweep = detectLiquiditySweep(candles, pivots, 3);
    expect(sweep).not.toBeNull();
    expect(sweep!.type).toBe('BSL');
    expect(sweep!.level).toBe(150);
  });
});

describe('market-structure: detectMarketStructureBreaks', () => {
  it('identifies a Bearish CHoCH when candle body closes below Higher Low', () => {
    const pivots = [
      { type: 'HH' as const, price: 120, index: 2, time: 2000 },
      { type: 'HL' as const, price: 110, index: 4, time: 4000 },
    ];

    // Candle closes below 110 with candle body
    const candles: Candle[] = [
      makeCandle(118, 120, 116, 119, 2000),
      makeCandle(119, 119, 111, 112, 3000),
      makeCandle(112, 114, 110, 111, 4000),
      makeCandle(111, 112, 102, 104, 5000), // Open 111, Close 104 (< 110) -> Body close below HL!
    ];

    const { trend, lastBreak } = detectMarketStructureBreaks(candles, pivots);
    expect(lastBreak).not.toBeNull();
    expect(lastBreak!.direction).toBe('BEARISH');
    expect(lastBreak!.type).toBe('CHoCH');
    expect(trend).toBe('BEARISH');
  });

  it('requires a close crossing and reports a break only once', () => {
    const pivots = [
      { type: 'HH' as const, price: 120, index: 1, time: 2000 },
      { type: 'HL' as const, price: 110, index: 1, time: 2000 },
    ];
    const candles: Candle[] = [
      makeCandle(110, 115, 109, 112, 1000),
      makeCandle(112, 119, 108, 111, 2000), // Wick/open cross below 110; close holds above.
      makeCandle(111, 114, 107, 109, 3000), // Close crosses below 110.
      makeCandle(109, 112, 106, 108, 4000), // Remains below; not a second event.
    ];

    const { lastBreak } = detectMarketStructureBreaks(candles, pivots);
    expect(lastBreak?.direction).toBe('BEARISH');
    expect(lastBreak?.candleIndex).toBe(2);
    expect(lastBreak?.time).toBe(3000);
  });

  it('confirms a bullish CHoCH only when the candle closes above the pivot', () => {
    const pivots = [
      { type: 'LH' as const, price: 100, index: 1, time: 2000 },
      { type: 'LL' as const, price: 90, index: 1, time: 2000 },
    ];
    const candles: Candle[] = [
      makeCandle(94, 98, 92, 95, 1000),
      makeCandle(95, 99, 91, 98, 2000),
      makeCandle(99, 101, 97, 100, 3000), // High crosses, close only touches pivot.
      makeCandle(99, 103, 98, 102, 4000), // Close crosses above pivot.
    ];

    const { trend, lastBreak } = detectMarketStructureBreaks(candles, pivots);
    expect(lastBreak?.direction).toBe('BULLISH');
    expect(lastBreak?.type).toBe('CHoCH');
    expect(lastBreak?.candleIndex).toBe(3);
    expect(trend).toBe('BULLISH');
  });
});

describe('market-structure: planImbalanceScalp', () => {
  it('plans a SHORT scalp to FVG after BSL sweep with favorable R:R', () => {
    const candles: Candle[] = [
      makeCandle(100, 105, 99, 104, 1000),  // FVG bottom = 105
      makeCandle(104, 115, 103, 114, 2000),
      makeCandle(114, 120, 110, 118, 3000), // FVG top = 110, Mid = 107.5
      makeCandle(118, 125, 117, 124, 4000),
      makeCandle(124, 131, 123, 125, 5000), // Sweeps 130 to 131, close 125
    ];

    const fvgs = [
      {
        direction: 'BULLISH' as const,
        top: 110,
        bottom: 105,
        midpoint: 107.5,
        candleIndex: 1,
        time: 2000,
        mitigated: false,
      },
    ];

    const sweep = { type: 'BSL' as const, level: 130, time: 5000 };
    const scalp = planImbalanceScalp(candles, 125, null, fvgs, sweep);

    expect(scalp).not.toBeNull();
    expect(scalp!.side).toBe('SHORT');
    expect(scalp!.targetPrice).toBe(107.5);
    expect(scalp!.stopLoss).toBeGreaterThan(131);
    expect(scalp!.rrEstimate).toBeGreaterThanOrEqual(1.8);
  });

  it('prefers the 0.618 fib target over the 0.5 fallback when both are valid', () => {
    const candles = [
      makeCandle(100, 102, 99, 101, 1000),
      makeCandle(101, 104, 100, 103, 2000),
      makeCandle(103, 108, 102, 106, 3000),
      makeCandle(106, 115, 105, 113, 4000),
      makeCandle(113, 125, 112, 120, 5000),
    ];
    const fib = {
      swingHigh: 130,
      swingLow: 90,
      direction: 'UP' as const,
      retracements: [
        { ratio: 0.5, price: 110 },
        { ratio: 0.618, price: 105 },
      ],
      extensions: [],
      nearest: { ratio: 0.5, price: 110 },
      distanceToNearest: 0,
    };
    const scalp = planImbalanceScalp(candles, 120, fib, [], {
      type: 'BSL',
      level: 124,
      time: 5000,
    });

    expect(scalp?.side).toBe('SHORT');
    expect(scalp?.targetPrice).toBe(105);
    expect(scalp?.targetReason).toContain('61.8%');
  });

  it('plans a LONG SSL scalp and prefers the 0.618 target over the 0.5 fallback', () => {
    const candles = [
      makeCandle(100, 102, 99, 101, 1000),
      makeCandle(101, 103, 98, 100, 2000),
      makeCandle(100, 102, 97, 99, 3000),
      makeCandle(99, 101, 96, 98, 4000),
      makeCandle(98, 103, 95, 100, 5000),
    ];
    const fib = {
      swingHigh: 130,
      swingLow: 90,
      direction: 'DOWN' as const,
      retracements: [
        { ratio: 0.5, price: 110 },
        { ratio: 0.618, price: 115 },
      ],
      extensions: [],
      nearest: { ratio: 0.5, price: 110 },
      distanceToNearest: 0,
    };
    const scalp = planImbalanceScalp(candles, 100, fib, [], {
      type: 'SSL',
      level: 96,
      time: 5000,
    });

    expect(scalp?.side).toBe('LONG');
    expect(scalp?.targetPrice).toBe(115);
    expect(scalp?.targetReason).toContain('61.8%');
    expect(scalp?.rrEstimate).toBeGreaterThanOrEqual(1.8);
  });
});

describe('market-structure: computeVolumeProfile', () => {
  it('computes POC, VAH, and VAL from candle series', () => {
    // Create candles oscillating around 100 with heavy volume at 100
    const candles: Candle[] = [
      { open: 90, high: 95, low: 88, close: 94, volume: 100, time: 1000 },
      { open: 94, high: 98, low: 92, close: 96, volume: 200, time: 2000 },
      // Heavy volume clustering around 100-102
      { open: 99, high: 102, low: 98, close: 101, volume: 5000, time: 3000 },
      { open: 100, high: 103, low: 99, close: 102, volume: 5000, time: 4000 },
      { open: 101, high: 102, low: 99, close: 100, volume: 5000, time: 5000 },
      { open: 100, high: 105, low: 99, close: 104, volume: 300, time: 6000 },
      { open: 104, high: 110, low: 103, close: 108, volume: 200, time: 7000 },
      { open: 108, high: 112, low: 106, close: 110, volume: 150, time: 8000 },
      { open: 110, high: 115, low: 109, close: 114, volume: 100, time: 9000 },
      { open: 114, high: 118, low: 112, close: 116, volume: 100, time: 10000 },
    ];

    const vp = computeVolumeProfile(candles, 100, 20);
    expect(vp).not.toBeNull();
    expect(vp!.poc).toBeGreaterThanOrEqual(98);
    expect(vp!.poc).toBeLessThanOrEqual(104);
    expect(vp!.val).toBeLessThanOrEqual(vp!.poc);
    expect(vp!.vah).toBeGreaterThanOrEqual(vp!.poc);
  });

  it('returns null for insufficient candles', () => {
    const candles: Candle[] = [
      { open: 100, high: 105, low: 95, close: 102, volume: 1000, time: 1000 },
    ];
    expect(computeVolumeProfile(candles)).toBeNull();
  });

  it('throws for invalid volume profile window and bin counts', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(10, 12, 9, 11, i));
    for (const lookback of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => computeVolumeProfile(candles, lookback, 20)).toThrow(RangeError);
    }
    for (const bins of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => computeVolumeProfile(candles, 10, bins)).toThrow(RangeError);
    }
  });

  it('preserves price precision for instruments below six decimal places', () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      open: 0.000000015,
      high: 0.00000002 + i * 0.00000000001,
      low: 0.00000001,
      close: 0.000000015,
      volume: 100,
      time: 1000 + i,
    }));
    const profile = computeVolumeProfile(candles, 10, 20);

    expect(profile).not.toBeNull();
    expect(profile!.poc).toBeGreaterThan(0);
    expect(profile!.val).toBeGreaterThan(0);
    expect(profile!.vah).toBeGreaterThan(0);
  });
});

describe('market-structure: detectSmtDivergence', () => {
  it('detects Bullish SMT when Benchmark makes Lower Low and Asset makes Higher Low', () => {
    // Benchmark (BTC): Swing Low 1 = 100, Swing Low 2 = 90 (Lower Low)
    const benchmarkCandles: Candle[] = [
      makeCandle(110, 112, 108, 110, 1000),
      makeCandle(110, 115, 109, 114, 2000),
      makeCandle(105, 106, 100, 101, 3000), // Low 1 (100)
      makeCandle(101, 108, 105, 107, 4000),
      makeCandle(107, 115, 106, 113, 5000),
      makeCandle(113, 114, 102, 106, 6000),
      makeCandle(98, 100, 90, 92, 7000),    // Low 2 (90, Lower Low!)
      makeCandle(92, 99, 95, 98, 8000),
      makeCandle(98, 102, 96, 101, 9000),
      // Padding to > 20 candles
      ...Array.from({ length: 15 }, (_, i) =>
        makeCandle(101 + i, 103 + i, 100 + i, 102 + i, 10000 + i * 1000)
      ),
    ];

    // Asset (Altcoin): Swing Low 1 = 10.0, Swing Low 2 = 12.0 (Higher Low -> Bullish SMT!)
    const assetCandles: Candle[] = [
      makeCandle(11, 12, 10.5, 11, 1000),
      makeCandle(11, 13, 10.8, 12.5, 2000),
      makeCandle(10.5, 11, 10.0, 10.2, 3000), // Low 1 (10.0)
      makeCandle(10.2, 12, 11.5, 11.8, 4000),
      makeCandle(11.8, 14, 13.0, 13.5, 5000),
      makeCandle(13.5, 13.8, 12.5, 12.8, 6000),
      makeCandle(12.8, 13.2, 12.0, 12.9, 7000), // Low 2 (12.0, Higher Low!)
      makeCandle(12.9, 14, 12.8, 13.8, 8000),
      makeCandle(13.8, 14.5, 13.5, 14.2, 9000),
      // Padding to > 20 candles
      ...Array.from({ length: 15 }, (_, i) =>
        makeCandle(14 + i * 0.1, 14.5 + i * 0.1, 13.8 + i * 0.1, 14.2 + i * 0.1, 10000 + i * 1000)
      ),
    ];

    const smt = detectSmtDivergence(assetCandles, benchmarkCandles, 50, 'BTC_USDT');
    expect(smt).not.toBeNull();
    expect(smt!.type).toBe('BULLISH');
    expect(smt!.benchmarkSymbol).toBe('BTC_USDT');

    expect(detectSmtDivergence(assetCandles, benchmarkCandles.slice(0, -1), 50, 'BTC_USDT')?.type).toBe(
      'BULLISH'
    );
    expect(detectSmtDivergence(assetCandles, benchmarkCandles.slice(0, -2), 50, 'BTC_USDT')).toBeNull();

    const shiftedBenchmark = benchmarkCandles.map((c) => ({ ...c, time: c.time + 1 }));
    expect(detectSmtDivergence(assetCandles, shiftedBenchmark, 50, 'BTC_USDT')).toBeNull();

    const gappedAsset = assetCandles.map((c, i) =>
      i === assetCandles.length - 1 ? { ...c, time: c.time + 100_000 } : c
    );
    const gappedBenchmark = benchmarkCandles.map((c, i) =>
      i === benchmarkCandles.length - 1 ? { ...c, time: c.time + 100_000 } : c
    );
    expect(detectSmtDivergence(gappedAsset, gappedBenchmark, 50, 'BTC_USDT')).toBeNull();

    const stalePadding = Array.from({ length: 25 }, (_, i) =>
      makeCandle(130 + i, 132 + i, 129 + i, 131 + i, 40_000 + i * 1000)
    );
    expect(
      detectSmtDivergence(
        [...assetCandles, ...stalePadding],
        [...benchmarkCandles, ...stalePadding],
        50,
        'BTC_USDT'
      )
    ).toBeNull();
  });

  it('detects Bearish SMT when Benchmark makes Higher High and Asset makes Lower High', () => {
    // Benchmark (BTC): Swing High 1 = 100, Swing High 2 = 115 (Higher High)
    const benchmarkCandles: Candle[] = [
      makeCandle(90, 92, 88, 90, 1000),
      makeCandle(90, 95, 89, 94, 1500),
      makeCandle(94, 100, 89, 99, 2000), // High 1 (100)
      makeCandle(99, 96, 92, 93, 3000),
      makeCandle(93, 98, 92, 97, 4000),
      makeCandle(97, 105, 96, 104, 4500),
      makeCandle(104, 115, 96, 114, 5000), // High 2 (115, Higher High!)
      makeCandle(114, 108, 105, 106, 6000),
      makeCandle(106, 106, 100, 102, 7000),
      ...Array.from({ length: 15 }, (_, i) =>
        makeCandle(102 - i, 104 - i, 99 - i, 101 - i, 8000 + i * 1000)
      ),
    ];

    // Asset: Swing High 1 = 50, Swing High 2 = 45 (Lower High -> Bearish SMT!)
    const assetCandles: Candle[] = [
      makeCandle(45, 46, 44, 45, 1000),
      makeCandle(45, 48, 44, 47, 1500),
      makeCandle(47, 50, 44.5, 49.5, 2000), // High 1 (50)
      makeCandle(49.5, 44, 42, 43, 3000),
      makeCandle(43, 42, 41, 42, 4000),
      makeCandle(42, 43, 41, 42.5, 4500),
      makeCandle(42.5, 45, 41, 44, 5000), // High 2 (45, Lower High!)
      makeCandle(44, 41, 38, 39, 6000),
      makeCandle(39, 40, 35, 36, 7000),
      ...Array.from({ length: 15 }, (_, i) =>
        makeCandle(36 - i, 37 - i, 34 - i, 35 - i, 8000 + i * 1000)
      ),
    ];

    const smt = detectSmtDivergence(assetCandles, benchmarkCandles, 50, 'BTC_USDT');
    expect(smt).not.toBeNull();
    expect(smt!.type).toBe('BEARISH');
  });

  it('rejects conflicting bullish-low and bearish-high divergences', () => {
    const benchmark = Array.from({ length: 21 }, (_, i) =>
      makeCandle(75, i === 7 ? 110 : i === 13 ? 120 : 100, i === 4 ? 40 : i === 10 ? 30 : 50, 75, i * 900)
    );
    const asset = Array.from({ length: 21 }, (_, i) =>
      makeCandle(75, i === 7 ? 110 : i === 13 ? 105 : 100, i === 4 ? 40 : i === 10 ? 45 : 50, 75, i * 900)
    );

    expect(detectSmtDivergence(asset, benchmark, 50, 'BTC_USDT')).toBeNull();
  });
});

describe('market-structure: analyzeMarketStructure', () => {
  it('returns a comprehensive MarketStructureInfo profile including POC and SMT', () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 102 + i, 99 + i, 101 + i, (i + 1) * 1000)
    );

    const info = analyzeMarketStructure(candles, 130, null);
    expect(info).toHaveProperty('trend');
    expect(info).toHaveProperty('recentPivots');
    expect(info).toHaveProperty('activeFVGs');
    expect(info).toHaveProperty('dealingRange');
    expect(info).toHaveProperty('volumeProfile');
    expect(info.volumeProfile).not.toBeNull();
    expect(info.volumeProfile!.poc).toBeGreaterThan(0);
  });
});
