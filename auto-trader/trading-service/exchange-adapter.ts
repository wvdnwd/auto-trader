import { createHash, createHmac } from 'node:crypto';
import type { Side } from './types.js';

/**
 * MEXC contract API strictly limits `externalOid` to 32 characters (alphanumeric, dashes, underscores).
 * UUIDs (36 characters) and appended tags (e.g. `${uuid}-stop`) trigger MEXC rejection:
 * "External order ID too long (max. 32 digit)".
 * When an ID exceeds 32 characters or has non-permitted characters, hash it to a 32-character hex string.
 */
export function sanitizeExternalOid(oid?: string): string | undefined {
  if (!oid) return undefined;
  if (oid.length <= 32 && /^[a-zA-Z0-9_-]+$/.test(oid)) {
    return oid;
  }
  return createHash('md5').update(oid).digest('hex');
}

/** Private (signed) API root — separate from the public `/contract` root used by {@link MarketData}. */
const PRIVATE_BASE = process.env.MEXC_PRIVATE_API_BASE || 'https://contract.mexc.com/api/v1/private';

/**
 * Margin mode for an order.
 *
 * Isolated is the default here because the engine already computes a dedicated
 * margin per position — that is an isolated-margin mental model, and mirroring
 * it on the exchange keeps one position's liquidation from touching any other.
 */
export type OpenType = 'isolated' | 'cross';

/**
 * Order intent, translated to the venue's numeric `side` code.
 *
 * `OPEN_LONG` / `OPEN_SHORT` start a new position; `CLOSE_LONG` / `CLOSE_SHORT`
 * reduce or exit an existing one. Kept as an explicit union — mixing this up
 * with the plain {@link Side} would silently reverse a close into an open.
 */
export type OrderIntent = 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT';

/** Parameters for placing a market order. */
export type PlaceOrderInput = {
  /** Contract symbol, e.g. `BTC_USDT`. */
  symbol: string;
  intent: OrderIntent;
  /** Order size in contracts/volume, as required by the venue. */
  vol: number;
  leverage: number;
  openType?: OpenType;
  /** Client order id, echoed back by the venue — useful to reconcile fills against a paper position id. */
  externalOid?: string;
  /** Optional stop-loss price attached to the order itself. */
  stopLossPrice?: number;
  /** Optional take-profit price attached to the order itself. */
  takeProfitPrice?: number;
};

/** Parameters for closing an existing position at market. */
export type ClosePositionInput = {
  symbol: string;
  /** The side of the position being closed — the adapter derives the correct closing intent. */
  side: Side;
  vol: number;
  externalOid?: string;
};

/** Result of a submitted order. */
export type ExchangeOrderResult = {
  orderId: string;
  symbol: string;
};

/** Parameters for a resting, broker-side protective stop (trigger) order. */
export type PlaceStopOrderInput = {
  symbol: string;
  /** The side of the position being protected — the adapter derives the correct closing intent. */
  side: Side;
  /** Size to close if triggered, in contracts/volume. */
  vol: number;
  /** Trigger price — the stop level. */
  triggerPrice: number;
  externalOid?: string;
};

/** One open position as reported by the venue. */
export type ExchangePosition = {
  symbol: string;
  side: Side;
  vol: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  unrealisedPnl: number;
  createTime?: number;
};

/** One asset balance as reported by the venue. */
export type ExchangeAccountAsset = {
  currency: string;
  equity: number;
  available: number;
  frozen: number;
};

/** Credential readiness and the fail-closed live execution state. */
export type LiveTradingStatus = {
  /** True when both API credentials are present. */
  configured: boolean;
  /** True when live trading is armed and enabled. */
  enabled: boolean;
  baseUrl: string;
  executionDisabledReason?: string;
  venue?: ExchangeVenue;
};

export const LIVE_EXECUTION_DISABLED_REASON =
  'Live execution disabled: the adapter exposes order acknowledgements, not confirmed fills; reconcile an execution ledger before re-arming.';

export type ExchangeVenue = 'mexc' | 'hyperliquid';

export interface IExchangeAdapter {
  readonly venue: ExchangeVenue;
  isConfigured(): boolean;
  status(): LiveTradingStatus;
  getAccountAssets(): Promise<ExchangeAccountAsset[]>;
  getOpenPositions(): Promise<ExchangePosition[]>;
  placeMarketOrder(input: PlaceOrderInput): Promise<ExchangeOrderResult>;
  closePosition(input: ClosePositionInput): Promise<ExchangeOrderResult>;
  placeStopOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult>;
  placeTakeProfitOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  cancelStopOrder(orderId: string, symbol?: string): Promise<void>;
  cancelPlanOrders(orders: Array<{ symbol: string; orderId: string }>): Promise<void>;
  cancelAllPlanOrders(symbol?: string): Promise<void>;
  setLeverage(symbol: string, leverage: number, side: Side, openType?: OpenType): Promise<void>;
  getOpenPlanOrders(symbol?: string): Promise<
    Array<{
      id: string;
      symbol: string;
      side: number;
      triggerType: number;
      triggerPrice: number;
      vol: number;
      createTime: number;
    }>
  >;
}

const INTENT_SIDE: Record<OrderIntent, 1 | 2 | 3 | 4> = {
  OPEN_LONG: 1,
  CLOSE_SHORT: 2,
  OPEN_SHORT: 3,
  CLOSE_LONG: 4,
};

const OPEN_TYPE_CODE: Record<OpenType, 1 | 2> = { isolated: 1, cross: 2 };

/** MEXC's numeric position-side code, required alongside `symbol`/`openType` on `change_leverage`. */
const POSITION_TYPE_CODE: Record<Side, 1 | 2> = { LONG: 1, SHORT: 2 };

/** Market order type code for the venue's `order/submit` endpoint. */
const ORDER_TYPE_MARKET = 5;

/**
 * Sign a request the way MEXC's futures API expects.
 *
 * The venue hashes `accessKey + timestamp + payload` with HMAC-SHA256 using the
 * secret key, where `payload` is the sorted query string for a GET request or
 * the compact JSON body for a POST. Exported so the exact bytes being signed
 * can be unit tested without a live key.
 *
 * @param accessKey the API key.
 * @param secretKey the API secret.
 * @param timestamp unix milliseconds, must match the `Request-Time` header sent.
 * @param payload the query string (GET) or JSON body (POST) being signed.
 * @returns lowercase hex HMAC-SHA256 signature.
 */
export function signRequest(
  accessKey: string,
  secretKey: string,
  timestamp: number,
  payload: string
): string {
  return createHmac('sha256', secretKey).update(`${accessKey}${timestamp}${payload}`).digest('hex');
}

/**
 * Build the sorted query string MEXC signs for a GET request.
 *
 * @param params query parameters.
 * @returns `key=value` pairs joined by `&`, keys sorted ascending.
 */
export function toSortedQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Whether MEXC API credentials are configured, from either source.
 *
 * Credentials entered from the dashboard (passed in as `stored`) take
 * priority over the `MEXC_API_KEY` / `MEXC_API_SECRET` environment variables,
 * so a shared deployment can be handed to someone else and they connect their
 * own MEXC account from the UI without touching the hosting environment.
 *
 * @param stored credentials read from the database, if any.
 * @returns true when an API key and secret are available from either source.
 */
export function hasExchangeCredentials(stored?: { apiKey?: string; apiSecret?: string }): boolean {
  if (stored?.apiKey && stored?.apiSecret) return true;
  return Boolean(process.env.MEXC_API_KEY && process.env.MEXC_API_SECRET);
}

/**
 * Whether the deployment is armed to send real orders. This remains false
 * regardless of credentials or legacy environment flags until fills can be
 * positively reconciled.
 *
 * @param stored credentials read from the database, if any.
 * @returns false until confirmed-fill reconciliation is available.
 */
export function isLiveTradingEnabled(stored?: { apiKey?: string; apiSecret?: string }): boolean {
  return hasExchangeCredentials(stored) && process.env.LIVE_TRADING_ENABLED === 'true';
}

/**
 * Thin client for MEXC's private futures API — venue reads plus guarded order
 * methods that remain disabled pending confirmed-fill reconciliation.
 *
 * Venue reads remain available to show and reconcile existing positions.
 * Every order, leverage, or cancellation method fails before network I/O until
 * acknowledgements can be reconciled to confirmed fills.
 *
 * Endpoint shapes follow MEXC's documented v1 contract private API as of this
 * writing. Exchange APIs change; re-verify request/response shapes before
 * implementing a future confirmed-fill execution ledger.
 */
export class MexcExchangeAdapter implements IExchangeAdapter {
  readonly venue: ExchangeVenue = 'mexc';
  constructor(
    private apiKey = process.env.MEXC_API_KEY || '',
    private apiSecret = process.env.MEXC_API_SECRET || '',
    private readonly baseUrl = PRIVATE_BASE
  ) {}

  /**
   * Replace the credentials this instance signs requests with.
   *
   * Called after someone pastes their own MEXC API key and secret into the
   * dashboard, so the running service switches to their account immediately
   * — no restart or environment variable change required. Passing empty
   * strings clears the credentials and drops the deployment back to
   * unconfigured (and therefore paper-only).
   *
   * @param apiKey the MEXC API key, or '' to clear.
   * @param apiSecret the MEXC API secret, or '' to clear.
   */
  setCredentials(apiKey: string, apiSecret: string): void {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  /** Whether both API credentials were provided to this instance. */
  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /** Live-trading readiness for this instance, safe to expose to the dashboard. */
  status(): LiveTradingStatus {
    const enabled = this.isConfigured() && process.env.LIVE_TRADING_ENABLED === 'true';
    return {
      configured: this.isConfigured(),
      enabled,
      baseUrl: this.baseUrl,
      executionDisabledReason: enabled ? undefined : LIVE_EXECUTION_DISABLED_REASON,
      venue: this.venue,
    };
  }

  /**
   * Place a market order to open or close a position.
   *
   * @param input order parameters.
   * @returns the venue-assigned order id.
   */
  async placeMarketOrder(input: PlaceOrderInput): Promise<ExchangeOrderResult> {
    this.assertExecutionEnabled();
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      vol: input.vol,
      leverage: input.leverage,
      side: INTENT_SIDE[input.intent],
      type: ORDER_TYPE_MARKET,
      openType: OPEN_TYPE_CODE[input.openType || 'isolated'],
    };
    if (input.externalOid) body.externalOid = sanitizeExternalOid(input.externalOid);
    if (input.stopLossPrice) {
      body.stopLossPrice = input.stopLossPrice;
      body.lossTrend = 1;
    }
    if (input.takeProfitPrice) {
      body.takeProfitPrice = input.takeProfitPrice;
      body.profitTrend = 1;
    }

    // `order/submit`'s `data` is the bare order id (e.g. `855266738370550300`),
    // not an `{ orderId }` object — reading `.orderId` off a number always gave
    // `undefined`, which every caller then rendered as the literal string
    // "undefined" instead of the real id.
    const data = await this.post<string | number>('/order/submit', body);
    return { orderId: String(data), symbol: input.symbol };
  }

  /**
   * Close an existing position at market.
   *
   * @param input the position to close and the size to reduce it by.
   * @returns the venue-assigned order id.
   */
  async closePosition(input: ClosePositionInput): Promise<ExchangeOrderResult> {
    this.assertExecutionEnabled();
    return this.placeMarketOrder({
      symbol: input.symbol,
      vol: input.vol,
      // Leverage is ignored by the venue on a closing order — required by the
      // request shape only, so this value is inert.
      leverage: 1,
      intent: input.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
      externalOid: input.externalOid,
    });
  }

  /**
   * Cancel a resting order.
   *
   * @param orderId the venue order id to cancel.
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.assertExecutionEnabled();
    await this.post('/order/cancel', [orderId]);
  }

  /**
   * Place a resting, broker-side protective stop ("trigger") order that closes
   * the position at market once the trigger price is touched.
   *
   * This is the durable stop-loss for a live position: it lives on MEXC's
   * servers, not in this process's memory, so the position stays protected
   * through a crash, a restart, or a network outage on this end. The engine
   * replaces this order (cancel + re-place) every time the paper stop moves —
   * to break-even after TP1, then as the trailing stop follows price.
   *
   * @param input symbol, side, size and trigger price.
   * @returns the venue-assigned trigger order id.
   */
  async placeStopOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult> {
    this.assertExecutionEnabled();
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      vol: input.vol,
      side: INTENT_SIDE[input.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT'],
      openType: OPEN_TYPE_CODE.isolated,
      triggerPrice: input.triggerPrice,
      // 1 = trigger when price rises >= triggerPrice (e.g. short stop loss)
      // 2 = trigger when price drops <= triggerPrice (e.g. long stop loss)
      triggerType: input.side === 'LONG' ? 2 : 1,
      // Execute as a market order once triggered (orderType: 5), valid for 7 days (executeCycle: 2)
      executeCycle: 2,
      orderType: 5,
      trend: 1,
      // Reduce-only: this order can only ever shrink or close the position, so
      // a stale/duplicate trigger can never accidentally open a new one.
      reduceOnly: true,
    };
    if (input.externalOid) body.externalOid = sanitizeExternalOid(input.externalOid);
    const data = await this.post<string | number>('/planorder/place', body);
    return { orderId: String(data), symbol: input.symbol };
  }

  /**
   * Place a resting broker-side take-profit trigger order that closes part or
   * all of the position once the target price is reached.
   *
   * @param input symbol, side, volume and target trigger price.
   * @returns venue-assigned order id.
   */
  async placeTakeProfitOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult> {
    this.assertExecutionEnabled();
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      vol: input.vol,
      side: INTENT_SIDE[input.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT'],
      openType: OPEN_TYPE_CODE.isolated,
      triggerPrice: input.triggerPrice,
      // 1 = trigger when price rises >= triggerPrice (e.g. long take profit)
      // 2 = trigger when price drops <= triggerPrice (e.g. short take profit)
      triggerType: input.side === 'LONG' ? 1 : 2,
      executeCycle: 2,
      orderType: 5,
      trend: 1,
      reduceOnly: true,
    };
    if (input.externalOid) body.externalOid = sanitizeExternalOid(input.externalOid);
    const data = await this.post<string | number>('/planorder/place', body);
    return { orderId: String(data), symbol: input.symbol };
  }

  /**
   * Cancel a resting protective trigger order placed by {@link placeStopOrder}.
   *
   * Safe to call for an order that has already triggered or was already
   * cancelled — MEXC returns an error in that case, and this method swallows
   * it, since the desired end state (no resting trigger left) is already true.
   *
   * @param orderId the trigger order id to cancel.
   * @param symbol optional symbol; MEXC requires { symbol, orderId } in the array payload.
   */
  async cancelStopOrder(orderId: string, symbol?: string): Promise<void> {
    this.assertExecutionEnabled();
    try {
      const payload = symbol ? [{ symbol, orderId }] : [{ orderId }];
      await this.post('/planorder/cancel', payload, false);
    } catch {
      // Already gone (triggered or cancelled) — nothing left to do.
    }
  }

  /**
   * Cancel a batch of resting plan orders on MEXC.
   *
   * @param orders array of objects containing symbol and orderId.
   */
  async cancelPlanOrders(orders: Array<{ symbol: string; orderId: string }>): Promise<void> {
    this.assertExecutionEnabled();
    if (!orders.length) return;
    try {
      const batchSize = 20;
      for (let i = 0; i < orders.length; i += batchSize) {
        await this.post('/planorder/cancel', orders.slice(i, i + batchSize), false);
      }
    } catch {
      // Already clean or triggered — nothing left to cancel.
    }
  }

  /**
   * Fetch active/open plan orders currently resting on MEXC.
   *
   * @param symbol optional symbol filter.
   */
  async getOpenPlanOrders(symbol?: string): Promise<
    Array<{
      id: string;
      symbol: string;
      side: number;
      triggerType: number;
      triggerPrice: number;
      vol: number;
      createTime: number;
    }>
  > {
    const raw = await this.get<
      Array<{
        id: string | number;
        symbol: string;
        side: number;
        triggerType: number;
        triggerPrice: number;
        vol: number;
        createTime: number;
      }>
    >('/planorder/list/orders', {
      page_num: 1,
      page_size: 100,
      states: '1',
      ...(symbol ? { symbol } : {}),
    });
    return (raw || []).map((o) => ({
      id: String(o.id),
      symbol: o.symbol,
      side: Number(o.side),
      triggerType: Number(o.triggerType),
      triggerPrice: Number(o.triggerPrice),
      vol: Number(o.vol),
      createTime: Number(o.createTime),
    }));
  }

  /**
   * Cancel all open plan/trigger orders, optionally filtered by symbol.
   */
  async cancelAllPlanOrders(symbol?: string): Promise<void> {
    this.assertExecutionEnabled();
    try {
      await this.post('/planorder/cancel_all', symbol ? { symbol } : {}, false);
    } catch {
      // Already clean — nothing left to cancel.
    }
  }

  /**
   * Set the leverage used for a symbol's isolated position.
   *
   * MEXC's `change_leverage` endpoint accepts either a `positionId` (for an
   * existing position) or the trio `symbol` + `openType` + `positionType` (to
   * set leverage before a position exists, which is the only case this engine
   * ever hits — leverage is always set right before the opening order). Omitting
   * `positionType` leaves the venue unable to resolve either branch, which it
   * reports back as "Params [positionId] and [symbol] can't be null at the same
   * time" even though `symbol` was provided.
   *
   * @param symbol contract symbol.
   * @param leverage desired leverage.
   * @param side the position side leverage is being set for.
   * @param openType margin mode, defaults to isolated.
   */
  async setLeverage(symbol: string, leverage: number, side: Side, openType: OpenType = 'isolated'): Promise<void> {
    this.assertExecutionEnabled();
    await this.post(
      '/position/change_leverage',
      {
        symbol,
        leverage,
        openType: OPEN_TYPE_CODE[openType],
        positionType: POSITION_TYPE_CODE[side],
      },
      false
    );
  }

  /**
   * Fetch every currently open position on the account.
   *
   * @returns open positions, venue-reported.
   */
  async getOpenPositions(): Promise<ExchangePosition[]> {
    const raw = await this.get<
      {
        symbol: string;
        positionType: 1 | 2;
        holdVol: number;
        leverage: number;
        holdAvgPrice: number;
        liquidatePrice: number;
        unRealizedPnl?: number;
        unrealised?: number;
        createTime?: number;
        cTime?: number;
        openTime?: number;
        updateTime?: number;
      }[]
    >('/position/open_positions', {});
    return raw.map((p) => ({
      symbol: p.symbol,
      side: p.positionType === 1 ? 'LONG' : 'SHORT',
      vol: p.holdVol,
      leverage: p.leverage,
      entryPrice: p.holdAvgPrice,
      liquidationPrice: p.liquidatePrice,
      unrealisedPnl: p.unRealizedPnl ?? p.unrealised ?? 0,
      createTime: p.createTime ?? p.cTime ?? p.openTime ?? p.updateTime,
    }));
  }

  /**
   * Fetch account balances across all held currencies.
   *
   * @returns per-currency equity, available and frozen balances.
   */
  async getAccountAssets(): Promise<ExchangeAccountAsset[]> {
    const raw = await this.get<
      { currency: string; equity: number; availableBalance: number; frozenBalance: number }[]
    >('/account/assets', {});
    return raw.map((a) => ({
      currency: a.currency,
      equity: a.equity,
      available: a.availableBalance,
      frozen: a.frozenBalance,
    }));
  }

  private assertExecutionEnabled(): void {
    if (!this.isConfigured() || process.env.LIVE_TRADING_ENABLED !== 'true') {
      throw new Error(LIVE_EXECUTION_DISABLED_REASON);
    }
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const query = toSortedQuery(params);
    const timestamp = Date.now();
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    return this.send<T>(url, 'GET', this.headers(timestamp, query));
  }

  private async post<T>(path: string, body: unknown, requireData = true): Promise<T> {
    const payload = JSON.stringify(body);
    const timestamp = Date.now();
    const url = `${this.baseUrl}${path}`;
    return this.send<T>(url, 'POST', this.headers(timestamp, payload), payload, requireData);
  }

  private headers(timestamp: number, payload: string): Record<string, string> {
    if (!this.isConfigured()) {
      throw new Error('MEXC-adapter niet geconfigureerd — MEXC_API_KEY en MEXC_API_SECRET ontbreken');
    }
    return {
      ApiKey: this.apiKey,
      'Request-Time': String(timestamp),
      Signature: signRequest(this.apiKey, this.apiSecret, timestamp, payload),
      'Content-Type': 'application/json',
    };
  }

  private async send<T>(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body?: string,
    requireData = true,
    retries = 1
  ): Promise<T> {
    const res = await fetch(url, { method, headers, body });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; code?: number; message?: string; data?: T }
      | null;
    if (!res.ok || !json || json.success === false) {
      const detail = json?.message || `${res.status} ${res.statusText}`;
      if (retries > 0 && (res.status === 429 || detail.toLowerCase().includes('frequent'))) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const newTimestamp = Date.now();
        const payload = method === 'GET' ? (url.split('?')[1] || '') : (body || '');
        const newHeaders = this.headers(newTimestamp, payload);
        return this.send<T>(url, method, newHeaders, body, requireData, retries - 1);
      }
      throw new Error(`MEXC-order mislukt: ${detail}`);
    }
    // Settings-style endpoints (e.g. change_leverage) confirm success without
    // echoing a `data` payload back — there is nothing to return for a value
    // that was just set, so `success: true` alone is the meaningful signal.
    // Endpoints that DO return a resource (an order id, a position list) still
    // require `data` to be present, since a missing payload there means the
    // response cannot be trusted even though the HTTP call itself succeeded.
    if (requireData && json.data === undefined) throw new Error('MEXC-antwoord bevatte geen data');
    return json.data as T;
  }
}
