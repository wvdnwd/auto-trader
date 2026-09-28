import type {
  CoinDNA,
  ClusterRiskEvaluation,
  FactorStat,
  MfeMaeStats,
  SessionStat,
  SignalCheck,
  Side,
} from './types.js';

function round(val: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

/** Known entry factors tracked by post-mortem and candidate ranking. */
export const KNOWN_ENTRY_FACTORS = [
  'Volume Spurt (Coin in Play)',
  'Fibonacci Golden Zone',
  'Sniper Pullback',
  'RSI Divergentie',
  'Asian Session Sweep',
  '15m Ommekeer-bevestiging',
  'Smart Pyramiding (2e tranche)',
] as const;

export type KnownEntryFactor = (typeof KNOWN_ENTRY_FACTORS)[number];

// ============================================================================
// 1. ADAPTIVE FACTOR WEIGHTING (DYNAMIC EDGE LEARNING)
// ============================================================================

/**
 * Compute the dynamic weight multiplier for a technical factor based on historical performance.
 *
 * - Minimum 3 completed trades required before deviation from neutral 1.0x.
 * - Factors with high win-rate (>60%) and positive net R are boosted up to 1.30x (+30%).
 * - Factors with low win-rate (<40%) or negative expectancy are penalized down to 0.70x (-30%).
 */
export function computeFactorWeight(stat: FactorStat): number {
  const total = stat.wins + stat.losses;
  if (total < 3) return 1.0;

  const winRate = stat.wins / total;
  const avgR = stat.netR / total;

  // Base formula: 1.0 + (winRate - 0.5) * 0.4 + clamp(avgR * 0.1, -0.2, 0.2)
  const rawWeight = 1.0 + (winRate - 0.5) * 0.4 + Math.max(-0.2, Math.min(0.2, avgR * 0.1));
  return Math.round(Math.max(0.7, Math.min(1.3, rawWeight)) * 100) / 100;
}

/**
 * Match a signal check or reason to a known factor name.
 */
export function matchCheckToFactor(checkName: string, checkDetail = ''): KnownEntryFactor | null {
  const text = `${checkName} ${checkDetail}`.toLowerCase();
  if (/volume spurt|coin in play/.test(text)) return 'Volume Spurt (Coin in Play)';
  if (/fib|golden zone/.test(text)) return 'Fibonacci Golden Zone';
  if (/sniper pullback|pullback/.test(text)) return 'Sniper Pullback';
  if (/rsi|divergentie|rsi div/.test(text)) return 'RSI Divergentie';
  if (/asian.*sweep|asian/.test(text)) return 'Asian Session Sweep';
  if (/15m.*reversal|ommekeer|15[- ]?m/.test(text)) return '15m Ommekeer-bevestiging';
  if (/scale[- ]?in|pyramid|tranche/.test(text)) return 'Smart Pyramiding (2e tranche)';
  return null;
}

/**
 * Evaluate the adaptive confluence edge of a candidate's passed checks against historical factorStats.
 * Returns an edge score bonus/penalty to adjust candidate ranking.
 */
export function evaluateCandidateFactorEdge(
  checks: readonly SignalCheck[],
  factorStats?: Record<string, FactorStat>
): { bonus: number; matchedFactors: string[] } {
  if (!factorStats || Object.keys(factorStats).length === 0) {
    return { bonus: 0, matchedFactors: [] };
  }

  const matchedFactors: string[] = [];
  let scoreDelta = 0;

  for (const check of checks) {
    if (!check.passed) continue;
    const factor = matchCheckToFactor(check.name, check.detail);
    if (!factor || matchedFactors.includes(factor)) continue;

    matchedFactors.push(factor);
    const stat = factorStats[factor];
    if (!stat) continue;

    const weight = stat.weightMultiplier ?? computeFactorWeight(stat);
    if (weight > 1.05) {
      scoreDelta += (weight - 1.0) * 0.15; // e.g. 1.25x -> +0.0375
    } else if (weight < 0.95) {
      scoreDelta -= (1.0 - weight) * 0.15; // e.g. 0.75x -> -0.0375
    }
  }

  return {
    bonus: Math.round(Math.max(-0.08, Math.min(0.1, scoreDelta)) * 1000) / 1000,
    matchedFactors,
  };
}

// ============================================================================
// 2. TIME-OF-DAY & SESSION INTELLIGENCE MATRIX
// ============================================================================

/**
 * Record a trade outcome into session performance statistics.
 */
export function updateSessionStat(
  sessionKey: string,
  verdict: 'WIN' | 'LOSS' | 'BREAK_EVEN',
  rMultiple: number,
  currentStats: Record<string, SessionStat> = {}
): Record<string, SessionStat> {
  const next = { ...currentStats };
  const prev = next[sessionKey] || {
    session: sessionKey,
    wins: 0,
    losses: 0,
    netR: 0,
    winRate: 0,
    edgeMultiplier: 1.0,
  };

  const wins = prev.wins + (verdict === 'WIN' ? 1 : 0);
  const losses = prev.losses + (verdict === 'LOSS' ? 1 : 0);
  const netR = round(prev.netR + rMultiple, 2);
  const total = wins + losses;
  const winRate = total > 0 ? round(wins / total, 2) : 0;

  let edgeMultiplier = 1.0;
  if (total >= 3) {
    if (winRate >= 0.65 && netR > 0) edgeMultiplier = 1.15;
    else if (winRate < 0.35 && netR < -1.0) edgeMultiplier = 0.75;
  }

  next[sessionKey] = {
    ...prev,
    wins,
    losses,
    netR,
    winRate,
    edgeMultiplier,
  };

  return next;
}

/**
 * Evaluate current session edge. Detects toxic trading hours or high-probability windows.
 */
export function evaluateSessionEdge(
  session: string,
  sessionStats?: Record<string, SessionStat>
): { multiplier: number; scoreAdjustment: number; isToxic: boolean; reason?: string } {
  if (!sessionStats || !sessionStats[session]) {
    return { multiplier: 1.0, scoreAdjustment: 0, isToxic: false };
  }

  const stat = sessionStats[session];
  const total = stat.wins + stat.losses;
  if (total < 3) {
    return { multiplier: 1.0, scoreAdjustment: 0, isToxic: false };
  }

  if (stat.winRate < 0.35 && stat.netR < -1.0) {
    return {
      multiplier: 0.8,
      scoreAdjustment: -0.05,
      isToxic: true,
      reason: `Sessie ${session} heeft een verhoogd risico (${Math.round(stat.winRate * 100)}% winrate, ${stat.netR}R)`,
    };
  }

  if (stat.winRate >= 0.65 && stat.netR > 0) {
    return {
      multiplier: 1.1,
      scoreAdjustment: 0.03,
      isToxic: false,
      reason: `Sessie ${session} presteert statistisch sterk (${Math.round(stat.winRate * 100)}% winrate, +${stat.netR}R)`,
    };
  }

  return { multiplier: 1.0, scoreAdjustment: 0, isToxic: false };
}

// ============================================================================
// 3. COIN DNA PROFILING (ASSET BEHAVIOURAL LEARNING)
// ============================================================================

/**
 * Classify a symbol into a volatility category.
 */
export function classifyVolatilityTier(symbol: string): 'MAJOR' | 'ALT' | 'MEME' {
  const norm = symbol.toUpperCase().replace(/[-_]?(USDT|USDC)$/i, '');
  if (/^(BTC|ETH|SOL|XRP)$/i.test(norm)) return 'MAJOR';
  if (
    /^(DOGE|SHIB|PEPE|1000PEPE|BONK|1000BONK|FLOKI|WIF|POPCAT|BOME|TURBO|PNUT|MOODENG|BRETT|MEW|GOAT|MOG|1000000MOG|FARTCOIN|PENGU|SPX|ACT|TRUMP)$/i.test(
      norm
    )
  ) {
    return 'MEME';
  }
  return 'ALT';
}

/**
 * Update the Coin DNA memory for a symbol when a trade closes.
 */
export function updateCoinDNA(
  symbol: string,
  verdict: 'WIN' | 'LOSS' | 'BREAK_EVEN',
  rMultiple: number,
  durationMinutes: number,
  mfeR: number,
  maeR: number,
  currentDNA: Record<string, CoinDNA> = {}
): Record<string, CoinDNA> {
  const next = { ...currentDNA };
  const tier = classifyVolatilityTier(symbol);
  const prev = next[symbol] || {
    symbol,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    netR: 0,
    winRate: 0,
    avgDurationMinutes: durationMinutes,
    avgMfeR: mfeR,
    avgMaeR: maeR,
    volatilityTier: tier,
    stopLossMultiplier: tier === 'MEME' ? 1.2 : 1.0,
    takeProfitMultiplier: tier === 'MEME' ? 0.9 : 1.0,
  };

  const totalTrades = prev.totalTrades + 1;
  const wins = prev.wins + (verdict === 'WIN' ? 1 : 0);
  const losses = prev.losses + (verdict === 'LOSS' ? 1 : 0);
  const netR = round(prev.netR + rMultiple, 2);
  const winRate = round(wins / totalTrades, 2);

  // Online running averages
  const avgDurationMinutes = Math.round(
    (prev.avgDurationMinutes * prev.totalTrades + durationMinutes) / totalTrades
  );
  const avgMfeR = round((prev.avgMfeR * prev.totalTrades + mfeR) / totalTrades, 2);
  const avgMaeR = round((prev.avgMaeR * prev.totalTrades + maeR) / totalTrades, 2);

  // Dynamic Stop-Loss Multiplier adaptation
  let stopLossMultiplier = 1.0;
  if (tier === 'MEME' || avgMaeR < -0.85) {
    // Needs wider stop buffer against aggressive wicks
    stopLossMultiplier = 1.25;
  } else if (tier === 'MAJOR' && winRate >= 0.6) {
    // Highly efficient order flow, tight stops thrive
    stopLossMultiplier = 0.95;
  }

  // Dynamic Take-Profit Multiplier adaptation
  let takeProfitMultiplier = 1.0;
  if (avgMfeR < 1.8 && totalTrades >= 3) {
    // Coin struggles to reach high targets before reversal; take profits faster
    takeProfitMultiplier = 0.85;
  } else if (avgMfeR >= 3.0 && winRate >= 0.5) {
    // Powerful runner; let profits expand
    takeProfitMultiplier = 1.15;
  }

  next[symbol] = {
    symbol,
    totalTrades,
    wins,
    losses,
    netR,
    winRate,
    avgDurationMinutes,
    avgMfeR,
    avgMaeR,
    volatilityTier: tier,
    stopLossMultiplier,
    takeProfitMultiplier,
  };

  return next;
}

// ============================================================================
// 4. MFE / MAE DYNAMIC TARGET & SL OPTIMIZATION
// ============================================================================

/**
 * Update global MFE (Maximum Favorable Excursion) & MAE (Maximum Adverse Excursion) metrics.
 */
export function updateMfeMaeStats(
  mfeR: number,
  maeR: number,
  current?: MfeMaeStats
): MfeMaeStats {
  const prev = current || {
    totalTracked: 0,
    avgMfeR: 0,
    avgMaeR: 0,
    medianMfeR: 0,
    optimalTp1R: 1.5,
    optimalTp2R: 3.0,
  };

  const totalTracked = prev.totalTracked + 1;
  const avgMfeR = round((prev.avgMfeR * prev.totalTracked + mfeR) / totalTracked, 2);
  const avgMaeR = round((prev.avgMaeR * prev.totalTracked + maeR) / totalTracked, 2);

  // Calculate empirically realistic take-profit targets based on where trades actually run
  const optimalTp1R = Math.round(Math.max(1.2, Math.min(2.2, avgMfeR * 0.6 || 1.5)) * 10) / 10;
  const optimalTp2R = Math.round(Math.max(2.2, Math.min(4.5, avgMfeR * 1.1 || 3.0)) * 10) / 10;

  return {
    totalTracked,
    avgMfeR,
    avgMaeR,
    medianMfeR: avgMfeR,
    optimalTp1R,
    optimalTp2R,
  };
}

// ============================================================================
// 5. CORRELATION & PORTFOLIO CLUSTER-RISK AI
// ============================================================================

/** Correlation groups for cluster-risk evaluation. */
const CLUSTER_GROUPS: Record<string, RegExp> = {
  majors: /^(BTC|ETH|SOL|XRP)[-_]?/i,
  layer1: /^(AVAX|NEAR|ADA|DOT|SUI|APT|SEI|TIA|ATOM|INJ|TON|FTM|ALGO|HBAR|KAS|ICP)[-_]?/i,
  layer2: /^(ARB|OP|STRK|POL|MANTA|METIS|BOBA|ZKJ|ZK|SCROLL|BLAST)[-_]?/i,
  ai: /^(FET|RENDER|TAO|WLD|AGIX|OCEAN|ARKM|ASI|IO|ATH|AI16Z|AIXBT|VIRTUAL|AIOZ)[-_]?/i,
  defi: /^(UNI|AAVE|MKR|LDO|PENDLE|CRV|SNX|COMP|JUP|RAY|AERO|ENA|SUSHI|DYDX|HYPE|CAKE|ONDO|ETHFI|GMX)[-_]?/i,
  gaming: /^(AXS|SAND|MANA|IMX|GALA|ENJ|BEAM|RON|MAGIC|YGG|PIXEL|PYR|ILV|PRIME)[-_]?/i,
  memes:
    /^(DOGE|SHIB|PEPE|1000PEPE|WIF|1000BONK|BONK|FLOKI|FARTCOIN|PENGU|SPX|POPCAT|BOME|TURBO|PNUT|NEIRO|NEIROCTO|MOODENG|BRETT|MEW|GOAT|MOG|1000000MOG|ACT|TRUMP)[-_]?/i,
  exchange: /^(BNB|OKB|CRO|FTT|BGB|KCS)[-_]?/i,
};

export function getClusterGroup(symbol: string): string {
  for (const [name, pattern] of Object.entries(CLUSTER_GROUPS)) {
    if (pattern.test(symbol)) return name;
  }
  return 'alts';
}

/**
 * Evaluate cluster and correlation risk for a candidate trade.
 *
 * Prevents correlated basket blowouts:
 * - When multiple positions are already open in the same direction, subsequent entries
 *   are scaled down (0.85x for 1 existing, 0.70x for 2 existing, 0.55x for 3+).
 * - Additional dampener applies when multiple assets from the same sector/cluster are open.
 * - Extra dampener applies when opening LONGs during an adverse Bitcoin trend.
 */
export function evaluateClusterRisk(
  candidate: { symbol: string; side: Side },
  openPositions: readonly { symbol: string; side: Side }[],
  btcTrend?: string
): ClusterRiskEvaluation {
  const activeSameSide = openPositions.filter((p) => p.side === candidate.side).length;
  const group = getClusterGroup(candidate.symbol);
  const inGroup = group !== 'alts' ? openPositions.filter((p) => getClusterGroup(p.symbol) === group).length : 0;

  let multiplier = 1.0;
  const reasons: string[] = [];

  if (activeSameSide === 1) {
    multiplier *= 0.85;
    reasons.push('1 bestaande positie in zelfde richting (85% risico)');
  } else if (activeSameSide === 2) {
    multiplier *= 0.7;
    reasons.push('2 bestaande posities in zelfde richting (70% cluster dampener)');
  } else if (activeSameSide >= 3) {
    multiplier *= 0.55;
    reasons.push(`${activeSameSide} bestaande posities in zelfde richting (55% defensieve schaling)`);
  }

  if (inGroup >= 1) {
    multiplier *= 0.85;
    reasons.push(`sector-concentratie in ${group} (${inGroup} actief)`);
  }

  if (candidate.side === 'LONG' && (btcTrend === 'TREND_DOWN' || btcTrend === 'BEARISH')) {
    multiplier *= 0.85;
    reasons.push('BTC macro-trend is neerwaarts (markt-beta correctie)');
  }

  const finalMultiplier = round(Math.max(0.4, Math.min(1.0, multiplier)), 2);

  return {
    activeSameSide,
    group,
    inGroup,
    multiplier: finalMultiplier,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}
