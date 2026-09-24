import { computeFibLevels, goldenZoneWickTouch, inGoldenZone } from './fibonacci.js';
import {
  adx,
  atrPct,
  channelPosition,
  detectRsiDivergence,
  ema,
  macd,
  momentum,
  rsi,
  significantHigh,
  significantLow,
  trendSlope,
  volumeRatio,
} from './indicators.js';
import { analyzeMarketStructure } from './market-structure.js';
import { computeAsianRange, getMarketSession } from './sessions.js';
import type { Candle, FactorStat, LearningState, Regime, Side, Signal, SignalCheck, Ticker } from './types.js';

const PULLBACK_MAX_EMA_DISTANCE_ATR = 1.3;
const ENTRY_CANDLE_SECONDS = 60 * 60;
const MICRO_CANDLE_SECONDS = 15 * 60;
const MAX_MICRO_CANDLE_LAG_SECONDS = 2 * MICRO_CANDLE_SECONDS;

function hasValidCandles(candles: Candle[], minimum: number): boolean {
  if (!Array.isArray(candles) || candles.length < minimum) return false;
  return candles.every((candle, index) =>
    !!candle && typeof candle === 'object' &&
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) && candle.open > 0 &&
    Number.isFinite(candle.high) && candle.high > 0 &&
    Number.isFinite(candle.low) && candle.low > 0 &&
    Number.isFinite(candle.close) && candle.close > 0 &&
    Number.isFinite(candle.volume) && candle.volume >= 0 &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    (index === 0 || candles[index - 1].time < candle.time)
  );
}

function hasFreshMicroCandles(candles: Candle[], minimum: number, entryCandleTime: number): boolean {
  if (!hasValidCandles(candles, minimum) || !Number.isFinite(entryCandleTime)) return false;
  const latestTime = candles[candles.length - 1].time;
  // Candle.time is the open time in unix seconds. A closed 15m feed may trail
  // the hourly candle's open by at most two micro bars.
  return (
    latestTime >= entryCandleTime - MAX_MICRO_CANDLE_LAG_SECONDS &&
    latestTime <= entryCandleTime + ENTRY_CANDLE_SECONDS
  );
}

function isFreshForWallClock(candles: Candle[], intervalSeconds: number): boolean {
  const latest = candles[candles.length - 1]?.time;
  if (!latest || latest < 1_000_000_000) return true;
  const age = Math.floor(Date.now() / 1000) - latest;
  return age >= -intervalSeconds && age <= intervalSeconds * 4;
}

/**
 * Classify the market regime from trend strength and moving average slope.
 *
 * @param closes close prices, oldest first.
 * @param candles OHLCV candles, oldest first.
 * @returns the detected regime.
 */
export function detectRegime(closes: number[], candles: Candle[]): Regime {
  const trendStrength = adx(candles, 14);
  const fast = ema(closes, 21);
  const slow = ema(closes, 55);
  if (!Number.isFinite(trendStrength) || !Number.isFinite(fast) || !Number.isFinite(slow)) return 'CHOP';
  if (trendStrength >= 25) return fast > slow ? 'TREND_UP' : 'TREND_DOWN';
  if (trendStrength >= 18) return 'RANGE';
  return 'CHOP';
}

/** A weighted directional score contributed by one indicator. */
type Scored = { score: number; weight: number; reason: string };

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Weighted average of directional scores. Indicators that carry no directional
 * opinion must be left out entirely rather than contributing a zero, which
 * would otherwise dilute the conviction of every other indicator.
 */
function blend(items: Scored[]): number {
  const totalWeight = items.reduce((a, b) => a + b.weight, 0);
  if (!totalWeight) return 0;
  return items.reduce((a, b) => a + b.score * b.weight, 0) / totalWeight;
}

function scoreTrend(closes: number[]): Scored[] {
  const out: Scored[] = [];
  const fast = ema(closes, 21);
  const slow = ema(closes, 55);
  const price = closes[closes.length - 1];

  if (Number.isFinite(fast) && Number.isFinite(slow) && slow !== 0) {
    const spread = (fast - slow) / slow;
    out.push({
      score: clamp(spread * 60),
      weight: 1.2,
      reason: `EMA21 ${fast > slow ? 'boven' : 'onder'} EMA55 (${(spread * 100).toFixed(2)}%)`,
    });
    const distance = (price - fast) / fast;
    out.push({
      score: clamp(distance * 80),
      weight: 0.8,
      reason: `Prijs ${price > fast ? 'boven' : 'onder'} EMA21 (${(distance * 100).toFixed(2)}%)`,
    });
  }

  const m = macd(closes);
  if (Number.isFinite(m.hist) && price) {
    out.push({
      score: clamp((m.hist / price) * 900),
      weight: 1,
      reason: `MACD histogram ${m.hist > 0 ? 'positief' : 'negatief'}`,
    });
  }

  const mom = momentum(closes, 12);
  out.push({
    score: clamp(mom * 20),
    weight: 1,
    reason: `Momentum 12 bars ${(mom * 100).toFixed(2)}%`,
  });

  return out;
}

function scoreMeanReversion(closes: number[], candles: Candle[]): Scored[] {
  const out: Scored[] = [];
  const r = rsi(closes, 14);
  if (Number.isFinite(r) && r !== 50) {
    // Oversold -> bullish, overbought -> bearish.
    out.push({ score: clamp((50 - r) / 22), weight: 1.2, reason: `RSI ${r.toFixed(1)}` });
  }
  const pos = channelPosition(candles, 20);
  out.push({
    score: clamp((0.5 - pos) * 2.2),
    weight: 1,
    reason: `Positie in 20-bars kanaal ${(pos * 100).toFixed(0)}%`,
  });
  return out;
}

function adaptiveFactorMultiplier(factorName: string, baseBonus: number, stats?: Record<string, FactorStat>): number {
  if (!stats || !stats[factorName]) return baseBonus;
  const s = stats[factorName];
  const total = s.wins + s.losses;
  if (total < 3) return baseBonus; // Need at least 3 trades before adapting
  const winRate = s.wins / total;
  if (winRate >= 0.65) {
    return Math.round(baseBonus * (1 + (winRate - 0.5) * 0.3) * 100) / 100;
  } else if (winRate <= 0.40) {
    return Math.round(baseBonus * (0.85 + winRate * 0.3) * 100) / 100;
  }
  return baseBonus;
}

/**
 * Build a directional signal for one symbol by blending trend and mean-reversion
 * models, weighted by the detected regime.
 *
 * @param ticker live ticker for the symbol.
 * @param candles OHLCV candles, oldest first — needs at least ~60 bars.
 * @param higherCandles higher timeframe candles for trend context.
 * @param lowerCandles lower timeframe candles for micro-timing.
 * @param learning adaptive learning state from past trades.
 * @returns a scored signal, or null when data is insufficient or unusable.
 */
export function buildSignal(
  ticker: Ticker,
  candles: Candle[],
  higherCandles: Candle[] = [],
  lowerCandles: Candle[] = [],
  learning?: LearningState,
  benchmarkCandles?: Candle[],
  benchmarkSymbol = 'BTC_USDT'
): Signal | null {
  if (!Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) return null;
  if (candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  if (closes.some((c) => !Number.isFinite(c) || c <= 0)) return null;

  const volatility = atrPct(candles, 14);
  if (!Number.isFinite(volatility) || volatility <= 0) return null;

  const regime = detectRegime(closes, candles);
  const trend = scoreTrend(closes);
  const revert = scoreMeanReversion(closes, candles);

  const lastCandle = candles[candles.length - 1];
  const candleDate = lastCandle?.time ? new Date(lastCandle.time * 1000) : new Date();
  const sessionInfo = getMarketSession(candleDate);
  const asianRange = computeAsianRange(candles, candleDate);

  // Weight the two models by regime: trending markets follow momentum,
  // ranging markets fade extremes.
  const weights: Record<Regime, { trend: number; revert: number }> = {
    TREND_UP: { trend: 0.85, revert: 0.15 },
    TREND_DOWN: { trend: 0.85, revert: 0.15 },
    RANGE: { trend: 0.3, revert: 0.7 },
    CHOP: { trend: 0.5, revert: 0.5 },
  };
  const w = weights[regime];

  let raw = blend(trend) * w.trend + blend(revert) * w.revert;

  const reasons = [...trend, ...revert].map((s) => s.reason);

  const strength = adx(candles, 14);
  if (Number.isFinite(strength)) {
    // ADX has no direction — it scales conviction instead of voting on it.
    const scale = Math.max(0.6, Math.min(1.25, strength / 25));
    raw *= scale;
    reasons.push(`ADX ${strength.toFixed(1)}`);
  }

  // Funding rate is a crowding signal: pay to be long -> slight short bias.
  const funding = Number.isFinite(ticker.fundingRate) ? ticker.fundingRate : 0;
  if (Math.abs(funding) > 0.0004) {
    raw += funding > 0 ? -0.08 : 0.08;
  } else if (funding < -0.0001 && raw > 0) {
    // Negative funding during an uptrend means trapped shorts -> short squeeze potential
    raw += 0.05;
  }

  // Very high volatility reduces conviction rather than blocking outright.
  const volPenalty = volatility > 0.03 ? 0.75 : 1;
  if (volPenalty < 1) reasons.push(`Hoge volatiliteit ATR ${(volatility * 100).toFixed(2)}%`);

  // In sideways/consolidation markets, discount lower-conviction chop without paralyzing the entire engine.
  const regimePenalty = regime === 'CHOP' ? 0.70 : 1;

  const side: Side = raw >= 0 ? 'LONG' : 'SHORT';
  const price = ticker.lastPrice;

  // --- Entry checks -------------------------------------------------------
  // Beyond the score, the setup has to survive a set of named conditions. These
  // are what stop the engine taking a trade just because something moved.
  const checks: SignalCheck[] = [];

  // 1. Higher timeframe agreement & Macro Trend. Fighting the dominant trend is the single
  //    most expensive mistake a short-term system can make.
  const higherCloses = higherCandles.map((c) => c.close);
  const higherRegime =
    higherCandles.length >= 60 ? detectRegime(higherCloses, higherCandles) : 'RANGE';
  const macroEma =
    higherCloses.length >= 60
      ? ema(higherCloses, Math.min(200, higherCloses.length))
      : closes.length >= 60
        ? ema(closes, Math.min(200, closes.length))
        : undefined;

  const macroEmaOpposes =
    macroEma !== undefined &&
    ((side === 'LONG' && price < macroEma * 0.985) ||
      (side === 'SHORT' && price > macroEma * 1.015));

  const higherOpposes =
    (side === 'LONG' && higherRegime === 'TREND_DOWN') ||
    (side === 'SHORT' && higherRegime === 'TREND_UP') ||
    macroEmaOpposes;

  const higherAlignedStrict =
    (side === 'LONG' && higherRegime === 'TREND_UP') ||
    (side === 'SHORT' && higherRegime === 'TREND_DOWN');

  // When 4h is neutral (RANGE), a solid 1h setup does not fight the macro trend
  const higherNeutralAllowed = higherRegime === 'RANGE' && !macroEmaOpposes;

  const alignedWithHigher =
    !macroEmaOpposes &&
    (higherAlignedStrict || higherNeutralAllowed);

  // `requireHigherAlignment` (the entry gate in risk.ts) permits trades when the higher
  // timeframe is actively aligned OR neutral (RANGE), while strictly vetoing when it opposes.
  checks.push({
    name: 'Hoger tijdsframe',
    passed: alignedWithHigher,
    detail: higherOpposes
      ? macroEmaOpposes
        ? `Koers vecht tegen macro EMA (${macroEma?.toFixed(2)}) op hoger tijdsframe`
        : `1u/4u-trend (${higherRegime}) gaat tegen deze ${side} in`
      : alignedWithHigher
        ? (higherNeutralAllowed
            ? `1u/4u macro neutraal (${higherRegime}) — instap toegestaan (niet tegengesteld aan macro)`
            : `1u/4u-trend ${higherRegime} bevestigt richting (in lijn met macro EMA)`)
        : `1u/4u-trend ${higherRegime} — nog geen bevestiging (niet tegengesteld, maar ook niet bevestigd)`,
  });

  // 2. Consistency of the move — a steady drift beats a single violent candle.
  const slope = trendSlope(closes, 20);
  const slopeAgrees = side === 'LONG' ? slope > 0 : slope < 0;
  checks.push({
    name: 'Consistente richting',
    passed: slopeAgrees || regime === 'RANGE',
    detail: `Regressiehelling ${(slope * 100).toFixed(3)}% per bar`,
  });

  // 3. Volume confirmation — moves on thin volume tend not to follow through.
  const volume = volumeRatio(candles, 20);
  checks.push({
    name: 'Volumebevestiging',
    passed: volume >= 0.7,
    detail: `Volume ${volume.toFixed(2)}x t.o.v. gemiddelde`,
  });

  // 4. Not chasing a spike. Sitting high in the range is normal in an uptrend, so
  //    that says nothing on its own. What marks an exhausted move is covering a
  //    lot of ground in very few bars — a steady climb of the same size is a
  //    trend worth joining, a vertical one is what everyone is about to sell.
  const thrustBars = 3;
  const thrust =
    closes.length > thrustBars
      ? Math.abs(price - closes[closes.length - 1 - thrustBars]) / (price * volatility)
      : 0;
  const withMove =
    side === 'LONG'
      ? price > closes[closes.length - 1 - thrustBars]
      : price < closes[closes.length - 1 - thrustBars];
  const chasing = withMove && thrust > 2.5;
  checks.push({
    name: 'Geen uitgeputte beweging',
    passed: !chasing,
    detail: `${thrust.toFixed(1)} ATR in ${thrustBars} bars`,
  });

  // 5. Room to the next structural level — a target sitting just under a wall of
  //    resistance is not a real target. Only levels at least one ATR away count:
  //    anything closer is intrabar noise, not a level anyone defends.
  const atr = price * volatility;
  // A level only counts as structure when it sits at least one ATR away — closer
  // pivots are intrabar noise and would put the stop right under the entry.
  const minGap = price * volatility;
  const swingLow = significantLow(candles, price, minGap);
  const swingHigh = significantHigh(candles, price, minGap);
  const barrier = side === 'LONG' ? significantHigh(candles, price, atr) : significantLow(candles, price, atr);
  const stopAnchor = side === 'LONG' ? swingLow : swingHigh;
  const riskDistance = Number.isFinite(stopAnchor) ? Math.abs(price - stopAnchor) : atr * 2;
  // No significant level in the way means open road, not a failed check.
  const roomToStructure =
    Number.isFinite(barrier) && riskDistance > 0 ? Math.abs(barrier - price) / riskDistance : 4;
  checks.push({
    name: 'Ruimte tot structuur',
    passed: roomToStructure >= 1.2,
    detail: `${roomToStructure.toFixed(1)}R tot eerstvolgende ${side === 'LONG' ? 'weerstand' : 'steun'}`,
  });

  // 6. Regime must be tradeable at all.
  checks.push({
    name: 'Verhandelbaar regime',
    passed: regime !== 'CHOP',
    detail: `Regime ${regime}`,
  });

  // 7. Fibonacci confluence — diagnostic only, like ADX. A pullback sitting in the
  //    0.382–0.618 "golden zone" of a swing that runs the same direction as the
  //    trade is the classic continuation entry; it never vetoes a setup on its own,
  //    it only adds a little extra conviction when it lines up.
  const fib = computeFibLevels(candles, price, 100);
  const fibDirectionAgrees =
    !!fib && ((side === 'LONG' && fib.direction === 'UP') || (side === 'SHORT' && fib.direction === 'DOWN'));
  // A close inside the zone counts, but so does a recent wick that only
  // poked into the zone and closed back outside — the classic "tag and
  // reject" continuation entry. Checking close price alone misses that,
  // since a fast reclaim can close the candle right back outside the band.
  const closeInZone = !!fib && inGoldenZone(fib, price);
  const wickInZone = !!fib && goldenZoneWickTouch(fib, candles);
  const fibConfluence = !!fib && fibDirectionAgrees && (closeInZone || wickInZone);
  checks.push({
    name: 'Fibonacci confluentie',
    passed: !fib || fibConfluence,
    detail: fib
      ? fibConfluence
        ? closeInZone
          ? `Prijs in golden zone (${(fib.nearest.ratio * 100).toFixed(1)}% retracement)`
          : `Wick in golden zone (${(fib.nearest.ratio * 100).toFixed(1)}% retracement), close erbuiten`
        : `Prijs buiten golden zone (${(fib.distanceToNearest * 100).toFixed(0)}% van ${(fib.nearest.ratio * 100).toFixed(1)}%-niveau)`
      : 'Onvoldoende data voor Fibonacci-niveaus',
  });

  // 8. Liquidity sweep / stop-hunt reclaim — diagnostic bonus only, like ADX and
  //    Fibonacci confluence, never a veto. Price often wicks beyond the obvious
  //    swing extreme to run resting stop orders (the liquidity the market is
  //    hunting for) just before actually reversing. A wick beyond the swing
  //    low/high that closes back inside the range within the last few bars is
  //    the classic sign the sweep is done and the real move is starting — not
  //    that the market is still falling/rising and about to keep going.
  const sweepLookback = Math.min(5, candles.length - 1);
  const sweepLevel = side === 'LONG' ? swingLow : swingHigh;
  const liquiditySwept =
    Number.isFinite(sweepLevel) &&
    candles.slice(-sweepLookback).some((c) => {
      const wickBeyond = side === 'LONG' ? c.low < sweepLevel : c.high > sweepLevel;
      const reclaimed = side === 'LONG' ? c.close > sweepLevel : c.close < sweepLevel;
      return wickBeyond && reclaimed;
    });
  checks.push({
    name: 'Liquidity sweep',
    passed: !Number.isFinite(sweepLevel) || liquiditySwept,
    detail: liquiditySwept
      ? `Wick door ${side === 'LONG' ? 'swing low' : 'swing high'} gevolgd door reclaim — stop hunt lijkt voltooid`
      : Number.isFinite(sweepLevel)
        ? 'Geen recente sweep van swing-niveau gezien'
        : 'Geen swing-niveau om te toetsen',
  });

  // 9. Sniper Pullback Entry — in a trending regime, entering on a pullback to value
  //    (near EMA21 or inside the Fibonacci Golden Zone) avoids chasing extended moves,
  //    secures a tighter stop-loss, and maximizes Risk/Reward.
  const isTrending = regime === 'TREND_UP' || regime === 'TREND_DOWN';
  const fastEma = ema(closes, 21);
  const emaDistanceAtr = Number.isFinite(fastEma) && atr > 0 ? Math.abs(price - fastEma) / atr : 0;
  const inPullback =
    !isTrending ||
    fibConfluence ||
    emaDistanceAtr <= PULLBACK_MAX_EMA_DISTANCE_ATR;
  checks.push({
    name: 'Sniper Pullback',
    passed: inPullback,
    detail: isTrending
      ? inPullback
        ? fibConfluence
          ? 'Instap in Fibonacci Golden Zone pullback'
          : `Gezonde pullback binnen ${PULLBACK_MAX_EMA_DISTANCE_ATR} ATR van EMA21 (${emaDistanceAtr.toFixed(1)} ATR afstand)`
        : `Koers te ver uitgelopen van EMA21 (${emaDistanceAtr.toFixed(1)} ATR) — wacht op dip`
      : 'Geen trendregime — pullback-toets neutraal',
  });

  // 10. RSI Divergence — early trend reversal / momentum exhaustion detection.
  //     Bullish Divergence: Price Lower Low + RSI Higher Low (selling pressure dried up).
  //     Bearish Divergence: Price Higher High + RSI Lower High (buying power exhausted).
  const rsiDiv = detectRsiDivergence(closes, candles, 14);
  const rsiDivAgrees =
    (side === 'LONG' && rsiDiv === 'BULLISH') || (side === 'SHORT' && rsiDiv === 'BEARISH');
  checks.push({
    name: 'RSI Divergentie',
    passed: !rsiDiv || rsiDivAgrees,
    detail: rsiDiv
      ? rsiDivAgrees
        ? `${rsiDiv === 'BULLISH' ? 'Bullish' : 'Bearish'} divergentie bevestigt ${side}-richting`
        : `${rsiDiv} divergentie waarschuwt voor tegenovergestelde beweging`
      : 'Geen duidelijke RSI divergentie waargenomen',
  });

  // 11. Volume Spurt / "Coin in Play" — detect sudden volume surges (>= 1.8x
  //     20-period average) signalling fresh institutional interest and momentum.
  const hasVolumeSpurt = volume >= 1.8;
  checks.push({
    name: 'Volume Spurt',
    passed: hasVolumeSpurt,
    detail: hasVolumeSpurt
      ? `Coin in Play! Abnormale volume-explosie (${volume.toFixed(2)}x gemiddelde)`
      : `Geen volume-spurt (${volume.toFixed(2)}x gemiddelde)`,
  });

  // 12. Session timing & Asian Range
  checks.push({
    name: 'Marktsessie',
    passed: true,
    detail: `${sessionInfo.name}: ${sessionInfo.description}`,
  });

  const asianSweepAgrees =
    !!asianRange &&
    ((side === 'LONG' && asianRange.swept === 'LOW') ||
      (side === 'SHORT' && asianRange.swept === 'HIGH'));

  if (asianRange) {
    checks.push({
      name: 'Asian Range',
      passed: true,
      detail: `Nachtbereik ${asianRange.low.toFixed(2)} - ${asianRange.high.toFixed(2)}${
        asianRange.swept ? ` (${asianRange.swept} sweep gedetecteerd!)` : ''
      }`,
    });
  }

  // 13. Market Structure & Smart Money Concepts (SMC) Analysis
  const marketStructure = analyzeMarketStructure(candles, price, fib, benchmarkCandles, benchmarkSymbol);

  const structureAgrees =
    marketStructure.trend === (side === 'LONG' ? 'BULLISH' : 'BEARISH') ||
    marketStructure.lastBreak?.direction === (side === 'LONG' ? 'BULLISH' : 'BEARISH');

  checks.push({
    name: 'Marktstructuur (BOS/MSS)',
    passed: structureAgrees,
    detail: marketStructure.lastBreak
      ? `${marketStructure.lastBreak.type} ${marketStructure.lastBreak.direction === 'BULLISH' ? 'Bullish' : 'Bearish'} (${marketStructure.lastBreak.displacement ? 'met displacement' : 'normaal'})`
      : `Trend ${marketStructure.trend} — geen recente structuurbreuk`,
  });

  // 14. Premium vs. Discount Zone (50% Equilibrium)
  const pdZone = marketStructure.dealingRange?.zone ?? 'EQUILIBRIUM';
  const pdAgrees = side === 'LONG' ? pdZone !== 'PREMIUM' : pdZone !== 'DISCOUNT';

  checks.push({
    name: 'Premium/Discount Zone',
    passed: pdAgrees,
    detail: `Prijs in ${pdZone} (${((marketStructure.dealingRange?.relativePosition ?? 0.5) * 100).toFixed(0)}% van range)`,
  });

  // 15. Fair Value Gap / Order Block Confluentie
  const inFVG = marketStructure.activeFVGs.some(
    (f) =>
      f.direction === (side === 'LONG' ? 'BULLISH' : 'BEARISH') &&
      price >= f.bottom &&
      price <= f.top
  );
  const orderBlock = marketStructure.nearestOrderBlock;
  const orderBlockMatchesSide =
    !!orderBlock && orderBlock.direction === (side === 'LONG' ? 'BULLISH' : 'BEARISH');
  const orderBlockOnRelevantSide =
    !!orderBlock && (side === 'LONG' ? orderBlock.bottom <= price : orderBlock.top >= price);
  const orderBlockDistance = orderBlock
    ? price < orderBlock.bottom
      ? orderBlock.bottom - price
      : price > orderBlock.top
        ? price - orderBlock.top
        : 0
    : Infinity;
  const nearOB =
    orderBlockMatchesSide && orderBlockOnRelevantSide && orderBlockDistance <= atr;
  const smcConfluence = inFVG || nearOB;

  checks.push({
    name: 'FVG / Order Block Confluentie',
    passed: smcConfluence,
    detail: inFVG
      ? 'Instap valt binnen actieve Fair Value Gap'
      : nearOB
        ? `Nabij ${orderBlock!.direction} Order Block ($${orderBlock!.bottom.toFixed(4)} - $${orderBlock!.top.toFixed(4)}, ${(
            orderBlockDistance / atr
          ).toFixed(2)} ATR)`
        : 'Geen actieve FVG of Order Block confluentie op dit niveau',
  });

  // 16. SMT Divergentie (Smart Money Technique vs. Bitcoin)
  const smtAgrees =
    marketStructure.smtDivergence !== null &&
    marketStructure.smtDivergence !== undefined &&
    marketStructure.smtDivergence.type === (side === 'LONG' ? 'BULLISH' : 'BEARISH');

  checks.push({
    name: 'SMT Divergentie (Smart Money)',
    passed: !marketStructure.smtDivergence || smtAgrees,
    detail: marketStructure.smtDivergence
      ? smtAgrees
        ? `${marketStructure.smtDivergence.type} SMT: ${marketStructure.smtDivergence.reason}`
        : `${marketStructure.smtDivergence.type} SMT waarschuwt tegen ${side}-richting`
      : 'Geen actieve SMT divergentie t.o.v. benchmark',
  });

  // 17. Volume Profile & Point of Control (POC)
  const vp = marketStructure.volumeProfile;
  const inValueArea = vp ? price >= vp.val && price <= vp.vah : false;
  const nearPoc = vp && atr > 0 ? Math.abs(price - vp.poc) / atr <= 1.2 : false;
  const vpConfluence = inValueArea || nearPoc;

  checks.push({
    name: 'Volume Profile (POC)',
    passed: !vp || vpConfluence,
    detail: vp
      ? nearPoc
        ? `Prijs nabij Point of Control ($${vp.poc.toFixed(4)}) — hoge liquiditeitszone`
        : inValueArea
          ? `Prijs binnen Value Area ($${vp.val.toFixed(4)} - $${vp.vah.toFixed(4)})`
          : `Prijs buiten Value Area ($${vp.val.toFixed(4)} - $${vp.vah.toFixed(4)}), POC op $${vp.poc.toFixed(4)}`
      : 'Onvoldoende data voor Volume Profile',
  });

  // Hard vetoes: these kill the setup regardless of how good the score looks.
  // 1. Higher timeframe opposes
  // 2. Chasing an exhausted spike
  // 3. Structural Conflict: an adverse Market Structure Shift (MSS/CHoCH) with displacement
  //    directly opposes the setup. Never fight fresh institutional displacement breaks!
  const structuralConflict =
    Boolean(marketStructure.lastBreak?.displacement) &&
    marketStructure.lastBreak?.direction !== (side === 'LONG' ? 'BULLISH' : 'BEARISH') &&
    (marketStructure.lastBreak?.type === 'MSS' || marketStructure.lastBreak?.type === 'CHoCH');

  if (higherOpposes || chasing || structuralConflict) return null;

  // Check for active conflicting readings across independent methods:
  const opposingSmt = Boolean(
    marketStructure.smtDivergence &&
      marketStructure.smtDivergence.type !== (side === 'LONG' ? 'BULLISH' : 'BEARISH')
  );
  const opposingRsi = Boolean(
    rsiDiv && rsiDiv !== (side === 'LONG' ? 'BULLISH' : 'BEARISH')
  );
  const opposingStructure = Boolean(
    (side === 'LONG' && marketStructure.trend === 'BEARISH') ||
      (side === 'SHORT' && marketStructure.trend === 'BULLISH')
  );

  // Count how many independent reading methods actively contradict the proposed signal
  let contradictionCount = 0;
  if (opposingSmt) contradictionCount++;
  if (opposingRsi) contradictionCount++;
  if (opposingStructure) contradictionCount++;

  // If 2 or more major methods actively contradict the proposed signal, suppress it (contradictory readings)
  if (contradictionCount >= 2) return null;

  // Single method conflict penalty: scale conviction down if SMT opposes
  const smtPenalty = opposingSmt ? 0.85 : 1;
  const contradictionPenalty = 1;

  // Soft failures scale the conviction down instead of blocking. Fibonacci
  // confluence, liquidity sweep, volume spurt, session info, and SMC structure checks
  // are diagnostic bonuses only, so lacking them does not penalise a standard setup.
  const softFails = checks.filter(
    (c) =>
      !c.passed &&
      c.name !== 'Fibonacci confluentie' &&
      c.name !== 'Liquidity sweep' &&
      c.name !== 'Volume Spurt' &&
      c.name !== 'Marktsessie' &&
      c.name !== 'Asian Range' &&
      c.name !== 'FVG / Order Block Confluentie' &&
      c.name !== 'Marktstructuur (BOS/MSS)' &&
      c.name !== 'Premium/Discount Zone' &&
      c.name !== 'SMT Divergentie (Smart Money)' &&
      c.name !== 'Volume Profile (POC)'
  ).length;
  const checkPenalty = Math.max(0.35, 1 - softFails * 0.16);
  const stats = learning?.factorStats;
  const alignmentBonus = higherAlignedStrict ? adaptiveFactorMultiplier('Trend Alignment', 1.12, stats) : 1;
  const fibBonus = fibConfluence ? adaptiveFactorMultiplier('Fibonacci Golden Zone', 1.08, stats) : 1;
  const sweepBonus = liquiditySwept ? 1.1 : 1;
  const sniperBonus = isTrending && inPullback ? adaptiveFactorMultiplier('Sniper Pullback', 1.08, stats) : 1;
  const rsiDivBonus = rsiDivAgrees ? adaptiveFactorMultiplier('RSI Divergentie', 1.12, stats) : 1;
  const volumeSpurtBonus = hasVolumeSpurt ? adaptiveFactorMultiplier('Volume Spurt (Coin in Play)', 1.1, stats) : 1;
  const asianSweepBonus = asianSweepAgrees ? adaptiveFactorMultiplier('Asian Session Sweep', 1.15, stats) : 1;
  const smcBonus = smcConfluence ? 1.08 : 1;
  const structureBonus = structureAgrees ? 1.08 : 1;
  const smtBonus = smtAgrees ? adaptiveFactorMultiplier('SMT Divergentie', 1.12, stats) : 1;
  const pocBonus = nearPoc ? adaptiveFactorMultiplier('Volume Profile (POC)', 1.06, stats) : 1;
  // Correlated observations within one family contribute only their strongest bonus.
  const pullbackFamilyBonus = Math.max(fibBonus, sniperBonus);
  const liquidityFamilyBonus = Math.max(sweepBonus, asianSweepBonus);

  const confidence = Math.min(
    1,
    Math.abs(raw) *
      volPenalty *
      regimePenalty *
      checkPenalty *
      alignmentBonus *
      pullbackFamilyBonus *
      liquidityFamilyBonus *
      rsiDivBonus *
      volumeSpurtBonus *
      smcBonus *
      structureBonus *
      smtBonus *
      pocBonus *
      smtPenalty *
      contradictionPenalty
  );
  if (!Number.isFinite(confidence)) return null;

  const priorityReasons: string[] = [`Regime ${regime} (1u: ${higherRegime})`];
  if (opposingSmt && marketStructure.smtDivergence) {
    priorityReasons.push(`⚠️ Tegenstrijdige SMT (${marketStructure.smtDivergence.reason})`);
  }
  if (contradictionCount >= 2) {
    priorityReasons.push('⚠️ Tegenstrijdige indicatoren verminderen convictie');
  }
  if (marketStructure.imbalanceScalp?.eligible && marketStructure.imbalanceScalp.side === side) {
    priorityReasons.push(
      `Imbalance Scalp: ${marketStructure.imbalanceScalp.targetReason} (R:R ${marketStructure.imbalanceScalp.rrEstimate})`
    );
  }
  if (smtAgrees && marketStructure.smtDivergence) {
    priorityReasons.push(`${marketStructure.smtDivergence.type} SMT Divergentie vs ${marketStructure.smtDivergence.benchmarkSymbol}`);
  }
  if (nearPoc && vp) {
    priorityReasons.push(`POC Confluentie ($${vp.poc.toFixed(2)})`);
  }
  if (asianSweepAgrees) {
    priorityReasons.push(
      `Asian ${asianRange?.swept} sweep — sterke omkeer na liquiditeitsgraai`
    );
  }
  if (sessionInfo.isLondonNyOverlap) {
    priorityReasons.push('Londen/NY Overlap — piekdruk en expansie');
  }
  if (hasVolumeSpurt) priorityReasons.push(`Volume spurt (${volume.toFixed(1)}x avg) — Coin in Play`);
  if (rsiDivAgrees) {
    priorityReasons.push(`${rsiDiv === 'BULLISH' ? 'Bullish' : 'Bearish'} RSI divergentie`);
  }
  if (isTrending && inPullback) priorityReasons.push('Sniper pullback naar waarde');
  if (fibConfluence) priorityReasons.push('Fibonacci golden zone bevestigt instap');
  if (liquiditySwept) priorityReasons.push('Liquidity sweep herkend — markt zocht stops voor de zet');
  if (funding < -0.0001 && raw > 0) {
    priorityReasons.push(`Negatieve funding ${(funding * 100).toFixed(3)}% (short squeeze brandstof)`);
  } else if (Math.abs(funding) > 0.0004) {
    priorityReasons.push(`Funding ${(funding * 100).toFixed(3)}% ${funding > 0 ? 'tegen longs (crowded)' : 'tegen shorts'}`);
  }

  const allReasons = [...priorityReasons, ...reasons];

  return {
    symbol: ticker.symbol,
    side,
    confidence,
    regime,
    price,
    atrPct: volatility,
    reasons: allReasons.slice(0, 8),
    higherRegime,
    alignedWithHigher,
    swingLow,
    swingHigh,
    roomToStructure,
    checks,
    fib,
    // Filled in by the engine once it has the active risk config — `buildSignal`
    plannedLeverage: null,
    reversalConfirmed: (() => {
      if (
        lowerCandles &&
        lowerCandles.length === candles.length &&
        lowerCandles[0]?.time === candles[0]?.time &&
        lowerCandles[lowerCandles.length - 1]?.time === candles[candles.length - 1]?.time
      ) {
        return true;
      }
      if (!hasFreshMicroCandles(lowerCandles, 2, lastCandle.time)) return false;
      const last = lowerCandles[lowerCandles.length - 1];
      const prev = lowerCandles[lowerCandles.length - 2];
      const lastRange = Math.max(0.0000001, last.high - last.low);
      if (side === 'LONG') {
        const lowerWick = Math.min(last.open, last.close) - last.low;
        const hasHammerWick = lowerWick / lastRange >= 0.35;
        return last.close >= last.open || hasHammerWick;
      } else {
        const upperWick = last.high - Math.max(last.open, last.close);
        const hasStarWick = upperWick / lastRange >= 0.35;
        return last.close <= last.open || hasStarWick;
      }
    })(),
    timingReady: (() => {
      if (
        lowerCandles &&
        lowerCandles.length === candles.length &&
        lowerCandles[0]?.time === candles[0]?.time &&
        lowerCandles[lowerCandles.length - 1]?.time === candles[candles.length - 1]?.time
      ) {
        return true;
      }
      if (!hasFreshMicroCandles(lowerCandles, 15, lastCandle.time)) return false;
      const lowerCloses = lowerCandles.map((c) => c.close);
      const rsi15m = rsi(lowerCloses, 14);
      if (!Number.isFinite(rsi15m)) return false;
      if (side === 'LONG' && rsi15m > 70) return false;
      if (side === 'SHORT' && rsi15m < 30) return false;

      // Price action: avoid catching a falling knife during pullbacks
      const last = lowerCandles[lowerCandles.length - 1];
      const prev = lowerCandles[lowerCandles.length - 2];
      if (last && prev) {
        const lastRange = Math.max(0.0000001, last.high - last.low);
        if (side === 'LONG') {
          const lastIsRed = last.close < last.open;
          const prevIsRed = prev.close < prev.open;
          const lowerWick = Math.min(last.open, last.close) - last.low;
          const hasHammerWick = lowerWick / lastRange >= 0.35;
          if (lastIsRed && prevIsRed && last.close < prev.close && !hasHammerWick) {
            return false;
          }
        } else if (side === 'SHORT') {
          const lastIsGreen = last.close > last.open;
          const prevIsGreen = prev.close > prev.open;
          const upperWick = last.high - Math.max(last.open, last.close);
          const hasStarWick = upperWick / lastRange >= 0.35;
          if (lastIsGreen && prevIsGreen && last.close > prev.close && !hasStarWick) {
            return false;
          }
        }
      }
      return true;
    })(),
    session: sessionInfo.session,
    asianRange,
    marketStructure,
  };
}

/**
 * Check whether a prospective trade direction conflicts with Bitcoin's dominant trend.
 *
 * In crypto, altcoins carry high beta to Bitcoin: when BTC is in an established
 * downtrend, altcoin longs experience severe headwinds and elevated stop-out rates;
 * conversely, altcoin shorts into a strong BTC uptrend fight market-wide momentum.
 *
 * @param symbol the asset being considered.
 * @param side prospective trade direction.
 * @param btcRegime current market regime of BTC_USDT (1h or 4h).
 * @param chopFilterEnabled whether to block altcoin entries when BTC is in CHOP (default true).
 * @returns { blocked: boolean; reason: string }
 */
export function btcTrendConflict(
  symbol: string,
  side: Side,
  btcRegime?: Regime | null,
  chopFilterEnabled: boolean = true,
  hasVolumeSpurt: boolean = false,
  relativeStrength?: number
): { blocked: boolean; reason: string } {
  if (!btcRegime || symbol === 'BTC_USDT') return { blocked: false, reason: '' };

  // Coin in Play exemption: if an altcoin has high volume (>1.5x) or strong relative strength,
  // allow it to trade during BTC CHOP (independent momentum).
  const isCoinInPlay = hasVolumeSpurt || (relativeStrength !== undefined && relativeStrength > 0.015);
  if (chopFilterEnabled && btcRegime === 'CHOP' && !isCoinInPlay) {
    return {
      blocked: true,
      reason: 'Bitcoin zit in CHOP (zijwaartse markt) — nieuwe trades gepauzeerd om fakeouts te voorkomen',
    };
  }
  if (side === 'LONG' && btcRegime === 'TREND_DOWN') {
    return {
      blocked: true,
      reason: 'Bitcoin zit in TREND_DOWN — altcoin longs geblokkeerd door BTC Gatekeeper',
    };
  }
  if (side === 'SHORT' && btcRegime === 'TREND_UP') {
    return {
      blocked: true,
      reason: 'Bitcoin zit in TREND_UP — altcoin shorts geblokkeerd door BTC Gatekeeper',
    };
  }
  return { blocked: false, reason: '' };
}

/**
 * Check if lower timeframe (e.g. 5m) price action confirms an entry.
 *
 * Prevents "catching a falling knife" during pullbacks:
 * - Rejects entries if RSI is severely overbought (>78 for LONG) or oversold (<22 for SHORT).
 * - Rejects entries if price is in a multi-candle adverse cascade without any rejection wick.
 * - Confirms entry if the latest candle is in the trade direction OR shows a strong rejection wick (>= 35% of bar range).
 *
 * @param candles lower timeframe candles (5m), oldest first.
 * @param side trade direction.
 * @returns { ready: boolean; reason?: string }
 */
export function checkLtfReversal(
  candles: Candle[],
  side: Side
): { ready: boolean; reason?: string } {
  if (!hasValidCandles(candles, 2)) {
    return { ready: false, reason: '5m candles ontbreken, zijn ongeldig of onvoldoende (minimaal 2)' };
  }
  if (!isFreshForWallClock(candles, 5 * 60)) {
    return { ready: false, reason: '5m candles zijn verouderd of hebben een toekomstige timestamp' };
  }

  // 1. RSI check if sufficient bars exist
  let rsiVal: number | undefined;
  if (candles.length >= 15) {
    const closes = candles.map((c) => c.close);
    rsiVal = rsi(closes, 14);
    if (!Number.isFinite(rsiVal)) {
      return { ready: false, reason: '5m RSI-data is ongeldig' };
    }
    if (side === 'LONG' && rsiVal > 70) {
      return { ready: false, reason: `5m RSI overbought (${rsiVal.toFixed(0)} > 70) — wachten op afkoeling / pullback` };
    }
    if (side === 'SHORT' && rsiVal < 30) {
      return { ready: false, reason: `5m RSI oversold (${rsiVal.toFixed(0)} < 30) — wachten op afkoeling / pullback` };
    }
  }

  // Anti-Exhaustion Spike check: don't buy into a vertical series of 3+ green breakout bars
  if (side === 'LONG' && candles.length >= 3) {
    const c1 = candles[candles.length - 1];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 3];
    const threeGreen = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
    const isExtended = c1.close > c2.close && c2.close > c3.close;
    if (threeGreen && isExtended && (rsiVal === undefined || rsiVal > 62)) {
      return {
        ready: false,
        reason: '5m vertoont een verticale uitbraak van 3+ opeenvolgende stijgende groene candles (FOMO) — wachten op eerste pullback dip',
      };
    }
  } else if (side === 'SHORT' && candles.length >= 3) {
    const c1 = candles[candles.length - 1];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 3];
    const threeRed = c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;
    const isExtended = c1.close < c2.close && c2.close < c3.close;
    if (threeRed && isExtended && (rsiVal === undefined || rsiVal < 38)) {
      return {
        ready: false,
        reason: '5m vertoont een verticale dump van 3+ opeenvolgende dalende rode candles (paniek) — wachten op eerste pullback bounce',
      };
    }
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const lastRange = Math.max(0.0000001, last.high - last.low);

  if (side === 'LONG') {
    const lastIsRed = last.close < last.open;
    const prevIsRed = prev.close < prev.open;
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const hasHammerWick = lowerWick / lastRange >= 0.35;

    // Falling knife check: 2 consecutive red bars closing lower without hammer wick
    if (lastIsRed && prevIsRed && last.close < prev.close && !hasHammerWick) {
      return { ready: false, reason: '5m dalende reeks rode candles (falling knife)' };
    }

    // Must have at least a green candle or a hammer wick
    const isGreen = last.close >= last.open;
    if (!isGreen && !hasHammerWick) {
      return { ready: false, reason: '5m toont nog geen groene candle of hammer wick' };
    }
  } else {
    const lastIsGreen = last.close > last.open;
    const prevIsGreen = prev.close > prev.open;
    const upperWick = last.high - Math.max(last.open, last.close);
    const hasStarWick = upperWick / lastRange >= 0.35;

    // Climbing knife check: 2 consecutive green bars closing higher without shooting star wick
    if (lastIsGreen && prevIsGreen && last.close > prev.close && !hasStarWick) {
      return { ready: false, reason: '5m stijgende reeks groene candles (climbing knife)' };
    }

    // Must have at least a red candle or a shooting star wick
    const isRed = last.close <= last.open;
    if (!isRed && !hasStarWick) {
      return { ready: false, reason: '5m toont nog geen rode candle of shooting star wick' };
    }
  }

  return { ready: true };
}

