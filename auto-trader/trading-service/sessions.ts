import type { Candle, MarketSession } from './types.js';

/**
 * Detailed metadata about the active market session.
 */
export type SessionInfo = {
  /** Canonical market session identifier. */
  session: MarketSession;
  /** Human-readable session name. */
  name: string;
  /** Current UTC hour (0..23). */
  hourUtc: number;
  /** Current UTC minute (0..59). */
  minuteUtc: number;
  /** True during US cash market opening surge (13:30 - 16:00 UTC). */
  isNyOpen: boolean;
  /** True during London and New York session overlap (13:00 - 16:00 UTC), the highest volume period of the day. */
  isLondonNyOverlap: boolean;
  /** True during initial Asian session liquidity build-up (00:00 - 03:00 UTC). */
  isAsiaOpen: boolean;
  /** Dutch description of current session characteristics. */
  description: string;
};

/**
 * Benchmark range formed during the Asian trading session (00:00 - 08:00 UTC).
 */
export type AsianRange = {
  /** Highest price recorded between 00:00 and 08:00 UTC. */
  high: number;
  /** Lowest price recorded between 00:00 and 08:00 UTC. */
  low: number;
  /** Equilibrium / midpoint of the Asian range. */
  mid: number;
  /** Size of the range as a fraction of the midpoint. */
  rangePct: number;
  /** Whether price has swept an Asian session extreme outside the Asian session. */
  swept: 'HIGH' | 'LOW' | null;
};

/**
 * Determine the active market session and time characteristics based on UTC time.
 *
 * Market hours standard (UTC):
 * - ASIA:      00:00 - 08:00 UTC (Tokyo, Singapore, Hong Kong)
 * - LONDON:    08:00 - 13:00 UTC (Frankfurt, London core)
 * - NEW_YORK:  13:00 - 21:00 UTC (Wall Street, US spot & futures)
 * - OFF_HOURS: 21:00 - 24:00 UTC (Pacific lull / daily transition)
 *
 * @param date timestamp to evaluate (defaults to current time).
 * @returns active session details.
 */
export function getMarketSession(date: Date = new Date()): SessionInfo {
  const hourUtc = date.getUTCHours();
  const minuteUtc = date.getUTCMinutes();
  const timeFraction = hourUtc + minuteUtc / 60;

  const isNyOpen = timeFraction >= 13.5 && timeFraction <= 16.0;
  const isLondonNyOverlap = timeFraction >= 13.0 && timeFraction <= 16.0;
  const isAsiaOpen = timeFraction >= 0.0 && timeFraction <= 3.0;

  let session: MarketSession;
  let name: string;
  let description: string;

  if (hourUtc >= 0 && hourUtc < 8) {
    session = 'ASIA';
    name = 'Asian Session';
    description = isAsiaOpen
      ? 'Aziatische sessie (opening) — liquiditeitsopbouw en consolidatie'
      : 'Aziatische sessie — range-bound en Mean-Reversion dominant';
  } else if (hourUtc >= 8 && hourUtc < 13) {
    session = 'LONDON';
    name = 'London Session';
    description = 'Londen sessie — uitbraakdynamiek en Europese volumestroom';
  } else if (hourUtc >= 13 && hourUtc < 21) {
    session = 'NEW_YORK';
    name = 'New York Session';
    description = isLondonNyOverlap
      ? 'Londen/NY Overlap ("Golden Hours") — maximale wereldwijde liquiditeit & trendexpansie'
      : 'New York sessie — macro-economische trends en sterke momentum continuatie';
  } else {
    session = 'OFF_HOURS';
    name = 'Off-Hours';
    description = 'Off-hours / Pacific — lagere liquiditeit, terughoudend met entries';
  }

  return {
    session,
    name,
    hourUtc,
    minuteUtc,
    isNyOpen,
    isLondonNyOverlap,
    isAsiaOpen,
    description,
  };
}

/**
 * Compute the Asian Range (00:00 - 08:00 UTC) from recent candles and detect liquidity sweeps.
 *
 * The Asian range represents the overnight balance area. When London or New York sessions open,
 * institutional algorithms frequently pierce the Asian High or Low to trigger retail stop-losses
 * (liquidity sweep / "Judas Swing") before aggressively reversing in the true direction of the day.
 *
 * @param candles recent candle history (must contain today's 00:00 - 08:00 UTC candles).
 * @param now current timestamp (defaults to Date.now()).
 * @param candleDurationSec candle interval in seconds. When omitted, the last
 *   observed candle is excluded because Candle has no explicit close status.
 * @returns Asian range levels and sweep detection, or null if insufficient Asian session data.
 */
export function computeAsianRange(
  candles: Candle[],
  now: Date = new Date(),
  candleDurationSec?: number
): AsianRange | null {
  if (
    !candles ||
    candles.length < 4 ||
    !Number.isFinite(now.getTime()) ||
    (candleDurationSec !== undefined &&
      (!Number.isFinite(candleDurationSec) || candleDurationSec <= 0))
  ) {
    return null;
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  const timestamped = candles
    .filter((c) => Number.isFinite(c.time) && c.time <= nowSec)
    .slice()
    .sort((a, b) => a.time - b.time);
  if (
    timestamped.length < 4 ||
    timestamped.some((c, index) => index > 0 && timestamped[index - 1].time === c.time)
  ) {
    return null;
  }
  const observed =
    candleDurationSec === undefined
      ? timestamped.slice(0, -1)
      : timestamped.filter((c) => c.time + candleDurationSec <= nowSec);
  if (observed.length < 4) return null;
  if (candleDurationSec !== undefined) {
    const newestClosed = observed[observed.length - 1];
    if (nowSec - (newestClosed.time + candleDurationSec) > candleDurationSec) return null;
  }

  // Find start of today's UTC day in seconds
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayStartSec = Math.floor(todayUtc.getTime() / 1000);
  const asiaEndSec = todayStartSec + 8 * 3600; // 08:00:00 UTC

  // Extract candles falling within 00:00 - 08:00 UTC
  const asiaCandles = observed.filter((c) => c.time >= todayStartSec && c.time < asiaEndSec);

  // If we are still in Asia and have at least 4 candles, or if Asia has concluded:
  if (asiaCandles.length < 4) {
    // If today's Asia hasn't formed enough bars yet, check yesterday's Asia as the previous benchmark
    const yesterdayStartSec = todayStartSec - 86400;
    const yesterdayAsiaEndSec = yesterdayStartSec + 8 * 3600;
    const prevAsia = observed.filter((c) => c.time >= yesterdayStartSec && c.time < yesterdayAsiaEndSec);
    if (prevAsia.length < 4) return null;
    return evaluateRangeAndSweeps(prevAsia, observed, yesterdayAsiaEndSec);
  }

  return evaluateRangeAndSweeps(asiaCandles, observed, asiaEndSec);
}

function evaluateRangeAndSweeps(
  asiaCandles: Candle[],
  allCandles: Candle[],
  asiaEndSec: number
): AsianRange {
  const high = Math.max(...asiaCandles.map((c) => c.high));
  const low = Math.min(...asiaCandles.map((c) => c.low));
  const mid = (high + low) / 2;
  const rangePct = mid > 0 ? (high - low) / mid : 0;

  // Post-Asia candles to inspect for sweeps
  const postAsia = allCandles.filter((c) => c.time >= asiaEndSec);
  let swept: 'HIGH' | 'LOW' | null = null;

  // Inspect recent post-Asia candles (last 8 bars) for sweep-and-reclaim
  const recentPostAsia = postAsia.slice(-8);
  for (const c of recentPostAsia) {
    const sweptHigh = c.high > high && c.close < high;
    const sweptLow = c.low < low && c.close > low;
    // A single candle can sweep both edges and close inside the range. Its
    // direction is ambiguous, so do not let the check order pick a side.
    if (sweptHigh && sweptLow) {
      swept = null;
    } else if (sweptHigh) {
      swept = 'HIGH';
    } else if (sweptLow) {
      swept = 'LOW';
    }
  }

  return { high, low, mid, rangePct, swept };
}

/**
 * Adaptive strategy multipliers based on active market session characteristics.
 *
 * @param session current market session.
 * @param isOverlap true during London/New York overlap.
 * @returns strategy weight multipliers and confidence bonuses.
 */
export function sessionWeightModifiers(
  session: MarketSession,
  isOverlap = false
): {
  trendWeightMultiplier: number;
  revertWeightMultiplier: number;
  confidenceMultiplier: number;
  reason: string;
} {
  switch (session) {
    case 'ASIA':
      // Asian session is statistically range-bound: boost mean reversion, tone down trend chasing
      return {
        trendWeightMultiplier: 0.75,
        revertWeightMultiplier: 1.35,
        confidenceMultiplier: 0.98,
        reason: 'Aziatische sessie: voorkeur voor mean-reversion en consolidatie-fades',
      };

    case 'LONDON':
      // London session: balanced trend expansion
      return {
        trendWeightMultiplier: 1.0,
        revertWeightMultiplier: 1.0,
        confidenceMultiplier: 1.0,
        reason: 'Londen sessie: gebalanceerde uitbraak- en trenddynamiek',
      };

    case 'NEW_YORK':
      // New York session: highest volume, macro institutional trend continuation
      return {
        trendWeightMultiplier: 1.25,
        revertWeightMultiplier: 0.7,
        confidenceMultiplier: isOverlap ? 1.05 : 1.0,
        reason: isOverlap
          ? 'Londen/NY Overlap ("Golden Hours"): maximale liquiditeit & sterke trendexpansie'
          : 'New York sessie: sterke trendopvolging en momentumuitbraken',
      };

    case 'OFF_HOURS':
    default:
      // Off-hours: thinner liquidity, slight discount
      return {
        trendWeightMultiplier: 0.85,
        revertWeightMultiplier: 1.0,
        confidenceMultiplier: 0.95,
        reason: 'Off-hours: lagere marktliquiditeit, conservatieve overtuiging',
      };
  }
}
