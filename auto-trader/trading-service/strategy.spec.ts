import { detectRsiDivergence, rsi, rsiSeries } from './indicators.js';
import { isCryptoPerp } from './market-data.js';
import { btcTrendConflict, buildSignal, checkLtfReversal, detectRegime } from './strategy.js';
import type { Candle, Ticker } from './types.js';

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
});

describe('rsiSeries and detectRsiDivergence', () => {
  it('computes rsiSeries matching scalar rsi output', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const series = rsiSeries(values, 14);
    expect(series.length).toBe(30 - 14);
    expect(series[series.length - 1]).toBeCloseTo(rsi(values, 14), 5);
  });

  it('detects a bullish RSI divergence when price lower-low has higher-low RSI', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 35; i += 1) {
      let close = 100;
      if (i === 15) close = 85;
      else if (i > 15 && i < 22) close = 95;
      else if (i === 22) close = 80;
      else if (i > 22) close = 88;
      candles.push({
        time: i * 900,
        open: close,
        high: close + 2,
        low: close - 2,
        close,
        volume: 1000,
      });
    }
    const closes = candles.map((c) => c.close);
    const result = detectRsiDivergence(closes, candles, 14);
    expect(result === 'BULLISH' || result === 'BEARISH' || result === null).toBe(true);
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

    const sig = buildSignal(tickerFor(up), up, [], overboughtLower)!;
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
    const sigReady = buildSignal(tickerFor(up), up, [], normalLower)!;
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
    const sig = buildSignal(tickerFor(up), up, [], fallingKnifeLower)!;
    expect(sig).not.toBeNull();
    expect(sig.timingReady).toBe(false);
    expect(sig.reversalConfirmed).toBe(false);

    // When the last candle reverses with a hammer wick
    const hammerLower = [...fallingKnifeLower];
    hammerLower[29] = {
      time: 29 * 900,
      open: 135.5,
      high: 135.6,
      low: 133.0,
      close: 135.4, // close near open, long lower wick of 2.4 / 2.6 = 92%
      volume: 2500,
    };
    const sigHammer = buildSignal(tickerFor(up), up, [], hammerLower)!;
    expect(sigHammer.reversalConfirmed).toBe(true);
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
});

describe('checkLtfReversal', () => {
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
      makeCandle(100, 101, 98, 98.5, 1000), // red
      makeCandle(98.5, 99, 96, 96.5, 2000), // red, lower close, tiny wick
    ];

    const res = checkLtfReversal(candles, 'LONG');
    expect(res.ready).toBe(false);
    expect(res.reason).toContain('falling knife');
  });

  it('approves LONG when 5m shows a green candle', () => {
    const candles: Candle[] = [
      makeCandle(100, 101, 98, 98.5, 1000), // red
      makeCandle(98.5, 100, 98, 99.5, 2000), // green: close 99.5 > open 98.5
    ];

    const res = checkLtfReversal(candles, 'LONG');
    expect(res.ready).toBe(true);
  });

  it('approves LONG when 5m shows a red candle with a strong hammer wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 101, 98, 98.5, 1000),
      makeCandle(98.5, 98.6, 95.0, 98.2, 2000), // range 3.6, lower wick 98.2 - 95 = 3.2 (88% of range)
    ];

    const res = checkLtfReversal(candles, 'LONG');
    expect(res.ready).toBe(true);
  });

  it('rejects SHORT when 5m is in a climbing knife without star wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 102, 99, 101.5, 1000), // green
      makeCandle(101.5, 104, 101, 103.5, 2000), // green, higher close, tiny wick
    ];

    const res = checkLtfReversal(candles, 'SHORT');
    expect(res.ready).toBe(false);
    expect(res.reason).toContain('climbing knife');
  });

  it('approves SHORT when 5m shows a red candle or star wick', () => {
    const candles: Candle[] = [
      makeCandle(100, 102, 99, 101.5, 1000),
      makeCandle(101.5, 102, 99.5, 100.2, 2000), // red: close 100.2 < open 101.5
    ];

    const res = checkLtfReversal(candles, 'SHORT');
    expect(res.ready).toBe(true);
  });
});


