import { describe, expect, it } from 'vitest';
import { extractHlOrderId, HyperliquidExchangeAdapter, toHyperliquidCloid } from './hyperliquid-adapter.js';

// Pure-function tests only: they never construct the production adapter and make
// no network calls.
describe('toHyperliquidCloid', () => {
  it('returns undefined when no external oid is supplied', () => {
    expect(toHyperliquidCloid(undefined)).toBeUndefined();
    expect(toHyperliquidCloid('')).toBeUndefined();
  });

  it('produces a 34-char 0x-prefixed 32-hex cloid accepted by the SDK pattern', () => {
    const cloid = toHyperliquidCloid('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(cloid).toBeDefined();
    expect(cloid).toHaveLength(34);
    expect(cloid).toMatch(/^0x[a-fA-F0-9]{32}$/);
  });

  it('is deterministic and distinct per external oid', () => {
    const a = toHyperliquidCloid('order-a');
    const b = toHyperliquidCloid('order-b');
    expect(toHyperliquidCloid('order-a')).toBe(a);
    expect(a).not.toBe(b);
  });
});

describe('extractHlOrderId', () => {
  it('reads the oid from filled and resting acknowledgements', () => {
    expect(extractHlOrderId({ filled: { oid: 123, totalSz: '1', avgPx: '100' } })).toBe('123');
    expect(extractHlOrderId({ resting: { oid: 456 } })).toBe('456');
  });

  it('returns null for statuses that carry no oid', () => {
    expect(extractHlOrderId('waitingForFill')).toBeNull();
    expect(extractHlOrderId('waitingForTrigger')).toBeNull();
    expect(extractHlOrderId({ error: 'order rejected' })).toBeNull();
    expect(extractHlOrderId(null)).toBeNull();
    expect(extractHlOrderId(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAccountAssets accounting
//
// These tests never hit the network: the adapter's private info client is
// replaced with a stub that returns the supplied clearinghouse payloads.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;

type AdapterInternals = {
  infoClient: {
    clearinghouseState: (params: { user: `0x${string}` }) => Promise<unknown>;
    spotClearinghouseState: (params: { user: `0x${string}` }) => Promise<unknown>;
  };
  balanceCache: unknown;
};

/**
 * Build a real adapter instance (so the production accounting code runs) with
 * its private perp/spot info clients replaced by deterministic stubs.
 */
function adapterWith(perpState: unknown, spotState: unknown): HyperliquidExchangeAdapter {
  const adapter = new HyperliquidExchangeAdapter(WALLET);
  const internals = adapter as unknown as AdapterInternals;
  internals.infoClient = {
    clearinghouseState: async () => perpState,
    spotClearinghouseState: async () => spotState,
  };
  internals.balanceCache = null;
  return adapter;
}

describe('HyperliquidExchangeAdapter.getAccountAssets', () => {
  it('values a unified account as spot USDC total + perp unrealised PnL without double counting', async () => {
    // Exact live snapshot: perp marginSummary.accountValue == totalMarginUsed,
    // spot USDC total 236.96938 of which 73.328394 is held as perp collateral.
    const perp = {
      marginSummary: {
        accountValue: '73.328',
        totalNtlPos: '0',
        totalRawUsd: '73.328',
        totalMarginUsed: '73.328394',
      },
      crossMarginSummary: {
        accountValue: '0.0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '0.0',
      assetPositions: [{ type: 'oneWay', position: { coin: 'SUI', szi: '10', unrealizedPnl: '-1.29' } }],
      time: 0,
    };
    const spot = {
      balances: [{ coin: 'USDC', token: 0, total: '236.96938', hold: '73.328394', entryNtl: '0' }],
    };

    const assets = await adapterWith(perp, spot).getAccountAssets();
    expect(assets).toHaveLength(1);
    const asset = assets[0];
    expect(asset.currency).toBe('USDC');
    expect(asset.equity).toBeCloseTo(235.68, 2); // 236.96938 − 1.29
    expect(asset.frozen).toBeCloseTo(73.33, 2); // perp totalMarginUsed → used margin
    expect(asset.available).toBeCloseTo(163.641, 3); // 236.96938 − 73.328394
    // The engine derives unrealised PnL as equity − available − frozen; it must
    // be the real perp PnL, not a phantom from the old equity/used-margin clash.
    expect(asset.equity - asset.available - asset.frozen).toBeCloseTo(-1.29, 2);
    // Regression guards: neither perp-only equity (~73.8) nor spot + perp double-count (~310).
    expect(asset.equity).toBeGreaterThan(200);
    expect(asset.equity).toBeLessThan(236.98);
  });

  it('uses perp accountValue as equity for a pure perp account with no spot balance', async () => {
    const perp = {
      marginSummary: {
        accountValue: '500.5',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '120',
      },
      crossMarginSummary: {
        accountValue: '0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '380.5',
      assetPositions: [{ type: 'oneWay', position: { coin: 'BTC', szi: '0.1', unrealizedPnl: '5.5' } }],
      time: 0,
    };

    const asset = (await adapterWith(perp, { balances: [] }).getAccountAssets())[0];
    expect(asset.equity).toBeCloseTo(500.5, 6);
    expect(asset.frozen).toBeCloseTo(120, 6);
    expect(asset.available).toBeCloseTo(380.5, 6);
  });

  it('treats a zero-total spot USDC balance as a pure perp account', async () => {
    const perp = {
      marginSummary: {
        accountValue: '500.5',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '120',
      },
      crossMarginSummary: {
        accountValue: '0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '380.5',
      assetPositions: [],
      time: 0,
    };
    const spot = { balances: [{ coin: 'USDC', token: 0, total: '0', hold: '0', entryNtl: '0' }] };

    const asset = (await adapterWith(perp, spot).getAccountAssets())[0];
    expect(asset.equity).toBeCloseTo(500.5, 6);
    expect(asset.frozen).toBeCloseTo(120, 6);
    expect(asset.available).toBeCloseTo(380.5, 6);
  });

  it('returns zeroed, finite values for an empty account', async () => {
    const perp = {
      marginSummary: {
        accountValue: '0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMarginSummary: {
        accountValue: '0',
        totalNtlPos: '0',
        totalRawUsd: '0',
        totalMarginUsed: '0',
      },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '0',
      assetPositions: [],
      time: 0,
    };

    const asset = (await adapterWith(perp, { balances: [] }).getAccountAssets())[0];
    expect(asset.currency).toBe('USDC');
    expect(asset.equity).toBe(0);
    expect(asset.available).toBe(0);
    expect(asset.frozen).toBe(0);
    expect(Number.isFinite(asset.equity)).toBe(true);
    expect(Number.isFinite(asset.available)).toBe(true);
    expect(Number.isFinite(asset.frozen)).toBe(true);
  });

  it('zeroes missing, non-numeric and negative fields instead of producing NaN', async () => {
    const perp = {
      marginSummary: { accountValue: 'n/a', totalMarginUsed: undefined },
      crossMarginSummary: { accountValue: '-3' },
      withdrawable: '-5',
      assetPositions: [{ type: 'oneWay', position: { coin: 'ETH', szi: '1', unrealizedPnl: 'oops' } }],
    };
    const spot = { balances: [{ coin: 'USDC', token: 0, total: 'NaN', hold: '10' }] };

    const asset = (await adapterWith(perp, spot).getAccountAssets())[0];
    expect(asset.equity).toBe(0);
    expect(asset.available).toBe(0);
    expect(asset.frozen).toBe(0);
    expect([asset.equity, asset.available, asset.frozen].every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
});
