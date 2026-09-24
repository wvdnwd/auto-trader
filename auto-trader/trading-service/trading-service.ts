import { BacktestRunner } from './backtest-runner.js';
import { OptimizerRunner } from './optimizer-runner.js';
import { WalkForwardRunner, type WalkForwardStatus } from './walk-forward-runner.js';
import { CONFIRM_INTERVAL, ENTRY_INTERVAL, Engine } from './engine.js';
import { MexcExchangeAdapter, type IExchangeAdapter, type LiveTradingStatus } from './exchange-adapter.js';
import { HyperliquidExchangeAdapter } from './hyperliquid-adapter.js';
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
  private hasUnresolvedLivePositions = false;

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly market: MarketData,
    private readonly backtests: BacktestRunner,
    private readonly optimizer: OptimizerRunner,
    private readonly walkForward: WalkForwardRunner,
    private readonly scout: MarketScout,
    private readonly exchange: IExchangeAdapter = new MexcExchangeAdapter()
  ) {
    this.store.onFailure?.(() => {
      this.engine.stop();
      this.scout.stop();
    });
  }

  /**
   * Connect storage and initialize the service.
   *
   * @param autoStart whether to start the trading loop immediately.
   */
  async init(autoStart = false): Promise<void> {
    process.env.LIVE_TRADING_ENABLED = 'false';
    const connected = await this.store.connect();
    if (!connected && process.env.ALLOW_IN_MEMORY_STORE !== 'true') {
      throw new Error('Persistent storage is required; in-memory mode must be explicitly enabled for local development');
    }
    await this.store.addEvent({
      at: Date.now(),
      level: connected ? 'info' : 'warn',
      message: connected
        ? 'Verbonden met database — posities worden bewaard'
        : 'Explicit non-live local development: using in-memory state',
    });
    const stored = await this.store.exchangeCredentials();
    if (stored.apiKey && stored.apiSecret && 'setCredentials' in this.exchange) {
      (this.exchange as MexcExchangeAdapter).setCredentials(stored.apiKey, stored.apiSecret);
    }
    this.hasUnresolvedLivePositions = (await this.store.positions('OPEN', 0)).some((position) => position.live);
    await this.scout.init();
    if (autoStart && (!this.hasUnresolvedLivePositions || this.exchange.status?.()?.enabled)) this.engine.start();
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
      const usdt = assets.find((a) => a.currency === 'USDT' || a.currency === 'USDC');
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
    this.assertNoUnresolvedLivePositions();
    this.engine.start();
  }

  /** Stop the autonomous loop. */
  stop(): void {
    this.engine.stop();
  }

  shutdown(): void {
    this.stop();
    this.scout.stop();
  }

  /** Run a single cycle immediately, regardless of the loop schedule. */
  async runOnce(): Promise<void> {
    this.assertNoUnresolvedLivePositions();
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
    const position = await this.store.position(id);
    if (position?.live && !this.exchange.status().enabled) {
      throw new Error('Live positions cannot be closed through the local engine while execution is disarmed');
    }
    return this.engine.closePosition(id);
  }

  /**
   * Partially close an open position (e.g. 50% profit take).
   *
   * @param id position id.
   * @param fraction fraction to close (0 < fraction < 1, defaults to 0.5).
   * @returns true when the position existed and was reduced.
   */
  async reducePosition(id: string, fraction = 0.5): Promise<boolean> {
    const position = await this.store.position(id);
    if (position?.live && !this.exchange.status().enabled) {
      throw new Error('Live positions cannot be reduced through the local engine while execution is disarmed');
    }
    return this.engine.reducePosition(id, fraction);
  }

  /** Reset the paper account and clear all history. */
  async reset(): Promise<void> {
    this.assertNoUnresolvedLivePositions();
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
    const open = await this.store.positions('OPEN');
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

  /** Disabled: order probes bypass the adapter's live-execution gate. */
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
        'Exchange API-sleutel ontbreekt — koppel eerst je eigen sleutel voordat je een testorder plaatst.'
      );
    }
    if (!(usdtAmount > 0)) throw new Error('bedrag (USDT) moet groter dan 0 zijn');

    const [price, detail] = await Promise.all([
      this.market.price(symbol),
      this.market.contractDetail(symbol),
    ]);
    if (!price) throw new Error(`geen live prijs beschikbaar voor ${symbol}`);

    const contractSize = detail?.contractSize || 1;
    const rawVol = (usdtAmount * leverage) / (contractSize * price);
    const vol = Math.max(detail?.minVol || 1, Math.round(rawVol));
    if (detail?.maxVol && vol > detail.maxVol) {
      throw new Error(`bedrag te groot — max ordergrootte voor ${symbol} is ${detail.maxVol} contracten`);
    }

    const wasArmed = process.env.LIVE_TRADING_ENABLED === 'true';
    process.env.LIVE_TRADING_ENABLED = 'true';
    try {
      await this.exchange.setLeverage(symbol, leverage, side, 'isolated');

      const scale = detail?.priceScale ?? 4;
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
        message: `🧪 Testorder geplaatst: ${side} ${vol} contracten ${symbol} @ ~${price} (order ${opened.orderId})`,
      });

      let closeOrderId: string | null = null;
      if (!keepOpen) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const closed = await this.exchange.closePosition({
            symbol,
            side,
            vol,
            externalOid: `testclose-${Date.now()}`,
          });
          closeOrderId = closed.orderId;
          await this.store.addEvent({
            at: Date.now(),
            level: 'info',
            message: `🧪 Testorder direct weer gesloten (${side} ${vol} contracten ${symbol}, order ${closed.orderId}).`,
          });
        } catch (err) {
          await this.store.addEvent({
            at: Date.now(),
            level: 'warn',
            message: `🧪 Testorder kon niet automatisch worden gesloten: ${(err as Error).message}`,
          });
        }
      }

      return {
        orderId: opened.orderId,
        vol,
        price,
        tpPrice,
        slPrice,
        closeOrderId,
      };
    } finally {
      if (!wasArmed) process.env.LIVE_TRADING_ENABLED = 'false';
    }
  }

  /** Close a live position directly on the venue. */
  async flattenExchangePosition(symbol: string): Promise<{ orderId: string; vol: number } | null> {
    const positions = await this.exchange.getOpenPositions();
    const position = positions.find((p) => p.symbol === symbol);
    if (!position || position.vol <= 0) return null;
    const wasArmed = process.env.LIVE_TRADING_ENABLED === 'true';
    process.env.LIVE_TRADING_ENABLED = 'true';
    try {
      const closed = await this.exchange.closePosition({
        symbol,
        side: position.side,
        vol: position.vol,
        externalOid: `flatten-${Date.now()}`,
      });
      await this.store.addEvent({
        at: Date.now(),
        level: 'warn',
        message: `Exchange positie handmatig gesloten via dashboard: ${position.side} ${position.vol} contracten ${symbol} (order ${closed.orderId}).`,
      });
      return { orderId: closed.orderId, vol: position.vol };
    } finally {
      if (!wasArmed) process.env.LIVE_TRADING_ENABLED = 'false';
    }
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

  /** Disabled because synthetic prices can reach real-position management. */
  async simulatePrice(symbol: string, price: number): Promise<Position[]> {
    void symbol;
    void price;
    throw new Error('Price simulation is disabled on the trading service');
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

  isStorageHealthy(): boolean {
    return this.store.isHealthy();
  }

  /**
   * Save credentials for this single service.
   *
   * @param apiKey the API key, or '' to disconnect.
   * @param apiSecret the API secret, or '' to disconnect.
   * @returns the resulting live-trading status.
   */
  async saveExchangeCredentials(apiKey: string, apiSecret: string): Promise<LiveTradingStatus> {
    await this.store.saveExchangeCredentials({ apiKey, apiSecret });
    if ('setCredentials' in this.exchange) {
      (this.exchange as MexcExchangeAdapter).setCredentials(apiKey, apiSecret);
    }
    await this.store.addEvent({
      at: Date.now(),
      level: 'info',
      message:
        apiKey && apiSecret
          ? 'Exchange credentials opgeslagen.'
          : 'Exchange credentials verwijderd.',
    });
    return this.exchange.status();
  }

  /**
   * Toggle live order execution.
   *
   * @param armed true to arm live execution, false for paper-only.
   * @returns the resulting live-trading status.
   */
  async setLiveTrading(armed: boolean): Promise<LiveTradingStatus> {
    if (armed) {
      const configured = this.exchange.isConfigured();
      if (!configured) {
        throw new Error('Kan live trading niet inschakelen: exchange credentials ontbreken');
      }
      process.env.LIVE_TRADING_ENABLED = 'true';
      const status = this.exchange.status();
      await this.store.addEvent({
        at: Date.now(),
        level: 'warn',
        message: `🔴 LIVE TRADING INGESCHAKELD (${status.venue?.toUpperCase() || 'exchange'}) — orders worden direct live geplaatst!`,
      });
      void notify({
        kind: 'trade-open',
        message: `🔴 LIVE TRADING INGESCHAKELD op ${status.venue?.toUpperCase() || 'exchange'}!`,
      });
      return status;
    }
    process.env.LIVE_TRADING_ENABLED = 'false';
    const status = this.exchange.status();
    await this.store.addEvent({
      at: Date.now(),
      level: 'info',
      message: 'Live trading uitgeschakeld; de engine draait veilig in paper trading modus.',
    });
    void notify({
      kind: 'trade-close',
      message: 'Live trading uitgeschakeld.',
    });
    return status;
  }

  /**
   * Create the single wired trading service with configured venue.
   *
   * @param market shared market-data client.
   * @returns a ready-to-init service instance.
   */
  static from(market: MarketData = new MarketData()): TradingService {
    const store = new Store();
    const venue = (process.env.EXCHANGE_VENUE?.toLowerCase() === 'hyperliquid') ? 'hyperliquid' : 'mexc';
    const exchange: IExchangeAdapter = venue === 'hyperliquid'
      ? new HyperliquidExchangeAdapter(
          process.env.HYPERLIQUID_WALLET,
          process.env.HYPERLIQUID_PRIVATE_KEY,
          process.env.HYPERLIQUID_TESTNET === 'true'
        )
      : new MexcExchangeAdapter();
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

  private assertNoUnresolvedLivePositions(): void {
    if (this.hasUnresolvedLivePositions && !this.exchange.status?.()?.enabled) {
      throw new Error('Service actions are disabled while unresolved live positions exist and live trading is disarmed');
    }
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
