/**
 * Regime-Filtered Daily Trend Breakout — self-contained strategy module.
 *
 * Pure functions only: no I/O, no engine coupling, no singleton state. Every
 * helper is deterministic and safe to call from a backtester, a worker, or the
 * live engine loop.
 *
 * The tactic implemented here is the best-evidenced result of the 4.1-year
 * research programme in `scripts/strategy-research-lab.mjs`,
 * `scripts/strategy-optimizer.mjs` and `scripts/strategy-validation.mjs`:
 *
 *   1D regime-filtered breakout, long/short
 *   - regime   : BTC 1D EMA50 vs EMA200
 *   - entry    : close > Donchian(55).upper OR close > Keltner(EMA20, 2*ATR14)
 *                with ATR%(14) > 50-bar rolling median (volatility expansion)
 *   - stop     : 3 * ATR(14)
 *   - take     : bank 1/3 at +1R, move stop to breakeven, trail the rest
 *   - trail    : Donchian(10) opposite side
 *
 * Measured research profile (out-of-sample 2025-01-01 .. 2026-09-28, costs on,
 * fixed 1% risk, 5x cap / 25% notional cap, at most 5 concurrent positions):
 *   profit factor 2.22, win rate 43.8%, max drawdown 15.5%, 73 trades,
 *   ROI 28.1% (`data/strategy_validation_results.json`, variant A1R).
 *
 * WARNING: the configuration is NOT stable across time. In the rolling 6-month
 * walk-forward (14 windows, parameters fixed) 5 windows were negative
 * (PF < 1.0) — roughly a third. These figures are research estimates from one
 * historical sample and a multiple-comparison sweep; they are not a guarantee
 * of future performance and must not be used to size real capital without an
 * explicit risk decision. Nothing in this file enables live trading.
 */

/** A single OHLCV candle, oldest first within a series. */
export type TrendCandle = {
  /** Open time in unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Regime definition used to gate trade direction.
 *
 * - `priceVsEma200`: latest close above/below EMA(200) of the higher-timeframe
 *   series is bullish/bearish.
 * - `ema50Vs200`: EMA(50) above/below EMA(200) of the higher-timeframe series.
 * - `btcMarket`: EMA(50) vs EMA(200) of the supplied BTC higher-timeframe
 *   closes (market-wide regime, the validated default).
 */
export type RegimeMode = 'priceVsEma200' | 'ema50Vs200' | 'btcMarket';

/** Direction returned by the regime gate. `NONE` means indeterminate or flat. */
export type TrendDirection = 'LONG' | 'SHORT' | 'NONE';

/** A tradable side. */
export type TrendSide = 'LONG' | 'SHORT';

/** Breakout family evaluated by {@link evaluateTrendEntry}. */
export type BreakoutType = 'donchian' | 'keltner';

/** Trailing-stop family. */
export type TrailType = 'donchian' | 'chandelier';

/**
 * Strategy parameters. Every field has a default in
 * {@link DEFAULT_TREND_PARAMS} matching the validated configuration.
 */
export type TrendParams = {
  /** Higher timeframe the caller resampled to, e.g. `'1D'`. Metadata only. */
  signalTimeframe: string;
  /** Regime gate definition. */
  regimeMode: RegimeMode;
  /** Donchian breakout lookback (validated: 55). */
  breakoutLookback: number;
  /**
   * Breakout family. `'donchian'` evaluates the validated trigger, which is the
   * Donchian(N) channel OR the Keltner(EMA20, 2*ATR) channel. `'keltner'`
   * restricts the trigger to the Keltner channel only.
   */
  breakoutType: BreakoutType;
  /** Require ATR%(atrPeriod) to exceed its rolling median. */
  volatilityExpansion: boolean;
  /** Lookback for the ATR% median, in bars (validated: 50). */
  volatilityLookback: number;
  /** ATR period used for every stop/trail/volatility calculation. */
  atrPeriod: number;
  /** Initial stop distance as a multiple of ATR (validated: 3). */
  stopAtrMultiple: number;
  /** Trailing-stop family. */
  trailType: TrailType;
  /** Donchian trail lookback (validated: 10). */
  trailLookback: number;
  /** Chandelier trail multiple of ATR(22) when `trailType` is `'chandelier'`. */
  chandelierAtrMultiple: number;
  /** Partial take-profit level in R multiples (validated: 1). */
  partialTakeProfitR: number;
  /** Fraction of the position banked at the partial level (validated: 1/3). */
  partialPortion: number;
  /** When true, short entries are refused. */
  longOnly: boolean;
};

/**
 * Default parameters matching the validated research configuration
 * `TC-1D-c-N55-LS-P3` with the +1R partial take-profit variant.
 */
export const DEFAULT_TREND_PARAMS: TrendParams = {
  signalTimeframe: '1D',
  regimeMode: 'btcMarket',
  breakoutLookback: 55,
  breakoutType: 'donchian',
  volatilityExpansion: true,
  volatilityLookback: 50,
  atrPeriod: 14,
  stopAtrMultiple: 3,
  trailType: 'donchian',
  trailLookback: 10,
  chandelierAtrMultiple: 3,
  partialTakeProfitR: 1,
  partialPortion: 1 / 3,
  longOnly: false,
};

/** Descriptive trail specification carried on an entry signal. */
export type TrendTrailSpec = {
  type: TrailType;
  /** Donchian lookback (present for the Donchian trail). */
  lookback: number;
  /** ATR multiple (present for the chandelier trail). */
  atrMultiple?: number;
};

/** Initial stop and trailing-stop plan for a signal. */
export type TrendStopPlan = {
  /** Initial protective stop price. */
  initialStop: number;
  /** Absolute distance between entry and the initial stop. */
  stopDistance: number;
  /** ATR value on the signal bar. */
  atr: number;
  /** Trailing-stop specification the caller should apply. */
  trail: TrendTrailSpec;
};

/** Partial take-profit plan. */
export type TrendPartialPlan = {
  /** R multiple at which a portion is banked. */
  rMultiple: number;
  /** Fraction of the position banked at that level, clamped to [0, 1]. */
  portion: number;
};

/** A fully-formed entry signal. */
export type TrendEntrySignal = {
  side: TrendSide;
  regime: TrendDirection;
  /** Index of the signal bar inside the supplied candles array. */
  signalIndex: number;
  /** Signal-bar close. The caller is responsible for the next-bar open fill. */
  entryPrice: number;
  /** ATR divided by close on the signal bar. */
  atrPct: number;
  breakoutType: BreakoutType;
  stop: TrendStopPlan;
  takeProfitPlan: TrendPartialPlan;
};

/** Input for {@link positionSizeUsd}. */
export type PositionSizeInput = {
  equity: number;
  entry: number;
  stop: number;
  riskPct: number;
  maxLeverage: number;
  maxNotionalPct: number;
};

/** Output of {@link positionSizeUsd}. */
export type PositionSizeResult = {
  /** Final notional in USD, after every cap. */
  notionalUsd: number;
  /** Actual dollar risk implied by `quantity` and `|entry - stop|`. */
  riskUsd: number;
  /** Position quantity in base units. */
  quantity: number;
  /** notionalUsd / equity. */
  leverageUsed: number;
};

/** Input for {@link trailStop}. */
export type TrailStopInput = {
  side: TrendSide;
  /** Highest high reached since entry (long side). */
  highestHigh: number;
  /** Lowest low reached since entry (short side). */
  lowestLow: number;
  /** Stop currently in force; the result will never loosen it. */
  currentStop: number;
  /** Candle series whose final bar drives the candidate level. */
  candles: TrendCandle[];
  params?: Partial<TrendParams>;
};

/** ATR period used by the chandelier trail (fixed by the research design). */
const CHANDELIER_ATR_PERIOD = 22;

/**
 * Relative tolerance below which two regime series are treated as equal, so a
 * flat market maps to `NONE` instead of flipping on floating-point noise.
 */
const REGIME_EPSILON = 1e-9;

/** Keltner EMA period and ATR multiple fixed by the validated configuration. */
const KELTNER_EMA_PERIOD = 20;
const KELTNER_ATR_MULTIPLE = 2;

/**
 * True when `value` is a finite number (rejects `undefined`, `NaN`, `Infinity`).
 */
function isFiniteNum(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Anchored exponential moving average, seeded with the SMA of the first
 * `period` values.
 *
 * @param values series of finite numbers, oldest first.
 * @param period lookback window.
 * @returns array aligned to `values`; leading entries are `undefined` until the
 *   seed, and non-finite inputs are skipped.
 */
export function ema(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = values.map(() => undefined);
  if (!Number.isInteger(period) || period < 1 || values.length < period) {
    return out;
  }
  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    const value = values[i];
    if (!isFiniteNum(value)) return out;
    seed += value;
  }
  let prev = seed / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    const value = values[i];
    if (!isFiniteNum(value)) continue;
    prev = value * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Simple moving average series.
 *
 * @param values series of finite numbers, oldest first.
 * @param period lookback window.
 * @returns array aligned to `values`; entries are `undefined` until `period`
 *   consecutive finite values are available.
 */
export function sma(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = values.map(() => undefined);
  if (!Number.isInteger(period) || period < 1 || values.length < period) {
    return out;
  }
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    let complete = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      const value = values[j];
      if (!isFiniteNum(value)) {
        complete = false;
        break;
      }
      sum += value;
    }
    if (complete) out[i] = sum / period;
  }
  return out;
}

/**
 * Average True Range with Wilder smoothing, seeded by the mean of the first
 * `period` true ranges (the first bar's range is not part of the seed).
 *
 * @param candles OHLCV candles, oldest first.
 * @param period lookback window.
 * @returns array aligned to `candles`; `undefined` during the `period`-bar
 *   warm-up.
 */
export function atr(
  candles: TrendCandle[],
  period: number
): (number | undefined)[] {
  const out: (number | undefined)[] = candles.map(() => undefined);
  const n = candles.length;
  if (!Number.isInteger(period) || period < 1 || n < period + 1) return out;
  const trueRange = new Array<number>(n);
  trueRange[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    trueRange[i] = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += trueRange[i];
  let prevAtr = sum / period;
  out[period] = prevAtr;
  for (let i = period + 1; i < n; i += 1) {
    prevAtr = (prevAtr * (period - 1) + trueRange[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

/**
 * Donchian channel, shifted by one bar so the level at index `i` uses bars
 * `[i - period, i - 1]` and never includes the current bar. This matches the
 * no-lookahead semantics of the research backtester.
 *
 * @param candles OHLCV candles, oldest first.
 * @param period lookback window.
 * @returns `{ upper, lower }` arrays aligned to `candles`, `undefined` before
 *   `period` prior bars exist.
 */
export function donchian(
  candles: TrendCandle[],
  period: number
): { upper: (number | undefined)[]; lower: (number | undefined)[] } {
  const upper: (number | undefined)[] = candles.map(() => undefined);
  const lower: (number | undefined)[] = candles.map(() => undefined);
  if (!Number.isInteger(period) || period < 1) return { upper, lower };
  for (let i = period; i < candles.length; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period; j < i; j += 1) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    if (Number.isFinite(highest)) upper[i] = highest;
    if (Number.isFinite(lowest)) lower[i] = lowest;
  }
  return { upper, lower };
}

/**
 * Keltner channel: EMA(close, emaPeriod) +/- mult * ATR(atrPeriod).
 *
 * @param candles OHLCV candles, oldest first.
 * @param emaPeriod EMA lookback for the channel mid-line.
 * @param atrPeriod ATR lookback for the channel half-width.
 * @param mult ATR multiple for the half-width.
 * @returns `{ upper, lower }` arrays aligned to `candles`, `undefined` until
 *   both the EMA and the ATR are defined.
 */
export function keltner(
  candles: TrendCandle[],
  emaPeriod: number,
  atrPeriod: number,
  mult: number
): { upper: (number | undefined)[]; lower: (number | undefined)[] } {
  const upper: (number | undefined)[] = candles.map(() => undefined);
  const lower: (number | undefined)[] = candles.map(() => undefined);
  if (!isFiniteNum(mult)) return { upper, lower };
  const closes = candles.map((candle) => candle.close);
  const mid = ema(closes, emaPeriod);
  const range = atr(candles, atrPeriod);
  for (let i = 0; i < candles.length; i += 1) {
    const m = mid[i];
    const a = range[i];
    if (!isFiniteNum(m) || !isFiniteNum(a)) continue;
    upper[i] = m + mult * a;
    lower[i] = m - mult * a;
  }
  return { upper, lower };
}

/**
 * Rolling median over the `period` bars strictly before each index, matching the
 * research volatility-expansion window `[i - period, i - 1]`.
 *
 * @param values series of numbers or `undefined` gaps, oldest first.
 * @param period lookback window.
 * @returns array aligned to `values`; `undefined` when fewer than
 *   `max(3, floor(period / 2))` finite samples are present.
 */
function rollingMedian(
  values: (number | undefined)[],
  period: number
): (number | undefined)[] {
  const out: (number | undefined)[] = values.map(() => undefined);
  if (!Number.isInteger(period) || period < 1) return out;
  const minCount = Math.max(3, Math.floor(period / 2));
  for (let i = period; i < values.length; i += 1) {
    const window: number[] = [];
    for (let j = i - period; j < i; j += 1) {
      const value = values[j];
      if (isFiniteNum(value)) window.push(value);
    }
    if (window.length < minCount) continue;
    window.sort((a, b) => a - b);
    const mid = window.length >> 1;
    out[i] =
      window.length % 2
        ? window[mid]
        : (window[mid - 1] + window[mid]) / 2;
  }
  return out;
}

/**
 * Compare the latest element of two aligned series, treating values within a
 * small relative tolerance as equal.
 *
 * @returns `'LONG'` when `a` is above `b`, `'SHORT'` when below, `'NONE'` when
 *   either side is missing or they are effectively equal.
 */
function compareLatest(
  a: (number | undefined)[],
  b: (number | undefined)[]
): TrendDirection {
  const av = a[a.length - 1];
  const bv = b[b.length - 1];
  if (!isFiniteNum(av) || !isFiniteNum(bv)) return 'NONE';
  const scale = Math.max(1, Math.abs(av), Math.abs(bv));
  if (Math.abs(av - bv) <= REGIME_EPSILON * scale) return 'NONE';
  return av > bv ? 'LONG' : 'SHORT';
}

/**
 * Evaluate the market regime gate.
 *
 * @param htfCloses higher-timeframe closes of the traded symbol, oldest first.
 * @param mode regime definition to apply.
 * @param btcCloses higher-timeframe BTC closes; required for `'btcMarket'`.
 * @returns `'LONG'` for an uptrend, `'SHORT'` for a downtrend, `'NONE'` when
 *   data is insufficient or the regime is flat.
 */
export function detectRegime(
  htfCloses: number[],
  mode: RegimeMode,
  btcCloses?: number[]
): TrendDirection {
  if (mode === 'btcMarket') {
    if (!btcCloses || btcCloses.length === 0) return 'NONE';
    return compareLatest(ema(btcCloses, 50), ema(btcCloses, 200));
  }
  if (mode === 'ema50Vs200') {
    return compareLatest(ema(htfCloses, 50), ema(htfCloses, 200));
  }
  return compareLatest(htfCloses, ema(htfCloses, 200));
}

/**
 * Initial protective stop price.
 *
 * @param side trade direction.
 * @param entry reference entry price.
 * @param atrValue ATR on the signal bar.
 * @param params strategy parameters; defaults to {@link DEFAULT_TREND_PARAMS}.
 * @returns `entry - stopAtrMultiple * ATR` for longs and `entry + ...` for
 *   shorts; returns `entry` unchanged when the inputs are not finite.
 */
export function initialStopPrice(
  side: TrendSide,
  entry: number,
  atrValue: number,
  params: TrendParams = DEFAULT_TREND_PARAMS
): number {
  if (!isFiniteNum(entry) || !isFiniteNum(atrValue) || atrValue <= 0) {
    return entry;
  }
  const distance = params.stopAtrMultiple * atrValue;
  return side === 'LONG' ? entry - distance : entry + distance;
}

/**
 * Partial take-profit plan derived from the parameters.
 *
 * @param params strategy parameters; defaults to {@link DEFAULT_TREND_PARAMS}.
 * @returns the R multiple and the portion to bank, with the portion clamped to
 *   `[0, 1]` and the R multiple floored at 0.
 */
export function partialPlan(
  params: TrendParams = DEFAULT_TREND_PARAMS
): TrendPartialPlan {
  const portion = Math.min(1, Math.max(0, params.partialPortion));
  const rMultiple =
    isFiniteNum(params.partialTakeProfitR) && params.partialTakeProfitR > 0
      ? params.partialTakeProfitR
      : 0;
  return { rMultiple, portion };
}

/**
 * Evaluate a regime-filtered breakout entry on the final candle of `candles`.
 *
 * The signal is evaluated at the close of the last candle. The caller is
 * responsible for filling at the next bar's open (and for only passing closed
 * candles).
 *
 * @param input candles, higher-timeframe closes, optional BTC closes and
 *   parameter overrides.
 * @returns the entry signal, or `null` when the regime, breakout or volatility
 *   filter rejects it.
 */
export function evaluateTrendEntry(input: {
  candles: TrendCandle[];
  htfCloses: number[];
  btcHtfCloses?: number[];
  params?: Partial<TrendParams>;
}): TrendEntrySignal | null {
  const params: TrendParams = { ...DEFAULT_TREND_PARAMS, ...input.params };
  const { candles } = input;
  const index = candles.length - 1;
  if (index < 1) return null;

  const close = candles[index].close;
  if (!isFiniteNum(close) || close <= 0) return null;

  const atrSeries = atr(candles, params.atrPeriod);
  const atrValue = atrSeries[index];
  if (!isFiniteNum(atrValue) || atrValue <= 0) return null;

  const regime = detectRegime(
    input.htfCloses,
    params.regimeMode,
    input.btcHtfCloses
  );
  if (regime === 'NONE') return null;
  if (params.longOnly && regime !== 'LONG') return null;

  const channel = donchian(candles, params.breakoutLookback);
  const bands = keltner(
    candles,
    KELTNER_EMA_PERIOD,
    params.atrPeriod,
    KELTNER_ATR_MULTIPLE
  );
  const useDonchian = params.breakoutType === 'donchian';
  const breakUp =
    (useDonchian &&
      isFiniteNum(channel.upper[index]) &&
      close > channel.upper[index]) ||
    (isFiniteNum(bands.upper[index]) && close > bands.upper[index]);
  const breakDown =
    (useDonchian &&
      isFiniteNum(channel.lower[index]) &&
      close < channel.lower[index]) ||
    (isFiniteNum(bands.lower[index]) && close < bands.lower[index]);

  const longTrigger = regime === 'LONG' && breakUp;
  const shortTrigger = regime === 'SHORT' && breakDown;
  if (!longTrigger && !shortTrigger) return null;
  const side: TrendSide = longTrigger ? 'LONG' : 'SHORT';

  if (params.volatilityExpansion) {
    const atrPct = atrSeries.map((value, i) => {
      const closeAt = candles[i].close;
      return isFiniteNum(value) && isFiniteNum(closeAt) && closeAt > 0
        ? value / closeAt
        : undefined;
    });
    const median = rollingMedian(atrPct, params.volatilityLookback)[index];
    const current = atrPct[index];
    if (!isFiniteNum(median) || !isFiniteNum(current) || current <= median) {
      return null;
    }
  }

  const stopPrice = initialStopPrice(side, close, atrValue, params);
  const trail: TrendTrailSpec =
    params.trailType === 'chandelier'
      ? {
          type: 'chandelier',
          lookback: params.trailLookback,
          atrMultiple: params.chandelierAtrMultiple,
        }
      : { type: 'donchian', lookback: params.trailLookback };

  return {
    side,
    regime,
    signalIndex: index,
    entryPrice: close,
    atrPct: atrValue / close,
    breakoutType: params.breakoutType,
    stop: {
      initialStop: stopPrice,
      stopDistance: Math.abs(close - stopPrice),
      atr: atrValue,
      trail,
    },
    takeProfitPlan: partialPlan(params),
  };
}

/**
 * Candidate trailing stop with an explicit monotonic clamp: the returned stop
 * never loosens the current one.
 *
 * @param input side, favourable extremes, current stop, candles and overrides.
 * @returns the tightened stop, or `currentStop` when no candidate is available
 *   (including when the indicator is still warming up).
 */
export function trailStop(input: TrailStopInput): number {
  const params: TrendParams = { ...DEFAULT_TREND_PARAMS, ...input.params };
  const index = input.candles.length - 1;
  let candidate: number | undefined;

  if (params.trailType === 'chandelier') {
    const range = atr(input.candles, CHANDELIER_ATR_PERIOD)[index];
    if (isFiniteNum(range) && range > 0) {
      candidate =
        input.side === 'LONG'
          ? input.highestHigh - params.chandelierAtrMultiple * range
          : input.lowestLow + params.chandelierAtrMultiple * range;
    }
  } else {
    const channel = donchian(input.candles, params.trailLookback);
    const level =
      input.side === 'LONG' ? channel.lower[index] : channel.upper[index];
    if (isFiniteNum(level)) candidate = level;
  }

  if (!isFiniteNum(candidate)) return input.currentStop;
  if (!isFiniteNum(input.currentStop)) return candidate;
  return input.side === 'LONG'
    ? Math.max(input.currentStop, candidate)
    : Math.min(input.currentStop, candidate);
}

/**
 * Risk-based position sizing with hard notional caps.
 *
 * Risk is `riskPct * equity`; size is `risk / |entry - stop|`; the resulting
 * notional is capped by `min(maxLeverage * equity, maxNotionalPct * equity)`.
 *
 * @param input equity, entry, stop and the risk/leverage limits.
 * @returns finite, non-negative sizing when the inputs are usable, otherwise
 *   all-zero. `riskUsd` is the actual risk after the notional cap binds.
 */
export function positionSizeUsd(input: PositionSizeInput): PositionSizeResult {
  const zero: PositionSizeResult = {
    notionalUsd: 0,
    riskUsd: 0,
    quantity: 0,
    leverageUsed: 0,
  };
  const { equity, entry, stop, riskPct, maxLeverage, maxNotionalPct } = input;
  if (
    !isFiniteNum(equity) ||
    !isFiniteNum(entry) ||
    !isFiniteNum(stop) ||
    !isFiniteNum(riskPct) ||
    !isFiniteNum(maxLeverage) ||
    !isFiniteNum(maxNotionalPct)
  ) {
    return zero;
  }
  if (
    equity <= 0 ||
    entry <= 0 ||
    stop <= 0 ||
    riskPct < 0 ||
    maxLeverage <= 0 ||
    maxNotionalPct < 0
  ) {
    return zero;
  }
  const perUnitRisk = Math.abs(entry - stop);
  if (!(perUnitRisk > 0)) return zero;

  const requestedRisk = riskPct * equity;
  const notionalCap = Math.min(
    maxLeverage * equity,
    maxNotionalPct * equity
  );
  if (!isFiniteNum(notionalCap) || notionalCap <= 0) return zero;

  let quantity = requestedRisk / perUnitRisk;
  const notional = quantity * entry;
  if (notional > notionalCap) quantity = notionalCap / entry;
  if (!(quantity > 0)) return zero;

  const notionalUsd = quantity * entry;
  return {
    notionalUsd,
    riskUsd: quantity * perUnitRisk,
    quantity,
    leverageUsed: notionalUsd / equity,
  };
}
