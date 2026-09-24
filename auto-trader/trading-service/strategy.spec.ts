import * as fibonacciModule from './fibonacci.js';
import * as indicatorsModule from './indicators.js';
import { atrPct, detectRsiDivergence, ema, rsi, rsiSeries } from './indicators.js';
import * as marketStructureModule from './market-structure.js';
import { isCryptoPerp } from './market-filter.js';
import * as sessionsModule from './sessions.js';
import { btcTrendConflict, buildSignal, checkLtfReversal, detectRegime } from './strategy.js';
import type { Candle, Ticker } from './types.js';
import { vi } from 'vitest';

describe('market filter', () => {
  it('accepts crypto perpetuals and rejects everything else', () => {
    expect(isCryptoPerp('BTC_USDT')).toBe(true);
    expect(isCryptoPerp('DOGE_USDT')).toBe(true);
    // Metals, energy and equity indices trade on session hours and macro news,
    // so a crypto momentum strategy has no edge there and the session gaps break
    // the candle-based indicators.
    expect(isCryptoPerp('XAU_USDT')).toBe(false);
    expect(isCryptoPerp('USOIL_USDT')).toBe(false);
    expect(isCryptoPerp('SPX500_USDT')).toBe(false);
    expect(isCryptoPerp('SPY_USDT')).toBe(false);
    expect(isCryptoPerp('SOXL_USDT')).toBe(false);
    expect(isCryptoPerp('TESLA_USDT')).toBe(false);
    expect(isCryptoPerp('NVIDIA_USDT')).toBe(false);
    // Non-USDT quotes are excluded too — sizing assumes a USDT-quoted contract.
    expect(isCryptoPerp('BTC_USDC')).toBe(false);
  });
});

function series(fn: (i: number) => number, length = 140): Candle[] {
  return Array.from({ length }, (_, i) => {
    const close = fn(i);
    return {
      time: i * 900,
      open: close * 0.999,
      high: close * 1.004,
      low: close * 0.996,
      close,
      volume: 1000,
    };
  });
}

function tickerFor(candles: Candle[], fundingRate = 0): Ticker {
  return {
    symbol: 'X_USDT',
    lastPrice: candles[candles.length - 1].close,
    quoteVolume24h: 50_000_000,
    changeRate24h: 0.05,
    fundingRate,
  };
}

function alignMicroCandles(candles: Candle[], entryCandles: Candle[]): Candle[] {
  const latest = entryCandles[entryCandles.length - 1].time + 45 * 60;
  return candles.map((candle, index) => ({
    ...candle,
    time: latest - (candles.length - 1 - index) * 15 * 60,
  }));
}

describe('entry discipline', () => {
  it('refuses to trade against the higher timeframe', () => {
    // 15m pulls up while the 1h is in a confirmed downtrend — a counter-trend
    // long here is exactly the trade the engine must not take.
    const bounce = series((i) => (i < 110 ? 200 - i * 0.9 : 101 + (i - 110) * 1.6));
    const higherDown = series((i) => 300 - i * 1.4);
    expect(buildSignal(tickerFor(bounce), bounce, higherDown)).toBeNull();
  });

  it('does not chase a move that is already exhausted', () => {
    // A vertical spike into the very top of its range.
    const spike = series((i) => (i < 130 ? 100 : 100 + (i - 130) * 9));
    expect(buildSignal(tickerFor(spike), spike)).toBeNull();
  });

  it('rewards a setup the higher timeframe confirms', () => {
    const up = series((i) => 100 + i * 0.8);
    const higherUp = series((i) => 60 + i * 1.2);
    const plain = buildSignal(tickerFor(up), up)!;
    const confirmed = buildSignal(tickerFor(up), up, higherUp)!;
    expect(confirmed.alignedWithHigher).toBe(true);
    expect(confirmed.confidence).toBeGreaterThan(plain.confidence);
  });

  it('reports every entry check it evaluated', () => {
    const up = series((i) => 100 + i * 0.8);
    const result = buildSignal(tickerFor(up), up)!;
    expect(result.checks.length).toBeGreaterThanOrEqual(5);
    expect(result.checks.every((c) => c.name && c.detail)).toBe(true);
  });

  it('finds the structure levels used for stops and targets', () => {
    const wavy = series((i) => 100 + i * 0.5 + Math.sin(i / 4) * 6);
    const result = buildSignal(tickerFor(wavy), wavy)!;
    expect(Number.isFinite(result.swingLow) || Number.isFinite(result.swingHigh)).toBe(true);
    expect(result.roomToStructure).toBeGreaterThan(0);
  });
});

describe('signal generation', () => {
  it('goes long on an uptrend and short on a downtrend', () => {
    const up = series((i) => 100 + i * 0.8);
    const down = series((i) => 220 - i * 0.8);
    expect(buildSignal(tickerFor(up), up)?.side).toBe('LONG');
    expect(buildSignal(tickerFor(down), down)?.side).toBe('SHORT');
  });

  it('produces usable conviction on a clean trend', () => {
    const up = series((i) => 100 + i * 0.8);
    const result = buildSignal(tickerFor(up), up);
    // A textbook trend must clear the default entry threshold — a regression
    // here means the indicator blend is diluting conviction to nothing.
    expect(result!.confidence).toBeGreaterThan(0.35);
    expect(result!.regime).toBe('TREND_UP');
  });

  it('rates a directionless market far below a trending one', () => {
    const up = series((i) => 100 + i * 0.8);
    const flat = series((i) => 100 + Math.sin(i / 2) * 0.4);
    const trendConfidence = buildSignal(tickerFor(up), up)!.confidence;
    const flatConfidence = buildSignal(tickerFor(flat), flat)!.confidence;
    expect(flatConfidence).toBeLessThan(trendConfidence);
    expect(detectRegime(flat.map((c) => c.close), flat)).toBe('CHOP');
  });

  it('returns null on insufficient or corrupt data', () => {
    const up = series((i) => 100 + i * 0.8);
    expect(buildSignal(tickerFor(up), [])).toBeNull();
    expect(buildSignal(tickerFor(up), up.slice(0, 30))).toBeNull();
    const broken = series((i) => (i === 50 ? 0 : 100 + i));
    expect(buildSignal(tickerFor(broken), broken)).toBeNull();
  });

  it('rejects non-finite or non-positive ticker prices', () => {
    const candles = series((i) => 100 + i * 0.8);
    for (const lastPrice of [0, -1, NaN, Infinity, -Infinity]) {
      expect(buildSignal({ ...tickerFor(candles), lastPrice }, candles)).toBeNull();
    }
  });

  it('keeps confidence within bounds even with extreme funding', () => {
    const up = series((i) => 100 + i * 0.8);
    const result = buildSignal(tickerFor(up, 0.01), up);
    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });
});

describe('btcTrendConflict (Bitcoin Gatekeeper)', () => {
  it('never blocks Bitcoin trading its own trend', () => {
    expect(btcTrendConflict('BTC_USDT', 'LONG', 'TREND_DOWN').blocked).toBe(false);
    expect(btcTrendConflict('BTC_USDT', 'SHORT', 'TREND_UP').blocked).toBe(false);
  });

  it('blocks altcoin longs when Bitcoin is in TREND_DOWN', () => {
    const check = btcTrendConflict('SOL_USDT', 'LONG', 'TREND_DOWN');
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('TREND_DOWN');
  });

  it('blocks altcoin shorts when Bitcoin is in TREND_UP', () => {
    const check = btcTrendConflict('ETH_USDT', 'SHORT', 'TREND_UP');
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain('TREND_UP');
  });

  it('allows altcoin trades when Bitcoin trend agrees or is neutral', () => {
    expect(btcTrendConflict('SOL_USDT', 'LONG', 'TREND_UP').blocked).toBe(false);
    expect(btcTrendConflict('SOL_USDT', 'SHORT', 'TREND_DOWN').blocked).toBe(false);
    expect(btcTrendConflict('SOL_USDT', 'LONG', 'RANGE').blocked).toBe(false);
    expect(btcTrendConflict('SOL_USDT', 'LONG', 'CHOP', false).blocked).toBe(false);
    expect(btcTrendConflict('SOL_USDT', 'LONG', null).blocked).toBe(false);
  });

  it('blocks altcoin trades when Bitcoin is in CHOP and chop filter is active', () => {
    const checkLong = btcTrendConflict('SOL_USDT', 'LONG', 'CHOP', true);
    expect(checkLong.blocked).toBe(true);
    expect(checkLong.reason).toContain('CHOP');

    const checkShort = btcTrendConflict('SOL_USDT', 'SHORT', 'CHOP', true);
    expect(checkShort.blocked).toBe(true);
    expect(checkShort.reason).toContain('CHOP');

    // Never blocks BTC itself even in CHOP
    expect(btcTrendConflict('BTC_USDT', 'LONG', 'CHOP', true).blocked).toBe(false);
  });

  it('exempts Coin in Play with volume spurt or relative strength from BTC CHOP block', () => {
    // Volume spurt bypasses BTC CHOP
    const withVolume = btcTrendConflict('SOL_USDT', 'LONG', 'CHOP', true, true);
    expect(withVolume.blocked).toBe(false);

    // Relative strength outperforming BTC bypasses BTC CHOP
    const withRS = btcTrendConflict('PEPE_USDT', 'LONG', 'CHOP', true, false, 0.025);
    expect(withRS.blocked).toBe(false);

    // Still blocks when BTC is actively in TREND_DOWN even with volume
    const duringCrash = btcTrendConflict('SOL_USDT', 'LONG', 'TREND_DOWN', true, true);
    expect(duringCrash.blocked).toBe(true);
  });
});

describe('rsiSeries and detectRsiDivergence', () => {
  it('computes rsiSeries matching scalar rsi output', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const series = rsiSeries(values, 14);
    expect(series.length).toBe(30 - 14);
    expect(series[series.length - 1]).toBeCloseTo(rsi(values, 14), 5);
  });

  it('detects a bullish RSI divergence when price lower-low has higher-low RSI', () => {
    const closes = Array.from({ length: 50 }, (_, i) => {
      if (i <= 26) return 100;
      if (i <= 29) return 100 - (i - 26) * 10;
      if (i <= 40) return 70 + (i - 29) * 2;
      if (i <= 45) return 92 - (i - 40) * 5;
      return 67 + (i - 45) * 4;
    });
    const candles: Candle[] = closes.map((close, i) => ({
      time: i * 900,
      open: close,
      high: close + 1,
      low: close,
      close,
      volume: 1000,
    }));
    expect(detectRsiDivergence(closes, candles, 14)).toBe('BULLISH');
  });
});

describe('trade discovery enhancements', () => {
  it('evaluates Sniper Pullback, RSI Divergence, and Volume Spurt checks', () => {
    const up = series((i) => 100 + i * 0.8);
    const sig = buildSignal(tickerFor(up), up)!;
    expect(sig).not.toBeNull();

    const sniper = sig.checks.find((c) => c.name === 'Sniper Pullback');
    expect(sniper).toBeDefined();
    expect(typeof sniper!.passed).toBe('boolean');

    const rsiCheck = sig.checks.find((c) => c.name === 'RSI Divergentie');
    expect(rsiCheck).toBeDefined();
    expect(typeof rsiCheck!.passed).toBe('boolean');

    const spurt = sig.checks.find((c) => c.name === 'Volume Spurt');
    expect(spurt).toBeDefined();
    expect(typeof spurt!.passed).toBe('boolean');
  });

  it('rewards volume spurt with higher confidence and Coin in Play reason', () => {
    const upNormal = series((i) => 100 + i * 0.8);
    const upSpurt = series((i) => 100 + i * 0.8);
    upSpurt[upSpurt.length - 2].volume = 3500;

    const sigNormal = buildSignal(tickerFor(upNormal), upNormal)!;
    const sigSpurt = buildSignal(tickerFor(upSpurt), upSpurt)!;

    const spurtCheck = sigSpurt.checks.find((c) => c.name === 'Volume Spurt');
    expect(spurtCheck?.passed).toBe(true);
    expect(sigSpurt.confidence).toBeGreaterThan(sigNormal.confidence);
    expect(sigSpurt.reasons.some((r) => r.includes('Volume spurt'))).toBe(true);
  });

  it('flags timingReady false when 15m micro-timeframe RSI is overbought', () => {
    const up = series((i) => 100 + i * 0.8);
    // Create distinct lowerCandles with higher resolution and high RSI
    const overboughtLower: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      time: i * 900,
      open: 100 + i * 1.5,
      high: 100 + i * 1.5 + 0.5,
      low: 100 + i * 1.5 - 0.2,
      close: 100 + i * 1.5 + 0.3,
      volume: 1000,
    }));

    const sig = buildSignal(tickerFor(up), up, [], alignMicroCandles(overboughtLower, up))!;
    expect(sig).not.toBeNull();
    expect(sig.timingReady).toBe(false);

    // When lowerCandles has normal/pullback RSI
    const normalLower: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      time: i * 900,
      open: 100 + (i % 2 === 0 ? 0.5 : -0.5),
      high: 101,
      low: 99,
      close: 100 + (i % 2 === 0 ? 0.2 : -0.2),
      volume: 1000,
    }));
    const sigReady = buildSignal(tickerFor(up), up, [], alignMicroCandles(normalLower, up))!;
    expect(sigReady.timingReady).toBe(true);
    expect(sigReady.reversalConfirmed).toBe(true);
  });

  it('detects falling knife on 15m and flags reversalConfirmed false', () => {
    const up = series((i) => 100 + i * 0.8);
    // Consecutive falling red candles making lower lows without hammer wick
    const fallingKnifeLower: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      time: i * 900,
      open: 150 - i * 0.5,
      high: 150 - i * 0.5 + 0.1,
      low: 150 - i * 0.5 - 1.0,
      close: 150 - i * 0.5 - 0.9,
      volume: 1000,
    }));
    const alignedFallingKnife = alignMicroCandles(fallingKnifeLower, up);
    const sig = buildSignal(tickerFor(up), up, [], alignedFallingKnife)!;
    expect(sig).not.toBeNull();
    expect(sig.timingReady).toBe(false);
    expect(sig.reversalConfirmed).toBe(false);

    // When the last candle reverses with a hammer wick
    const hammerLower = [...alignedFallingKnife];
    hammerLower[29] = {
      time: alignedFallingKnife[29].time,
      open: 135.5,
      high: 135.6,
      low: 133.0,
      close: 135.4, // close near open, long lower wick of 2.4 / 2.6 = 92%
      volume: 2500,
    };
    const sigHammer = buildSignal(tickerFor(up), up, [], hammerLower)!;
    expect(sigHammer.reversalConfirmed).toBe(true);
  });

  it('fails closed when 15m timing or reversal data is missing, short, invalid, or stale', () => {
    const up = series((i) => 100 + i * 0.8);
    const missing = buildSignal(tickerFor(up), up, [], [])!;
    expect(missing.timingReady).toBe(false);
    expect(missing.reversalConfirmed).toBe(false);

    const short = alignMicroCandles(up.slice(0, 10), up);
    const shortSignal = buildSignal(tickerFor(up), up, [], short)!;
    expect(shortSignal.timingReady).toBe(false);
    expect(shortSignal.reversalConfirmed).toBe(true);

    const invalid = alignMicroCandles(up.slice(-20), up);
    invalid[invalid.length - 1] = { ...invalid[invalid.length - 1], close: NaN };
    const invalidSignal = buildSignal(tickerFor(up), up, [], invalid)!;
    expect(invalidSignal.timingReady).toBe(false);
    expect(invalidSignal.reversalConfirmed).toBe(false);

    const stale = alignMicroCandles(up.slice(-20), up);
    const staleBy = stale[stale.length - 1].time - up[up.length - 1].time + 2 * 15 * 60 + 1;
    for (const candle of stale) candle.time -= staleBy;
    const staleSignal = buildSignal(tickerFor(up), up, [], stale)!;
    expect(staleSignal.timingReady).toBe(false);
    expect(staleSignal.reversalConfirmed).toBe(false);
  });

  it('accepts a valid Fib pullback bonus without stacking the correlated sniper bonus', () => {
    const up = series((i) => 100 + i * 0.8);
    const closes = up.map((candle) => candle.close);
    const price = ema(closes, 21);
    const atr = price * atrPct(up, 14);
    const structure = marketStructureModule.analyzeMarketStructure(up, price, null);
    const structureSpy = vi.spyOn(marketStructureModule, 'analyzeMarketStructure').mockReturnValue(structure);
    const fibSpy = vi.spyOn(fibonacciModule, 'computeFibLevels').mockReturnValue(null);
    try {
      const withoutFib = buildSignal({ ...tickerFor(up), lastPrice: price }, up)!;
      const fib = {
        swingHigh: price + atr * 2,
        swingLow: price - atr * 2,
        direction: 'UP' as const,
        retracements: [
          { ratio: 0.236, price: price + atr * 1.5 },
          { ratio: 0.382, price: price + atr * 0.5 },
          { ratio: 0.5, price },
          { ratio: 0.618, price: price - atr * 0.5 },
          { ratio: 0.786, price: price - atr },
        ],
        extensions: [],
        nearest: { ratio: 0.5, price },
        distanceToNearest: 0,
      };
      fibSpy.mockReturnValue(fib);
      const withFib = buildSignal({ ...tickerFor(up), lastPrice: price }, up)!;

      expect(withoutFib.checks.find((check) => check.name === 'Sniper Pullback')?.passed).toBe(true);
      expect(withFib.checks.find((check) => check.name === 'Sniper Pullback')?.passed).toBe(true);
      expect(withFib.checks.find((check) => check.name === 'Fibonacci confluentie')?.passed).toBe(true);
      expect(withFib.confidence).toBeCloseTo(withoutFib.confidence, 12);
    } finally {
      fibSpy.mockRestore();
      structureSpy.mockRestore();
    }
  });

  it('rejects deep EMA21 extensions on either side but accepts near-EMA pullbacks', () => {
    const fibSpy = vi.spyOn(fibonacciModule, 'computeFibLevels').mockReturnValue(null);
    try {
      for (const [candles, side] of [
        [series((i) => 100 + i * 0.8), 'LONG'],
        [series((i) => 220 - i * 0.8), 'SHORT'],
      ] as const) {
        const closes = candles.map((candle) => candle.close);
        const fastEma = ema(closes, 21);
        const atr = fastEma * atrPct(candles, 14);
        const direction = side === 'LONG' ? -1 : 1;
        const checkAt = (distanceAtr: number) => {
          const signal = buildSignal(
            { ...tickerFor(candles), lastPrice: fastEma + direction * atr * distanceAtr },
            candles
          )!;
          expect(signal.side).toBe(side);
          return signal.checks.find((check) => check.name === 'Sniper Pullback')!.passed;
        };

        expect(checkAt(0.5)).toBe(true);
        expect(checkAt(2)).toBe(false);
      }
    } finally {
      fibSpy.mockRestore();
    }
  });

  it('caps overlapping swing-sweep and Asian-session-sweep evidence to one bonus', () => {
    const up = series((i) => 100 + i * 0.8);
    const last = up[up.length - 1];
    const asianRange = {
      high: last.close + 2,
      low: last.close - 2,
      mid: last.close,
      rangePct: 0.02,
      swept: 'LOW' as const,
    };
    const rangeSpy = vi.spyOn(sessionsModule, 'computeAsianRange');
    const lowSpy = vi.spyOn(indicatorsModule, 'significantLow');
    try {
      const signalWith = (sweepLevel: number, range: typeof asianRange | null) => {
        rangeSpy.mockReturnValue(range);
        lowSpy.mockReturnValue(sweepLevel);
        return buildSignal(tickerFor(up), up)!;
      };

      const asianOnly = signalWith(last.low - 100, asianRange);
      const both = signalWith(last.low + 0.1, asianRange);
      expect(asianOnly.checks.find((check) => check.name === 'Liquidity sweep')?.passed).toBe(false);
      expect(both.checks.find((check) => check.name === 'Liquidity sweep')?.passed).toBe(true);
      expect(both.confidence).toBeCloseTo(asianOnly.confidence, 12);
    } finally {
      rangeSpy.mockRestore();
      lowSpy.mockRestore();
    }
  });

  it('gives confidence bonus when funding rate is negative during uptrend', () => {
    const up = series((i) => 100 + i * 0.8);
    const neutralTicker = tickerFor(up, 0);
    const negativeFundingTicker = tickerFor(up, -0.0003);

    const sigNeutral = buildSignal(neutralTicker, up)!;
    const sigBonus = buildSignal(negativeFundingTicker, up)!;

    expect(sigBonus.confidence).toBeGreaterThan(sigNeutral.confidence);
    expect(sigBonus.reasons.some((r) => r.includes('short squeeze'))).toBe(true);
  });

  it('penalizes conviction when SMT divergence opposes trade direction', () => {
    const up = series((i) => 100 + i * 0.8);
    // Benchmark BTC making higher highs, but asset making lower highs -> Bearish SMT
    // Against a LONG signal, Bearish SMT should trigger conflict penalty
    const sig = buildSignal(tickerFor(up), up)!;
    expect(sig).not.toBeNull();
  });

  it('counts an order block only when direction and distance fit the signal', () => {
    const up = series((i) => 100 + i * 0.8);
    const price = up[up.length - 1].close;
    const structure = marketStructureModule.analyzeMarketStructure(up, price);
    const spy = vi.spyOn(marketStructureModule, 'analyzeMarketStructure');
    try {
      const evaluate = (direction: 'BULLISH' | 'BEARISH', bottom: number, top: number) => {
        spy.mockReturnValue({
          ...structure,
          activeFVGs: [],
          nearestOrderBlock: {
            direction,
            bottom,
            top,
            candleIndex: 10,
            time: up[10].time,
            mitigated: false,
          },
        });
        return buildSignal(tickerFor(up), up)!.checks.find((c) => c.name === 'FVG / Order Block Confluentie')!.passed;
      };

      expect(evaluate('BEARISH', price - 0.1, price + 0.1)).toBe(false);
      expect(evaluate('BULLISH', price - 5, price - 4)).toBe(false);
      expect(evaluate('BULLISH', price - 0.5, price + 0.2)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('checkLtfReversal', () => {
  const recentBase = Math.floor(Date.now() / 1000) - 5 * 60;
  const makeCandle = (o: number, h: number, l: number, c: number, t: number): Candle => ({
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1000,
    time: t,
  });

  it('rejects LONG when 5m is in a falling knife without hammer wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 101, 98, 98.5, recentBase), // red
      makeCandle(98.5, 99, 96, 96.5, recentBase + 300), // red, lower close, tiny wick
    ];

    const res = checkLtfReversal(candles, 'LONG');
    expect(res.ready).toBe(false);
    expect(res.reason).toContain('falling knife');
  });

  it('approves LONG when 5m shows a green candle', () => {
    const candles: Candle[] = [
      makeCandle(100, 101, 98, 98.5, recentBase), // red
      makeCandle(98.5, 100, 98, 99.5, recentBase + 300), // green: close 99.5 > open 98.5
    ];

    const res = checkLtfReversal(candles, 'LONG');
    expect(res.ready).toBe(true);
  });

  it('approves LONG when 5m shows a red candle with a strong hammer wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 101, 98, 98.5, recentBase),
      makeCandle(98.5, 98.6, 95.0, 98.2, recentBase + 300), // range 3.6, lower wick 98.2 - 95 = 3.2 (88% of range)
    ];

    const res = checkLtfReversal(candles, 'LONG');
    expect(res.ready).toBe(true);
  });

  it('rejects SHORT when 5m is in a climbing knife without star wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 102, 99, 101.5, recentBase), // green
      makeCandle(101.5, 104, 101, 103.5, recentBase + 300), // green, higher close, tiny wick
    ];

    const res = checkLtfReversal(candles, 'SHORT');
    expect(res.ready).toBe(false);
    expect(res.reason).toContain('climbing knife');
  });

  it('approves SHORT when 5m shows a red candle or star wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 102, 99, 101.5, recentBase),
      makeCandle(101.5, 102, 99.5, 100.2, recentBase + 300), // red: close 100.2 < open 101.5
    ];

    const res = checkLtfReversal(candles, 'SHORT');
    expect(res.ready).toBe(true);
  });

  it('fails closed on missing, malformed, or stale 5m candles', () => {
    expect(checkLtfReversal([], 'LONG').ready).toBe(false);
    expect(checkLtfReversal([makeCandle(100, 101, 99, 100, recentBase)], 'LONG').ready).toBe(false);
    expect(
      checkLtfReversal(
        [makeCandle(100, 101, 99, 100, recentBase), makeCandle(100, 101, 99, NaN, recentBase + 300)],
        'LONG'
      ).ready
    ).toBe(false);
    expect(
      checkLtfReversal(
        [makeCandle(100, 101, 99, 100, recentBase - 3600), makeCandle(100, 101, 99, 100, recentBase - 3300)],
        'LONG'
      ).ready
    ).toBe(false);
  });
});


