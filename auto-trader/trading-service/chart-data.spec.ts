import { describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', () => ({ Store: class Store {} }));

describe('TradingService chart data', () => {
  it('propagates position-store read failures', async () => {
    const { TradingService } = await import('./trading-service.js');
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
