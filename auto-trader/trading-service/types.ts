import type { FibLevels } from './fibonacci.js';
export type { FibLevels };

/**
 * Trade direction of a futures position.
 */
export type Side = 'LONG' | 'SHORT';

/**
 * A single OHLCV candle.
 */
export type Candle = {
  /** Open time in unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Live ticker snapshot for a futures contract.
 */
export type Ticker = {
  symbol: string;
  lastPrice: number;
  /** Best bid price from orderbook. */
  bid1?: number;
  /** Best ask price from orderbook. */
  ask1?: number;
  /** Bid-ask spread as a fraction of price, e.g. 0.0012 = 0.12%. */
  spreadPct?: number;
  /** 24h quote volume, used to filter illiquid markets. */
  quoteVolume24h: number;
  /** 24h change as a ratio, e.g. 0.0169 = +1.69%. */
  changeRate24h: number;
  /** Current funding rate of the perpetual contract. */
  fundingRate: number;
};

/**
 * The market regime detected by the strategy engine.
 */
export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'CHOP';

/**
 * Financial market trading session based on global market hours (UTC).
 */
export type MarketSession = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'OFF_HOURS';

/**
 * A scored trading opportunity produced by the strategy engine.
 */
export type Signal = {
  symbol: string;
  side: Side;
  /** Composite conviction score, 0..1. */
  confidence: number;
  regime: Regime;
  price: number;
  /** Average true range as a ratio of price — the volatility measure. */
  atrPct: number;
  /** Human readable reasons behind the signal. */
  reasons: string[];
  /** Regime on the higher timeframe, used to confirm or veto the entry. */
  higherRegime: Regime;
  /** True when the higher timeframe agrees with the trade direction. */
  alignedWithHigher: boolean;
  /** Nearest swing low below price, an anchor for LONG stops. */
  swingLow: number;
  /** Nearest swing high above price, an anchor for SHORT stops. */
  swingHigh: number;
  /** Distance to the nearest opposing structure, in R multiples. */
  roomToStructure: number;
  /** Checks the signal had to pass before it was allowed through. */
  checks: SignalCheck[];
  /** Fibonacci retracement/extension levels off the dominant recent swing, when computable. */
  fib: FibLevels | null;
  /**
   * Leverage the engine would use for this signal today, from {@link previewLeverage}.
   *
   * Null when the signal would not currently qualify for entry (below
   * `minConfidence`, missing higher timeframe alignment when required, etc.) —
   * distinct from 0, which would wrongly imply a valid but zero leverage.
   */
  plannedLeverage: number | null;
  /** True when 15m micro-timing confirms entry (not overbought/oversold on 15m). */
  timingReady?: boolean;
  /** Relative strength vs Bitcoin (changeRate24h - btcChangeRate24h), e.g. +0.035 = +3.5% outperforming. */
  relativeStrength?: number;
  /** True when 15m candle reversal is confirmed (green candle / hammer for long, red / inverted hammer for short). */
  reversalConfirmed?: boolean;
  /** Active market session during which this signal was evaluated. */
  session?: MarketSession;
  /** Asian session range levels and sweep state. */
  asianRange?: { high: number; low: number; mid: number; swept?: 'HIGH' | 'LOW' | null } | null;
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
  midpoint: number; // Consequent Encroachment (50%)
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
  equilibrium: number; // 50%
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  relativePosition: number; // 0 (low) to 1 (high)
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

/**
 * One named entry condition and whether the market met it.
 */
export type SignalCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

/**
 * A staged profit target. Each level closes part of the position when hit.
 */
export type TakeProfitLevel = {
  /** Price at which this level triggers. */
  price: number;
  /** Fraction of the ORIGINAL quantity closed here, e.g. 0.4 = 40%. */
  portion: number;
  /** Reward multiple of the initial risk, e.g. 1.5 = 1.5R. */
  rMultiple: number;
  /** Whether this level has already been filled. */
  hit: boolean;
  /** When it filled, unix milliseconds. */
  hitAt?: number;
  /** Realised pnl booked at this level. */
  realised?: number;
};

/**
 * A fully sized trade plan, ready for execution.
 */
export type TradePlan = {
  symbol: string;
  side: Side;
  entry: number;
  leverage: number;
  /** Collateral committed, in quote currency. */
  margin: number;
  /** Position notional = margin * leverage. */
  notional: number;
  quantity: number;
  stopLoss: number;
  /** Final target — the last and furthest take-profit level. */
  takeProfit: number;
  /** Staged profit targets, nearest first. */
  takeProfits: TakeProfitLevel[];
  /** Fraction of equity risked if the stop is hit, e.g. 0.01 = 1%. */
  riskPct: number;
  confidence: number;
  regime: Regime;
  reasons: string[];
};

/**
 * An open or closed paper position.
 */
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
  /** Final target — the last and furthest take-profit level. */
  takeProfit: number;
  /** Staged profit targets, nearest first. */
  takeProfits: TakeProfitLevel[];
  /** Quantity still open after any partial take-profit fills. */
  remainingQuantity: number;
  /** Profit already booked from partial exits. */
  realisedPnl: number;
  /** Taker fee paid to open the position, charged at entry. */
  entryFee: number;
  /**
   * Distance between entry and the original stop, in price units.
   *
   * Captured at entry because the live stop moves — to break-even, then trailing —
   * and every R calculation must stay anchored to the risk actually taken.
   */
  initialRisk: number;
  /** True once the stop has been moved to break-even after the first target. */
  breakEven: boolean;
  /** Highest (LONG) / lowest (SHORT) price seen, drives the trailing stop. */
  extreme: number;
  trailingArmed: boolean;
  /**
   * True once this position has already been trimmed for an adverse regime
   * flip (see {@link RiskConfig.trendFlipProtection}). Guards the trim to a
   * one-time event per position — the remainder is still fully managed by
   * the normal stop/trailing/take-profit logic afterwards.
   */
  regimeTrimmed?: boolean;
  openedAt: number;
  closedAt?: number;
  exit?: number;
  pnl?: number;
  pnlPct?: number;
  /** Why the position was closed. */
  exitReason?:
    | 'STOP_LOSS'
    | 'TAKE_PROFIT'
    | 'TRAILING_STOP'
    | 'BREAK_EVEN'
    | 'SIGNAL_FLIP'
    | 'LIQUIDATED'
    | 'MAX_AGE'
    | 'MANUAL'
    | 'DELISTED'
    | 'STALE_TRADE'
    | 'STAGNATION'
    | 'UNCERTAINTY'
    | 'CLIMAX_TRIM'
    | 'PROFIT_LOCK'
    | 'MSS_FLIP';
  status: 'OPEN' | 'CLOSED';
  confidence: number;
  regime: Regime;
  reasons: string[];
  /** Minimum R multiple locked in by the progressive profit-locking floor. */
  profitLockR?: number;
  /** True when a blow-off top climax trim has already fired on this position. */
  climaxTrimmed?: boolean;
  /**
   * True when this position was mirrored onto the real MEXC account at entry.
   * Positions opened while paper-trading (`enabled === false`) are never
   * retroactively mirrored, so this flag — not the current exchange status —
   * decides whether the engine sends real orders while managing it.
   */
  live?: boolean;
  /** Contract size used to convert this position's quantity into MEXC's `vol` units. */
  liveContractSize?: number;
  /** Venue order id for the entry order, when {@link live}. */
  liveOrderId?: string;
  /**
   * Venue order id of the currently resting protective stop ("trigger") order,
   * when {@link live}. Replaced (cancel + re-place) every time the local stop
   * moves — break-even, then trailing — so it always matches `stopLoss`.
   */
  liveStopOrderId?: string | null;
  /** Number of times this position has been scaled into (pyramided). Max 1. */
  scaleInCount?: number;
  /** Timestamp of the scale-in entry, if any. */
  scaledInAt?: number;
  /** Collateral added during scale-in. */
  scaleInMargin?: number;
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

/**
 * Account snapshot of the paper trading engine.
 */
export type Account = {
  /** Free collateral available for new positions. */
  balance: number;
  /** Balance + unrealised pnl of open positions. */
  equity: number;
  /** Collateral locked in open positions. */
  usedMargin: number;
  realisedPnl: number;
  unrealisedPnl: number;
  startingBalance: number;
  /** Peak equity, used for drawdown control. */
  peakEquity: number;
  drawdownPct: number;
};

/**
 * Risk configuration that drives sizing and leverage decisions.
 */
export type RiskConfig = {
  /** Base fraction of equity risked per trade. */
  baseRiskPct: number;
  /** Hard cap on risk per trade after confidence scaling. */
  maxRiskPct: number;
  maxLeverage: number;
  minLeverage: number;
  maxOpenPositions: number;
  /** Max fraction of equity committed as margin across all positions. */
  maxTotalMarginPct: number;
  /** Engine halts new entries beyond this drawdown. */
  maxDrawdownPct: number;
  /** Engine halts new entries beyond this daily loss. */
  dailyLossLimitPct: number;
  /** Minimum confidence required to take a trade. */
  minConfidence: number;
  /** Max hours a position may stay open. */
  maxPositionHours: number;
  /** Max hours an unconfirmed position (TP1 not reached) may stay open without headway before closing as stale. */
  maxStaleHours?: number;
  /** Proactively close open positions when market conditions deteriorate into uncertainty or oppose the trade. */
  uncertaintyExitEnabled?: boolean;
  /** Automatically ratchet stop loss up as price reaches +2.2R, +3.2R, etc. to lock in profit. */
  profitLockingEnabled?: boolean;
  /** Harvest 25%-30% on parabolic blow-off top climax candles before the dump. */
  climaxExitEnabled?: boolean;
  /** Use 15m micro-timing to avoid buying at the peak of an hourly candle. */
  microTiming15mEnabled?: boolean;
  /** Use limit pullback entry instead of pure market orders when price is extended. */
  pullbackEntryEnabled?: boolean;
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
  /** Use ATR-based dynamic chandelier trailing stop for runners. */
  dynamicChandelierTrailing?: boolean;
  /** Only open trades during permitted market sessions. */
  sessionFilterEnabled?: boolean;
  /** Allowed market sessions to open trades in (e.g. ['ASIA', 'NEW_YORK']). */
  allowedSessions?: MarketSession[];
  /** Adapt strategy model weights according to active market session dynamics. */
  sessionAdaptiveWeights?: boolean;
  /** Exploit Asian range high/low liquidity sweeps during London and New York sessions. */
  asianRangeSweepEnabled?: boolean;
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
  /** Reward multiple of the final rung — how far a runner is allowed to go. */
  finalTargetR: number;
  /** Move the stop to entry once the first target fills. */
  breakEvenAfterFirst: boolean;
  /** Only take trades the higher timeframe actively confirms. */
  requireHigherAlignment: boolean;
  /**
   * Max positions allowed on the same side at once.
   *
   * Crypto perps move together, so five longs is closer to one large bet than to
   * a diversified book. This is the cap that keeps a single market-wide move from
   * hitting every stop at the same moment.
   */
  maxSameSidePositions: number;
  /** Max positions per correlation group (majors, memes, alts). */
  maxPerGroup: number;
  /**
   * Target collateral (margin) per trade, as a fraction of equity. When set,
   * sizing scales UP to this stake if the risk-budget-derived size would be
   * smaller — it does not shrink a trade the risk budget already wants bigger.
   * Still bounded by `maxTotalMarginPct`/`maxOpenPositions` and available
   * balance. Because this can push the realised risk at the stop above
   * `maxRiskPct` (the stop distance and leverage no longer just serve a fixed
   * risk amount), this is a deliberate aggressiveness override, not a
   * validated setting — leave undefined to size purely from the risk budget.
   *
   * This is now the CEILING of a confidence-scaled range — see
   * {@link minStakePct} for the floor. A signal that barely clears
   * `minConfidence` stakes near the floor; one at `highConvictionConfidence`
   * or above stakes the full ceiling.
   */
  targetStakePct?: number;
  /**
   * Floor of the confidence-scaled stake range, as a fraction of equity. A
   * signal right at `minConfidence` stakes this much; the stake scales up
   * linearly to `targetStakePct` as confidence rises to
   * `highConvictionConfidence`. Ignored when `targetStakePct` is unset.
   */
  minStakePct?: number;
  /**
   * Confidence level (0..1) considered "high conviction". Two things happen
   * at this level: the stake range (`minStakePct`..`targetStakePct`) reaches
   * its ceiling, and — once the portfolio is completely full — a signal this
   * strong is allowed to open one extra position beyond `maxOpenPositions`
   * (see `maxOverflowPositions`) rather than being skipped entirely.
   */
  highConvictionConfidence: number;
  /**
   * Extra positions allowed beyond `maxOpenPositions` when a signal's
   * confidence reaches `highConvictionConfidence` while the book is already
   * full. E.g. `maxOpenPositions: 10` + `maxOverflowPositions: 3` means the
   * book can hold up to 13 positions, but only the last 3 slots require
   * high-conviction confidence to fill. Set to 0 to disable overflow.
   */
  maxOverflowPositions: number;
  /**
   * Consecutive scan cycles the whole universe must sit in a low-edge CHOP
   * regime (no signal reaching `minConfidence`) before the engine pauses new
   * entries. Existing positions are still managed as normal — this only stops
   * new risk from being added during a stretch with no trending edge. Set to a
   * large number to disable.
   */
  chopPauseStreak: number;
  /**
   * Turbo mode — for a smaller starting balance where dollar-based sizing
   * limits are the binding constraint, not risk tolerance. Raises the
   * leverage ceiling in calm/medium volatility (the hard 8x safety cap above
   * 2% ATR is never relaxed) and banks the first take-profit tranche sooner,
   * so capital cycles back to free margin faster for the next setup instead
   * of sitting in a slow-moving runner.
   */
  turboMode?: boolean;
  /**
   * Trim part of an open position as soon as the market regime genuinely
   * flips against it (e.g. a LONG held while the regime turns TREND_DOWN),
   * instead of waiting for the stop-loss or a full opposite-side signal.
   * Reduces exposure early so a real trend reversal cannot turn into the full
   * planned loss. Fires at most once per position — see `Position.regimeTrimmed`.
   */
  trendFlipProtection: boolean;
  /** Fraction of the remaining position closed when a trend-flip trim fires. */
  trendFlipTrimPortion: number;
  /**
   * Bitcoin Gatekeeper: blocks altcoin entries that fight the dominant Bitcoin trend.
   * Altcoin longs are blocked if BTC is in TREND_DOWN; altcoin shorts are blocked if BTC is in TREND_UP.
   */
  btcFilterEnabled?: boolean;
  /**
   * Minimum minutes between consecutive new entries to prevent clustering trades on single-candle spikes.
   */
  entryCooldownMinutes?: number;
  /**
   * Minimum 24h quote volume (in USDT) required for any candidate to be traded or scouted.
   */
  minQuoteVolume24h?: number;
  /**
   * Room (in R) given to the break-even stop beyond entry+fees after TP1 fills.
   */
  breakEvenBufferR?: number;
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

/**
 * Why the engine is not opening new positions right now.
 *
 * `capacity` is business as usual — the portfolio is simply fully deployed.
 * `halt` means a risk limit tripped and trading is suspended.
 */
export type BlockedState = {
  kind: 'capacity' | 'halt' | 'regime';
  message: string;
};

/**
 * Outcome of testing one candidate market for admission to the live universe.
 */
export type ScoutResult = {
  symbol: string;
  /** When the test ran, unix ms. */
  testedAt: number;
  passed: boolean;
  /** Human-readable reason, shown in the event log and dashboard. */
  reason: string;
  profitFactor: number;
  expectancyR: number;
  trades: number;
  maxDrawdownPct: number;
};

/**
 * Current state of the background market scout.
 */
export type ScoutStatus = {
  running: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** Symbols the scout has admitted into the live universe so far. */
  universeExtras: string[];
  /** Most recent test results, newest first. */
  recent: ScoutResult[];
  /**
   * Candidates that cleared the scout's backtest bar and are awaiting manual
   * approval before joining the live universe — the scout never admits a
   * symbol on its own; a human always confirms first.
   */
  pending: ScoutResult[];
};

/**
 * Parameters of a backtest run.
 */
export type BacktestConfig = {
  /** Markets to replay. */
  symbols: string[];
  /** Entry timeframe, e.g. `Min15`. */
  interval: string;
  /** Confirmation timeframe, e.g. `Min60`. */
  higherInterval: string;
  /** Window start, unix seconds. */
  from: number;
  /** Window end, unix seconds. */
  to: number;
  startingBalance: number;
  /** Risk overrides applied on top of the default profile. */
  risk?: Partial<RiskConfig>;
  /** Taker fee per side, as a fraction of notional. */
  feeRate?: number;
};

/**
 * One completed trade in a backtest.
 */
export type BacktestTrade = {
  symbol: string;
  side: Side;
  entry: number;
  exit: number;
  quantity: number;
  leverage: number;
  margin: number;
  /** Entry time, unix seconds. */
  openedAt: number;
  /** Exit time, unix seconds. */
  closedAt: number;
  /** How many bars the position stayed open. */
  barsHeld: number;
  pnl: number;
  pnlPct: number;
  /** Result in units of the risk taken, e.g. 2 = won twice what was risked. */
  rMultiple: number;
  exitReason: NonNullable<Position['exitReason']>;
  confidence: number;
  regime: Regime;
};

/**
 * A point on the backtest equity curve.
 */
export type EquityPoint = {
  /** Bar time, unix seconds. */
  time: number;
  equity: number;
  drawdownPct: number;
  openPositions: number;
};

/**
 * The full outcome of a backtest run.
 */
export type BacktestResult = {
  config: BacktestConfig;
  startedAt: number;
  endedAt: number;
  /** Number of bars replayed. */
  bars: number;
  startingBalance: number;
  finalEquity: number;
  totalReturnPct: number;
  /** Total return compounded to a yearly rate. */
  annualisedReturnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  /** Average result per trade in R — the single best measure of edge. */
  expectancyR: number;
  avgBarsHeld: number;
  /** Annualised risk-adjusted return. */
  sharpe: number;
  /** Bars during which a risk limit suspended trading. */
  haltedBars: number;
  /** Trade count and pnl grouped by how the position ended. */
  exitBreakdown: Record<string, { count: number; pnl: number }>;
  /**
   * Result broken down per calendar month.
   *
   * A single headline return hides whether the edge is steady or whether one
   * exceptional month carries the whole run. That distinction matters more than
   * the total, so it is reported alongside it rather than left to be discovered.
   */
  monthly: MonthlyBucket[];
  /**
   * Share of the total profit contributed by the single best month.
   *
   * Near 1 means the run depends on one lucky stretch. Only meaningful when the
   * run was profitable overall, so it is 0 for losing runs.
   */
  bestMonthShare: number;
  /** Fraction of months that ended positive. */
  positiveMonthRate: number;
  /**
   * Result per market, best first.
   *
   * Averaging across markets hides that a portfolio result is often a few
   * markets earning and the rest leaking. This is what tells you which ones
   * actually belong in the universe.
   */
  bySymbol: SymbolBucket[];
  /**
   * Result grouped by the regime the signal was taken in, and by direction.
   *
   * A trend system is not one strategy — it behaves completely differently in a
   * trending market than in a ranging one, and often differently long vs short.
   * Averaging those together hides which of them is actually paying.
   */
  byRegime: GroupBucket[];
  bySide: GroupBucket[];
  equityCurve: EquityPoint[];
  tradeLog: BacktestTrade[];
};

/**
 * One evaluation window of a walk-forward analysis.
 */
export type WalkForwardWindow = {
  /** Window start, unix seconds. */
  from: number;
  /** Window end, unix seconds. */
  to: number;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  expectancyR: number;
  trades: number;
};

/**
 * Results of evaluating one parameter set across many overlapping windows.
 *
 * `positiveRate` is the figure to judge a strategy on: the share of 300-day
 * periods that ended in profit. A single backtest can always find a good
 * stretch; this measures how much of the history was good.
 */
export type WalkForwardReport = {
  windows: WalkForwardWindow[];
  windowCount: number;
  /** Share of windows that ended positive, 0–1. */
  positiveRate: number;
  medianReturnPct: number;
  /** Return of the single worst window — the realistic bad case. */
  worstReturnPct: number;
  /** Deepest drawdown seen in any window. */
  worstDrawdownPct: number;
  medianProfitFactor: number;
};

/**
 * A slice of trades sharing one attribute — regime, side, or anything else.
 */
export type GroupBucket = {
  /** What this slice represents, e.g. `TREND_UP` or `LONG`. */
  key: string;
  pnl: number;
  trades: number;
  wins: number;
  /** Average result per trade in R for this slice. */
  expectancyR: number;
};

/**
 * One market's contribution to a backtest.
 */
export type SymbolBucket = {
  symbol: string;
  pnl: number;
  trades: number;
  wins: number;
  /** Average result per trade in R for this market. */
  expectancyR: number;
};

/**
 * One calendar month of a backtest.
 */
export type MonthlyBucket = {
  /** Month key as `YYYY-MM`. */
  month: string;
  /** Realised profit or loss for trades closed in this month. */
  pnl: number;
  trades: number;
  wins: number;
};

/**
 * How one parameter set performed on training and held-out test data.
 */
export type OptimizeTrial = {
  params: Partial<RiskConfig>;
  trainScore: number;
  /** Score on data the search never selected on — the number that matters. */
  testScore: number;
  trainResult: { totalReturnPct: number; expectancyR: number; maxDrawdownPct: number; trades: number };
  testResult: { totalReturnPct: number; expectancyR: number; maxDrawdownPct: number; trades: number };
};

/**
 * Progress and results of a parameter search.
 */
export type OptimizeStatus = {
  state: 'idle' | 'loading' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  /** Top trials, best out-of-sample first. */
  trials: OptimizeTrial[];
  best: OptimizeTrial | null;
};

/**
 * Progress of a backtest run, polled by the dashboard.
 */
export type BacktestStatus = {
  state: 'idle' | 'loading' | 'running' | 'done' | 'error';
  /** What the run is doing right now, for the UI. */
  message: string;
  /** Completion between 0 and 1. */
  progress: number;
  result: BacktestResult | null;
};

/**
 * A log line emitted by the engine, surfaced in the dashboard.
 */
export type EngineEvent = {
  at: number;
  level: 'info' | 'trade' | 'warn' | 'error';
  message: string;
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
  /**
   * Computed from entry/mark/side/leverage rather than taken from the venue's
   * `unrealised` field, which is not reliably populated on this endpoint.
   */
  unrealisedPnl: number;
  /** Unix timestamp in milliseconds when the position was opened on MEXC. */
  openedAt?: number;
};

/**
 * Real MEXC account state, fetched only while live trading is armed
 * ({@link LiveTradingStatus.enabled}). Replaces the paper {@link Account} and
 * {@link Position} list on the dashboard so the user sees exactly what is
 * happening on the exchange, not the internal paper ledger.
 */
export type ExchangeAccountSnapshot = {
  /** USDT-denominated equity on the venue (balance + unrealised pnl). */
  equity: number;
  /** USDT available to open new positions. */
  available: number;
  /** USDT locked as margin in open positions. */
  frozen: number;
  /** Sum of unrealised pnl across all open venue positions. */
  unrealisedPnl: number;
  open: LiveExchangePosition[];
  /** Unix ms this was fetched — lets the dashboard show staleness if MEXC is slow. */
  fetchedAt: number;
  /** Set when the fetch failed — the dashboard falls back to showing this instead of stale/blank data. */
  error?: string;
};
