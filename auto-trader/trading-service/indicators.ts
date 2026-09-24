import type { Candle } from './types.js';

/**
 * Simple moving average of the last `period` values.
 *
 * @param values series of numbers, oldest first.
 * @param period lookback window.
 * @returns the average, or NaN when there is not enough data.
 */
export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Exponential moving average series.
 *
 * @param values series of numbers, oldest first.
 * @param period lookback window.
 * @returns the EMA series aligned to the tail of the input.
 */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * Latest exponential moving average value.
 *
 * @param values series of numbers, oldest first.
 * @param period lookback window.
 * @returns the last EMA value, or NaN when there is not enough data.
 */
export function ema(values: number[], period: number): number {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : NaN;
}

/**
 * Relative Strength Index series (Wilder smoothing).
 *
 * @param values close prices, oldest first.
 * @param period lookback window, defaults to 14.
 * @returns RSI values array aligned with the inputs from index `period` onwards.
 */
export function rsiSeries(values: number[], period = 14): number[] {
  if (values.length < period + 1) return [];
  const out: number[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  out.push(loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));

  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
    out.push(loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

/**
 * Relative Strength Index (Wilder smoothing).
 *
 * @param values close prices, oldest first.
 * @param period lookback window, defaults to 14.
 * @returns RSI between 0 and 100, or NaN when there is not enough data.
 */
export function rsi(values: number[], period = 14): number {
  const series = rsiSeries(values, period);
  return series.length ? series[series.length - 1] : NaN;
}

/**
 * Detect regular RSI divergences over recent candles.
 *
 * - Bullish divergence: price forms a lower low (or double bottom), while RSI
 *   forms a higher low below neutral 50. Indicates selling exhaustion.
 * - Bearish divergence: price forms a higher high (or double top), while RSI
 *   forms a lower high above neutral 50. Indicates buying exhaustion.
 *
 * @param closes close prices, oldest first.
 * @param candles OHLCV candles, oldest first.
 * @param period RSI period, defaults to 14.
 * @returns 'BULLISH', 'BEARISH', or null when no clear divergence is present.
 */
export function detectRsiDivergence(
  closes: number[],
  candles: Candle[],
  period = 14
): 'BULLISH' | 'BEARISH' | null {
  if (candles.length < period + 10 || closes.length < period + 10) return null;
  const series = rsiSeries(closes, period);
  if (series.length < 10) return null;

  const N = candles.length;
  const startIdx = Math.max(period + 2, N - 25);

  // 1. Check Bullish Divergence (Troughs / Swing Lows)
  const troughs: { index: number; price: number; rsi: number }[] = [];
  for (let i = startIdx; i < N - 1; i += 1) {
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low) {
      troughs.push({ index: i, price: candles[i].low, rsi: series[i - period] });
    }
  }
  if (candles[N - 1].low <= candles[N - 2].low) {
    troughs.push({ index: N - 1, price: candles[N - 1].low, rsi: series[N - 1 - period] });
  }

  let bullDiv = false;
  let bullIndex = -1;
  if (troughs.length >= 2) {
    const recent = troughs[troughs.length - 1];
    const prior = troughs[troughs.length - 2];
    if (
      recent.index - prior.index >= 3 &&
      recent.price < prior.price &&
      recent.rsi > prior.rsi + 1.5 &&
      recent.rsi <= 50
    ) {
      bullDiv = true;
      bullIndex = recent.index;
    }
  }

  // 2. Check Bearish Divergence (Peaks / Swing Highs)
  const peaks: { index: number; price: number; rsi: number }[] = [];
  for (let i = startIdx; i < N - 1; i += 1) {
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i + 1].high) {
      peaks.push({ index: i, price: candles[i].high, rsi: series[i - period] });
    }
  }
  if (candles[N - 1].high >= candles[N - 2].high) {
    peaks.push({ index: N - 1, price: candles[N - 1].high, rsi: series[N - 1 - period] });
  }

  let bearDiv = false;
  let bearIndex = -1;
  if (peaks.length >= 2) {
    const recent = peaks[peaks.length - 1];
    const prior = peaks[peaks.length - 2];
    if (
      recent.index - prior.index >= 3 &&
      recent.price > prior.price &&
      recent.rsi < prior.rsi - 1.5 &&
      recent.rsi >= 50
    ) {
      bearDiv = true;
      bearIndex = recent.index;
    }
  }

  if (bullDiv && bearDiv) {
    return bullIndex > bearIndex ? 'BULLISH' : 'BEARISH';
  }
  if (bullDiv) return 'BULLISH';
  if (bearDiv) return 'BEARISH';
  return null;
}

/**
 * MACD line, signal line and histogram.
 *
 * @param values close prices, oldest first.
 * @returns macd/signal/histogram values, NaN when there is not enough data.
 */
export function macd(values: number[]): { macd: number; signal: number; hist: number } {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  if (!fast.length || !slow.length) return { macd: NaN, signal: NaN, hist: NaN };
  const offset = fast.length - slow.length;
  const line = slow.map((s, i) => fast[i + offset] - s);
  const signalSeries = emaSeries(line, 9);
  if (!signalSeries.length) return { macd: NaN, signal: NaN, hist: NaN };
  const macdValue = line[line.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { macd: macdValue, signal, hist: macdValue - signal };
}

/**
 * Average True Range as a ratio of the last close.
 *
 * @param candles OHLCV candles, oldest first.
 * @param period lookback window, defaults to 14.
 * @returns ATR divided by price, or NaN when there is not enough data.
 */
export function atrPct(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const atr = sma(trs, period);
  const last = candles[candles.length - 1].close;
  return last ? atr / last : NaN;
}

/**
 * Average Directional Index — measures trend strength regardless of direction.
 *
 * @param candles OHLCV candles, oldest first.
 * @param period lookback window, defaults to 14.
 * @returns ADX value (roughly 0..100), or NaN when there is not enough data.
 */
export function adx(candles: Candle[], period = 14): number {
  // This implementation needs `period` true ranges, then `period` DX samples.
  if (period < 1 || candles.length < period * 2 + 1) return NaN;
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const dxs: number[] = [];
  for (let i = period; i < trs.length; i += 1) {
    const tr = trs.slice(i - period, i).reduce((a, b) => a + b, 0);
    if (!tr) continue;
    const pdi = (100 * plusDm.slice(i - period, i).reduce((a, b) => a + b, 0)) / tr;
    const mdi = (100 * minusDm.slice(i - period, i).reduce((a, b) => a + b, 0)) / tr;
    const sum = pdi + mdi;
    if (sum) dxs.push((100 * Math.abs(pdi - mdi)) / sum);
  }
  if (dxs.length < period) return NaN;
  return sma(dxs, period);
}

/**
 * Percentage return over the last `bars` candles.
 *
 * @param values close prices, oldest first.
 * @param bars lookback in candles.
 * @returns the return as a ratio, or 0 when there is not enough data.
 */
export function momentum(values: number[], bars: number): number {
  if (values.length <= bars) return 0;
  const past = values[values.length - 1 - bars];
  if (!past) return 0;
  return (values[values.length - 1] - past) / past;
}

/**
 * Position of price inside its recent high/low channel.
 *
 * @param candles OHLCV candles, oldest first.
 * @param period channel lookback, defaults to 20.
 * @returns 0 at the channel low, 1 at the channel high.
 */
export function channelPosition(candles: Candle[], period = 20): number {
  if (candles.length < period) return 0.5;
  const slice = candles.slice(-period);
  const high = Math.max(...slice.map((c) => c.high));
  const low = Math.min(...slice.map((c) => c.low));
  if (high === low) return 0.5;
  return (slice[slice.length - 1].close - low) / (high - low);
}

/**
 * Find swing pivots — local highs and lows confirmed by `strength` candles on
 * each side. These are the levels other traders actually watch, which makes them
 * far better stop and target anchors than a pure volatility band.
 *
 * @param candles OHLCV candles, oldest first.
 * @param strength candles required on each side of the pivot, defaults to 3.
 * @returns confirmed swing highs and lows, oldest first.
 */
export function swings(
  candles: Candle[],
  strength = 3
): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = strength; i < candles.length - strength; i += 1) {
    const window = candles.slice(i - strength, i + strength + 1);
    const candle = candles[i];
    if (window.every((c) => c.high <= candle.high)) highs.push(candle.high);
    if (window.every((c) => c.low >= candle.low)) lows.push(candle.low);
  }
  return { highs, lows };
}

/**
 * Nearest confirmed swing low strictly below the reference price.
 *
 * @param candles OHLCV candles, oldest first.
 * @param price reference price.
 * @param strength pivot strength, defaults to 3.
 * @returns the swing low, or NaN when there is none.
 */
export function nearestSwingLow(candles: Candle[], price: number, strength = 3): number {
  const below = swings(candles, strength).lows.filter((l) => l < price);
  return below.length ? Math.max(...below) : NaN;
}

/**
 * Nearest *significant* level below price — a swing low that is far enough away
 * to be real structure rather than intrabar noise.
 *
 * @param candles OHLCV candles, oldest first.
 * @param price reference price.
 * @param minDistance minimum distance from price to qualify.
 * @returns the level, or NaN when there is none.
 */
export function significantLow(candles: Candle[], price: number, minDistance: number): number {
  const levels = swings(candles, 5).lows.filter((l) => l < price - minDistance);
  return levels.length ? Math.max(...levels) : NaN;
}

/**
 * Nearest *significant* level above price.
 *
 * @param candles OHLCV candles, oldest first.
 * @param price reference price.
 * @param minDistance minimum distance from price to qualify.
 * @returns the level, or NaN when there is none.
 */
export function significantHigh(candles: Candle[], price: number, minDistance: number): number {
  const levels = swings(candles, 5).highs.filter((h) => h > price + minDistance);
  return levels.length ? Math.min(...levels) : NaN;
}

/**
 * Nearest confirmed swing high strictly above the reference price.
 *
 * @param candles OHLCV candles, oldest first.
 * @param price reference price.
 * @param strength pivot strength, defaults to 3.
 * @returns the swing high, or NaN when there is none.
 */
export function nearestSwingHigh(candles: Candle[], price: number, strength = 3): number {
  const above = swings(candles, strength).highs.filter((h) => h > price);
  return above.length ? Math.min(...above) : NaN;
}

/**
 * Current volume relative to its recent average.
 *
 * A breakout on rising volume is far more likely to follow through than the same
 * move on thin trade.
 *
 * @param candles OHLCV candles, oldest first.
 * @param period lookback for the average, defaults to 20.
 * @returns ratio where 1 means average volume, 2 means double, or NaN when
 *   there are not enough valid closed candles to calculate the ratio.
 */
export function volumeRatio(candles: Candle[], period = 20): number {
  // The final candle is still forming, so its volume is only a fraction of what
  // it will end up being. Comparing it to completed candles would make every
  // market look thin. Measure the last CLOSED candle instead.
  if (period < 1 || candles.length < period + 2) return NaN;
  const last = candles[candles.length - 2];
  const slice = candles.slice(-period - 2, -2);
  if (
    !Number.isFinite(last.volume) ||
    last.volume < 0 ||
    slice.some((c) => !Number.isFinite(c.volume) || c.volume < 0)
  ) {
    return NaN;
  }
  const avg = slice.reduce((a, c) => a + c.volume, 0) / slice.length;
  if (!avg) return NaN;
  return last.volume / avg;
}

/**
 * Slope of a linear regression through the series, normalised by price.
 *
 * Measures how consistently a market is moving rather than how far — a steady
 * climb scores higher than a single spike of the same size.
 *
 * @param values series of numbers, oldest first.
 * @param period lookback window.
 * @returns slope per bar as a ratio of the mean value.
 */
export function trendSlope(values: number[], period = 20): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const n = slice.length;
  const meanX = (n - 1) / 2;
  const meanY = slice.reduce((a, b) => a + b, 0) / n;
  if (!meanY) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (slice[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (!den) return 0;
  return num / den / meanY;
}
