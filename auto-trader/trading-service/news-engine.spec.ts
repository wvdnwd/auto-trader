import { describe, expect, it } from 'vitest';
import { NewsEngine, normalizeCoin } from './news-engine.js';
import type { NewsItem } from './types.js';

describe('NewsEngine', () => {
  it('normalizes coin symbols correctly', () => {
    expect(normalizeCoin('BTC_USDT')).toBe('BTC');
    expect(normalizeCoin('SOL-USDC')).toBe('SOL');
    expect(normalizeCoin('ETH_USDC')).toBe('ETH');
    expect(normalizeCoin('1000PEPE_USDT')).toBe('PEPE');
    expect(normalizeCoin('HYPE')).toBe('HYPE');
  });

  it('correctly matches and scores catalysts', async () => {
    const engine = NewsEngine.getInstance();

    // Inject mock news into cache
    const mockNews: NewsItem[] = [
      {
        id: 'test-1',
        title: 'Solana Surges 15% Following Major Mainnet Upgrade and Institutional Inflows',
        link: 'https://example.com/solana',
        source: 'CoinDesk',
        publishedAt: Date.now() - 10 * 60_000,
        sentiment: 'BULLISH',
        coins: ['SOL', 'SOL_USDT', 'SOL_USDC'],
        isHighImpact: true,
      },
      {
        id: 'test-2',
        title: 'Aave Protocol Exploit Leads to $5M Drain as SEC Opens Emergency Probe',
        link: 'https://example.com/aave',
        source: 'Decrypt',
        publishedAt: Date.now() - 25 * 60_000,
        sentiment: 'BEARISH',
        coins: ['AAVE', 'AAVE_USDT', 'AAVE_USDC'],
        isCritical: true,
      },
    ];

    (engine as unknown as { cachedNews: NewsItem[]; lastNewsFetch: number }).cachedNews = mockNews;
    (engine as unknown as { lastNewsFetch: number }).lastNewsFetch = Date.now();

    // Check SOL catalyst
    const solCat = await engine.getCatalystForSymbol('SOL_USDT');
    expect(solCat.hasCatalyst).toBe(true);
    expect(solCat.sentiment).toBe('BULLISH');
    expect(solCat.scoreBoost).toBeGreaterThanOrEqual(8);
    expect(solCat.isHighImpact).toBe(true);

    // Check AAVE catalyst
    const aaveCat = await engine.getCatalystForSymbol('AAVE-USDC');
    expect(aaveCat.hasCatalyst).toBe(true);
    expect(aaveCat.sentiment).toBe('BEARISH');
    expect(aaveCat.scoreBoost).toBeLessThan(0);
    expect(aaveCat.isCritical).toBe(true);

    // Check neutral coin
    const btcCat = await engine.getCatalystForSymbol('BTC_USDT');
    expect(btcCat.hasCatalyst).toBe(false);
  });

  it('detects adverse news for open positions', async () => {
    const engine = NewsEngine.getInstance();
    const now = Date.now();

    const mockNews: NewsItem[] = [
      {
        id: 'test-3',
        title: 'Critical Vulnerability Discovered in SUI Bridges — Halted Immediately',
        link: 'https://example.com/sui',
        source: 'TheBlock',
        publishedAt: now - 15 * 60_000,
        sentiment: 'BEARISH',
        coins: ['SUI', 'SUI_USDT'],
        isCritical: true,
      },
    ];

    (engine as unknown as { cachedNews: NewsItem[]; lastNewsFetch: number }).cachedNews = mockNews;
    (engine as unknown as { lastNewsFetch: number }).lastNewsFetch = now;

    // Open LONG on SUI should trigger critical adverse alert
    const checkLong = await engine.checkAdverseNewsForPosition('SUI_USDT', 'LONG', now - 45 * 60_000);
    expect(checkLong.adverse).toBe(true);
    expect(checkLong.isCritical).toBe(true);
    expect(checkLong.news?.title).toContain('Critical Vulnerability');

    // Open SHORT on SUI is not adverse (it benefits from bearish news)
    const checkShort = await engine.checkAdverseNewsForPosition('SUI_USDT', 'SHORT', now - 45 * 60_000);
    expect(checkShort.adverse).toBe(false);
  });
});
