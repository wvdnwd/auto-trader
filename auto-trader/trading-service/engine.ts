import { randomUUID } from 'node:crypto';
import {
  BREAK_EVEN_BUFFER_R,
  FEE,
  type ExitTuning,
  chandelierStop,
  closeSettlement,
  detectBlowOffTop,
  direction,
  earlyProfitProtect,
  fillTakeProfits,
  isLiquidated,
  isStopHit,
  openPnl,
  partialFillPatch,
  progressiveProfitLock,
  regimeTrimPatch,
  riskUnit,
  stopReason,
  trailPatch,
  trimForRegimeFlip,
} from './exits.js';
import { atr, rsi } from './indicators.js';
import { MexcExchangeAdapter, type IExchangeAdapter } from './exchange-adapter.js';
import { MarketData, isCryptoPerp } from './market-data.js';
import { notify } from './notifier.js';
import { rankCandidates } from './candidate-ranking.js';
import { DEFAULT_RISK, concentrationBlock, correlationGroup, getCoinProfile, isPositionDerisked, planTrade, previewLeverage, tradingBlockedReason } from './risk.js';
import { btcTrendConflict, buildSignal, checkLtfReversal, detectRegime } from './strategy.js';
import { analyzeMarketStructure } from './market-structure.js';
import { getMarketSession } from './sessions.js';
import { Store } from './store.js';
import { analyzeClosedTrade } from './post-mortem.js';
import { NewsEngine } from './news-engine.js';
import { ErrorLogger } from './error-logger.js';
import {
  computeFactorWeight,
  evaluateCandidateFactorEdge,
  evaluateClusterRisk,
  evaluateSessionEdge,
  updateCoinDNA,
  updateMfeMaeStats,
  updateSessionStat,
} from './ai-learning.js';
import type {
  Account,
  BlockedState,
  BlockReasonCode,
  Candle,
  EngineEvent,
  MarketSession,
  NewsItem,
  Position,
  RiskConfig,
  Signal,
  SetupScore,
  StrategyType,
  Ticker,
  TakeProfitLevel,
  TradePlan,
  TradePostMortem,
} from './types.js';

/**
 * Markets the engine is allowed to trade.
 *
 * Scanning the whole top-40 by volume sounds like more opportunity, but the
 * backtests say otherwise: over 18 months, trading 12 markets returned +4.9%
 * while the original four (BTC/ETH/AVAX/LINK) returned +47.5% on the same data,
 * with lower drawdown. The wide universe was not finding extra edge, it was
 * funding losers with the winners' profit — NEAR alone gave back $1.3k.
 *
 * SOL/XRP/DOGE were added back deliberately, on a walk-forward result the user
 * accepted knowingly: over 9 rolling 300-day windows this 7-market set raised
 * the median return (+17.8% -> +30.1%) but also opened up the tail risk the
 * original four did not have (worst window -0.8% -> -14.1%, worst drawdown up
 * to 20.2%). PI_USDT was excluded — its listing history is too short to clear
 * a single 300-day window, so it never traded in that test and would be flying
 * blind here. Re-narrowing this list without discussion silently reduces
 * expected return; widening it further without a new walk-forward is how the
 * funding-losers-with-winners problem comes back.
 */
export const MEME_UNIVERSE = [
  'DOGE_USDT',
  'SHIB_USDT',
  'PEPE_USDT',
  'WIF_USDT',
  '1000BONK_USDT',
  'FLOKI_USDT',
  '1000FLOKI_USDT',
  'FARTCOIN_USDT',
  'PENGU_USDT',
  'SPX_USDT',
  'POPCAT_USDT',
  'BOME_USDT',
  'TURBO_USDT',
  'PNUT_USDT',
  'MOODENG_USDT',
  'BRETT_USDT',
  'MEW_USDT',
  'GOAT_USDT',
  'TRUMP_USDT',
  'PURR_USDT',
  'CHILLGUY_USDT',
  'MELANIA_USDT',
  'ANIME_USDT',
  'VINE_USDT',
  'PUMP_USDT',
  'BABY_USDT',
  '1000DOGS_USDT',
  'CATI_USDT',
  'HMSTR_USDT',
  'ACT_USDT',
  'USELESS_USDT',
  '1000NEIRO_USDT',
  'NEIROETH_USDT',
  '1000000MOG_USDT',
];

/** AI & Agent coins — high-momentum narrative tokens */
export const AI_UNIVERSE = [
  'TAO_USDT',
  'FET_USDT',
  'RENDER_USDT',
  'WLD_USDT',
  'VIRTUAL_USDT',
  'AI16Z_USDT',
  'AIXBT_USDT',
  'AI_USDT',
  'IO_USDT',
  'ZEREBRO_USDT',
  'GRIFFAIN_USDT',
  'KAITO_USDT',
  'PROMPT_USDT',
  'ARKM_USDT',
  'ATH_USDT',
  'AIOZ_USDT',
  'BIO_USDT',
];

/** Gaming & Metaverse — high-beta narrative coins, ATR-based stops */
export const GAMING_UNIVERSE = [
  'AXS_USDT',
  'SAND_USDT',
  'IMX_USDT',
  'GALA_USDT',
  'YGG_USDT',
  'BIGTIME_USDT',
  'PIXEL_USDT',
  'ACE_USDT',
  'MAVIA_USDT',
  'ILV_USDT',
  'SUPER_USDT',
  'BEAM_USDT',
  'RON_USDT',
  'PRIME_USDT',
];

/** DeFi blue-chips & Hyperliquid ecosystem — liquidity-sensitive, TP runners on breakouts */
export const DEFI_UNIVERSE = [
  'AAVE_USDT',
  'UNI_USDT',
  'CRV_USDT',
  'MKR_USDT',
  'SNX_USDT',
  'JUP_USDT',
  'PENDLE_USDT',
  'GMX_USDT',
  'DYDX_USDT',
  'ENA_USDT',
  'ETHFI_USDT',
  'LDO_USDT',
  'ONDO_USDT',
  'HYPE_USDT',
  'CAKE_USDT',
  'LINK_USDT',
  'MORPHO_USDT',
  'SYRUP_USDT',
  'RESOLV_USDT',
  'AERO_USDT',
  'RAY_USDT',
  'SUSHI_USDT',
  'COMP_USDT',
  'PYTH_USDT',
  'JTO_USDT',
  'BLUR_USDT',
];

/** Layer 2 / Scaling tokens */
export const LAYER2_UNIVERSE = [
  'ARB_USDT',
  'OP_USDT',
  'STRK_USDT',
  'POL_USDT',
  'MANTA_USDT',
  'ZK_USDT',
  'BLAST_USDT',
  'SCR_USDT',
  'LINEA_USDT',
  'ZORA_USDT',
  'EIGEN_USDT',
  'ALT_USDT',
  'DYM_USDT',
  'TST_USDT',
  'LAYER_USDT',
  'W_USDT',
];

/** Layer 1 high-beta and major chains */
export const LAYER1_UNIVERSE = [
  'SOL_USDT',
  'AVAX_USDT',
  'ADA_USDT',
  'DOT_USDT',
  'NEAR_USDT',
  'SUI_USDT',
  'APT_USDT',
  'SEI_USDT',
  'TIA_USDT',
  'INJ_USDT',
  'KAS_USDT',
  'ICP_USDT',
  'HBAR_USDT',
  'XLM_USDT',
  'TON_USDT',
  'ATOM_USDT',
  'ALGO_USDT',
  'FTM_USDT',
  'AR_USDT',
  'BERA_USDT',
  'MON_USDT',
  'IP_USDT',
  'S_USDT',
  'MOVE_USDT',
  'OM_USDT',
  'TRX_USDT',
  'RUNE_USDT',
  'STX_USDT',
  'MINA_USDT',
  'CFX_USDT',
  'POLYX_USDT',
];

export const CORE_UNIVERSE = Array.from(
  new Set([
    // ── Majors ───────────────────────────────────────────────────────────────
    'BTC_USDT',
    'ETH_USDT',
    'BNB_USDT',
    'XRP_USDT',
    'LTC_USDT',
    'BCH_USDT',
    'ETC_USDT',

    // ── Layer 1 ──────────────────────────────────────────────────────────────
    ...LAYER1_UNIVERSE,

    // ── Layer 2 / Scaling ────────────────────────────────────────────────────
    ...LAYER2_UNIVERSE,

    // ── DeFi ─────────────────────────────────────────────────────────────────
    ...DEFI_UNIVERSE,

    // ── AI / Tech ─────────────────────────────────────────────────────────────
    ...AI_UNIVERSE,

    // ── Gaming / Metaverse ────────────────────────────────────────────────────
    ...GAMING_UNIVERSE,

    // ── Meme coins ────────────────────────────────────────────────────────────
    ...MEME_UNIVERSE,

    // ── Legacy Low-Leverage Alts ──────────────────────────────────────────────
    'DASH_USDT',
    'ZEC_USDT',
    'SAGA_USDT',
  ])
);

/**
 * Entry timeframe, with the timeframe used to confirm it.
 *
 * 1h, not 15m. On 15m the average edge per trade is smaller than the round-trip
 * fee, so the strategy grinds the account down even when its direction calls are
 * right. This pairing is the one every backtest above was measured on.
 */
export const ENTRY_INTERVAL = 'Min60';
export const CONFIRM_INTERVAL = 'Hour4';
export const MICRO_INTERVAL = 'Min15';
export const SNIPER_INTERVAL = 'Min5';

/**
 * Rounds a quantity to the nearest step precision (e.g. 0.01 for Hyperliquid fractional coins,
 * or 1 for MEXC integer contracts) to avoid leaving unallocated fractional dust.
 */
export function roundToStep(val: number, step: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return val;
  if (step >= 1) return Math.round(val);
  const decimals = Math.max(0, Math.min(8, Math.round(-Math.log10(step))));
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}


/**
 * How close to the entry threshold a signal must be for the engine to switch to
 * the fast cycle.
 *
 * Conviction is recomputed from the live price every cycle, so a setup sitting
 * just under the threshold is the one that can cross it within minutes. Anything
 * further out will not get there before the next 1h bar closes and changes the
 * picture anyway, so widening this band buys requests, not entries.
 */
const WATCH_BAND = 0.08;

/**
 * Distance to the stop or the next target, in R, at which an open position is
 * considered to be at a decision point.
 */
const WATCH_R = 0.25;

/** Convert base quantity to supported whole contracts without rounding risk upward. */
export function toContractVolume(quantity: number, contractSize: number, minVol: number, maxVol: number): number {
  if (![quantity, contractSize, minVol, maxVol].every(Number.isFinite) || quantity <= 0 || contractSize <= 0) {
    return 0;
  }
  const vol = Math.floor(quantity / contractSize);
  return vol >= minVol && vol <= maxVol ? vol : 0;
}

/** Allocate TP contract lots without exceeding the position's total volume. */
export function allocateTakeProfitVolumes(totalVol: number, portions: number[], minVol: number): number[] {
  let allocated = 0;
  return portions.map((portion, index) => {
    const requested = index === portions.length - 1 ? totalVol - allocated : Math.floor(totalVol * portion);
    const vol = Number.isFinite(requested) && requested >= minVol && allocated + requested <= totalVol ? requested : 0;
    allocated += vol;
    return vol;
  });
}


/**
 * The autonomous trading engine.
 *
 * Every cycle scans and scores opportunities for the paper book. Existing venue
 * positions remain readable/reconciled, but live order execution and local
 * price-based management are disabled until confirmed fills can be reconciled.
 */
export class Engine {
  private timer: ReturnType<typeof setTimeout> | null = null;

  private stopped = true;

  /** Whether the engine is currently on the fast cycle. */
  private fast = false;

  private busy = false;

  private resetting = false;

  private readonly closingPositions = new Set<string>();

  private liveExecutionWarningLogged = false;

  private lastSignals: Signal[] = [];

  private lastScanAt = 0;

  private blockedReason: BlockedState | null = null;

  /** Timestamp of the most recent position entry, used for trade pacing cooldown. */
  private lastEntryAt = 0;

  /** Consecutive scan cycles with no signal reaching `minConfidence` anywhere in the universe. */
  private chopStreak = 0;

  /** Timestamp of last broken market warning log to avoid spamming the log every 5s. */
  private lastBrokenLogAt = 0;

  /** Tracks last skip reason per symbol to prevent spamming identical skip messages every cycle. */
  /** Granular cooldown tracker: key -> { until: timestamp, reason: description } */
  private cooldowns = new Map<string, { until: number; reason: string }>();

  /** Tracks last skip reason per symbol to prevent spamming identical skip messages every cycle. */
  private lastSkipReasons = new Map<string, { reason: string; at: number; blockCode?: BlockReasonCode }>();

  /** Timestamp of last pacing log to avoid spamming the log every 5s. */
  private lastPacingLogAt = 0;

  /** Latest known mark price per symbol, refreshed each cycle. */
  private marks = new Map<string, number>();

  /** Latest ticker data per symbol from the most recent scan cycle. */
  private lastTickers = new Map<string, Ticker>();

  /**
   * Consecutive scan cycles a symbol has had an open position but no ticker
   * data at all (bulk feed AND individual lookup both empty) — a sign the
   * contract was delisted or suspended, not just a slow response.
   */
  private missingTicks = new Map<string, number>();

  /** Cycles a symbol may be missing before its position is force-closed as delisted.
   * Increased to 12 (~60s on fast loop) to withstand brief exchange 502/timeouts without dumping positions.
   */
  private static readonly MAX_MISSING_TICKS = 12;

  /** Markets admitted into the live universe by the market scout, on top of the
   * validated {@link CORE_UNIVERSE}. Kept separate from `universe` so a restart
   * can restore prior discoveries without touching the walk-forward-validated
   * core list.
   */
  private extraSymbols = new Set<string>();

  /** Tracking state for live MEXC account metrics */
  private livePeakEquity = 0;
  private liveStartingBalance = 0;
  private liveDayStartEquity = 0;
  private liveDayKey = '';
  /** Rolling BTC price history for flash-dump detection (last 20 mins) */
  private btcPriceHistory: { time: number; price: number }[] = [];
  /** Timestamp of the last market-wide candidate scan */
  private lastFullScanAt = 0;

  constructor(
    private readonly store: Store,
    private readonly market: MarketData,
    private risk: RiskConfig = { ...DEFAULT_RISK },
    /** Seconds between engine cycles when nothing is close to a decision. */
    private readonly intervalSec = 45,
    /** Markets the engine may trade. Defaults to the validated core set. */
    private readonly universe: string[] = CORE_UNIVERSE,
    /**
     * The venue adapter used to mirror paper trades onto the real MEXC account
     * whenever live trading is armed. Shared with {@link TradingService} so a
     * credential save from the dashboard is visible here immediately.
     */
    private exchange: IExchangeAdapter = new MexcExchangeAdapter(),
    /**
     * Seconds between cycles once a setup is near its trigger. The strategy runs
     * on 1h bars, so this does not produce new signal information — it exists so
     * the crossing is acted on at a price close to where it happened, instead of
     * up to a full slow cycle later.
     */
    private readonly fastIntervalSec = 5
  ) {}

  /** Whether the engine loop is currently running. */
  get running(): boolean {
    return !this.stopped;
  }

  /** Seconds between cycles right now — drops to the fast cadence near a trigger. */
  get cadenceSec(): number {
    return this.fast ? this.fastIntervalSec : this.intervalSec;
  }

  /** Whether the engine is currently watching a setup on the fast cycle. */
  get watching(): boolean {
    return this.fast;
  }

  /** Set or switch the active exchange adapter at runtime (e.g. MEXC <-> Hyperliquid). */
  setExchange(exchange: IExchangeAdapter): void {
    this.exchange = exchange;
  }

  /** Get the active exchange adapter. */
  get currentExchange(): IExchangeAdapter {
    return this.exchange;
  }

  /** The active risk configuration. */
  get config(): RiskConfig {
    return this.risk;
  }

  /** The most recent ranked signals from the scanner. */
  get signals(): Signal[] {
    return this.lastSignals;
  }

  /** Active cooldowns by key with remaining seconds. */
  getCooldowns(): Record<string, { until: number; reason: string; remainingSec: number }> {
    const now = Date.now();
    const result: Record<string, { until: number; reason: string; remainingSec: number }> = {};
    for (const [key, val] of this.cooldowns.entries()) {
      if (val.until > now) {
        result[key] = {
          until: val.until,
          reason: val.reason,
          remainingSec: Math.ceil((val.until - now) / 1000),
        };
      }
    }
    return result;
  }

  /** Set cooldown for a symbol, direction or zone. */
  setCooldown(key: string, durationMinutes: number, reason: string): void {
    this.cooldowns.set(key, { until: Date.now() + durationMinutes * 60_000, reason });
  }

  /** Clear a cooldown manually. */
  clearCooldown(key: string): void {
    this.cooldowns.delete(key);
  }

  /** Check if a symbol, direction or zone is currently in cooldown. */
  isCooldownActive(
    symbol: string,
    side: 'LONG' | 'SHORT',
    zoneId?: string
  ): { active: boolean; remainingSec: number; reason?: string } {
    const now = Date.now();
    const keysToCheck = [
      symbol,
      `${symbol}:${side}`,
      zoneId ? `${symbol}:zone:${zoneId}` : null,
      `${symbol}:fakeout`,
    ].filter(Boolean) as string[];

    for (const key of keysToCheck) {
      const cd = this.cooldowns.get(key);
      if (cd && cd.until > now) {
        return {
          active: true,
          remainingSec: Math.ceil((cd.until - now) / 1000),
          reason: cd.reason,
        };
      }
    }
    return { active: false, remainingSec: 0 };
  }

  /** Last skip reasons recorded per symbol. */
  getSkipReasons(): Record<string, { reason: string; at: number; blockCode?: BlockReasonCode }> {
    return Object.fromEntries(this.lastSkipReasons.entries());
  }

  /** Timestamp of the last completed scan. */
  get scannedAt(): number {
    return this.lastScanAt;
  }

  /** Why new entries are currently paused, if they are. */
  get blocked(): BlockedState | null {
    return this.blockedReason;
  }

  /**
   * Consecutive scan cycles with no signal reaching `minConfidence` anywhere in
   * the universe, and how many are allowed before entries pause.
   *
   * Exposed so the dashboard can show the count building up toward
   * `chopPauseStreak` — rather than the pause only becoming visible the
   * instant it trips.
   */
  get chopStatus(): { streak: number; limit: number } {
    return { streak: this.chopStreak, limit: this.risk.chopPauseStreak };
  }

  /** Latest mark price per symbol, used by the dashboard for live pnl. */
  get markPrices(): Record<string, number> {
    return Object.fromEntries(this.marks);
  }

  /** The full set of markets the engine may currently trade — core plus scout-admitted. */
  get effectiveUniverse(): string[] {
    return [...this.universe, ...this.extraSymbols];
  }

  /**
   * Admit a market into the live universe, on top of the validated core set.
   *
   * Called by the market scout once a candidate clears its backtest bar, and on
   * startup to restore markets admitted in a previous run. Idempotent — adding an
   * already-present symbol (core or extra) is a no-op.
   *
   * @param symbol contract symbol, e.g. `PEPE_USDT`.
   */
  addUniverseSymbol(symbol: string): void {
    if (this.universe.includes(symbol)) return;
    this.extraSymbols.add(symbol);
  }

  /**
   * Update the risk configuration at runtime, guarding against nonsensical input.
   *
   * @param patch fields to override.
   * @returns the merged configuration.
   */
  setRisk(patch: Partial<RiskConfig>): RiskConfig {
    const merged = { ...this.risk, ...patch };
    const num = (value: number, min: number, max: number, fallback: number) =>
      Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

    this.risk = {
      baseRiskPct: num(merged.baseRiskPct, 0.0005, 0.1, this.risk.baseRiskPct),
      maxRiskPct: num(merged.maxRiskPct, 0.001, 0.2, this.risk.maxRiskPct),
      maxLeverage: Math.round(num(merged.maxLeverage, 1, 125, this.risk.maxLeverage)),
      minLeverage: Math.round(num(merged.minLeverage, 1, 25, this.risk.minLeverage)),
      maxOpenPositions: Math.round(num(merged.maxOpenPositions, 1, 30, this.risk.maxOpenPositions)),
      maxTotalMarginPct: num(merged.maxTotalMarginPct, 0.05, 1, this.risk.maxTotalMarginPct),
      maxDrawdownPct: num(merged.maxDrawdownPct, 0.02, 0.9, this.risk.maxDrawdownPct),
      dailyLossLimitPct: num(merged.dailyLossLimitPct, 0.01, 0.9, this.risk.dailyLossLimitPct),
      minConfidence: num(merged.minConfidence, 0.05, 0.95, this.risk.minConfidence),
      maxPositionHours: num(merged.maxPositionHours, 1, 720, this.risk.maxPositionHours),
      maxSameSidePositions: Math.round(
        num(merged.maxSameSidePositions, 1, 30, this.risk.maxSameSidePositions)
      ),
      maxPerGroup: Math.round(num(merged.maxPerGroup, 1, 20, this.risk.maxPerGroup)),
      atrStopMultiple: num(merged.atrStopMultiple, 0.8, 6, this.risk.atrStopMultiple),
      trailArmR: num(merged.trailArmR, 0.2, 5, this.risk.trailArmR),
      trailGiveback: num(merged.trailGiveback, 0.1, 0.95, this.risk.trailGiveback),
      firstTargetR: num(merged.firstTargetR, 0.3, 5, this.risk.firstTargetR),
      firstTargetPortion: num(merged.firstTargetPortion, 0.1, 0.9, this.risk.firstTargetPortion),
      finalTargetR: num(merged.finalTargetR, 0.6, 12, this.risk.finalTargetR),
      breakEvenAfterFirst: Boolean(merged.breakEvenAfterFirst),
      requireHigherAlignment: Boolean(merged.requireHigherAlignment),
      targetStakePct: Number.isFinite(merged.targetStakePct)
        ? Math.max(0.02, Math.min(1, merged.targetStakePct as number))
        : this.risk.targetStakePct,
      minStakePct: Number.isFinite(merged.minStakePct)
        ? Math.max(0.01, Math.min(1, merged.minStakePct as number))
        : this.risk.minStakePct,
      highConvictionConfidence: num(
        merged.highConvictionConfidence,
        0.5,
        0.99,
        this.risk.highConvictionConfidence
      ),
      maxOverflowPositions: Math.round(
        num(merged.maxOverflowPositions, 0, 10, this.risk.maxOverflowPositions)
      ),
      chopPauseStreak: Math.round(num(merged.chopPauseStreak, 2, 50, this.risk.chopPauseStreak)),
      turboMode: Boolean(merged.turboMode),
      trendFlipProtection: merged.trendFlipProtection !== undefined
        ? Boolean(merged.trendFlipProtection)
        : this.risk.trendFlipProtection,
      trendFlipTrimPortion: num(
        merged.trendFlipTrimPortion,
        0.1,
        0.9,
        this.risk.trendFlipTrimPortion
      ),
      btcFilterEnabled: merged.btcFilterEnabled !== undefined
        ? Boolean(merged.btcFilterEnabled)
        : this.risk.btcFilterEnabled,
      entryCooldownMinutes: Math.round(
        num(merged.entryCooldownMinutes, 0, 120, this.risk.entryCooldownMinutes ?? 0)
      ),
      minQuoteVolume24h: num(
        merged.minQuoteVolume24h,
        100_000,
        1_000_000_000,
        this.risk.minQuoteVolume24h ?? 5_000_000
      ),
      breakEvenBufferR: num(
        merged.breakEvenBufferR,
        0,
        2,
        this.risk.breakEvenBufferR ?? BREAK_EVEN_BUFFER_R
      ),
      maxStaleHours: num(merged.maxStaleHours, 1, 168, this.risk.maxStaleHours ?? 12),
      uncertaintyExitEnabled: merged.uncertaintyExitEnabled !== undefined
        ? Boolean(merged.uncertaintyExitEnabled)
        : (this.risk.uncertaintyExitEnabled ?? true),
      profitLockingEnabled: merged.profitLockingEnabled !== undefined
        ? Boolean(merged.profitLockingEnabled)
        : (this.risk.profitLockingEnabled ?? true),
      climaxExitEnabled: merged.climaxExitEnabled !== undefined
        ? Boolean(merged.climaxExitEnabled)
        : (this.risk.climaxExitEnabled ?? true),
      microTiming15mEnabled: merged.microTiming15mEnabled !== undefined
        ? Boolean(merged.microTiming15mEnabled)
        : (this.risk.microTiming15mEnabled ?? true),
      pullbackEntryEnabled: merged.pullbackEntryEnabled !== undefined
        ? Boolean(merged.pullbackEntryEnabled)
        : (this.risk.pullbackEntryEnabled ?? true),
      dynamicChandelierTrailing: merged.dynamicChandelierTrailing !== undefined
        ? Boolean(merged.dynamicChandelierTrailing)
        : (this.risk.dynamicChandelierTrailing ?? true),
      sessionFilterEnabled: merged.sessionFilterEnabled !== undefined
        ? Boolean(merged.sessionFilterEnabled)
        : (this.risk.sessionFilterEnabled ?? false),
      allowedSessions: Array.isArray(merged.allowedSessions)
        ? (merged.allowedSessions as MarketSession[])
        : (this.risk.allowedSessions ?? ['ASIA', 'LONDON', 'NEW_YORK']),
      pyramidingEnabled: merged.pyramidingEnabled !== undefined
        ? Boolean(merged.pyramidingEnabled)
        : (this.risk.pyramidingEnabled ?? true),
      pyramidMinConfidence: num(
        merged.pyramidMinConfidence,
        0.05,
        0.99,
        this.risk.pyramidMinConfidence ?? 0.85
      ),
      pullbackFilterEnabled: merged.pullbackFilterEnabled !== undefined
        ? Boolean(merged.pullbackFilterEnabled)
        : (this.risk.pullbackFilterEnabled ?? true),
      ignoreDailyLimit: merged.ignoreDailyLimit !== undefined
        ? Boolean(merged.ignoreDailyLimit)
        : (this.risk.ignoreDailyLimit ?? false),
      rsFilterEnabled: merged.rsFilterEnabled !== undefined
        ? Boolean(merged.rsFilterEnabled)
        : (this.risk.rsFilterEnabled ?? false),
      reversal15mRequired: merged.reversal15mRequired !== undefined
        ? Boolean(merged.reversal15mRequired)
        : (this.risk.reversal15mRequired ?? true),
      minTradeMarginUsdt: num(merged.minTradeMarginUsdt, 1, 1000, this.risk.minTradeMarginUsdt ?? 35),
      maxFundingRateLong: num(merged.maxFundingRateLong, 0.0001, 0.01, this.risk.maxFundingRateLong ?? 0.0005),
      minFundingRateShort: num(merged.minFundingRateShort, -0.01, -0.0001, this.risk.minFundingRateShort ?? -0.0005),
      breakoutBypassEnabled: merged.breakoutBypassEnabled !== undefined
        ? Boolean(merged.breakoutBypassEnabled)
        : (this.risk.breakoutBypassEnabled ?? true),
      dynamicRunnersEnabled: merged.dynamicRunnersEnabled !== undefined
        ? Boolean(merged.dynamicRunnersEnabled)
        : (this.risk.dynamicRunnersEnabled ?? true),
      stagnationExitEnabled: merged.stagnationExitEnabled !== undefined
        ? Boolean(merged.stagnationExitEnabled)
        : (this.risk.stagnationExitEnabled ?? true),
      stagnationHours: num(merged.stagnationHours, 0.5, 48, this.risk.stagnationHours ?? 2.5),
      stagnationMaxR: num(merged.stagnationMaxR, 0.05, 1.5, this.risk.stagnationMaxR ?? 0.35),
      spreadShieldEnabled: merged.spreadShieldEnabled !== undefined
        ? Boolean(merged.spreadShieldEnabled)
        : (this.risk.spreadShieldEnabled ?? true),
      maxSpreadPct: num(merged.maxSpreadPct, 0.0001, 0.02, this.risk.maxSpreadPct ?? 0.0015),
      btcFlashDumpThreshold: num(merged.btcFlashDumpThreshold, -0.1, -0.002, this.risk.btcFlashDumpThreshold ?? -0.012),
      earlyBreakEvenR: num(merged.earlyBreakEvenR, 0.5, 3.0, this.risk.earlyBreakEvenR ?? 1.2),
      btcChopFilterEnabled: merged.btcChopFilterEnabled !== undefined
        ? Boolean(merged.btcChopFilterEnabled)
        : (this.risk.btcChopFilterEnabled ?? false),
      pauseNewEntries: merged.pauseNewEntries !== undefined
        ? Boolean(merged.pauseNewEntries)
        : (this.risk.pauseNewEntries ?? false),
      mssProtectionEnabled: merged.mssProtectionEnabled !== undefined
        ? Boolean(merged.mssProtectionEnabled)
        : (this.risk.mssProtectionEnabled ?? true),
      premiumDiscountFilterEnabled: merged.premiumDiscountFilterEnabled !== undefined
        ? Boolean(merged.premiumDiscountFilterEnabled)
        : (this.risk.premiumDiscountFilterEnabled ?? false),
      imbalanceScalpEnabled: merged.imbalanceScalpEnabled !== undefined
        ? Boolean(merged.imbalanceScalpEnabled)
        : (this.risk.imbalanceScalpEnabled ?? true),
      ltfSniper5mEnabled: merged.ltfSniper5mEnabled !== undefined
        ? Boolean(merged.ltfSniper5mEnabled)
        : (this.risk.ltfSniper5mEnabled ?? true),
      smtFilterEnabled: merged.smtFilterEnabled !== undefined
        ? Boolean(merged.smtFilterEnabled)
        : (this.risk.smtFilterEnabled ?? true),
      volumeProfileEnabled: merged.volumeProfileEnabled !== undefined
        ? Boolean(merged.volumeProfileEnabled)
        : (this.risk.volumeProfileEnabled ?? true),
      maxPortfolioHeat: num(merged.maxPortfolioHeat, 0.005, 0.5, this.risk.maxPortfolioHeat ?? 0.050),
      maxCorrelatedRisk: num(merged.maxCorrelatedRisk, 0.005, 0.3, this.risk.maxCorrelatedRisk ?? 0.030),
      minScore: patch.minScore !== undefined
        ? num(patch.minScore, 10, 100, this.risk.minScore ?? 65)
        : (patch.minConfidence !== undefined
            ? Math.max(10, Math.min(100, Math.round(patch.minConfidence * 100)))
            : (this.risk.minScore ?? 65)),
      minReversalScore: num(merged.minReversalScore, 10, 100, this.risk.minReversalScore ?? 80),
      goldenZoneLow: num(merged.goldenZoneLow, 0.1, 0.9, this.risk.goldenZoneLow ?? 0.618),
      goldenZoneHigh: num(merged.goldenZoneHigh, 0.1, 0.95, this.risk.goldenZoneHigh ?? 0.650),
      minimumRrSwing: num(merged.minimumRrSwing, 0.5, 10, this.risk.minimumRrSwing ?? 2.0),
      minimumRrPullback: num(merged.minimumRrPullback, 0.5, 10, this.risk.minimumRrPullback ?? 1.5),
      minimumRrBreakout: num(merged.minimumRrBreakout, 0.5, 10, this.risk.minimumRrBreakout ?? 2.0),
      minReturnOnMargin: num(merged.minReturnOnMargin, 0, 5, this.risk.minReturnOnMargin ?? 0.50),
      cooldownTpMinutes: num(merged.cooldownTpMinutes, 0, 1440, this.risk.cooldownTpMinutes ?? 15),
      cooldownBeMinutes: num(merged.cooldownBeMinutes, 0, 1440, this.risk.cooldownBeMinutes ?? 30),
      cooldownSlMinutes: num(merged.cooldownSlMinutes, 0, 1440, this.risk.cooldownSlMinutes ?? 60),
      cooldownFakeoutMinutes: num(merged.cooldownFakeoutMinutes, 0, 1440, this.risk.cooldownFakeoutMinutes ?? 120),
      newsTradingEnabled: merged.newsTradingEnabled !== undefined
        ? Boolean(merged.newsTradingEnabled)
        : (this.risk.newsTradingEnabled ?? true),
      newsCatalystBypassPullback: merged.newsCatalystBypassPullback !== undefined
        ? Boolean(merged.newsCatalystBypassPullback)
        : (this.risk.newsCatalystBypassPullback ?? true),
      newsAdversePositionProtect: merged.newsAdversePositionProtect !== undefined
        ? Boolean(merged.newsAdversePositionProtect)
        : (this.risk.newsAdversePositionProtect ?? true),
      macroShieldEnabled: merged.macroShieldEnabled !== undefined
        ? Boolean(merged.macroShieldEnabled)
        : (this.risk.macroShieldEnabled ?? true),
    };
    // Keep the pairs coherent regardless of the order the user edits them in.
    this.risk.maxRiskPct = Math.max(this.risk.maxRiskPct, this.risk.baseRiskPct);
    this.risk.maxLeverage = Math.max(this.risk.maxLeverage, this.risk.minLeverage);
    this.risk.finalTargetR = Math.max(this.risk.finalTargetR, this.risk.firstTargetR + 0.3);
    this.risk.highConvictionConfidence = Math.max(
      this.risk.highConvictionConfidence,
      this.risk.minConfidence
    );
    if (!this.risk.entryCooldownMinutes) {
      this.lastEntryAt = 0;
    }
    return this.risk;
  }

  /** Exit behaviour derived from the active risk profile. */
  private exitTuning(): ExitTuning {
    // Turbo arms the trailing stop sooner — 0.8R instead of the configured
    // value when that would otherwise be later — so profit locks in faster on
    // the quick, higher-leverage trades the mode is built for.
    const trailArmR = this.risk.turboMode ? Math.min(this.risk.trailArmR, 0.8) : this.risk.trailArmR;
    return {
      trailArmR,
      trailGiveback: this.risk.trailGiveback,
      breakEvenAfterFirst: this.risk.breakEvenAfterFirst,
      breakEvenBufferR: this.risk.breakEvenBufferR ?? BREAK_EVEN_BUFFER_R,
    };
  }

  /** Start the autonomous loop and run one cycle immediately. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.log('info', 'Engine gestart — autonome modus actief');
    void this.tick().catch(() => {});
  }

  /** Stop the autonomous loop. Open positions are left untouched. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fast = false;
    void this.log('info', 'Engine gestopt');
  }

  /**
   * Run a cycle, then re-arm the timer at whatever cadence the current market
   * state calls for.
   *
   * Self-rescheduling rather than a fixed interval, so the gap between cycles can
   * change without tearing the loop down — and so a slow cycle can never overlap
   * the next one.
   */
  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      const minScanGap = 30_000;
      if (this.fast && now - this.lastFullScanAt < minScanGap) {
        if (!this.busy && !this.resetting) {
          this.busy = true;
          try {
            await this.refreshMarks();
            await this.reconcileLivePositions();
            await this.manageOpenPositions();
          } finally {
            this.busy = false;
          }
        }
      } else {
        this.lastFullScanAt = now;
        await this.cycle();
      }
      if (this.stopped) return;
      const wasFast = this.fast;
      this.fast = await this.nearDecision();
      if (this.fast !== wasFast) {
        await this.log(
          'info',
          this.fast
            ? `Sneller scannen (${this.fastIntervalSec}s) — setup dicht bij trigger`
            : `Terug naar normaal scannen (${this.intervalSec}s)`
        );
      }
    } catch (err) {
      ErrorLogger.getInstance().error('Engine', err, { phase: 'tick' });
      await this.log('error', `Fout in engine tick: ${(err as Error).message}`).catch(() => {});
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick().catch(() => {}), this.cadenceSec * 1000);
      }
    }
  }

  /**
   * Whether anything is close enough to a decision to justify the fast cycle.
   *
   * Two cases matter: a signal about to clear the confidence threshold, and an
   * open position approaching its stop or next target. Everything else waits.
   */
  private async nearDecision(): Promise<boolean> {
    const open = await this.store.positions('OPEN');

    for (const position of open) {
      const price = this.marks.get(position.symbol);
      if (!price) continue;
      const unit = position.initialRisk || Math.abs(position.entry - position.stopLoss);
      if (!unit) continue;
      if (Math.abs(price - position.stopLoss) / unit <= WATCH_R) return true;
      const next = position.takeProfits?.find((t) => !t.hit);
      if (next && Math.abs(next.price - price) / unit <= WATCH_R) return true;
    }

    // A halt block means nothing can open regardless of slots. A full book
    // still has overflow room for a high-conviction signal, so it is not an
    // automatic "nothing to watch for" case the way it used to be.
    if (this.blockedReason?.kind === 'halt') return false;
    const atRisk = open.filter((p) => !isPositionDerisked(p));
    const atCap = atRisk.length >= this.risk.maxOpenPositions;
    const overflowUsed = Math.max(0, atRisk.length - this.risk.maxOpenPositions);
    const overflowLeft = this.risk.maxOverflowPositions - overflowUsed;
    if (atCap && overflowLeft <= 0) return false;

    const held = new Set(open.map((p) => p.symbol));
    const book = atRisk.map((p) => ({ symbol: p.symbol, side: p.side }));
    return this.lastSignals.some((s) => {
      if (held.has(s.symbol)) return false;
      // Only setups that would actually be allowed through — a signal the higher
      // timeframe vetoes cannot become a trade no matter how its score moves, and
      // one the concentration caps would reject cannot become a trade either no
      // matter how fast we poll it, so it should not justify the faster cycle.
      if (this.risk.requireHigherAlignment && !s.alignedWithHigher) return false;
      if (concentrationBlock(s, book, this.risk)) return false;
      // Fast watch on breakout candidates with abnormal volume spurt
      const hasVolume = s.checks?.some((c) => c.name === 'Volume Spurt' && c.passed);
      if (hasVolume && s.confidence >= 0.60) return true;
      const bar = atCap ? this.risk.highConvictionConfidence : this.risk.minConfidence;
      const gap = bar - s.confidence;
      return gap <= WATCH_BAND;
    });
  }

  /**
   * Run one full cycle: refresh prices, manage open positions, then look for
   * new entries. Overlapping invocations are ignored.
   */
  async cycle(): Promise<void> {
    if (this.busy || this.resetting) return;
    this.busy = true;
    try {
      await this.refreshMarks();
      await this.reconcileLivePositions();
      await this.manageOpenPositions();
      await this.scanAndEnter();
    } catch (err) {
      ErrorLogger.getInstance().error('Engine', err, { phase: 'cycle' });
      await this.log('error', `Cyclus mislukt: ${(err as Error).message}`);
      void notify({ kind: 'engine-error', message: `Scan-cyclus mislukt: ${(err as Error).message}` });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Build the live account snapshot including unrealised pnl, and persist the
   * running equity peak so drawdown protection survives restarts.
   *
   * @returns the account snapshot.
   */
  async account(): Promise<Account> {
    if (this.exchange.status().enabled) {
      try {
        const assets = await this.exchange.getAccountAssets();
        const usdt = assets.find((a) => a.currency === 'USDT' || a.currency === 'USDC');
        if (usdt && Number.isFinite(usdt.equity) && usdt.equity > 0) {
          const balance = usdt.available;
          const equity = usdt.equity;
          const usedMargin = usdt.frozen;
          if (!this.liveStartingBalance) this.liveStartingBalance = equity;
          if (equity > this.livePeakEquity) this.livePeakEquity = equity;
          const peakEquity = this.livePeakEquity || equity;
          const drawdownPct = peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : 0;
          const today = new Date().toISOString().slice(0, 10);
          void this.store.saveAccount({
            balance,
            startingBalance: this.liveStartingBalance,
            realisedPnl: 0,
            peakEquity,
            dayStartEquity: this.liveDayStartEquity || equity,
            dayKey: today,
          }).catch(() => {});
          return {
            balance,
            equity,
            usedMargin,
            realisedPnl: 0,
            unrealisedPnl: equity - balance - usedMargin,
            startingBalance: this.liveStartingBalance,
            peakEquity,
            drawdownPct,
          };
        }
      } catch {
        // Fallback to store if MEXC API request fails
      }
    }

    const state = await this.store.account();
    const open = await this.store.positions('OPEN');
    let unrealised = 0;
    let usedMargin = 0;
    for (const p of open) {
      usedMargin += p.margin;
      unrealised += Math.max(this.pnlOf(p, this.markOf(p)), -p.margin);
    }
    const equity = state.balance + usedMargin + unrealised;
    const peakEquity = Math.max(state.peakEquity, equity);
    if (peakEquity > state.peakEquity) {
      // Atomic $max — a concurrent cycle computing the same peak from a stale
      // read can never stomp a higher value another caller just wrote.
      await this.store.applyPeakEquity(peakEquity);
    }
    return {
      balance: state.balance,
      equity,
      usedMargin,
      realisedPnl: state.realisedPnl,
      unrealisedPnl: unrealised,
      startingBalance: state.startingBalance,
      peakEquity,
      drawdownPct: peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : 0,
    };
  }

  /**
   * Force-close an open position at the current market price.
   *
   * @param id position id.
   * @returns true when the position was found and closed.
   */
  async closePosition(id: string): Promise<boolean> {
    if (this.resetting || this.closingPositions.has(id)) return false;
    this.closingPositions.add(id);
    try {
      const open = await this.store.positions('OPEN');
      const position = open.find((p) => p.id === id);
      if (!position) return false;
      if (position.live && !this.exchange.status().enabled) {
        await this.reportLiveExecutionBlocked();
        return false;
      }
      const price = await this.livePrice(position.symbol);
      if (!Number.isFinite(price) || price <= 0) return false;
      return await this.closeUnlocked(position, price, 'MANUAL');
    } finally {
      this.closingPositions.delete(id);
    }
  }

  /**
   * Close all active positions immediately at market (panic / emergency close).
   * Works for both paper and live positions.
   */
  async closeAllPositions(): Promise<{ closed: number; total: number; errors: string[] }> {
    const open = await this.store.positions('OPEN');
    let closed = 0;
    const errors: string[] = [];

    for (const position of open) {
      try {
        const ok = await this.closePosition(position.id);
        if (ok) {
          closed += 1;
        } else {
          errors.push(`${position.symbol}: kon positie niet sluiten`);
        }
      } catch (err) {
        errors.push(`${position.symbol}: ${(err as Error).message}`);
      }
    }

    await this.log(
      closed > 0 ? 'trade' : 'warn',
      `🚨 Noodsluiting voltooid: ${closed}/${open.length} posities gesloten.${errors.length ? ` Fouten: ${errors.join(', ')}` : ''}`
    );

    return { closed, total: open.length, errors };
  }

  /**
   * Partially reduce an open position (e.g. 50% profit take).
   *
   * @param id position id
   * @param fraction fraction to close (0 < fraction < 1, defaults to 0.5)
   * @returns true if position was reduced, false otherwise
   */
  async reducePosition(id: string, fraction = 0.5): Promise<boolean> {
    if (this.resetting || this.closingPositions.has(id)) return false;
    const boundedFraction = Math.max(0.01, Math.min(0.99, fraction));
    this.closingPositions.add(id);
    try {
      const open = await this.store.positions('OPEN');
      const position = open.find((p) => p.id === id);
      if (!position || position.remainingQuantity <= 0) return false;
      if (position.live && !this.exchange.status().enabled) {
        await this.reportLiveExecutionBlocked();
        return false;
      }
      const price = await this.livePrice(position.symbol);
      if (!Number.isFinite(price) || price <= 0) return false;

      const reduceQty = position.remainingQuantity * boundedFraction;
      const reduceMargin = position.margin * (reduceQty / position.remainingQuantity);
      const direction = position.side === 'LONG' ? 1 : -1;
      const trancheGrossPnl = direction * (price - position.entry) * reduceQty;
      const exitFee = reduceQty * price * FEE;
      const trancheNetPnl = trancheGrossPnl - exitFee;

      if (position.live) {
        const reduced = await this.reduceLivePosition(position, reduceQty);
        if (!reduced) return false;
        if (position.liveStopOrderId) {
          await this.moveLiveStop(position, position.stopLoss, position.remainingQuantity - reduceQty);
        }
      }

      const nextRemaining = position.remainingQuantity - reduceQty;
      const nextMargin = Math.max(0, position.margin - reduceMargin);
      const nextNotional = position.notional * (nextRemaining / position.quantity);

      await this.store.updatePosition(position.id, {
        remainingQuantity: nextRemaining,
        margin: nextMargin,
        notional: nextNotional,
        realisedPnl: (position.realisedPnl || 0) + trancheNetPnl,
      });

      await this.store.applyBalanceDelta({
        balance: reduceMargin + trancheNetPnl,
        realisedPnl: trancheNetPnl,
      });

      position.remainingQuantity = nextRemaining;
      position.margin = nextMargin;
      position.notional = nextNotional;
      position.realisedPnl = (position.realisedPnl || 0) + trancheNetPnl;

      await this.log(
        'trade',
        `✂️ DEELSLUITING ${position.side} ${position.symbol} @ ${price} · ${Math.round(boundedFraction * 100)}% gesloten · PnL ${trancheNetPnl >= 0 ? '+' : ''}${trancheNetPnl.toFixed(2)}${position.live ? ' · 🔴 LIVE' : ''}`
      );
      void notify({
        kind: 'trade-close',
        message: `✂️ DEELSLUITING ${position.side} ${position.symbol} @ ${price} · ${Math.round(boundedFraction * 100)}% gesloten · PnL ${trancheNetPnl >= 0 ? '+' : ''}${trancheNetPnl.toFixed(2)}${position.live ? ' · LIVE' : ''}`,
      });
      return true;
    } finally {
      this.closingPositions.delete(id);
    }
  }

  /**
   * Override the mark price for a symbol and immediately run position
   * management against it.
   *
   * This exists to verify exit behaviour — take-profit fills, break-even moves,
   * stop triggers — without waiting for the live market to travel there. It only
   * affects the paper book; no market data is modified.
   *
   * @param symbol the market to move.
   * @param price the price to simulate.
   * @returns the position state after management ran.
   */
  async simulatePrice(symbol: string, price: number): Promise<Position[]> {
    if (!Number.isFinite(price) || price <= 0) throw new Error('invalid price');
    void symbol;
    throw new Error('Synthetic price simulation is disabled; it cannot safely be isolated from live position management.');
  }

  /** Reset the paper account and wipe all history. */
  async reset(): Promise<void> {
    if (this.busy || this.resetting || this.closingPositions.size > 0) {
      throw new Error('Cannot reset while engine or position mutations are in progress.');
    }
    this.resetting = true;
    try {
      const liveOpen = (await this.store.positions('OPEN')).some((position) => position.live);
      if (liveOpen) {
        throw new Error('Cannot reset while live venue positions are tracked; reconcile them manually first.');
      }
      await this.store.reset();
      this.lastSignals = [];
      this.blockedReason = null;
      this.marks.clear();
      this.missingTicks.clear();
      await this.log('warn', 'Account gereset naar startsaldo');
    } finally {
      this.resetting = false;
    }
  }

  /**
   * Refresh mark prices for every open position in a single batched request,
   * instead of one HTTP call per position per check.
   */
  private async refreshMarks(): Promise<void> {
    const open = await this.store.positions('OPEN');
    if (!open.length) return;
    let tickers: Ticker[] = [];
    try {
      tickers = await this.market.tickers(this.priceMaxAgeMs());
    } catch (err) {
      await this.log('warn', `Prijzen verversen mislukt: ${(err as Error).message}`);
    }
    const bySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker.lastPrice]));
    await Promise.all(open.map(async (position) => {
      const tickerPrice = bySymbol.get(position.symbol);
      if (Number.isFinite(tickerPrice) && tickerPrice! > 0) {
        this.marks.set(position.symbol, tickerPrice!);
        this.missingTicks.delete(position.symbol);
        return;
      }
      const price = await this.livePrice(position.symbol);
      if (Number.isFinite(price) && price > 0) {
        this.marks.set(position.symbol, price);
        this.missingTicks.delete(position.symbol);
      } else {
        this.marks.delete(position.symbol);
        this.missingTicks.set(position.symbol, (this.missingTicks.get(position.symbol) || 0) + 1);
      }
    }));
  }

  /**
   * Reconcile the engine's own bookkeeping for live positions against what
   * MEXC actually reports before this cycle's stop/target/trailing logic runs.
   *
   * The engine can only track fills, closes and cancellations that happen
   * through its own API calls. Anything that happens directly on the exchange
   * — a manual close in the MEXC app, a broker-side stop-order trigger while
   * the process was offline, a partial fill, or a venue-side cancellation —
   * never reaches the local `Position` record, so without this check the
   * engine would keep "managing" (and reporting) a position that no longer
   * exists, or with a size that no longer matches reality.
   *
   * Runs once per cycle, only when live trading is enabled and at least one
   * locally-tracked position is flagged `live`. A single `getOpenPositions()`
   * call covers every symbol, so this stays cheap even with several open
   * positions.
   */
  private async reconcileLivePositions(): Promise<void> {
    if (!this.exchange.status().configured) return;
    let onVenue: Awaited<ReturnType<MexcExchangeAdapter['getOpenPositions']>>;
    try {
      onVenue = await this.exchange.getOpenPositions();
    } catch (err) {
      await this.log('warn', `Reconciliatie mislukt — kon posities niet ophalen bij Hyperliquid: ${(err as Error).message}`);
      return;
    }

    const open = await this.store.positions('OPEN');
    const liveOpen = open.filter((p) => p.live);
    const positionKey = (symbol: string, side: Position['side']) => `${symbol}:${side}`;
    const byPosition = new Map(onVenue.map((p) => [positionKey(p.symbol, p.side), p]));

    for (const position of liveOpen) {
      const venue = byPosition.get(positionKey(position.symbol, position.side));
      const contractSize = position.liveContractSize || 1;

      if (!venue || venue.side !== position.side || venue.vol <= 0) {
        // The engine thinks this is open and live, but MEXC no longer shows it —
        // closed manually, stopped out broker-side while offline, or reversed.
        // Settle it locally at the last known mark so the paper book (balance,
        // stats, dashboard) stops reflecting a position that is already gone.
        // No reduce order is sent — there is nothing left on the venue to reduce.
        const price = this.markOf(position);
        let exitReason: NonNullable<Position['exitReason']> = 'MANUAL';
        if (position.side === 'LONG') {
          if (price <= position.stopLoss) exitReason = 'STOP_LOSS';
          else if (position.takeProfit && price >= position.takeProfit) exitReason = 'TAKE_PROFIT';
        } else {
          if (price >= position.stopLoss) exitReason = 'STOP_LOSS';
          else if (position.takeProfit && price <= position.takeProfit) exitReason = 'TAKE_PROFIT';
        }
        await this.settleExternally(position, price, exitReason);
        continue;
      }

      const expectedQty = position.remainingQuantity ?? position.quantity;
      const expectedVol = expectedQty / contractSize;
      const detail = await this.market
        .contractDetail(position.symbol)
        .catch(() => ({ contractSize, minVol: 0.0001, maxVol: 100000, priceScale: 4 }));
      const minDelta = (detail.minVol && detail.minVol > 0) ? detail.minVol * 0.5 : 0.00001;
      const volDiff = venue.vol - expectedVol;

      if (Math.abs(volDiff) > minDelta) {
        const newQty = venue.vol * contractSize;
        const priceScale = detail.priceScale ?? 4;
        const isLiveArmed = this.exchange.status().enabled;

        if (volDiff > 0) {
          // Handmatige bijkoop op exchange / manual scale-in
          const addedVol = volDiff;
          const addedQty = addedVol * contractSize;
          const oldEntry = position.entry;
          const newEntry = venue.entryPrice > 0 ? venue.entryPrice : oldEntry;
          const isLong = position.side === 'LONG';
          const dir = isLong ? 1 : -1;

          // Bereken stop distance. Als er al een SL was, behoud het risico vanaf de nieuwe gewogen entry
          const oldStopDist = Math.abs(oldEntry - position.stopLoss);
          const stopDist = oldStopDist > 0 ? oldStopDist : newEntry * 0.05;

          // Bepaal nieuwe SL prijs:
          // Als de positie al break-even of trailing was, mag het risico niet verslechteren
          let newStopLoss = position.stopLoss;
          if (isLong) {
            const calculatedSl = Number((newEntry - stopDist).toFixed(priceScale));
            newStopLoss = position.breakEven || position.trailingArmed
              ? Math.max(position.stopLoss, calculatedSl)
              : calculatedSl;
          } else {
            const calculatedSl = Number((newEntry + stopDist).toFixed(priceScale));
            newStopLoss = position.breakEven || position.trailingArmed
              ? Math.min(position.stopLoss, calculatedSl)
              : calculatedSl;
          }

          // Bereken TP-targets via coin-profiel zodat meme/DeFi/L1 hun eigen R-multiples krijgen
          const cpBijkoop = getCoinProfile(position.symbol);
          const r1 = cpBijkoop.firstTargetR;
          const r2 = Number((r1 + (cpBijkoop.finalTargetR - r1) * 0.45).toFixed(1));
          const r3 = cpBijkoop.finalTargetR;
          const p1 = cpBijkoop.firstTargetPortion;
          const p2 = Number(((1 - p1) / 2).toFixed(2));
          const p3 = Number((1 - p1 - p2).toFixed(2));
          const currentRisk = Math.abs(newEntry - newStopLoss);

          const updatedTakeProfits = (position.takeProfits && position.takeProfits.length > 0)
            ? position.takeProfits.map((tp) => ({
                ...tp,
                hit: false,
                price: Number((newEntry + dir * currentRisk * (tp.rMultiple || r1)).toFixed(priceScale)),
              }))
            : [
                { price: Number((newEntry + dir * currentRisk * r1).toFixed(priceScale)), portion: p1, rMultiple: r1, hit: false },
                { price: Number((newEntry + dir * currentRisk * r2).toFixed(priceScale)), portion: p2, rMultiple: r2, hit: false },
                { price: Number((newEntry + dir * currentRisk * r3).toFixed(priceScale)), portion: p3, rMultiple: r3, hit: false },
              ];

          const newNotional = newQty * newEntry;
          const leverage = venue.leverage || position.leverage || 9;
          const newMargin = newNotional / leverage;

          // 1. Update orders op de exchange als live trading actief is
          if (isLiveArmed) {
            try {
              // Annuleer oude plan orders zodat we geen verouderde volumes of triggers overhouden
              await this.exchange.cancelAllPlanOrders(position.symbol);

              // Plaats nieuwe SL order voor het VOLLEDIGE nieuwe volume
              const stop = await this.exchange.placeStopOrder({
                symbol: position.symbol,
                side: position.side,
                vol: venue.vol,
                triggerPrice: newStopLoss,
                externalOid: `${position.id}-stop-${Date.now()}`,
              });
              position.liveStopOrderId = stop.orderId;

              // Plaats nieuwe TP orders voor het volledige volume
              const step = detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
              let remainingVol = venue.vol;
              for (let i = 0; i < updatedTakeProfits.length; i++) {
                const tp = updatedTakeProfits[i];
                const isLast = i === updatedTakeProfits.length - 1;
                const tpVol = isLast ? roundToStep(remainingVol, step) : Math.max(detail.minVol, roundToStep(venue.vol * tp.portion, step));
                remainingVol = roundToStep(remainingVol - tpVol, step);
                if (tpVol > 0) {
                  await this.exchange
                    .placeTakeProfitOrder({
                      symbol: position.symbol,
                      side: position.side,
                      vol: tpVol,
                      triggerPrice: tp.price,
                      externalOid: `${position.id}-tp-${i + 1}-${Date.now()}`,
                    })
                    .catch((err) => {
                      void this.log('warn', `TP${i + 1} herplaatsen na handmatige aankoop mislukt: ${(err as Error).message}`);
                    });
                }
              }
            } catch (err) {
              await this.log('warn', `Orders updaten op exchange na handmatige bijkoop mislukt voor ${position.symbol}: ${(err as Error).message}`);
            }
          }

          // 2. Update positie in database en geheugen
          const newInitialRisk = Math.abs(newEntry - newStopLoss);
          await this.store.updatePosition(position.id, {
            entry: newEntry,
            quantity: position.quantity + addedQty,
            remainingQuantity: newQty,
            notional: newNotional,
            margin: newMargin,
            leverage,
            stopLoss: newStopLoss,
            takeProfit: updatedTakeProfits[0]?.price ?? position.takeProfit,
            takeProfits: updatedTakeProfits,
            liveStopOrderId: position.liveStopOrderId,
            scaleInCount: (position.scaleInCount ?? 0) + 1,
            scaledInAt: Date.now(),
            initialRisk: newInitialRisk,
          });

          position.entry = newEntry;
          position.quantity += addedQty;
          position.remainingQuantity = newQty;
          position.notional = newNotional;
          position.margin = newMargin;
          position.leverage = leverage;
          position.stopLoss = newStopLoss;
          position.takeProfit = updatedTakeProfits[0]?.price ?? position.takeProfit;
          position.takeProfits = updatedTakeProfits;
          position.scaleInCount = (position.scaleInCount ?? 0) + 1;
          position.scaledInAt = Date.now();
          position.initialRisk = newInitialRisk;

          await this.log(
            'trade',
            `🔄 Handmatige bijkoop gedetecteerd voor ${position.symbol}: volume gestegen van ${expectedVol} naar ${venue.vol} contracts (${newQty.toFixed(2)} eenheden). Nieuwe avg entry: ${newEntry.toFixed(priceScale)}. SL aangepast naar ${newStopLoss.toFixed(priceScale)}, TPs herberekend voor het volledige volume.`
          );
          void notify({
            kind: 'trade-open',
            message: `🔄 Handmatige bijkoop: ${position.symbol} ${position.side} nu ${venue.vol} contracts @ avg ${newEntry.toFixed(priceScale)}. SL: ${newStopLoss.toFixed(priceScale)}, TP1: ${updatedTakeProfits[0]?.price}. Orders geüpdatet op exchange!`,
          });
        } else {
          // Volume op venue is lager (deel gesloten of TP geraakt)
          const closedQty = Math.max(0, -volDiff * contractSize);
          const dir = position.side === 'LONG' ? 1 : -1;
          const markPx = this.marks.get(position.symbol) || venue.entryPrice;

          // Bepaal welke TP-levels zijn geraakt
          let bookedPnl = 0;
          let movedBreakEven = false;
          let newStop = position.stopLoss;

          const updatedTps = (position.takeProfits || []).map((tp, idx) => {
            const isHit =
              tp.hit ||
              (dir === 1 ? markPx >= tp.price : markPx <= tp.price);
            if (isHit && !tp.hit) {
              if (idx === 0) movedBreakEven = true;
              return { ...tp, hit: true };
            }
            return tp;
          });

          // Als er geen specifiek TP level gematcht werd maar volume toch daalde:
          const unhitTp = position.takeProfits?.find((t) => !t.hit);
          const effectiveFillPx = unhitTp?.price || markPx;
          bookedPnl = dir * (effectiveFillPx - position.entry) * closedQty;

          if (movedBreakEven || (position.takeProfits && position.takeProfits[0]?.hit)) {
            position.breakEven = true;
            const isStopBeyondEntry = dir === 1 ? newStop >= position.entry : newStop <= position.entry;
            if (!isStopBeyondEntry) {
              newStop = position.entry;
            }
          }

          const leverage = position.leverage || 5;
          const freedMargin = (closedQty * position.entry) / leverage;
          const newRealised = (position.realisedPnl || 0) + bookedPnl;
          const newMargin = Math.max(0, position.margin - freedMargin);
          const newNotional = Math.max(0, newQty * position.entry);

          await this.log(
            'trade',
            `🎯 Deelsluiting / TP geraakt op exchange voor ${position.symbol} ${position.side}: ${closedQty.toFixed(2)} contracten gesloten (+${bookedPnl >= 0 ? '$' : '-$'}${Math.abs(bookedPnl).toFixed(2)} winst geboekt). Restant: ${newQty.toFixed(2)} contracten${movedBreakEven ? ' · Stop naar break-even' : ''}.`
          );

          if (bookedPnl !== 0 || freedMargin > 0) {
            await this.store.applyBalanceDelta({
              balance: freedMargin + bookedPnl,
              realisedPnl: bookedPnl,
            });
          }

          position.remainingQuantity = Math.max(0, newQty);
          position.realisedPnl = newRealised;
          position.margin = newMargin;
          position.notional = newNotional;
          position.stopLoss = newStop;
          position.takeProfits = updatedTps;

          if (isLiveArmed && newQty > 0) {
            await this.moveLiveStop(position, newStop, newQty).catch(() => {});
          }

          await this.store.updatePosition(position.id, {
            remainingQuantity: newQty,
            realisedPnl: newRealised,
            margin: newMargin,
            notional: newNotional,
            breakEven: position.breakEven,
            stopLoss: newStop,
            takeProfits: updatedTps,
            liveStopOrderId: position.liveStopOrderId,
          });
        }
      }
    }

    // Adopt any positions open on MEXC that were not in the local book (e.g. after server restart)
    const tracked = new Set(liveOpen.map((p) => positionKey(p.symbol, p.side)));
    for (const venue of onVenue) {
      if (!tracked.has(positionKey(venue.symbol, venue.side)) && venue.vol > 0) {
        const detail = await this.market
          .contractDetail(venue.symbol)
          .catch(() => ({ contractSize: 1, minVol: 1, maxVol: 100000, priceScale: 4 }));
        const contractSize = detail.contractSize || 1;
        const qty = venue.vol * contractSize;
        const entry = venue.entryPrice;
        const notional = qty * entry;
        const leverage = venue.leverage || 9;
        const margin = notional / leverage;
        const scale = detail.priceScale ?? 4;
        const dir = venue.side === 'LONG' ? 1 : -1;
        const stopDistance = entry * 0.05;
        let stopLoss = Number((venue.side === 'LONG' ? entry - stopDistance : entry + stopDistance).toFixed(scale));
        // TP-doelen via coin-profiel zodat meme/DeFi/L1 hun eigen R-multiples krijgen
        const cpAdopted = getCoinProfile(venue.symbol);
        const adR1 = cpAdopted.firstTargetR;
        const adR2 = Number((adR1 + (cpAdopted.finalTargetR - adR1) * 0.45).toFixed(1));
        const adR3 = cpAdopted.finalTargetR;
        const adP1 = cpAdopted.firstTargetPortion;
        const adP2 = Number(((1 - adP1) / 2).toFixed(2));
        const adP3 = Number((1 - adP1 - adP2).toFixed(2));
        const dirAdopted = venue.side === 'LONG' ? 1 : -1;
        const tp1 = Number((entry + dirAdopted * stopDistance * adR1).toFixed(scale));
        const tp2 = Number((entry + dirAdopted * stopDistance * adR2).toFixed(scale));
        const tp3 = Number((entry + dirAdopted * stopDistance * adR3).toFixed(scale));

        let liveStopOrderId: string | undefined;
        const takeProfits = [
          { price: tp1, portion: adP1, rMultiple: adR1, hit: false },
          { price: tp2, portion: adP2, rMultiple: adR2, hit: false },
          { price: tp3, portion: adP3, rMultiple: adR3, hit: false },
        ];

        try {
          const venuePlanOrders = await this.exchange.getOpenPlanOrders(venue.symbol);
          const isLong = venue.side === 'LONG';
          // SL: triggerType 2 for LONG, 1 for SHORT
          const slOrders = venuePlanOrders
            .filter((o) => (isLong ? o.triggerType === 2 && o.side === 4 : o.triggerType === 1 && o.side === 2))
            .sort((a, b) => b.createTime - a.createTime);

          if (slOrders.length > 0) {
            liveStopOrderId = slOrders[0].id;
            stopLoss = slOrders[0].triggerPrice;
          }

          // TP: triggerType 1 for LONG, 2 for SHORT
          const tpOrders = venuePlanOrders
            .filter((o) => (isLong ? o.triggerType === 1 && o.side === 4 : o.triggerType === 2 && o.side === 2))
            .sort((a, b) => (isLong ? a.triggerPrice - b.triggerPrice : b.triggerPrice - a.triggerPrice));

          if (tpOrders.length > 0) {
            for (let i = 0; i < Math.min(takeProfits.length, tpOrders.length); i++) {
              takeProfits[i].price = tpOrders[i].triggerPrice;
            }
            takeProfits.sort((a, b) => (isLong ? a.price - b.price : b.price - a.price));
          }
        } catch {
          // If plan order query fails, continue with calculated values
        }

        const adopted: Position = {
          id: randomUUID(),
          symbol: venue.symbol,
          side: venue.side,
          entry,
          quantity: qty,
          leverage,
          margin,
          initialMargin: margin,
          notional,
          stopLoss,
          takeProfit: takeProfits[takeProfits.length - 1]?.price ?? tp3,
          takeProfits,
          remainingQuantity: qty,
          realisedPnl: 0,
          entryFee: notional * FEE,
          initialRisk: stopDistance,
          breakEven: false,
          extreme: entry,
          trailingArmed: false,
          openedAt: venue.createTime || Date.now(),
          status: 'OPEN',
          confidence: 0.8,
          regime: 'TREND_UP',
          reasons: ['Overgenomen van actieve MEXC positie bij reconciliatie'],
          live: true,
          liveContractSize: contractSize,
          liveStopOrderId,
        };
        await this.store.insertPosition(adopted);
        tracked.add(positionKey(venue.symbol, venue.side));
        this.marks.set(adopted.symbol, entry);
        await this.log(
          'info',
          `📥 Bestaande MEXC positie overgenomen: ${adopted.side} ${adopted.symbol} (${venue.vol} contracten @ ${entry}) — beschermd tegen dubbele entries.`
        );
      }
    }
  }

  private async manageOpenPositions(): Promise<void> {
    const open = await this.store.positions('OPEN');
    for (const position of open) {
      if (this.closingPositions.has(position.id)) continue;

      // Missing data is tracked for diagnostics, never used as a synthetic exit price.
      const missCount = this.missingTicks.get(position.symbol) || 0;
      if (missCount >= Engine.MAX_MISSING_TICKS) {
        if (missCount === Engine.MAX_MISSING_TICKS) {
          await this.log(
            'warn',
            `${position.symbol}: geen verse marktdata sinds ${missCount} cycli; positie blijft open tot er een actuele prijs beschikbaar is.`
          );
          this.missingTicks.set(position.symbol, missCount + 1);
        }
        continue;
      }

      const price = this.marks.get(position.symbol);
      // No fresh price means no decision — never act on a stale fallback value.
      if (!price) continue;

      // Paper-only synthetic exits. For live positions, exchange resting orders handle SL/TP;
      // however, if a live position lacks a broker-side stop order, the engine acts as an emergency stop.
      if (!position.live) {
        // Liquidation guard: the margin behind the position is effectively wiped out.
        if (isLiquidated(position, price)) {
          await this.close(position, price, 'LIQUIDATED');
          continue;
        }

        if (isStopHit(position, price)) {
          await this.close(position, price, stopReason(position));
          continue;
        }

        // Staged take-profits: book a tranche at each level the price has reached.
        const filled = await this.takePartialProfits(position, price);
        if (filled === 'CLOSED') continue;
      } else {
        // Emergency stop fallback for live positions: if no broker-side stop is active and stop is breached
        if (!position.liveStopOrderId && isStopHit(position, price)) {
          await this.log(
            'warn',
            `🚨 Noodstop geactiveerd voor live positie ${position.symbol}: geen actieve broker stop-order en stop (${position.stopLoss}) is geraakt.`
          );
          await this.close(position, price, stopReason(position));
          continue;
        }
      }
      // Re-read after any attempted settlement so a failed final close or a
      // concurrent close cannot continue mutating a stale OPEN object.
      const current = await this.store.position(position.id);
      if (!current || current.status !== 'OPEN') continue;

      const ageHours = (Date.now() - current.openedAt) / 3_600_000;
      if (ageHours > this.risk.maxPositionHours) {
        await this.close(current, price, 'MAX_AGE');
        continue;
      }

      const isDerisked = isPositionDerisked(current);

      // Close trades that stagnate without a fee-covered break-even stop or progress towards targets.
      const stagnationEnabled = this.risk.stagnationExitEnabled !== false;
      const stagnationHours = this.risk.stagnationHours ?? 2.5;
      const maxStagnationR = this.risk.stagnationMaxR ?? 0.35;
      if (stagnationEnabled && !isDerisked && ageHours >= stagnationHours) {
        const dir = direction(current);
        const r = riskUnit(current);
        const currentR = r > 0 ? (dir * (price - current.entry)) / r : 0;
        if (Math.abs(currentR) <= maxStagnationR) {
          await this.log(
            'trade',
            `⏱️ Stagnatie Exit: ${current.symbol} staat al ${ageHours.toFixed(1)}u stil (${currentR >= 0 ? '+' : ''}${currentR.toFixed(2)}R) — positie gesloten om kapitaal vrij te maken${current.live ? ' · 🔴 LIVE' : ''}`
          );
          await this.close(current, price, 'STAGNATION');
          continue;
        }
      }

      // Close positions still exposed after maxStaleHours (default 12h) when price has made no significant headway
      // (< 0.8R progress), momentum is dead — close cleanly to recycle capital and free the slot.
      const staleHours = this.risk.maxStaleHours ?? 12;
      if (!isDerisked && ageHours > staleHours) {
        const dir = direction(current);
        const r = riskUnit(current);
        const currentR = r > 0 ? (dir * (price - current.entry)) / r : 0;
        if (currentR < 0.8) {
          await this.log(
            'trade',
            `⏱️ Time-Stop / Stale Trade: ${current.symbol} staat al ${ageHours.toFixed(1)}u open zonder fee-covered break-even stop (${currentR.toFixed(2)}R) — positie gesloten om kapitaal vrij te maken${current.live ? ' · 🔴 LIVE' : ''}`
          );
          await this.close(current, price, 'STALE_TRADE');
          continue;
        }
      }

      // Proactive Adverse News Protection: de-risk or tighten stop if breaking negative news / exploit hits
      if (this.risk.newsAdversePositionProtect !== false && !current.newsProtected) {
        try {
          const adv = await NewsEngine.getInstance().checkAdverseNewsForPosition(
            current.symbol,
            current.side,
            current.openedAt
          );
          if (adv.adverse && adv.news) {
            current.newsProtected = true;
            await this.store.updatePosition(current.id, { newsProtected: true });
            if (adv.isCritical) {
              await this.log(
                'warn',
                `🚨 CRITISCH ADVERS NIEUWS voor ${current.symbol} (${current.side}): "${adv.news.title}" — nood-derisking geactiveerd!`
              );
              void notify({
                kind: 'risk-halt',
                message: `🚨 CRITISCH NIEUWS ${current.symbol}: "${adv.news.title}" — 50% noodsluiting uitgevoerd!`,
              });
              await this.reducePosition(current.id, 0.5);
              continue;
            } else {
              const markPx = this.marks.get(current.symbol) || current.entry;
              const inProfit = current.side === 'LONG' ? markPx > current.entry : markPx < current.entry;
              if (inProfit && !current.breakEven) {
                current.breakEven = true;
                current.stopLoss = current.entry;
                await this.store.updatePosition(current.id, { breakEven: true, stopLoss: current.entry });
                if (current.live && current.remainingQuantity > 0) {
                  await this.moveLiveStop(current, current.entry, current.remainingQuantity).catch(() => {});
                }
                await this.log(
                  'info',
                  `🛡️ Adverse nieuws bescherming voor ${current.symbol}: stop preventief naar break-even (${current.entry}) getrokken.`
                );
              }
            }
          }
        } catch {}
      }

      // Early protection: the regime itself has turned against the position
      // (e.g. held LONG while the market now reads TREND_DOWN), even before a
      // full opposite-side signal fires. Trim part of the size immediately so a
      // real reversal cannot run all the way to the stop before anything is
      // done about it — fires once per position, the remainder stays under the
      // normal stop/trailing/take-profit logic.
      const latest = this.lastSignals.find((s) => s.symbol === current.symbol);
      let fallbackMs = latest?.marketStructure;
      let fallbackHigherRegime = latest?.higherRegime;

      if (!latest) {
        // Fallback: analyze cached candles so protection is never blind if new signal was vetoed
        const cachedCandles = this.market.getCachedCandles(current.symbol, ENTRY_INTERVAL);
        const cachedHigher = this.market.getCachedCandles(current.symbol, CONFIRM_INTERVAL);
        if (cachedCandles && cachedCandles.length >= 30) {
          fallbackMs = analyzeMarketStructure(cachedCandles, price);
        }
        if (cachedHigher && cachedHigher.length >= 30) {
          const higherCloses = cachedHigher.map((c) => c.close);
          fallbackHigherRegime = detectRegime(higherCloses, cachedHigher);
        }
      }

      if (
        this.risk.trendFlipProtection &&
        !current.regimeTrimmed &&
        latest &&
        ((current.side === 'LONG' && latest.regime === 'TREND_DOWN') ||
          (current.side === 'SHORT' && latest.regime === 'TREND_UP'))
      ) {
        const trimmed = await this.trimForTrendFlip(current, price);
        if (trimmed) {
          const after = await this.store.position(current.id);
          if (!after || after.status !== 'OPEN') continue;
          Object.assign(current, after);
        }
      }

      // Market Structure Shift (MSS / CHoCH) Protection:
      // If an adverse structural break (with candle body close) is confirmed against the active position,
      // exit or protect immediately before a full reversal stops it out.
      const activeBreak = latest?.marketStructure?.lastBreak || fallbackMs?.lastBreak;
      if (
        this.risk.mssProtectionEnabled !== false &&
        activeBreak
      ) {
        const adverseBreak =
          (current.side === 'LONG' && activeBreak.direction === 'BEARISH' && (activeBreak.type === 'CHoCH' || activeBreak.type === 'MSS')) ||
          (current.side === 'SHORT' && activeBreak.direction === 'BULLISH' && (activeBreak.type === 'CHoCH' || activeBreak.type === 'MSS'));

        if (adverseBreak) {
          await this.log(
            'trade',
            `🔄 Market Structure Shift (MSS): ${current.side} ${current.symbol} geconfronteerd met ${activeBreak.type} ${activeBreak.direction} — positie direct gesloten ter bescherming van kapitaal${current.live ? ' · 🔴 LIVE' : ''}`
          );
          await this.close(current, price, 'MSS_FLIP');
          continue;
        }
      }

      // Continuous Health & Uncertainty Monitor:
      // Actively inspects open positions on every cycle. If the market structure breaks down,
      // the higher timeframe flips against the trade, opposite momentum emerges, or conviction
      // collapses while in drawdown, close early rather than waiting for the full stop loss.
      if (this.risk.uncertaintyExitEnabled !== false) {
        const effectiveHigher = latest?.higherRegime || fallbackHigherRegime;
        const higherOpposes =
          (current.side === 'LONG' && effectiveHigher === 'TREND_DOWN') ||
          (current.side === 'SHORT' && effectiveHigher === 'TREND_UP');

        if (higherOpposes) {
          await this.log(
            'trade',
            `⚠️ Onzekerheid: 4u-trend voor ${current.symbol} is gedraaid naar ${effectiveHigher} (tegen ${current.side} in) — positie preventief gesloten om kapitaal te beschermen${current.live ? ' · 🔴 LIVE' : ''}`
          );
          await this.close(current, price, 'UNCERTAINTY');
          continue;
        }

        if (latest) {
          const dir = direction(current);
          const pnlPct = (dir * (price - current.entry)) / current.entry;
          const isDerisked = isPositionDerisked(current);

          // 2. Early Opposite Shift: 1h momentum flipped to opposite side with moderate conviction (>= 0.40)
          // (If confidence >= minConfidence, handled below by SIGNAL_FLIP)
          const earlyOppositeShift =
            latest.side !== current.side && latest.confidence >= 0.40 && latest.confidence < this.risk.minConfidence;

          // 3. Conviction Collapse in Drawdown: confidence dropped below 0.35 or entered CHOP while in the red
          const convictionCollapse =
            latest.side === current.side &&
            !isDerisked &&
            pnlPct < -0.005 &&
            (latest.confidence < 0.35 || latest.regime === 'CHOP');

          if (earlyOppositeShift) {
            await this.log(
              'trade',
              `⚠️ Onzekerheid: vroege momentumverschuiving tegen ${current.side} ${current.symbol} (${Math.round(
                latest.confidence * 100
              )}% ${latest.side}) — positie preventief gesloten om kapitaal te beschermen${current.live ? ' · 🔴 LIVE' : ''}`
            );
            await this.close(current, price, 'UNCERTAINTY');
            continue;
          }

          if (convictionCollapse) {
            await this.log(
              'trade',
              `⚠️ Onzekerheid: overtuiging ingestort (${Math.round(
                latest.confidence * 100
              )}%, regime ${latest.regime}) tijdens drawdown (${(pnlPct * 100).toFixed(
                2
              )}%) — positie preventief gesloten om kapitaal te beschermen${current.live ? ' · 🔴 LIVE' : ''}`
            );
            await this.close(current, price, 'UNCERTAINTY');
            continue;
          }
        }
      }

      // Exit when the thesis breaks: the scanner now reads the opposite side with
      // real conviction. Waiting for the stop would give back profit for nothing.
      const flip = latest;
      if (flip && flip.side !== current.side && flip.confidence >= this.risk.minConfidence) {
        await this.close(current, price, 'SIGNAL_FLIP');
        continue;
      }

      // Progressive Profit-Locking Floor:
      // When price reaches +2.2R, +3.2R, +4.2R, ratchet stop-loss up to +0.75R, +1.75R, +2.75R
      // so a winning trade never returns to flat break-even.
      if (this.risk.profitLockingEnabled !== false) {
        const lock = progressiveProfitLock(current, price);
        if (lock && (!current.profitLockR || lock.rLocked > current.profitLockR)) {
          current.stopLoss = lock.stopLoss;
          current.profitLockR = lock.rLocked;
          await this.store.updatePosition(current.id, {
            stopLoss: lock.stopLoss,
            profitLockR: lock.rLocked,
          });
          if (current.live) {
            await this.moveLiveStop(current, lock.stopLoss, current.remainingQuantity ?? current.quantity);
          }
          await this.log(
            'trade',
            `🔒 Winst vastgezet voor ${current.symbol}: stop opgetrokken naar ${lock.stopLoss} (+${lock.rLocked}R winst gegarandeerd)${current.live ? ' · 🔴 LIVE' : ''}`
          );
        }
      }

      // Parabolic Blow-Off Top / Climax Exit:
      // When extreme RSI (>82 for Long, <18 for Short) combines with volume surge (>= 2.2x avg),
      // trim 25% of the position immediately at market to harvest the blow-off peak before the dump.
      if (this.risk.climaxExitEnabled !== false && !current.climaxTrimmed) {
        let candlesForClimax: Candle[] = [];
        let rsiVal: number | undefined;
        try {
          candlesForClimax = await this.market.candles(current.symbol, ENTRY_INTERVAL);
          if (candlesForClimax.length >= 15) {
            rsiVal = rsi(candlesForClimax.map((c) => c.close), 14);
          }
        } catch {
          // non-fatal
        }
        if (detectBlowOffTop(current, candlesForClimax, rsiVal)) {
          const trim = trimForRegimeFlip(current, price, 0.25);
          if (trim) {
            if (current.live) {
              const reduced = await this.reduceLivePosition(current, trim.trimmedQty);
              if (!reduced) continue;
            }
            const { patch, freedMargin } = regimeTrimPatch(current, trim);
            patch.climaxTrimmed = true;
            await this.store.applyBalanceDelta({
              balance: freedMargin + trim.bookedPnl,
              realisedPnl: trim.bookedPnl,
            });
            await this.store.updatePosition(current.id, patch);
            Object.assign(current, patch);
            await this.log(
              'trade',
              `🌋 Climax / Blow-Off Top gedetecteerd voor ${current.symbol} (RSI ${(rsiVal ?? 0).toFixed(0)}) — 25% winst genomen op de piek (+${trim.bookedPnl.toFixed(2)})${current.live ? ' · 🔴 LIVE' : ''}`
            );
          }
        }
      }

      // Early Profit Protection: move stop to break-even once price reaches +1.1R/+1.2R before TP1 fills
      const profile = getCoinProfile(current.symbol);
      const earlyR = this.risk.earlyBreakEvenR ?? profile.earlyBreakEvenR;
      if (!current.breakEven && earlyR > 0) {
        const earlyProtect = earlyProfitProtect(current, price, earlyR);
        if (earlyProtect) {
          current.stopLoss = earlyProtect.stopLoss;
          current.breakEven = true;
          await this.store.updatePosition(current.id, {
            stopLoss: earlyProtect.stopLoss,
            breakEven: true,
          });
          if (current.live) {
            await this.moveLiveStop(current, earlyProtect.stopLoss, current.remainingQuantity ?? current.quantity);
          }
          await this.log(
            'trade',
            `🛡️ Early Break-Even: ${current.symbol} heeft +${earlyR}R bereikt — stop verplaatst naar break-even${current.live ? ' · 🔴 LIVE' : ''}`
          );
        }
      }

      // Trailing stop: once the trade is far enough ahead, lock in and follow.
      const patch = trailPatch(current, price, this.exitTuning());
      if (this.risk.dynamicChandelierTrailing !== false && (patch.trailingArmed || current.trailingArmed)) {
        const peak = patch.extreme ?? current.extreme ?? price;
        const currentAtr = latest?.atrPct
          ? latest.atrPct * price
          : (current.initialRisk ? current.initialRisk / (this.risk.atrStopMultiple || 2) : 0);
        if (currentAtr > 0) {
          const chStop = chandelierStop(current, peak, currentAtr, 1.5);
          const dir = direction(current);
          const existingStop = patch.stopLoss ?? current.stopLoss;
          const isChandelierBetter = dir === 1 ? chStop > existingStop : chStop < existingStop;
          if (isChandelierBetter) {
            patch.stopLoss = chStop;
            patch.trailingArmed = true;
          }
        }
      }
      if (patch.trailingArmed && !current.trailingArmed) {
        await this.log(
          'info',
          `${current.symbol}: trailing stop geactiveerd op +${this.risk.trailArmR}R`
        );
      }
      if (
        current.live &&
        ((!current.liveStopOrderId && current.stopLoss) ||
          (patch.stopLoss !== undefined && patch.stopLoss !== current.stopLoss))
      ) {
        await this.moveLiveStop(current, patch.stopLoss ?? current.stopLoss, current.remainingQuantity);
      }
      // Continuous excursion tracking (MFE / MAE) for AI learning
      const dir = direction(current);
      const riskDistance = current.initialRisk > 0 ? current.initialRisk : Math.abs(current.entry - current.stopLoss);
      if (riskDistance > 0) {
        const curR = ((price - current.entry) * dir) / riskDistance;
        const curPeak = current.peakR !== undefined ? Math.max(current.peakR, curR) : curR;
        const curTrough = current.troughR !== undefined ? Math.min(current.troughR, curR) : curR;
        if (curPeak !== current.peakR) {
          patch.peakR = Math.round(curPeak * 100) / 100;
          current.peakR = patch.peakR;
        }
        if (curTrough !== current.troughR) {
          patch.troughR = Math.round(curTrough * 100) / 100;
          current.troughR = patch.troughR;
        }
      }
      if (Object.keys(patch).length) await this.store.updatePosition(current.id, patch);
    }
  }

  /**
   * Book profit at every target the price has reached since the last check.
   *
   * The first fill also moves the stop to break-even, so a winner can no longer
   * turn into a loser. When the final level fills the position is closed out.
   *
   * @returns what happened, so the caller knows whether to re-read the position.
   */
  private async takePartialProfits(
    position: Position,
    price: number
  ): Promise<'NONE' | 'FILLED' | 'CLOSED'> {
    const fill = fillTakeProfits(position, price);
    if (!fill) return 'NONE';

    if (fill.allDone) {
      // Final tranche filled — settle whatever is left at the last target.
      const settled = await this.settleRemainder(position, fill.levels, fill.bookedPnl, fill.remaining, price);
      return settled ? 'CLOSED' : 'NONE';
    }

    // Mirror the tranche close onto MEXC BEFORE booking it locally — a failed
    // reduce-order here must leave the local position untouched so the next
    // cycle simply retries the same fill instead of the two books diverging.
    if (position.live) {
      const reduced = await this.reduceLivePosition(position, fill.bookedQty);
      if (!reduced) return 'NONE';
    }

    // Release the collateral behind the closed tranche and bank the profit.
    const { patch, freedMargin } = partialFillPatch(position, fill, this.exitTuning());
    // Atomic delta — another position's exit crediting the balance concurrently
    // must not be overwritten by this credit reading a stale balance.
    await this.store.applyBalanceDelta({
      balance: freedMargin + fill.bookedPnl,
      realisedPnl: fill.bookedPnl,
    });
    await this.store.updatePosition(position.id, patch);

    // TP1 may move the stop; the risk gate counts the position derisked only
    // when that stop covers entry fees for the remaining quantity.
    if (patch.stopLoss !== undefined && position.live) {
      await this.moveLiveStop(position, patch.stopLoss, fill.remaining);
      await this.store.updatePosition(position.id, { liveStopOrderId: position.liveStopOrderId ?? undefined });
    }

    const labels = fill.filled.map((t) => `${t.rMultiple}R`).join(', ');
    await this.log(
      'trade',
      `TP ${position.symbol} ${labels} — ${Math.round((fill.bookedQty / position.quantity) * 100)}% gesloten, +${fill.bookedPnl.toFixed(2)} geboekt${!position.breakEven ? ' · stop naar break-even' : ''}${position.live ? ' · 🔴 LIVE' : ''}`
    );
    return 'FILLED';
  }

  /**
   * Trim part of an open position the moment the market regime turns against
   * it, well before the stop-loss or a full opposite-side signal would act.
   *
   * Fires at most once per position (`Position.regimeTrimmed` guards it) — the
   * remainder stays fully managed by the normal stop/trailing/take-profit
   * logic afterwards, so this only ever reduces risk, never replaces the rest
   * of the exit plan.
   *
   * @param position the open position to trim.
   * @param price current mark price.
   * @returns true when a trim was booked, false when nothing fired.
   */
  private async trimForTrendFlip(position: Position, price: number): Promise<boolean> {
    const trim = trimForRegimeFlip(position, price, this.risk.trendFlipTrimPortion);
    if (!trim) return false;

    // Mirror onto MEXC BEFORE booking it locally, same rule as a take-profit
    // tranche — a failed reduce-order must leave the local position untouched.
    if (position.live) {
      const reduced = await this.reduceLivePosition(position, trim.trimmedQty);
      if (!reduced) return false;
    }

    const { patch, freedMargin } = regimeTrimPatch(position, trim);
    await this.store.applyBalanceDelta({
      balance: freedMargin + trim.bookedPnl,
      realisedPnl: trim.bookedPnl,
    });
    await this.store.updatePosition(position.id, patch);

    await this.log(
      'trade',
      `Trendwissel gedetecteerd voor ${position.symbol} — ${Math.round(
        (trim.trimmedQty / (position.remainingQuantity ?? position.quantity)) * 100
      )}% van de positie preventief gesloten (${trim.bookedPnl >= 0 ? '+' : ''}${trim.bookedPnl.toFixed(
        2
      )}) om verlies te beperken bij een echte trendomkeer${position.live ? ' · 🔴 LIVE' : ''}`
    );
    return true;
  }

  /**
   * Run post-mortem analysis on a closing trade and update the adaptive learning state.
   */
  private async recordPostMortem(
    position: Position,
    price: number,
    reason: NonNullable<Position['exitReason']> | string,
    net: number
  ): Promise<TradePostMortem> {
    const postMortem = analyzeClosedTrade(position, price, reason, net);

    try {
      const learning = await this.store.learning();
      const penalties = { ...learning.penalties };
      const prev = penalties[position.symbol] || { symbol: position.symbol, consecutiveLosses: 0 };

      if (net < -0.05) {
        prev.consecutiveLosses = (prev.consecutiveLosses || 0) + 1;
        if (prev.consecutiveLosses >= 2) {
          prev.penalizedUntil = Date.now() + 18 * 3600 * 1000;
          prev.reason = `2x op rij verlies geleden (-${Math.abs(net).toFixed(2)} USDT)`;
          await this.log(
            'warn',
            `🚫 Strafbankje: ${position.symbol} heeft 2x op rij verlies geleden — 18 uur op de reservebank geplaatst om verdere verliezen te voorkomen.`
          );
        }
      } else if (net > 0.05) {
        prev.consecutiveLosses = 0;
        prev.penalizedUntil = undefined;
        prev.reason = undefined;
      }
      penalties[position.symbol] = prev;

      // 1. Update factor statistics & dynamic weights
      const factorStats = { ...learning.factorStats };
      for (const factor of postMortem.entryFactors) {
        const stat = factorStats[factor] || { wins: 0, losses: 0, netR: 0 };
        if (postMortem.verdict === 'WIN') stat.wins += 1;
        else if (postMortem.verdict === 'LOSS') stat.losses += 1;
        stat.netR = Math.round((stat.netR + postMortem.rMultiple) * 100) / 100;
        const total = stat.wins + stat.losses;
        stat.winRate = total > 0 ? Math.round((stat.wins / total) * 100) / 100 : 0;
        stat.weightMultiplier = computeFactorWeight(stat);
        factorStats[factor] = stat;
      }

      // 2. Update session statistics
      const sessionKey = position.session || postMortem.session || getMarketSession(new Date(position.openedAt || Date.now())).session;
      const sessionStats = updateSessionStat(sessionKey, postMortem.verdict, postMortem.rMultiple, learning.sessionStats);

      // 3. Update Coin DNA
      const mfeR = postMortem.mfeR ?? 0;
      const maeR = postMortem.maeR ?? 0;
      const durationMin = postMortem.durationMinutes ?? 1;
      const coinDNA = updateCoinDNA(position.symbol, postMortem.verdict, postMortem.rMultiple, durationMin, mfeR, maeR, learning.coinDNA);

      // 4. Update MFE/MAE aggregate statistics
      const mfeMaeStats = updateMfeMaeStats(mfeR, maeR, learning.mfeMaeStats);

      await this.store.updateLearning({ penalties, factorStats, sessionStats, coinDNA, mfeMaeStats });
    } catch {
      // Non-fatal if learning update fails
    }

    const mfeStr = postMortem.mfeR !== undefined ? ` | MFE: +${postMortem.mfeR}R` : '';
    const maeStr = postMortem.maeR !== undefined ? ` | MAE: ${postMortem.maeR}R` : '';
    await this.log(
      'info',
      `🧠 Post-Mortem ${position.symbol}: ${postMortem.verdict} (${postMortem.rMultiple > 0 ? '+' : ''}${postMortem.rMultiple}R${mfeStr}${maeStr}) — ${postMortem.lesson}`
    );

    return postMortem;
  }

  /**
   * Close out a position whose final take-profit level has been reached.
   */
  private async settleRemainder(
    position: Position,
    levels: Position['takeProfits'],
    bookedPnl: number,
    remaining: number,
    price: number
  ): Promise<boolean> {
    if (position.live) {
      if (!this.exchange.status().enabled) {
        await this.reportLiveExecutionBlocked();
        return false;
      }
      if (remaining > 0) {
        const reduced = await this.reduceLivePosition(position, remaining);
        if (!reduced) return false;
      }
      if (position.liveStopOrderId) {
        await this.exchange.cancelStopOrder(position.liveStopOrderId, position.symbol).catch(() => {});
      }
      await this.exchange.cancelAllPlanOrders(position.symbol).catch(() => {});
    }

    const dir = position.side === 'LONG' ? 1 : -1;
    // Anything left over beyond the ladder is closed at the current mark.
    const leftoverPnl =
      remaining > 0 ? dir * (price - position.entry) * remaining - remaining * price * FEE : 0;
    const total = position.realisedPnl + bookedPnl + leftoverPnl;
    const net = total - (position.entryFee || 0);

    const postMortem = await this.recordPostMortem(position, price, 'TAKE_PROFIT', net);

    const claimed = await this.store.settlePosition(position.id, {
      closedAt: Date.now(),
      exit: price,
      pnl: net,
      pnlPct: (position.initialMargin ?? (position.quantity && position.entry && position.leverage ? (position.quantity * position.entry) / position.leverage : position.margin)) > 0
        ? net / (position.initialMargin ?? (position.quantity && position.entry && position.leverage ? (position.quantity * position.entry) / position.leverage : position.margin))
        : 0,
      exitReason: 'TAKE_PROFIT',
      takeProfits: levels,
      remainingQuantity: 0,
      realisedPnl: total,
      postMortem,
    });
    if (!claimed) return false;

    // Atomic delta — keeps this credit correct even if another position settles
    // in the same instant.
    await this.store.applyBalanceDelta({
      balance: position.margin + bookedPnl + leftoverPnl,
      realisedPnl: bookedPnl + leftoverPnl,
    });
    this.marks.delete(position.symbol);
    await this.log(
      'trade',
      `CLOSE ${position.side} ${position.symbol} · alle targets geraakt · +${net.toFixed(2)}${position.live ? ' · 🔴 LIVE' : ''}`
    );
    return true;
  }

  private async scanAndEnter(): Promise<void> {
    const signals = await this.rankSignals();
    this.lastSignals = signals;
    this.lastScanAt = Date.now();
    for (const s of signals) this.marks.set(s.symbol, s.price);

    let account = await this.account();
    const open = await this.store.positions('OPEN');
    const state = await this.store.account();

    const today = new Date().toISOString().slice(0, 10);
    let dayStart: number;
    if (this.exchange.status().enabled) {
      if (this.liveDayKey !== today || !this.liveDayStartEquity) {
        this.liveDayKey = today;
        this.liveDayStartEquity = account.equity;
      }
      dayStart = this.liveDayStartEquity;
    } else {
      await this.rollDay(account, state.dayKey);
      dayStart = state.dayStartEquity || state.startingBalance;
    }
    const dayPnlPct = dayStart ? (account.equity - dayStart) / dayStart : 0;

    // Calculate realised loss today from closed positions to prevent false halts from open floating positions
    const closed = await this.store.positions('CLOSED', 50);
    const startOfDayTs = new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime();
    const closedToday = closed.filter((p) => (p.closedAt ?? 0) >= startOfDayTs);
    const realisedLossToday = closedToday.reduce((sum, p) => sum + Math.min(0, p.pnl || 0), 0);
    const realisedLossTodayPct = dayStart > 0 ? realisedLossToday / dayStart : 0;

    // Daily loss limit should protect against realised losses from closed losing trades.
    // Floating intraday oscillations in open positions are managed by each position's stop-loss order.
    // However, if total account equity experiences a catastrophic daily collapse (>2.5x limit), halt for safety.
    const effectiveDayLossPct = Math.min(
      realisedLossTodayPct,
      dayPnlPct <= -(this.risk.dailyLossLimitPct * 2.5) ? dayPnlPct : 0
    );

    const atRisk = open.filter((p) => !isPositionDerisked(p));
    const blocked = tradingBlockedReason(account, open.length, effectiveDayLossPct, this.risk, atRisk.length);
    if (blocked?.kind === 'halt' && !this.risk.pauseNewEntries && this.blockedReason?.kind !== 'halt') {
      void notify({ kind: 'risk-halt', message: blocked.message });
    }
    if (blocked?.kind === 'halt') {
      this.blockedReason = blocked;
      return;
    }

    // A full book of at-risk positions at `maxOpenPositions` is still allowed a few extra
    // high-conviction entries (see `maxOverflowPositions`) — only a capacity
    // block caused by the margin budget itself is a hard stop, since no slot
    // count can fix a lack of free collateral.
    const positionsFull = atRisk.length >= this.risk.maxOpenPositions;
    if (blocked?.kind === 'capacity' && !positionsFull) {
      this.blockedReason = blocked;
      return;
    }

    // Track how many consecutive cycles produced zero tradeable signal anywhere
    // in the universe — a proxy for the whole book sitting in a dead, choppy
    // regime with no trending edge to size a position against.
    const anyTradeable = signals.some((s) => s.confidence >= this.risk.minConfidence);
    this.chopStreak = anyTradeable ? 0 : this.chopStreak + 1;
    const maxChopStreak = this.risk.chopPauseStreak ?? 40;
    if (this.chopStreak >= maxChopStreak) {
      const regimeBlock: BlockedState = {
        kind: 'regime',
        message: `Geen kansrijke trend in ${this.chopStreak} scans op rij — nieuwe entries gepauzeerd tot een markt weer trending regime toont.`,
      };
      if (this.blockedReason?.kind !== 'regime') {
        await this.log('info', regimeBlock.message);
      }
      this.blockedReason = regimeBlock;
      return;
    }

    // Session Gatekeeper: restrict trade entries to permitted market sessions when filter is enabled
    if (this.risk.sessionFilterEnabled && this.risk.allowedSessions?.length) {
      const currentSession = getMarketSession().session;
      if (!this.risk.allowedSessions.includes(currentSession)) {
        const sessionBlock: BlockedState = {
          kind: 'regime',
          message: `Sessie-filter actief: ${currentSession} staat niet in allowedSessions (${this.risk.allowedSessions.join(
            ', '
          )}) — wachten op toegestane sessie.`,
        };
        if (this.blockedReason?.kind !== 'regime' || this.blockedReason?.message !== sessionBlock.message) {
          await this.log('info', sessionBlock.message);
        }
        this.blockedReason = sessionBlock;
        return;
      }
    }

    // Macro Shield Gatekeeper: block new entries around High-Impact economic news (FOMC, CPI, NFP, etc.)
    if (this.risk.macroShieldEnabled !== false) {
      const macroShield = await NewsEngine.getInstance().getMacroShield().catch(() => ({ active: false, reason: undefined }));
      if (macroShield.active) {
        const shieldBlock: BlockedState = {
          kind: 'regime',
          message: macroShield.reason || 'Macro Shield actief — wachten op afronding van hoog-impact economisch nieuws.',
        };
        if (this.blockedReason?.kind !== 'regime' || this.blockedReason?.message !== shieldBlock.message) {
          await this.log('warn', `🛡️ ${shieldBlock.message}`);
        }
        this.blockedReason = shieldBlock;
        return;
      }
    }

    const held = new Set(open.map((p) => p.symbol));
    const book = atRisk.map((p) => ({ symbol: p.symbol, side: p.side }));

    // Capacity uses `isPositionDerisked`: TP1 alone does not free a slot unless
    // the remaining position's stop covers entry fees at break-even.
    let slots = Math.max(0, this.risk.maxOpenPositions - atRisk.length);
    const overflowUsed = Math.max(0, atRisk.length - this.risk.maxOpenPositions);
    let overflow = Math.max(0, this.risk.maxOverflowPositions - overflowUsed);

    if (slots <= 0 && overflow > 0) {
      this.blockedReason = {
        kind: 'capacity',
        message: `Portefeuille vol (${atRisk.length}/${this.risk.maxOpenPositions} nog niet beschermd op fee-covered break-even) — alleen nog ruimte voor een setup van ${Math.round(this.risk.highConvictionConfidence * 100)}%+ zekerheid`,
      };
    } else if (slots <= 0 && overflow <= 0) {
      this.blockedReason = {
        kind: 'capacity',
        message: `Portefeuille volledig vol (${atRisk.length}/${this.risk.maxOpenPositions + this.risk.maxOverflowPositions} nog niet beschermd op fee-covered break-even incl. overflow) — wachten op risicoreductie of exit`,
      };
    } else {
      this.blockedReason = null;
    }

    const btcSignal = signals.find((s) => s.symbol === 'BTC_USDT');
    const btcRegime = btcSignal?.higherRegime || btcSignal?.regime;
    const btcTicker = this.lastTickers.get('BTC_USDT');
    const btcChange = btcTicker?.changeRate24h ?? 0;
    if (btcTicker && btcTicker.lastPrice > 0) {
      const now = Date.now();
      this.btcPriceHistory.push({ time: now, price: btcTicker.lastPrice });
      this.btcPriceHistory = this.btcPriceHistory.filter((p) => now - p.time <= 20 * 60_000);
    }
    const btcDumpActive = (() => {
      if (this.btcPriceHistory.length < 2) return false;
      const oldest = this.btcPriceHistory[0];
      const latest = this.btcPriceHistory[this.btcPriceHistory.length - 1];
      const diff = (latest.price - oldest.price) / oldest.price;
      const threshold = this.risk.btcFlashDumpThreshold ?? -0.012;
      return diff <= threshold;
    })();

    const learning = await this.store.learning();
    const currentSession = getMarketSession(new Date()).session;
    const prioritizedSignals = rankCandidates(signals, learning, currentSession);

    const activeLongs = open.filter((p) => p.side === 'LONG').length;
    const activeShorts = open.filter((p) => p.side === 'SHORT').length;
    await this.store.updateLearning({
      clusterStatus: {
        activeLongs,
        activeShorts,
        lastDampener: learning.clusterStatus?.lastDampener ?? 1.0,
      },
    }).catch(() => {});

    for (const signal of prioritizedSignals) {
      if (slots <= 0 && overflow <= 0) break;

      // Strafbankje Gatekeeper: block coins on cooldown after 2 consecutive losses
      const penalty = learning.penalties[signal.symbol];
      if (penalty?.penalizedUntil && penalty.penalizedUntil > Date.now()) {
        const remainingHours = Math.ceil((penalty.penalizedUntil - Date.now()) / 3600_000);
        await this.logSkip(
          signal.symbol,
          `Munt zit op het strafbankje na 2 opeenvolgende verliezen (nog ${remainingHours}u cooldown)`,
          'BLOCKED_COOLDOWN'
        );
        continue;
      }

      const ticker = this.lastTickers.get(signal.symbol);

      // Granular Cooldown Check (TP: 15m, BE: 30m, SL: 60m, Fakeout: 120m)
      const zoneKey = signal.zone4H ? `${Math.round(signal.zone4H.low)}-${Math.round(signal.zone4H.high)}` : undefined;
      const cd = this.isCooldownActive(signal.symbol, signal.side, zoneKey);
      if (cd.active) {
        signal.blockReasonCode = 'BLOCKED_COOLDOWN';
        await this.logSkip(
          signal.symbol,
          `Cooldown actief: ${cd.reason} (nog ${cd.remainingSec}s)`,
          'BLOCKED_COOLDOWN'
        );
        continue;
      }

      // Breaking News Catalyst Check: boosts score on positive news, blocks on adverse news
      let catalyst: {
        hasCatalyst: boolean;
        sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
        news?: NewsItem;
        scoreBoost: number;
        warning?: string;
        isHighImpact?: boolean;
        isCritical?: boolean;
      } = { hasCatalyst: false, sentiment: 'NEUTRAL', scoreBoost: 0 };

      if (this.risk.newsTradingEnabled !== false) {
        catalyst = await NewsEngine.getInstance().getCatalystForSymbol(signal.symbol).catch(() => ({
          hasCatalyst: false,
          sentiment: 'NEUTRAL' as const,
          scoreBoost: 0,
        }));
      }

      if (catalyst.hasCatalyst) {
        if (catalyst.sentiment === 'BEARISH' && signal.side === 'LONG') {
          signal.blockReasonCode = 'BLOCKED_LOW_SCORE';
          await this.logSkip(
            signal.symbol,
            `Advers nieuws katalysator: "${catalyst.news?.title}" — longs geblokkeerd`,
            'BLOCKED_LOW_SCORE'
          );
          continue;
        } else if (catalyst.sentiment === 'BULLISH' && signal.side === 'SHORT') {
          signal.blockReasonCode = 'BLOCKED_LOW_SCORE';
          await this.logSkip(
            signal.symbol,
            `Bullish nieuws katalysator: "${catalyst.news?.title}" — shorts geblokkeerd`,
            'BLOCKED_LOW_SCORE'
          );
          continue;
        } else if (
          (catalyst.sentiment === 'BULLISH' && signal.side === 'LONG') ||
          (catalyst.sentiment === 'BEARISH' && signal.side === 'SHORT')
        ) {
          if (signal.setupScore) {
            signal.setupScore.total = Math.min(100, signal.setupScore.total + catalyst.scoreBoost);
            signal.setupScore.details.push(`🔥 Nieuws Katalysator (+${catalyst.scoreBoost}): ${catalyst.news?.title}`);
          }
          signal.reasons.push(`🔥 Nieuws Katalysator: ${catalyst.news?.title}`);
        }
      }

      // Smart Pyramiding / Scale-In: allow adding a 2nd tranche to an existing winning position
      const existingPos = open.find((p) => p.symbol === signal.symbol);
      const isScaleIn = Boolean(existingPos);

      // MTF Setup Score Check: Blends structural MTF score with deep model conviction (0..1)
      const minScore = isScaleIn && existingPos?.side === signal.side
        ? Math.min(this.risk.minScore ?? 65, Math.round((this.risk.pyramidMinConfidence ?? 0.85) * 100))
        : (this.risk.minScore ?? 65);
      const minReversalScore = this.risk.minReversalScore ?? 72;
      const confidenceScore = Math.round(signal.confidence * 100);
      const mtfScore = signal.setupScore?.total ?? confidenceScore;
      // High-conviction setups (90%+ confidence with SMT, volume, golden zone) are properly credited
      const score = Math.round(0.50 * mtfScore + 0.50 * confidenceScore);

      if (score < minScore) {
        signal.blockReasonCode = 'BLOCKED_LOW_SCORE';
        await this.logSkip(
          signal.symbol,
          `MTF Setup Score (${score}/100) onder minimum vereiste (${minScore})`,
          'BLOCKED_LOW_SCORE'
        );
        continue;
      }

      if (signal.strategyType === 'REVERSAL' && score < minReversalScore) {
        signal.blockReasonCode = 'BLOCKED_REVERSAL_LOW_SCORE';
        await this.logSkip(
          signal.symbol,
          `Reversal setup score (${score}/100) onder minimum vereiste (${minReversalScore})`,
          'BLOCKED_REVERSAL_LOW_SCORE'
        );
        continue;
      }

      if (isScaleIn && existingPos) {
        if (this.risk.pyramidingEnabled === false) continue;
        if ((existingPos.scaleInCount ?? 0) >= 1) continue; // Max 1 scale-in (2 tranches total)
        if (existingPos.side !== signal.side) {
          if (existingPos.live) continue;
          if (score >= minReversalScore) {
            await this.log(
              'trade',
              `🔄 One-Way Mode Reversal: ${signal.symbol} score is ${score}/100 (>= ${minReversalScore}). Oude ${existingPos.side} positie sluiten alvorens nieuwe ${signal.side} te openen...`
            );
            const markPrice = ticker?.lastPrice ?? signal.price;
            await this.close(existingPos, markPrice, 'SIGNAL_FLIP');
            account = await this.account();
            const freshOpen = await this.store.positions('OPEN');
            open.length = 0;
            open.push(...freshOpen);
            held.delete(signal.symbol);
          } else {
            signal.blockReasonCode = 'BLOCKED_EXISTING_SYMBOL_POSITION';
            await this.logSkip(
              signal.symbol,
              `Bestaande ${existingPos.side} positie op ${signal.symbol}, score (${score}) onvoldoende voor reversal flip (min. ${minReversalScore})`,
              'BLOCKED_EXISTING_SYMBOL_POSITION'
            );
            continue;
          }
        } else {

        // A TP1 flag is insufficient; the stop must cover fees at break-even.
        if (!isPositionDerisked(existingPos)) {
          await this.logSkip(
            signal.symbol,
            `Bestaande ${signal.symbol} positie heeft nog geen fee-covered break-even stop — bijschalen niet toegestaan`
          );
          continue;
        }

        // Scale-in requires high conviction
        const minConf = this.risk.pyramidMinConfidence ?? 0.85;
        if (signal.confidence < minConf) {
          await this.logSkip(
            signal.symbol,
            `Overtuiging (${Math.round(signal.confidence * 100)}%) onder drempel (${Math.round(minConf * 100)}%) voor bijschalen op ${signal.symbol}`
          );
          continue;
        }

        // Timing, reversal & pullback must be confirmed (buy the pullback, not the peak)
        const pullbackCheck = signal.checks?.find((c) => c.name === 'Sniper Pullback');
        if (pullbackCheck && !pullbackCheck.passed) {
          await this.logSkip(signal.symbol, `Bijschalen vereist pullback: ${pullbackCheck.detail}`);
          continue;
        }

        if (signal.timingReady === false || signal.reversalConfirmed === false) {
          await this.logSkip(signal.symbol, `Wachten op 15m pullback-ommekeer voor 2e tranche van ${signal.symbol}`);
          continue;
        }
        }
      } else if (held.has(signal.symbol)) {
        signal.blockReasonCode = 'BLOCKED_EXISTING_SYMBOL_POSITION';
        continue;
      }



      // Bitcoin Gatekeeper: block altcoins that fight Bitcoin's dominant trend or when BTC is in CHOP
      if (this.risk.btcFilterEnabled !== false && signal.symbol !== 'BTC_USDT') {
        const hasVolumeSpurt = signal.checks?.some((c) => c.name === 'Volume Spurt' && c.passed) ?? false;
        const rs = ticker && btcTicker ? ticker.changeRate24h - btcChange : undefined;
        const btcCheck = btcTrendConflict(
          signal.symbol,
          signal.side,
          btcRegime,
          this.risk.btcChopFilterEnabled === true,
          hasVolumeSpurt,
          rs
        );
        if (btcCheck.blocked) {
          await this.logSkip(signal.symbol, btcCheck.reason);
          continue;
        } else if (btcRegime === 'CHOP' && (hasVolumeSpurt || (rs !== undefined && rs > 0.015))) {
          await this.log(
            'info',
            `🚀 Coin in Play: ${signal.symbol} toont sterke eigen dynamiek (${hasVolumeSpurt ? 'Volume Spurt' : `RS +${((rs ?? 0) * 100).toFixed(1)}%`}) — BTC Chop Filter omzeild!`
          );
        }
      }

      // BTC Flash-Dump Circuit Breaker: block new altcoin longs during sharp BTC drops
      if (btcDumpActive && signal.side === 'LONG' && signal.symbol !== 'BTC_USDT') {
        await this.logSkip(
          signal.symbol,
          `BTC Flash-dump actief (BTC daling >1.2% in korte tijd) — nieuwe longs tijdelijk geblokkeerd`
        );
        continue;
      }

      // Spread & Slippage Shield: reject tokens with excessive bid-ask spread
      if (this.risk.spreadShieldEnabled !== false && ticker?.spreadPct !== undefined) {
        const maxSpread = this.risk.maxSpreadPct ?? 0.0015;
        if (ticker.spreadPct > maxSpread) {
          await this.logSkip(
            signal.symbol,
            `Spread te wijd (${(ticker.spreadPct * 100).toFixed(2)}% > max ${(maxSpread * 100).toFixed(2)}%) — liquiditeit onvoldoende, risico op slippage`
          );
          continue;
        }
      }

      // Premium vs. Discount Gatekeeper: never buy in Premium (>50%), never sell in Discount (<50%)
      if (this.risk.premiumDiscountFilterEnabled === true && signal.marketStructure?.dealingRange) {
        const zone = signal.marketStructure.dealingRange.zone;
        const inGoldenZone = signal.checks?.some((c) => c.name === 'Fibonacci confluentie' && c.passed);
        const inSniperPullback = signal.checks?.some((c) => c.name === 'Sniper Pullback' && c.passed);
        const isExempt = inGoldenZone || inSniperPullback;
        if (signal.side === 'LONG' && zone === 'PREMIUM' && !isExempt) {
          await this.logSkip(
            signal.symbol,
            `Prijs bevindt zich in de PREMIUM zone (${((signal.marketStructure.dealingRange.relativePosition) * 100).toFixed(0)}% van range) — te duur om te kopen (wacht op discount pullback)`
          );
          continue;
        } else if (signal.side === 'SHORT' && zone === 'DISCOUNT' && !isExempt) {
          await this.logSkip(
            signal.symbol,
            `Prijs bevindt zich in de DISCOUNT zone (${((signal.marketStructure.dealingRange.relativePosition) * 100).toFixed(0)}% van range) — te goedkoop om te shorten`
          );
          continue;
        }
      }

      // Relative Strength Gatekeeper: trade market leaders, avoid laggards (off by default)
      if (Boolean(this.risk.rsFilterEnabled) && signal.symbol !== 'BTC_USDT' && ticker && btcTicker) {
        const rs = ticker.changeRate24h - btcChange;
        signal.relativeStrength = rs;
        if (signal.side === 'LONG' && rs < -0.015) {
          await this.logSkip(
            signal.symbol,
            `Achterblijver t.o.v. BTC (RS: ${(rs * 100).toFixed(1)}% vs BTC ${(btcChange * 100).toFixed(1)}%) — alleen marktleiders toegestaan`
          );
          continue;
        } else if (signal.side === 'SHORT' && rs > 0.015) {
          await this.logSkip(
            signal.symbol,
            `Munt is sterker dan BTC (RS: +${(rs * 100).toFixed(1)}%) — altcoin shorts alleen op zwakke munten`
          );
          continue;
        }
      }

      // Funding Rate Gatekeeper: avoid crowded long/short squeezes
      if (ticker) {
        const maxLongFunding = this.risk.maxFundingRateLong ?? 0.0005;
        const minShortFunding = this.risk.minFundingRateShort ?? -0.0005;
        if (signal.side === 'LONG' && ticker.fundingRate > maxLongFunding) {
          await this.logSkip(
            signal.symbol,
            `Funding rate te hoog (+${(ticker.fundingRate * 100).toFixed(3)}%): long-zijde overvol, risico op squeeze`
          );
          continue;
        } else if (signal.side === 'SHORT' && ticker.fundingRate < minShortFunding) {
          await this.logSkip(
            signal.symbol,
            `Funding rate te laag (${(ticker.fundingRate * 100).toFixed(3)}%): short-zijde overvol, risico op short squeeze`
          );
          continue;
        }
      }

      // Breakout check helper for high-momentum outliers and breaking news catalysts
      const hasVolumeSpurt = signal.checks?.some((c) => c.name === 'Volume Spurt' && c.passed);
      const hasNewsMomentum = Boolean(
        catalyst.hasCatalyst &&
          this.risk.newsCatalystBypassPullback !== false &&
          ((catalyst.sentiment === 'BULLISH' && signal.side === 'LONG') ||
            (catalyst.sentiment === 'BEARISH' && signal.side === 'SHORT'))
      );
      const isBreakoutBypassActive =
        this.risk.breakoutBypassEnabled !== false &&
        (hasVolumeSpurt || hasNewsMomentum) &&
        signal.confidence >= Math.max(0.65, (this.risk.minConfidence ?? 0.54));

      const bypassReason = hasNewsMomentum ? 'Nieuws Katalysator' : 'Volume Spurt';

      // 15-Minute Micro-Timing & Reversal Gatekeeper: avoid buying into an intra-hour top or falling knife
      if (this.risk.microTiming15mEnabled !== false && signal.timingReady === false) {
        if (isBreakoutBypassActive) {
          await this.log(
            'info',
            `⚡ Micro-timing bypass voor ${signal.symbol}: ${bypassReason} breakout momentum overstemt 15m afkoeling.`
          );
        } else {
          await this.logSkip(signal.symbol, '15m micro-timing overbought/oversold of dip nog niet gekeerd (wachten op ommekeer)');
          continue;
        }
      }
      if (this.risk.reversal15mRequired !== false && signal.reversalConfirmed === false) {
        let confirmedBy5m = false;
        if (this.risk.ltfSniper5mEnabled !== false) {
          try {
            const candles5m = await this.market.candles(signal.symbol, 'Min5');
            const ltfCheck = checkLtfReversal(candles5m, signal.side);
            if (ltfCheck.ready) {
              confirmedBy5m = true;
            }
          } catch {
            // Non-fatal
          }
        }
        if (!confirmedBy5m) {
          if (isBreakoutBypassActive) {
            await this.log(
              'info',
              `⚡ LTF ommekeer bypass voor ${signal.symbol}: ${bypassReason} breakout momentum geactiveerd.`
            );
          } else {
            await this.logSkip(signal.symbol, '15m/5m ommekeer nog niet bevestigd (wachten op groene candle / hammer wick)');
            continue;
          }
        }
      }

      // Sniper Pullback Gatekeeper: never buy on the top or chase overextended moves (require pullback to EMA/Fib)
      if (this.risk.pullbackFilterEnabled) {
        const pullbackCheck = signal.checks?.find((c) => c.name === 'Sniper Pullback');
        if (pullbackCheck && !pullbackCheck.passed) {
          if (isBreakoutBypassActive) {
            await this.log(
              'info',
              `🚀 Breakout Momentum Bypass geactiveerd voor ${signal.symbol} (${bypassReason}, Conviction: ${Math.round(
                signal.confidence * 100
              )}%) — directe instap op momentum!`
            );
          } else {
            await this.logSkip(signal.symbol, pullbackCheck.detail);
            continue;
          }
        }
      }

      // Trade Pacing: enforce a cooldown between new entries if explicitly configured
      const cooldownMin = this.risk.entryCooldownMinutes ?? 0;
      const cooldownMs = cooldownMin * 60_000;
      if (cooldownMin > 0 && this.lastEntryAt && Date.now() - this.lastEntryAt < cooldownMs) {
        if (Date.now() - this.lastPacingLogAt > 60_000) {
          this.lastPacingLogAt = Date.now();
          const remainingSec = Math.ceil((cooldownMs - (Date.now() - this.lastEntryAt)) / 1000);
          await this.log('info', `Pacing actief: nog ${remainingSec}s wachten voor volgende positie geopend kan worden.`);
        }
        break;
      }

      const usingOverflow = slots <= 0;
      if (usingOverflow && signal.confidence < this.risk.highConvictionConfidence) continue;
      // Correlated markets all lose together, so cap one-way and same-group
      // exposure before sizing anything.
      const crowded = concentrationBlock(signal, book, this.risk);
      if (crowded) {
        signal.blockReasonCode = 'BLOCKED_CORRELATED_RISK';
        await this.logSkip(signal.symbol, crowded, 'BLOCKED_CORRELATED_RISK');
        continue;
      }
      const detail = await this.market.contractDetail(signal.symbol).catch(() => null);
      const plan = planTrade(signal, account, this.risk, FEE, detail?.maxLeverage);
      if (!plan) {
        const rawPlan = planTrade(signal, account, { ...this.risk, minReturnOnMargin: 0 }, FEE, detail?.maxLeverage);
        if (rawPlan && rawPlan.margin > 0) {
          const dir = signal.side === 'LONG' ? 1 : -1;
          const potProfit = rawPlan.takeProfits.reduce((acc, tp) => {
            const pnl = dir * (tp.price - rawPlan.entry) * (rawPlan.quantity * tp.portion);
            return acc + pnl;
          }, 0);
          const ratio = potProfit / rawPlan.margin;
          const minRatio = this.risk.minReturnOnMargin ?? 0.35;
          if (ratio < minRatio) {
            signal.blockReasonCode = 'BLOCKED_LOW_REWARD_MARGIN';
            await this.logSkip(
              signal.symbol,
              `Winstpotentieel ($${potProfit.toFixed(2)}) is maar ${Math.round(ratio * 100)}% van inzet ($${rawPlan.margin.toFixed(2)}) — minimaal ${Math.round(minRatio * 100)}% rendement vereist`,
              'BLOCKED_LOW_REWARD_MARGIN'
            );
            continue;
          }
        }
        const minReq = Math.max(5, this.risk.minTradeMarginUsdt ?? 5);
        if (account.balance < minReq) {
          await this.logSkip(
            signal.symbol,
            `onvoldoende vrij saldo ($${account.balance.toFixed(2)} vrij, min. $${minReq} vereist voor trade)`
          );
        }
        continue;
      }

      // 5. Apply AI Cluster-Risk & Portfolio Market Beta Dampener
      const clusterRisk = evaluateClusterRisk(signal, open, btcRegime);
      if (clusterRisk.multiplier < 1.0) {
        plan.margin = Math.round(plan.margin * clusterRisk.multiplier * 100) / 100;
        plan.quantity = Math.round((plan.quantity * clusterRisk.multiplier) * 10000) / 10000;
        plan.notional = Math.round(plan.notional * clusterRisk.multiplier * 100) / 100;
        plan.riskPct = Math.round(plan.riskPct * clusterRisk.multiplier * 10000) / 10000;
        plan.clusterRiskMultiplier = clusterRisk.multiplier;
        await this.log(
          'info',
          `🛡️ Cluster-Risico AI: ${signal.symbol} risicoschaling naar ${Math.round(clusterRisk.multiplier * 100)}% (${clusterRisk.reason})`
        );
      }

      // Portfolio Heat & Correlated Group Risk Limits
      const maxPortfolioHeat = this.risk.maxPortfolioHeat ?? 0.050;
      const maxCorrelatedRisk = this.risk.maxCorrelatedRisk ?? 0.030;

      const currentHeat = open
        .filter((p) => !isPositionDerisked(p))
        .reduce((sum, p) => sum + (p.initialRisk * p.quantity) / (account.equity || 1), 0);

      if (currentHeat + plan.riskPct > maxPortfolioHeat) {
        signal.blockReasonCode = 'BLOCKED_PORTFOLIO_HEAT';
        await this.logSkip(
          signal.symbol,
          `Portfolio heat zou ${((currentHeat + plan.riskPct) * 100).toFixed(2)}% worden (max ${(maxPortfolioHeat * 100).toFixed(1)}%)`,
          'BLOCKED_PORTFOLIO_HEAT'
        );
        continue;
      }

      const grp = correlationGroup(signal.symbol);
      if (grp !== 'alts') {
        const currentGroupRisk = open
          .filter((p) => correlationGroup(p.symbol) === grp && !isPositionDerisked(p))
          .reduce((sum, p) => sum + (p.initialRisk * p.quantity) / (account.equity || 1), 0);

        if (currentGroupRisk + plan.riskPct > maxCorrelatedRisk) {
          signal.blockReasonCode = 'BLOCKED_CORRELATED_RISK';
          await this.logSkip(
            signal.symbol,
            `Gecorreleerd risico voor groep '${grp}' zou ${((currentGroupRisk + plan.riskPct) * 100).toFixed(2)}% worden (max ${(maxCorrelatedRisk * 100).toFixed(1)}%)`,
            'BLOCKED_CORRELATED_RISK'
          );
          continue;
        }
      }
      // 5-Minute (5m) Sniper Trigger: verify micro-reversal on 5m candles right before opening trade
      if (this.risk.ltfSniper5mEnabled !== false) {
        try {
          const candles5m = await this.market.candles(signal.symbol, 'Min5');
          const ltfCheck = checkLtfReversal(candles5m, signal.side);
          if (!ltfCheck.ready) {
            await this.logSkip(
              signal.symbol,
              `5m sniper timing: ${ltfCheck.reason} (wachten op 5m ommekeer)`
            );
            continue;
          }
        } catch (err) {
          await this.logSkip(
            signal.symbol,
            `5m sniper timing unavailable: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
      }
      if (this.exchange.status().enabled) {
        const currentVenue = await this.exchange.getOpenPositions().catch(() => []);
        if (!isScaleIn && currentVenue.some((p) => p.symbol === signal.symbol && p.vol > 0)) {
          held.add(signal.symbol);
          await this.logSkip(signal.symbol, 'positie staat al open op MEXC');
          continue;
        }
      }

      // Re-read the mark after timing/venue checks and fully re-size the plan
      // from that accepted execution price immediately before opening.
      const confirmed = await this.confirmEntry(signal, plan);
      if (!confirmed.ok) {
        await this.logSkip(signal.symbol, `bij dubbele check: ${confirmed.reason}`);
        continue;
      }
      const executionPlan = confirmed.plan;

      if (isScaleIn && existingPos) {
        const scaled = await this.scaleIn(existingPos, executionPlan);
        if (scaled) {
          this.lastSkipReasons.delete(signal.symbol);
          this.lastEntryAt = Date.now();
          account = await this.account();
        }
        continue;
      }

      const opened = await this.open(executionPlan, signal, confirmed.price);
      if (!opened) continue;
      this.lastSkipReasons.delete(signal.symbol);
      this.lastEntryAt = Date.now();
      if (usingOverflow) {
        await this.log(
          'info',
          `${signal.symbol}: extra positie boven ${this.risk.maxOpenPositions} geopend op ${Math.round(signal.confidence * 100)}% zekerheid`
        );
      } else if (open.length >= this.risk.maxOpenPositions) {
        await this.log(
          'info',
          `${signal.symbol}: nieuwe positie geopend (${open.length + 1}e open positie, eerdere posities zijn beschermd op fee-covered break-even).`
        );
      }
      held.add(signal.symbol);
      book.push({ symbol: signal.symbol, side: signal.side });
      if (usingOverflow) overflow -= 1;
      else slots -= 1;
      // Re-read the account so the next entry sizes against the reduced budget.
      account = await this.account();
    }
  }

  /**
   * How stale a cached price may be for the current cadence.
   *
   * On the fast cycle the whole point is a sharper entry price, so the ticker
   * cache is bypassed; on the slow cycle the default TTL keeps request volume
   * down and well inside the venue's rate limit.
   */
  private priceMaxAgeMs(): number | undefined {
    return this.fast ? this.fastIntervalSec * 1000 : undefined;
  }

  private async rankSignals(): Promise<Signal[]> {
    const allowed = new Set(this.effectiveUniverse);
    const allTickers = await this.market.tickers(this.priceMaxAgeMs());
    const tickerMap = new Map(allTickers.map((t) => [t.symbol, t]));
    this.lastTickers = tickerMap;
    const minVol = this.risk.minQuoteVolume24h ?? 1_000_000;
    // 1. Filter all liquid perpetual contracts meeting minimum volume ($1M default)
    const liquidTickers = allTickers.filter(
      (t) =>
        isCryptoPerp(t.symbol) &&
        (t.symbol === 'BTC_USDT' || t.quoteVolume24h >= minVol) &&
        Number.isFinite(t.lastPrice) &&
        t.lastPrice > 0
    );

    // 2. Discover Coins in Play: Top 24h Gainers (+%), Top 24h Losers (-%), and Volume Leaders
    const withChange = liquidTickers.filter((t) => Number.isFinite(t.changeRate24h));
    const topGainers = [...withChange]
      .filter((t) => t.changeRate24h > 0)
      .sort((a, b) => b.changeRate24h - a.changeRate24h)
      .slice(0, 12);
    const topLosers = [...withChange]
      .filter((t) => t.changeRate24h < 0)
      .sort((a, b) => a.changeRate24h - b.changeRate24h)
      .slice(0, 12);
    const topVolumeLeaders = [...liquidTickers]
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, 15);
    const extremeFunding = liquidTickers
      .filter((t) => Number.isFinite(t.fundingRate) && t.fundingRate < -0.0003)
      .sort((a, b) => a.fundingRate - b.fundingRate)
      .slice(0, 6);

    const moverRoleMap = new Map<string, 'TOP_GAINER' | 'TOP_LOSER' | 'VOLUME_LEADER' | 'SHORT_SQUEEZE'>();
    for (const g of topGainers) moverRoleMap.set(g.symbol, 'TOP_GAINER');
    for (const l of topLosers) moverRoleMap.set(l.symbol, 'TOP_LOSER');
    for (const v of topVolumeLeaders) {
      if (!moverRoleMap.has(v.symbol)) moverRoleMap.set(v.symbol, 'VOLUME_LEADER');
    }
    for (const f of extremeFunding) {
      if (!moverRoleMap.has(f.symbol)) moverRoleMap.set(f.symbol, 'SHORT_SQUEEZE');
    }

    // 3. Assemble priority candidate universe (majors + open positions + top movers + sector reps + core universe)
    const prioritySymbols = new Set<string>();

    // A. Majors: BTC, ETH, SOL
    for (const sym of ['BTC_USDT', 'ETH_USDT', 'SOL_USDT']) {
      if (tickerMap.has(sym)) prioritySymbols.add(sym);
    }

    // B. Any open positions or active holdings
    const openPositions = await this.store.positions('OPEN').catch(() => []);
    for (const pos of openPositions) {
      if (tickerMap.has(pos.symbol)) prioritySymbols.add(pos.symbol);
    }

    // In restricted test environments (where BTC is omitted from universe), only scan allowed symbols
    const isRestrictedUniverse = !allowed.has('BTC_USDT');

    // C. Top 12 Gainers (+%) & Top 12 Losers (-%)
    for (const g of topGainers) {
      if (!isRestrictedUniverse || allowed.has(g.symbol)) prioritySymbols.add(g.symbol);
    }
    for (const l of topLosers) {
      if (!isRestrictedUniverse || allowed.has(l.symbol)) prioritySymbols.add(l.symbol);
    }

    // D. Top Volume Leaders & Short Squeeze candidates
    for (const v of topVolumeLeaders) {
      if (!isRestrictedUniverse || allowed.has(v.symbol)) prioritySymbols.add(v.symbol);
    }
    for (const f of extremeFunding) {
      if (!isRestrictedUniverse || allowed.has(f.symbol)) prioritySymbols.add(f.symbol);
    }

    // E. Sector Representation: Ensure top liquid coins from each sector are scanned
    const sectorLists = [
      MEME_UNIVERSE,
      AI_UNIVERSE,
      DEFI_UNIVERSE,
      LAYER1_UNIVERSE,
      LAYER2_UNIVERSE,
      GAMING_UNIVERSE,
    ];
    for (const sector of sectorLists) {
      const liquidSector = sector
        .map((s) => tickerMap.get(s))
        .filter((t): t is Ticker => Boolean(t && t.quoteVolume24h >= minVol))
        .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
        .slice(0, 5);
      for (const t of liquidSector) {
        if (!isRestrictedUniverse || allowed.has(t.symbol)) prioritySymbols.add(t.symbol);
      }
    }

    // F. Core allowed universe markets (highest volume first, fill up to 90)
    const coreLiquid = liquidTickers
      .filter((t) => allowed.has(t.symbol))
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
    for (const t of coreLiquid) {
      if (prioritySymbols.size >= 90) break;
      prioritySymbols.add(t.symbol);
    }

    const candidates = Array.from(prioritySymbols)
      .map((sym) => tickerMap.get(sym)!)
      .filter(Boolean);

    // A market that yields no signal is normal — the strategy vetoes setups that
    // fight the higher timeframe. A market that errors or has no data at all is
    // not normal, so only that case is logged. Warning on both would cry wolf
    // every cycle and train the user to ignore the log.
    const broken: string[] = [];
    const [btcCandles, ethCandles, learning] = await Promise.all([
      this.risk.smtFilterEnabled !== false
        ? this.market.candles('BTC_USDT', ENTRY_INTERVAL).catch(() => [] as Candle[])
        : Promise.resolve([] as Candle[]),
      this.risk.smtFilterEnabled !== false
        ? this.market.candles('ETH_USDT', ENTRY_INTERVAL).catch(() => [] as Candle[])
        : Promise.resolve([] as Candle[]),
      this.store.learning(),
    ]);
    const results: Array<ReturnType<typeof buildSignal> | null> = [];
    const BATCH_SIZE = 8;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (ticker) => {
          try {
            // Two timeframes: 1h drives the entry, 4h confirms the context.
            // 15m micro-timing confirms entry when enabled.
            const fetchLower = this.risk.microTiming15mEnabled !== false;
            const [candles, higher, lower, sniper] = await Promise.all([
              this.market.candles(ticker.symbol, ENTRY_INTERVAL),
              this.market.candles(ticker.symbol, CONFIRM_INTERVAL).catch(() => []),
              fetchLower ? this.market.candles(ticker.symbol, MICRO_INTERVAL).catch(() => []) : Promise.resolve([]),
              this.market.candles(ticker.symbol, SNIPER_INTERVAL).catch(() => []),
            ]);
            if (candles.length < 60) {
              broken.push(`${ticker.symbol} (${candles.length} candles)`);
              return null;
            }
            const bmCandles = ticker.symbol === 'BTC_USDT' ? ethCandles : btcCandles;
            const bmSymbol = ticker.symbol === 'BTC_USDT' ? 'ETH_USDT' : 'BTC_USDT';
            return buildSignal(
              ticker,
              candles,
              higher,
              lower,
              learning,
              bmCandles,
              bmSymbol,
              sniper
            );
          } catch (err) {
            broken.push(`${ticker.symbol} (${(err as Error).message})`);
            return null;
          }
        })
      );
      results.push(...batchResults);
      if (i + BATCH_SIZE < candidates.length) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }


    const absent = this.effectiveUniverse.filter((s) => !tickerMap.has(s));
    if (absent.length) {
      broken.push(...absent.map((s) => `${s} (geen ticker)`));
    }
    if (broken.length && Date.now() - this.lastBrokenLogAt > 60 * 60_000) {
      this.lastBrokenLogAt = Date.now();
      await this.log('warn', `Marktdata ontbreekt voor ${broken.join(', ')}`);
    }

    const currentSession = getMarketSession(new Date()).session;
    return rankCandidates(
      results
        .filter((s): s is Signal => s !== null)
        .map((s) => {
          const profile = getCoinProfile(s.symbol);
          const moverRole = moverRoleMap.get(s.symbol) || 'NORMAL';
          return {
            ...s,
            category: profile.category,
            moverRole,
            plannedLeverage: previewLeverage(s, this.risk),
          };
        }),
      learning,
      currentSession
    );
  }

  /**
   * Scale into an existing winning position (pyramiding / add to winners).
   *
   * Only allowed when the remaining position's stop covers entry fees at
   * break-even; TP and break-even flags alone are not sufficient.
   */
  private async scaleIn(existing: Position, plan: TradePlan): Promise<boolean> {
    const fee = plan.notional * FEE;
    const state = await this.account();
    if (plan.margin + fee > state.balance) return false;

    const addedQty = plan.quantity;
    const addedMargin = plan.margin;
    const addedNotional = plan.notional;
    const currentRemaining = existing.remainingQuantity ?? existing.quantity;
    const newRemainingQty = currentRemaining + addedQty;
    const newTotalQty = existing.quantity + addedQty;

    // Weighted average entry price across both tranches
    const newEntry =
      (currentRemaining * existing.entry + addedQty * plan.entry) / newRemainingQty;

    // Stop loss protects the combined position at the pullback level
    const newStopLoss =
      existing.side === 'LONG'
        ? Math.max(existing.stopLoss, plan.stopLoss)
        : Math.min(existing.stopLoss, plan.stopLoss);

    // Mirror onto live exchange if armed
    if (existing.live) {
      if (!this.exchange.status().enabled) {
        await this.reportLiveExecutionBlocked();
        return false;
      }
      const contractSize = existing.liveContractSize || 1;
      const detail = await this.market.contractDetail(existing.symbol).catch(() => null);
      const step = detail && detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
      const minVol = detail?.minVol || 1;
      const vol = Math.max(minVol, roundToStep(addedQty / contractSize, step));
      try {
        const order = await this.exchange.placeMarketOrder({
          symbol: existing.symbol,
          intent: existing.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
          vol,
          leverage: existing.leverage,
          externalOid: `${existing.id}-scale-${Date.now()}`,
        });
        if (!order || !order.orderId) {
          throw new Error('Exchange retourneerde geen orderId bij scale-in');
        }
        await this.moveLiveStop(existing, newStopLoss, newRemainingQty);
      } catch (err) {
        await this.log('error', `Live scale-in order mislukt voor ${existing.symbol}: ${(err as Error).message}`);
        return false;
      }
    }

    // Update position in local store
    await this.store.updatePosition(existing.id, {
      quantity: newTotalQty,
      remainingQuantity: newRemainingQty,
      margin: existing.margin + addedMargin,
      notional: existing.notional + addedNotional,
      entry: Number(newEntry.toFixed(8)),
      stopLoss: Number(newStopLoss.toFixed(8)),
      takeProfits: plan.takeProfits,
      takeProfit: plan.takeProfit,
      scaleInCount: (existing.scaleInCount ?? 0) + 1,
      scaledInAt: Date.now(),
      scaleInMargin: (existing.scaleInMargin ?? 0) + addedMargin,
      liveStopOrderId: existing.liveStopOrderId,
    });

    // Debit margin & fee
    await this.store.applyBalanceDelta({ balance: -(addedMargin + fee), realisedPnl: -fee });

    // Mutate existing position object in-place so current cycle sees updated values
    existing.quantity = newTotalQty;
    existing.remainingQuantity = newRemainingQty;
    existing.margin += addedMargin;
    existing.notional += addedNotional;
    existing.entry = Number(newEntry.toFixed(8));
    existing.stopLoss = Number(newStopLoss.toFixed(8));
    existing.takeProfits = plan.takeProfits;
    existing.takeProfit = plan.takeProfit;
    existing.scaleInCount = (existing.scaleInCount ?? 0) + 1;
    existing.scaledInAt = Date.now();
    existing.scaleInMargin = (existing.scaleInMargin ?? 0) + addedMargin;

    await this.log(
      'trade',
      `🚀 SCALE-IN (Tranche 2): ${existing.symbol} positie vergroot met ${addedMargin} margin @ ${plan.entry} · nieuwe gewogen entry ${newEntry.toFixed(4)} · stop op ${newStopLoss.toFixed(4)} · conf ${Math.round(plan.confidence * 100)}%${existing.live ? ' · 🔴 LIVE' : ''}`
    );
    void notify({
      kind: 'trade-open',
      message: `🚀 SCALE-IN: ${existing.symbol} vergroot met ${addedMargin.toFixed(0)} margin · conf ${Math.round(plan.confidence * 100)}% (1e tranche is risicovrij)${existing.live ? ' · LIVE' : ''}`,
    });

    return true;
  }

  private async open(plan: TradePlan, signal: Signal, acceptedEntry: number): Promise<boolean> {
    const state = await this.account();
    const fee = plan.notional * FEE;
    // Never let an entry overdraw the free balance.
    if (plan.margin + fee > state.balance) return false;
    if (!this.planMatchesAcceptedEntry(plan, acceptedEntry, state.equity)) return false;

    const position: Position = {
      id: randomUUID(),
      symbol: plan.symbol,
      side: plan.side,
      entry: plan.entry,
      quantity: plan.quantity,
      leverage: plan.leverage,
      margin: plan.margin,
      initialMargin: plan.margin,
      notional: plan.notional,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      takeProfits: plan.takeProfits,
      remainingQuantity: plan.quantity,
      realisedPnl: 0,
      entryFee: fee,
      initialRisk: Math.abs(plan.entry - plan.stopLoss),
      breakEven: false,
      extreme: plan.entry,
      trailingArmed: false,
      openedAt: Date.now(),
      status: 'OPEN',
      confidence: plan.confidence,
      regime: plan.regime,
      reasons: plan.reasons,
      entryChecks: signal?.checks,
      strategyType: plan.strategyType,
      setupScore: plan.setupScore,
      leverageBreakdown: plan.leverageBreakdown,
      session: signal?.session || getMarketSession(new Date()).session,
      peakR: 0,
      troughR: 0,
      clusterRiskMultiplier: plan.clusterRiskMultiplier ?? 1.0,
    };

    // Mirror onto the real MEXC account when armed. Done BEFORE the position is
    // persisted so a rejected real order (bad symbol, insufficient margin,
    // venue error) aborts the paper entry too — the two books must never
    // diverge with paper believing a position exists that MEXC refused.
    if (this.exchange.status().enabled) {
      const mirrored = await this.mirrorOpenLive(position);
      if (!mirrored) return false;
    }

    await this.store.insertPosition(position);
    // Atomic delta — a concurrent exit crediting the balance in the same instant
    // must not be lost to this debit overwriting it with a stale read.
    await this.store.applyBalanceDelta({ balance: -(plan.margin + fee), realisedPnl: -fee });
    this.marks.set(plan.symbol, plan.entry);
    await this.log(
      'trade',
      `OPEN ${plan.side} ${plan.symbol} @ ${plan.entry} · ${plan.leverage}x · ${plan.margin} margin · risk ${(plan.riskPct * 100).toFixed(2)}% · conf ${(plan.confidence * 100).toFixed(0)}%${position.live ? ' · 🔴 LIVE' : ''}`
    );
    void notify({
      kind: 'trade-open',
      message: `OPEN ${plan.side} ${plan.symbol} @ ${plan.entry} · ${plan.leverage}x · ${plan.margin.toFixed(0)} margin · conf ${(plan.confidence * 100).toFixed(0)}%${position.live ? ' · LIVE' : ''}`,
    });
    return true;
  }

  private planMatchesAcceptedEntry(plan: TradePlan, acceptedEntry: number, equity: number): boolean {
    const directionSign = plan.side === 'LONG' ? 1 : -1;
    if (
      !Number.isFinite(acceptedEntry) || acceptedEntry <= 0 || plan.entry !== acceptedEntry ||
      !Number.isFinite(plan.stopLoss) || plan.stopLoss <= 0 ||
      directionSign * (plan.entry - plan.stopLoss) <= 0 ||
      !Number.isFinite(plan.quantity) || plan.quantity <= 0 ||
      !Number.isFinite(plan.notional) || plan.notional <= 0 ||
      !Number.isFinite(equity) || equity <= 0
    ) return false;

    const quantityFromNotional = plan.notional / acceptedEntry;
    const actualRiskPct =
      (plan.quantity * (Math.abs(acceptedEntry - plan.stopLoss) + FEE * (acceptedEntry + plan.stopLoss))) / equity;
    return (
      Math.abs(plan.quantity - quantityFromNotional) <= Math.max(1e-12, quantityFromNotional * 1e-6) &&
      actualRiskPct <= Math.max(plan.riskPct, this.risk.maxRiskPct) + 1e-6
    );
  }

  /**
   * Fail closed rather than treating an order acknowledgement as a confirmed
   * fill. The live entry remains disabled until reconciliation exists.
   *
   * @param position the paper position about to be opened.
   * @returns always false until confirmed-fill reconciliation is implemented.
   */
  private async mirrorOpenLive(position: Position): Promise<boolean> {
    if (!this.exchange.status().enabled) {
      await this.reportLiveExecutionBlocked();
      return false;
    }
    try {
      const detail = await this.market.contractDetail(position.symbol);
      const step = detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
      const vol = roundToStep(position.quantity / detail.contractSize, step);
      if (vol < detail.minVol) {
        await this.log(
          'warn',
          `Live entry overgeslagen: ${position.symbol} — gesized volume (${vol}) onder het minimum van de exchange (${detail.minVol}). Vergroot de inzet of sla dit signaal over.`
        );
        return false;
      }

      const orderValue = vol * detail.contractSize * position.entry;
      if (orderValue < 10) {
        await this.log(
          'warn',
          `Live entry overgeslagen: ${position.symbol} — orderwaarde ($${orderValue.toFixed(2)}) is lager dan het Hyperliquid minimum van $10 USDC. Verhoog de inzet.`
        );
        return false;
      }

      const priceScale = detail.priceScale ?? 4;
      const roundPrice = (p: number) => Number(p.toFixed(priceScale));
      const slPrice = position.stopLoss ? roundPrice(position.stopLoss) : undefined;

      await this.exchange.setLeverage(position.symbol, position.leverage, position.side, 'isolated');
      const opened = await this.exchange.placeMarketOrder({
        symbol: position.symbol,
        intent: position.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
        vol,
        leverage: position.leverage,
        openType: 'isolated',
        externalOid: position.id,
      });

      position.live = true;
      position.liveContractSize = detail.contractSize;
      position.liveOrderId = opened.orderId;

      try {
        if (slPrice) {
          let stopPlaced = false;
          let lastErr: unknown;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const stop = await this.exchange.placeStopOrder({
                symbol: position.symbol,
                side: position.side,
                vol,
                triggerPrice: slPrice,
                externalOid: `${position.id}-stop`,
              });
              position.liveStopOrderId = stop.orderId;
              stopPlaced = true;
              break;
            } catch (retryErr) {
              lastErr = retryErr;
              if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
            }
          }

          if (!stopPlaced) {
            await this.log(
              'error',
              `🚨 Live positie ${position.symbol} geopend maar stop plaatsen mislukt na 2 pogingen: ${(lastErr as Error).message}. Noodsluiting uitvoeren om kapitaal te beschermen...`
            );
            try {
              await this.exchange.closePosition({
                symbol: position.symbol,
                side: position.side,
                vol,
                externalOid: `${position.id}-sl-fail-close`,
              });
              await this.log('warn', `🛡️ Noodsluiting voor ${position.symbol} geslaagd: positie direct gesloten.`);
              void notify({
                kind: 'risk-halt',
                message: `Stop-order mislukt voor ${position.symbol} — positie automatisch gesloten ter beveiliging.`,
              });
              return false;
            } catch (closeErr) {
              position.liveStopOrderId = null;
              await this.log(
                'error',
                `🚨 CRITIEK: Noodsluiting voor ${position.symbol} MISLUKT: ${(closeErr as Error).message}. Sluit deze positie ONMIDDELLIJK handmatig op de exchange!`
              );
              void notify({
                kind: 'risk-halt',
                message: `CRITIEK NOODGEVAL: ${position.symbol} open zonder stop én noodsluiting mislukt! Handmatige actie vereist op de exchange!`,
              });
            }
          }
        }
      } catch (err) {
        position.liveStopOrderId = null;
        await this.log('error', `Onverwachte fout bij stop-order afhandeling: ${(err as Error).message}`);
      }

      // Place each Take Profit target in the ladder directly on the exchange
      if (position.takeProfits?.length) {
        const step = detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
        const totalNotional = vol * detail.contractSize * position.entry;

        // Hyperliquid requires each order to have >= $10 notional.
        // Adapt target portions so each active order clears the $10 minimum:
        // - totalNotional < 20: 1 target (100% at TP1)
        // - totalNotional < 30: 2 targets (50% / 50%)
        // - totalNotional >= 30: all 3 targets
        let tpsToPlace = position.takeProfits;
        if (totalNotional < 20) {
          tpsToPlace = [{ ...position.takeProfits[0], portion: 1.0 }];
        } else if (totalNotional < 30 && position.takeProfits.length >= 2) {
          tpsToPlace = [
            { ...position.takeProfits[0], portion: 0.5 },
            { ...position.takeProfits[position.takeProfits.length - 1], portion: 0.5 },
          ];
        }

        let remainingVol = vol;
        for (let i = 0; i < tpsToPlace.length; i++) {
          const tp = tpsToPlace[i];
          const isLast = i === tpsToPlace.length - 1;
          const tpVol = isLast ? roundToStep(remainingVol, step) : Math.max(detail.minVol, roundToStep(vol * tp.portion, step));
          remainingVol = roundToStep(remainingVol - tpVol, step);
          if (tpVol > 0) {
            const tpTargetPrice = Number(tp.price.toFixed(priceScale));
            await this.exchange
              .placeTakeProfitOrder({
                symbol: position.symbol,
                side: position.side,
                vol: tpVol,
                triggerPrice: tpTargetPrice,
                externalOid: `${position.id}-tp-${i + 1}`,
              })
              .catch((err) => {
                void this.log('warn', `TP${i + 1} trigger (${tpTargetPrice}) plaatsen mislukt: ${(err as Error).message}`);
              });
          }
        }
      }
      return true;
    } catch (err) {
      await this.log(
        'warn',
        `Live entry mislukt voor ${position.symbol}: ${(err as Error).message} — geen order geplaatst, positie niet geopend.`
      );
      return false;
    }
  }

  private async reduceLivePosition(position: Position, qty: number): Promise<boolean> {
    const contractSize = position.liveContractSize || 1;
    const detail = await this.market.contractDetail(position.symbol).catch(() => null);
    const step = detail && detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
    const vol = roundToStep(qty / contractSize, step);
    if (vol <= 0) return true;
    try {
      await this.exchange.closePosition({
        symbol: position.symbol,
        side: position.side,
        vol,
        externalOid: `${position.id}-tp-${Date.now()}`,
      });
      return true;
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      if (
        msg.includes('not found') ||
        msg.includes('no position') ||
        msg.includes('empty') ||
        msg.includes('zero') ||
        msg.includes('not exist') ||
        msg.includes('position is zero') ||
        msg.includes('would increase position') ||
        msg.includes('reduce only')
      ) {
        await this.log('warn', `Live positie ${position.symbol} bestaat niet meer op exchange — lokaal sluiten wordt voltooid.`);
        return true;
      }
      await this.log(
        'warn',
        `Live take-profit sluiten mislukt voor ${position.symbol}: ${(err as Error).message} — wordt volgende cyclus opnieuw geprobeerd.`
      );
      return false;
    }
  }

  private async moveLiveStop(position: Position, stopPrice: number, remainingQty: number): Promise<void> {
    // Cancel existing stop order (if any) before placing a new one.
    // Note: do NOT early-return if liveStopOrderId is null — we still need to place a fresh stop.
    if (position.liveStopOrderId) {
      try {
        await this.exchange.cancelStopOrder(position.liveStopOrderId, position.symbol);
      } catch {
        // Ignore — order may already be gone
      }
      position.liveStopOrderId = null;
    }
    const contractSize = position.liveContractSize || 1;
    const detail = await this.market.contractDetail(position.symbol).catch(() => null);
    const step = detail && detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
    const minVol = detail?.minVol || 1;
    const vol = Math.max(minVol, roundToStep(remainingQty / contractSize, step));
    try {
      const stop = await this.exchange.placeStopOrder({
        symbol: position.symbol,
        side: position.side,
        vol,
        triggerPrice: stopPrice,
        externalOid: `${position.id}-stop-${Date.now()}`,
      });
      position.liveStopOrderId = stop.orderId;
      position.stopLoss = stopPrice;
      await this.store.updatePosition(position.id, {
        liveStopOrderId: stop.orderId,
        stopLoss: stopPrice,
      });
    } catch (err) {
      await this.log('warn', `Stop verplaatsen op exchange mislukt voor ${position.symbol}: ${(err as Error).message}`);
    }
  }

  /**
   * Settle an externally closed position locally (e.g. stopped out or closed on exchange).
   */
  private async settleExternally(
    position: Position,
    price: number,
    reason: NonNullable<Position['exitReason']> = 'MANUAL'
  ): Promise<void> {
    if (position.live) {
      if (position.liveStopOrderId) {
        await this.exchange.cancelStopOrder(position.liveStopOrderId, position.symbol).catch(() => {});
      }
      await this.exchange.cancelAllPlanOrders(position.symbol).catch(() => {});
    }
    const { total, settling, net } = closeSettlement(position, price);
    const postMortem = await this.recordPostMortem(position, price, reason, net);
    const claimed = await this.store.settlePosition(position.id, {
      closedAt: Date.now(),
      exit: price,
      pnl: net,
      pnlPct: (position.initialMargin ?? (position.quantity && position.entry && position.leverage ? (position.quantity * position.entry) / position.leverage : position.margin)) > 0
        ? net / (position.initialMargin ?? (position.quantity && position.entry && position.leverage ? (position.quantity * position.entry) / position.leverage : position.margin))
        : 0,
      exitReason: reason,
      remainingQuantity: 0,
      realisedPnl: total,
      postMortem,
    });
    if (!claimed) return;
    await this.store.applyBalanceDelta({
      balance: position.margin + settling,
      realisedPnl: settling,
    });
    this.marks.delete(position.symbol);
    await this.log(
      net >= 0 ? 'trade' : 'warn',
      `Reconciliatie: ${position.symbol} ${position.side} extern gesloten op exchange — lokaal afgewikkeld @ ${price} (PnL: ${net >= 0 ? '+' : ''}$${net.toFixed(2)}), slot vrijgegeven.`
    );
    void notify({
      kind: 'trade-close',
      message: `CLOSE ${position.side} ${position.symbol} @ ${price} · extern gesloten op exchange · ${net >= 0 ? '+' : ''}$${net.toFixed(2)} · LIVE`,
    });
  }

  /**
   * Realign / recalculate or manually customize Take Profit targets and Stop Loss for an open position.
   * If custom levels are provided, validates and sets them; otherwise automatically recalculates
   * optimal levels using current ATR and market structure. If the position is live, updates orders on the exchange.
   */
  public async realignPositionTpSl(
    id: string,
    customTpSl?: { stopLoss?: number; takeProfits?: Array<{ price: number; portion?: number }> }
  ): Promise<{ ok: boolean; position: Position }> {
    const position = await this.store.position(id);
    if (!position || position.status !== 'OPEN') {
      throw new Error(`Positie ${id} niet gevonden of niet meer open.`);
    }

    const price = this.markOf(position);
    const detail = await this.market
      .contractDetail(position.symbol)
      .catch(() => ({ contractSize: position.liveContractSize || 1, minVol: 1, maxVol: 100000, priceScale: 4 }));
    const priceScale = detail.priceScale ?? 4;
    const isLong = position.side === 'LONG';
    const dir = isLong ? 1 : -1;

    let newSl: number;
    let newTps: TakeProfitLevel[];

    if (customTpSl?.stopLoss && customTpSl?.takeProfits?.length) {
      newSl = Number(customTpSl.stopLoss.toFixed(priceScale));
      newTps = customTpSl.takeProfits.map((tp, idx) => ({
        price: Number(tp.price.toFixed(priceScale)),
        portion: tp.portion ?? (idx === 0 ? 0.33 : idx === 1 ? 0.33 : 0.34),
        rMultiple: Math.round((Math.abs(tp.price - position.entry) / Math.max(0.0001, Math.abs(position.entry - newSl))) * 10) / 10 || 1.5,
        hit: false,
      }));
    } else {
      // Automatic smart recalculation using coin profile, ATR and entry price
      const profile = getCoinProfile(position.symbol);
      const candles = await this.market.candles(position.symbol, 'Min60').catch(() => []);
      const atrVal = candles.length >= 14 ? atr(candles, 14) : position.entry * 0.02;
      const stopDistance = Math.max(position.entry * 0.015, atrVal * profile.atrStopMultiple);
      newSl = Number((position.entry - dir * stopDistance).toFixed(priceScale));

      const r1 = profile.firstTargetR;
      const r2 = Number((profile.firstTargetR + (profile.finalTargetR - profile.firstTargetR) * 0.5).toFixed(1));
      const r3 = profile.finalTargetR;

      const p1 = profile.firstTargetPortion;
      const p2 = Number(((1 - p1) / 2).toFixed(2));
      const p3 = Number((1 - p1 - p2).toFixed(2));

      const tp1 = Number((position.entry + dir * stopDistance * r1).toFixed(priceScale));
      const tp2 = Number((position.entry + dir * stopDistance * r2).toFixed(priceScale));
      const tp3 = Number((position.entry + dir * stopDistance * r3).toFixed(priceScale));

      newTps = [
        { price: tp1, portion: p1, rMultiple: r1, hit: false },
        { price: tp2, portion: p2, rMultiple: r2, hit: false },
        { price: tp3, portion: p3, rMultiple: r3, hit: false },
      ];
    }

    const updatedTakeProfit = newTps[0].price;
    await this.store.updatePosition(position.id, {
      stopLoss: newSl,
      takeProfit: updatedTakeProfit,
      takeProfits: newTps,
      breakEven: false,
    });

    position.stopLoss = newSl;
    position.takeProfit = updatedTakeProfit;
    position.takeProfits = newTps;
    position.breakEven = false;

    // If live, synchronize Stop Loss and Take Profit orders on the exchange
    if (position.live && this.exchange.status().enabled) {
      const remainingQty = position.remainingQuantity ?? position.quantity;
      const contractSize = position.liveContractSize || 1;
      const step = detail.minVol > 0 && detail.minVol < 1 ? detail.minVol : 1;
      const vol = Math.max(detail.minVol, roundToStep(remainingQty / contractSize, step));

      // 1. Cancel ALL existing open orders for this symbol FIRST (TP + SL from before),
      //    so we start with a clean slate and don't accidentally cancel the new SL below.
      await this.exchange.cancelAllPlanOrders(position.symbol).catch(() => {});

      // 2. Place a fresh Stop Loss (moveLiveStop also cancels any remaining stop by ID,
      //    but since we just bulk-cancelled everything, liveStopOrderId may now be stale — reset it).
      position.liveStopOrderId = null;
      await this.moveLiveStop(position, newSl, remainingQty).catch((err) => {
        void this.log('warn', `Stop Loss bijwerken op exchange mislukt voor ${position.symbol}: ${(err as Error).message}`);
      });

      // 3. Place fresh TP orders

      let remainingVol = vol;
      for (let i = 0; i < newTps.length; i++) {
        const tp = newTps[i];
        const isLast = i === newTps.length - 1;
        const tpVol = isLast ? roundToStep(remainingVol, step) : Math.max(detail.minVol, roundToStep(vol * tp.portion, step));
        remainingVol = roundToStep(remainingVol - tpVol, step);
        if (tpVol > 0) {
          await this.exchange
            .placeTakeProfitOrder({
              symbol: position.symbol,
              side: position.side,
              vol: tpVol,
              triggerPrice: tp.price,
              externalOid: `${position.id}-tp-${i + 1}-${Date.now()}`,
            })
            .catch((err) => {
              void this.log('warn', `TP${i + 1} herplaatsen op exchange mislukt: ${(err as Error).message}`);
            });
        }
      }

      // Persist the new liveStopOrderId so it survives restarts
      if (position.liveStopOrderId !== undefined) {
        await this.store.updatePosition(position.id, {
          liveStopOrderId: position.liveStopOrderId ?? undefined,
        });
      }
    }

    await this.log(
      'trade',
      `🎯 TP & SL opnieuw ingesteld voor ${position.symbol} ${position.side}: SL @ ${newSl}, TP's @ ${newTps.map((t) => t.price).join(', ')}${position.live ? ' (gesynchroniseerd op exchange)' : ''}`
    );

    return { ok: true, position };
  }

  private async close(
    position: Position,
    price: number,
    reason: NonNullable<Position['exitReason']>
  ): Promise<boolean> {
    if (this.resetting || this.closingPositions.has(position.id)) return false;
    this.closingPositions.add(position.id);
    try {
      return await this.closeUnlocked(position, price, reason);
    } finally {
      this.closingPositions.delete(position.id);
    }
  }

  private async closeUnlocked(
    position: Position,
    price: number,
    reason: NonNullable<Position['exitReason']>
  ): Promise<boolean> {
    if (position.live) {
      if (!this.exchange.status().enabled) {
        await this.reportLiveExecutionBlocked();
        return false;
      }
      if (reason !== 'LIQUIDATED' && position.remainingQuantity > 0) {
        const reduced = await this.reduceLivePosition(position, position.remainingQuantity);
        if (!reduced) return false;
      }
      if (position.liveStopOrderId) {
        await this.exchange.cancelStopOrder(position.liveStopOrderId, position.symbol).catch(() => {});
      }
      await this.exchange.cancelAllPlanOrders(position.symbol).catch(() => {});
    }

    // Only the quantity still open is settled here — tranches closed at earlier
    // take-profit levels have already been booked and paid out.
    const { total, settling, net } = closeSettlement(position, price);

    const postMortem = await this.recordPostMortem(position, price, reason, net);

    // Claim the position atomically — only the winner settles the cash, so a
    // manual close racing the engine cycle cannot credit the pnl twice.
    const claimed = await this.store.settlePosition(position.id, {
      closedAt: Date.now(),
      exit: price,
      // Reported result includes the entry fee, so the number the user sees is
      // what the trade actually made.
      pnl: net,
      pnlPct: (position.initialMargin ?? (position.quantity && position.entry && position.leverage ? (position.quantity * position.entry) / position.leverage : position.margin)) > 0
        ? net / (position.initialMargin ?? (position.quantity && position.entry && position.leverage ? (position.quantity * position.entry) / position.leverage : position.margin))
        : 0,
      exitReason: reason,
      remainingQuantity: 0,
      realisedPnl: total,
      postMortem,
    });
    if (!claimed) return false;

    // Only the pnl on the still-open portion settles now. Atomic delta — the
    // background cycle and a manual close both reach this line concurrently, so
    // a plain read-then-write here would drop whichever credit landed second.
    await this.store.applyBalanceDelta({
      balance: position.margin + settling,
      realisedPnl: settling,
    });
    this.marks.delete(position.symbol);

    // Granular cooldowns per coin / setup:
    // - Na TP: 15 min cooldown op dezelfde coin
    // - Na Break-Even: 30 min cooldown op dezelfde coin
    // - Na Stop-Loss: 60 min cooldown op dezelfde coin/richting
    // - Na Fakeout / valse breakout: 120 min cooldown op die zone
    const durationMinutes = Math.max(1, Math.round((Date.now() - position.openedAt) / 60_000));
    const hitAnyTp = position.takeProfits && position.takeProfits.some((t) => t.hit);

    if (reason === 'TAKE_PROFIT' || (hitAnyTp && net >= 0)) {
      const cdMin = this.risk.cooldownTpMinutes ?? 15;
      this.setCooldown(position.symbol, cdMin, `Take-profit bereikt (${cdMin}m cooldown op munt)`);
    } else if (reason === 'BREAK_EVEN' || (position.breakEven && Math.abs(net) < 1.0)) {
      const cdMin = this.risk.cooldownBeMinutes ?? 30;
      this.setCooldown(position.symbol, cdMin, `Break-even geraakt (${cdMin}m cooldown op munt)`);
    } else if (reason === 'STOP_LOSS' || (reason === 'TRAILING_STOP' && net < -0.05)) {
      const isQuickStop = durationMinutes <= 20;
      const isFakeout =
        isQuickStop ||
        position.strategyType === 'BREAKOUT' ||
        (postMortem?.verdict === 'LOSS' && durationMinutes <= 30);
      if (isFakeout) {
        const cdMin = this.risk.cooldownFakeoutMinutes ?? 120;
        this.setCooldown(position.symbol, cdMin, `Fakeout / valse uitbraak (${cdMin}m cooldown)`);
        this.setCooldown(`${position.symbol}:fakeout`, cdMin, `Fakeout (${cdMin}m cooldown)`);
        this.setCooldown(`${position.symbol}:${position.side}`, cdMin, `Fakeout richting (${cdMin}m cooldown)`);
      } else {
        const cdMin = this.risk.cooldownSlMinutes ?? 60;
        this.setCooldown(
          `${position.symbol}:${position.side}`,
          cdMin,
          `Stop-loss geraakt (${cdMin}m cooldown op ${position.side})`
        );
      }
    }
    await this.log(
      net >= 0 ? 'trade' : 'warn',
      `CLOSE ${position.side} ${position.symbol} @ ${price} · ${reason} · ${net >= 0 ? '+' : ''}${net.toFixed(2)} (${((position.margin ? net / position.margin : 0) * 100).toFixed(1)}%)${position.live ? ' · 🔴 LIVE' : ''}`
    );
    void notify({
      kind: 'trade-close',
      message: `CLOSE ${position.side} ${position.symbol} @ ${price} · ${reason} · ${net >= 0 ? '+' : ''}${net.toFixed(2)} (${((position.margin ? net / position.margin : 0) * 100).toFixed(1)}%)${position.live ? ' · LIVE' : ''}`,
    });
    return true;
  }

  private async rollDay(account: Account, dayKey: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (dayKey === today) return;
    // Auto-reset the daily-limit override — it was only valid for the day it was set.
    if (this.risk.ignoreDailyLimit) {
      this.risk = { ...this.risk, ignoreDailyLimit: false };
      await this.log('info', 'Daglimiet-override gereset bij dagwisseling.');
    }
    // Conditional write — only rolls when the stored day key still differs, so
    // an overlapping cycle racing the day boundary cannot reset the baseline twice.
    await this.store.rollDay(today, account.equity);
  }

  /**
   * Unrealised pnl on the portion of a position that is still open.
   *
   * Profit already booked at a take-profit level is deliberately excluded: it was
   * paid into the balance the moment that tranche closed, so counting it here too
   * would inflate equity by the booked amount.
   */
  private pnlOf(position: Position, price: number): number {
    return openPnl(position, price);
  }

  /** Last known mark price, falling back to the entry so pnl reads as flat. */
  private markOf(position: Position): number {
    return this.marks.get(position.symbol) || position.entry;
  }

  private async livePrice(symbol: string): Promise<number> {
    try {
      return (await this.market.price(symbol)) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Re-validate a candidate entry against a fresh price right before capital
   * is committed, so a slot freed up mid-cycle (by an earlier entry or an
   * exit in the same loop) does not blindly reuse a signal computed a few
   * seconds to tens of seconds earlier against the scan's cached tickers.
   *
   * Two things can invalidate a signal between scoring and execution:
   *  - price already moved a meaningful fraction of the stop distance against
   *    the planned side (the setup is no longer at a favourable entry, and
   *    the risk/reward the plan was sized for no longer holds);
   *  - the live price fetch itself fails or returns nothing usable, in which
   *    case there is no way to confirm the trade is still sound.
   *
   * This does not re-run the full signal/indicator pipeline (that would cost
   * a second full candle fetch per candidate, undermining the fast watch
   * loop) — it is a cheap, final sanity gate, not a re-scan.
   *
   * @param signal the scored candidate the plan was built from.
   * @param plan the sized trade plan awaiting execution.
   * @returns whether the entry still qualifies, with a reason when it does not.
   */
  private async confirmEntry(
    signal: Signal,
    plan: TradePlan
  ): Promise<{ ok: true; reason: ''; price: number; plan: TradePlan } | { ok: false; reason: string }> {
    if (
      plan.symbol !== signal.symbol || plan.side !== signal.side || plan.entry !== signal.price ||
      !Number.isFinite(plan.entry) || plan.entry <= 0 || !Number.isFinite(plan.stopLoss) || plan.stopLoss <= 0 ||
      (plan.side === 'LONG' ? plan.stopLoss >= plan.entry : plan.stopLoss <= plan.entry)
    ) return { ok: false, reason: 'oorspronkelijk plan is ongeldig of past niet bij het signaal' };

    const fresh = await this.livePrice(signal.symbol);
    if (!fresh || !Number.isFinite(fresh) || fresh <= 0) {
      return { ok: false, reason: 'geen verse prijs beschikbaar' };
    }
    const dir = plan.side === 'LONG' ? 1 : -1;
    const stopDistance = Math.abs(plan.entry - plan.stopLoss);
    if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
      return { ok: false, reason: 'ongeldige stopafstand' };
    }
    const remainingStopDistance = dir * (fresh - plan.stopLoss);
    if (remainingStopDistance <= 0) {
      return { ok: false, reason: 'verse prijs is voorbij de geplande stop' };
    }
    const driftInRiskUnits = Math.abs(fresh - plan.entry) / stopDistance;
    if (driftInRiskUnits > 0.20) {
      return {
        ok: false,
        reason: `verse prijs wijkt ${(driftInRiskUnits * 100).toFixed(0)}% van de stopafstand af van de geplande entry (max 20%)`,
      };
    }
    const executionSignal = { ...signal, price: fresh };
    const [account, detail] = await Promise.all([
      this.account(),
      this.market.contractDetail(executionSignal.symbol).catch(() => null),
    ]);
    const executionPlan = planTrade(executionSignal, account, this.risk, FEE, detail?.maxLeverage);
    if (
      !executionPlan || executionPlan.symbol !== signal.symbol || executionPlan.side !== signal.side ||
      executionPlan.entry !== fresh || !this.planMatchesAcceptedEntry(executionPlan, fresh, account.equity)
    ) {
      return { ok: false, reason: 'verse prijs levert geen geldig plan op' };
    }
    return { ok: true, reason: '', price: fresh, plan: executionPlan };
  }

  /**
   * Log a skip reason for a candidate symbol at most once while the condition persists.
   * If the reason changes or 30 minutes pass, it can log again.
   */
  private async logSkip(symbol: string, reason: string, blockCode?: BlockReasonCode): Promise<void> {
    const prev = this.lastSkipReasons.get(symbol);
    const now = Date.now();
    if (!prev || prev.reason !== reason || now - prev.at > 30 * 60_000) {
      this.lastSkipReasons.set(symbol, { reason, at: now, blockCode });
      await this.log('info', `${symbol} overgeslagen: ${reason}${blockCode ? ` [${blockCode}]` : ''}`);
    }
  }

  private async reportLiveExecutionBlocked(): Promise<void> {
    if (this.liveExecutionWarningLogged) return;
    this.liveExecutionWarningLogged = true;
    const reason = this.exchange.status?.()?.executionDisabledReason || 'Live trading staat momenteel uitgeschakeld';
    await this.log('warn', reason);
  }

  private async log(level: EngineEvent['level'], message: string): Promise<void> {
    await this.store.addEvent({ at: Date.now(), level, message });
    if (level === 'error') {
      const isHl = /hyperliquid|dex|live/i.test(message);
      ErrorLogger.getInstance().error(isHl ? 'Hyperliquid' : 'Engine', message);
    } else if (level === 'warn') {
      const isHl = /hyperliquid|dex|live/i.test(message);
      ErrorLogger.getInstance().warn(isHl ? 'Hyperliquid' : 'Engine', message);
    }
  }
}
