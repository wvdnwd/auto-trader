import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { MarketData } from './market-data.js';
import type { TradingService } from './trading-service.js';

function loadEnv(): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...parts] = trimmed.split('=');
      const value = parts.join('=').trim().replace(/^["'](.*)["']$/, '$1');
      if (key && !process.env[key.trim()]) process.env[key.trim()] = value;
    }
  } catch {
    // Missing configuration falls back to safe defaults.
  }
  if (!process.env.MONGO_URL && !process.env.ALLOW_IN_MEMORY_STORE) {
    process.env.ALLOW_IN_MEMORY_STORE = 'true';
  }
  if (!process.env.AUTOSTART) {
    process.env.AUTOSTART = 'true';
  }
}

/** Require a fixed-length, constant-time comparison for the configured token. */
export function createApiAuthMiddleware(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' && req.path === '/health') {
      next();
      return;
    }
    if (!token) {
      next();
      return;
    }
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
    if (!match) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }
    const expected = createHash('sha256').update(token, 'utf8').digest();
    const supplied = createHash('sha256').update(match[1], 'utf8').digest();
    if (!timingSafeEqual(expected, supplied)) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    next();
  };
}

function serviceFor(res: Response): TradingService {
  return res.locals.service as TradingService;
}

/**
 * Start the trading service HTTP API.
 *
 * Exposes a single-instance API protected by `TRADER_API_TOKEN` (when configured).
 *
 * @returns the running server handle.
 */
export function run() {
  loadEnv();
  if (process.env.LIVE_TRADING_ENABLED !== 'true') {
    process.env.LIVE_TRADING_ENABLED = 'false';
  }
  const app = express();

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && req.path === '/health') {
      res.json({ ok: true });
      return;
    }
    next();
  });

  const apiToken = process.env.TRADER_API_TOKEN?.trim() || undefined;
  app.use(createApiAuthMiddleware(apiToken));
  app.use(express.json());
  const serviceReady: Promise<TradingService> = import('./trading-service.js').then(async ({ TradingService: Service }) => {
    const service = Service.from(new MarketData());
    await service.init(process.env.AUTOSTART !== 'false');
    return service;
  });
  void serviceReady.catch((err: unknown) => {
    console.error(
      '[trading-service] initialization failed; API remains unavailable:',
      err instanceof Error ? err.name : 'unknown error'
    );
  });
  app.use(async (_req: Request, res: Response, next: NextFunction) => {
    if (!serviceReady) {
      res.status(503).json({ error: 'Trading service is unavailable' });
      return;
    }
    try {
      const service = await serviceReady;
      if (!service.isStorageHealthy()) {
        res.status(503).json({ error: 'Trading storage is unavailable' });
        return;
      }
      res.locals.service = service;
      next();
    } catch {
      res.status(503).json({ error: 'Trading service is unavailable' });
    }
  });

  app.get('/snapshot', async (_req, res) => {
    try {
      res.json(await serviceFor(res).snapshot());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/engine/start', (_req, res) => {
    try {
      serviceFor(res).start();
      res.json({ running: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/engine/stop', (_req, res) => {
    serviceFor(res).stop();
    res.json({ running: false });
  });

  app.post('/engine/cycle', async (_req, res) => {
    try {
      await serviceFor(res).runOnce();
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/risk', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid risk payload' });
      return;
    }
    res.json(serviceFor(res).updateRisk(body));
  });

  app.post('/positions/:id/close', async (req, res) => {
    try {
      const closed = await serviceFor(res).closePosition(req.params.id);
      res.status(closed ? 200 : 404).json({ closed });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/positions/:id/reduce', async (req, res) => {
    try {
      const fraction = typeof req.body?.fraction === 'number' ? req.body.fraction : 0.5;
      const reduced = await serviceFor(res).reducePosition(req.params.id, fraction);
      res.status(reduced ? 200 : 404).json({ reduced });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.get('/markets', async (_req, res) => {
    try {
      res.json({ markets: await serviceFor(res).markets(40) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/exchange', (_req, res) => {
    res.json(serviceFor(res).exchangeStatus());
  });

  app.post('/exchange/toggle', async (req, res) => {
    const { armed } = req.body || {};
    if (typeof armed !== 'boolean') {
      res.status(400).json({ error: 'armed (boolean) required' });
      return;
    }
    try {
      res.json(await serviceFor(res).setLiveTrading(armed));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post('/exchange/credentials', async (req, res) => {
    const { apiKey, apiSecret } = req.body || {};
    if (typeof apiKey !== 'string' || typeof apiSecret !== 'string') {
      res.status(400).json({ error: 'apiKey (string) and apiSecret (string) required' });
      return;
    }
    try {
      res.json(await serviceFor(res).saveExchangeCredentials(apiKey.trim(), apiSecret.trim()));
    } catch {
      res.status(503).json({ error: 'Credential storage is unavailable' });
    }
  });

  app.post('/exchange/test-order', (_req, res) => {
    res.status(409).json({ error: 'Exchange order probes are disabled' });
  });

  app.post('/exchange/positions/:symbol/close', (_req, res) => {
    res.status(409).json({ error: 'Exchange position mutations are disabled' });
  });

  app.get('/chart/:symbol', async (req, res) => {
    try {
      const interval = typeof req.query.interval === 'string' ? req.query.interval : 'Min60';
      res.json(await serviceFor(res).chartData(req.params.symbol, interval));
    } catch (err) {
      res.json({
        symbol: req.params.symbol,
        entryInterval: typeof req.query.interval === 'string' ? req.query.interval : 'Min60',
        confirmInterval: 'Hour4',
        candles: [],
        higherCandles: [],
        signal: null,
        error: (err as Error).message,
      });
    }
  });

  app.post('/backtest', (req, res) => {
    try {
      res.json(serviceFor(res).startBacktest(req.body || {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/backtest', (_req, res) => {
    res.json(serviceFor(res).backtestStatus());
  });

  app.post('/walk-forward', (req, res) => {
    try {
      const { risk, ...config } = req.body || {};
      res.json(serviceFor(res).startWalkForward(config, risk));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/walk-forward', (_req, res) => {
    res.json(serviceFor(res).walkForwardStatus());
  });

  app.post('/optimize', (req, res) => {
    try {
      res.json(serviceFor(res).startOptimize(req.body || {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/optimize', (_req, res) => {
    res.json(serviceFor(res).optimizeStatus());
  });

  app.post('/optimize/apply', (_req, res) => {
    try {
      res.json({ risk: serviceFor(res).applyBestParams() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/simulate', (_req, res) => {
    res.status(409).json({ error: 'Price simulation is disabled on the trading service' });
  });

  app.post('/scout/:symbol/approve', async (req, res) => {
    try {
      const ok = await serviceFor(res).approveScoutCandidate(req.params.symbol);
      res.status(ok ? 200 : 404).json({ approved: ok });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/scout/:symbol/dismiss', async (req, res) => {
    try {
      const ok = await serviceFor(res).dismissScoutCandidate(req.params.symbol);
      res.status(ok ? 200 : 404).json({ dismissed: ok });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/reset', async (_req, res) => {
    try {
      await serviceFor(res).reset();
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`🤖  Trading service ready at http://${host === '0.0.0.0' ? '0.0.0.0' : host}:${port}`);
  });

  return {
    port,
    stop: async () => {
      const service = await serviceReady?.catch(() => null);
      service?.shutdown();
      server.closeAllConnections();
      server.close();
    },
  };
}
