import type {
  BacktestConfig,
  BacktestStatus,
  ChartData,
  LiveTradingStatus,
  OptimizeStatus,
  RiskConfig,
  Snapshot,
  Ticker,
  WalkForwardStatus,
} from './types.js';

/**
 * Resolve the API base URL.
 *
 * In development the vite server proxies `/trading-service` to the platform
 * gateway, so a same-origin relative path works and avoids CORS entirely. In a
 * production build there is no proxy, so the app talks to the gateway directly
 * through the URL the platform injects as `BACKEND_URL`.
 */
function resolveBase(): string {
  const backend = (process.env.BACKEND_URL || '').replace(/\/$/, '');
  const isDev = Boolean(import.meta.env?.DEV);
  if (!isDev && backend) return `${backend}/trading-service`;
  return '/trading-service';
}

const BASE = resolveBase();

/** Requests time out rather than hanging the dashboard forever. */
const TIMEOUT_MS = 20_000;

/** Where the per-browser client id is persisted. */
const CLIENT_ID_KEY = 'trader-app-client-id';

/**
 * Get (or create) a stable id for this browser, sent as `x-client-id` on
 * every request so the backend can give this visitor their own isolated
 * paper account, MEXC connection and history — letting the dashboard be
 * shared with anyone without touching the deployment owner's account.
 *
 * @returns a persistent client id, unique per browser.
 */
function clientId(): string {
  if (typeof window === 'undefined') return 'main';
  try {
    const urlParam = new URLSearchParams(window.location.search).get('client');
    if (urlParam && urlParam.trim()) return urlParam.trim();
  } catch {
    // Ignore URL parse errors
  }
  let id = window.localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = 'main';
    window.localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-id': clientId() },
      signal: controller.signal,
      ...init,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail ? `${res.status}: ${detail.slice(0, 200)}` : `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('Verzoek verlopen — engine reageert niet');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the full dashboard snapshot from the trading service.
 *
 * @returns account, positions, signals, events and stats.
 */
export function fetchSnapshot(): Promise<Snapshot> {
  return request<Snapshot>('/snapshot');
}

/**
 * Start or stop the autonomous engine loop.
 *
 * @param running desired state.
 */
export function setEngineRunning(running: boolean): Promise<{ running: boolean }> {
  return request(`/engine/${running ? 'start' : 'stop'}`, { method: 'POST' });
}

/** Trigger one engine cycle immediately. */
export function runCycle(): Promise<{ ok: boolean }> {
  return request('/engine/cycle', { method: 'POST' });
}

/**
 * Update risk settings at runtime.
 *
 * @param patch fields to override.
 * @returns the merged configuration.
 */
export function updateRisk(patch: Partial<RiskConfig>): Promise<RiskConfig> {
  return request('/risk', { method: 'POST', body: JSON.stringify(patch) });
}

/**
 * Close an open position at market price.
 *
 * @param id position id.
 */
export function closePosition(id: string): Promise<{ closed: boolean }> {
  return request(`/positions/${id}/close`, { method: 'POST' });
}

/** Reset the paper account and wipe history. */
export function resetAccount(): Promise<{ ok: boolean }> {
  return request('/reset', { method: 'POST' });
}

/**
 * The most liquid markets available, for the backtest market picker.
 *
 * @returns tickers sorted by 24h volume.
 */
export function fetchMarkets(): Promise<{ markets: Ticker[] }> {
  return request('/markets');
}

/**
 * Kick off a historical replay of the strategy.
 *
 * @param config the run parameters.
 * @returns the initial status — poll {@link fetchBacktest} for progress.
 */
export function startBacktest(config: Partial<BacktestConfig>): Promise<BacktestStatus> {
  return request('/backtest', { method: 'POST', body: JSON.stringify(config) });
}

/** Progress and result of the most recent backtest. */
export function fetchBacktest(): Promise<BacktestStatus> {
  return request('/backtest');
}

/**
 * Start a parameter search over historical data.
 *
 * @param config the window and markets to optimise over.
 * @returns the initial status — poll {@link fetchOptimize} for progress.
 */
export function startOptimize(config: Partial<BacktestConfig>): Promise<OptimizeStatus> {
  return request('/optimize', { method: 'POST', body: JSON.stringify(config) });
}

/** Progress and results of the most recent parameter search. */
export function fetchOptimize(): Promise<OptimizeStatus> {
  return request('/optimize');
}

/**
 * Start a walk-forward analysis over many overlapping 300-day windows.
 *
 * @param config the markets and timeframe to evaluate.
 * @returns the initial status — poll {@link fetchWalkForward} for progress.
 */
export function startWalkForward(config: Partial<BacktestConfig>): Promise<WalkForwardStatus> {
  return request('/walk-forward', { method: 'POST', body: JSON.stringify(config) });
}

/** Progress and result of the most recent walk-forward analysis. */
export function fetchWalkForward(): Promise<WalkForwardStatus> {
  return request('/walk-forward');
}

/** Apply the best parameter set found to the live engine. */
export function applyBestParams(): Promise<{ risk: RiskConfig }> {
  return request('/optimize/apply', { method: 'POST' });
}

/**
 * Chart candles and the current signal for one symbol, on the exact
 * timeframes the strategy trades — what a signal card's "Grafiek" button opens.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 */
export function fetchChart(symbol: string, interval = 'Min60'): Promise<ChartData> {
  const query = interval ? `?interval=${encodeURIComponent(interval)}` : '';
  return request(`/chart/${encodeURIComponent(symbol)}${query}`);
}

/**
 * Arm or disarm live MEXC order execution.
 *
 * Rejected by the server when arming is requested without exchange
 * credentials configured — the caller should surface that error rather than
 * assume the toggle always succeeds.
 *
 * @param armed true to switch on live order execution, false to return to paper trading.
 * @returns the resulting live-trading status.
 */
export function setLiveTrading(armed: boolean): Promise<LiveTradingStatus> {
  return request('/exchange/toggle', { method: 'POST', body: JSON.stringify({ armed }) });
}

/**
 * Save (or clear, when passed empty strings) the MEXC API key and secret used
 * for live order execution. Lets anyone running this deployment connect their
 * own MEXC account from the dashboard, without touching server configuration.
 *
 * @param apiKey the MEXC API key, or '' to disconnect.
 * @param apiSecret the MEXC API secret, or '' to disconnect.
 * @returns the resulting live-trading status.
 */
export function saveExchangeCredentials(apiKey: string, apiSecret: string): Promise<LiveTradingStatus> {
  return request('/exchange/credentials', { method: 'POST', body: JSON.stringify({ apiKey, apiSecret }) });
}

/**
 * Approve a market scout candidate, admitting it into the live scanning universe.
 *
 * @param symbol contract symbol awaiting approval.
 */
export function approveScoutCandidate(symbol: string): Promise<{ approved: boolean }> {
  return request(`/scout/${encodeURIComponent(symbol)}/approve`, { method: 'POST' });
}

/**
 * Dismiss a market scout candidate without admitting it.
 *
 * @param symbol contract symbol to dismiss.
 */
export function dismissScoutCandidate(symbol: string): Promise<{ dismissed: boolean }> {
  return request(`/scout/${encodeURIComponent(symbol)}/dismiss`, { method: 'POST' });
}

/** Result of a manual real-order connectivity test against MEXC. */
export type TestOrderResult = {
  orderId: string;
  vol: number;
  price: number;
  tpPrice?: number;
  slPrice?: number;
  closeOrderId: string | null;
};

/**
 * Place a tiny real order on MEXC to verify the connected API key can
 * actually place and fill orders — bypassing the strategy and paper engine.
 * By default the order is opened and immediately closed again at market, so
 * it does not linger as a real position.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 * @param side `LONG` or `SHORT`.
 * @param usdtAmount notional size in USDT, e.g. 1 for a $1 test.
 * @param leverage leverage to open the test order with.
 * @param keepOpen when true, leaves the resulting position open on MEXC.
 * @param tpPct take-profit target in %, default 3.
 * @param slPct stop-loss protection in %, default 2.
 * @returns the opened (and, unless kept open, closing) order ids.
 */
export function placeTestOrder(
  symbol: string,
  side: 'LONG' | 'SHORT',
  usdtAmount: number,
  leverage: number,
  keepOpen = false,
  tpPct = 3,
  slPct = 2
): Promise<TestOrderResult> {
  return request('/exchange/test-order', {
    method: 'POST',
    body: JSON.stringify({ symbol, side, usdtAmount, leverage, keepOpen, tpPct, slPct }),
  });
}

/**
 * Close a live position directly on MEXC.
 */
export function closeExchangePosition(symbol: string): Promise<{ orderId: string; vol: number }> {
  return request(`/exchange/positions/${encodeURIComponent(symbol)}/close`, { method: 'POST' });
}
