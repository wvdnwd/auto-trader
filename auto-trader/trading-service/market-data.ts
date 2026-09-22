import type { Candle, Ticker } from './types.js';

const BASE = process.env.FUTURES_API_BASE || 'https://contract.mexc.com/api/v1/contract';

/**
 * Non-crypto underlyings the venue also lists as perpetuals.
 *
 * Metals, energy, equity indices and tokenised stocks trade on session hours and
 * macro news, so a crypto momentum strategy has no edge in them and the gaps
 * between sessions break the candle-based indicators.
 */
const NON_CRYPTO =
  /^(XAU|XAG|XAUT|XPT|XPD|SILVER|GOLD|USOIL|UKOIL|WTI|BRENT|NGAS|SPX|SPX500|SPY|NDX|NAS100|DJI|DAX|FTSE|NIKKEI|HSI|US30|US500|VIX)_|STOCK|_INDEX|PREMARKET|SOXL|TSLA|TESLA|AAPL|NVDA|NVIDIA|MSTR|AMZN|MSFT|GOOGL/i;

/**
 * Whether a contract is a crypto perpetual worth trading.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 * @returns true when the symbol is a USDT-quoted crypto perpetual.
 */
export function isCryptoPerp(symbol: string): boolean {
  if (!symbol.endsWith('_USDT')) return false;
  return !NON_CRYPTO.test(symbol);
}

type RawTicker = {
  symbol: string;
  lastPrice: number;
  bid1?: number;
  ask1?: number;
  amount24: number;
  riseFallRate: number;
  fundingRate: number;
};

type RawKline = {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  vol: number[];
};

type RawContractDetail = {
  symbol: string;
  contractSize: number;
  minVol: number;
  maxVol: number;
  volScale: number;
  priceScale?: number;
};

/**
 * The handful of contract-spec fields needed to translate a USDT amount into
 * the `vol` (contract count) MEXC's order endpoint expects.
 */
export type ContractDetail = {
  symbol: string;
  /** Amount of the underlying one contract ('vol' unit) represents. */
  contractSize: number;
  /** Smallest order size the venue accepts, in vol. */
  minVol: number;
  /** Largest order size the venue accepts, in vol. */
  maxVol: number;
  /** Decimal places allowed for order prices. */
  priceScale: number;
};

/**
 * Venue responses that mean "try again", not "this request is wrong".
 *
 * 510 is the venue's rate limit and it arrives as HTTP 200 with `success: false`,
 * so it has to be matched on the body code rather than the status. Retrying these
 * matters more than it looks: a single throw kills the whole engine cycle, which
 * also skips exit management on open positions.
 */
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 510]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Max distinct historical windows kept in memory at once. */
const HISTORY_CACHE_LIMIT = 200;

/**
 * Global outbound-request gate shared by every call this module makes.
 *
 * A single scan cycle used to fire one request per symbol per timeframe (14+
 * for a 7-symbol universe) all at once with zero pacing. MEXC's public API
 * rate-limits by IP and answers a tripped limit with code 510 on EVERY
 * in-flight request at once — which is exactly the "all symbols fail in the
 * same warning" pattern seen in production, not a per-symbol problem. Capping
 * how many requests may be in flight together, and spacing out when each new
 * one is allowed to start, keeps the whole module under the venue's burst
 * limit instead of tripping it every cycle.
 */
const MAX_CONCURRENT_REQUESTS = 3;
/** Minimum gap between the start of two outbound requests, in ms. */
const DISPATCH_GAP_MS = 150;

let activeRequests = 0;
let lastDispatchAt = 0;
const waiters: Array<() => void> = [];

function pumpQueue(): void {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || !waiters.length) return;
  const waiter = waiters.shift();
  if (!waiter) return;
  activeRequests += 1;
  const now = Date.now();
  const wait = Math.max(0, lastDispatchAt + DISPATCH_GAP_MS - now);
  lastDispatchAt = now + wait;
  setTimeout(waiter, wait);
}

/** Reserve a slot in the shared request gate, resolving once dispatch is allowed. */
function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    pumpQueue();
  });
}

/** Release a slot back to the shared request gate, waking the next waiter. */
function releaseSlot(): void {
  activeRequests -= 1;
  pumpQueue();
}

async function getJson<T>(url: string, attempts = 3): Promise<T> {
  let last: Error = new Error(`market data request failed: ${url}`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      // Back off with jitter so parallel symbol requests do not retry in lockstep
      // and trip the same limit again. Rate-limit (510) responses get a longer
      // base delay than plain network hiccups since the whole IP window needs
      // time to clear, not just this one request.
      await sleep(400 * 2 ** (attempt - 1) + Math.random() * 200);
    }
    await acquireSlot();
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        const err = new Error(`market data request failed: ${res.status} ${url}`);
        if (RETRYABLE_CODES.has(res.status)) {
          last = err;
          continue;
        }
        throw err;
      }
      const body = (await res.json()) as { success?: boolean; data?: T; code?: number };
      if (body.success === false) {
        const err = new Error(`market data error code ${body.code} for ${url}`);
        if (body.code !== undefined && RETRYABLE_CODES.has(body.code)) {
          last = err;
          continue;
        }
        throw err;
      }
      if (body.data === undefined) throw new Error(`market data returned no payload for ${url}`);
      return body.data;
    } catch (err) {
      // Network-level failures are worth one more try; anything the venue
      // explicitly rejected has already been rethrown above.
      if (err instanceof TypeError) {
        last = err;
        continue;
      }
      throw err;
    } finally {
      releaseSlot();
    }
  }
  throw last;
}

/**
 * Read-only feed of perpetual futures market data.
 *
 * Uses public endpoints only — no API key, no account access. Swap the base URL
 * via the `FUTURES_API_BASE` env var to point at another venue with the same shape.
 */
export class MarketData {
  private tickerCache: { at: number; data: Ticker[] } = { at: 0, data: [] };

  private candleCache = new Map<string, { at: number; data: Candle[] }>();

  /** Contract specs (size, min/max order vol) rarely change — cached for the process lifetime. */
  private contractCache = new Map<string, ContractDetail>();

  /**
   * Historical windows never change once fetched, so they are cached for reuse
   * across a run — e.g. the overlapping windows a walk-forward analysis replays,
   * or the shared candles every optimizer candidate scores against.
   *
   * Bounded to {@link HISTORY_CACHE_LIMIT} entries: a long optimizer search can
   * touch hundreds of distinct `symbol:interval:from:to` windows in one process
   * lifetime, and each entry holds a full OHLCV series, so an unbounded map would
   * grow for as long as the process runs. Evicting the oldest entry once the
   * limit is hit keeps memory flat without hurting the common case, where the
   * same handful of windows are re-read many times in a row.
   */
  private historyCache = new Map<string, Candle[]>();

  constructor(
    /** How long ticker snapshots stay fresh, in ms. */
    private readonly tickerTtlMs = 20_000,
    /** How long candle series stay fresh, in ms. */
    private readonly candleTtlMs = 60_000,
    /**
     * How far past its TTL a cached ticker may be served when the venue is
     * unreachable. Kept short: a stale price still drives exit decisions, and on
     * this strategy's 3x ATR stops half a minute of drift is tolerable where a
     * dead cycle — which manages no positions at all — is not.
     */
    private readonly staleGraceMs = 30_000
  ) {}

  /**
   * Fetch every USDT perpetual ticker, cached for a short TTL.
   *
   * @param maxAgeMs how stale a cached snapshot may be before refetching.
   *   Defaults to the configured TTL; pass a lower value when running the fast
   *   cycle and a sharper entry price is worth the extra request.
   * @returns list of tickers sorted by 24h quote volume, most liquid first.
   */
  async tickers(maxAgeMs?: number): Promise<Ticker[]> {
    const ttl = maxAgeMs ?? this.tickerTtlMs;
    const now = Date.now();
    if (now - this.tickerCache.at < ttl && this.tickerCache.data.length) {
      return this.tickerCache.data;
    }
    let raw: RawTicker[];
    try {
      raw = await getJson<RawTicker[]>(`${BASE}/ticker`);
    } catch (err) {
      if (this.tickerCache.data.length && now - this.tickerCache.at < this.staleGraceMs) {
        return this.tickerCache.data;
      }
      throw err;
    }
    const data = raw
      .filter((t) => t.symbol?.endsWith('_USDT'))
      .map<Ticker>((t) => {
        const lastPrice = Number(t.lastPrice) || 0;
        const bid1 = Number(t.bid1) || undefined;
        const ask1 = Number(t.ask1) || undefined;
        const spreadPct =
          bid1 !== undefined && ask1 !== undefined && lastPrice > 0
            ? Math.max(0, (ask1 - bid1) / lastPrice)
            : undefined;
        return {
          symbol: t.symbol,
          lastPrice,
          bid1,
          ask1,
          spreadPct,
          quoteVolume24h: Number(t.amount24) || 0,
          changeRate24h: Number(t.riseFallRate) || 0,
          fundingRate: Number(t.fundingRate) || 0,
        };
      })
      .filter((t) => t.lastPrice > 0)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
    this.tickerCache = { at: now, data };
    return data;
  }

  /**
   * Fetch the latest price for a single symbol, bypassing the candle cache.
   *
   * @param symbol contract symbol, e.g. `BTC_USDT`.
   * @returns the last traded price.
   */
  async price(symbol: string): Promise<number> {
    const data = await getJson<RawTicker>(`${BASE}/ticker?symbol=${symbol}`);
    return Number(data.lastPrice) || 0;
  }

  /**
   * Fetch a contract's order-sizing spec — the pieces needed to translate a
   * plain USDT amount into the `vol` (contract count) MEXC's order endpoint
   * expects, and to validate that amount against the venue's min/max order size.
   *
   * Cached indefinitely per symbol: contract specs change on the order of
   * months, not during a session, so re-fetching every call would just be
   * wasted requests on the hot order-placement path.
   *
   * @param symbol contract symbol, e.g. `BTC_USDT`.
   * @returns the contract size and order size bounds for that symbol.
   */
  async contractDetail(symbol: string): Promise<ContractDetail> {
    const cached = this.contractCache.get(symbol);
    if (cached) return cached;
    const data = await getJson<RawContractDetail>(`${BASE}/detail?symbol=${symbol}`);
    const detail: ContractDetail = {
      symbol,
      contractSize: Number(data.contractSize) || 1,
      minVol: Number(data.minVol) || 1,
      maxVol: Number(data.maxVol) || Number.MAX_SAFE_INTEGER,
      priceScale: Number.isFinite(Number(data.priceScale)) ? Number(data.priceScale) : 4,
    };
    this.contractCache.set(symbol, detail);
    return detail;
  }

  /**
   * Fetch OHLCV candles for a symbol.
   *
   * @param symbol contract symbol, e.g. `BTC_USDT`.
   * @param interval venue interval key, e.g. `Min15` or `Min60`.
   * @returns candles oldest first.
   */
  async candles(symbol: string, interval = 'Min15'): Promise<Candle[]> {
    const key = `${symbol}:${interval}`;
    const now = Date.now();
    const cached = this.candleCache.get(key);
    if (cached && now - cached.at < this.candleTtlMs) return cached.data;

    try {
      const data = await this.fetchKlines(symbol, interval);
      this.candleCache.set(key, { at: now, data });
      return data;
    } catch (err) {
      if (cached && cached.data.length) return cached.data;
      throw err;
    }
  }

  /**
   * Return any cached candles for a symbol, regardless of TTL.
   */
  getCachedCandles(symbol: string, interval = 'Min60'): Candle[] | undefined {
    return this.candleCache.get(`${symbol}:${interval}`)?.data;
  }

  /**
   * Fetch a long history of candles for backtesting, paging backwards through
   * the venue's per-request limit until the requested window is covered.
   *
   * @param symbol contract symbol, e.g. `BTC_USDT`.
   * @param interval venue interval key, e.g. `Min15`.
   * @param from start of the window, unix seconds.
   * @param to end of the window, unix seconds.
   * @returns candles oldest first, de-duplicated and sorted.
   */
  async history(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
    const key = `${symbol}:${interval}:${from}:${to}`;
    const cached = this.historyCache.get(key);
    if (cached) return cached;

    const byTime = new Map<number, Candle>();
    let cursor = to;
    // Page backwards: each request returns the newest bars up to `end`, so we
    // walk the window back until we reach `from` or the venue stops returning data.
    for (let page = 0; page < 24 && cursor > from; page += 1) {
      const batch = await this.fetchKlines(symbol, interval, from, cursor);
      if (!batch.length) break;
      for (const candle of batch) byTime.set(candle.time, candle);
      const oldest = batch[0].time;
      if (oldest <= from || oldest >= cursor) break;
      cursor = oldest - 1;
    }

    const data = [...byTime.values()]
      .filter((c) => c.time >= from && c.time <= to)
      .sort((a, b) => a.time - b.time);
    // Evict the oldest window first so the cache cannot grow without bound
    // across a long-running optimizer or walk-forward session.
    if (this.historyCache.size >= HISTORY_CACHE_LIMIT) {
      const oldestKey = this.historyCache.keys().next().value;
      if (oldestKey !== undefined) this.historyCache.delete(oldestKey);
    }
    this.historyCache.set(key, data);
    return data;
  }

  private async fetchKlines(
    symbol: string,
    interval: string,
    from?: number,
    to?: number
  ): Promise<Candle[]> {
    const params = new URLSearchParams({ interval });
    if (from !== undefined) params.set('start', String(Math.floor(from)));
    if (to !== undefined) params.set('end', String(Math.floor(to)));
    const raw = await getJson<RawKline>(`${BASE}/kline/${symbol}?${params.toString()}`);
    return (raw.time || [])
      .map((time, i) => ({
        time,
        open: Number(raw.open[i]),
        high: Number(raw.high[i]),
        low: Number(raw.low[i]),
        close: Number(raw.close[i]),
        volume: Number(raw.vol[i]),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.close > 0
      );
  }
}
