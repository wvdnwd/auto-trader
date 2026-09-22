import type {
  Candle,
  DealingRange,
  FairValueGap,
  FibLevels,
  MarketStructureInfo,
  OrderBlock,
  PivotPoint,
  PivotType,
  Side,
  StructureBreak,
} from './types.js';

/**
 * Identify swing pivot points (fractals) in a candle series.
 *
 * A pivot high has higher highs than `strength` bars on either side.
 * A pivot low has lower lows than `strength` bars on either side.
 *
 * @param candles OHLCV series, oldest first.
 * @param strength number of bars on each side required to confirm a pivot (default 2).
 * @returns confirmed pivot points sorted chronologically.
 */
export function findPivots(candles: Candle[], strength = 2): PivotPoint[] {
  if (candles.length < strength * 2 + 1) return [];

  const pivots: PivotPoint[] = [];
  let lastHigh: number | null = null;
  let lastLow: number | null = null;

  // We scan up to candles.length - strength so pivots have confirmation bars
  for (let i = strength; i < candles.length - strength; i += 1) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= strength; j += 1) {
      if (candles[i - j].high >= current.high || candles[i + j].high > current.high) {
        isHigh = false;
      }
      if (candles[i - j].low <= current.low || candles[i + j].low < current.low) {
        isLow = false;
      }
    }

    if (isHigh) {
      const type: PivotType = lastHigh === null || current.high > lastHigh ? 'HH' : 'LH';
      lastHigh = current.high;
      pivots.push({
        type,
        price: current.high,
        index: i,
        time: current.time,
      });
    }

    if (isLow) {
      const type: PivotType = lastLow === null || current.low > lastLow ? 'HL' : 'LL';
      lastLow = current.low;
      pivots.push({
        type,
        price: current.low,
        index: i,
        time: current.time,
      });
    }
  }

  return pivots;
}

/**
 * Calculate the active dealing range and Equilibrium (50%) zone.
 *
 * @param candles OHLCV series.
 * @param currentPrice current mark/close price.
 * @param lookback number of candles to establish the dealing range (default 60).
 */
export function getDealingRange(candles: Candle[], currentPrice: number, lookback = 60): DealingRange {
  const window = candles.slice(-lookback);
  if (!window.length) {
    return {
      high: currentPrice,
      low: currentPrice,
      equilibrium: currentPrice,
      zone: 'EQUILIBRIUM',
      relativePosition: 0.5,
    };
  }

  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  const range = high - low;
  const equilibrium = (high + low) / 2;
  const relativePosition = range > 0 ? Math.max(0, Math.min(1, (currentPrice - low) / range)) : 0.5;

  let zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' = 'EQUILIBRIUM';
  if (relativePosition > 0.52) zone = 'PREMIUM';
  else if (relativePosition < 0.48) zone = 'DISCOUNT';

  return {
    high,
    low,
    equilibrium,
    zone,
    relativePosition,
  };
}

/**
 * Detect Fair Value Gaps (FVG) / Imbalances.
 *
 * Bullish FVG: candle[i-2].high < candle[i].low (an unfilled gap formed during upward impulse).
 * Bearish FVG: candle[i-2].low > candle[i].high (an unfilled gap formed during downward impulse).
 *
 * @param candles OHLCV series.
 * @param minGapPct minimum gap size as a fraction of price (default 0.0008 = 0.08%).
 * @returns detected Fair Value Gaps.
 */
export function detectFairValueGaps(candles: Candle[], minGapPct = 0.0008): FairValueGap[] {
  if (candles.length < 3) return [];

  const fvgs: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i += 1) {
    const cPrev = candles[i - 2];
    const cCurr = candles[i];
    const cMid = candles[i - 1];

    // Bullish FVG
    if (cCurr.low > cPrev.high) {
      const gapSize = (cCurr.low - cPrev.high) / cMid.close;
      if (gapSize >= minGapPct) {
        const top = cCurr.low;
        const bottom = cPrev.high;
        const midpoint = (top + bottom) / 2;

        // Check if subsequent candles mitigated (retested) this FVG
        let mitigated = false;
        let mitigatedAt: number | undefined;
        for (let k = i + 1; k < candles.length; k += 1) {
          if (candles[k].low <= bottom) {
            mitigated = true;
            mitigatedAt = candles[k].time;
            break;
          }
        }

        fvgs.push({
          direction: 'BULLISH',
          top,
          bottom,
          midpoint,
          candleIndex: i - 1,
          time: cMid.time,
          mitigated,
          mitigatedAt,
        });
      }
    }

    // Bearish FVG
    if (cPrev.low > cCurr.high) {
      const gapSize = (cPrev.low - cCurr.high) / cMid.close;
      if (gapSize >= minGapPct) {
        const top = cPrev.low;
        const bottom = cCurr.high;
        const midpoint = (top + bottom) / 2;

        // Check if subsequent candles mitigated (retested) this FVG
        let mitigated = false;
        let mitigatedAt: number | undefined;
        for (let k = i + 1; k < candles.length; k += 1) {
          if (candles[k].high >= top) {
            mitigated = true;
            mitigatedAt = candles[k].time;
            break;
          }
        }

        fvgs.push({
          direction: 'BEARISH',
          top,
          bottom,
          midpoint,
          candleIndex: i - 1,
          time: cMid.time,
          mitigated,
          mitigatedAt,
        });
      }
    }
  }

  return fvgs;
}

/**
 * Detect Order Blocks (OB).
 *
 * Bullish Order Block: the last bearish candle before an aggressive bullish impulse.
 * Bearish Order Block: the last bullish candle before an aggressive bearish impulse.
 *
 * @param candles OHLCV series.
 * @param minDisplacementPct minimum impulse size following the candle (default 0.015 = 1.5%).
 */
export function detectOrderBlocks(candles: Candle[], minDisplacementPct = 0.012): OrderBlock[] {
  if (candles.length < 5) return [];

  const orderBlocks: OrderBlock[] = [];

  for (let i = 1; i < candles.length - 2; i += 1) {
    const c = candles[i];
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];

    // Bullish OB: bearish candle (close < open) followed by strong upward impulse
    const isBearishCandle = c.close < c.open;
    const impulseUp = Math.max(next1.close, next2.close) - c.low;
    if (isBearishCandle && impulseUp / c.close >= minDisplacementPct) {
      let mitigated = false;
      for (let k = i + 3; k < candles.length; k += 1) {
        if (candles[k].low <= c.low) {
          mitigated = true;
          break;
        }
      }
      orderBlocks.push({
        direction: 'BULLISH',
        top: Math.max(c.open, c.high),
        bottom: c.low,
        candleIndex: i,
        time: c.time,
        mitigated,
      });
    }

    // Bearish OB: bullish candle (close > open) followed by strong downward impulse
    const isBullishCandle = c.close > c.open;
    const impulseDown = c.high - Math.min(next1.close, next2.close);
    if (isBullishCandle && impulseDown / c.close >= minDisplacementPct) {
      let mitigated = false;
      for (let k = i + 3; k < candles.length; k += 1) {
        if (candles[k].high >= c.high) {
          mitigated = true;
          break;
        }
      }
      orderBlocks.push({
        direction: 'BEARISH',
        top: c.high,
        bottom: Math.min(c.open, c.low),
        candleIndex: i,
        time: c.time,
        mitigated,
      });
    }
  }

  return orderBlocks;
}

/**
 * Detect 24/7 Swing Liquidity Sweeps (Buy-Side Liquidity & Sell-Side Liquidity).
 *
 * A sweep occurs when price wicks past a prior swing pivot but closes back within the range.
 *
 * @param candles OHLCV series.
 * @param pivots confirmed swing points.
 * @param lookbackBars number of recent bars to scan for sweeps (default 6).
 */
export function detectLiquiditySweep(
  candles: Candle[],
  pivots: PivotPoint[],
  lookbackBars = 6
): { type: 'BSL' | 'SSL'; level: number; time: number } | null {
  if (candles.length < lookbackBars || pivots.length === 0) return null;

  const recentCandles = candles.slice(-lookbackBars);

  // Recent swing highs and lows
  const highPivots = pivots.filter((p) => p.type === 'HH' || p.type === 'LH');
  const lowPivots = pivots.filter((p) => p.type === 'HL' || p.type === 'LL');

  // Check for Buy-Side Liquidity (BSL) sweep at highs
  if (highPivots.length > 0) {
    const lastHigh = highPivots[highPivots.length - 1];
    for (const c of recentCandles) {
      if (c.time > lastHigh.time && c.high > lastHigh.price && c.close < lastHigh.price) {
        return {
          type: 'BSL',
          level: lastHigh.price,
          time: c.time,
        };
      }
    }
  }

  // Check for Sell-Side Liquidity (SSL) sweep at lows
  if (lowPivots.length > 0) {
    const lastLow = lowPivots[lowPivots.length - 1];
    for (const c of recentCandles) {
      if (c.time > lastLow.time && c.low < lastLow.price && c.close > lastLow.price) {
        return {
          type: 'SSL',
          level: lastLow.price,
          time: c.time,
        };
      }
    }
  }

  return null;
}

/**
 * Detect Market Structure Shifts (MSS / CHoCH) and Breaks of Structure (BOS).
 *
 * Crucial SMC distinction:
 * - A wick past a level is a liquidity sweep.
 * - A candle BODY CLOSE past the structural level confirms a true BOS or MSS/CHoCH.
 *
 * @param candles OHLCV series.
 * @param pivots confirmed swing points.
 */
export function detectMarketStructureBreaks(
  candles: Candle[],
  pivots: PivotPoint[]
): {
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  lastBreak: StructureBreak | null;
} {
  if (pivots.length < 2 || candles.length < 3) {
    return { trend: 'NEUTRAL', lastBreak: null };
  }

  const highPivots = pivots.filter((p) => p.type === 'HH' || p.type === 'LH');
  const lowPivots = pivots.filter((p) => p.type === 'HL' || p.type === 'LL');

  if (!highPivots.length || !lowPivots.length) {
    return { trend: 'NEUTRAL', lastBreak: null };
  }

  const lastHigh = highPivots[highPivots.length - 1];
  const lastLow = lowPivots[lowPivots.length - 1];

  // Determine current baseline trend from recent pivots
  let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lastHigh.type === 'HH' && lastLow.type === 'HL') {
    trend = 'BULLISH';
  } else if (lastHigh.type === 'LH' && lastLow.type === 'LL') {
    trend = 'BEARISH';
  }

  let lastBreak: StructureBreak | null = null;
  const recentWindow = candles.slice(-20);

  // Scan recent candles for structure breaks with candle body close
  for (let idx = 0; idx < recentWindow.length; idx += 1) {
    const c = recentWindow[idx];
    const candleBodyHigh = Math.max(c.open, c.close);
    const candleBodyLow = Math.min(c.open, c.close);
    const candleRange = Math.abs(c.close - c.open);

    // Bullish breaks
    if (c.time > lastHigh.time && candleBodyHigh > lastHigh.price) {
      const isCHoCH = trend === 'BEARISH' || lastHigh.type === 'LH';
      const displacement = candleRange > (c.high - c.low) * 0.6;
      lastBreak = {
        type: isCHoCH ? 'CHoCH' : 'BOS',
        direction: 'BULLISH',
        brokenLevel: lastHigh.price,
        candleIndex: candles.length - recentWindow.length + idx,
        time: c.time,
        displacement,
      };
      trend = 'BULLISH';
    }

    // Bearish breaks
    if (c.time > lastLow.time && candleBodyLow < lastLow.price) {
      const isCHoCH = trend === 'BULLISH' || lastLow.type === 'HL';
      const displacement = candleRange > (c.high - c.low) * 0.6;
      lastBreak = {
        type: isCHoCH ? 'CHoCH' : 'BOS',
        direction: 'BEARISH',
        brokenLevel: lastLow.price,
        candleIndex: candles.length - recentWindow.length + idx,
        time: c.time,
        displacement,
      };
      trend = 'BEARISH';
    }
  }

  return { trend, lastBreak };
}

/**
 * Plan an Imbalance / Golden Zone Retracement Scalp.
 *
 * When a sweep of liquidity (BSL/SSL) occurs and is confirmed by an opposing micro-shift,
 * the market has high probability of retracing to fill the active Fair Value Gap or
 * retest the Fibonacci 0.618 Golden Zone.
 */
export function planImbalanceScalp(
  candles: Candle[],
  currentPrice: number,
  fib: FibLevels | null,
  activeFVGs: FairValueGap[],
  sweep: { type: 'BSL' | 'SSL'; level: number; time: number } | null
): MarketStructureInfo['imbalanceScalp'] {
  if (!sweep || candles.length < 5) return null;

  const recentCandles = candles.slice(-5);
  const highestRecent = Math.max(...recentCandles.map((c) => c.high));
  const lowestRecent = Math.min(...recentCandles.map((c) => c.low));

  // SHORT Scalp after Buy-Side Liquidity (BSL) sweep
  if (sweep.type === 'BSL') {
    const stopLoss = highestRecent * 1.002; // Tight stop just above the sweep wick
    const stopDist = stopLoss - currentPrice;
    if (stopDist <= 0) return null;

    // Find target: nearest unmitigated bullish FVG below or Fib 0.618 Golden Zone
    let targetPrice: number | null = null;
    let targetReason = '';

    // Prefer unmitigated bullish FVG below current price
    const fvgBelow = activeFVGs
      .filter((f) => !f.mitigated && f.direction === 'BULLISH' && f.top < currentPrice)
      .sort((a, b) => b.top - a.top)[0];

    if (fvgBelow) {
      targetPrice = fvgBelow.midpoint;
      targetReason = `Fair Value Gap midpoint ($${fvgBelow.midpoint.toFixed(4)})`;
    } else if (fib && fib.direction === 'UP') {
      const gZone = fib.retracements.find((r) => r.ratio === 0.618 || r.ratio === 0.5);
      if (gZone && gZone.price < currentPrice) {
        targetPrice = gZone.price;
        targetReason = `Fibonacci Golden Zone ${(gZone.ratio * 100).toFixed(1)}% ($${gZone.price.toFixed(4)})`;
      }
    }

    if (!targetPrice || targetPrice >= currentPrice) return null;

    const reward = currentPrice - targetPrice;
    const rrEstimate = reward / stopDist;
    if (rrEstimate < 1.8) return null;

    return {
      eligible: true,
      side: 'SHORT',
      targetPrice,
      targetReason,
      stopLoss,
      rrEstimate: Number(rrEstimate.toFixed(2)),
    };
  }

  // LONG Scalp after Sell-Side Liquidity (SSL) sweep
  if (sweep.type === 'SSL') {
    const stopLoss = lowestRecent * 0.998; // Tight stop just below the sweep wick
    const stopDist = currentPrice - stopLoss;
    if (stopDist <= 0) return null;

    // Find target: nearest unmitigated bearish FVG above or Fib 0.618 Golden Zone
    let targetPrice: number | null = null;
    let targetReason = '';

    const fvgAbove = activeFVGs
      .filter((f) => !f.mitigated && f.direction === 'BEARISH' && f.bottom > currentPrice)
      .sort((a, b) => a.bottom - b.bottom)[0];

    if (fvgAbove) {
      targetPrice = fvgAbove.midpoint;
      targetReason = `Fair Value Gap midpoint ($${fvgAbove.midpoint.toFixed(4)})`;
    } else if (fib && fib.direction === 'DOWN') {
      const gZone = fib.retracements.find((r) => r.ratio === 0.618 || r.ratio === 0.5);
      if (gZone && gZone.price > currentPrice) {
        targetPrice = gZone.price;
        targetReason = `Fibonacci Golden Zone ${(gZone.ratio * 100).toFixed(1)}% ($${gZone.price.toFixed(4)})`;
      }
    }

    if (!targetPrice || targetPrice <= currentPrice) return null;

    const reward = targetPrice - currentPrice;
    const rrEstimate = reward / stopDist;
    if (rrEstimate < 1.8) return null;

    return {
      eligible: true,
      side: 'LONG',
      targetPrice,
      targetReason,
      stopLoss,
      rrEstimate: Number(rrEstimate.toFixed(2)),
    };
  }

  return null;
}

/**
 * Compute Volume Profile across a lookback window to find Point of Control (POC) and Value Area (VAH/VAL).
 *
 * @param candles OHLCV series.
 * @param lookback number of candles to evaluate (default 100).
 * @param bins number of price bins (default 40).
 * @returns Volume Profile with Point of Control (POC), VAH, and VAL.
 */
export function computeVolumeProfile(
  candles: Candle[],
  lookback = 100,
  bins = 40
): { poc: number; vah: number; val: number } | null {
  if (candles.length < 10) return null;
  const slice = candles.slice(-lookback);
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let totalVolume = 0;

  for (const c of slice) {
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
    totalVolume += c.volume;
  }

  if (maxPrice <= minPrice || totalVolume <= 0) return null;

  const binStep = (maxPrice - minPrice) / bins;
  const binVolumes = new Float64Array(bins);

  for (const c of slice) {
    if (c.volume <= 0) continue;
    const lowBin = Math.max(0, Math.min(bins - 1, Math.floor((c.low - minPrice) / binStep)));
    const highBin = Math.max(0, Math.min(bins - 1, Math.floor((c.high - minPrice) / binStep)));
    const spannedBins = highBin - lowBin + 1;
    const volPerBin = c.volume / spannedBins;
    for (let b = lowBin; b <= highBin; b++) {
      binVolumes[b] += volPerBin;
    }
  }

  let maxBinIndex = 0;
  let maxBinVol = -1;
  for (let b = 0; b < bins; b++) {
    if (binVolumes[b] > maxBinVol) {
      maxBinVol = binVolumes[b];
      maxBinIndex = b;
    }
  }

  const poc = minPrice + (maxBinIndex + 0.5) * binStep;

  // Compute Value Area (70% of total volume around POC)
  const targetVaVolume = totalVolume * 0.7;
  let accumulatedVolume = binVolumes[maxBinIndex];
  let lowerIdx = maxBinIndex;
  let upperIdx = maxBinIndex;

  while (accumulatedVolume < targetVaVolume && (lowerIdx > 0 || upperIdx < bins - 1)) {
    const nextLowerVol = lowerIdx > 0 ? binVolumes[lowerIdx - 1] : -1;
    const nextUpperVol = upperIdx < bins - 1 ? binVolumes[upperIdx + 1] : -1;

    if (nextLowerVol >= nextUpperVol && lowerIdx > 0) {
      lowerIdx--;
      accumulatedVolume += binVolumes[lowerIdx];
    } else if (upperIdx < bins - 1) {
      upperIdx++;
      accumulatedVolume += binVolumes[upperIdx];
    } else if (lowerIdx > 0) {
      lowerIdx--;
      accumulatedVolume += binVolumes[lowerIdx];
    } else {
      break;
    }
  }

  const val = minPrice + lowerIdx * binStep;
  const vah = minPrice + (upperIdx + 1) * binStep;

  return {
    poc: Number(poc.toFixed(6)),
    vah: Number(vah.toFixed(6)),
    val: Number(val.toFixed(6)),
  };
}

/**
 * Detect Smart Money Technique (SMT) Divergence between an asset and a benchmark (e.g. BTC).
 *
 * Bullish SMT: Benchmark makes a Lower Low while Asset makes a Higher Low (or Asset sweeps low while Benchmark holds).
 * Bearish SMT: Benchmark makes a Higher High while Asset makes a Lower High (or Asset sweeps high while Benchmark holds).
 *
 * @param assetCandles OHLCV series for the asset.
 * @param benchmarkCandles OHLCV series for the benchmark (e.g. BTC_USDT).
 * @param lookback number of candles to consider for swing pivots (default 50).
 * @param benchmarkSymbol symbol of the benchmark asset (default BTC_USDT).
 * @returns SmtDivergence details if divergence is detected, or null.
 */
export function detectSmtDivergence(
  assetCandles: Candle[],
  benchmarkCandles: Candle[],
  lookback = 50,
  benchmarkSymbol = 'BTC_USDT'
): { type: 'BULLISH' | 'BEARISH'; reason: string; benchmarkSymbol: string } | null {
  if (assetCandles.length < 20 || benchmarkCandles.length < 20) return null;

  const assetSlice = assetCandles.slice(-lookback);
  const benchSlice = benchmarkCandles.slice(-lookback);

  const assetPivots = findPivots(assetSlice, 2);
  const benchPivots = findPivots(benchSlice, 2);

  const assetLows = assetPivots.filter((p) => p.type === 'LL' || p.type === 'HL');
  const benchLows = benchPivots.filter((p) => p.type === 'LL' || p.type === 'HL');

  // Check Bullish SMT at swing lows
  if (assetLows.length >= 2 && benchLows.length >= 2) {
    const aPrev = assetLows[assetLows.length - 2];
    const aLast = assetLows[assetLows.length - 1];
    const bPrev = benchLows[benchLows.length - 2];
    const bLast = benchLows[benchLows.length - 1];

    const benchLowerLow = bLast.price < bPrev.price;
    const assetHigherLow = aLast.price >= aPrev.price;

    if (benchLowerLow && assetHigherLow) {
      return {
        type: 'BULLISH',
        reason: `${benchmarkSymbol} maakte Lower Low (${bLast.price.toFixed(2)} < ${bPrev.price.toFixed(2)}) terwijl asset Higher Low vasthield (${aLast.price.toFixed(4)} >= ${aPrev.price.toFixed(4)}) — institutionele accumulatie`,
        benchmarkSymbol,
      };
    }

    const assetLowerLow = aLast.price < aPrev.price;
    const benchHigherLow = bLast.price >= bPrev.price;

    if (assetLowerLow && benchHigherLow) {
      return {
        type: 'BULLISH',
        reason: `Asset sweepte low (${aLast.price.toFixed(4)} < ${aPrev.price.toFixed(4)}) terwijl ${benchmarkSymbol} Higher Low noteerde (${bLast.price.toFixed(2)} >= ${bPrev.price.toFixed(2)}) — Bullish SMT liquiditeitsgraai`,
        benchmarkSymbol,
      };
    }
  }

  const assetHighs = assetPivots.filter((p) => p.type === 'HH' || p.type === 'LH');
  const benchHighs = benchPivots.filter((p) => p.type === 'HH' || p.type === 'LH');

  // Check Bearish SMT at swing highs
  if (assetHighs.length >= 2 && benchHighs.length >= 2) {
    const aPrev = assetHighs[assetHighs.length - 2];
    const aLast = assetHighs[assetHighs.length - 1];
    const bPrev = benchHighs[benchHighs.length - 2];
    const bLast = benchHighs[benchHighs.length - 1];

    const benchHigherHigh = bLast.price > bPrev.price;
    const assetLowerHigh = aLast.price <= aPrev.price;

    if (benchHigherHigh && assetLowerHigh) {
      return {
        type: 'BEARISH',
        reason: `${benchmarkSymbol} maakte Higher High (${bLast.price.toFixed(2)} > ${bPrev.price.toFixed(2)}) terwijl asset achterbleef met Lower High (${aLast.price.toFixed(4)} <= ${aPrev.price.toFixed(4)}) — institutionele distributie`,
        benchmarkSymbol,
      };
    }

    const assetHigherHigh = aLast.price > aPrev.price;
    const benchLowerHigh = bLast.price <= bPrev.price;

    if (assetHigherHigh && benchLowerHigh) {
      return {
        type: 'BEARISH',
        reason: `Asset sweepte high (${aLast.price.toFixed(4)} > ${aPrev.price.toFixed(4)}) terwijl ${benchmarkSymbol} Lower High noteerde (${bLast.price.toFixed(2)} <= ${bPrev.price.toFixed(2)}) — Bearish SMT divergentie`,
        benchmarkSymbol,
      };
    }
  }

  return null;
}

/**
 * Comprehensive Market Structure Analysis.
 *
 * Orchestrates pivots, BOS/CHoCH, FVGs, Order Blocks, Dealing Range, Imbalance Scalps, Volume Profile (POC), and SMT Divergence.
 *
 * @param candles OHLCV series.
 * @param currentPrice current price.
 * @param fib computed Fibonacci levels.
 * @param benchmarkCandles optional benchmark OHLCV series (e.g. BTC_USDT).
 * @param benchmarkSymbol optional benchmark symbol name (default BTC_USDT).
 * @returns full market structure profile.
 */
export function analyzeMarketStructure(
  candles: Candle[],
  currentPrice: number,
  fib: FibLevels | null = null,
  benchmarkCandles?: Candle[],
  benchmarkSymbol = 'BTC_USDT'
): MarketStructureInfo {
  const pivots = findPivots(candles, 2);
  const { trend, lastBreak } = detectMarketStructureBreaks(candles, pivots);
  const activeFVGs = detectFairValueGaps(candles).filter((f) => !f.mitigated);
  const orderBlocks = detectOrderBlocks(candles).filter((ob) => !ob.mitigated);
  const dealingRange = getDealingRange(candles, currentPrice, 60);
  const liquiditySwept = detectLiquiditySweep(candles, pivots, 6);

  // Find nearest unmitigated order block
  const nearestOrderBlock =
    orderBlocks
      .filter((ob) => (trend === 'BULLISH' ? ob.direction === 'BULLISH' && ob.top <= currentPrice : ob.direction === 'BEARISH' && ob.bottom >= currentPrice))
      .sort((a, b) => Math.abs(currentPrice - a.top) - Math.abs(currentPrice - b.top))[0] ?? null;

  // Plan imbalance scalp if a sweep is detected
  const imbalanceScalp = planImbalanceScalp(candles, currentPrice, fib, activeFVGs, liquiditySwept);

  // Compute Volume Profile (POC, VAH, VAL)
  const volumeProfile = computeVolumeProfile(candles, 100, 40);

  // Detect SMT Divergence against benchmark
  const smtDivergence =
    benchmarkCandles && benchmarkCandles.length >= 20
      ? detectSmtDivergence(candles, benchmarkCandles, 50, benchmarkSymbol)
      : null;

  return {
    trend,
    recentPivots: pivots.slice(-6),
    lastBreak,
    activeFVGs: activeFVGs.slice(-5),
    nearestOrderBlock,
    dealingRange,
    liquiditySwept,
    imbalanceScalp,
    volumeProfile,
    smtDivergence,
  };
}
