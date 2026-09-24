import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiAuthMiddleware } from './trading-service.app-root.js';

const originalLiveGate = process.env.LIVE_TRADING_ENABLED;
const originalMemoryOptIn = process.env.ALLOW_IN_MEMORY_STORE;

afterEach(() => {
  if (originalLiveGate === undefined) delete process.env.LIVE_TRADING_ENABLED;
  else process.env.LIVE_TRADING_ENABLED = originalLiveGate;
  if (originalMemoryOptIn === undefined) delete process.env.ALLOW_IN_MEMORY_STORE;
  else process.env.ALLOW_IN_MEMORY_STORE = originalMemoryOptIn;
});

function invokeAuth(
  token: string | undefined,
  authorization?: string,
  method = 'GET',
  path = '/snapshot',
  clientId?: string
) {
  const req = {
    method,
    path,
    get: (name: string) => name.toLowerCase() === 'authorization' ? authorization : undefined,
    headers: clientId ? { 'x-client-id': clientId } : {},
  } as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  createApiAuthMiddleware(token)(req, res, next);
  return { res, status, json, next };
}

async function loadTradingService() {
  return import('./trading-service.js');
}

describe('API authentication boundary', () => {
  it('fails closed with 503 when the server token is absent', () => {
    const { status, next } = invokeAuth(undefined, 'Bearer arbitrary');
    expect(status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('requires a bearer token and ignores x-client-id as authentication', () => {
    const { status, next } = invokeAuth('server-secret', undefined, 'GET', '/snapshot', 'main');
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an incorrect bearer token without echoing either token', () => {
    const { status, json, next } = invokeAuth('server-secret', 'Bearer wrong-secret');
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid bearer token' });
    expect(JSON.stringify(json.mock.calls)).not.toContain('server-secret');
    expect(JSON.stringify(json.mock.calls)).not.toContain('wrong-secret');
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the configured bearer token even when a spoofed tenant header is present', () => {
    const { status, next } = invokeAuth('server-secret', 'Bearer server-secret', 'GET', '/snapshot', '..\\other');
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps only GET /health public', () => {
    const health = invokeAuth(undefined, undefined, 'GET', '/health');
    const otherMethod = invokeAuth(undefined, undefined, 'POST', '/health');
    const head = invokeAuth(undefined, undefined, 'HEAD', '/health');
    expect(health.next).toHaveBeenCalledOnce();
    expect(otherMethod.status).toHaveBeenCalledWith(503);
    expect(head.status).toHaveBeenCalledWith(503);
  });
});

describe('paper-only startup', () => {
  it('forces the live gate off at startup and rejects re-arming without configured credentials', async () => {
    const { TradingService } = await loadTradingService();
    process.env.LIVE_TRADING_ENABLED = 'true';
    const store = {
      connect: vi.fn().mockResolvedValue(true),
      addEvent: vi.fn().mockResolvedValue(undefined),
      exchangeCredentials: vi.fn().mockResolvedValue({ apiKey: '', apiSecret: '' }),
      positions: vi.fn().mockResolvedValue([]),
    };
    const engine = { start: vi.fn(), stop: vi.fn() };
    const scout = { init: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    const exchange = {
      isConfigured: vi.fn(() => false),
      setCredentials: vi.fn(),
      status: vi.fn(() => ({ configured: false, enabled: process.env.LIVE_TRADING_ENABLED === 'true', baseUrl: 'fake' })),
    };
    const service = new TradingService(
      store as never,
      engine as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      scout as never,
      exchange as never
    );

    await service.init();
    expect(process.env.LIVE_TRADING_ENABLED).toBe('false');
    expect(engine.start).not.toHaveBeenCalled();
    await expect(service.setLiveTrading(true)).rejects.toThrow(/credentials ontbreken/i);
    expect(process.env.LIVE_TRADING_ENABLED).toBe('false');
    expect(exchange.status().enabled).toBe(false);
  });

  it('blocks autostart and start for a legacy open live position without a tenant id', async () => {
    const { TradingService } = await loadTradingService();
    const store = {
      connect: vi.fn().mockResolvedValue(true),
      addEvent: vi.fn().mockResolvedValue(undefined),
      exchangeCredentials: vi.fn().mockResolvedValue({ apiKey: '', apiSecret: '' }),
      positions: vi.fn().mockResolvedValue([{
        id: 'legacy-live',
        symbol: 'BTC_USDT',
        status: 'OPEN',
        live: true,
      }]),
    };
    const engine = { start: vi.fn(), stop: vi.fn() };
    const scout = { init: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
    const service = new TradingService(
      store as never,
      engine as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      scout as never,
      {} as never
    );

    await service.init(true);
    expect(engine.start).not.toHaveBeenCalled();
    expect(store.positions).toHaveBeenCalledWith('OPEN', 0);
    expect(service.start.bind(service)).toThrow(/unresolved live positions/i);
  });

  it('fails initialization on missing persistent storage without explicit local opt-in', async () => {
    const { TradingService } = await loadTradingService();
    delete process.env.ALLOW_IN_MEMORY_STORE;
    const store = { connect: vi.fn().mockResolvedValue(false) };
    const engine = { start: vi.fn() };
    const service = new TradingService(
      store as never,
      engine as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.init(true)).rejects.toThrow(/persistent storage is required/i);
    expect(engine.start).not.toHaveBeenCalled();
  });
});

describe('chart storage failures', () => {
  it('rejects chart data when the position store is unavailable', async () => {
    const { TradingService } = await loadTradingService();
    const store = { positions: vi.fn().mockRejectedValue(new Error('storage unavailable')) };
    const market = {
      candles: vi.fn().mockResolvedValue([]),
      tickers: vi.fn().mockResolvedValue([]),
      getCachedCandles: vi.fn().mockReturnValue([]),
    };
    const service = new TradingService(
      store as never,
      {} as never,
      market as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.chartData('BTC_USDT')).rejects.toThrow('storage unavailable');
    expect(store.positions).toHaveBeenCalledWith('OPEN');
  });
});
