import { type MarketHistory } from './backtest.js';
import { CORE_UNIVERSE } from './engine.js';
import { isCryptoPerp, MarketData } from './market-data.js';
import { loadReplayTimingHistory, replayWarmupStarts, REPLAY_WARMUP_BARS } from './replay-warmup.js';
import { DEFAULT_RISK } from './risk.js';
import { Store } from './store.js';
import { runWorkerJob } from './worker-runner.js';
import type { BacktestConfig, BacktestResult, ScoutResult, ScoutStatus } from './types.js';

/** How often the scout looks for new markets to admit. */
export const SCOUT_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

/** How many candidate markets are backtested per scan. */
export const SCOUT_BATCH_SIZE = 3;

/** History replayed per candidate - enough bars for a meaningful sample without a heavy run. */
const SCOUT_LOOKBACK_DAYS = 180;

/** A rejected market waits this long before it can be retested. */
const COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Minimum backtest bar a candidate market must clear to be admitted.
 *
 * Matches what the optimizer already treats as an acceptable outcome on the
 * validated core universe - not a lower bar just because this runs unsupervised.
 */
const ADMISSION = {
  profitFactor: 1.1,
  minTrades: 20,
} as const;

/**
 * Delay before the first scan after startup, so it never competes with the
 * engine and store finishing their own initialisation.
 */
const STARTUP_DELAY_MS = 60_000;

/**
 * Background job that widens the live trading universe over time.
 *
 * Every {@link SCOUT_INTERVAL_MS} it picks the most liquid crypto perpetuals not
 * already traded, backtests each one on a worker thread - never on the main
 * event loop, so live trading and the dashboard stay responsive - and admits
 * any that clear the same bar the optimizer already considers acceptable.
 * Markets that fail serve a cooldown so the next scan does not immediately
 * retest them. Admissions and cooldowns persist across restarts.
 */
export class MarketScout {
  private timer: ReturnType<typeof setInterval> | null = null;

  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private lastRunAt: number | null = null;

  private recent: ScoutResult[] = [];

  private universeExtras: string[] = [];

  /**
   * Candidates that cleared the backtest bar but have not been manually
   * approved yet — keyed by symbol so a re-test of the same market before
   * approval replaces rather than duplicates the entry.
   */
  private pending = new Map<string, ScoutResult>();

  constructor(
    private readonly market: MarketData,
    private readonly store: Store,
    /** Called with a symbol once it clears the admission bar. */
    private readonly onAdmit: (symbol: string) => void,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => Promise<void>
  ) {}

  /**
   * Restore prior admissions into the live engine and start the recurring scan.
   *
   * Safe to call once at service startup, after the store is connected.
   */
  async init(): Promise<void> {
    const state = await this.store.scoutState();
    for (const symbol of state.universeExtras) this.onAdmit(symbol);
    this.universeExtras = state.universeExtras;
    this.lastRunAt = state.lastRunAt;
    this.startupTimer = setTimeout(() => void this.run(), STARTUP_DELAY_MS);
    this.timer = setInterval(() => void this.run(), SCOUT_INTERVAL_MS);
  }

  /** Stop the recurring scan - used only by tests and graceful shutdown. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
  }

  /** Current state for the dashboard. */
  status(): ScoutStatus {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.lastRunAt ? this.lastRunAt + SCOUT_INTERVAL_MS : null,
      universeExtras: this.universeExtras,
      recent: this.recent,
      pending: [...this.pending.values()],
    };
  }

  /**
   * Admit a pending candidate into the live universe.
   *
   * The scout never does this on its own — clearing the backtest bar only
   * earns a market a spot in {@link status}'s `pending` list; a human has to
   * confirm it here before it ever appears in a scan.
   *
   * @param symbol the pending candidate to admit.
   * @returns true if the symbol was pending and is now admitted, false if it was not found.
   */
  async approve(symbol: string): Promise<boolean> {
    const entry = this.pending.get(symbol);
    if (!entry) return false;
    this.pending.delete(symbol);
    await this.store.addScoutUniverseSymbol(symbol);
    this.onAdmit(symbol);
    if (!this.universeExtras.includes(symbol)) this.universeExtras = [...this.universeExtras, symbol];
    await this.log('info', `Marktscan: ${symbol} handmatig goedgekeurd en toegevoegd aan universum`);
    return true;
  }

  /**
   * Dismiss a pending candidate without admitting it.
   *
   * Applies the same cooldown a failed backtest would, so a dismissed market
   * is not immediately re-proposed on the next scan.
   *
   * @param symbol the pending candidate to dismiss.
   * @returns true if the symbol was pending and is now dismissed, false if it was not found.
   */
  async dismiss(symbol: string): Promise<boolean> {
    if (!this.pending.has(symbol)) return false;
    this.pending.delete(symbol);
    await this.store.setScoutCooldown(symbol, Date.now() + COOLDOWN_MS);
    await this.log('info', `Marktscan: ${symbol} afgewezen door gebruiker`);
    return true;
  }

  /** Run one scan now - picks candidates, backtests each, admits or cools down. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.pickCandidates();
      for (const symbol of candidates) {
        await this.evaluate(symbol);
      }
    } catch (err) {
      await this.log('warn', `Marktscan mislukt: ${(err as Error).message}`);
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
      await this.store.setScoutLastRun(this.lastRunAt);
    }
  }

  /** Select the most liquid crypto perps not already traded and not on cooldown. */
  private async pickCandidates(): Promise<string[]> {
    const state = await this.store.scoutState();
    const active = new Set([...CORE_UNIVERSE, ...state.universeExtras]);
    const now = Date.now();
    const onCooldown = new Set(
      Object.entries(state.cooldowns)
        .filter(([, until]) => until > now)
        .map(([symbol]) => symbol)
    );
    const minVol = DEFAULT_RISK.minQuoteVolume24h ?? 5_000_000;
    const tickers = await this.market.tickers();
    return tickers
      .filter(
        (t) =>
          isCryptoPerp(t.symbol) &&
          Number.isFinite(t.quoteVolume24h) &&
          t.quoteVolume24h >= minVol &&
          !active.has(t.symbol) &&
          !onCooldown.has(t.symbol) &&
          !this.pending.has(t.symbol)
      )
      .sort((a, b) => {
        const byVolume = b.quoteVolume24h - a.quoteVolume24h;
        if (byVolume !== 0) return byVolume;
        return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
      })
      .slice(0, SCOUT_BATCH_SIZE)
      .map((t) => t.symbol);
  }

  /** Backtest one candidate and admit or cool it down based on the result. */
  private async evaluate(symbol: string): Promise<void> {
    const to = Math.floor(Date.now() / 1000);
    const from = to - SCOUT_LOOKBACK_DAYS * 86_400;
    const config: BacktestConfig = {
      symbols: [symbol],
      interval: 'Min60',
      higherInterval: 'Hour4',
      from,
      to,
      startingBalance: 10_000,
      risk: DEFAULT_RISK,
    };

    let result: BacktestResult;
    try {
      const markets = await this.loadHistory(config);
      if (!markets.length) {
        await this.reject(symbol, 'geen historische data beschikbaar');
        return;
      }
      const outcome = await runWorkerJob({ kind: 'backtest', markets, config }, () => {});
      if (outcome.kind !== 'backtest') throw new Error('onverwacht worker-resultaat');
      result = outcome.result;
    } catch (err) {
      await this.reject(symbol, `backtest mislukt: ${(err as Error).message}`);
      return;
    }

    const passed =
      result.trades >= ADMISSION.minTrades &&
      result.profitFactor >= ADMISSION.profitFactor &&
      result.expectancyR > 0 &&
      result.maxDrawdownPct <= DEFAULT_RISK.maxDrawdownPct;

    const entry: ScoutResult = {
      symbol,
      testedAt: Date.now(),
      passed,
      reason: passed
        ? `toegelaten: PF ${result.profitFactor.toFixed(2)}, verwachting ${result.expectancyR.toFixed(3)}R over ${result.trades} trades`
        : `afgewezen: PF ${result.profitFactor.toFixed(2)}, verwachting ${result.expectancyR.toFixed(3)}R over ${result.trades} trades, DD ${(result.maxDrawdownPct * 100).toFixed(1)}%`,
      profitFactor: result.profitFactor,
      expectancyR: result.expectancyR,
      trades: result.trades,
      maxDrawdownPct: result.maxDrawdownPct,
    };
    this.remember(entry);

    if (passed) {
      // Clearing the backtest bar earns a review slot, not automatic admission —
      // `approve()` is the only path that actually widens the live universe.
      this.pending.set(symbol, entry);
      await this.log('info', `Marktscan: ${symbol} wacht op goedkeuring - ${entry.reason}`);
    } else {
      this.pending.delete(symbol);
      await this.store.setScoutCooldown(symbol, Date.now() + COOLDOWN_MS);
      await this.log('info', `Marktscan: ${symbol} niet toegelaten - ${entry.reason}`);
    }
  }

  /** Record a hard failure (no data, backtest error) as a rejection with cooldown. */
  private async reject(symbol: string, reason: string): Promise<void> {
    this.pending.delete(symbol);
    const entry: ScoutResult = {
      symbol,
      testedAt: Date.now(),
      passed: false,
      reason,
      profitFactor: 0,
      expectancyR: 0,
      trades: 0,
      maxDrawdownPct: 0,
    };
    this.remember(entry);
    await this.store.setScoutCooldown(symbol, Date.now() + COOLDOWN_MS);
    await this.log('warn', `Marktscan: ${symbol} overgeslagen - ${reason}`);
  }

  /** Keep a bounded trail of recent results for the dashboard. */
  private remember(entry: ScoutResult): void {
    this.recent = [entry, ...this.recent].slice(0, 15);
  }

  /** Download entry and higher-timeframe history for one candidate. */
  private async loadHistory(config: BacktestConfig): Promise<MarketHistory[]> {
    const { entryFrom, higherFrom } = replayWarmupStarts(
      config.from,
      config.interval,
      config.higherInterval
    );

    const markets: MarketHistory[] = [];
    for (const symbol of config.symbols) {
      const [candles, higher] = await Promise.all([
        this.market.history(symbol, config.interval, entryFrom, config.to),
        this.market.history(symbol, config.higherInterval, higherFrom, config.to),
      ]);
      if (candles.length < REPLAY_WARMUP_BARS || higher.length < REPLAY_WARMUP_BARS) continue;
      const timing = await loadReplayTimingHistory(
        this.market.history.bind(this.market),
        symbol,
        config.from,
        config.to,
        [
          { interval: config.interval, from: entryFrom, to: config.to, candles },
          { interval: config.higherInterval, from: higherFrom, to: config.to, candles: higher },
        ]
      );
      if (!timing.timing15m || !timing.timing5m) {
        throw new Error('geen bruikbare Min15/Min5 timinghistorie beschikbaar');
      }
      markets.push({ symbol, candles, higher, ...timing });
    }
    return markets;
  }
}
