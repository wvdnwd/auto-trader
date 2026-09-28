import fs from 'node:fs';
import path from 'node:path';
import type { FearAndGreed, MacroEvent, MarketIntelligence, NewsItem, Side } from './types.js';

const FNG_URL = 'https://api.alternative.me/fng/?limit=1';
const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const RSS_COINTELEGRAPH = 'https://cointelegraph.com/rss';
const RSS_COINDESK = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
const RSS_DECRYPT = 'https://decrypt.co/feed';
const RSS_THEBLOCK = 'https://www.theblock.co/rss.xml';

const TIMEOUT_MS = 4000;

export function normalizeCoin(raw: string): string {
  return raw.toUpperCase().replace(/[-_](USDT|USDC|USD|PERP)$/i, '').replace(/^[0-9]+/, '').trim();
}

const KNOWN_COINS: Array<{ symbol: string; patterns: RegExp }> = [
  { symbol: 'BTC', patterns: /\b(BTC|BITCOIN)\b/i },
  { symbol: 'ETH', patterns: /\b(ETH|ETHEREUM|ETHER)\b/i },
  { symbol: 'SOL', patterns: /\b(SOL|SOLANA)\b/i },
  { symbol: 'XRP', patterns: /\b(XRP|RIPPLE)\b/i },
  { symbol: 'DOGE', patterns: /\b(DOGE|DOGECOIN)\b/i },
  { symbol: 'PEPE', patterns: /\b(PEPE)\b/i },
  { symbol: 'SHIB', patterns: /\b(SHIB|SHIBA)\b/i },
  { symbol: 'BONK', patterns: /\b(BONK|1000BONK)\b/i },
  { symbol: 'SUI', patterns: /\b(SUI)\b/i },
  { symbol: 'AVAX', patterns: /\b(AVAX|AVALANCHE)\b/i },
  { symbol: 'NEAR', patterns: /\b(NEAR|NEAR PROTOCOL)\b/i },
  { symbol: 'APT', patterns: /\b(APT|APTOS)\b/i },
  { symbol: 'SEI', patterns: /\b(SEI|SEI NETWORK)\b/i },
  { symbol: 'LINK', patterns: /\b(LINK|CHAINLINK)\b/i },
  { symbol: 'AAVE', patterns: /\b(AAVE)\b/i },
  { symbol: 'UNI', patterns: /\b(UNI|UNISWAP)\b/i },
  { symbol: 'TAO', patterns: /\b(TAO|BITTENSOR)\b/i },
  { symbol: 'FET', patterns: /\b(FET|FETCH|ASI|ARTIFICIAL SUPERINTELLIGENCE)\b/i },
  { symbol: 'RENDER', patterns: /\b(RENDER|RNDR)\b/i },
  { symbol: 'WLD', patterns: /\b(WLD|WORLDCOIN)\b/i },
  { symbol: 'ARB', patterns: /\b(ARB|ARBITRUM)\b/i },
  { symbol: 'OP', patterns: /\b(OP|OPTIMISM)\b/i },
  { symbol: 'DASH', patterns: /\b(DASH)\b/i },
  { symbol: 'ZEC', patterns: /\b(ZEC|ZCASH)\b/i },
  { symbol: 'HYPE', patterns: /\b(HYPE|HYPERLIQUID)\b/i },
  { symbol: 'TRUMP', patterns: /\b(TRUMP)\b/i },
  { symbol: 'FARTCOIN', patterns: /\b(FARTCOIN)\b/i },
  { symbol: 'PENGU', patterns: /\b(PENGU|PUDGY PENGUINS)\b/i },
  { symbol: 'BCH', patterns: /\b(BCH|BITCOIN CASH)\b/i },
  { symbol: 'ICP', patterns: /\b(ICP|INTERNET COMPUTER)\b/i },
  { symbol: 'ADA', patterns: /\b(ADA|CARDANO)\b/i },
  { symbol: 'DOT', patterns: /\b(DOT|POLKADOT)\b/i },
  { symbol: 'BNB', patterns: /\b(BNB|BINANCE COIN)\b/i },
  { symbol: 'LTC', patterns: /\b(LTC|LITECOIN)\b/i },
  { symbol: 'TIA', patterns: /\b(TIA|CELESTIA)\b/i },
  { symbol: 'INJ', patterns: /\b(INJ|INJECTIVE)\b/i },
  { symbol: 'CRV', patterns: /\b(CRV|CURVE)\b/i },
  { symbol: 'DYDX', patterns: /\b(DYDX)\b/i },
  { symbol: 'KAS', patterns: /\b(KAS|KASPA)\b/i },
  { symbol: 'MOODENG', patterns: /\b(MOODENG)\b/i },
  { symbol: 'WIF', patterns: /\b(WIF|DOGWIFHAT)\b/i },
  { symbol: 'POPCAT', patterns: /\b(POPCAT)\b/i },
  { symbol: 'PNUT', patterns: /\b(PNUT)\b/i },
  { symbol: 'GOAT', patterns: /\b(GOAT)\b/i },
  { symbol: 'SPX', patterns: /\b(SPX|SPX6900)\b/i },
  { symbol: 'TURBO', patterns: /\b(TURBO)\b/i },
  { symbol: 'MEW', patterns: /\b(MEW)\b/i },
  { symbol: 'BOME', patterns: /\b(BOME)\b/i },
  { symbol: 'ENA', patterns: /\b(ENA|ETHENA)\b/i },
  { symbol: 'ONDO', patterns: /\b(ONDO)\b/i },
  { symbol: 'ETHFI', patterns: /\b(ETHFI|ETHERFI)\b/i },
  { symbol: 'GMX', patterns: /\b(GMX)\b/i },
  { symbol: 'JUP', patterns: /\b(JUP|JUPITER)\b/i },
  { symbol: 'RAY', patterns: /\b(RAY|RAYDIUM)\b/i },
  { symbol: 'AERO', patterns: /\b(AERO|AERODROME)\b/i },
  { symbol: 'STRK', patterns: /\b(STRK|STARKNET)\b/i },
  { symbol: 'BLAST', patterns: /\b(BLAST)\b/i },
  { symbol: 'ZK', patterns: /\b(ZK|ZKSYNC)\b/i },
  { symbol: 'KAITO', patterns: /\b(KAITO)\b/i },
  { symbol: 'BERA', patterns: /\b(BERA|BERACHAIN)\b/i },
  { symbol: 'MON', patterns: /\b(MON|MONAD)\b/i },
  { symbol: 'VIRTUAL', patterns: /\b(VIRTUAL)\b/i },
  { symbol: 'AI16Z', patterns: /\b(AI16Z)\b/i },
  { symbol: 'AIXBT', patterns: /\b(AIXBT)\b/i },
];

const HIGH_IMPACT_BULLISH = [
  /\b(etf approval|etf approved|mainnet launch|listed on binance|listed on coinbase|listing on binance|listing on coinbase|sec dismisses|sec drops lawsuit|sec drops charges|strategic reserve|treasury buy|major partnership|upgrade live)\b/i,
];

const BULLISH_KEYWORDS = [
  /\b(soar|surge|rally|gain|gains|bull|bullish|record|high|highs|approve|approval|approved|partnership|partner|launch|upgrade|etf|breakout|inflow|inflows|accumulate|accumulation|rebound|boom|adoption|win|positive|green|milestone)\b/i,
];

const CRITICAL_BEARISH_KEYWORDS = [
  /\b(hack|hacked|exploit|exploited|drain|drained|rug|rugpull|insolvent|insolvency|halted|freeze|frozen|delist|delisting|sec charges|indicted|arrested|bankruptcy|bankrupt|stolen)\b/i,
];

const BEARISH_KEYWORDS = [
  /\b(crash|dump|plunge|hack|hacked|exploit|exploited|drop|drops|fall|falls|bear|bearish|sue|sued|sec\b|ban|banned|fraud|scam|outflow|outflows|liquidation|liquidated|delist|delisted|delisting|drain|drained|warn|warning|fine|fined|loss|losses|lawsuit|probe)\b/i,
];

export class NewsEngine {
  private static instance: NewsEngine | null = null;

  private cachedFng: FearAndGreed | null = null;
  private lastFngFetch = 0;
  private readonly FNG_TTL = 3600_000; // 1 hour

  private cachedEvents: MacroEvent[] = [];
  private lastEventsFetch = 0;
  private readonly EVENTS_TTL = 1800_000; // 30 minutes

  private cachedNews: NewsItem[] = [];
  private lastNewsFetch = 0;
  private readonly NEWS_TTL = 300_000; // 5 minutes

  static getInstance(): NewsEngine {
    if (!NewsEngine.instance) {
      NewsEngine.instance = new NewsEngine();
    }
    return NewsEngine.instance;
  }

  private async fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TraderrBot/2.0', ...headers },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch current Crypto Fear & Greed Index.
   */
  async getFearAndGreed(): Promise<FearAndGreed | null> {
    const now = Date.now();
    if (this.cachedFng && now - this.lastFngFetch < this.FNG_TTL) {
      return this.cachedFng;
    }
    try {
      const text = await this.fetchWithTimeout(FNG_URL);
      const json = JSON.parse(text);
      const item = json?.data?.[0];
      if (item && item.value !== undefined) {
        this.cachedFng = {
          score: Number(item.value) || 50,
          classification: item.value_classification || 'Neutral',
          updatedAt: Number(item.timestamp) * 1000 || now,
        };
        this.lastFngFetch = now;
      }
    } catch {
      // Keep previous cache on network error
    }
    return this.cachedFng;
  }

  /**
   * Fetch this week's economic calendar and identify high-impact USD events.
   */
  private getCalendarDiskPath(): string {
    const dir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.resolve(dir, 'macro-calendar.json');
  }

  private readCalendarFromDisk(): MacroEvent[] | null {
    try {
      const p = this.getCalendarDiskPath();
      if (!fs.existsSync(p)) return null;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(data.events) && typeof data.savedAt === 'number') {
        const age = Date.now() - data.savedAt;
        if (age < 24 * 3600_000) {
          const now = Date.now();
          return data.events.map((e: MacroEvent) => {
            const evTime = new Date(e.date).getTime();
            const diff = Math.round((evTime - now) / 60_000);
            return { ...e, timeUntilMinutes: diff, activeShield: diff >= -5 && diff <= 15 };
          }).filter((e: MacroEvent) => e.timeUntilMinutes > -120 && e.timeUntilMinutes < 10080);
        }
      }
    } catch {}
    return null;
  }

  private saveCalendarToDisk(events: MacroEvent[]): void {
    try {
      const p = this.getCalendarDiskPath();
      fs.writeFileSync(p, JSON.stringify({ events, savedAt: Date.now() }, null, 2), 'utf8');
    } catch {}
  }

  private generateDefaultUpcomingEvents(): MacroEvent[] {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const events: MacroEvent[] = [];

    // Core PCE: Last Friday of this month at 12:30 UTC
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0, 12, 30));
    const pceOffset = (lastDayOfMonth.getUTCDay() - 5 + 7) % 7;
    const pceDate = new Date(lastDayOfMonth.getTime() - pceOffset * 86400_000);
    const pceDiff = Math.round((pceDate.getTime() - now.getTime()) / 60_000);
    if (pceDiff > -120 && pceDiff < 10080) {
      events.push({
        title: 'Core PCE Price Index m/m',
        country: 'USD',
        date: pceDate.toISOString(),
        impact: 'High',
        timeUntilMinutes: pceDiff,
        activeShield: pceDiff >= -5 && pceDiff <= 15,
      });
    }

    // NFP: First Friday of next month at 12:30 UTC
    const firstOfNext = new Date(Date.UTC(year, month + 1, 1, 12, 30));
    const nfpOffset = (5 - firstOfNext.getUTCDay() + 7) % 7;
    const nfpDate = new Date(firstOfNext.getTime() + nfpOffset * 86400_000);
    const nfpDiff = Math.round((nfpDate.getTime() - now.getTime()) / 60_000);
    if (nfpDiff > -120 && nfpDiff < 10080) {
      events.push({
        title: 'Non-Farm Employment Change (NFP)',
        country: 'USD',
        date: nfpDate.toISOString(),
        impact: 'High',
        timeUntilMinutes: nfpDiff,
        activeShield: nfpDiff >= -5 && nfpDiff <= 15,
      });
    }

    return events;
  }

  /**
   * Fetch this week's economic calendar and identify high-impact USD events.
   */
  async getMacroEvents(): Promise<MacroEvent[]> {
    const now = Date.now();
    if (this.cachedEvents.length && now - this.lastEventsFetch < this.EVENTS_TTL) {
      return this.cachedEvents;
    }

    // 1. Try disk cache first
    const diskEvents = this.readCalendarFromDisk();
    if (diskEvents && diskEvents.length > 0 && !this.cachedEvents.length) {
      this.cachedEvents = diskEvents;
    }

    try {
      const text = await this.fetchWithTimeout(CALENDAR_URL);
      const rawEvents: Array<{
        title: string;
        country: string;
        date: string;
        impact: string;
        forecast?: string;
        previous?: string;
      }> = JSON.parse(text);

      const parsed: MacroEvent[] = [];
      for (const ev of rawEvents) {
        if (ev.country !== 'USD') continue;
        if (ev.impact !== 'High' && ev.impact !== 'Holiday') continue;

        const eventTime = new Date(ev.date).getTime();
        if (Number.isNaN(eventTime)) continue;

        const diffMinutes = Math.round((eventTime - now) / 60_000);
        // Retain past 2 hours and future 7 days (10080 min)
        if (diffMinutes < -120 || diffMinutes > 10080) continue;

        const activeShield = diffMinutes >= -5 && diffMinutes <= 15;
        parsed.push({
          title: ev.title,
          country: ev.country,
          date: ev.date,
          impact: ev.impact as MacroEvent['impact'],
          forecast: ev.forecast,
          previous: ev.previous,
          timeUntilMinutes: diffMinutes,
          activeShield,
        });
      }

      if (parsed.length > 0) {
        parsed.sort((a, b) => a.timeUntilMinutes - b.timeUntilMinutes);
        this.cachedEvents = parsed;
        this.lastEventsFetch = now;
        this.saveCalendarToDisk(parsed);
      }
    } catch {
      // If network fails (e.g. rate limit), use disk cache or fallback schedule
      if (!this.cachedEvents.length) {
        this.cachedEvents = this.generateDefaultUpcomingEvents();
      }
    }
    return this.cachedEvents;
  }

  /**
   * Check if Macro Shield should pause trading due to high-impact economic news.
   */
  async getMacroShield(): Promise<{ active: boolean; reason?: string; nextEvent?: MacroEvent | null }> {
    const events = await this.getMacroEvents();
    const activeEvent = events.find((e) => e.activeShield);
    if (activeEvent) {
      const timingText =
        activeEvent.timeUntilMinutes > 0
          ? `binnen ${activeEvent.timeUntilMinutes} minuten`
          : `zojuist gepubliceerd (${Math.abs(activeEvent.timeUntilMinutes)}m geleden)`;
      return {
        active: true,
        reason: `Macro Shield actief: USD High-Impact Event "${activeEvent.title}" ${timingText} — nieuwe entries gepauzeerd om slippage en stop-wicks te voorkomen`,
        nextEvent: activeEvent,
      };
    }

    const nextUpcoming = events.find((e) => e.timeUntilMinutes > 15);
    return {
      active: false,
      nextEvent: nextUpcoming || null,
    };
  }

  /**
   * Fetch breaking crypto news from RSS feeds and analyze sentiment + coin tags.
   */
  async getBreakingNews(): Promise<NewsItem[]> {
    const now = Date.now();
    if (this.cachedNews.length && now - this.lastNewsFetch < this.NEWS_TTL) {
      return this.cachedNews;
    }

    const feeds: Array<{ url: string; source: NewsItem['source'] }> = [
      { url: RSS_COINTELEGRAPH, source: 'Cointelegraph' },
      { url: RSS_COINDESK, source: 'CoinDesk' },
      { url: RSS_DECRYPT, source: 'Decrypt' },
      { url: RSS_THEBLOCK, source: 'TheBlock' },
    ];

    const allItems: NewsItem[] = [];

    await Promise.all(
      feeds.map(async ({ url, source }) => {
        try {
          const xml = await this.fetchWithTimeout(url);
          const rawItems = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

          for (const itemXml of rawItems.slice(0, 15)) {
            const titleMatch =
              itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
              itemXml.match(/<title>([\s\S]*?)<\/title>/i);
            const linkMatch =
              itemXml.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/i) ||
              itemXml.match(/<link>([\s\S]*?)<\/link>/i);
            const dateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
            const descMatch =
              itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
              itemXml.match(/<description>([\s\S]*?)<\/description>/i);

            const title = (titleMatch?.[1] || '').trim().replace(/&amp;/g, '&').replace(/&quot;/g, '"');
            if (!title) continue;

            const link = (linkMatch?.[1] || '').trim();
            const pubDateStr = (dateMatch?.[1] || '').trim();
            const publishedAt = pubDateStr ? new Date(pubDateStr).getTime() : now;
            const summary = (descMatch?.[1] || '').replace(/<[^>]*>?/gm, '').trim().slice(0, 200);

            // Sentiment classification
            const fullText = `${title} ${summary}`;
            let sentiment: NewsItem['sentiment'] = 'NEUTRAL';
            const isCritical = CRITICAL_BEARISH_KEYWORDS.some((kw) => kw.test(fullText));
            const isHighImpact = HIGH_IMPACT_BULLISH.some((kw) => kw.test(fullText));
            const isBullish = isHighImpact || BULLISH_KEYWORDS.some((kw) => kw.test(fullText));
            const isBearish = isCritical || BEARISH_KEYWORDS.some((kw) => kw.test(fullText));

            if (isBullish && !isBearish) sentiment = 'BULLISH';
            else if (isBearish && !isBullish) sentiment = 'BEARISH';

            // Coin symbol extraction (stores base ticker, _USDT, and _USDC variants for instant matching)
            const detectedCoins: string[] = [];
            for (const { symbol, patterns } of KNOWN_COINS) {
              if (patterns.test(fullText)) {
                detectedCoins.push(symbol, `${symbol}_USDT`, `${symbol}_USDC`);
              }
            }

            allItems.push({
              id: `${source}-${publishedAt}-${title.slice(0, 30)}`,
              title,
              link,
              source,
              publishedAt,
              sentiment,
              coins: detectedCoins,
              summary: summary ? `${summary}...` : undefined,
              isHighImpact,
              isCritical,
            });
          }
        } catch {
          // ignore individual feed failure
        }
      })
    );

    if (allItems.length > 0) {
      allItems.sort((a, b) => b.publishedAt - a.publishedAt);
      this.cachedNews = allItems.slice(0, 40);
      this.lastNewsFetch = now;
    }

    return this.cachedNews;
  }

  /**
   * Check if a specific symbol has breaking news / catalyst in the last 3 hours.
   */
  async getCatalystForSymbol(symbol: string): Promise<{
    hasCatalyst: boolean;
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    news?: NewsItem;
    scoreBoost: number;
    warning?: string;
    isHighImpact?: boolean;
    isCritical?: boolean;
  }> {
    const news = await this.getBreakingNews();
    const threeHoursAgo = Date.now() - 3 * 3600_000;
    const norm = normalizeCoin(symbol);

    const matching = news.find(
      (n) =>
        n.publishedAt >= threeHoursAgo &&
        (n.coins.some((c) => normalizeCoin(c) === norm) ||
          new RegExp(`\\b${norm}\\b`, 'i').test(n.title))
    );

    if (!matching) {
      return { hasCatalyst: false, sentiment: 'NEUTRAL', scoreBoost: 0 };
    }

    if (matching.sentiment === 'BULLISH') {
      const boost = matching.isHighImpact ? 14 : 8;
      return {
        hasCatalyst: true,
        sentiment: 'BULLISH',
        news: matching,
        scoreBoost: boost,
        isHighImpact: matching.isHighImpact,
      };
    }

    if (matching.sentiment === 'BEARISH') {
      const penalty = matching.isCritical ? -30 : -15;
      return {
        hasCatalyst: true,
        sentiment: 'BEARISH',
        news: matching,
        scoreBoost: penalty,
        warning: `${matching.isCritical ? '🚨 CRITISCH' : '⚠️'} Negatief nieuws gedetecteerd: "${matching.title}"`,
        isCritical: matching.isCritical,
      };
    }

    return {
      hasCatalyst: true,
      sentiment: 'NEUTRAL',
      news: matching,
      scoreBoost: 0,
    };
  }

  /**
   * Proactively check if critical adverse breaking news broke for an open position.
   */
  async checkAdverseNewsForPosition(
    symbol: string,
    side: Side,
    openedAt: number
  ): Promise<{
    adverse: boolean;
    isCritical: boolean;
    news?: NewsItem;
  }> {
    const news = await this.getBreakingNews();
    const windowStart = Math.min(openedAt - 30 * 60_000, Date.now() - 2 * 3600_000);
    const norm = normalizeCoin(symbol);

    const matching = news.find(
      (n) =>
        n.publishedAt >= windowStart &&
        (n.coins.some((c) => normalizeCoin(c) === norm) ||
          new RegExp(`\\b${norm}\\b`, 'i').test(n.title))
    );

    if (!matching) {
      return { adverse: false, isCritical: false };
    }

    if (side === 'LONG' && matching.sentiment === 'BEARISH') {
      return { adverse: true, isCritical: Boolean(matching.isCritical), news: matching };
    }

    if (side === 'SHORT' && matching.sentiment === 'BULLISH') {
      return { adverse: true, isCritical: Boolean(matching.isHighImpact), news: matching };
    }

    return { adverse: false, isCritical: false };
  }

  /**
   * Get full consolidated market intelligence payload for dashboard and engine.
   */
  async getMarketIntelligence(): Promise<MarketIntelligence> {
    const [fearAndGreed, macroShield, upcomingMacroEvents, breakingNews] = await Promise.all([
      this.getFearAndGreed(),
      this.getMacroShield(),
      this.getMacroEvents(),
      this.getBreakingNews(),
    ]);

    return {
      fearAndGreed,
      macroShield,
      upcomingMacroEvents: upcomingMacroEvents.slice(0, 10),
      breakingNews: breakingNews.slice(0, 20),
      fetchedAt: Date.now(),
    };
  }
}
