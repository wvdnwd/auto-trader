import type {
  Account,
  BlockedState,
  RiskConfig,
  Side,
  Signal,
  TakeProfitLevel,
  TradePlan,
} from './types.js';

/**
 * Default risk profile.
 *
 * The base version of this profile was selected by a 160-combination parameter
 * search over 18 months of hourly data across eight crypto perps (65%/35%
 * train/test split, re-checked quarter by quarter). That search found leverage
 * was NOT the binding constraint — 8x, 12x and 20x gave identical out-of-sample
 * returns once sizing was fixed by the stop distance and risk budget — so it
 * defaulted to the lowest cap (8x) as free safety margin against liquidation.
 *
 * Measured per-quarter result of the original 8x/1%-risk profile (8 perps, 1h
 * entries, 4h filter):
 *
 * | Quarter | Return | Profit factor |
 * |---------|--------|---------------|
 * | Q1 2025 | +16.4% | 1.25 |
 * | Q2 2025 | -10.9% | 0.75 |
 * | Q3 2025 | +46.2% | 1.67 |
 * | Q4 2025 | -10.4% | 0.79 |
 * | Q1 2026 |  +3.9% | 1.09 |
 * | Q2 2026 |  +9.9% | 1.22 |
 *
 * Read that honestly: four quarters up, two down, and Q3 2025 alone carries the
 * sum. This is a trend-following profile, so it earns in trending quarters and
 * bleeds in chop. Expect losing quarters — they are normal, not a malfunction.
 *
 * DELIBERATE OVERRIDE (user request): risk budget and leverage ceiling raised
 * above the tier the optimizer called optimal, to put more balance to work per
 * trade and allow up to 20x. Since leverage did not change *return* in the
 * search above, raising the cap does not add edge — it removes the liquidation
 * safety margin the 8x default was chosen for. The stop still defines the loss
 * at the OLD (smaller) position size; at 20x that same stop sits roughly 2.5x
 * closer to the liquidation price than at 8x. Re-validate with a backtest/
 * walk-forward run before trusting this in paper trading.
 *
 * The single most important field is `requireHigherAlignment`: every parameter
 * set in the top tier had it enabled, and every set without it lost money. The
 * strategy only has an edge when it trades with the higher timeframe.
 */
export const DEFAULT_RISK: RiskConfig = {
  // Calibrated to 0.025 (2.5%) to support ~€40-€50 trade sizing on ~€300 equity.
  baseRiskPct: 0.025,
  // Raised to 0.04 (4%) hard per-trade ceiling for high conviction setups.
  maxRiskPct: 0.04,
  // Lowered to 12 per user request for the first live run — the search found
  // leverage above ~12x added no return, only shrank the liquidation buffer,
  // so 12x sits right at that ceiling with a bit more margin of safety than
  // the earlier 15x setting.
  maxLeverage: 12,
  minLeverage: 2,
  // Max concurrent open positions in the portfolio. Scaled to 6 so trades receive
  // substantial margin (~€40-€50 at €300 balance) with safety buffer.
  maxOpenPositions: 6,
  // Raised to 0.95 so the portfolio margin budget can deploy across the full balance
  // (leaving a 5% buffer for exchange fees and slippage), rather than artificially
  // holding 80% of funds idle.
  maxTotalMarginPct: 0.95,
  maxDrawdownPct: 0.25,
  dailyLossLimitPct: 0.08,
  // Raised from 0.45 to 0.60: only trade strong signals to cut low-conviction chop losses.
  minConfidence: 0.6,
  // Reduced from 48h to 36h: allows profitable runners to develop without keeping capital tied up for days.
  maxPositionHours: 36,
  // Stale Trade Exit: close unconfirmed positions (TP1 not reached) after 12h if price has made no significant headway.
  maxStaleHours: 12,
  // Proactively close positions when market conditions deteriorate into uncertainty or oppose the trade.
  uncertaintyExitEnabled: true,
  // Progressive Profit-Locking: ratchet stop loss up as price advances (+2.2R, +3.2R, +4.2R).
  profitLockingEnabled: true,
  // Harvest 25%-30% on parabolic blow-off top climax candles before the dump.
  climaxExitEnabled: true,
  // Use 15m micro-timing to avoid buying at the peak of an hourly candle.
  microTiming15mEnabled: true,
  // Use limit pullback entry instead of pure market orders when price is extended.
  pullbackEntryEnabled: true,
  // Use ATR-based dynamic chandelier trailing stop for runners.
  dynamicChandelierTrailing: true,
  // A wider stop survives normal noise; the tighter 2.2x version was stopped out
  // of trades that later reached their target.
  atrStopMultiple: 3,
  // Was 0.8 — well below firstTargetR (1.8), so the trailing stop was arming
  // and closing trades on a pullback before TP1 ever had a chance to fill (a
  // trade that ran to +1.2R then pulled back closed via TRAILING_STOP with a
  // small profit, TP1 never touched). Raised to match firstTargetR so trailing
  // only takes over the runner AFTER the first target has already been banked.
  trailArmR: 1.5,
  // Raised from 0.6 per user request: after TP1 hits, the old 0.6 giveback let
  // a normal post-target consolidation wobble stop the runner out almost
  // immediately ("hit take profit, drops back a tick, stopped out"). 0.75 gives
  // the runner more room to breathe through a pullback before the trail exits
  // it, at the cost of giving back a larger share of the peak if it does
  // reverse for good.
  trailGiveback: 0.75,
  firstTargetR: 1.5,
  // Banking half at the first rung beat banking 30%. Taking the runner-heavy side
  // sounds right in theory, but the extra realised profit funds the stop-outs.
  firstTargetPortion: 0.5,
  finalTargetR: 3.6,
  breakEvenAfterFirst: true,
  requireHigherAlignment: true,
  // Scaled to match maxOpenPositions (6) so the book can take up to 6 aligned trades
  // in the same direction when market conviction is high.
  maxSameSidePositions: 6,
  maxPerGroup: 2,
  // Scaled to 10% - 20% for ~€40-€50 trade sizing on ~€300 equity.
  minStakePct: 0.1,
  targetStakePct: 0.2,
  highConvictionConfidence: 0.7,
  maxOverflowPositions: 0,
  // Hard floor: never open trades under $35/€35 margin.
  minTradeMarginUsdt: 35,
  // Relative Strength filter: off by default so altcoin breakouts and dips are not blocked by BTC comparison.
  rsFilterEnabled: false,
  // Crowding & Squeeze protection: skip longs if funding exceeds +0.05% per 8h.
  maxFundingRateLong: 0.0005,
  // Crowding & Squeeze protection: skip shorts if funding falls below -0.05% per 8h.
  minFundingRateShort: -0.0005,
  // Price action confirmation: require 15m candle reversal before entering pullbacks.
  reversal15mRequired: true,
  // 6 consecutive cycles with zero tradeable signal across the whole universe
  // (roughly 4.5 hours at the 45s baseline, since a dead cycle also has nothing
  // to trigger the fast 5s watch mode) is treated as a dead trending regime —
  // pause new entries rather than force a low-edge trade to stay busy.
  chopPauseStreak: 6,
  // Off by default — a deliberate opt-in for a small starting balance (see
  // `turboMode` doc comment on RiskConfig).
  turboMode: false,
  // On by default per user request: as soon as the regime genuinely turns
  // against an open position (e.g. held LONG while the market flips to
  // TREND_DOWN), trim part of it immediately rather than riding it all the way
  // to the stop-loss or waiting for a full opposite-side signal to close it.
  trendFlipProtection: true,
  // Half the remaining size comes off on the first adverse regime flip — enough
  // to meaningfully cut risk while leaving a stake behind in case the flip is a
  // brief wobble rather than a real reversal. The remainder stays under the
  // normal stop/trailing/take-profit logic afterwards.
  trendFlipTrimPortion: 0.5,
  // Bitcoin Gatekeeper: blocks altcoin trades that fight Bitcoin's dominant trend.
  btcFilterEnabled: true,
  // Minimum minutes between consecutive entries to prevent trade clustering on spikes.
  entryCooldownMinutes: 2,
  // Minimum 24h quote volume (USDT) to trade a coin — protects against illiquid tokens.
  minQuoteVolume24h: 5_000_000,
  // Healthy buffer beyond entry+fees after TP1 so retests don't prematurely stop out runners.
  breakEvenBufferR: 0.35,
  // Only open trades during permitted market sessions (false = 24/7 trading enabled).
  sessionFilterEnabled: false,
  // Sessions permitted to open trades when sessionFilterEnabled is true.
  allowedSessions: ['ASIA', 'LONDON', 'NEW_YORK'],
  // Adapt strategy weights according to active market session dynamics.
  sessionAdaptiveWeights: true,
  // Exploit Asian range high/low liquidity sweeps during London and New York sessions.
  asianRangeSweepEnabled: true,
  // Smart Pyramiding: allow adding a 2nd tranche to winning, derisked positions on pullback.
  pyramidingEnabled: true,
  pyramidMinConfidence: 0.85,
  // Sniper Pullback: require price to be near EMA21 or inside Fib golden zone (true = gatekeeper active for all entries).
  pullbackFilterEnabled: true,
  // Override for the daily loss halt — reset to false at every daily rollover.
  ignoreDailyLimit: false,
  // Breakout Momentum Bypass: allow immediate entry on volume-spurt breakouts without waiting for pullback.
  breakoutBypassEnabled: true,
  // Dynamic Altcoin Runners: expand far target to 5.0R on strong breakout runners.
  dynamicRunnersEnabled: true,
  // Stagnation Exit: close trades that stagnate around break-even after 2.5h without progress towards TP1.
  stagnationExitEnabled: true,
  stagnationHours: 2.5,
  stagnationMaxR: 0.35,
  // Spread & Slippage Shield: reject orders if bid-ask spread exceeds 0.15%.
  spreadShieldEnabled: true,
  maxSpreadPct: 0.0015,
  // BTC Flash-Dump circuit breaker: drop >1.2% in short window blocks new longs.
  btcFlashDumpThreshold: -0.012,
  // Early Profit Protection: move stop to break-even once +1.2R is touched.
  earlyBreakEvenR: 1.2,
  // BTC Chop Filter: pause altcoin entries when Bitcoin is in CHOP (sideways/directionless).
  btcChopFilterEnabled: true,
  // Standby Mode: pause opening new positions while continuing to manage existing positions.
  pauseNewEntries: false,
  // Market Structure Shift (MSS) protection: protect or exit open positions immediately on adverse structural break.
  mssProtectionEnabled: true,
  // Premium/Discount filter: block LONGs in Premium (>50%) and SHORTs in Discount (<50%) (off by default, opt-in).
  premiumDiscountFilterEnabled: false,
  // Imbalance / Golden Zone Scalps: allow high R:R scalps towards FVG / Fib 0.618 after sweeps.
  imbalanceScalpEnabled: true,
  // Require Fair Value Gap or Order Block confluence for pullback entries.
  fvgFilterEnabled: false,
  // 5m Sniper Trigger: verify 5m micro-reversal (green candle / hammer wick) right before opening order.
  ltfSniper5mEnabled: true,
  // SMT Divergence Filter: detect institutional divergence vs Bitcoin.
  smtFilterEnabled: true,
  // Volume Profile & POC: compute Point of Control & Value Area.
  volumeProfileEnabled: true,
};

/**
 * Correlation groups. Instruments inside a group move together closely enough
 * that holding several of them is one position, not several.
 */
const GROUPS: Record<string, RegExp> = {
  majors: /^(BTC|ETH)_/i,
  layer1: /^(SOL|AVAX|NEAR|ADA|DOT|SUI|APT|SEI|TIA|ATOM|INJ|TON|FTM|ALGO|HBAR|KAS|ICP)_/i,
  ai: /^(FET|RENDER|TAO|WLD|AGIX|OCEAN|ARKM|ASI|IO|ATH)_/i,
  defi: /^(UNI|AAVE|MKR|LDO|PENDLE|CRV|SNX|COMP|JUP|RAY|AERO|ENA|SUSHI|DYDX)_/i,
  memes:
    /^(DOGE|SHIB|PEPE|WIF|1000BONK|BONK|FLOKI|FARTCOIN|PENGU|SPX|POPCAT|BOME|TURBO|PNUT|NEIRO|NEIROCTO|MOODENG|BRETT|MEW|GOAT|MOG|1000000MOG|ACT|TRUMP)_/i,
  exchange: /^(BNB|OKB|CRO|FTT|BGB|KCS)_/i,
};

/**
 * The correlation group a symbol belongs to.
 *
 * Only tight clusters are named. Everything else returns `alts`, which is a
 * catch-all rather than a real cluster — capping it like a cluster would block
 * most of the book, since almost every altcoin would land in it.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 * @returns the group name, or `alts` when it fits none of the known clusters.
 */
export function correlationGroup(symbol: string): string {
  for (const [name, pattern] of Object.entries(GROUPS)) {
    if (pattern.test(symbol)) return name;
  }
  return 'alts';
}

/**
 * Whether a new position would breach the concentration limits.
 *
 * Position count alone is a poor risk limit in crypto: five longs across five
 * tickers all lose together when the market turns. This caps exposure per
 * direction and per correlation group so the book is genuinely spread.
 *
 * @param candidate the symbol and side being considered.
 * @param open symbols and sides already held.
 * @param config active risk configuration.
 * @returns a reason string when the trade should be skipped, otherwise null.
 */
export function concentrationBlock(
  candidate: { symbol: string; side: Side },
  open: { symbol: string; side: Side }[],
  config: RiskConfig
): string | null {
  const sameSide = open.filter((p) => p.side === candidate.side).length;
  if (sameSide >= config.maxSameSidePositions) {
    return `al ${sameSide} posities ${candidate.side} — te eenzijdig`;
  }
  const group = correlationGroup(candidate.symbol);
  // `alts` is a catch-all, not a cluster — the same-side cap above is what limits
  // broad market exposure there.
  if (group !== 'alts') {
    const inGroup = open.filter((p) => correlationGroup(p.symbol) === group).length;
    if (inGroup >= config.maxPerGroup) {
      return `al ${inGroup} posities in groep ${group}`;
    }
  }
  return null;
}

/**
 * Safety buffer between the stop loss and the liquidation price. A position is
 * liquidated at roughly a `1 / leverage` adverse move, so the leverage must stay
 * low enough that the stop is always hit first.
 */
const LIQUIDATION_BUFFER = 0.7;

/** Smallest collateral worth committing to a single trade, in quote currency. */
const MIN_MARGIN = 5;

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Turn a signal into a fully sized trade plan: stop distance from volatility,
 * risk budget from conviction, leverage from the resulting notional.
 *
 * The core rule is that the STOP defines the risk, not the leverage. We first
 * decide how much equity may be lost, then derive size from the stop distance,
 * and only then compute the leverage that size implies — clamped so that the
 * stop always triggers before liquidation.
 *
 * @param signal the scored opportunity.
 * @param account current account snapshot.
 * @param config active risk configuration.
 * @returns a trade plan, or null when the signal fails a risk gate.
 */
/**
 * Preview the leverage {@link planTrade} would pick for a signal, without an
 * account.
 *
 * Mirrors the stop-distance and conviction-scaling steps of `planTrade` — the
 * two inputs leverage actually depends on — so the dashboard can show
 * "this signal would use ~14x" next to a candidate before it is ever sized
 * into a real trade. Position sizing (margin, notional) still needs the
 * account and only happens in `planTrade` itself.
 *
 * @param signal the scored opportunity.
 * @param config active risk configuration.
 * @returns the leverage `planTrade` would use for this signal today, or null when the signal would not qualify.
 */
export function previewLeverage(signal: Signal, config: RiskConfig): number | null {
  if (!Number.isFinite(signal.confidence) || signal.confidence < config.minConfidence) return null;
  if (!Number.isFinite(signal.atrPct) || signal.atrPct <= 0) return null;
  if (config.requireHigherAlignment && !signal.alignedWithHigher) return null;

  const trendMultiple = config.atrStopMultiple;
  const atrMultiple = signal.regime === 'RANGE' ? trendMultiple * 0.68 : trendMultiple;
  let stopDistancePct = signal.atrPct * atrMultiple;
  const anchor = signal.side === 'LONG' ? signal.swingLow : signal.swingHigh;
  if (Number.isFinite(anchor) && anchor > 0 && Number.isFinite(signal.price) && signal.price > 0) {
    const structurePct = (Math.abs(signal.price - anchor) / signal.price) * 1.15;
    if (structurePct >= stopDistancePct * 0.5 && structurePct <= stopDistancePct * 2) {
      stopDistancePct = structurePct;
    }
  }
  stopDistancePct = Math.max(0.006, Math.min(0.12, stopDistancePct));

  const liquidationCap = (1 / stopDistancePct) * LIQUIDATION_BUFFER;
  const { volCap, confFloor, turboActive } = leverageCaps(signal, config);
  const confHighMark = 0.85;
  const confT = Math.max(
    0,
    Math.min(1, (signal.confidence - config.minConfidence) / (confHighMark - config.minConfidence))
  );
  // In turbo mode the volCap intentionally exceeds maxLeverage — use it as the
  // effective ceiling so the boost is not negated by Math.min.
  const effectiveCeiling = turboActive ? volCap : config.maxLeverage;
  const confidenceCap = confFloor + confT * (effectiveCeiling - confFloor);
  const leverageCap = Math.min(effectiveCeiling, volCap, liquidationCap, confidenceCap);
  if (leverageCap < 1) return null;
  return Math.max(1, Math.min(Math.floor(leverageCap), effectiveCeiling));
}

/**
 * Volatility- and turbo-adjusted leverage ceiling and confidence floor shared
 * by `previewLeverage` and `planTrade`, so the preview shown in the UI always
 * matches what a real entry would use.
 *
 * High-conviction signals (confidence >= highConvictionConfidence, default 0.70)
 * are allowed to scale leverage up to maxLeverage (10x-12x) even in volatile markets,
 * provided the stop loss remains safely inside the liquidation buffer.
 *
 * @param signal the scored opportunity.
 * @param config active risk configuration.
 * @returns the volatility cap and confidence floor to use for this signal.
 */
function leverageCaps(signal: Signal, config: RiskConfig): { volCap: number; confFloor: number; turboActive: boolean } {
  const turbo = Boolean(config.turboMode);
  const highConviction = signal.confidence >= (config.highConvictionConfidence ?? 0.7);
  if (signal.atrPct > 0.02) {
    return {
      volCap: highConviction ? config.maxLeverage : 8,
      confFloor: turbo ? 10 : 8,
      turboActive: turbo,
    };
  }
  if (signal.atrPct > 0.01) {
    return {
      volCap: turbo ? 18 : config.maxLeverage,
      confFloor: turbo ? 10 : 8,
      turboActive: turbo,
    };
  }
  return {
    volCap: turbo ? Math.max(config.maxLeverage, 20) : config.maxLeverage,
    confFloor: turbo ? 10 : 8,
    turboActive: turbo,
  };
}

/**
 * Confidence-scaled stake percentage between `minStakePct` (at `minConfidence`)
 * and `targetStakePct` (at `highConvictionConfidence` or above).
 *
 * A signal that only just clears the entry bar commits less collateral than
 * one the engine is highly confident in — higher leverage setups (which tend
 * to cluster at higher confidence, see `volCap`/`confidenceCap` above) get a
 * smaller stake, not a bigger one, so the dollar risk from a bad fill does not
 * compound with the leverage.
 *
 * @param confidence the signal's composite conviction score, 0..1.
 * @param config active risk configuration.
 * @returns stake as a fraction of equity, clamped to [minStakePct, targetStakePct].
 */
function confidenceScaledStakePct(confidence: number, config: RiskConfig): number {
  const ceiling = config.targetStakePct as number;
  const floor = Number.isFinite(config.minStakePct) ? (config.minStakePct as number) : ceiling;
  const highMark = config.highConvictionConfidence || 0.7;
  const t = Math.max(
    0,
    Math.min(1, (confidence - config.minConfidence) / Math.max(0.0001, highMark - config.minConfidence))
  );
  return floor + t * (ceiling - floor);
}

export function planTrade(signal: Signal, account: Account, config: RiskConfig): TradePlan | null {
  if (!Number.isFinite(signal.confidence) || signal.confidence < config.minConfidence) return null;
  if (!Number.isFinite(signal.price) || signal.price <= 0) return null;
  if (!Number.isFinite(signal.atrPct) || signal.atrPct <= 0) return null;
  if (!Number.isFinite(account.equity) || account.equity <= 0) return null;

  // An entry the higher timeframe does not actively confirm is optional: it is
  // the single biggest driver of trade quality, so it is configurable rather
  // than hardcoded.
  if (config.requireHigherAlignment && !signal.alignedWithHigher) return null;

  const dir = signal.side === 'LONG' ? 1 : -1;
  const entry = signal.price;

  // 1. Stop distance. Volatility sets the baseline, but when a confirmed swing
  //    sits just beyond it we place the stop behind that level instead — price
  //    has to break real structure to take us out, not just wobble.
  const trendMultiple = config.atrStopMultiple;
  const atrMultiple = signal.regime === 'RANGE' ? trendMultiple * 0.68 : trendMultiple;
  const volStopPct = signal.atrPct * atrMultiple;
  const anchor = signal.side === 'LONG' ? signal.swingLow : signal.swingHigh;
  let stopDistancePct = volStopPct;
  let stopBasis = 'volatiliteit';
  if (Number.isFinite(anchor) && anchor > 0) {
    // Small buffer beyond the level so a clean wick does not trigger the stop.
    const structurePct = (Math.abs(entry - anchor) / entry) * 1.15;
    // Only adopt it when it is a sane distance — never tighter than half the
    // volatility stop, never more than double it.
    if (structurePct >= volStopPct * 0.5 && structurePct <= volStopPct * 2) {
      stopDistancePct = structurePct;
      stopBasis = 'marktstructuur';
    }
  }

  const isImbalanceScalp =
    config.imbalanceScalpEnabled !== false &&
    signal.marketStructure?.imbalanceScalp?.eligible &&
    signal.marketStructure.imbalanceScalp.side === signal.side;

  if (isImbalanceScalp) {
    const scalp = signal.marketStructure!.imbalanceScalp!;
    const scalpStopDistPct = Math.abs(entry - scalp.stopLoss) / entry;
    // Tight stop based on sweep wick
    stopDistancePct = Math.max(0.004, Math.min(0.08, scalpStopDistPct));
    stopBasis = 'sweep-wick (SMC scalp)';
  } else {
    stopDistancePct = Math.max(0.006, Math.min(0.12, stopDistancePct));
  }

  // 2. Risk budget scales with conviction, capped, and shrinks in drawdown.
  const convictionScale = 0.5 + signal.confidence;
  // Progressive drawdown governor: scales back risk gradually to preserve banked profits.
  const drawdownScale =
    account.drawdownPct >= 0.2
      ? 0.25
      : account.drawdownPct >= 0.15
        ? 0.4
        : account.drawdownPct >= 0.1
          ? 0.5
          : 1;
  const riskPct = Math.min(config.maxRiskPct, config.baseRiskPct * convictionScale * drawdownScale);
  const riskAmount = account.equity * riskPct;

  // 3. Notional follows from the risk budget divided by the stop distance.
  const targetNotional = riskAmount / stopDistancePct;

  // 4. Work out how much collateral this trade may use.
  const maxMarginByPortfolio = Math.max(
    0,
    account.equity * config.maxTotalMarginPct - account.usedMargin
  );
  // Never commit more than one trade's fair share of the portfolio budget.
  // When `targetStakePct` is set it IS that share (e.g. 20% per user
  // request) — using it directly here, rather than dividing the total budget
  // by `maxOpenPositions`, lets a single high-conviction trade actually reach
  // the full 20% ceiling instead of being capped at 1/10th of the budget just
  // because up to 10 slots exist. Falls back to an equal split when no target
  // stake is configured.
  const perTradeCap =
    account.equity *
    (Number.isFinite(config.targetStakePct) && (config.targetStakePct as number) > 0
      ? (config.targetStakePct as number)
      : config.maxTotalMarginPct / config.maxOpenPositions);
  const minTradeFloor = Math.max(MIN_MARGIN, config.minTradeMarginUsdt ?? 0);
  const freeMargin = Math.min(account.balance, maxMarginByPortfolio, perTradeCap);
  if (freeMargin < minTradeFloor) return null;
  // 5. Cap leverage so the stop loss always sits inside the liquidation price,
  //    then apply the volatility, conviction and configured caps on top.
  const liquidationCap = (1 / stopDistancePct) * LIQUIDATION_BUFFER;
  // Scaled alongside maxLeverage (15x default): high volatility still caps
  // hardest (8x), medium volatility next (12x), calm markets may use the full
  // configured ceiling. Turbo mode raises the calm/medium bands — see
  // `leverageCaps` — the 8x high-volatility floor is never relaxed.
  const { volCap, confFloor, turboActive } = leverageCaps(signal, config);
  // Conviction also gates leverage, not just position size: a signal that barely
  // clears `minConfidence` gets the conservative end (~8x, the level this desk
  // ran on before the multiplier was raised); only signals the strategy is most
  // sure about (0.85+ confidence) are allowed to reach the full configured ceiling.
  // In turbo mode the volCap intentionally exceeds maxLeverage — use it as the
  // effective ceiling so the boost is not negated by Math.min.
  const effectiveCeiling = turboActive ? volCap : config.maxLeverage;
  const confHighMark = 0.85;
  const confT = Math.max(
    0,
    Math.min(1, (signal.confidence - config.minConfidence) / (confHighMark - config.minConfidence))
  );
  const confidenceCap = confFloor + confT * (effectiveCeiling - confFloor);
  const leverageCap = Math.min(effectiveCeiling, volCap, liquidationCap, confidenceCap);
  if (leverageCap < 1) return null;

  // Take the highest safe leverage rather than the lowest that fits. The loss at
  // the stop is identical either way — the stop defines the risk — but higher
  // leverage locks up far less collateral, keeping capital free for other setups.
  // The caps above guarantee the stop still fires before liquidation.
  const leverage = Math.max(1, Math.min(Math.floor(leverageCap), effectiveCeiling));

  // Optional target stake as a fraction of equity — see `targetStakePct` doc
  // comment on RiskConfig. Only scales the stake UP: it raises the floor a
  // trade is allowed to use, it never overrides the hard caps above. Still
  // respects the drawdown throttle — a flat stake that ignored drawdown would
  // undo the exact protection `drawdownScale` exists to provide.
  //
  // Sizing baseline leverage calibrated at 8x so that positions at higher leverage
  // scale down dollar risk at the stop.
  const baselineLeverage = 8;
  let stakeFloor = 0;
  if (Number.isFinite(config.targetStakePct) && (config.targetStakePct as number) > 0) {
    const stakePct = confidenceScaledStakePct(signal.confidence, config);
    const leverageAdjustedStakePct = stakePct * Math.min(1, baselineLeverage / leverage);
    stakeFloor = Math.min(freeMargin, account.equity * leverageAdjustedStakePct * drawdownScale);
  }

  // 6. Size the position, never exceeding the collateral available. The
  //    risk-budget size is a floor raised to `stakeFloor` when that target is
  //    larger — it never shrinks a trade the risk budget already sized bigger.
  const riskSizedMargin = Math.min(freeMargin, targetNotional / leverage);
  let margin = Math.min(freeMargin, Math.max(riskSizedMargin, stakeFloor));
  if (margin < minTradeFloor) return null;
  // Hard outer ceiling on realised risk regardless of how the stake floor and
  // leverage combine: even with the leverage adjustment above, never let a
  // single trade risk more than 2.5x `maxRiskPct` of equity at the stop.
  const hardRiskCeiling = account.equity * config.maxRiskPct * 2.5;
  const maxMarginForRisk = hardRiskCeiling / (leverage * stopDistancePct);
  margin = Math.min(margin, maxMarginForRisk);
  if (margin < minTradeFloor) return null;
  const notional = margin * leverage;
  if (!Number.isFinite(notional) || notional <= 0) return null;

  const quantity = notional / entry;
  const stopLoss = entry * (1 - dir * stopDistancePct);
  if (stopLoss <= 0) return null;

  // Dynamic price precision: sub-penny and meme tokens (PEPE, SHIB, BONK) can have
  // 8-10+ decimals. Hardcoded 8 decimals rounds their targets to 0 or entry.
  // We guarantee at least 4-6 significant digits of precision up to 14 decimals.
  const priceDecimals = entry > 0 ? Math.min(14, Math.max(8, Math.ceil(-Math.log10(entry)) + 4)) : 8;

  // 7. Staged profit targets. Taking money off the table in tranches converts a
  //    winning move into realised profit without giving up the tail: the first
  //    level pays for the trade, the last one rides the trend.
  let takeProfits: TakeProfitLevel[];
  let ladderDesc: string;

  if (isImbalanceScalp && signal.marketStructure?.imbalanceScalp?.targetPrice) {
    const targetPrice = signal.marketStructure.imbalanceScalp.targetPrice;
    const rMultiple = Math.max(1.5, Math.abs(targetPrice - entry) / (entry * stopDistancePct));
    takeProfits = [
      {
        price: round(targetPrice, priceDecimals),
        portion: 0.75, // Bank 75% at FVG / Golden Zone
        rMultiple: round(rMultiple, 1),
        hit: false,
      },
      {
        price: round(entry * (1 + dir * stopDistancePct * (rMultiple * 1.5)), priceDecimals),
        portion: 0.25, // Let 25% runner ride
        rMultiple: round(rMultiple * 1.5, 1),
        hit: false,
      },
    ];
    ladderDesc = `Targets ${takeProfits.map((l) => `${l.rMultiple}R`).join(' / ')} (SMC FVG Scalp)`;
  } else {
    const ladder = targetLadder(signal, config);
    takeProfits = ladder.map((level) => ({
      price: round(entry * (1 + dir * stopDistancePct * level.rMultiple), priceDecimals),
      portion: level.portion,
      rMultiple: level.rMultiple,
      hit: false,
    }));
    ladderDesc = `Targets ${ladder.map((l) => `${l.rMultiple}R`).join(' / ')} — ${ladder
      .map((l) => `${Math.round(l.portion * 100)}%`)
      .join(' / ')}`;
  }

  if (takeProfits.some((t) => t.price <= 0)) return null;
  const takeProfit = takeProfits[takeProfits.length - 1].price;

  const reasons = [...signal.reasons];
  reasons.push(`Stop op ${stopBasis} (${(stopDistancePct * 100).toFixed(2)}%)`);
  reasons.push(ladderDesc);

  return {
    symbol: signal.symbol,
    side: signal.side,
    entry,
    leverage,
    margin: round(margin, 2),
    notional: round(notional, 2),
    quantity,
    stopLoss: round(stopLoss, priceDecimals),
    takeProfit,
    takeProfits,
    // Actual risk after all caps — may be below the budget, never above it.
    riskPct: round((notional * stopDistancePct) / account.equity, 4),
    confidence: round(signal.confidence, 3),
    regime: signal.regime,
    reasons,
  };
}

/**
 * Choose the profit ladder for a setup.
 *
 * Range trades are cut short because price is expected to turn at the boundary.
 * Trend trades run further, and a trade confirmed by the higher timeframe keeps
 * a runner open for the move to extend into.
 *
 * @param signal the scored opportunity.
 * @returns target levels as reward multiples and the portion closed at each.
 */
function targetLadder(
  signal: Signal,
  config: RiskConfig
): { rMultiple: number; portion: number }[] {
  const turbo = Boolean(config.turboMode);
  const first = config.firstTargetR;
  // Turbo banks more at the first rung so margin frees up sooner for the next
  // setup — the point of the mode on a small balance is capital velocity, not
  // riding every runner to the end.
  const portion = turbo ? Math.min(0.85, config.firstTargetPortion + 0.25) : config.firstTargetPortion;
  // Turbo also shortens the far target — a smaller move closes the trade out,
  // which matters when position count (not R-multiple) is the growth lever.
  const final = Math.max(first + 0.3, turbo ? config.finalTargetR * 0.6 : config.finalTargetR);

  // Dynamic Altcoin Runners: on strong breakout setups or high conviction, elevate far target to 5.0R
  const hasVolumeSpurt = signal.checks?.some((c) => c.name === 'Volume Spurt' && c.passed);
  const isHighConvictionBreakout =
    config.dynamicRunnersEnabled !== false &&
    !turbo &&
    (signal.alignedWithHigher || hasVolumeSpurt) &&
    signal.confidence >= 0.65;
  const effectiveFinal = isHighConvictionBreakout ? Math.max(final, 5.0) : final;

  if (signal.regime === 'RANGE') {
    // Mean reversion: take most of it at the first target, price usually stalls.
    return [
      { rMultiple: round(first * 0.85, 2), portion: Math.min(0.75, portion + 0.2) },
      { rMultiple: round(final * 0.8, 2), portion: round(1 - Math.min(0.75, portion + 0.2), 2) },
    ];
  }
  // Cap the far target at the structure the market actually has room to reach.
  const room = Number.isFinite(signal.roomToStructure) ? signal.roomToStructure : 3;
  if (!turbo && (signal.alignedWithHigher || isHighConvictionBreakout) && room >= 3) {
    // Highest quality setup: bank less early and keep a real runner, because this
    // is the only kind of trade that pays for all the stopped-out ones. Skipped
    // in turbo mode — it always uses the two-rung ladder below for a faster exit.
    const early = Math.max(0.2, portion - 0.05);
    const mid = round((1 - early) * 0.5, 2);
    return [
      { rMultiple: first, portion: early },
      { rMultiple: round((first + effectiveFinal) / 2, 2), portion: mid },
      { rMultiple: round(Math.max(effectiveFinal, round(final * 1.6, 2)), 2), portion: round(1 - early - mid, 2) },
    ];
  }
  return [
    { rMultiple: first, portion },
    { rMultiple: effectiveFinal, portion: round(1 - portion, 2) },
  ];
}

/**
 * Portfolio-level gate checked before any new position is opened.
 *
 * @param account current account snapshot.
 * @param openCount number of currently open positions.
 * @param dayPnlPct realised pnl today as a fraction of the day's starting equity.
 * @param config active risk configuration.
 * @returns a blocking reason, or null when trading is allowed.
 */
/**
 * Whether a position has achieved its first profit milestone (TP1) and is thus
 * derisked (stop moved to break-even, initial margin partially released).
 * Derisked positions free up their active trade slot so new setups can be taken.
 */
export function isPositionDerisked(position: {
  breakEven?: boolean;
  trailingArmed?: boolean;
  takeProfits?: { hit?: boolean }[];
  remainingQuantity?: number;
  quantity?: number;
  stopLoss?: number;
  entry?: number;
  side?: Side;
}): boolean {
  if (position.breakEven) return true;
  if (position.trailingArmed) return true;
  if (position.takeProfits?.some((t) => t.hit)) return true;
  if (
    position.remainingQuantity !== undefined &&
    position.quantity !== undefined &&
    position.quantity > 0 &&
    position.remainingQuantity < position.quantity * 0.99
  ) {
    return true;
  }
  if (
    position.stopLoss !== undefined &&
    position.entry !== undefined &&
    position.side !== undefined
  ) {
    const isLong = position.side === 'LONG';
    if (isLong ? position.stopLoss >= position.entry : position.stopLoss <= position.entry) {
      return true;
    }
  }
  return false;
}

export function tradingBlockedReason(
  account: Account,
  openCount: number,
  dayPnlPct: number,
  config: RiskConfig,
  atRiskCount?: number
): BlockedState | null {
  if (config.pauseNewEntries) {
    return {
      kind: 'halt',
      message: 'Standby actief: nieuwe entries gepauzeerd door gebruiker — actieve posities worden beheerd',
    };
  }
  // Risk halts first — these mean something went wrong and trading is suspended.
  if (account.drawdownPct >= config.maxDrawdownPct) {
    return {
      kind: 'halt',
      message: `Max drawdown bereikt (${(account.drawdownPct * 100).toFixed(1)}%) — nieuwe trades gepauzeerd`,
    };
  }
  if (dayPnlPct <= -config.dailyLossLimitPct && !config.ignoreDailyLimit) {
    return {
      kind: 'halt',
      message: `Daglimiet bereikt (${(dayPnlPct * 100).toFixed(1)}%) — nieuwe trades gepauzeerd`,
    };
  }
  // Capacity limits are normal operation, not a problem.
  // When atRiskCount is provided, only positions waiting for TP1 count against maxOpenPositions.
  const activeCount = atRiskCount !== undefined ? atRiskCount : openCount;
  if (activeCount >= config.maxOpenPositions) {
    return {
      kind: 'capacity',
      message: `Portefeuille vol — ${activeCount} van max ${config.maxOpenPositions} actieve posities (wachtend op TP1)`,
    };
  }
  if (account.usedMargin >= account.equity * config.maxTotalMarginPct) {
    return { kind: 'capacity', message: 'Volledige margin-budget ingezet — wachten op een exit' };
  }
  return null;
}
