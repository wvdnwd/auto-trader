import {
  DEFAULT_TREND_PARAMS,
  atr,
  detectRegime,
  donchian,
  ema,
  evaluateTrendEntry,
  initialStopPrice,
  keltner,
  partialPlan,
  positionSizeUsd,
  sma,
  trailStop,
} from './regime-trend.js';
import type { TrendCandle, TrendEntrySignal } from './regime-trend.js';

function candle(
  time: number,
  close: number,
  high: number,
  low: number,
  open = close,
  volume = 1
): TrendCandle {
  return { time, open, high, low, close, volume };
}

function flatCandles(count: number, price: number): TrendCandle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(i, price, price + 1, price - 1)
  );
}

function risingSeries(count: number, start = 100): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

function fallingSeries(count: number, start = 400): number[] {
  return Array.from({ length: count }, (_, i) => start - i);
}

function flatSeries(count: number): number[] {
  return Array.from({ length: count }, () => 100);
}

describe('regime-trend indicators', () => {
  it('aligns SMA and EMA to the input with undefined warm-up', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it('computes Wilder ATR from a hand-checked true-range series', () => {
    const candles: TrendCandle[] = [
      candle(0, 10, 10, 10),
      candle(1, 11, 12, 10),
      candle(2, 14, 15, 12),
      candle(3, 13, 14, 12),
    ];
    const series = atr(candles, 2);
    expect(series[0]).toBeUndefined();
    expect(series[1]).toBeUndefined();
    expect(series[2]).toBeCloseTo(3, 6);
    expect(series[3]).toBeCloseTo(2.5, 6);
  });

  it('shifts the Donchian channel by one bar so the current bar is excluded', () => {
    const candles: TrendCandle[] = [
      candle(0, 1, 1, 0),
      candle(1, 2, 2, 0),
      candle(2, 3, 3, 0),
      candle(3, 4, 4, 0),
      candle(4, 5, 5, 0),
    ];
    const channel = donchian(candles, 3);
    expect(channel.upper[2]).toBeUndefined();
    expect(channel.upper[3]).toBe(3);
    expect(channel.upper[4]).toBe(4);
    expect(channel.lower[4]).toBe(0);
  });

  it('wraps an EMA midline with an ATR band for Keltner', () => {
    const candles = flatCandles(40, 100);
    const bands = keltner(candles, 20, 14, 2);
    const last = candles.length - 1;
    expect(bands.upper[10]).toBeUndefined();
    expect(bands.upper[last]).toBeCloseTo(104, 6);
    expect(bands.lower[last]).toBeCloseTo(96, 6);
  });
});

describe('detectRegime', () => {
  const up = risingSeries(260);
  const down = fallingSeries(260);
  const flat = flatSeries(260);

  it('classifies price versus EMA200', () => {
    expect(detectRegime(up, 'priceVsEma200')).toBe('LONG');
    expect(detectRegime(down, 'priceVsEma200')).toBe('SHORT');
    expect(detectRegime(flat, 'priceVsEma200')).toBe('NONE');
  });

  it('classifies EMA50 versus EMA200', () => {
    expect(detectRegime(up, 'ema50Vs200')).toBe('LONG');
    expect(detectRegime(down, 'ema50Vs200')).toBe('SHORT');
    expect(detectRegime(flat, 'ema50Vs200')).toBe('NONE');
  });

  it('classifies the BTC market regime and rejects missing or short data', () => {
    expect(detectRegime([], 'btcMarket', up)).toBe('LONG');
    expect(detectRegime([], 'btcMarket', down)).toBe('SHORT');
    expect(detectRegime([], 'btcMarket', flat)).toBe('NONE');
    expect(detectRegime([], 'btcMarket')).toBe('NONE');
    expect(detectRegime([1, 2, 3], 'priceVsEma200')).toBe('NONE');
  });
});

describe('evaluateTrendEntry', () => {
  function breakoutCandles(): TrendCandle[] {
    const candles = flatCandles(260, 100);
    candles.push(candle(260, 120, 121, 110, 100));
    return candles;
  }

  it('fires a long entry on an upside breakout in a bullish regime', () => {
    const signal = evaluateTrendEntry({
      candles: breakoutCandles(),
      htfCloses: risingSeries(250),
      params: { regimeMode: 'priceVsEma200', volatilityExpansion: false },
    });
    if (!signal) throw new Error('expected an entry signal');
    expect(signal.side).toBe('LONG');
    expect(signal.regime).toBe('LONG');
    expect(signal.entryPrice).toBe(120);
    expect(signal.stop.initialStop).toBeCloseTo(
      120 - DEFAULT_TREND_PARAMS.stopAtrMultiple * signal.stop.atr,
      6
    );
    expect(signal.stop.stopDistance).toBeCloseTo(3 * signal.stop.atr, 6);
    expect(signal.stop.trail).toEqual({ type: 'donchian', lookback: 10 });
    expect(signal.takeProfitPlan).toEqual({ rMultiple: 1, portion: 1 / 3 });
  });

  it('rejects the same upside breakout in a bearish regime', () => {
    const signal = evaluateTrendEntry({
      candles: breakoutCandles(),
      htfCloses: fallingSeries(250),
      params: { regimeMode: 'priceVsEma200', volatilityExpansion: false },
    });
    expect(signal).toBeNull();
  });

  it('fires a short entry on a downside breakout in a bearish regime', () => {
    const candles = flatCandles(260, 100);
    candles.push(candle(260, 80, 90, 79, 100));
    const signal: TrendEntrySignal | null = evaluateTrendEntry({
      candles,
      htfCloses: fallingSeries(250),
      params: { regimeMode: 'priceVsEma200', volatilityExpansion: false },
    });
    if (!signal) throw new Error('expected a short signal');
    expect(signal.side).toBe('SHORT');
    expect(signal.stop.initialStop).toBeGreaterThan(signal.entryPrice);
  });

  it('blocks a low-ATR breakout only when volatility expansion is required', () => {
    const candles = flatCandles(260, 100);
    candles.push(candle(260, 101.5, 101.2, 100.8, 100));
    const htfCloses = risingSeries(250);
    const withoutFilter = evaluateTrendEntry({
      candles,
      htfCloses,
      params: { regimeMode: 'priceVsEma200', volatilityExpansion: false },
    });
    const withFilter = evaluateTrendEntry({
      candles,
      htfCloses,
      params: { regimeMode: 'priceVsEma200', volatilityExpansion: true },
    });
    expect(withoutFilter).not.toBeNull();
    expect(withFilter).toBeNull();
  });
});

describe('initialStopPrice', () => {
  it('places the stop at the configured ATR multiple on both sides', () => {
    expect(initialStopPrice('LONG', 100, 2, DEFAULT_TREND_PARAMS)).toBe(94);
    expect(initialStopPrice('SHORT', 100, 2, DEFAULT_TREND_PARAMS)).toBe(106);
  });
});

describe('trailStop', () => {
  const candles = flatCandles(30, 100);

  it('never loosens a long stop', () => {
    const tightened = trailStop({
      side: 'LONG',
      highestHigh: 105,
      lowestLow: 99,
      currentStop: 95,
      candles,
      params: { trailLookback: 5 },
    });
    expect(tightened).toBeCloseTo(99, 6);

    const kept = trailStop({
      side: 'LONG',
      highestHigh: 105,
      lowestLow: 99,
      currentStop: 100,
      candles,
      params: { trailLookback: 5 },
    });
    expect(kept).toBe(100);
  });

  it('never loosens a short stop', () => {
    const tightened = trailStop({
      side: 'SHORT',
      highestHigh: 105,
      lowestLow: 95,
      currentStop: 105,
      candles,
      params: { trailLookback: 5 },
    });
    expect(tightened).toBeCloseTo(101, 6);

    const kept = trailStop({
      side: 'SHORT',
      highestHigh: 105,
      lowestLow: 95,
      currentStop: 95,
      candles,
      params: { trailLookback: 5 },
    });
    expect(kept).toBe(95);
  });

  it('supports the chandelier trail and still clamps monotonically', () => {
    const tightened = trailStop({
      side: 'LONG',
      highestHigh: 130,
      lowestLow: 90,
      currentStop: 80,
      candles,
      params: { trailType: 'chandelier', chandelierAtrMultiple: 3 },
    });
    expect(tightened).toBeCloseTo(124, 6);

    const kept = trailStop({
      side: 'LONG',
      highestHigh: 130,
      lowestLow: 90,
      currentStop: 128,
      candles,
      params: { trailType: 'chandelier', chandelierAtrMultiple: 3 },
    });
    expect(kept).toBe(128);
  });
});

describe('partialPlan', () => {
  it('returns the validated partial take-profit values', () => {
    expect(partialPlan(DEFAULT_TREND_PARAMS)).toEqual({
      rMultiple: 1,
      portion: 1 / 3,
    });
    expect(
      partialPlan({
        ...DEFAULT_TREND_PARAMS,
        partialTakeProfitR: 2,
        partialPortion: 0.5,
      })
    ).toEqual({ rMultiple: 2, portion: 0.5 });
  });
});

describe('positionSizeUsd', () => {
  it('caps the notional at 25% of equity when that cap binds', () => {
    const sizing = positionSizeUsd({
      equity: 10000,
      entry: 100,
      stop: 99,
      riskPct: 0.01,
      maxLeverage: 5,
      maxNotionalPct: 0.25,
    });
    expect(sizing.notionalUsd).toBeCloseTo(2500, 6);
    expect(sizing.notionalUsd).toBeLessThanOrEqual(2500 + 1e-6);
    expect(sizing.quantity).toBeCloseTo(25, 6);
    expect(sizing.riskUsd).toBeCloseTo(25, 6);
    expect(sizing.leverageUsed).toBeCloseTo(0.25, 6);
  });

  it('caps the notional at the leverage limit when that cap binds', () => {
    const sizing = positionSizeUsd({
      equity: 10000,
      entry: 100,
      stop: 95,
      riskPct: 0.5,
      maxLeverage: 2,
      maxNotionalPct: 10,
    });
    expect(sizing.notionalUsd).toBeCloseTo(20000, 6);
    expect(sizing.leverageUsed).toBeCloseTo(2, 6);
    expect(sizing.quantity).toBeCloseTo(200, 6);
  });

  it('never returns NaN or negative values', () => {
    const zeroRisk = positionSizeUsd({
      equity: 10000,
      entry: 100,
      stop: 100,
      riskPct: 0.01,
      maxLeverage: 5,
      maxNotionalPct: 0.25,
    });
    expect(zeroRisk).toEqual({
      notionalUsd: 0,
      riskUsd: 0,
      quantity: 0,
      leverageUsed: 0,
    });

    const invalid = positionSizeUsd({
      equity: Number.NaN,
      entry: 100,
      stop: 99,
      riskPct: 0.01,
      maxLeverage: 5,
      maxNotionalPct: 0.25,
    });
    for (const value of Object.values(invalid)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
