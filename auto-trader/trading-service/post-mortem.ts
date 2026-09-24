import type { Position, TradePostMortem } from './types.js';
import { FEE } from './exits.js';

function round(val: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

/**
 * Perform a post-mortem analysis of a closed trade.
 *
 * Evaluates why the trade won or lost, which entry factors contributed,
 * what went well, what went wrong, and derives an actionable learning.
 */
export function analyzeClosedTrade(
  position: Position,
  exitPrice: number,
  exitReason: NonNullable<Position['exitReason']> | string,
  netPnl: number
): TradePostMortem {
  const closedAt = position.closedAt || Date.now();
  const durationMinutes = Math.max(1, Math.round((closedAt - position.openedAt) / 60_000));
  const dir = position.side === 'LONG' ? 1 : -1;

  // Keep R anchored to entry-time quantity and stop distance, not margin or
  // stop/quantity fields that can change after exits. Scale-ins do not retain
  // per-tranche initial risk, so report neutral R rather than invent a basis.
  const riskDistance = position.initialRisk;
  const initialStop = position.entry - dir * riskDistance;
  const initialRiskPerUnit = riskDistance + FEE * (position.entry + initialStop);
  const initialRiskAmount = position.quantity * initialRiskPerUnit;
  const rMultiple =
    !position.scaleInCount &&
    Number.isFinite(position.entry) && position.entry > 0 &&
    Number.isFinite(riskDistance) && riskDistance > 0 && initialStop > 0 &&
    Number.isFinite(position.quantity) && position.quantity > 0 &&
    Number.isFinite(initialRiskAmount) && initialRiskAmount > 0 && Number.isFinite(netPnl)
      ? round(netPnl / initialRiskAmount, 2)
      : 0;
  const realisedNet = Number.isFinite(netPnl) ? netPnl : 0;

  // Determine verdict
  const verdict: TradePostMortem['verdict'] =
    realisedNet > 0.05 ? 'WIN' : realisedNet < -0.05 ? 'LOSS' : 'BREAK_EVEN';

  // Passed checks are authoritative; reason parsing is a positive-only fallback.
  const entryFactors: string[] = [];
  const reasons = position.reasons || [];
  const checks = position.entryChecks || [];
  const isNegativeReason = (reason: string): boolean =>
    /\b(?:N\/A|false|unconfirmed|absent|not active|not passed|not detected|not confirmed|failed|disabled|no qualifying|no (?:volume spurt|coin in play|fibonacci|golden zone|pullback|rsi|asian|reversal))\b/i.test(reason);
  const hasActiveFactor = (checkPattern: RegExp, reasonPattern: RegExp): boolean => {
    const matchingChecks = checks.filter((check) => checkPattern.test(check.name));
    if (matchingChecks.length > 0) return matchingChecks.some((check) => check.passed);
    return reasons.some((reason) => reasonPattern.test(reason) && !isNegativeReason(reason));
  };
  const fifteenMinuteReversal = /\b15[- ]?(?:m|min(?:ute)?s?)\b[^\n]*(?:reversal|ommekeer)|(?:reversal|ommekeer)[^\n]*\b15[- ]?(?:m|min(?:ute)?s?)\b/i;
  const hasActive15mReversal = (): boolean => {
    const matchingChecks = checks.filter((check) => fifteenMinuteReversal.test(`${check.name} ${check.detail}`));
    if (matchingChecks.length > 0) return matchingChecks.some((check) => check.passed);
    return reasons.some((reason) => fifteenMinuteReversal.test(reason) && !isNegativeReason(reason));
  };

  if (hasActiveFactor(/volume spurt|coin in play/i, /volume spurt|coin in play/i)) {
    entryFactors.push('Volume Spurt (Coin in Play)');
  }
  if (hasActiveFactor(/fib/i, /golden zone|fibonacci/i)) {
    entryFactors.push('Fibonacci Golden Zone');
  }
  if (hasActiveFactor(/sniper pullback/i, /sniper pullback|pullback/i)) {
    entryFactors.push('Sniper Pullback');
  }
  if (hasActiveFactor(/rsi/i, /divergentie|rsi div/i)) {
    entryFactors.push('RSI Divergentie');
  }
  if (hasActiveFactor(/asian/i, /asian.*sweep/i)) {
    entryFactors.push('Asian Session Sweep');
  }
  if (hasActive15mReversal()) {
    entryFactors.push('15m Ommekeer-bevestiging');
  }
  if (position.scaleInCount && position.scaleInCount > 0) {
    entryFactors.push('Smart Pyramiding (2e tranche)');
  }
  // Analyze what went well
  const whatWentWell: string[] = [];
  const tpLevels = position.takeProfits || [];
  const hitTps = tpLevels.filter((t) => t.hit);

  if (hitTps.length > 0) {
    whatWentWell.push(
      `Take-profit bereikt: ${hitTps.length}/${tpLevels.length} doelen geraakt (+${(position.realisedPnl || 0).toFixed(2)} winst veiliggesteld).`
    );
  }
  if (position.breakEven) {
    whatWentWell.push('Stop-loss tijdig opgetrokken naar break-even om kapitaal te beschermen.');
  }
  if (position.trailingArmed) {
    whatWentWell.push('Trailing stop geactiveerd en heeft de winstgevende trend gevolgd.');
  }
  if (position.profitLockR && position.profitLockR > 0) {
    whatWentWell.push(`Progressive profit-lock heeft minimaal +${position.profitLockR}R winst gegarandeerd.`);
  }
  if (verdict === 'WIN') {
    whatWentWell.push(`Positief netto resultaat: +${realisedNet.toFixed(2)} USDT (${rMultiple > 0 ? '+' : ''}${rMultiple}R).`);
  }
  if (whatWentWell.length === 0 && verdict === 'BREAK_EVEN') {
    whatWentWell.push('Nettoresultaat lag rond break-even na kosten.');
  } else if (whatWentWell.length === 0) {
    whatWentWell.push('Stop-loss heeft het maximale risico netjes begrensd conform risicoplan.');
  }

  // Analyze what went wrong
  const whatWentWrong: string[] = [];
  const isStopExit = exitReason === 'STOP_LOSS' || (exitReason === 'TRAILING_STOP' && verdict === 'LOSS');

  if (isStopExit) {
    whatWentWrong.push(`Stop-loss geraakt op ${exitPrice} (${realisedNet.toFixed(2)} USDT).`);
    if (durationMinutes <= 20) {
      whatWentWrong.push(`Snelle stop-out binnen ${durationMinutes} min — duidt op een valse uitbraak (fakeout) of plotse wick.`);
    }
  }
  if (exitReason === 'UNCERTAINTY') {
    whatWentWrong.push('Macro-trend (4u) of momentum keerde om tegen de positie in; preventief gesloten om erger te voorkomen.');
  }
  if (exitReason === 'STALE_TRADE') {
    whatWentWrong.push(`Trade stagneerde ${durationMinutes} min zonder headway richting TP1 — momentum doofde uit.`);
  }
  if (exitReason === 'STAGNATION') {
    whatWentWrong.push(`Trade stagneerde ${durationMinutes} min rond break-even zonder voortgang — afgesloten als 'dead money'.`);
  }
  if (exitReason === 'SIGNAL_FLIP') {
    whatWentWrong.push('Tegengesteld signaal gedetecteerd met hoge overtuiging — positie voortijdig afgebroken.');
  }
  if (verdict === 'LOSS' && hitTps.length === 0) {
    whatWentWrong.push('Geen enkel take-profit niveau kunnen aantikken voor de ommekeer.');
  }

  // Synthesize lesson in clear Dutch
  let lesson = '';
  if (verdict === 'WIN') {
    if (entryFactors.includes('Volume Spurt (Coin in Play)')) {
      lesson = 'Sterke volume-explosie bij instap leidde tot een krachtige trend; uitbraak-momentum hield overtuigend stand.';
    } else if (entryFactors.includes('Fibonacci Golden Zone') || entryFactors.includes('Sniper Pullback')) {
      lesson = 'Geduldige instap op de pullback nabij de 21 EMA / Golden Zone zorgde voor een optimale risk/reward en veilige stop.';
    } else {
      lesson = 'Solide trendvolgende trade; staged take-profits hebben de winst systematisch veiliggesteld.';
    }
  } else if (verdict === 'BREAK_EVEN') {
    lesson = exitReason === 'STAGNATION'
      ? 'Positie gesloten wegens stagnatie (dead money); nettoresultaat bepaalt of de trade werkelijk winstgevend was.'
      : 'Trade sloot netto rond break-even na kosten.';
  } else {
    // LOSS
    if (durationMinutes <= 20) {
      lesson = `Snelle stop-out duidt op een valse uitbraak of marktmanipulatie; het strafbankje beschermt ${position.symbol} nu tegen herhaald verlies.`;
    } else if (exitReason === 'UNCERTAINTY') {
      lesson = 'De macro-structuur verzwakte; vroegtijdig sluiten heeft een grotere stop-out voorkomen.';
    } else if (exitReason === 'STALE_TRADE') {
      lesson = 'Momentum ontbrak langdurig; kapitaal is netjes vrijgemaakt om te herinvesteren in actievere kansen.';
    } else {
      lesson = 'Stop-loss heeft het verlies strikt binnen de risicolimiet gehouden; het algoritme leert van deze uitkomst en past de weging aan.';
    }
  }

  return {
    verdict,
    rMultiple,
    netPnl: round(realisedNet, 2),
    durationMinutes,
    entryFactors,
    whatWentWell,
    whatWentWrong,
    lesson,
  };
}
