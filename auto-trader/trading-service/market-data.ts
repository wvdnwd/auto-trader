import type { Candle, Ticker } from './types.js';
export { isCryptoPerp } from './market-filter.js';

const BASE = process.env.FUTURES_API_BASE || '';
const HYPERLIQUID_URL = process.env.HYPERLIQUID_INFO_URL || 'https://api.hyperliquid.xyz/info';

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

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 510]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HISTORY_CACHE_LIMIT = 200;

const MAX_CONCURRENT_REQUESTS = 4;
const DISPATCH_GAP_MS = 100;

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

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    pumpQueue();
  });
}

function releaseSlot(): void {
  activeRequests -= 1;
  pumpQueue();
}

/**
 * Normalise any user-supplied or internal symbol to Hyperliquid's asset name.
 * E.g. 'BTC_USDT', 'BTC-USDC', 'BTC_USDC', 'BTC' -> 'BTC'.
 * Handles special scaled meme naming e.g. PEPE -> kPEPE, 1000BONK -> kBONK.
 */
export function normalizeCoin(symbol: string): string {
  const clean = symbol.replace(/-USDC$|-USDT$|_USDT$|_USDC$/i, '').toUpperCase();
  if (clean === 'PEPE' || clean === '1000PEPE') return 'kPEPE';
  if (clean === 'BONK' || clean === '1000BONK') return 'kBONK';
  if (clean === 'SHIB' || clean === '1000SHIB') return 'kSHIB';
  if (clean === 'MOG' || clean === '1000000MOG') return 'kMOG';
  return clean;
}

function toHlInterval(interval: string): '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d' {
  const lower = interval.toLowerCase();
  if (lower === 'min5' || lower === '5m') return '5m';
  if (lower === 'min15' || lower === '15m') return '15m';
  if (lower === 'min60' || lower === '60m' || lower === '1h') return '1h';
  if (lower === '4h') return '4h';
  if (lower === '1d' || lower === '1day') return '1d';
  if (lower === '1m' || lower === '3m' || lower === '30m' || lower === '2h' || lower === '8h' || lower === '12h') {
    return lower as any;
  }
  return '15m';
}

function hlIntervalToMs(interval: string): number {
  switch (interval) {
    case '1m': return 60_000;
    case '3m': return 180_000;
    case '5m': return 300_000;
    case '15m': return 900_000;
    case '30m': return 1_800_000;
    case '1h': return 3_600_000;
    case '2h': return 7_200_000;
    case '4h': return 14_400_000;
    case '8h': return 28_800_000;
    case '12h': return 43_200_000;
    case '1d': return 86_400_000;
    default: return 900_000;
  }
}

async function postHl<T>(body: unknown, attempts = 3): Promise<T> {
  let lastError: Error = new Error('Hyperliquid info request failed');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(200 * 2 ** (attempt - 1));
    }
    await acquireSlot();
    try {
      const res = await fetch(HYPERLIQUID_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Hyperliquid HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err as Error;
    } finally {
      releaseSlot();
    }
  }
  throw lastError;
}

async function getJson<T>(url: string, attempts = 3): Promise<T> {
  let last: Error = new Error(`market data request failed: ${url}`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
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
 * Read-only feed of perpetual futures market data from Hyperliquid L1.
 */
export class MarketData {
  private tickerCache: { at: number; data: Ticker[] } = { at: 0, data: [] };
  private candleCache = new Map<string, { at: number; data: Candle[] }>();
  private contractCache = new Map<string, ContractDetail>();
  private historyCache = new Map<string, Candle[]>();

  constructor(
    private readonly tickerTtlMs = 20_000,
    private readonly candleTtlMs = 60_000,
    private readonly staleGraceMs = 30_000
  ) {}

  /**
   * Fetch perpetual tickers, cached for a short TTL.
   * Primary source is Hyperliquid decentralized perpetuals.
   */
  async tickers(maxAgeMs?: number): Promise<Ticker[]> {
    const ttl = maxAgeMs ?? this.tickerTtlMs;
    const now = Date.now();
    if (now - this.tickerCache.at < ttl && this.tickerCache.data.length) {
      return this.tickerCache.data;
    }

    if (BASE && BASE.includes('contract.mexc.com')) {
      return this.fetchMexcTickers(now);
    }

    try {
      const [meta, assetCtxs] = await postHl<[
        { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> },
        Array<{
          markPx?: string;
          midPx?: string | null;
          prevDayPx?: string;
          dayNtlVlm?: string;
          funding?: string;
          impactPxs?: [string, string] | null;
        }>
      ]>({
        type: 'metaAndAssetCtxs',
      });

      const data: Ticker[] = [];
      const universe = meta?.universe || [];
      const ctxs = assetCtxs || [];

      for (let i = 0; i < universe.length; i += 1) {
        const u = universe[i];
        const ctx = ctxs[i];
        if (!u || !ctx) continue;
        const lastPrice = Number(ctx.markPx || ctx.midPx || 0);
        if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;

        const bid1 = ctx.impactPxs && ctx.impactPxs[0] ? Number(ctx.impactPxs[0]) : undefined;
        const ask1 = ctx.impactPxs && ctx.impactPxs[1] ? Number(ctx.impactPxs[1]) : undefined;
        const spreadPct =
          bid1 !== undefined && ask1 !== undefined && lastPrice > 0
            ? Math.max(0, (ask1 - bid1) / lastPrice)
            : undefined;
        const prevDayPx = Number(ctx.prevDayPx) || lastPrice;
        const changeRate24h = prevDayPx > 0 ? (lastPrice - prevDayPx) / prevDayPx : 0;
        const quoteVolume24h = Number(ctx.dayNtlVlm) || 0;
        const fundingRate = Number(ctx.funding) || 0;

        const primarySymbol = `${u.name}_USDT`;
        data.push({
          symbol: primarySymbol,
          lastPrice,
          bid1,
          ask1,
          spreadPct,
          quoteVolume24h,
          changeRate24h,
          fundingRate,
        });

        // Add meme aliases for engine compatibility
        if (u.name === 'kPEPE') {
          data.push({ symbol: 'PEPE_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kBONK') {
          data.push({ symbol: '1000BONK_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
          data.push({ symbol: 'BONK_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kSHIB') {
          data.push({ symbol: 'SHIB_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kMOG') {
          data.push({ symbol: '1000000MOG_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        }
      }

      data.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
      this.tickerCache = { at: now, data };
      return data;
    } catch (err) {
      if (this.tickerCache.data.length && now - this.tickerCache.at < this.staleGraceMs) {
        return this.tickerCache.data;
      }
      throw err;
    }
  }

  /**
   * Fetch the latest price for a single symbol from Hyperliquid.
   */
  async price(symbol: string): Promise<number> {
    if (BASE && BASE.includes('contract.mexc.com')) {
      const data = await getJson<RawTicker>(`${BASE}/ticker?symbol=${symbol}`);
      return Number(data.lastPrice) || 0;
    }
    const coin = normalizeCoin(symbol);
    const mids = await postHl<Record<string, string>>({ type: 'allMids' });
    return Number(mids[coin]) || 0;
  }

  /**
   * Fetch contract order-sizing specification for Hyperliquid.
   */
  async contractDetail(symbol: string): Promise<ContractDetail> {
    const cached = this.contractCache.get(symbol);
    if (cached) return cached;

    if (BASE && BASE.includes('contract.mexc.com')) {
      return this.fetchMexcContractDetail(symbol);
    }

    const coin = normalizeCoin(symbol);
    let szDecimals = 4;
    try {
      const meta = await postHl<{ universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> }>({ type: 'meta' });
      const asset = meta?.universe?.find((u) => u.name === coin);
      if (asset) szDecimals = asset.szDecimals;
    } catch {
      // Fallback
    }

    const detail: ContractDetail = {
      symbol,
      contractSize: 1,
      minVol: Math.pow(10, -szDecimals),
      maxVol: Number.MAX_SAFE_INTEGER,
      priceScale: Math.min(8, Math.max(2, szDecimals + 2)),
    };
    this.contractCache.set(symbol, detail);
    return detail;
  }

  /**
   * Fetch OHLCV candles for a symbol from Hyperliquid.
   */
  async candles(symbol: string, interval = 'Min15'): Promise<Candle[]> {
    const key = `${symbol}:${interval}`;
    const now = Date.now();
    const cached = this.candleCache.get(key);
    if (cached && now - cached.at < this.candleTtlMs) return cached.data;

    if (BASE && BASE.includes('contract.mexc.com')) {
      const data = await this.fetchMexcKlines(symbol, interval);
      this.candleCache.set(key, { at: now, data });
      return data;
    }

    try {
      const coin = normalizeCoin(symbol);
      const hlInterval = toHlInterval(interval);
      const intervalMs = hlIntervalToMs(hlInterval);
      const startTime = now - 300 * intervalMs;

      const raw = await postHl<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>>({
        type: 'candleSnapshot',
        req: {
          coin,
          interval: hlInterval,
          startTime,
          endTime: now,
        },
      });

      const data: Candle[] = (Array.isArray(raw) ? raw : [])
        .map((c) => ({
          time: Math.floor(c.t / 1000),
          open: Number(c.o),
          high: Number(c.h),
          low: Number(c.l),
          close: Number(c.c),
          volume: Number(c.v),
        }))
        .filter(
          (c) =>
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close) &&
            c.close > 0
        )
        .sort((a, b) => a.time - b.time);

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
   * Fetch a history of candles for backtesting from Hyperliquid.
   */
  async history(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
    const key = `${symbol}:${interval}:${from}:${to}`;
    const cached = this.historyCache.get(key);
    if (cached) return cached;

    if (BASE && BASE.includes('contract.mexc.com')) {
      return this.fetchMexcHistory(symbol, interval, from, to);
    }

    const coin = normalizeCoin(symbol);
    const hlInterval = toHlInterval(interval);

    const raw = await postHl<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>>({
      type: 'candleSnapshot',
      req: {
        coin,
        interval: hlInterval,
        startTime: Math.floor(from * 1000),
        endTime: Math.floor(to * 1000),
      },
    });

    const data: Candle[] = (Array.isArray(raw) ? raw : [])
      .map((c) => ({
        time: Math.floor(c.t / 1000),
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.close > 0 &&
          c.time >= from &&
          c.time <= to
      )
      .sort((a, b) => a.time - b.time);

    if (this.historyCache.size >= HISTORY_CACHE_LIMIT) {
      const oldestKey = this.historyCache.keys().next().value;
      if (oldestKey !== undefined) this.historyCache.delete(oldestKey);
    }
    this.historyCache.set(key, data);
    return data;
  }

  private async fetchMexcTickers(now: number): Promise<Ticker[]> {
    const raw = await getJson<RawTicker[]>(`${BASE}/ticker`);
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

  private async fetchMexcContractDetail(symbol: string): Promise<ContractDetail> {
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

  private async fetchMexcKlines(symbol: string, interval: string, from?: number, to?: number): Promise<Candle[]> {
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

  private async fetchMexcHistory(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
    const byTime = new Map<number, Candle>();
    let cursor = to;
    for (let page = 0; page < 24 && cursor > from; page += 1) {
      const batch = await this.fetchMexcKlines(symbol, interval, from, cursor);
      if (!batch.length) break;
      for (const candle of batch) byTime.set(candle.time, candle);
      const oldest = batch[0].time;
      if (oldest <= from || oldest >= cursor) break;
      cursor = oldest - 1;
    }
    const data = [...byTime.values()]
      .filter((c) => c.time >= from && c.time <= to)
      .sort((a, b) => a.time - b.time);
    if (this.historyCache.size >= HISTORY_CACHE_LIMIT) {
      const oldestKey = this.historyCache.keys().next().value;
      if (oldestKey !== undefined) this.historyCache.delete(oldestKey);
    }
    this.historyCache.set(`${symbol}:${interval}:${from}:${to}`, data);
    return data;
  }
}
