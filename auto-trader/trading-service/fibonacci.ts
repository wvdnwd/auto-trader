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
  lookback = 100
): FibLevels | null {
  if (!Number.isInteger(lookback) || lookback <= 0 || candles.length < 5) return null;
  const window = candles.slice(-lookback);
  if (window.length < 5) return null;
  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < window.length; i += 1) {
    // On equal extremes, use the latest occurrence to identify the latest leg.
    if (window[i].high >= window[highIdx].high) highIdx = i;
    if (window[i].low <= window[lowIdx].low) lowIdx = i;
  }
  const swingHigh = window[highIdx].high;
  const swingLow = window[lowIdx].low;
  const range = swingHigh - swingLow;
  if (!Number.isFinite(range) || range <= 0 || highIdx === lowIdx) return null;

  // The swing that happened LAST defines the active leg: if the low is the more
  // recent extreme, price impulsed down and any recovery is a retracement UP
  // toward the prior high. If the high is more recent, the reverse.
  const direction: 'UP' | 'DOWN' = highIdx > lowIdx ? 'UP' : 'DOWN';

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
 * Whether a price sits inside the Fibonacci "golden zone" (0.382\u20130.618
 * retracement band) \u2014 the pullback area with the strongest continuation
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
function goldenZoneBand(fib: FibLevels): [number | null, number | null] {
  const low = fib.retracements.find((l) => l.ratio === GOLDEN_ZONE[0]);
  const high = fib.retracements.find((l) => l.ratio === GOLDEN_ZONE[1]);
  if (!low || !high) return [null, null];
  return [Math.min(low.price, high.price), Math.max(low.price, high.price)];
}

/**
 * Whether a recent candle wicked into and then directionally rejected the
 * golden zone without a close invalidating the swing beyond the 0.786 level.
 * Freshness is expressed in supplied bars because Candle has no timeframe.
 *
 * @param fib levels computed by {@link computeFibLevels}.
 * @param candles OHLCV candles, oldest first — only the trailing `lookback` are checked.
 * @param lookback how many of the most recent candles to check, defaults to 5.
 * @returns true when an ordered recent candle touches and rejects the zone and
 *   no candle in that window closes beyond the 0.786 invalidation level.
 */
export function goldenZoneWickTouch(fib: FibLevels, candles: Candle[], lookback = 5): boolean {
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

  return recent.some((c) => {
    const touched = c.high >= lo && c.low <= hi;
    const rejected = fib.direction === 'UP' ? c.close > hi : c.close < lo;
    return touched && rejected;
  });
}
