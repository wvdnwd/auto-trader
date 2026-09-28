import type { Candle, Ticker } from './types.js';
import { ErrorLogger } from './error-logger.js';
export { isCryptoPerp } from './market-filter.js';

const HYPERLIQUID_URL = process.env.HYPERLIQUID_INFO_URL || 'https://api.hyperliquid.xyz/info';

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
  /** Maximum leverage tier allowed for this contract on the exchange. */
  maxLeverage?: number;
};

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 510]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HISTORY_CACHE_LIMIT = 200;
const CANDLE_CACHE_LIMIT = 400;
const CONTRACT_CACHE_LIMIT = 400;

const MAX_CONCURRENT_REQUESTS = 2;
const DISPATCH_GAP_MS = 250;

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
  if (clean === 'FLOKI' || clean === '1000FLOKI') return 'kFLOKI';
  if (clean === 'MOG' || clean === '1000000MOG') return 'kMOG';
  if (clean === 'DOGS' || clean === '1000DOGS') return 'kDOGS';
  if (clean === 'NEIRO' || clean === '1000NEIRO') return 'kNEIRO';
  if (clean === 'LUNC' || clean === '1000LUNC') return 'kLUNC';
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

function toBinanceSymbol(symbol: string): string {
  const coin = normalizeCoin(symbol);
  if (coin === 'kPEPE') return '1000PEPEUSDT';
  if (coin === 'kBONK') return '1000BONKUSDT';
  if (coin === 'kSHIB') return '1000SHIBUSDT';
  if (coin === 'kFLOKI') return '1000FLOKIUSDT';
  if (coin === 'kMOG') return '1000MOGUSDT';
  if (coin === 'kDOGS') return '1000DOGSUSDT';
  if (coin === 'kNEIRO') return '1000NEIROUSDT';
  if (coin === 'kLUNC') return '1000LUNCUSDT';
  return `${coin}USDT`;
}

function toBinanceInterval(interval: string): string {
  const lower = interval.toLowerCase();
  if (lower === 'min5' || lower === '5m') return '5m';
  if (lower === 'min15' || lower === '15m') return '15m';
  if (lower === 'min60' || lower === '60m' || lower === '1h') return '1h';
  if (lower === '4h') return '4h';
  if (lower === '1d' || lower === '1day') return '1d';
  return '15m';
}

function toBybitInterval(interval: string): string {
  const lower = interval.toLowerCase();
  if (lower === 'min5' || lower === '5m') return '5';
  if (lower === 'min15' || lower === '15m') return '15';
  if (lower === 'min60' || lower === '60m' || lower === '1h') return '60';
  if (lower === '4h') return '240';
  if (lower === '1d' || lower === '1day') return 'D';
  return '15';
}

async function fetchBinanceCandles(symbol: string, interval: string, limit = 150): Promise<Candle[] | null> {
  try {
    const binanceSymbol = toBinanceSymbol(symbol);
    const binanceInterval = toBinanceInterval(interval);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${binanceInterval}&limit=${limit}`,
      { signal: controller.signal }
    ).finally(() => clearTimeout(timeout));

    if (!res.ok) return null;
    const raw = (await res.json()) as Array<[number, string, string, string, string, string, ...unknown[]]>;
    if (!Array.isArray(raw) || !raw.length) return null;

    const data = raw
      .map((c) => ({
        time: Math.floor(Number(c[0]) / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
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

    return data.length >= 20 ? data : null;
  } catch {
    return null;
  }
}

async function fetchBybitCandles(symbol: string, interval: string, limit = 150): Promise<Candle[] | null> {
  try {
    const bybitSymbol = toBinanceSymbol(symbol);
    const bybitInterval = toBybitInterval(interval);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${bybitSymbol}&interval=${bybitInterval}&limit=${limit}`,
      { signal: controller.signal }
    ).finally(() => clearTimeout(timeout));

    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { list?: Array<[string, string, string, string, string, string, string]> } };
    const raw = json?.result?.list;
    if (!Array.isArray(raw) || !raw.length) return null;

    const data = raw
      .map((c) => ({
        time: Math.floor(Number(c[0]) / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
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

    return data.length >= 20 ? data : null;
  } catch {
    return null;
  }
}

async function postHl<T>(body: unknown, attempts = 4): Promise<T> {
  let lastError: Error = new Error('Hyperliquid info request failed');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(1000 * 2 ** (attempt - 1));
    }
    await acquireSlot();
    try {
      const res = await fetch(HYPERLIQUID_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 429) {
          lastError = new Error(`Hyperliquid HTTP 429 (Rate Limit)`);
          ErrorLogger.getInstance().warn('MarketData', 'Hyperliquid HTTP 429 (Rate Limit)', { attempt, attempts });
          await sleep(2500 * (attempt + 1));
          continue;
        }
        throw new Error(`Hyperliquid HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err as Error;
    } finally {
      releaseSlot();
    }
  }
  ErrorLogger.getInstance().error('MarketData', lastError, { attempts, endpoint: 'postHl' });
  throw lastError;
}

/**
 * Read-only feed of perpetual futures market data from Hyperliquid L1.
 */
export class MarketData {
  private tickerCache: { at: number; data: Ticker[] } = { at: 0, data: [] };
  private candleCache = new Map<string, { at: number; data: Candle[] }>();
  private contractCache = new Map<string, ContractDetail>();
  private historyCache = new Map<string, Candle[]>();
  private inFlightCandles = new Map<string, Promise<Candle[]>>();

  constructor(
    private readonly tickerTtlMs = 20_000,
    private readonly candleTtlMs = 60_000,
    private readonly staleGraceMs = 30_000
  ) {}

  private getTtlForInterval(interval: string): number {
    const lower = interval.toLowerCase();
    if (lower === '4h') return 300_000; // 5 minuten
    if (lower === 'min60' || lower === '60m' || lower === '1h') return 120_000; // 2 minuten
    if (lower === 'min15' || lower === '15m') return 60_000; // 1 minuut
    if (lower === 'min5' || lower === '5m') return 30_000; // 30 seconden
    return this.candleTtlMs;
  }

  /** Store candles under a bounded cache, evicting the least recently written key. */
  private setCandleCache(key: string, entry: { at: number; data: Candle[] }): void {
    if (this.candleCache.has(key)) {
      this.candleCache.delete(key);
    } else if (this.candleCache.size >= CANDLE_CACHE_LIMIT) {
      const oldestKey = this.candleCache.keys().next().value;
      if (oldestKey !== undefined) this.candleCache.delete(oldestKey);
    }
    this.candleCache.set(key, entry);
  }

  /** Store a contract spec under a bounded cache, evicting the least recently written key. */
  private setContractCache(symbol: string, detail: ContractDetail): void {
    if (this.contractCache.has(symbol)) {
      this.contractCache.delete(symbol);
    } else if (this.contractCache.size >= CONTRACT_CACHE_LIMIT) {
      const oldestKey = this.contractCache.keys().next().value;
      if (oldestKey !== undefined) this.contractCache.delete(oldestKey);
    }
    this.contractCache.set(symbol, detail);
  }

  /**
   * Fetch perpetual tickers, cached for a short TTL.
   * Source is Hyperliquid decentralized perpetuals.
   */
  async tickers(maxAgeMs?: number): Promise<Ticker[]> {
    const ttl = maxAgeMs ?? this.tickerTtlMs;
    const now = Date.now();
    if (now - this.tickerCache.at < ttl && this.tickerCache.data.length) {
      return this.tickerCache.data;
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
        } else if (u.name === 'kFLOKI') {
          data.push({ symbol: '1000FLOKI_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
          data.push({ symbol: 'FLOKI_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kMOG') {
          data.push({ symbol: '1000000MOG_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kDOGS') {
          data.push({ symbol: '1000DOGS_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
          data.push({ symbol: 'DOGS_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kNEIRO') {
          data.push({ symbol: '1000NEIRO_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
          data.push({ symbol: 'NEIRO_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
        } else if (u.name === 'kLUNC') {
          data.push({ symbol: '1000LUNC_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
          data.push({ symbol: 'LUNC_USDT', lastPrice, bid1, ask1, spreadPct, quoteVolume24h, changeRate24h, fundingRate });
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

    const coin = normalizeCoin(symbol);
    let szDecimals = 4;
    let maxLeverage = 20;
    try {
      const meta = await postHl<{ universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> }>({ type: 'meta' });
      const asset = meta?.universe?.find((u) => u.name === coin);
      if (asset) {
        szDecimals = asset.szDecimals;
        if (asset.maxLeverage) maxLeverage = asset.maxLeverage;
      }
    } catch {
      // Fallback
    }

    const detail: ContractDetail = {
      symbol,
      contractSize: 1,
      minVol: Math.pow(10, -szDecimals),
      maxVol: Number.MAX_SAFE_INTEGER,
      priceScale: Math.min(8, Math.max(2, szDecimals + 2)),
      maxLeverage,
    };
    this.setContractCache(symbol, detail);
    return detail;
  }

  /**
   * Fetch OHLCV candles for a symbol from Hyperliquid.
   */
  async candles(symbol: string, interval = 'Min15'): Promise<Candle[]> {
    const key = `${symbol}:${interval}`;
    const now = Date.now();
    const cached = this.candleCache.get(key);
    const ttl = this.getTtlForInterval(interval);
    if (cached && now - cached.at < ttl) return cached.data;

    const existingPromise = this.inFlightCandles.get(key);
    if (existingPromise) return existingPromise;

    const fetchPromise = (async () => {
      try {
        // 1. High-capacity public providers (Binance Futures -> Bybit) to eliminate Hyperliquid rate limits
        const binanceData = await fetchBinanceCandles(symbol, interval);
        if (binanceData && binanceData.length >= 20) {
          this.setCandleCache(key, { at: Date.now(), data: binanceData });
          return binanceData;
        }

        const bybitData = await fetchBybitCandles(symbol, interval);
        if (bybitData && bybitData.length >= 20) {
          this.setCandleCache(key, { at: Date.now(), data: bybitData });
          return bybitData;
        }

        // 2. Fallback to native Hyperliquid L1 candleSnapshot for exclusive coins
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

        if (data.length) {
          this.setCandleCache(key, { at: Date.now(), data });
          return data;
        }

        if (cached && cached.data.length) return cached.data;
        return data;
      } catch (err) {
        if (cached && cached.data.length) return cached.data;
        throw err;
      } finally {
        this.inFlightCandles.delete(key);
      }
    })();

    this.inFlightCandles.set(key, fetchPromise);
    return fetchPromise;
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
}