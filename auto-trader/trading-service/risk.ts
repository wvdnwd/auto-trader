import type {
  Account,
  BlockedState,
  BlockReasonCode,
  LeverageBreakdown,
  LeverageClass,
  RiskConfig,
  Side,
  Signal,
  StrategyType,
  TakeProfitLevel,
  TradePlan,
} from './types.js';
import { FEE } from './exits.js';

/**
 * Default MTF risk profile calibrated to:
 * - baseRiskPct: 0.005 (0.5% equity per trade)
 * - maxPortfolioHeat: 0.015 (1.5% max portfolio heat)
 * - maxCorrelatedRisk: 0.010 (1.0% max correlated group risk)
 * - maxOpenPositions: 3
 * - maxPositionsPerSymbol: 1
 * - minScore: 70 (Reversal minScore: 80)
 */
export const DEFAULT_RISK: RiskConfig = {
  baseRiskPct: 0.025,
  maxRiskPct: 0.035,
  maxLeverage: 20,
  minLeverage: 2,
  maxOpenPositions: 3,
  maxTotalMarginPct: 0.95,
  maxDrawdownPct: 0.25,
  dailyLossLimitPct: 0.035,
  minConfidence: 0.54,
  maxPositionHours: 36,
  maxStaleHours: 12,
  uncertaintyExitEnabled: true,
  profitLockingEnabled: true,
  climaxExitEnabled: true,
  microTiming15mEnabled: true,
  pullbackEntryEnabled: true,
  dynamicChandelierTrailing: true,
  atrStopMultiple: 1.8,
  trailArmR: 1.5,
  trailGiveback: 0.75,
  firstTargetR: 1.2,
  firstTargetPortion: 0.6,
  finalTargetR: 3.5,
  breakEvenAfterFirst: true,
  requireHigherAlignment: true,
  maxSameSidePositions: 2,
  maxPerGroup: 2,
  minStakePct: 0.20,
  targetStakePct: 0.28,
  highConvictionConfidence: 0.7,
  maxOverflowPositions: 0,
  minTradeMarginUsdt: 50,
  rsFilterEnabled: false,
  maxFundingRateLong: 0.0008,
  minFundingRateShort: -0.0008,
  reversal15mRequired: true,
  chopPauseStreak: 40,
  turboMode: false,
  trendFlipProtection: true,
  // Half the remaining size comes off on the first adverse regime flip — enough
  // to meaningfully cut risk while leaving a stake behind in case the flip is a
  // brief wobble rather than a real reversal. The remainder stays under the
  // normal stop/trailing/take-profit logic afterwards.
  trendFlipTrimPortion: 0.5,
  // Bitcoin Gatekeeper: blocks altcoin trades that fight Bitcoin's dominant trend.
  btcFilterEnabled: true,
  // Minimum minutes between consecutive entries to prevent trade clustering on spikes.
  entryCooldownMinutes: 15,
  // Minimum 24h quote volume (USDT) to trade a coin — protects against illiquid tokens.
  minQuoteVolume24h: 1_000_000,
  // Lock this many R beyond exact round-trip fees after TP1; exits clamp monotonically.
  breakEvenBufferR: 0.35,
  // Only open trades during permitted market sessions (false = 24/7 trading enabled).
  sessionFilterEnabled: false,
  // Sessions permitted to open trades when sessionFilterEnabled is true.
  allowedSessions: ['ASIA', 'LONDON', 'NEW_YORK'],
  // Smart Pyramiding: allow adding a 2nd tranche to winning, derisked positions on pullback.
  pyramidingEnabled: true,
  pyramidMinConfidence: 0.85,
  // Sniper Pullback: require price to be near EMA21 or inside Fib golden zone (true = gatekeeper active for all entries).
  pullbackFilterEnabled: true,
  // Override for the daily loss halt — reset to false at every daily rollover.
  ignoreDailyLimit: false,
  // Breakout Momentum Bypass: allow direct market entry on explosive volume surges (>= 1.8x volume)
  // without waiting for an extended pullback to EMA21, catching runners and outlier breakouts in play.
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
  // Early Profit Protection: move stop to break-even once +1.1R is touched.
  earlyBreakEvenR: 1.1,
  // BTC Chop Filter: pause altcoin entries when Bitcoin is in CHOP (sideways/directionless).
  btcChopFilterEnabled: false,
  // Standby Mode: pause opening new positions while continuing to manage existing positions.
  pauseNewEntries: false,
  // Market Structure Shift (MSS) protection: protect or exit open positions immediately on adverse structural break.
  mssProtectionEnabled: true,
  // Premium/Discount filter: block LONGs in Premium (>50%) and SHORTs in Discount (<50%) (opt-in).
  premiumDiscountFilterEnabled: false,
  // Imbalance / Golden Zone Scalps: allow high R:R scalps towards FVG / Fib 0.618 after sweeps.
  imbalanceScalpEnabled: true,
  // 5m Sniper Trigger: verify 5m micro-reversal (green candle / hammer wick) right before opening order.
  ltfSniper5mEnabled: true,
  // SMT Divergence Filter: detect institutional divergence vs Bitcoin.
  smtFilterEnabled: true,
  // Volume Profile & POC: compute Point of Control & Value Area.
  volumeProfileEnabled: true,
  pivotLeft: 4,
  pivotRight: 4,
  atrLength: 14,
  adxLength: 14,
  volumeMaLength: 20,
  zoneMergeAtr: 0.25,
  breakoutBufferAtr: 0.15,
  stopBufferAtr: 0.20,
  maxPortfolioHeat: 0.050,
  maxCorrelatedRisk: 0.030,
  maxPositionsPerSymbol: 1,
  minScore: 70,
  minReversalScore: 80,
  goldenZoneLow: 0.618,
  goldenZoneHigh: 0.650,
  minimumRrSwing: 2.0,
  minimumRrPullback: 1.5,
  minimumRrBreakout: 2.0,
  cooldownTpMinutes: 15,
  cooldownBeMinutes: 30,
  cooldownSlMinutes: 60,
  cooldownFakeoutMinutes: 120,
  newsTradingEnabled: true,
  newsCatalystBypassPullback: true,
  newsAdversePositionProtect: true,
  macroShieldEnabled: true,
};

/**
 * Correlation groups. Instruments inside a group move together closely enough
 * that holding several of them is one position, not several.
 */
const GROUPS: Record<string, RegExp> = {
  majors: /^(BTC|ETH)_/i,
  layer1: /^(SOL|AVAX|NEAR|ADA|DOT|SUI|APT|SEI|TIA|ATOM|INJ|TON|FTM|ALGO|HBAR|KAS|ICP)_/i,
  layer2: /^(ARB|OP|STRK|POL|MANTA|METIS|BOBA|ZKJ|ZK|SCROLL|BLAST)_/i,
  ai: /^(FET|RENDER|TAO|WLD|AGIX|OCEAN|ARKM|ASI|IO|ATH|AI16Z|AIXBT|VIRTUAL|AIOZ)_/i,
  defi: /^(UNI|AAVE|MKR|LDO|PENDLE|CRV|SNX|COMP|JUP|RAY|AERO|ENA|SUSHI|DYDX|HYPE|CAKE|ONDO|ETHFI|GMX)_/i,
  gaming: /^(AXS|SAND|MANA|IMX|GALA|ENJ|BEAM|RON|MAGIC|YGG|PIXEL|PYR|ILV|PRIME)_/i,
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

export type CoinCategory = 'MEME' | 'LOW_LEVERAGE' | 'AI_TECH' | 'LAYER1' | 'LAYER2' | 'DEFI' | 'GAMING' | 'MAJOR' | 'ALT';

export type CoinProfile = {
  category: CoinCategory;
  atrStopMultiple: number;
  firstTargetR: number;
  firstTargetPortion: number;
  finalTargetR: number;
  earlyBreakEvenR: number;
  maxLeverageCap: number;
  description: string;
};

/**
 * Intelligent asset-class risk and target profile.
 * Tailors stop proximity, take-profit rungs, and leverage according to empirical volatility behavior.
 */
export function getCoinProfile(symbol: string): CoinProfile {
  const norm = symbol.toUpperCase().replace(/-USDC$|-USDT$|_USDT$|_USDC$/i, '');

  // 1. Meme & Hyper-Volatiel (PEPE, DOGE, BONK, SHIB, WIF, etc.)
  if (/^(PEPE|1000PEPE|DOGE|SHIB|BONK|1000BONK|FLOKI|WIF|POPCAT|BOME|TURBO|PNUT|MOODENG|BRETT|MEW|GOAT|MOG|1000000MOG|FARTCOIN|PENGU|SPX|ACT|TRUMP)$/i.test(norm)) {
    return {
      category: 'MEME',
      atrStopMultiple: 1.8,
      firstTargetR: 1.2,
      firstTargetPortion: 0.60,
      finalTargetR: 3.5,
      earlyBreakEvenR: 1.1,
      maxLeverageCap: 5,
      description: 'Meme/Hyper-Volatiel: Snelle 60% winstbank op 1.2R, strakke stop achter wicks',
    };
  }

  // 2. Low-Leverage & Sharp-Wick Alts (DASH, ZEC, FIL, NEO, ETC, etc.)
  if (/^(DASH|ZEC|FIL|NEO|ETC|ZEN|BADGER|CANTO|BLZ)$/i.test(norm)) {
    return {
      category: 'LOW_LEVERAGE',
      atrStopMultiple: 1.8,
      firstTargetR: 1.2,
      firstTargetPortion: 0.60,
      finalTargetR: 2.5,
      earlyBreakEvenR: 1.1,
      maxLeverageCap: 5,
      description: 'Low-Leverage Alt: 5x max hefboom op Hyperliquid, snelle 60% bank op 1.2R, wicks filteren',
    };
  }

  // 3. AI / News Narrative Movers (WLD, TAO, FET, RENDER, ARKM, etc.)
  if (/^(WLD|TAO|FET|RENDER|AGIX|OCEAN|ARKM|ASI|IO|ATH|AI16Z|AIXBT|VIRTUAL|AIOZ)$/i.test(norm)) {
    return {
      category: 'AI_TECH',
      atrStopMultiple: 1.8,
      firstTargetR: 1.25,
      firstTargetPortion: 0.55,
      finalTargetR: 3.8,
      earlyBreakEvenR: 1.15,
      maxLeverageCap: 5,
      description: 'AI / Tech Mover: Snelle winstname op 1.25R, trailing runner tot 3.8R',
    };
  }

  // 4. Gaming / Metaverse (AXS, SAND, MANA, IMX, GALA, ENJ, BEAM, RON, MAGIC, YGG)
  if (/^(AXS|SAND|MANA|IMX|GALA|ENJ|BEAM|RON|MAGIC|YGG|PIXEL|PYR|ILV|PRIME)$/i.test(norm)) {
    return {
      category: 'GAMING',
      atrStopMultiple: 1.8,
      firstTargetR: 1.2,
      firstTargetPortion: 0.60,
      finalTargetR: 4.0,
      earlyBreakEvenR: 1.1,
      maxLeverageCap: 5,
      description: 'Gaming/Metaverse: Narratief-gestuurd, snelle 60% bank op 1.2R, runner tot 4R bij uitbraak',
    };
  }

  // 5. DeFi Blue-Chips (AAVE, UNI, CRV, MKR, SNX, JUP, PENDLE, GMX, DYDX, etc.)
  if (/^(AAVE|UNI|CRV|MKR|SNX|COMP|SUSHI|BAL|JUP|PENDLE|GMX|DYDX|ENA|ETHFI|LDO|ONDO|HYPE|CAKE|1INCH|BIFI|ALPACA|BADGER)$/i.test(norm)) {
    return {
      category: 'DEFI',
      atrStopMultiple: 2.0,
      firstTargetR: 1.25,
      firstTargetPortion: 0.55,
      finalTargetR: 4.0,
      earlyBreakEvenR: 1.2,
      maxLeverageCap: 10,
      description: 'DeFi Blue-Chip: 55% bank op 1.25R, 2.0 ATR stop voor liquiditeitspieken, runner tot 4R',
    };
  }

  // 6. Layer 2 / Scaling (ARB, OP, STRK, POL, MANTA, METIS)
  if (/^(ARB|OP|STRK|POL|MANTA|METIS|BOBA|ZKJ|ZK|SCROLL|BLAST)$/i.test(norm)) {
    return {
      category: 'LAYER2',
      atrStopMultiple: 2.0,
      firstTargetR: 1.3,
      firstTargetPortion: 0.50,
      finalTargetR: 4.0,
      earlyBreakEvenR: 1.2,
      maxLeverageCap: 10,
      description: 'Layer 2: ETH-gecorreleerd, 50% bank op 1.3R, runner tot 4R, 10x max leverage',
    };
  }

  // 7. High-Beta Layer 1 / Trend Runners (SUI, SOL, AVAX, NEAR, SEI, APT, TIA, etc.)
  if (/^(SUI|SOL|AVAX|NEAR|SEI|APT|TIA|INJ|TON|FTM|ALGO|HBAR|KAS|ICP|ADA|DOT|ATOM|XLM|XRP|BNB|LTC|BCH|ETC|AR)$/i.test(norm)) {
    return {
      category: 'LAYER1',
      atrStopMultiple: 2.0,
      firstTargetR: 1.3,
      firstTargetPortion: 0.50,
      finalTargetR: 4.5,
      earlyBreakEvenR: 1.2,
      maxLeverageCap: 15,
      description: 'Layer 1 Momentum: 50% bank op 1.3R, ruime runner tot 4.5R voor trendopvolging',
    };
  }

  // 8. Majors (BTC, ETH)
  if (/^(BTC|ETH)$/i.test(norm)) {
    return {
      category: 'MAJOR',
      atrStopMultiple: 2.2,
      firstTargetR: 1.5,
      firstTargetPortion: 0.50,
      finalTargetR: 3.5,
      earlyBreakEvenR: 1.2,
      maxLeverageCap: 25,
      description: 'Major: Hoge liquiditeit, standaard 1.5R/3.5R rungs en tot 20x hefboom',
    };
  }

  // 9. Standaard Altcoins (catch-all)
  return {
    category: 'ALT',
    atrStopMultiple: 1.8,
    firstTargetR: 1.25,
    firstTargetPortion: 0.55,
    finalTargetR: 3.5,
    earlyBreakEvenR: 1.2,
    maxLeverageCap: 10,
    description: 'Standaard Alt: Snelle 55% bank op 1.25R, strakke 1.8 ATR stop',
  };
}

/**
 * Safety buffer between the stop loss and the liquidation price. A position is
 * liquidated at roughly a `1 / leverage` adverse move, so the leverage must stay
 * low enough that the stop is always hit first.
 */
const LIQUIDATION_BUFFER = 0.7;

/** Smallest collateral worth committing to a single trade, in quote currency (Hyperliquid L1 min $25 USDC voor rendabele trades). */
const MIN_MARGIN = 25;

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

type StopGeometry = {
  stopLoss: number;
  stopDistancePct: number;
  stopBasis: string;
  isImbalanceScalp: boolean;
  scalpTargetPrice?: number;
};

function priceDecimalsFor(price: number): number {
  return Math.min(14, Math.max(8, Math.ceil(-Math.log10(price)) + 4));
}

/** Resolve and validate the exact rounded protective stop shared by plan and preview. */
function stopGeometry(signal: Signal, config: RiskConfig): StopGeometry | null {
  if (
    (signal.side !== 'LONG' && signal.side !== 'SHORT') ||
    !Number.isFinite(signal.price) || signal.price <= 0 ||
    !Number.isFinite(signal.atrPct) || signal.atrPct <= 0 ||
    !Number.isFinite(config.atrStopMultiple) || config.atrStopMultiple <= 0
  ) return null;

  const dir = signal.side === 'LONG' ? 1 : -1;
  const entry = signal.price;
  const profile = getCoinProfile(signal.symbol);
  const trendMultiple =
    config.atrStopMultiple && config.atrStopMultiple !== 3 && config.atrStopMultiple !== 1.8
      ? config.atrStopMultiple
      : profile.atrStopMultiple;
  const atrMultiple = signal.regime === 'RANGE' ? trendMultiple * 0.68 : trendMultiple;
  const volStopPct = signal.atrPct * atrMultiple;
  if (!Number.isFinite(volStopPct) || volStopPct <= 0) return null;

  let stopDistancePct = volStopPct;
  let stopBasis = 'volatiliteit';
  const anchor = signal.side === 'LONG' ? signal.swingLow : signal.swingHigh;
  const anchorIsProtective = Number.isFinite(anchor) && anchor > 0 && dir * (entry - anchor) > 0;
  if (anchorIsProtective) {
    // Structure stop placed behind the swing high/low with a tight buffer (+0.25% - 4% of distance)
    const rawDistPct = (dir * (entry - anchor)) / entry;
    const structurePct = Math.max(rawDistPct + 0.0025, rawDistPct * 1.04);
    if (structurePct >= 0.006 && structurePct <= volStopPct * 1.5) {
      stopDistancePct = structurePct;
      stopBasis = 'marktstructuur';
    }
  }

  const scalp = signal.marketStructure?.imbalanceScalp;
  const isImbalanceScalp =
    config.imbalanceScalpEnabled !== false && Boolean(scalp?.eligible) && scalp?.side === signal.side;
  let scalpTargetPrice: number | undefined;
  if (isImbalanceScalp) {
    // An eligible scalp is rejected unless both its stop and target are on the protective/profit side.
    if (
      !scalp || !Number.isFinite(scalp.stopLoss) || scalp.stopLoss <= 0 ||
      dir * (entry - scalp.stopLoss) <= 0 ||
      !Number.isFinite(scalp.targetPrice) || scalp.targetPrice <= 0 ||
      dir * (scalp.targetPrice - entry) <= 0
    ) return null;
    stopDistancePct = Math.max(0.004, Math.min(0.08, (dir * (entry - scalp.stopLoss)) / entry));
    stopBasis = 'sweep-wick (SMC scalp)';
    scalpTargetPrice = round(scalp.targetPrice, priceDecimalsFor(entry));
    if (!Number.isFinite(scalpTargetPrice) || scalpTargetPrice <= 0 || dir * (scalpTargetPrice - entry) <= 0) {
      return null;
    }
  } else {
    stopDistancePct = Math.max(0.006, Math.min(0.12, stopDistancePct));
  }
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0) return null;

  const priceDecimals = priceDecimalsFor(entry);
  const stopLoss = round(entry * (1 - dir * stopDistancePct), priceDecimals);
  if (!Number.isFinite(stopLoss) || stopLoss <= 0 || dir * (entry - stopLoss) <= 0) return null;
  const actualStopDistancePct = (dir * (entry - stopLoss)) / entry;
  if (!Number.isFinite(actualStopDistancePct) || actualStopDistancePct <= 0) return null;
  return { stopLoss, stopDistancePct: actualStopDistancePct, stopBasis, isImbalanceScalp, scalpTargetPrice };
}

/**
 * Asset leverage tiering:
 * - BTC / ETH: max 25x, default 20x
 * - Major Alts: max 15x, default 12x
 * - Small / Meme Alts: max 10x, default 8x
 */
/**
 * Exact maximum leverage tiers enforced on Hyperliquid L1.
 * Hyperliquid enforces much stricter leverage caps than centralized exchanges (e.g. DASH is max 5x).
 */
export const HYPERLIQUID_MAX_LEVERAGE: Record<string, number> = {
  // 40x
  BTC: 40,
  // 25x
  ETH: 25,
  // 20x
  SOL: 20,
  XRP: 20,
  // 10x
  DOGE: 10,
  SUI: 10,
  NEAR: 10,
  ARB: 10,
  AVAX: 10,
  LINK: 10,
  ADA: 10,
  UNI: 10,
  APT: 10,
  DOT: 10,
  LTC: 10,
  HYPE: 10,
  FARTCOIN: 10,
  BONK: 10,
  KBONK: 10,
  '1000BONK': 10,
  PEPE: 10,
  KPEPE: 10,
  '1000PEPE': 10,
  SHIB: 10,
  KSHIB: 10,
  AAVE: 10,
  BCH: 10,
  MKR: 10,
  WLD: 10,
  TRX: 10,
  TON: 10,
  CRV: 10,
  ENA: 10,
  ONDO: 10,
  ZEC: 10,
  BNB: 10,
  FTM: 10,
  JUP: 10,
  STRAX: 10,
  PAXG: 10,
  TRUMP: 10,
  PUMP: 10,
  XPL: 10,
  // 5x
  DASH: 5,
  TAO: 5,
  TIA: 5,
  INJ: 5,
  FET: 5,
  RENDER: 5,
  WIF: 5,
  PENGU: 5,
  OP: 5,
  SEI: 5,
  RUNE: 5,
  SPX: 5,
  POL: 5,
  ICP: 5,
  STRK: 5,
  AR: 5,
  ETHFI: 5,
  HBAR: 5,
  XLM: 5,
  ALGO: 5,
  ATOM: 5,
  DYDX: 5,
  APE: 5,
  LDO: 5,
  STX: 5,
  CFX: 5,
  COMP: 5,
  FXS: 5,
  ZRO: 5,
  BLZ: 5,
  RDNT: 5,
  CANTO: 5,
  PENDLE: 5,
  BADGER: 5,
  NEO: 5,
  ZEN: 5,
  FIL: 5,
  PYTH: 5,
  IMX: 5,
  JTO: 5,
  ENS: 5,
  ETC: 5,
  W: 5,
  MNT: 5,
  EIGEN: 5,
  ZK: 5,
  BLAST: 5,
  NEIROETH: 5,
  SAND: 5,
  VIRTUAL: 5,
  AI16Z: 5,
  BERA: 5,
  KAITO: 5,
  WLFI: 5,
  ASTER: 5,
  AVNT: 5,
  MON: 5,
  LIT: 5,
  XMR: 5,
  AXS: 5,
  GRAM: 5,
  KFLOKI: 5,
  // 3x (High volatility meme coins)
  MOODENG: 3,
  PNUT: 3,
  GOAT: 3,
  TURBO: 3,
  BRETT: 3,
  MEW: 3,
  BOME: 3,
  POPCAT: 3,
  PURR: 3,
  GRASS: 3,
  SAGA: 3,
  NOT: 3,
  GMX: 3,
  SNX: 3,
  KAS: 3,
  BLUR: 3,
  MEME: 3,
  ORDI: 3,
  SUSHI: 3,
  GALA: 3,
  CHILLGUY: 3,
  AIXBT: 3,
  ZEREBRO: 3,
  BIO: 3,
  GRIFFAIN: 3,
  ANIME: 3,
  VINE: 3,
  VVV: 3,
  JELLY: 3,
  IP: 3,
  OM: 3,
  AERO: 3,
  SKR: 3,
  AZTEC: 3,
  CHIP: 3,
  PONS: 3,
  USELESS: 3,
  '1000000MOG': 3,
  MOG: 3,
};

export function classifyLeverage(
  symbol: string,
  exchangeMaxLeverage?: number
): {
  leverageClass: LeverageClass;
  defaultLeverage: number;
  maxLeverage: number;
} {
  const norm = symbol.toUpperCase().replace(/-USDC$|-USDT$|_USDT$|_USDC$/i, '');
  const venueCap = exchangeMaxLeverage ?? HYPERLIQUID_MAX_LEVERAGE[norm];

  if (norm === 'BTC' || norm === 'ETH') {
    const max = venueCap ? Math.min(venueCap, norm === 'BTC' ? 40 : 25) : 25;
    return { leverageClass: 'BTC_ETH', defaultLeverage: Math.min(20, max), maxLeverage: max };
  }

  // If venue strictly limits this coin to 3x or 5x (e.g. DASH is 5x, PNUT is 3x)
  if (venueCap && venueCap <= 5) {
    return {
      leverageClass: 'SMALL_ALT',
      defaultLeverage: venueCap,
      maxLeverage: venueCap,
    };
  }

  const majors = [
    'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'NEAR', 'SUI', 'APT', 'TIA', 'INJ',
    'FET', 'RENDER', 'TAO', 'AAVE', 'UNI', 'LTC', 'BCH', 'ICP', 'TON', 'TRX', 'MATIC', 'POL'
  ];
  const isMajor = majors.includes(norm);
  if (isMajor) {
    const max = venueCap ? Math.min(venueCap, 15) : 15;
    return { leverageClass: 'MAJOR_ALT', defaultLeverage: Math.min(12, max), maxLeverage: max };
  }

  const max = venueCap ? Math.min(venueCap, 10) : 10;
  return { leverageClass: 'SMALL_ALT', defaultLeverage: Math.min(8, max), maxLeverage: max };
}

/**
 * Liquidation price calculation taking standard maintenance margin into account.
 */
export function computeLiquidationPrice(entry: number, side: Side, leverage: number): number {
  const mmr = 0.005; // Standard maintenance margin rate
  if (side === 'LONG') {
    return Math.max(0, entry * (1 - 1 / leverage + mmr));
  } else {
    return entry * (1 + 1 / leverage - mmr);
  }
}

/**
 * Personalized leverage breakdown and liquidation safety metrics.
 * Auto-steps down leverage tier if liquidation buffer is too tight (< required R).
 */
export function computeLeverageBreakdown(
  symbol: string,
  side: Side,
  entry: number,
  stopLoss: number,
  strategy: StrategyType = 'SWING',
  maxConfigLeverage = 20,
  turboMode = false,
  exchangeMaxLeverage?: number
): LeverageBreakdown | null {
  const { leverageClass, defaultLeverage, maxLeverage } = classifyLeverage(symbol, exchangeMaxLeverage);
  const stopDistance = Math.abs(entry - stopLoss);
  if (stopDistance <= 0 || !Number.isFinite(entry) || entry <= 0) return null;

  const effectiveMax = turboMode
    ? Math.max(maxLeverage, maxConfigLeverage)
    : Math.min(maxLeverage, maxConfigLeverage);
  let targetLeverage = turboMode ? effectiveMax : Math.min(defaultLeverage, effectiveMax);
  if (strategy === 'BREAKOUT' && !turboMode) {
    if (targetLeverage >= 20) targetLeverage = 15;
    else if (targetLeverage >= 12) targetLeverage = 10;
    else if (targetLeverage >= 8) targetLeverage = 6;
    else if (targetLeverage >= 5) targetLeverage = 4;
    else targetLeverage = 3;
  }

  const candidateTiers = [40, 25, 22, 20, 18, 16, 15, 14, 12, 10, 8, 6, 5, 4, 3, 2];
  const validTiers = candidateTiers.filter((t) => t <= targetLeverage);

  let selectedLeverage = validTiers[validTiers.length - 1] ?? 2;
  let liquidationPrice = computeLiquidationPrice(entry, side, selectedLeverage);
  let liquidationBufferR = Math.abs(entry - liquidationPrice) / stopDistance;
  let requiredBufferR = 2.0;
  let steppedDown = false;

  for (const tier of validTiers) {
    const liq = computeLiquidationPrice(entry, side, tier);
    const bufR = Math.abs(entry - liq) / stopDistance;
    const reqR = turboMode ? 1.8 : tier >= 20 ? 2.5 : tier >= 12 ? 2.2 : 2.0;
    if (bufR >= reqR) {
      selectedLeverage = tier;
      liquidationPrice = liq;
      liquidationBufferR = bufR;
      requiredBufferR = reqR;
      steppedDown = tier < targetLeverage;
      break;
    }
  }

  return {
    leverageClass,
    defaultLeverage,
    maxLeverage: effectiveMax,
    selectedLeverage,
    liquidationPrice,
    liquidationBufferR,
    requiredBufferR,
    steppedDown,
  };
}

function leverageForStop(signal: Signal, config: RiskConfig, stopDistancePct: number, exchangeMaxLeverage?: number): number | null {
  const geometry = stopGeometry(signal, config);
  if (!geometry) return null;
  const caps = leverageCaps(signal, config);
  const effectiveLev = caps.turboActive ? caps.volCap : config.maxLeverage;
  const breakdown = computeLeverageBreakdown(
    signal.symbol,
    signal.side,
    signal.price,
    geometry.stopLoss,
    signal.strategyType ?? 'SWING',
    effectiveLev,
    caps.turboActive,
    exchangeMaxLeverage
  );
  if (!breakdown || breakdown.liquidationBufferR < 1.8) return null;
  return breakdown.selectedLeverage;
}

/**
 * Preview the leverage {@link planTrade} would pick for a signal, without an
 * account.
 */
export function previewLeverage(signal: Signal, config: RiskConfig, exchangeMaxLeverage?: number): number | null {
  if (
    !Number.isFinite(signal.confidence) ||
    signal.confidence < config.minConfidence ||
    signal.confidence > 1 ||
    !Number.isFinite(config.minConfidence) ||
    !Number.isFinite(config.maxLeverage) ||
    config.maxLeverage < 1
  ) {
    return null;
  }
  if (config.requireHigherAlignment && !signal.alignedWithHigher) return null;
  const geometry = stopGeometry(signal, config);
  if (!geometry) return null;

  const caps = leverageCaps(signal, config);
  const effectiveLev = caps.turboActive ? caps.volCap : config.maxLeverage;
  const breakdown = computeLeverageBreakdown(
    signal.symbol,
    signal.side,
    signal.price,
    geometry.stopLoss,
    signal.strategyType ?? 'SWING',
    effectiveLev,
    caps.turboActive,
    exchangeMaxLeverage
  );
  if (!breakdown || breakdown.liquidationBufferR < 1.8) return null;
  signal.leverageBreakdown = breakdown;
  return breakdown.selectedLeverage;
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
  const safeFloor = turbo ? Math.min(config.maxLeverage, 10) : Math.min(config.maxLeverage, 8);
  if (signal.atrPct > 0.02) {
    return {
      volCap: highConviction ? config.maxLeverage : Math.min(config.maxLeverage, 10),
      confFloor: safeFloor,
      turboActive: turbo,
    };
  }
  if (signal.atrPct > 0.01) {
    return {
      volCap: turbo ? Math.max(config.maxLeverage + 5, 25) : config.maxLeverage,
      confFloor: safeFloor,
      turboActive: turbo,
    };
  }
  return {
    volCap: turbo ? Math.max(config.maxLeverage + 5, 25) : config.maxLeverage,
    confFloor: safeFloor,
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

/**
 * Turn a signal into a fully sized trade plan, sizing against its rounded stop.
 *
 * @param signal the scored opportunity.
 * @param account current account snapshot.
 * @param config active risk configuration.
 * @param feeRate per-side taker fee used for entry and stop-exit risk (defaults to {@link FEE}).
 * @returns a trade plan, or null when the signal fails a risk gate.
 */
export function planTrade(
  signal: Signal,
  account: Account,
  config: RiskConfig,
  feeRate = FEE,
  exchangeMaxLeverage?: number
): TradePlan | null {
  if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) return null;
  if (!Number.isFinite(signal.price) || signal.price <= 0) return null;
  if (!Number.isFinite(signal.atrPct) || signal.atrPct <= 0) return null;
  if (
    !Number.isFinite(account.equity) || account.equity <= 0 ||
    !Number.isFinite(account.balance) || account.balance <= 0 ||
    !Number.isFinite(account.usedMargin) || account.usedMargin < 0 ||
    !Number.isFinite(account.drawdownPct) ||
    !Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1 ||
    !Number.isFinite(config.baseRiskPct) || config.baseRiskPct <= 0 ||
    !Number.isFinite(config.maxRiskPct) || config.maxRiskPct <= 0 ||
    !Number.isFinite(config.atrStopMultiple) || config.atrStopMultiple <= 0 ||
    !Number.isFinite(config.maxTotalMarginPct) || config.maxTotalMarginPct <= 0 ||
    !Number.isFinite(config.maxOpenPositions) || config.maxOpenPositions <= 0 ||
    !Number.isFinite(config.maxLeverage) || config.maxLeverage < 1 ||
    !Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1 ||
    (config.minTradeMarginUsdt !== undefined &&
      (!Number.isFinite(config.minTradeMarginUsdt) || config.minTradeMarginUsdt < 0))
  ) return null;
  if (config.targetStakePct !== undefined && (!Number.isFinite(config.targetStakePct) || config.targetStakePct < 0)) return null;
  if (config.minStakePct !== undefined && (!Number.isFinite(config.minStakePct) || config.minStakePct < 0)) return null;
  if (config.targetStakePct && config.minStakePct !== undefined && config.minStakePct > config.targetStakePct) return null;
  if (signal.confidence < config.minConfidence) return null;

  // An entry the higher timeframe does not actively confirm is optional: it is
  // the single biggest driver of trade quality, so it is configurable rather
  // than hardcoded.
  if (config.requireHigherAlignment && !signal.alignedWithHigher) return null;

  const dir = signal.side === 'LONG' ? 1 : -1;
  const entry = signal.price;
  const geometry = stopGeometry(signal, config);
  if (!geometry) return null;
  const { stopLoss, stopBasis, isImbalanceScalp, scalpTargetPrice } = geometry;
  const stopDistancePct = geometry.stopDistancePct;
  const priceDecimals = priceDecimalsFor(entry);
  const lossFractionAtStop = stopDistancePct + feeRate * (entry + stopLoss) / entry;
  if (!Number.isFinite(lossFractionAtStop) || lossFractionAtStop <= 0) return null;

  // 1. Personalized Leverage and Liquidation Buffer Step-Down
  const caps = leverageCaps(signal, config);
  const effectiveLev = caps.turboActive ? caps.volCap : config.maxLeverage;
  const breakdown = computeLeverageBreakdown(
    signal.symbol,
    signal.side,
    entry,
    stopLoss,
    signal.strategyType ?? 'SWING',
    effectiveLev,
    caps.turboActive,
    exchangeMaxLeverage
  );
  if (!breakdown || breakdown.liquidationBufferR < 1.8) return null;
  const leverage = breakdown.selectedLeverage;

  // 2. Risk budget with dynamic MTF multipliers
  const scoreMultiplier = signal.setupScore
    ? signal.setupScore.multiplier
    : signal.confidence >= 0.8
      ? 1.0
      : signal.confidence >= 0.7
        ? 0.75
        : 0.5;
  const strategyMultiplier =
    signal.strategyType === 'PULLBACK' ? 1.0 : signal.strategyType === 'REVERSAL' ? 0.5 : 0.75;
  const volMultiplier = signal.atrPct > 0.03 ? 0.75 : 1.0;
  const regimeMultiplier = signal.regime === 'CHOP' ? 0.7 : 1.0;

  // Progressive drawdown governor: scales back risk gradually to preserve banked profits.
  const drawdownScale =
    account.drawdownPct >= 0.2
      ? 0.25
      : account.drawdownPct >= 0.15
        ? 0.4
        : account.drawdownPct >= 0.1
          ? 0.5
          : 1;

  const riskPct = Math.min(
    config.maxRiskPct,
    config.baseRiskPct *
      scoreMultiplier *
      strategyMultiplier *
      volMultiplier *
      regimeMultiplier *
      drawdownScale
  );
  const riskAmount = account.equity * riskPct;
  if (!Number.isFinite(riskAmount) || riskAmount <= 0) return null;

  // 3. Include the entry and stop-exit fees in the trade's fixed risk budget.
  const maxNotionalForRisk = riskAmount / lossFractionAtStop;
  if (!Number.isFinite(maxNotionalForRisk) || maxNotionalForRisk <= 0) return null;

  // 4. Work out how much collateral this trade may use.
  const maxMarginByPortfolio = Math.max(
    0,
    account.equity * config.maxTotalMarginPct - account.usedMargin
  );
  if (!Number.isFinite(maxMarginByPortfolio)) return null;
  // Never commit more than one trade's fair share of the portfolio budget.
  const perTradeCap =
    account.equity *
    (Number.isFinite(config.targetStakePct) && (config.targetStakePct as number) > 0
      ? (config.targetStakePct as number)
      : config.maxTotalMarginPct / config.maxOpenPositions);
  if (!Number.isFinite(perTradeCap) || perTradeCap <= 0) return null;
  const minTradeFloor = Math.max(MIN_MARGIN, config.minTradeMarginUsdt ?? 0);
  const freeMargin = Math.min(account.balance, maxMarginByPortfolio, perTradeCap);
  if (!Number.isFinite(freeMargin) || freeMargin < minTradeFloor) return null;

  // Baseline leverage sizing
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
  const riskSizedMargin = Math.min(freeMargin, maxNotionalForRisk / leverage);
  let margin = Math.min(freeMargin, Math.max(riskSizedMargin, stakeFloor));
  if (margin < minTradeFloor) return null;
  // This final cap also constrains the target-stake floor. Floor, rather than
  // round, so cent precision can never move margin above the risk allowance.
  margin = floorTo(Math.min(margin, maxNotionalForRisk / leverage), 2);
  if (margin < minTradeFloor) return null;
  const notional = floorTo(Math.min(margin * leverage, maxNotionalForRisk), 2);
  if (!Number.isFinite(notional) || notional < 10) return null;

  const quantity = notional / entry;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  // Dynamic price precision: sub-penny and meme tokens (PEPE, SHIB, BONK) can have
  // 8-10+ decimals. Hardcoded 8 decimals rounds their targets to 0 or entry.
  // We guarantee at least 4-6 significant digits of precision up to 14 decimals.
  // 7. Staged profit targets. Taking money off the table in tranches converts a
  //    winning move into realised profit without giving up the tail: the first
  //    level pays for the trade, the last one rides the trend.
  let takeProfits: TakeProfitLevel[];
  let ladderDesc: string;

  if (isImbalanceScalp && scalpTargetPrice !== undefined) {
    const targetPrice = scalpTargetPrice;
    const rMultiple = (dir * (targetPrice - entry)) / (entry * stopDistancePct);
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

  if (
    takeProfits.length === 0 ||
    takeProfits.some((t) =>
      !Number.isFinite(t.price) || t.price <= 0 ||
      !Number.isFinite(t.portion) || t.portion <= 0 ||
      !Number.isFinite(t.rMultiple) || t.rMultiple <= 0 ||
      (dir === 1 ? t.price <= entry : t.price >= entry)
    )
  ) return null;
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
    riskPct: floorTo((notional * lossFractionAtStop) / account.equity, 6),
    confidence: round(signal.confidence, 3),
    regime: signal.regime,
    reasons,
    strategyType: signal.strategyType,
    setupScore: signal.setupScore,
    leverageBreakdown: breakdown,
  };
}

/**
 * Choose the profit ladder for a setup according to strategy type or regime.
 *
 * @param signal the scored opportunity.
 * @returns target levels as reward multiples and the portion closed at each.
 */
function targetLadder(
  signal: Signal,
  config: RiskConfig
): { rMultiple: number; portion: number }[] {
  const profile = getCoinProfile(signal.symbol);
  const first = (config.firstTargetR && config.firstTargetR !== 1.5 && config.firstTargetR !== 1.2)
    ? config.firstTargetR
    : profile.firstTargetR;
  const portion = (config.firstTargetPortion && config.firstTargetPortion !== 0.5 && config.firstTargetPortion !== 0.6)
    ? config.firstTargetPortion
    : profile.firstTargetPortion;
  const final = (config.finalTargetR && config.finalTargetR !== 3.6 && config.finalTargetR !== 3.5)
    ? config.finalTargetR
    : profile.finalTargetR;

  const rem = round(1 - portion, 2);
  const halfRem = round(rem * 0.5, 2);
  const otherRem = round(rem - halfRem, 2);

  if (signal.strategyType === 'SWING') {
    const midR = round(first + (final - first) * 0.45, 1);
    return [
      { rMultiple: first, portion },
      { rMultiple: midR, portion: halfRem },
      { rMultiple: final, portion: otherRem },
    ];
  }
  if (signal.strategyType === 'PULLBACK') {
    return [
      { rMultiple: first, portion },
      { rMultiple: final, portion: rem },
    ];
  }
  if (signal.strategyType === 'BREAKOUT') {
    return [
      { rMultiple: Math.max(first, 1.2), portion },
      { rMultiple: final, portion: rem },
    ];
  }
  if (signal.strategyType === 'REVERSAL') {
    return [
      { rMultiple: first, portion },
      { rMultiple: final, portion: rem },
    ];
  }

  const turbo = Boolean(config.turboMode);
  // Turbo banks more at the first rung so margin frees up sooner for the next
  // setup — the point of the mode on a small balance is capital velocity, not
  // riding every runner to the end.
  const turboPortion = turbo ? Math.min(0.85, portion + 0.25) : portion;
  // Turbo also shortens the far target — a smaller move closes the trade out,
  // which matters when position count (not R-multiple) is the growth lever.
  const turboFinal = Math.max(first + 0.3, turbo ? final * 0.6 : final);

  // Dynamic Altcoin Runners: on strong breakout setups or high conviction, elevate far target to 5.0R
  const hasVolumeSpurt = signal.checks?.some((c) => c.name === 'Volume Spurt' && c.passed);
  const isHighConvictionBreakout =
    config.dynamicRunnersEnabled !== false &&
    !turbo &&
    (signal.alignedWithHigher || hasVolumeSpurt) &&
    signal.confidence >= 0.65;
  const effectiveFinal = isHighConvictionBreakout ? Math.max(turboFinal, 5.0) : turboFinal;

  if (signal.regime === 'RANGE') {
    // Mean reversion: take most of it at the first target, price usually stalls.
    return [
      { rMultiple: round(first * 0.85, 2), portion: Math.min(0.75, turboPortion + 0.2) },
      { rMultiple: round(turboFinal * 0.8, 2), portion: round(1 - Math.min(0.75, turboPortion + 0.2), 2) },
    ];
  }
  // Cap the far target at the structure the market actually has room to reach.
  const room = Number.isFinite(signal.roomToStructure) ? signal.roomToStructure : 3;
  if (!turbo && (signal.alignedWithHigher || isHighConvictionBreakout) && room >= 3) {
    // Highest quality setup: bank less early and keep a real runner, because this
    // is the only kind of trade that pays for all the stopped-out ones. Skipped
    // in turbo mode — it always uses the two-rung ladder below for a faster exit.
    const early = Math.max(0.2, turboPortion - 0.05);
    const mid = round((1 - early) * 0.5, 2);
    return [
      { rMultiple: first, portion: early },
      { rMultiple: round((first + effectiveFinal) / 2, 2), portion: mid },
      { rMultiple: round(Math.max(effectiveFinal, round(turboFinal * 1.6, 2)), 2), portion: round(1 - early - mid, 2) },
    ];
  }
  return [
    { rMultiple: first, portion: turboPortion },
    { rMultiple: effectiveFinal, portion: round(1 - turboPortion, 2) },
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
 * Whether the remaining position is protected from a net loss at its stop.
 * TP, break-even, and trailing flags alone do not release an active trade slot.
 * @param feeRate per-side taker fee used for exact break-even coverage (defaults to {@link FEE}).
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
}, feeRate = FEE): boolean {
  if (
    (position.side !== 'LONG' && position.side !== 'SHORT') ||
    !Number.isFinite(position.stopLoss) || position.stopLoss! <= 0 ||
    !Number.isFinite(position.entry) || position.entry! <= 0 ||
    !Number.isFinite(position.quantity) || position.quantity! <= 0 ||
    !Number.isFinite(position.remainingQuantity) || position.remainingQuantity! <= 0 ||
    position.remainingQuantity! > position.quantity! ||
    !Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1
  ) {
    return false;
  }
  const isLong = position.side === 'LONG';
  const feeCoveredStop = position.entry! * (isLong ? (1 + feeRate) / (1 - feeRate) : (1 - feeRate) / (1 + feeRate));
  return isLong ? position.stopLoss! >= feeCoveredStop : position.stopLoss! <= feeCoveredStop;
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
