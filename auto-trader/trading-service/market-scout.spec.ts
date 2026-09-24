import { vi } from 'vitest';
import { MarketScout } from './market-scout.js';
import { runWorkerJob } from './worker-runner.js';
import type { MarketData } from './market-data.js';
import type { Store } from './store.js';
import type { BacktestResult, ScoutResult } from './types.js';

vi.mock('./worker-runner.js', () => ({ runWorkerJob: vi.fn() }));
vi.mock('./engine.js', () => ({ CORE_UNIVERSE: [] }));
vi.mock('./market-data.js', () => ({ isCryptoPerp: () => true }));

function workerResult(patch: Partial<BacktestResult>) {
  return {
    type: 'done' as const,
    kind: 'backtest' as const,
    result: {
      trades: 30,
      profitFactor: 1.4,
      expectancyR: 0.15,
      maxDrawdownPct: 0.05,
      ...patch,
    } as BacktestResult,
  };
}

describe('market scout pending approvals', () => {
  it('removes a prior pass when a retest fails', async () => {
    const historyMock = vi.fn(async (_symbol: string, interval: string, from: number) => {
      const step =
        ({ Min5: 300, Min15: 900, Min60: 3600, Hour4: 14_400 } as Record<string, number>)[interval] ?? 60;
      return Array.from({ length: 100 }, (_, i) => ({
        time: from + i * step,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000,
      }));
    });
    const market = {
      history: historyMock,
    } as unknown as MarketData;
    const store = {
      setScoutCooldown: vi.fn(async () => {}),
    } as unknown as Store;
    const onAdmit = vi.fn();
    const scout = new MarketScout(market, store, onAdmit, async () => {});
    const evaluate = (scout as unknown as { evaluate(symbol: string): Promise<void> }).evaluate.bind(scout);
    const worker = vi.mocked(runWorkerJob);

    worker.mockResolvedValueOnce(workerResult({}));
    await evaluate('TEST_USDT');
    expect(scout.status().pending).toHaveLength(1);
    expect(onAdmit).not.toHaveBeenCalled();
    expect(historyMock.mock.calls.map(([, interval]) => interval)).toEqual(
      expect.arrayContaining(['Min60', 'Hour4', 'Min15', 'Min5'])
    );
    expect(worker.mock.calls[0][0].markets[0]).toEqual(
      expect.objectContaining({ timing15m: expect.any(Array), timing5m: expect.any(Array) })
    );

    worker.mockResolvedValueOnce(workerResult({ trades: 5, profitFactor: 0.7, expectancyR: -0.2 }));
    await evaluate('TEST_USDT');

    expect(scout.status().pending).toHaveLength(0);
    expect(store.setScoutCooldown).toHaveBeenCalledTimes(1);
  });

  it('removes a pending pass when a retest cannot be completed', async () => {
    const market = { history: vi.fn(async () => []) } as unknown as MarketData;
    const store = {
      setScoutCooldown: vi.fn(async () => {}),
    } as unknown as Store;
    const scout = new MarketScout(market, store, () => {}, async () => {});
    const pending: ScoutResult = {
      symbol: 'TEST_USDT',
      testedAt: 1,
      passed: true,
      reason: 'pending review',
      profitFactor: 1.4,
      expectancyR: 0.15,
      trades: 30,
      maxDrawdownPct: 0.05,
    };
    (scout as unknown as { pending: Map<string, ScoutResult> }).pending.set(pending.symbol, pending);
    const evaluate = (scout as unknown as { evaluate(symbol: string): Promise<void> }).evaluate.bind(scout);

    await evaluate(pending.symbol);

    expect(scout.status().pending).toHaveLength(0);
    expect(store.setScoutCooldown).toHaveBeenCalledTimes(1);
  });

  it('rejects a scan instead of running without 15 real 5m timing bars', async () => {
    const market = {
      history: vi.fn(async (_symbol: string, interval: string, from: number) =>
        Array.from({ length: interval === 'Min5' ? 14 : 100 }, (_, i) => ({
          time: from + i * 300,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1,
        }))
      ),
    } as unknown as MarketData;
    const store = {
      setScoutCooldown: vi.fn(async () => {}),
    } as unknown as Store;
    const scout = new MarketScout(market, store, () => {}, async () => {});
    const evaluate = (scout as unknown as { evaluate(symbol: string): Promise<void> }).evaluate.bind(scout);
    const worker = vi.mocked(runWorkerJob);
    worker.mockClear();

    await evaluate('TEST_USDT');

    expect(worker).not.toHaveBeenCalled();
    expect(scout.status().recent[0].reason).toContain('Min15/Min5 timinghistorie');
    expect(store.setScoutCooldown).toHaveBeenCalledTimes(1);
  });
});

describe('market scout candidate selection', () => {
  function makeScout(tickers: { symbol: string; quoteVolume24h: number }[]) {
    const market = { tickers: vi.fn(async () => tickers) } as unknown as MarketData;
    const store = {
      scoutState: vi.fn(async () => ({ universeExtras: [], cooldowns: {}, lastRunAt: null })),
    } as unknown as Store;
    const onAdmit = vi.fn();
    const scout = new MarketScout(market, store, onAdmit, async () => {});
    const pickCandidates = (scout as unknown as {
      pickCandidates(): Promise<string[]>;
    }).pickCandidates.bind(scout);
    return { scout, pickCandidates, onAdmit };
  }

  it('sorts shuffled eligible tickers by quote volume before limiting the batch', async () => {
    const { pickCandidates } = makeScout([
      { symbol: 'LOW_USDT', quoteVolume24h: 8_000_000 },
      { symbol: 'TOP_USDT', quoteVolume24h: 80_000_000 },
      { symbol: 'MID_USDT', quoteVolume24h: 30_000_000 },
      { symbol: 'NEXT_USDT', quoteVolume24h: 20_000_000 },
    ]);

    await expect(pickCandidates()).resolves.toEqual(['TOP_USDT', 'MID_USDT', 'NEXT_USDT']);
  });

  it('orders equal-volume tickers by symbol regardless of input order', async () => {
    const tickers = [
      { symbol: 'ZED_USDT', quoteVolume24h: 20_000_000 },
      { symbol: 'ALPHA_USDT', quoteVolume24h: 20_000_000 },
      { symbol: 'BETA_USDT', quoteVolume24h: 20_000_000 },
    ];
    const first = makeScout(tickers);
    const second = makeScout([...tickers].reverse());

    await expect(first.pickCandidates()).resolves.toEqual(['ALPHA_USDT', 'BETA_USDT', 'ZED_USDT']);
    await expect(second.pickCandidates()).resolves.toEqual(['ALPHA_USDT', 'BETA_USDT', 'ZED_USDT']);
  });

  it('does not retest pending symbols or automatically admit them', async () => {
    const tickers = [
      { symbol: 'PENDING_USDT', quoteVolume24h: 80_000_000 },
      { symbol: 'OTHER_USDT', quoteVolume24h: 30_000_000 },
    ];
    const { scout, pickCandidates, onAdmit } = makeScout(tickers);
    const pending: ScoutResult = {
      symbol: 'PENDING_USDT',
      testedAt: 1,
      passed: true,
      reason: 'pending review',
      profitFactor: 1.4,
      expectancyR: 0.15,
      trades: 30,
      maxDrawdownPct: 0.05,
    };
    (scout as unknown as { pending: Map<string, ScoutResult> }).pending.set(pending.symbol, pending);

    await expect(pickCandidates()).resolves.toEqual(['OTHER_USDT']);
    expect(scout.status().pending).toEqual([pending]);
    expect(onAdmit).not.toHaveBeenCalled();
  });
});
