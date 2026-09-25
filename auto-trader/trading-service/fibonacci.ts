import type { Candle } from './types.js';

/** One Fibonacci level: the ratio and the price it maps to. */
export type FibLevel = {
  ratio: number;
  price: number;
};

/**
 * Fibonacci retracement and extension levels drawn off the dominant recent
 * swing.
 *
 * Retracements sit BETWEEN the swing high and low \u2014 the pullback zone a
 * trend-continuation entry watches. Extensions sit BEYOND the swing extreme
 * in the direction of the move \u2014 natural profit-taking zones once price
 * breaks out past the prior swing.
 */
export type FibLevels = {
  swingHigh: number;
  swingLow: number;
  /** `UP` when the low printed before the high (impulse up, retracements pull back down). */
  direction: 'UP' | 'DOWN';
  /** 0.236 / 0.382 / 0.5 / 0.618 / 0.786, ordered by ratio ascending. */
  retracements: FibLevel[];
  /** 1.272 / 1.618 / 2.0, ordered by ratio ascending. */
  extensions: FibLevel[];
  /** The retracement level closest to the reference price. */
  nearest: FibLevel;
  /** Distance from the reference price to `nearest`, as a ratio of the swing range. */
  distanceToNearest: number;
};

/** Standard retracement ratios watched by most technical traders. */
const RETRACEMENT_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

/** Standard extension ratios used to project profit-taking zones beyond a swing. */
const EXTENSION_RATIOS = [1.272, 1.618, 2.0];

/**
 * The 0.382\u20130.618 band \u2014 the zone most traders treat as the highest-probability
 * continuation entry, often called the "golden zone".
 */
export const GOLDEN_ZONE: [number, number] = [0.382, 0.618];

/**
 * Compute Fibonacci retracement and extension levels from the dominant swing
 * high/low within a lookback window.
 *
 * The dominant swing is simply the highest high and lowest low in the window \u2014
 * the same anchor points a trader would pick by eye on a chart. Direction is
 * inferred from which extreme printed more recently: if the low came after the
 * high, price is retracing DOWN off an up-move (an uptrend pulling back); if the
 * high came after the low, price is retracing UP off a down-move.
 *
 * @param candles OHLCV candles, oldest first.
 * @param price reference price to measure confluence against, defaults to the last close.
 * @param lookback number of trailing candles that define the swing, defaults to 60.
 * @returns the computed levels, or null when there is not enough data or the
 *   lookback is invalid, the swing has zero range, or the latest high and low
 *   are on the same candle so swing direction cannot be inferred.
 */
export function computeFibLevels(
  candles: Candle[],
  price?: number,
  lookback = 100,
  preferredSide?: 'LONG' | 'SHORT'
): FibLevels | null {
  if (!Number.isInteger(lookback) || lookback <= 0 || candles.length < 5) return null;
  const window = candles.slice(-lookback);
  if (window.length < 5) return null;

  let swingHigh: number;
  let swingLow: number;
  let direction: 'UP' | 'DOWN';

  if (preferredSide === 'LONG') {
    // For LONG: true swing low (Bodem) ➔ swing high (Top).
    // Find the recent peak (highest high in recent portion of window):
    const recentSub = window.slice(-Math.min(50, window.length));
    const recentSubOffset = window.length - recentSub.length;
    let peakIdxInSub = 0;
    for (let i = 1; i < recentSub.length; i++) {
      if (recentSub[i].high >= recentSub[peakIdxInSub].high) peakIdxInSub = i;
    }
    const peakIdx = recentSubOffset + peakIdxInSub;

    // The swing low (Bodem) is the lowest point BEFORE that peak where the impulse started:
    let troughIdx = 0;
    for (let i = 1; i <= peakIdx; i++) {
      if (window[i].low <= window[troughIdx].low) troughIdx = i;
    }

    if (troughIdx < peakIdx && window[peakIdx].high > window[troughIdx].low) {
      swingHigh = window[peakIdx].high;
      swingLow = window[troughIdx].low;
      direction = 'UP';
    } else {
      let hIdx = 0;
      let lIdx = 0;
      for (let i = 1; i < window.length; i++) {
        if (window[i].high >= window[hIdx].high) hIdx = i;
        if (window[i].low <= window[lIdx].low) lIdx = i;
      }
      if (hIdx === lIdx) return null;
      swingHigh = window[hIdx].high;
      swingLow = window[lIdx].low;
      direction = hIdx > lIdx ? 'UP' : 'DOWN';
    }
  } else if (preferredSide === 'SHORT') {
    // For SHORT: true swing high (Top) ➔ swing low (Bodem).
    const recentSub = window.slice(-Math.min(50, window.length));
    const recentSubOffset = window.length - recentSub.length;
    let troughIdxInSub = 0;
    for (let i = 1; i < recentSub.length; i++) {
      if (recentSub[i].low <= recentSub[troughIdxInSub].low) troughIdxInSub = i;
    }
    const troughIdx = recentSubOffset + troughIdxInSub;

    let peakIdx = 0;
    for (let i = 1; i <= troughIdx; i++) {
      if (window[i].high >= window[peakIdx].high) peakIdx = i;
    }

    if (peakIdx < troughIdx && window[peakIdx].high > window[troughIdx].low) {
      swingHigh = window[peakIdx].high;
      swingLow = window[troughIdx].low;
      direction = 'DOWN';
    } else {
      let hIdx = 0;
      let lIdx = 0;
      for (let i = 1; i < window.length; i++) {
        if (window[i].high >= window[hIdx].high) hIdx = i;
        if (window[i].low <= window[lIdx].low) lIdx = i;
      }
      if (hIdx === lIdx) return null;
      swingHigh = window[hIdx].high;
      swingLow = window[lIdx].low;
      direction = hIdx > lIdx ? 'UP' : 'DOWN';
    }
  } else {
    // Default mode: find global extremes in window and infer direction from which came last
    let highIdx = 0;
    let lowIdx = 0;
    for (let i = 1; i < window.length; i += 1) {
      if (window[i].high >= window[highIdx].high) highIdx = i;
      if (window[i].low <= window[lowIdx].low) lowIdx = i;
    }
    if (highIdx === lowIdx) return null;
    swingHigh = window[highIdx].high;
    swingLow = window[lowIdx].low;
    direction = highIdx > lowIdx ? 'UP' : 'DOWN';
  }

  const range = swingHigh - swingLow;
  if (!Number.isFinite(range) || range <= 0) return null;

  const retracements = RETRACEMENT_RATIOS.map((ratio) => ({
    ratio,
    // UP leg: price pulls back down from the high. DOWN leg: price pulls back up from the low.
    price: direction === 'UP' ? swingHigh - range * ratio : swingLow + range * ratio,
  }));

  const extensions = EXTENSION_RATIOS.map((ratio) => ({
    ratio,
    // Extensions project further in the direction of the impulse, past the swing extreme.
    price: direction === 'UP' ? swingHigh + range * (ratio - 1) : swingLow - range * (ratio - 1),
  }));

  const reference = price ?? candles[candles.length - 1].close;
  const nearest = retracements.reduce((closest, level) =>
    Math.abs(level.price - reference) < Math.abs(closest.price - reference) ? level : closest
  );
  const distanceToNearest = Math.abs(nearest.price - reference) / range;

  return { swingHigh, swingLow, direction, retracements, extensions, nearest, distanceToNearest };
}

/**
 * Whether a price sits inside the Fibonacci "golden zone" (0.382–0.618
 * retracement band) — the pullback area with the strongest continuation
 * track record.
 *
 * @param fib levels computed by {@link computeFibLevels}.
 * @param price the price to test, defaults to the price fib was computed against.
 * @returns true when price is between the 0.382 and 0.618 retracement levels.
 */
export function inGoldenZone(fib: FibLevels, price: number): boolean {
  const [lo, hi] = goldenZoneBand(fib);
  if (lo === null || hi === null) return false;
  return price >= lo && price <= hi;
}

/**
 * The golden zone price band (0.382–0.618 retracement), ordered low–high
 * regardless of swing direction. Shared by {@link inGoldenZone} and
 * {@link goldenZoneWickTouch} so both use the exact same band.
 *
 * @param fib levels computed by {@link computeFibLevels}.
 * @returns `[low, high]`, or `[null, null]` when the levels are missing.
 */
export function goldenZoneBand(fib: FibLevels): [number | null, number | null] {
  const low = fib.retracements.find((l) => l.ratio === GOLDEN_ZONE[0]);
  const high = fib.retracements.find((l) => l.ratio === GOLDEN_ZONE[1]);
  if (!low || !high) return [null, null];
  return [Math.min(low.price, high.price), Math.max(low.price, high.price)];
}

/**
 * Return the lower and upper price bounds of the Fibonacci Golden Zone (0.382–0.618).
 */
export function goldenZoneLevels(fib: FibLevels): { lower: number; upper: number } {
  const [lo, hi] = goldenZoneBand(fib);
  return { lower: lo ?? 0, upper: hi ?? 0 };
}

export type GoldenZoneBounceResult = {
  inZone: boolean;
  bouncedOut: boolean;
  touched: boolean;
  touchedZone: boolean;
  entryType: 'in_zone' | 'bounce_out' | 'none';
  zoneLow: number;
  zoneHigh: number;
};

/**
 * Detect whether price has recently tagged/entered the Golden Zone and has now
 * cleanly bounced out of it in the trend direction.
 *
 * Prevents false "waiting for pullback" alerts when the pullback already completed
 * and the coin has already begun expanding out of the zone.
 */
export function detectGoldenZoneBounce(
  fib: FibLevels,
  candles: Candle[],
  currentPrice?: number,
  lookback = 12
): GoldenZoneBounceResult {
  const [lo, hi] = goldenZoneBand(fib);
  const invalidation = fib.retracements.find((level) => level.ratio === 0.786);
  const refPrice = currentPrice ?? candles[candles.length - 1]?.close ?? 0;

  if (lo === null || hi === null || !invalidation || candles.length === 0) {
    return {
      inZone: false,
      bouncedOut: false,
      touched: false,
      touchedZone: false,
      entryType: 'none',
      zoneLow: 0,
      zoneHigh: 0,
    };
  }

  const inZone = refPrice >= lo && refPrice <= hi;
  const recent = candles.slice(-Math.min(lookback, candles.length));

  // Did price invalidate beyond the 0.786 level?
  const invalidated = recent.some((c) =>
    fib.direction === 'UP' ? c.close < invalidation.price : c.close > invalidation.price
  );
  if (invalidated) {
    return {
      inZone,
      bouncedOut: false,
      touched: false,
      touchedZone: false,
      entryType: 'none',
      zoneLow: lo,
      zoneHigh: hi,
    };
  }

  // Did any candle in the recent window touch or enter the Golden Zone?
  const touchedIndex = recent.findLastIndex((c) => c.low <= hi && c.high >= lo);
  const touched = touchedIndex !== -1;

  if (!touched) {
    return {
      inZone,
      bouncedOut: false,
      touched: false,
      touchedZone: false,
      entryType: inZone ? 'in_zone' : 'none',
      zoneLow: lo,
      zoneHigh: hi,
    };
  }

  // If price touched the zone in the recent window:
  // For UP (LONG): has price bounced OUT of the zone upwards? (refPrice > hi)
  // For DOWN (SHORT): has price rejected OUT of the zone downwards? (refPrice < lo)
  const isOutInTrendDirection = fib.direction === 'UP' ? refPrice > hi : refPrice < lo;

  // Has any candle following the touch closed outside the zone in the trend direction?
  const afterTouch = recent.slice(touchedIndex);
  const closedOutAfterTouch = afterTouch.some((c) => (fib.direction === 'UP' ? c.close > hi : c.close < lo));

  const bouncedOut = touched && (isOutInTrendDirection || closedOutAfterTouch) && !inZone;
  const entryType: 'in_zone' | 'bounce_out' | 'none' = inZone
    ? 'in_zone'
    : bouncedOut
      ? 'bounce_out'
      : 'none';

  return {
    inZone,
    bouncedOut,
    touched,
    touchedZone: touched,
    entryType,
    zoneLow: lo,
    zoneHigh: hi,
  };
}

/**
 * Whether a recent candle wicked into and then directionally rejected the
 * golden zone without a close invalidating the swing beyond the 0.786 level.
 * Supports both single-candle rejection wicks and multi-candle touch & bounce reclaims.
 *
 * @param fib levels computed by {@link computeFibLevels}.
 * @param candles OHLCV candles, oldest first — only the trailing `lookback` are checked.
 * @param lookback how many of the most recent candles to check, defaults to 5.
 * @returns true when an ordered recent candle touches and rejects the zone and
 *   no candle in that window closes beyond the 0.786 invalidation level.
 */
export function goldenZoneWickTouch(fib: FibLevels, candles: Candle[], lookback = 8): boolean {
  const [lo, hi] = goldenZoneBand(fib);
  const invalidation = fib.retracements.find((level) => level.ratio === 0.786);
  if (
    lo === null ||
    hi === null ||
    !invalidation ||
    !Number.isInteger(lookback) ||
    lookback < 1 ||
    candles.length === 0 ||
    candles.some(
      (c, index) =>
        !Number.isFinite(c.time) ||
        !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close) ||
        c.low > c.high ||
        (index > 0 && candles[index - 1].time >= c.time)
    )
  ) {
    return false;
  }
  const recent = candles.slice(-lookback);
  const invalidated = recent.some((c) =>
    fib.direction === 'UP' ? c.close <= invalidation.price : c.close >= invalidation.price
  );
  if (invalidated) return false;

  // Single-candle wick touch & reject
  const singleBarTouch = recent.some((c) => {
    const touched = c.high >= lo && c.low <= hi;
    const rejected = fib.direction === 'UP' ? c.close > hi : c.close < lo;
    return touched && rejected;
  });
  if (singleBarTouch) return true;

  // Multi-candle bounce: touched in recent bars, latest candle closed outside in trend direction
  const touchedIdx = recent.findLastIndex((c) => c.low <= hi && c.high >= lo);
  if (touchedIdx !== -1) {
    const last = recent[recent.length - 1];
    const bounced = fib.direction === 'UP' ? last.close > hi : last.close < lo;
    if (bounced) return true;
  }

  return false;
}
