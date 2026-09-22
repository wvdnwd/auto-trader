import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { MarketData } from './market-data.js';
import { TradingService } from './trading-service.js';

function loadEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [k, ...v] = trimmed.split('=');
          const val = v.join('=').trim().replace(/^["'](.*)["']$/, '$1');
          if (k && !process.env[k.trim()]) {
            process.env[k.trim()] = val;
          }
        }
      }
    }
  } catch {
    // ignore
  }
}

loadEnv();

/** Header a client sends to identify itself as a specific tenant. */
const TENANT_HEADER = 'x-client-id';

/**
 * Read the tenant-scoped {@link TradingService} attached to this request by
 * the tenant-resolution middleware below. Kept as a small helper (reading
 * from `res.locals`, already loosely typed by Express) rather than a global
 * `Request` type augmentation, which needs `@types/express-serve-static-core`
 * resolvable at the type-checker's module resolution root.
 */
function serviceFor(res: Response): TradingService {
  return res.locals.service as TradingService;
}

/**
 * Start the trading service HTTP API.
 *
 * Exposes a small REST surface consumed by the dashboard app. Every request
 * is routed to a tenant-scoped {@link TradingService} — identified by the
 * `x-client-id` header the dashboard sends automatically — so a deployment
 * can be shared with anyone: each visitor gets their own paper account,
 * their own MEXC connection, and their own history, completely independent
 * from the deployment owner's (`'main'`) and from each other. Requests with
 * no header (e.g. a raw curl call) fall back to `'main'` for compatibility.
 *
 * @returns the running server handle.
 */
export function run() {
  const app = express();
  app.use(express.json());

  // Market data (tickers, candles, contract specs) carries no user-specific
  // state, so it is fetched once and shared across every tenant — avoids
  // duplicating API calls and caches per visitor for no reason.
  const sharedMarket = new MarketData();
  const services = new Map<string, Promise<TradingService>>();

  function getService(tenantId: string): Promise<TradingService> {
    let pending = services.get(tenantId);
    if (!pending) {
      const service = TradingService.from(tenantId, sharedMarket);
      // The deployment owner's engine autostarts per AUTOSTART like before;
      // a freshly-created tenant for a shared visitor also autostarts by
      // default so their scanner is live immediately, matching what the
      // owner sees.
      pending = service.init(process.env.AUTOSTART !== 'false').then(() => service);
      services.set(tenantId, pending);
    }
    return pending;
  }

  // Pre-warm the deployment owner's service so the engine autostarts
  // immediately on boot (e.g. on a headless Raspberry Pi) without waiting
  // for an incoming browser HTTP request.
  void getService('main');

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header(TENANT_HEADER);
    const tenantId = header && header.trim() ? header.trim().slice(0, 128) : 'main';
    try {
      res.locals.service = await getService(tenantId);
      next();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/snapshot', async (_req, res) => {
    try {
      res.json(await serviceFor(res).snapshot());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/engine/start', (_req, res) => {
    serviceFor(res).start();
    res.json({ running: true });
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
      res.status(500).json({ error: (err as Error).message });
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
      res.status(500).json({ error: (err as Error).message });
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
      res.status(400).json({ error: (err as Error).message });
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
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Manual connectivity check: places (and by default immediately closes) a
  // tiny real order on MEXC so a pasted API key can be proven to work before
  // the autonomous engine is armed.
  app.post('/exchange/test-order', async (req, res) => {
    const { symbol, side, usdtAmount, leverage, keepOpen, tpPct, slPct } = req.body || {};
    if (typeof symbol !== 'string' || !symbol) {
      res.status(400).json({ error: 'symbol (string) required' });
      return;
    }
    try {
      const result = await serviceFor(res).placeTestOrder(
        symbol,
        side === 'SHORT' ? 'SHORT' : 'LONG',
        typeof usdtAmount === 'number' ? usdtAmount : 1,
        typeof leverage === 'number' ? leverage : 5,
        Boolean(keepOpen),
        typeof tpPct === 'number' && tpPct > 0 ? tpPct : 3,
        typeof slPct === 'number' && slPct > 0 ? slPct : 2
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/exchange/positions/:symbol/close', async (req, res) => {
    try {
      const result = await serviceFor(res).flattenExchangePosition(req.params.symbol);
      if (!result) {
        res.status(404).json({ error: `Geen open positie gevonden op MEXC voor ${req.params.symbol}` });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
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

  // Testing aid: move a market to a given price and run exit management.
  app.post('/simulate', async (req, res) => {
    const { symbol, price } = req.body || {};
    if (typeof symbol !== 'string' || typeof price !== 'number') {
      res.status(400).json({ error: 'symbol (string) and price (number) required' });
      return;
    }
    try {
      res.json({ open: await serviceFor(res).simulatePrice(symbol, price) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
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
      res.status(500).json({ error: (err as Error).message });
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
      for (const pending of services.values()) {
        const service = await pending.catch(() => null);
        service?.stop();
      }
      server.closeAllConnections();
      server.close();
    },
  };
}
