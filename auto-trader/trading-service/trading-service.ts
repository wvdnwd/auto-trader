import { BacktestRunner } from './backtest-runner.js';
import { OptimizerRunner } from './optimizer-runner.js';
import { WalkForwardRunner, type WalkForwardStatus } from './walk-forward-runner.js';
import { CONFIRM_INTERVAL, ENTRY_INTERVAL, Engine } from './engine.js';
import { MexcExchangeAdapter, hasExchangeCredentials, type LiveTradingStatus } from './exchange-adapter.js';
import { MarketScout } from './market-scout.js';
import { MarketData, isCryptoPerp } from './market-data.js';
import { hasNotificationChannel, notify } from './notifier.js';
import { Store } from './store.js';
import { buildSignal } from './strategy.js';
import { isPositionDerisked, planTrade } from './risk.js';
import type {
  Account,
  BacktestConfig,
  BacktestStatus,
  BlockedState,
  Candle,
  EngineEvent,
  ExchangeAccountSnapshot,
  LearningState,
  OptimizeStatus,
  Position,
  RiskConfig,
  ScoutStatus,
  Signal,
  Ticker,
  TradePlan,
} from './types.js';

/**
 * Chart payload for one symbol: the exact candles the strategy scores it on,
 * plus the freshly rebuilt signal so a chart can draw the same swing, golden
 * zone, and stop/target levels the engine is watching right now.
 */
export type ChartData = {
  symbol: string;
  entryInterval: string;
  confirmInterval: string;
  /** Entry-timeframe candles, oldest first. */
  candles: Candle[];
  /** Higher-timeframe candles used for trend confirmation, oldest first. */
  higherCandles: Candle[];
  /** The current signal for this symbol, or null when there is not enough history. */
  signal: Signal | null;
  /** Active open position for this symbol, if any. */
  position?: Position | null;
  /** Planned trade with TP ladder and SL, if computable. */
  plannedTrade?: TradePlan | null;
  /** Error message if candle fetch partially failed. */
  error?: string;
};

/**
 * Full dashboard payload returned by the API in a single request.
 */
export type Snapshot = {
  running: boolean;
  blocked: BlockedState | null;
  scannedAt: number;
  /** Seconds between scans right now. Drops when a setup nears its trigger. */
  cadenceSec: number;
  /** True while the engine is on the fast cycle watching a setup. */
  watching: boolean;
  account: Account;
  risk: RiskConfig;
  open: Position[];
  closed: Position[];
  signals: Signal[];
  events: EngineEvent[];
  stats: Stats;
  /** Latest mark price per symbol, so the dashboard can show live pnl. */
  marks: Record<string, number>;
  /** State of the background job that widens the trading universe over time. */
  scout: ScoutStatus;
  /** Readiness of the (not-yet-active) live MEXC order connection. */
  exchange: LiveTradingStatus;
  /** Whether a Telegram bot or webhook is configured to receive trade alerts. */
  notificationsEnabled: boolean;
  /** Consecutive chop-regime scans and how many are allowed before entries pause. */
  chopStatus: { streak: number; limit: number };
  /**
   * Real MEXC account state — present only while `exchange.enabled` is true.
   * The dashboard switches its main balance cards and open-position list to
   * this instead of the paper `account`/`open` fields whenever it is set, so
   * the user sees exactly what is happening on the real exchange while live.
   */
  exchangeAccount: ExchangeAccountSnapshot | null;
  /** Adaptive self-learning engine state including factor performance and symbol penalties. */
  learning?: LearningState;
};

/**
 * Aggregate performance statistics over closed trades.
 */
export type Stats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
};

/**
 * Facade over the trading engine — the single entry point used by the HTTP layer.
 */
export class TradingService {
  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly market: MarketData,
    private readonly backtests: BacktestRunner,
    private readonly optimizer: OptimizerRunner,
    private readonly walkForward: WalkForwardRunner,
    private readonly scout: MarketScout,
    private readonly exchange: MexcExchangeAdapter = new MexcExchangeAdapter()
  ) {}

  /**
   * Connect storage and start the autonomous engine.
   *
   * @param autoStart whether to start the trading loop immediately.
   */
  async init(autoStart = true): Promise<void> {
    const connected = await this.store.connect();
    await this.store.addEvent({
      at: Date.now(),
      level: connected ? 'info' : 'warn',
      message: connected
        ? 'Verbonden met database — posities worden bewaard'
        : 'Geen database bereikbaar — draait op in-memory state',
    });
    // Credentials saved from the dashboard on a previous run take priority over
    // any MEXC_API_KEY/MEXC_API_SECRET environment variables, so a restart
    // reconnects to whichever MEXC account was pasted in last.
    const stored = await this.store.exchangeCredentials();
    if (stored.apiKey && stored.apiSecret) {
      this.exchange.setCredentials(stored.apiKey, stored.apiSecret);
      process.env.MEXC_API_KEY = stored.apiKey;
      process.env.MEXC_API_SECRET = stored.apiSecret;
    }
    if (autoStart) this.engine.start();
    await this.scout.init();
  }

  /**
   * Build the complete dashboard snapshot.
   *
   * @returns account, positions, signals, events and stats in one payload.
   */
  async snapshot(): Promise<Snapshot> {
    const exchangeStatus = this.exchange.status();
    const [account, open, closed, events, exchangeAccount, learning] = await Promise.all([
      this.engine.account(),
      this.store.positions('OPEN'),
      this.store.positions('CLOSED', 100),
      this.store.events(60),
      exchangeStatus.enabled ? this.fetchExchangeAccount() : Promise.resolve(null),
      this.store.learning(),
    ]);
    // Recompute capacity against the active at-risk count: positions that reached
    // TP1 are derisked and do not consume a slot against maxOpenPositions.
    const atRisk = open.filter((p) => !isPositionDerisked(p));
    const cached = this.engine.blocked;
    const blocked =
      cached?.kind === 'capacity' && atRisk.length < this.engine.config.maxOpenPositions
        ? null
        : cached;

    return {
      running: this.engine.running,
      blocked,
      scannedAt: this.engine.scannedAt,
      cadenceSec: this.engine.cadenceSec,
      watching: this.engine.watching,
      account,
      risk: this.engine.config,
      open,
      closed,
      signals: this.engine.signals,
      events,
      stats: computeStats(closed),
      marks: this.engine.markPrices,
      scout: this.scout.status(),
      exchange: exchangeStatus,
      notificationsEnabled: hasNotificationChannel(),
      chopStatus: this.engine.chopStatus,
      exchangeAccount,
      learning,
    };
  }

  /**
   * Fetch the real MEXC account state — balances and open positions — for the
   * dashboard to display in place of the paper ledger while live trading is
   * armed. Never throws: a failed fetch (rate limit, network blip, revoked
   * key) resolves to a snapshot carrying only an `error`, so the dashboard can
   * show a clear warning instead of silently reverting to paper numbers that
   * would look like real ones.
   *
   * @returns the venue account snapshot, or an error-carrying stub on failure.
   */
  private async fetchExchangeAccount(): Promise<ExchangeAccountSnapshot> {
    try {
      const [assets, positions] = await Promise.all([
        this.exchange.getAccountAssets(),
        this.exchange.getOpenPositions(),
      ]);
      const usdt = assets.find((a) => a.currency === 'USDT');
      const marks = this.engine.markPrices;

      // MEXC's `unrealised` field on this endpoint is not reliably populated, and
      // `vol` is contract count, not base-asset quantity — both need converting
      // via the contract spec before they mean anything to a person reading the
      // dashboard. Computed the same way the paper ledger does (see `openPnl` in
      // exits.ts) so live and paper numbers are directly comparable.
      const open = await Promise.all(
        positions.map(async (p) => {
          const detail = await this.market.contractDetail(p.symbol).catch(() => null);
          const contractSize = detail?.contractSize || 1;
          const baseQty = p.vol * contractSize;
          const markPrice = marks[p.symbol] ?? p.entryPrice;
          const dir = p.side === 'LONG' ? 1 : -1;
          const unrealisedPnl = dir * (markPrice - p.entryPrice) * baseQty;
          return {
            symbol: p.symbol,
            side: p.side,
            vol: baseQty,
            leverage: p.leverage,
            entryPrice: p.entryPrice,
            markPrice,
            liquidationPrice: p.liquidationPrice,
            unrealisedPnl,
            openedAt: p.createTime,
          };
        })
      );
      const unrealisedPnl = open.reduce((sum, p) => sum + p.unrealisedPnl, 0);
      return {
        equity: usdt?.equity ?? 0,
        available: usdt?.available ?? 0,
        frozen: usdt?.frozen ?? 0,
        unrealisedPnl,
        open,
        fetchedAt: Date.now(),
      };
    } catch (err) {
      return {
        equity: 0,
        available: 0,
        frozen: 0,
        unrealisedPnl: 0,
        open: [],
        fetchedAt: Date.now(),
        error: (err as Error).message,
      };
    }
  }

  /** Start the autonomous loop. */
  start(): void {
    this.engine.start();
  }

  /** Stop the autonomous loop. */
  stop(): void {
    this.engine.stop();
  }

  /** Run a single cycle immediately, regardless of the loop schedule. */
  async runOnce(): Promise<void> {
    await this.engine.cycle();
  }

  /**
   * Update risk settings at runtime.
   *
   * @param patch fields to override.
   * @returns the merged risk configuration.
   */
  updateRisk(patch: Partial<RiskConfig>): RiskConfig {
    return this.engine.setRisk(patch);
  }

  /**
   * Manually close an open position at market.
   *
   * @param id position id.
   * @returns true when the position existed and was closed.
   */
  async closePosition(id: string): Promise<boolean> {
    return this.engine.closePosition(id);
  }

  /** Reset the paper account and clear all history. */
  async reset(): Promise<void> {
    await this.engine.reset();
  }

  /**
   * The most liquid markets available, for the backtest market picker.
   *
   * @param limit how many to return.
   * @returns tickers sorted by 24h volume, most liquid first.
   */
  async markets(limit = 30): Promise<Ticker[]> {
    const tickers = await this.market.tickers();
    return tickers.filter((t) => isCryptoPerp(t.symbol)).slice(0, limit);
  }

  /**
   * Chart data for one symbol on the exact timeframes the strategy trades on —
   * the entry candles it scores, the higher timeframe it must align with, and
   * the freshly rebuilt signal so the chart can draw the same swing, golden
   * zone and stop/target lines the engine is actually watching right now.
   *
   * @param symbol contract symbol, e.g. `BTC_USDT`.
   * @returns entry/higher candles plus the current signal for that symbol, or
   *   `signal: null` when there is not enough history to score it yet.
   */
  async chartData(symbol: string, interval = 'Min60'): Promise<ChartData> {
    let candles: Candle[] = [];
    let higherCandles: Candle[] = [];
    let ticker: Ticker | undefined;
    let fetchError: string | undefined;

    const confirmInterval =
      interval === 'Min5' ? 'Min15' :
      interval === 'Min15' ? 'Min60' :
      interval === 'Hour4' ? 'Day1' :
      CONFIRM_INTERVAL;

    try {
      [candles, higherCandles, ticker] = await Promise.all([
        this.market.candles(symbol, interval),
        this.market.candles(symbol, confirmInterval).catch(() => []),
        this.market.tickers().then((all) => all.find((t) => t.symbol === symbol)).catch(() => undefined),
      ]);
    } catch (err) {
      fetchError = (err as Error).message;
      candles = this.market.getCachedCandles(symbol, interval) || [];
      higherCandles = this.market.getCachedCandles(symbol, confirmInterval) || [];
    }

    const btcCandles = symbol !== 'BTC_USDT' ? this.market.getCachedCandles('BTC_USDT', interval) || [] : [];
    const signal =
      ticker && candles.length >= 30
        ? buildSignal(ticker, candles, higherCandles, [], undefined, btcCandles, 'BTC_USDT')
        : null;
    const open = await this.store.positions('OPEN').catch(() => []);
    const position = open.find((p) => p.symbol === symbol) || null;
    let plannedTrade: TradePlan | null = null;
    if (signal) {
      try {
        const account = await this.engine.account();
        plannedTrade = planTrade(signal, account, this.engine.config);
      } catch {
        // Fall back gracefully if account or planTrade fails
      }
    }

    // Slice candles to keep payload light and fast (~40KB instead of 460KB)
    const recentCandles = candles.slice(-240);
    const recentHigherCandles = higherCandles.slice(-120);

    return {
      symbol,
      entryInterval: interval,
      confirmInterval,
      candles: recentCandles,
      higherCandles: recentHigherCandles,
      signal,
      position,
      plannedTrade,
      error: fetchError,
    };
  }

  /**
   * Start a historical replay of the strategy.
   *
   * @param config the run parameters.
   * @returns the initial status; poll {@link backtestStatus} for progress.
   */
  startBacktest(config: Partial<BacktestConfig>): BacktestStatus {
    this.backtests.start(config as BacktestConfig);
    return this.backtests.state;
  }

  /** Progress and result of the most recent backtest. */
  backtestStatus(): BacktestStatus {
    return this.backtests.state;
  }

  /**
   * Evaluate the current strategy across many overlapping 300-day windows.
   *
   * @param config the markets and timeframe to evaluate.
   * @param risk risk overrides applied to every window.
   * @returns the initial status; poll {@link walkForwardStatus} for progress.
   */
  startWalkForward(
    config: Partial<BacktestConfig>,
    risk?: Partial<RiskConfig>
  ): WalkForwardStatus {
    this.walkForward.start(config, risk);
    return this.walkForward.state;
  }

  /** Progress and result of the most recent walk-forward analysis. */
  walkForwardStatus(): WalkForwardStatus {
    return this.walkForward.state;
  }

  /**
   * Search parameter combinations against historical data.
   *
   * @param config the window and markets to optimise over.
   * @returns the initial status; poll {@link optimizeStatus} for progress.
   */
  startOptimize(config: Partial<BacktestConfig>): OptimizeStatus {
    this.optimizer.start(config);
    return this.optimizer.state;
  }

  /** Progress and results of the most recent parameter search. */
  optimizeStatus(): OptimizeStatus {
    return this.optimizer.state;
  }

  /**
   * Approve a market scout candidate, admitting it into the live scanning universe.
   *
   * @param symbol the pending candidate to approve.
   * @returns true when the symbol was pending and is now admitted.
   */
  async approveScoutCandidate(symbol: string): Promise<boolean> {
    return this.scout.approve(symbol);
  }

  /**
   * Dismiss a market scout candidate without admitting it.
   *
   * @param symbol the pending candidate to dismiss.
   * @returns true when the symbol was pending and is now dismissed.
   */
  async dismissScoutCandidate(symbol: string): Promise<boolean> {
    return this.scout.dismiss(symbol);
  }

  /**
   * Place a tiny real market order directly on MEXC, bypassing the strategy
   * and paper engine entirely — a one-off connectivity check so a freshly
   * pasted API key/secret can be proven to actually place and fill an order
   * before trusting it to the autonomous engine.
   *
   * Refuses to run unless credentials are configured; does NOT require
   * `LIVE_TRADING_ENABLED` — that flag gates the autonomous engine's own
   * order flow, not this manual, explicitly-triggered probe. The order is
   * opened and, unless `keepOpen` is set, immediately closed again at market
   * so it does not linger as a real position after the check.
   *
   * @param symbol contract symbol, e.g. `BTC_USDT`.
   * @param side direction to test, defaults to `LONG`.
   * @param usdtAmount notional size in USDT to risk on the test order, e.g. 1 for $1.
   * @param leverage leverage to open the test order with, defaults to 5x.
   * @param keepOpen when true, leaves the resulting position open instead of
   *   immediately closing it again.
   * @returns the opened order id, the computed order size, and — unless kept
   *   open — the closing order id.
   * @throws when no exchange credentials are configured, when the notional is
   *   too small to satisfy the venue's minimum order size, or when either
   *   order is rejected by MEXC.
   */
  async placeTestOrder(
    symbol: string,
    side: 'LONG' | 'SHORT' = 'LONG',
    usdtAmount = 1,
    leverage = 5,
    keepOpen = false,
    tpPct = 3,
    slPct = 2
  ): Promise<{ orderId: string; vol: number; price: number; tpPrice: number; slPrice: number; closeOrderId: string | null }> {
    if (!this.exchange.isConfigured()) {
      throw new Error(
        'MEXC API-sleutel ontbreekt — koppel eerst je eigen sleutel voordat je een testorder plaatst.'
      );
    }
    if (!(usdtAmount > 0)) throw new Error('bedrag (USDT) moet groter dan 0 zijn');

    const [price, detail] = await Promise.all([
      this.market.price(symbol),
      this.market.contractDetail(symbol),
    ]);
    if (!price) throw new Error(`geen live prijs beschikbaar voor ${symbol}`);

    // notional = vol * contractSize * price  =>  vol = notional / (contractSize * price)
    const rawVol = (usdtAmount * leverage) / (detail.contractSize * price);
    const vol = Math.max(detail.minVol, Math.round(rawVol));
    if (vol > detail.maxVol) {
      throw new Error(`bedrag te groot — max ordergrootte voor ${symbol} is ${detail.maxVol} contracten`);
    }

    await this.exchange.setLeverage(symbol, leverage, side, 'isolated');

    const scale = detail.priceScale ?? 4;
    const tpPrice = side === 'LONG'
      ? +(price * (1 + tpPct / 100)).toFixed(scale)
      : +(price * (1 - tpPct / 100)).toFixed(scale);
    const slPrice = side === 'LONG'
      ? +(price * (1 - slPct / 100)).toFixed(scale)
      : +(price * (1 + slPct / 100)).toFixed(scale);

    const opened = await this.exchange.placeMarketOrder({
      symbol,
      intent: side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
      vol,
      leverage,
      openType: 'isolated',
      externalOid: `test-${Date.now()}`,
      takeProfitPrice: tpPrice,
      stopLossPrice: slPrice,
    });

    await this.store.addEvent({
      at: Date.now(),
      level: 'warn',
      message: `🧪 Testorder geplaatst: ${side} ${vol} contracten ${symbol} @ ~${price} (TP: ${tpPrice}, SL: ${slPrice}, order ${opened.orderId})${keepOpen ? '' : ' — wordt direct weer gesloten'}.`,
    });
    void notify({
      kind: 'trade-open',
      message: `Testorder geplaatst op MEXC: ${side} ${symbol}, ${usdtAmount} USDT notional, TP: ${tpPrice}, SL: ${slPrice}, order ${opened.orderId}.`,
    });

    if (keepOpen) {
      return { orderId: opened.orderId, vol, price, tpPrice, slPrice, closeOrderId: null };
    }

    const closed = await this.exchange.closePosition({ symbol, side, vol, externalOid: `test-close-${Date.now()}` });
    await this.exchange.cancelAllPlanOrders(symbol);
    await this.store.addEvent({
      at: Date.now(),
      level: 'info',
      message: `🧪 Testorder direct weer gesloten: ${symbol} (sluitorder ${closed.orderId}). Verbinding met MEXC werkt.`,
    });

    return { orderId: opened.orderId, vol, price, tpPrice, slPrice, closeOrderId: closed.orderId };
  }

  /**
   * Fully close a real position on the exchange, using the venue's own
   * reported open volume rather than any locally-estimated size.
   *
   * This is the safety-net counterpart to {@link placeTestOrder}: a test
   * order (or any live entry) can end up larger than expected — the venue may
   * merge repeated same-side opens into one position — so closing must always
   * read the real `getOpenPositions()` volume for the symbol and close exactly
   * that, not a recomputed test amount that could leave a remainder exposed.
   *
   * @param symbol contract symbol to flatten, e.g. `DOGE_USDT`.
   * @returns the closing order id, or null if there was nothing open.
   */
  async flattenExchangePosition(symbol: string): Promise<{ orderId: string; vol: number } | null> {
    const positions = await this.exchange.getOpenPositions();
    const position = positions.find((p) => p.symbol === symbol);
    if (!position || position.vol <= 0) return null;
    const closed = await this.exchange.closePosition({
      symbol,
      side: position.side,
      vol: position.vol,
      externalOid: `flatten-${Date.now()}`,
    });
    await this.store.addEvent({
      at: Date.now(),
      level: 'warn',
      message: `🔴 Live positie handmatig volledig gesloten: ${symbol} ${position.side} ${position.vol} contracten (sluitorder ${closed.orderId}).`,
    });
    return { orderId: closed.orderId, vol: position.vol };
  }

  /**
   * Apply the best parameter set found by the optimizer to the live engine.
   *
   * @returns the updated risk profile.
   * @throws when no search has completed yet.
   */
  applyBestParams(): RiskConfig {
    const best = this.optimizer.state.best;
    if (!best) throw new Error('nog geen optimalisatieresultaat om toe te passen');
    return this.engine.setRisk(best.params);
  }

  /**
   * Simulate a price for one market and run exit management against it.
   *
   * Used to verify take-profit, break-even and stop behaviour without waiting for
   * the live market to reach those levels.
   *
   * @param symbol the market to move.
   * @param price the price to simulate.
   * @returns positions in that symbol still open afterwards.
   */
  async simulatePrice(symbol: string, price: number): Promise<Position[]> {
    return this.engine.simulatePrice(symbol, price);
  }

  /**
   * Whether a live MEXC exchange connection is configured and armed.
   *
   * Safe to expose to the dashboard as-is: it never leaks the credentials
   * themselves, only whether they are present and whether `LIVE_TRADING_ENABLED`
   * has been switched on.
   *
   * @returns the live-trading readiness of this deployment.
   */
  exchangeStatus(): LiveTradingStatus {
    return this.exchange.status();
  }

  /**
   * Save a MEXC API key/secret pasted in from the dashboard and switch the
   * running exchange adapter to use them immediately.
   *
   * This is what makes the deployment shareable: whoever runs it pastes in
   * their own MEXC credentials from the UI, and from that point on the engine
   * talks to their account — no access to `MEXC_API_KEY`/`MEXC_API_SECRET` in
   * the hosting environment is required. Saving empty strings disconnects the
   * exchange and drops the deployment back to paper trading.
   *
   * @param apiKey the MEXC API key, or '' to disconnect.
   * @param apiSecret the MEXC API secret, or '' to disconnect.
   * @returns the resulting live-trading status.
   */
  async saveExchangeCredentials(apiKey: string, apiSecret: string): Promise<LiveTradingStatus> {
    await this.store.saveExchangeCredentials({ apiKey, apiSecret });
    this.exchange.setCredentials(apiKey, apiSecret);
    process.env.MEXC_API_KEY = apiKey;
    process.env.MEXC_API_SECRET = apiSecret;
    if (!apiKey || !apiSecret) process.env.LIVE_TRADING_ENABLED = 'false';
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const envPath = path.resolve(process.cwd(), '.env');
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      content = content.replace(/^MEXC_API_KEY=.*$/m, '').replace(/^MEXC_API_SECRET=.*$/m, '').trim();
      if (apiKey && apiSecret) {
        content = `${content}\nMEXC_API_KEY=${apiKey}\nMEXC_API_SECRET=${apiSecret}\n`.trim() + '\n';
      }
      fs.writeFileSync(envPath, content, 'utf8');
    } catch {
      // ignore
    }
    await this.store.addEvent({
      at: Date.now(),
      level: 'info',
      message:
        apiKey && apiSecret
          ? 'MEXC API-sleutel opgeslagen — koppeling klaar, live uitvoering nog uitgeschakeld.'
          : 'MEXC API-sleutel verwijderd — engine terug naar paper trading.',
    });
    return this.exchange.status();
  }

  /**
   * Arm or disarm live MEXC order execution at runtime.
   *
   * This flips the same `LIVE_TRADING_ENABLED` gate {@link isLiveTradingEnabled}
   * checks, so the dashboard toggle and the environment variable are always in
   * sync — whichever set it last wins, and every exchange call keeps re-reading
   * it fresh rather than caching a stale value. Arming is refused outright when
   * no credentials are configured on the running exchange adapter — checked via
   * `this.exchange.isConfigured()`, which is true for keys pasted into the
   * dashboard (see `saveExchangeCredentials`) as well as `MEXC_API_KEY`/
   * `MEXC_API_SECRET` env vars. Previously this checked the env vars only, so a
   * key saved from the UI was silently ignored and arming always failed with a
   * "not configured" error even right after a successful save. Disarming
   * always succeeds — dropping back to paper trading is never blocked.
   *
   * @param armed true to enable live order execution, false to return to paper trading.
   * @returns the resulting live-trading status.
   * @throws when arming is requested but no exchange credentials are configured.
   */
  async setLiveTrading(armed: boolean): Promise<LiveTradingStatus> {
    if (armed && !this.exchange.isConfigured()) {
      throw new Error(
        'MEXC API-sleutel en secret zijn nog niet ingesteld \u2014 live uitvoering kan niet worden ingeschakeld zonder API-sleutels.'
      );
    }
    process.env.LIVE_TRADING_ENABLED = armed ? 'true' : 'false';
    const creds = await this.store.exchangeCredentials();
    if (creds.apiKey && creds.apiSecret) {
      await this.store.saveExchangeCredentials(creds);
    }
    const status = this.exchange.status();
    await this.store.addEvent({
      at: Date.now(),
      level: armed ? 'warn' : 'info',
      message: armed
        ? '\uD83D\uDD34 Live order-uitvoering INGESCHAKELD \u2014 de engine plaatst vanaf nu echte orders op MEXC.'
        : '\uD83D\uDFE2 Live order-uitvoering uitgeschakeld \u2014 engine handelt weer volledig op papier.',
    });
    void notify({
      kind: armed ? 'risk-halt' : 'trade-close',
      message: armed
        ? 'Live order-uitvoering ingeschakeld op de trading engine.'
        : 'Live order-uitvoering uitgeschakeld \u2014 terug naar paper trading.',
    });
    return status;
  }

  /**
   * Create a wired trading service with live market data and paper execution.
   *
   * @param tenantId owner of this instance's paper account, MEXC connection and
   *   history — `'main'` for the deployment owner, or a per-browser client id
   *   for anyone else using a shared link. Each tenant gets a fully isolated
   *   {@link Store} and {@link Engine}; only the public market-data cache
   *   ({@link MarketData}) is shared, since it carries no user-specific state.
   * @param market shared market-data client, reused across tenants.
   * @returns a ready-to-init service instance.
   */
  static from(tenantId = 'main', market: MarketData = new MarketData()): TradingService {
    const store = new Store(tenantId);
    // Shared with the engine so a credential save from the dashboard (via
    // `saveExchangeCredentials` below) is visible to the same instance the
    // engine mirrors live orders through — no separate sync path needed.
    const exchange = new MexcExchangeAdapter();
    const engine = new Engine(store, market, undefined, undefined, undefined, exchange);
    const scout = new MarketScout(
      market,
      store,
      (symbol) => engine.addUniverseSymbol(symbol),
      (level, message) => store.addEvent({ at: Date.now(), level, message })
    );
    return new TradingService(
      store,
      engine,
      market,
      new BacktestRunner(market),
      new OptimizerRunner(market),
      new WalkForwardRunner(market),
      scout,
      exchange
    );
  }
}

/**
 * Compute aggregate performance statistics from closed trades.
 *
 * @param closed closed positions.
 * @returns win rate, averages, profit factor and extremes.
 */
export function computeStats(closed: Position[]): Stats {
  const settled = closed.filter((p) => typeof p.pnl === 'number');
  const wins = settled.filter((p) => (p.pnl as number) > 0);
  const losses = settled.filter((p) => (p.pnl as number) <= 0);
  const sum = (items: Position[]) => items.reduce((a, b) => a + (b.pnl as number), 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  if (!settled.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      bestTrade: 0,
      worstTrade: 0,
    };
  }
  return {
    trades: settled.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length ? wins.length / settled.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    bestTrade: settled.length ? Math.max(...settled.map((p) => p.pnl as number)) : 0,
    worstTrade: settled.length ? Math.min(...settled.map((p) => p.pnl as number)) : 0,
  };
}

export { Engine } from './engine.js';
export { MarketData } from './market-data.js';
export { Store } from './store.js';
export { DEFAULT_RISK } from './risk.js';
export { Backtest } from './backtest.js';
export { BacktestRunner } from './backtest-runner.js';
export { Optimizer, buildGrid, score } from './optimizer.js';
export { OptimizerRunner } from './optimizer-runner.js';
export {
  MexcExchangeAdapter,
  hasExchangeCredentials,
  isLiveTradingEnabled,
} from './exchange-adapter.js';
export type {
  ClosePositionInput,
  ExchangeAccountAsset,
  ExchangeOrderResult,
  ExchangePosition,
  LiveTradingStatus,
  OpenType,
  OrderIntent,
  PlaceOrderInput,
} from './exchange-adapter.js';
export type {
  Account,
  BacktestConfig,
  BacktestResult,
  BacktestStatus,
  BacktestTrade,
  BlockedState,
  EngineEvent,
  EquityPoint,
  OptimizeStatus,
  OptimizeTrial,
  Position,
  RiskConfig,
  Signal,
  TradePlan,
  Side,
  Regime,
  Candle,
  Ticker,
} from './types.js';
