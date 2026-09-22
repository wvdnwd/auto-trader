/**
 * Format a number as USD currency.
 *
 * @param value amount in quote currency.
 * @param decimals fraction digits, defaults to 2.
 * @returns formatted string, e.g. `$1,234.56`.
 */
export function usd(value: number, decimals = 2): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Format a ratio as a percentage.
 *
 * @param value ratio, e.g. 0.0125.
 * @param decimals fraction digits, defaults to 2.
 * @returns formatted string, e.g. `1.25%`.
 */
export function pct(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format a signed value with an explicit plus sign for gains.
 *
 * @param value the number to format.
 * @param fn formatter applied to the absolute rendering.
 * @returns formatted string prefixed with `+` when positive.
 */
export function signed(value: number, fn: (v: number) => string): string {
  return `${value > 0 ? '+' : ''}${fn(value)}`;
}

/**
 * Format a price with a sensible number of decimals for its magnitude.
 *
 * @param value the price.
 * @returns formatted price string.
 */
export function price(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  if (value >= 0.01) return value.toFixed(5);
  return value.toFixed(8);
}

/**
 * Format a coin quantity with a sensible number of decimals for its magnitude.
 *
 * Unlike {@link price}, this is unitless — the caller appends the asset symbol
 * (e.g. `qty(127.4)` + " WLD").
 *
 * @param value the quantity.
 * @returns formatted quantity string.
 */
export function qty(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(3);
  if (value >= 0.01) return value.toFixed(5);
  return value.toFixed(8);
}

/**
 * Format a timestamp as a local time string.
 *
 * @param ts unix milliseconds.
 * @returns `HH:MM:SS`.
 */
export function time(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('nl-NL', { hour12: false });
}

/**
 * Format a timestamp as date and time in Dutch.
 *
 * @param ts unix milliseconds.
 * @returns e.g. `21 sep, 19:32`.
 */
export function dateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const day = d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  const tm = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${tm}`;
}

/**
 * Format a unix-seconds timestamp as a short date.
 *
 * @param seconds unix seconds.
 * @returns `d MMM`, e.g. `4 mrt`.
 */
export function shortDate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const d = new Date(seconds * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

/**
 * Format the elapsed time since a timestamp.
 *
 * @param ts unix milliseconds.
 * @returns compact duration, e.g. `3u 12m`.
 */
export function since(ts: number): string {
  return duration(ts, Date.now());
}

/**
 * Format the span between two timestamps.
 *
 * @param from start in unix milliseconds.
 * @param to end in unix milliseconds, defaults to now.
 * @returns compact duration, e.g. `3u 12m`.
 */
export function duration(from: number, to?: number): string {
  const end = to ?? Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(end)) return '—';
  const mins = Math.max(0, Math.round((end - from) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}u ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}u`;
}
