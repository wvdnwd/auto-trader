import { describe, expect, it } from 'vitest';
import {
  MexcExchangeAdapter,
  LIVE_EXECUTION_DISABLED_REASON,
  hasExchangeCredentials,
  isLiveTradingEnabled,
  sanitizeExternalOid,
  signRequest,
  toSortedQuery,
} from './exchange-adapter.js';

describe('sanitizeExternalOid', () => {
  it('returns undefined if no oid is provided', () => {
    expect(sanitizeExternalOid(undefined)).toBeUndefined();
  });

  it('keeps valid alphanumeric identifiers within 32 chars', () => {
    expect(sanitizeExternalOid('order_12345')).toBe('order_12345');
    expect(sanitizeExternalOid('custom-id-99')).toBe('custom-id-99');
  });

  it('hashes IDs longer than 32 characters (e.g. UUID) into a 32-char hex string', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // 36 chars
    const sanitized = sanitizeExternalOid(uuid);
    expect(sanitized).toBeDefined();
    expect(sanitized?.length).toBe(32);
    expect(sanitized).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces distinct 32-char outputs for different composite IDs', () => {
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const main = sanitizeExternalOid(uuid);
    const stop = sanitizeExternalOid(`${uuid}-stop`);
    expect(main).not.toBe(stop);
    expect(main?.length).toBe(32);
    expect(stop?.length).toBe(32);
  });
});

describe('toSortedQuery', () => {
  it('sorts keys ascending regardless of input order', () => {
    expect(toSortedQuery({ symbol: 'BTC_USDT', vol: 1, leverage: 8 })).toBe(
      'leverage=8&symbol=BTC_USDT&vol=1'
    );
  });

  it('drops undefined values', () => {
    expect(toSortedQuery({ a: 1, b: undefined })).toBe('a=1');
  });
});

describe('signRequest', () => {
  it('produces a deterministic HMAC-SHA256 hex signature', () => {
    const sig = signRequest('key', 'secret', 1_700_000_000_000, 'a=1&b=2');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs must always produce the same signature — the venue verifies
    // the request by recomputing this exact hash.
    expect(signRequest('key', 'secret', 1_700_000_000_000, 'a=1&b=2')).toBe(sig);
  });

  it('changes when any input changes', () => {
    const base = signRequest('key', 'secret', 1_700_000_000_000, 'a=1');
    expect(signRequest('key', 'other-secret', 1_700_000_000_000, 'a=1')).not.toBe(base);
    expect(signRequest('key', 'secret', 1_700_000_000_001, 'a=1')).not.toBe(base);
  });
});

describe('credential and go-live gating', () => {
  it('recognizes supplied credentials without allowing live execution', () => {
    const supplied = { apiKey: 'test-key', apiSecret: 'test-secret' };
    expect(hasExchangeCredentials(supplied)).toBe(true);
    expect(isLiveTradingEnabled(supplied)).toBe(false);
  });

  it('does not configure itself without explicit credentials', () => {
    const adapter = new MexcExchangeAdapter('', '');
    expect(adapter.isConfigured()).toBe(false);
    expect(isLiveTradingEnabled()).toBe(false);
  });
});

describe('MexcExchangeAdapter', () => {
  it('reports unconfigured status without credentials', () => {
    const adapter = new MexcExchangeAdapter('', '');
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.status()).toEqual({
      configured: false,
      enabled: false,
      baseUrl: adapter.status().baseUrl,
      executionDisabledReason: LIVE_EXECUTION_DISABLED_REASON,
      venue: 'mexc',
    });
  });

  it('fails closed before signing or sending a request without credentials', async () => {
    const adapter = new MexcExchangeAdapter('', '');
    await expect(
      adapter.placeMarketOrder({ symbol: 'BTC_USDT', intent: 'OPEN_LONG', vol: 1, leverage: 5 })
    ).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
  });

  it('reports configured but never enabled even with supplied credentials', () => {
    const adapter = new MexcExchangeAdapter('key', 'secret');
    expect(adapter.status().configured).toBe(true);
    expect(adapter.status().enabled).toBe(false);
    expect(adapter.status().executionDisabledReason).toBe(LIVE_EXECUTION_DISABLED_REASON);
  });

  it('rejects all order, protection, cancellation, and leverage mutations before network I/O', async () => {
    const adapter = new MexcExchangeAdapter('key', 'secret');
    await expect(adapter.placeMarketOrder({
      symbol: 'BTC_USDT', intent: 'OPEN_LONG', vol: 1, leverage: 5,
    })).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.closePosition({ symbol: 'BTC_USDT', side: 'LONG', vol: 1 }))
      .rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.placeStopOrder({
      symbol: 'BTC_USDT', side: 'LONG', vol: 1, triggerPrice: 1,
    })).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.placeTakeProfitOrder({
      symbol: 'BTC_USDT', side: 'LONG', vol: 1, triggerPrice: 1,
    })).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.cancelOrder('order-id')).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.cancelStopOrder('stop-id', 'BTC_USDT'))
      .rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.cancelPlanOrders([])).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.cancelAllPlanOrders('BTC_USDT')).rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
    await expect(adapter.setLeverage('BTC_USDT', 5, 'LONG'))
      .rejects.toThrow(LIVE_EXECUTION_DISABLED_REASON);
  });
});
