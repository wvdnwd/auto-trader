/**
 * Hyperliquid TESTNET smoke test for the live order path.
 *
 * SKIPPED BY DEFAULT. It only runs when every guard below is satisfied, and it
 * refuses to start unless it is provably pointed at Hyperliquid TESTNET.
 *
 * Exact command (PowerShell, from the workspace root):
 *
 *   $env:HL_TESTNET_RUN='1'
 *   $env:HYPERLIQUID_TESTNET='true'
 *   $env:HL_TESTNET_WALLET_ADDRESS='0x<dedicated-testnet-wallet>'
 *   $env:HL_TESTNET_PRIVATE_KEY='0x<dedicated-testnet-private-key>'
 *   # optional: $env:HL_TESTNET_SYMBOL='BTC' (default BTC)
 *   # optional: $env:HL_TESTNET_NOTIONAL_USD='25' (default 25, venue min ~$10)
 *   bit test trading-service
 *
 * Or with a POSIX shell:
 *
 *   HL_TESTNET_RUN=1 HYPERLIQUID_TESTNET=true \
 *   HL_TESTNET_WALLET_ADDRESS=0x... HL_TESTNET_PRIVATE_KEY=0x... \
 *   bit test trading-service
 *
 * Never put real credentials in this file. The suite never prints secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { formatSize } from '@nktkas/hyperliquid/utils';
import { HyperliquidExchangeAdapter, toHyperliquidCloid } from './hyperliquid-adapter.js';
import { normalizeCoin } from './market-data.js';
import type { ExchangePosition } from './exchange-adapter.js';

const RUN = process.env.HL_TESTNET_RUN === '1';
const TESTNET_WALLET = process.env.HL_TESTNET_WALLET_ADDRESS ?? '';
const TESTNET_PRIVATE_KEY = process.env.HL_TESTNET_PRIVATE_KEY ?? '';
const SYMBOL = process.env.HL_TESTNET_SYMBOL || 'BTC';
const NOTIONAL_USD = Number(process.env.HL_TESTNET_NOTIONAL_USD || '25');

/** Hyperliquid rejects orders below ~$10 notional. */
const MIN_NOTIONAL_USD = 10;
/**
 * Fraction of the position each protective order covers. Keeping the two
 * stops at half size avoids stacking more reduce-only size than the position
 * while still exercising the place-before-cancel replacement contract.
 */
const PROTECT_FRACTION = 0.5;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function uniqueOid(tag: string): string {
  return `hl-testnet-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Normalise a credential for equality comparison only (never logged). */
function normalizeSecret(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, '');
}

/**
 * Read only the live Hyperliquid credentials from `.env` so the guards can
 * refuse a testnet run that accidentally reuses them. Values are compared and
 * discarded — they are never returned to callers or written to output.
 */
function readLiveEnvCredentials(): { wallet?: string; privateKey?: string } {
  const candidates = [path.resolve(process.cwd(), '.env')];
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    dir = path.dirname(dir);
    candidates.push(path.resolve(dir, '.env'));
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const found: { wallet?: string; privateKey?: string } = {};
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*(HYPERLIQUID_WALLET|HYPERLIQUID_PRIVATE_KEY)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        const value = match[2].trim().replace(/^["'](.*)["']$/, '$1');
        if (!value) continue;
        if (match[1] === 'HYPERLIQUID_WALLET') found.wallet = value;
        else found.privateKey = value;
      }
      return found;
    } catch {
      // Unreadable .env: fall through to the ambient process.env guards.
    }
  }
  return {};
}

/**
 * Refuse to run unless this is unambiguously a dedicated TESTNET smoke test.
 * Throws with a clear, secret-free message; never runs against mainnet.
 */
function assertTestnetGuards(): void {
  if (process.env.HL_TESTNET_RUN !== '1') {
    throw new Error('Refusing to run: set HL_TESTNET_RUN=1 to opt into the testnet smoke test.');
  }
  if (process.env.HYPERLIQUID_TESTNET !== 'true') {
    throw new Error('Refusing to run: HYPERLIQUID_TESTNET must be exactly "true" (testnet only).');
  }
  if (!TESTNET_WALLET) {
    throw new Error('Refusing to run: HL_TESTNET_WALLET_ADDRESS is required.');
  }
  if (!TESTNET_PRIVATE_KEY) {
    throw new Error('Refusing to run: HL_TESTNET_PRIVATE_KEY is required.');
  }
  if (!Number.isFinite(NOTIONAL_USD) || NOTIONAL_USD < MIN_NOTIONAL_USD) {
    throw new Error(`Refusing to run: HL_TESTNET_NOTIONAL_USD must be a number >= ${MIN_NOTIONAL_USD}.`);
  }

  const live = readLiveEnvCredentials();
  const pairs: Array<[string, string | undefined, string]> = [
    ['.env HYPERLIQUID_WALLET', live.wallet, TESTNET_WALLET],
    ['.env HYPERLIQUID_PRIVATE_KEY', live.privateKey, TESTNET_PRIVATE_KEY],
    ['process.env.HYPERLIQUID_WALLET', process.env.HYPERLIQUID_WALLET, TESTNET_WALLET],
    ['process.env.HYPERLIQUID_PRIVATE_KEY', process.env.HYPERLIQUID_PRIVATE_KEY, TESTNET_PRIVATE_KEY],
  ];
  for (const [label, liveValue, testnetValue] of pairs) {
    if (liveValue && normalizeSecret(liveValue) === normalizeSecret(testnetValue)) {
      throw new Error(`Refusing to run: testnet credential matches the live ${label}; use a dedicated testnet wallet.`);
    }
  }
}

type CapturingOrderParams = { orders?: Array<{ c?: string }> };
type ExchangeClientLike = { order: (params: CapturingOrderParams) => Promise<unknown> };

/**
 * Wrap the adapter's private exchange client so the test can prove a cloid was
 * actually attached to a submission, without altering the adapter's behavior.
 */
function installCloidCapture(adapter: HyperliquidExchangeAdapter, sink: string[]): void {
  const internals = adapter as unknown as { exchangeClient: ExchangeClientLike | null };
  if (!internals.exchangeClient) {
    throw new Error('Hyperliquid exchange client was not initialized; check HL_TESTNET_PRIVATE_KEY.');
  }
  const original = internals.exchangeClient.order.bind(internals.exchangeClient);
  internals.exchangeClient.order = async (params: CapturingOrderParams) => {
    for (const order of params?.orders ?? []) {
      if (typeof order?.c === 'string') sink.push(order.c);
    }
    return original(params);
  };
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  settle: (value: T) => boolean,
  attempts = 12,
  delayMs = 750
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (settle(last)) return last;
    await delay(delayMs);
  }
  throw new Error(`${label} did not settle after ${attempts} attempts (last=${JSON.stringify(last)}).`);
}

describe.skipIf(!RUN)('Hyperliquid TESTNET live order smoke test', () => {
  let adapter: HyperliquidExchangeAdapter;
  let coin = SYMBOL;
  let szDecimals = 0;
  let positionVol = 0;
  const capturedCloids: string[] = [];
  const originalLiveGate = process.env.LIVE_TRADING_ENABLED;

  async function cleanup(): Promise<void> {
    try {
      await adapter.cancelAllPlanOrders(coin);
    } catch (err) {
      console.warn(`[hl-testnet] cleanup: cancelAllPlanOrders failed: ${(err as Error).message}`);
    }
    try {
      const positions = await adapter.getOpenPositions();
      const open = positions.find((p) => p.symbol.startsWith(`${coin}_`));
      if (open && open.vol > 0) {
        await adapter.closePosition({
          symbol: open.symbol,
          side: open.side,
          vol: open.vol,
          externalOid: uniqueOid('cleanup'),
        });
      }
    } catch (err) {
      console.warn(`[hl-testnet] cleanup: closePosition failed: ${(err as Error).message}`);
    }
  }

  beforeAll(async () => {
    assertTestnetGuards();
    process.env.LIVE_TRADING_ENABLED = 'true';
    adapter = new HyperliquidExchangeAdapter(TESTNET_WALLET, TESTNET_PRIVATE_KEY, true);
    const status = adapter.status();
    if (!status.baseUrl.includes('testnet')) {
      throw new Error(`Refusing to run: adapter is not pointed at a testnet URL (${status.baseUrl}).`);
    }
    installCloidCapture(adapter, capturedCloids);
    coin = normalizeCoin(SYMBOL);
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true }) });
    const meta = await info.meta();
    const entry = meta.universe.find((u) => u.name === coin);
    if (!entry) {
      throw new Error(`Coin ${coin} not found in the Hyperliquid testnet perpetual universe.`);
    }
    szDecimals = entry.szDecimals;
    console.log(`[hl-testnet] running against testnet (${status.baseUrl}) for ${coin} (szDecimals=${szDecimals}).`);
  });

  afterAll(async () => {
    if (adapter) await cleanup();
    if (originalLiveGate === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = originalLiveGate;
  });

  // Network-bound: the whole lifecycle can take a minute on a quiet testnet.
  it(
    'exercises assets, book, open, atomic stop replace, TP, close, and ends flat',
    async () => {
      let failure: Error | null = null;
      try {
        // 1. Account assets sanity -------------------------------------------------
        console.log('[hl-testnet] step 1/8: getAccountAssets');
        const assets = await adapter.getAccountAssets();
        const usdc = assets.find((a) => a.currency === 'USDC') ?? assets[0];
        if (!usdc) throw new Error('No USDC account asset returned by the venue.');
        for (const value of [usdc.equity, usdc.available, usdc.frozen]) {
          if (!Number.isFinite(value)) {
            throw new Error(`getAccountAssets returned a non-finite value: ${JSON.stringify(usdc)}.`);
          }
        }
        if (!(usdc.equity > 0)) {
          throw new Error(`getAccountAssets equity must be > 0 for the smoke test, got ${usdc.equity}.`);
        }
        console.log(`[hl-testnet] step 1 ok: equity=${usdc.equity} available=${usdc.available} frozen=${usdc.frozen}`);

        // 2. Best bid/ask sanity ---------------------------------------------------
        console.log('[hl-testnet] step 2/8: getBestBidAsk');
        const book = await adapter.getBestBidAsk(coin);
        if (!book) throw new Error(`No L2 book returned for ${coin}.`);
        if (!Number.isFinite(book.bid) || !Number.isFinite(book.ask)) {
          throw new Error(`getBestBidAsk returned a non-finite touch: ${JSON.stringify(book)}.`);
        }
        if (!(book.bid < book.ask)) {
          throw new Error(`getBestBidAsk expected bid < ask, got bid=${book.bid} ask=${book.ask}.`);
        }
        const mid = (book.bid + book.ask) / 2;
        console.log(`[hl-testnet] step 2 ok: bid=${book.bid} ask=${book.ask}`);

        // Size from a small notional, truncated to the venue lot size.
        let sizeStr: string;
        try {
          sizeStr = formatSize(NOTIONAL_USD / mid, szDecimals);
        } catch (err) {
          throw new Error(
            `Computed size for ${coin} truncated to zero at szDecimals=${szDecimals}; raise HL_TESTNET_NOTIONAL_USD (${NOTIONAL_USD}). ${(err as Error).message}`
          );
        }
        const sizeNum = Number(sizeStr);
        if (!(sizeNum > 0)) throw new Error(`Computed size ${sizeStr} is not positive for ${coin}.`);
        if (sizeNum * mid < MIN_NOTIONAL_USD) {
          throw new Error(
            `Computed notional $${(sizeNum * mid).toFixed(2)} is below the venue minimum $${MIN_NOTIONAL_USD}; raise HL_TESTNET_NOTIONAL_USD.`
          );
        }

        // 3. Market open with a cloid ----------------------------------------------
        console.log('[hl-testnet] step 3/8: placeMarketOrder (OPEN_LONG)');
        const openOid = uniqueOid('open');
        const cloidsBeforeOpen = capturedCloids.length;
        const openedOrder = await adapter.placeMarketOrder({
          symbol: coin,
          intent: 'OPEN_LONG',
          vol: sizeNum,
          leverage: 1,
          openType: 'isolated',
          externalOid: openOid,
        });
        if (!/^\d+$/.test(openedOrder.orderId)) {
          throw new Error(`Expected a numeric venue orderId, got "${openedOrder.orderId}".`);
        }
        const expectedCloid = toHyperliquidCloid(openOid);
        const submittedCloids = capturedCloids.slice(cloidsBeforeOpen);
        if (!expectedCloid || !submittedCloids.includes(expectedCloid)) {
          throw new Error(`Market order was not submitted with the expected cloid ${expectedCloid}.`);
        }
        const positions = await waitFor(
          'open position',
          () => adapter.getOpenPositions(),
          (list: ExchangePosition[]) => list.some((p) => p.symbol.startsWith(`${coin}_`))
        );
        const openPosition = positions.find((p) => p.symbol.startsWith(`${coin}_`));
        if (!openPosition) throw new Error(`Position for ${coin} was not confirmed after the market open.`);
        if (openPosition.side !== 'LONG') {
          throw new Error(`Expected a LONG position after OPEN_LONG, got ${openPosition.side}.`);
        }
        positionVol = openPosition.vol;
        console.log(`[hl-testnet] step 3 ok: orderId=${openedOrder.orderId} cloid=${expectedCloid} vol=${positionVol}`);

        const protectVol = Number(formatSize(positionVol * PROTECT_FRACTION, szDecimals));
        if (!(protectVol > 0)) throw new Error(`Protective size rounded to zero for ${coin}.`);
        if (protectVol * mid < MIN_NOTIONAL_USD) {
          throw new Error(
            `Protective notional $${(protectVol * mid).toFixed(2)} is below the venue minimum $${MIN_NOTIONAL_USD}; raise HL_TESTNET_NOTIONAL_USD.`
          );
        }

        // 4. Protective stop --------------------------------------------------------
        console.log('[hl-testnet] step 4/8: placeStopOrder');
        const stop1 = await adapter.placeStopOrder({
          symbol: coin,
          side: 'LONG',
          vol: protectVol,
          triggerPrice: mid * (1 - 0.05),
          externalOid: uniqueOid('stop1'),
        });
        if (!/^\d+$/.test(stop1.orderId)) {
          throw new Error(`Expected a numeric stop orderId, got "${stop1.orderId}".`);
        }
        const afterStop1 = await waitFor(
          'stop listed in getOpenPlanOrders',
          () => adapter.getOpenPlanOrders(coin),
          (list) => list.some((o) => o.id === stop1.orderId)
        );
        if (!afterStop1.some((o) => o.id === stop1.orderId)) {
          throw new Error(`getOpenPlanOrders did not list stop ${stop1.orderId}.`);
        }
        console.log(`[hl-testnet] step 4 ok: stopId=${stop1.orderId}`);

        // 5. Atomic replace: place the new stop before cancelling the old one -------
        console.log('[hl-testnet] step 5/8: place second stop, then cancel the first');
        const stop2 = await adapter.placeStopOrder({
          symbol: coin,
          side: 'LONG',
          vol: protectVol,
          triggerPrice: mid * (1 - 0.06),
          externalOid: uniqueOid('stop2'),
        });
        if (!/^\d+$/.test(stop2.orderId)) {
          throw new Error(`Expected a numeric replacement stop orderId, got "${stop2.orderId}".`);
        }
        await adapter.cancelStopOrder(stop1.orderId, coin);
        const resting = await waitFor(
          'single resting stop',
          () => adapter.getOpenPlanOrders(coin),
          (list) => list.length === 1 && list[0].id === stop2.orderId
        );
        if (resting.length !== 1) {
          throw new Error(`Expected exactly one resting stop after replace, got ${resting.length}.`);
        }
        if (resting[0].id !== stop2.orderId) {
          throw new Error(`Expected the surviving stop to be ${stop2.orderId}, got ${resting[0].id}.`);
        }
        console.log(`[hl-testnet] step 5 ok: replaced ${stop1.orderId} with ${stop2.orderId}`);

        // 6. Tiny take-profit, then cancel all plan orders --------------------------
        console.log('[hl-testnet] step 6/8: placeTakeProfitOrder, then cancelAllPlanOrders');
        const tp = await adapter.placeTakeProfitOrder({
          symbol: coin,
          side: 'LONG',
          vol: protectVol,
          triggerPrice: mid * (1 + 0.05),
          externalOid: uniqueOid('tp'),
        });
        if (!/^\d+$/.test(tp.orderId)) {
          throw new Error(`Expected a numeric TP orderId, got "${tp.orderId}".`);
        }
        const afterTp = await waitFor(
          'TP listed in getOpenPlanOrders',
          () => adapter.getOpenPlanOrders(coin),
          (list) => list.some((o) => o.id === tp.orderId)
        );
        if (!afterTp.some((o) => o.id === tp.orderId)) {
          throw new Error(`getOpenPlanOrders did not list TP ${tp.orderId}.`);
        }
        await adapter.cancelAllPlanOrders(coin);
        await waitFor('all plan orders cancelled', () => adapter.getOpenPlanOrders(coin), (list) => list.length === 0);
        console.log(`[hl-testnet] step 6 ok: TP ${tp.orderId} placed and all plan orders cancelled`);

        // 7. Close the position -----------------------------------------------------
        console.log('[hl-testnet] step 7/8: closePosition');
        const closed = await adapter.closePosition({
          symbol: coin,
          side: 'LONG',
          vol: positionVol,
          externalOid: uniqueOid('close'),
        });
        if (!/^\d+$/.test(closed.orderId)) {
          throw new Error(`Expected a numeric close orderId, got "${closed.orderId}".`);
        }
        console.log(`[hl-testnet] step 7 ok: closeId=${closed.orderId}`);

        // 8. Venue is flat ----------------------------------------------------------
        console.log('[hl-testnet] step 8/8: assert flat venue');
        await waitFor(
          'flat position',
          () => adapter.getOpenPositions(),
          (list: ExchangePosition[]) => !list.some((p) => p.symbol.startsWith(`${coin}_`))
        );
        const finalPlans = await waitFor('flat plan orders', () => adapter.getOpenPlanOrders(coin), (list) => list.length === 0);
        expect(finalPlans).toHaveLength(0);
        const finalPositions = await adapter.getOpenPositions();
        expect(finalPositions.some((p) => p.symbol.startsWith(`${coin}_`))).toBe(false);
        console.log('[hl-testnet] step 8 ok: venue is flat (no positions, no resting plan orders)');
      } catch (err) {
        failure = err as Error;
      } finally {
        // Always attempt cleanup, even on failure.
        await cleanup();
      }

      if (failure) {
        throw new Error(`Hyperliquid testnet smoke test failed: ${failure.message}`);
      }
    },
    180_000
  );
});
