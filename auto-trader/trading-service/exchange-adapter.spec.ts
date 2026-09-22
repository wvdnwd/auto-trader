import { describe, expect, it } from 'vitest';
import {
  MexcExchangeAdapter,
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
  it('reports not configured when no env vars are set', () => {
    delete process.env.MEXC_API_KEY;
    delete process.env.MEXC_API_SECRET;
    delete process.env.LIVE_TRADING_ENABLED;
    expect(hasExchangeCredentials()).toBe(false);
    expect(isLiveTradingEnabled()).toBe(false);
  });

  it('requires the explicit go-live flag on top of credentials', () => {
    process.env.MEXC_API_KEY = 'k';
    process.env.MEXC_API_SECRET = 's';
    expect(hasExchangeCredentials()).toBe(true);
    // Credentials alone must never be enough to arm live trading.
    expect(isLiveTradingEnabled()).toBe(false);
    process.env.LIVE_TRADING_ENABLED = 'true';
    expect(isLiveTradingEnabled()).toBe(true);
    delete process.env.MEXC_API_KEY;
    delete process.env.MEXC_API_SECRET;
    delete process.env.LIVE_TRADING_ENABLED;
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
    });
  });

  it('refuses to sign a request without credentials', async () => {
    const adapter = new MexcExchangeAdapter('', '');
    await expect(
      adapter.placeMarketOrder({ symbol: 'BTC_USDT', intent: 'OPEN_LONG', vol: 1, leverage: 5 })
    ).rejects.toThrow(/niet geconfigureerd/);
  });

  it('reports enabled only once both credentials and the go-live flag are set', () => {
    const adapter = new MexcExchangeAdapter('key', 'secret');
    expect(adapter.status().configured).toBe(true);
    expect(adapter.status().enabled).toBe(false);
    process.env.LIVE_TRADING_ENABLED = 'true';
    expect(adapter.status().enabled).toBe(true);
    delete process.env.LIVE_TRADING_ENABLED;
  });
});
