/** Trade direction of a futures position. */
export type Side = 'LONG' | 'SHORT';

/** A single OHLCV candle. */
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Market regime detected by the strategy engine. */
export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'CHOP';

/** One Fibonacci level: the ratio and the price it maps to. */
export type FibLevel = {
  ratio: number;
  price: number;
};

/** Fibonacci retracement/extension levels off the dominant recent swing. */
export type FibLevels = {
  swingHigh: number;
  swingLow: number;
  /** `UP` when the low printed before the high (impulse up, retracements pull back down). */
  direction: 'UP' | 'DOWN';
  /** 0.236 / 0.382 / 0.5 / 0.618 / 0.786, ordered by ratio ascending. */
  retracements: FibLevel[];
  /** 1.272 / 1.618 / 2.0, ordered by ratio ascending. */
  extensions: FibLevel[];
  /** The retracement level closest to the reference price. */
  nearest: FibLevel;
  /** Distance from the reference price to `nearest`, as a ratio of the swing range. */
  distanceToNearest: number;
};

/** A scored trading opportunity. */
export type Signal = {
  symbol: string;
  side: Side;
  confidence: number;
  regime: Regime;
  price: number;
  atrPct: number;
  reasons: string[];
  /** Regime on the higher timeframe. */
  higherRegime: Regime;
  /** Whether the higher timeframe confirms the direction. */
  alignedWithHigher: boolean;
  swingLow: number;
  swingHigh: number;
  /** Distance to the nearest opposing level, in R multiples. */
  roomToStructure: number;
  /** Named entry conditions and whether the market met them. */
  checks: SignalCheck[];
  /** Fibonacci retracement/extension levels off the dominant recent swing, when computable. */
  fib: FibLevels | null;
  /** Leverage the engine would use for this signal today, or null if it would not currently qualify for entry. */
  plannedLeverage: number | null;
  /** Market structure analysis: BOS, MSS/CHoCH, FVG, Order Block, and Premium/Discount zone. */
  marketStructure?: MarketStructureInfo | null;
};

export type PivotType = 'HH' | 'HL' | 'LH' | 'LL';

export type PivotPoint = {
  type: PivotType;
  price: number;
  index: number;
  time: number;
};

export type StructureBreak = {
  type: 'BOS' | 'CHoCH' | 'MSS';
  direction: 'BULLISH' | 'BEARISH';
  brokenLevel: number;
  candleIndex: number;
  time: number;
  displacement: boolean;
};

export type FairValueGap = {
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  midpoint: number;
  candleIndex: number;
  time: number;
  mitigated: boolean;
  mitigatedAt?: number;
};

export type OrderBlock = {
  direction: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  candleIndex: number;
  time: number;
  mitigated: boolean;
};

export type DealingRange = {
  high: number;
  low: number;
  equilibrium: number;
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  relativePosition: number;
};

export type MarketStructureInfo = {
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  recentPivots: PivotPoint[];
  lastBreak?: StructureBreak | null;
  activeFVGs: FairValueGap[];
  nearestOrderBlock?: OrderBlock | null;
  dealingRange?: DealingRange | null;
  liquiditySwept?: {
    type: 'BSL' | 'SSL';
    level: number;
    time: number;
  } | null;
  imbalanceScalp?: {
    eligible: boolean;
    side: Side;
    targetPrice: number;
    targetReason: string;
    stopLoss: number;
    rrEstimate: number;
  } | null;
  volumeProfile?: {
    poc: number;
    vah: number;
    val: number;
  } | null;
  smtDivergence?: {
    type: 'BULLISH' | 'BEARISH';
    reason: string;
    benchmarkSymbol: string;
  } | null;
};

/** An open or closed paper position. */
export type Position = {
  id: string;
  symbol: string;
  side: Side;
  entry: number;
  quantity: number;
  leverage: number;
  margin: number;
  notional: number;
  stopLoss: number;
  takeProfit: number;
  /** Staged profit targets, nearest first. */
  takeProfits: TakeProfitLevel[];
  /** Quantity still open after partial take-profit fills. */
  remainingQuantity: number;
  /** Profit already booked from partial exits. */
  realisedPnl: number;
  /** True once the stop was moved to entry after the first target. */
  breakEven: boolean;
  trailingArmed: boolean;
  /** True once this position has already been trimmed for an adverse regime flip. */
  regimeTrimmed?: boolean;
  openedAt: number;
  closedAt?: number;
  exit?: number;
  pnl?: number;
  pnlPct?: number;
  exitReason?: string;
  /** Present on closed trades only. */
  status: 'OPEN' | 'CLOSED';
  confidence: number;
  regime: Regime;
  reasons: string[];
  /** True when this position was mirrored onto the real MEXC account at entry. */
  live?: boolean;
  scaleInCount?: number;
  scaledInAt?: number;
  scaleInMargin?: number;
  initialRisk?: number;
  /** Post-mortem analysis generated when the position closes. */
  postMortem?: TradePostMortem;
  /** Checks that were evaluated at entry, kept for post-mortem analysis. */
  entryChecks?: SignalCheck[];
};

/** Post-mortem diagnosis of a completed trade. */
export type TradePostMortem = {
  verdict: 'WIN' | 'LOSS' | 'BREAK_EVEN';
  rMultiple: number;
  netPnl: number;
  durationMinutes: number;
  entryFactors: string[];
  whatWentWell: string[];
  whatWentWrong: string[];
  lesson: string;
};

/** Historical performance statistics for a technical factor/indicator. */
export type FactorStat = {
  wins: number;
  losses: number;
  netR: number;
};

/** Temporary trading penalty (strafbankje) for underperforming symbols. */
export type SymbolPenalty = {
  symbol: string;
  consecutiveLosses: number;
  penalizedUntil?: number;
  reason?: string;
};

/** Self-learning adaptive state tracked across cycles. */
export type LearningState = {
  factorStats: Record<string, FactorStat>;
  penalties: Record<string, SymbolPenalty>;
};

/** One named entry condition and its outcome. */
export type SignalCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

/** A staged profit target that closes part of the position when hit. */
export type TakeProfitLevel = {
  price: number;
  /** Fraction of the original quantity closed here. */
  portion: number;
  /** Reward multiple of the initial risk. */
  rMultiple: number;
  hit: boolean;
  hitAt?: number;
  realised?: number;
};

/** Account snapshot of the paper engine. */
export type Account = {
  balance: number;
  equity: number;
  usedMargin: number;
  realisedPnl: number;
  unrealisedPnl: number;
  startingBalance: number;
  peakEquity: number;
  drawdownPct: number;
};

/** Risk configuration driving sizing and leverage. */
export type RiskConfig = {
  baseRiskPct: number;
  maxRiskPct: number;
  maxLeverage: number;
  minLeverage: number;
  maxOpenPositions: number;
  maxTotalMarginPct: number;
  maxDrawdownPct: number;
  dailyLossLimitPct: number;
  minConfidence: number;
  maxPositionHours: number;
  /** ATR multiple used for the stop in a trending market. */
  atrStopMultiple: number;
  /** Profit in R at which the trailing stop arms. */
  trailArmR: number;
  /** Fraction of the risk distance given back once trailing. */
  trailGiveback: number;
  /** Reward multiple of the first take-profit rung. */
  firstTargetR: number;
  /** Fraction of the position closed at the first rung. */
  firstTargetPortion: number;
  /** Reward multiple of the final rung. */
  finalTargetR: number;
  /** Move the stop to entry once the first target fills. */
  breakEvenAfterFirst: boolean;
  /** Only take trades the higher timeframe actively confirms. */
  requireHigherAlignment: boolean;
  /** Max positions allowed on the same side at once. */
  maxSameSidePositions: number;
  /** Max positions per correlation group. */
  maxPerGroup: number;
  /** Ceiling of the confidence-scaled stake range, as a fraction of equity, e.g. 0.2 = 20%. */
  targetStakePct?: number;
  /** Floor of the confidence-scaled stake range, as a fraction of equity. */
  minStakePct?: number;
  /** Confidence (0..1) considered high conviction — reaches the stake ceiling and unlocks overflow slots. */
  highConvictionConfidence: number;
  /** Extra positions allowed beyond maxOpenPositions for a high-conviction signal. */
  maxOverflowPositions: number;
  /** Consecutive dead-signal scan cycles before new entries pause for a lack of trending edge. */
  chopPauseStreak: number;
  /** Turbo mode — higher leverage ceiling in calm/medium volatility and faster profit-banking, for a smaller starting balance. */
  turboMode?: boolean;
  /** Trim part of an open position as soon as the market regime flips against it. */
  trendFlipProtection: boolean;
  /** Fraction of the remaining position closed when a trend-flip trim fires. */
  trendFlipTrimPortion: number;
  /** Cooldown in minutes between consecutive new entries (0 to disable). */
  entryCooldownMinutes?: number;
  /** Hard floor on margin committed to a single trade in quote currency (USDT). Never open below this amount. */
  minTradeMarginUsdt?: number;
  /** Only take altcoin longs that outperform/match Bitcoin (relative strength filter). */
  rsFilterEnabled?: boolean;
  /** Maximum funding rate for longs (e.g. 0.0005 = +0.05% per 8h). Blocks longs if market is crowded. */
  maxFundingRateLong?: number;
  /** Minimum funding rate for shorts (e.g. -0.0005 = -0.05% per 8h). Blocks shorts if shorts are crowded. */
  minFundingRateShort?: number;
  /** Require 15m candle reversal confirmation before entering pullbacks. */
  reversal15mRequired?: boolean;
  /** Allow scaling into (pyramiding) winning positions when confidence is very high and existing position is derisked. */
  pyramidingEnabled?: boolean;
  /** Minimum confidence required for a 2nd tranche entry (default 0.85). */
  pyramidMinConfidence?: number;
  /** Gatekeeper: require price to be in a pullback (near EMA21 or inside Fib golden zone) rather than overextended. */
  pullbackFilterEnabled?: boolean;
  /** Override the daily loss halt — allow new entries even after the daily loss limit is reached. Reset automatically at the next daily rollover. */
  ignoreDailyLimit?: boolean;
  /** Breakout Momentum Bypass: allow immediate entry on explosive volume surges (>= 1.8x) without waiting for a pullback. */
  breakoutBypassEnabled?: boolean;
  /** Dynamic Altcoin Runners: expand far take-profit target up to 5.0R on high-conviction breakout runners after TP1 is banked. */
  dynamicRunnersEnabled?: boolean;
  /** Stagnation Exit: close trades that stagnate around break-even after stagnationHours without progress towards TP1. */
  stagnationExitEnabled?: boolean;
  /** Hours after which a stagnant trade (< stagnationMaxR) is closed (default 2.5h). */
  stagnationHours?: number;
  /** Maximum absolute R multiple considered stagnant (default 0.35R). */
  stagnationMaxR?: number;
  /** Spread & Slippage Shield: skip trades where the bid-ask spread exceeds maxSpreadPct (default true). */
  spreadShieldEnabled?: boolean;
  /** Maximum bid-ask spread permitted to open a trade (default 0.0015 = 0.15%). */
  maxSpreadPct?: number;
  /** BTC Flash-Dump threshold: drop percentage within 15m that triggers the circuit breaker (default -0.012 = -1.2%). */
  btcFlashDumpThreshold?: number;
  /** Early Profit Protection: profit in R at which stop loss is moved to break-even before TP1 fills (default 1.2R). */
  earlyBreakEvenR?: number;
  /** BTC Chop Filter: pause altcoin entries when Bitcoin is in CHOP (sideways/directionless) (default true). */
  btcChopFilterEnabled?: boolean;
  /** Standby Mode: pause opening new positions while continuing to manage existing positions (default false). */
  pauseNewEntries?: boolean;
  /** Market Structure Shift (MSS) protection: protect or exit open positions immediately on adverse structural break (default true). */
  mssProtectionEnabled?: boolean;
  /** Premium/Discount filter: block LONGs in Premium (>50%) and SHORTs in Discount (<50%) of active dealing range (default true). */
  premiumDiscountFilterEnabled?: boolean;
  /** Imbalance / Golden Zone Scalps: enable high R:R mean-reversion scalps towards FVG / Fib 0.618 after liquidity sweeps (default true). */
  imbalanceScalpEnabled?: boolean;
  /** Require Fair Value Gap or Order Block confluence for pullback entries (default true). */
  fvgFilterEnabled?: boolean;
  /** 5-minute (5m) Sniper Trigger: verify micro-reversal (green candle / hammer wick) on 5m candles right before opening trade (default true). */
  ltfSniper5mEnabled?: boolean;
  /** SMT (Smart Money Technique) Divergence: detect cross-asset accumulation/distribution against benchmark (default true). */
  smtFilterEnabled?: boolean;
  /** Volume Profile / Point of Control (POC): use high-volume nodes as price magnets and targets (default true). */
  volumeProfileEnabled?: boolean;
};

/** Parameters of a backtest run. */
export type BacktestConfig = {
  symbols: string[];
  interval: string;
  higherInterval: string;
  /** Window start, unix seconds. */
  from: number;
  /** Window end, unix seconds. */
  to: number;
  startingBalance: number;
  risk?: Partial<RiskConfig>;
  feeRate?: number;
};

/** One completed trade in a backtest. */
export type BacktestTrade = {
  symbol: string;
  side: Side;
  entry: number;
  exit: number;
  quantity: number;
  leverage: number;
  margin: number;
  openedAt: number;
  closedAt: number;
  barsHeld: number;
  pnl: number;
  pnlPct: number;
  /** Result in units of the risk taken. */
  rMultiple: number;
  exitReason: string;
  confidence: number;
  regime: Regime;
};

/** A point on the backtest equity curve. */
export type EquityPoint = {
  time: number;
  equity: number;
  drawdownPct: number;
  openPositions: number;
};

/** The full outcome of a backtest run. */
export type BacktestResult = {
  config: BacktestConfig;
  startedAt: number;
  endedAt: number;
  bars: number;
  startingBalance: number;
  finalEquity: number;
  totalReturnPct: number;
  annualisedReturnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  /** Average result per trade in R — the clearest measure of edge. */
  expectancyR: number;
  avgBarsHeld: number;
  sharpe: number;
  haltedBars: number;
  exitBreakdown: Record<string, { count: number; pnl: number }>;
  /** Realised result per calendar month, oldest first. */
  monthly: MonthlyBucket[];
  /** Share of total profit from the single best month. 0 for losing runs. */
  bestMonthShare: number;
  /** Fraction of months that ended positive. */
  positiveMonthRate: number;
  /** Result per market, best contributor first. */
  bySymbol: SymbolBucket[];
  equityCurve: EquityPoint[];
  tradeLog: BacktestTrade[];
};

/** One evaluation window of a walk-forward analysis. */
export type WalkForwardWindow = {
  from: number;
  to: number;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  expectancyR: number;
  trades: number;
};

/**
 * Results of evaluating the strategy across many overlapping windows.
 *
 * `positiveRate` is the figure to judge the strategy on: the share of 300-day
 * periods that ended in profit.
 */
export type WalkForwardReport = {
  windows: WalkForwardWindow[];
  windowCount: number;
  positiveRate: number;
  medianReturnPct: number;
  /** Return of the single worst window — the realistic bad case. */
  worstReturnPct: number;
  worstDrawdownPct: number;
  medianProfitFactor: number;
};

/** Progress and result of a walk-forward analysis. */
export type WalkForwardStatus = {
  state: 'idle' | 'loading' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  report: WalkForwardReport | null;
};

/** One market's contribution to a backtest. */
export type SymbolBucket = {
  symbol: string;
  pnl: number;
  trades: number;
  wins: number;
  /** Average result per trade in R for this market. */
  expectancyR: number;
};

/** One calendar month of a backtest. */
export type MonthlyBucket = {
  /** Month key as `YYYY-MM`. */
  month: string;
  pnl: number;
  trades: number;
  wins: number;
};

/** Progress of a backtest run. */
export type BacktestStatus = {
  state: 'idle' | 'loading' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  result: BacktestResult | null;
};

/** How one parameter set performed on training and held-out test data. */
export type OptimizeTrial = {
  params: Partial<RiskConfig>;
  trainScore: number;
  /** Score on data the search never selected on — the number that matters. */
  testScore: number;
  trainResult: { totalReturnPct: number; expectancyR: number; maxDrawdownPct: number; trades: number };
  testResult: { totalReturnPct: number; expectancyR: number; maxDrawdownPct: number; trades: number };
};

/** Progress and results of a parameter search. */
export type OptimizeStatus = {
  state: 'idle' | 'loading' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  /** Top trials, best out-of-sample first. */
  trials: OptimizeTrial[];
  best: OptimizeTrial | null;
};

/** A tradable market, used by the backtest market picker. */
export type Ticker = {
  symbol: string;
  lastPrice: number;
  bid1?: number;
  ask1?: number;
  spreadPct?: number;
  quoteVolume24h: number;
  changeRate24h: number;
  fundingRate: number;
};

/** An engine log line. */
export type EngineEvent = {
  at: number;
  level: 'info' | 'trade' | 'warn' | 'error';
  message: string;
};

/** Aggregate performance statistics. */
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
 * Why the engine is not opening new positions right now. `capacity` is normal
 * operation, `halt` means a risk limit tripped, `regime` means the universe has
 * shown no trending edge for a while and entries are paused until it returns.
 */
export type BlockedState = {
  kind: 'capacity' | 'halt' | 'regime';
  message: string;
};

/** Outcome of testing one candidate market for admission to the live universe. */
export type ScoutResult = {
  symbol: string;
  testedAt: number;
  passed: boolean;
  reason: string;
  profitFactor: number;
  expectancyR: number;
  trades: number;
  maxDrawdownPct: number;
};

/** Current state of the background market scout. */
export type ScoutStatus = {
  running: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** Symbols the scout has admitted into the live universe so far. */
  universeExtras: string[];
  /** Most recent test results, newest first. */
  recent: ScoutResult[];
  /** Candidates that cleared the backtest bar and await manual approval before joining the live universe. */
  pending: ScoutResult[];
};

/**
 * Readiness of the (not-yet-active) live MEXC order connection.
 *
 * `configured` is true once API keys are present; `enabled` additionally
 * requires the explicit go-live flag, so a configured-but-not-armed connection
 * still trades on paper.
 */
export type LiveTradingStatus = {
  configured: boolean;
  enabled: boolean;
  baseUrl: string;
  venue?: 'mexc' | 'hyperliquid';
};

/** Planned trade with TP ladder and SL. */
export type TradePlan = {
  symbol: string;
  side: Side;
  entry: number;
  leverage: number;
  margin: number;
  notional: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  takeProfits: TakeProfitLevel[];
  riskPct: number;
  confidence: number;
  regime: Regime;
  reasons: string[];
};

/**
 * Chart payload for one symbol: the exact candles the strategy scores it on,
 * plus the current signal so the chart can draw the swing, golden zone, and
 * stop/target levels the engine is actually watching.
 */
export type ChartData = {
  symbol: string;
  entryInterval: string;
  confirmInterval: string;
  candles: Candle[];
  higherCandles: Candle[];
  signal: Signal | null;
  position?: Position | null;
  plannedTrade?: TradePlan | null;
  error?: string;
};

/**
 * One open position as reported directly by MEXC, shown instead of the paper
 * position list once live trading is armed — see {@link ExchangeAccountSnapshot}.
 */
export type LiveExchangePosition = {
  symbol: string;
  side: Side;
  /** Base-asset quantity (e.g. BTC), already converted from MEXC's contract-count `vol`. */
  vol: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealisedPnl: number;
  openedAt?: number;
};

/**
 * Real MEXC account state, present only while live trading is armed. The
 * dashboard switches its main balance cards and open-position list to this
 * instead of the paper `account`/`open` fields whenever it is set.
 */
export type ExchangeAccountSnapshot = {
  equity: number;
  available: number;
  frozen: number;
  unrealisedPnl: number;
  open: LiveExchangePosition[];
  fetchedAt: number;
  /** Set when the fetch failed — the dashboard shows this instead of stale/blank data. */
  error?: string;
};

/** Full dashboard payload from the trading service. */
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
  /** Latest mark price per symbol, used for live pnl on open positions. */
  marks: Record<string, number>;
  /** State of the background job that widens the trading universe over time. */
  scout: ScoutStatus;
  /** Readiness of the (not-yet-active) live MEXC order connection. */
  exchange: LiveTradingStatus;
  /** Whether a Telegram bot or webhook is configured to receive trade alerts. */
  notificationsEnabled: boolean;
  /** Consecutive chop-regime scans and how many are allowed before entries pause. */
  chopStatus: { streak: number; limit: number };
  /** Real MEXC account state — present only while `exchange.enabled` is true. */
  exchangeAccount: ExchangeAccountSnapshot | null;
  /** Adaptive self-learning engine state including factor performance and symbol penalties. */
  learning?: LearningState;
};
