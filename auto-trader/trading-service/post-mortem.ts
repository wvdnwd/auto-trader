import type { Position, TradePostMortem } from './types.js';

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

  // Calculate R-multiple
  const riskDistance = position.initialRisk || Math.abs(position.entry - position.stopLoss);
  let rMultiple = 0;
  if (riskDistance > 0 && position.entry > 0) {
    const initialRiskAmount = (position.margin * (position.leverage || 1) * riskDistance) / position.entry;
    rMultiple = initialRiskAmount > 0 ? round(netPnl / initialRiskAmount, 2) : (netPnl >= 0 ? 1 : -1);
  } else {
    rMultiple = netPnl >= 0 ? 1 : -1;
  }

  // Determine verdict
  const verdict: TradePostMortem['verdict'] =
    exitReason === 'BREAK_EVEN' || exitReason === 'STAGNATION'
      ? 'BREAK_EVEN'
      : netPnl > 0.05
        ? 'WIN'
        : netPnl < -0.05
          ? 'LOSS'
          : 'BREAK_EVEN';

  // Identify entry factors from reasons and checks
  const entryFactors: string[] = [];
  const allReasonText = [...(position.reasons || []), ...(position.entryChecks?.map((c) => c.name) || [])].join(' ');

  if (/volume spurt|coin in play/i.test(allReasonText) || position.entryChecks?.some((c) => c.name === 'Volume Spurt' && c.passed)) {
    entryFactors.push('Volume Spurt (Coin in Play)');
  }
  if (/golden zone|fibonacci/i.test(allReasonText) || position.entryChecks?.some((c) => c.name.includes('Fib') && c.passed)) {
    entryFactors.push('Fibonacci Golden Zone');
  }
  if (/sniper pullback|pullback/i.test(allReasonText) || position.entryChecks?.some((c) => c.name === 'Sniper Pullback' && c.passed)) {
    entryFactors.push('Sniper Pullback');
  }
  if (/divergentie|rsi div/i.test(allReasonText) || position.entryChecks?.some((c) => c.name.includes('RSI') && c.passed)) {
    entryFactors.push('RSI Divergentie');
  }
  if (/asian.*sweep/i.test(allReasonText) || position.entryChecks?.some((c) => c.name.includes('Asian') && c.passed)) {
    entryFactors.push('Asian Session Sweep');
  }
  if (/15m.*ommekeer|reversal/i.test(allReasonText)) {
    entryFactors.push('15m Ommekeer-bevestiging');
  }
  if (position.scaleInCount && position.scaleInCount > 0) {
    entryFactors.push('Smart Pyramiding (2e tranche)');
  }
  if (entryFactors.length === 0) {
    entryFactors.push('Trend & Momentum setup');
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
    whatWentWell.push(`Positief netto resultaat: +${netPnl.toFixed(2)} USDT (${rMultiple > 0 ? '+' : ''}${rMultiple}R).`);
  }
  if (whatWentWell.length === 0 && verdict === 'BREAK_EVEN') {
    whatWentWell.push('Positie zonder verlies afgesloten; inleg intact gebleven.');
  } else if (whatWentWell.length === 0) {
    whatWentWell.push('Stop-loss heeft het maximale risico netjes begrensd conform risicoplan.');
  }

  // Analyze what went wrong
  const whatWentWrong: string[] = [];
  const isStopExit = exitReason === 'STOP_LOSS' || (exitReason === 'TRAILING_STOP' && verdict === 'LOSS');

  if (isStopExit) {
    whatWentWrong.push(`Stop-loss geraakt op ${exitPrice} (${netPnl.toFixed(2)} USDT).`);
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
  } else if (verdict === 'BREAK_EVEN' || exitReason === 'STAGNATION') {
    lesson =
      exitReason === 'STAGNATION'
        ? 'Positie tijdig gesloten wegens stagnatie (dead money). Kapitaal werd beschermd en direct vrijgemaakt voor betere kansen.'
        : 'Eerste doel werd behaald waarna de stop naar break-even ging. De markt keerde om, maar het saldo bleef 100% beschermd.';
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
    netPnl: round(netPnl, 2),
    durationMinutes,
    entryFactors,
    whatWentWell,
    whatWentWrong,
    lesson,
  };
}
