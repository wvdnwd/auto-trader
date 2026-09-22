import type { Candle, Position, TakeProfitLevel } from './types.js';

/** Taker fee applied on entry and exit, as a fraction of notional. */
export const FEE = 0.0006;

/** Profit (in R) at which the trailing stop arms. */
export const TRAIL_ARM_R = 1;

/** Fraction of the trade's risk distance given back once trailing. */
export const TRAIL_GIVEBACK = 0.6;

/**
 * How the exit rules behave. Defaults mirror the constants above.
 */
export type ExitTuning = {
  /** Profit in R at which the trailing stop arms. */
  trailArmR: number;
  /** Fraction of the risk distance given back once trailing. */
  trailGiveback: number;
  /** Move the stop to entry once the first target fills. */
  breakEvenAfterFirst: boolean;
  /**
   * Extra room, as a fraction of the trade's risk distance (R), given to the
   * break-even stop after TP1 fills. `0` moves the stop to exactly
   * entry+fees, which a normal post-target consolidation wobble can trigger
   * almost immediately. A positive value lets price pull back that much
   * further before the break-even stop takes over, at the cost of giving back
   * a little of the profit already banked at TP1 if the pullback turns into a
   * full reversal.
   */
  breakEvenBufferR: number;
};

/**
 * Extra room given to the break-even stop after TP1, as a fraction of the
 * trade's risk distance. Per user request: the old behaviour moved the stop
 * to exactly entry+fees the instant TP1 filled, so a normal one-tick
 * consolidation right after the target closed the runner for a near-zero
 * gain instead of letting it continue. 0.3R gives the runner room to breathe
 * through that wobble.
 */
export const BREAK_EVEN_BUFFER_R = 0.3;

/** Exit behaviour used when no tuning is supplied. */
export const DEFAULT_EXITS: ExitTuning = {
  trailArmR: TRAIL_ARM_R,
  trailGiveback: TRAIL_GIVEBACK,
  breakEvenAfterFirst: true,
  breakEvenBufferR: BREAK_EVEN_BUFFER_R,
};

/**
 * The risk distance the trade was sized against.
 *
 * Always the distance to the *original* stop. Reading it off the live stop would
 * collapse to zero the moment the stop moves to break-even, which silently
 * disables the trailing logic for the rest of the trade.
 *
 * @param position the position to measure.
 * @returns the price distance one R represents.
 */
export function riskUnit(position: Position): number {
  return position.initialRisk || Math.abs(position.entry - position.stopLoss);
}

/**
 * Direction multiplier: +1 for a long, -1 for a short.
 *
 * @param position the position to read the side from.
 * @returns 1 or -1.
 */
export function direction(position: Pick<Position, 'side'>): 1 | -1 {
  return position.side === 'LONG' ? 1 : -1;
}

/**
 * Whether the collateral behind the position is effectively wiped out.
 *
 * @param position the open position.
 * @param price current mark price.
 * @returns true when the position would be liquidated.
 */
export function isLiquidated(position: Position, price: number): boolean {
  const dir = direction(position);
  const movePct = (dir * (price - position.entry)) / position.entry;
  return movePct * position.leverage <= -0.9;
}

/**
 * Whether price has traded through the stop loss.
 *
 * @param position the open position.
 * @param price current mark price.
 * @returns true when the stop is triggered.
 */
export function isStopHit(position: Position, price: number): boolean {
  return direction(position) === 1 ? price <= position.stopLoss : price >= position.stopLoss;
}

/**
 * Which kind of stop fired, for the trade log.
 *
 * @param position the position being stopped out.
 * @returns the exit reason to record.
 */
export function stopReason(position: Position): NonNullable<Position['exitReason']> {
  if (position.trailingArmed) return 'TRAILING_STOP';
  if (position.breakEven) return 'BREAK_EVEN';
  return 'STOP_LOSS';
}

/**
 * The outcome of running the take-profit ladder against a price.
 */
export type PartialFill = {
  /** The full ladder with newly filled levels marked. */
  levels: TakeProfitLevel[];
  /** Quantity closed by this fill. */
  bookedQty: number;
  /** Net profit booked by this fill, after fees. */
  bookedPnl: number;
  /** Quantity still open afterwards. */
  remaining: number;
  /** True when this fill completes the ladder and the position should close. */
  allDone: boolean;
  /** The levels that filled on this pass. */
  filled: TakeProfitLevel[];
};

/**
 * Book profit at every ladder level the price has reached since the last check.
 *
 * Fills happen at the target price rather than the current mark: the order rests
 * at the level, so a price that gaps past it still fills where it was placed.
 *
 * @param position the open position.
 * @param price current mark price.
 * @param feeRate taker fee as a fraction of notional.
 * @returns the fill, or null when no level was reached.
 */
export function fillTakeProfits(
  position: Position,
  price: number,
  feeRate = FEE
): PartialFill | null {
  const dir = direction(position);
  const levels = position.takeProfits || [];
  const updated = levels.map((t) => ({ ...t }));
  const filled: TakeProfitLevel[] = [];
  let bookedQty = 0;
  let bookedPnl = 0;

  for (const level of updated) {
    if (level.hit) continue;
    if (dir === 1 ? price < level.price : price > level.price) continue;
    const qty = position.quantity * level.portion;
    const gross = dir * (level.price - position.entry) * qty;
    const fee = qty * level.price * feeRate;
    const net = gross - fee;
    level.hit = true;
    level.hitAt = Date.now();
    level.realised = net;
    filled.push(level);
    bookedQty += qty;
    bookedPnl += net;
  }
  if (!bookedQty) return null;

  const remaining = Math.max(0, position.remainingQuantity - bookedQty);
  const allDone = updated.every((t) => t.hit) || remaining <= position.quantity * 0.01;
  return { levels: updated, bookedQty, bookedPnl, remaining, allDone, filled };
}

/**
 * The position changes that follow a partial take-profit fill.
 *
 * The first fill also moves the stop to break-even, so a winner can no longer
 * turn into a loser.
 *
 * @param position the position before the fill.
 * @param fill the fill produced by {@link fillTakeProfits}.
 * @returns the patch to apply and the collateral released by the closed tranche.
 */
export function partialFillPatch(
  position: Position,
  fill: PartialFill,
  tuning: ExitTuning = DEFAULT_EXITS
): { patch: Partial<Position>; freedMargin: number } {
  const freedMargin = position.margin * (fill.bookedQty / position.quantity);
  const patch: Partial<Position> = {
    takeProfits: fill.levels,
    remainingQuantity: fill.remaining,
    realisedPnl: position.realisedPnl + fill.bookedPnl,
    margin: position.margin - freedMargin,
    notional: position.notional * (fill.remaining / position.quantity),
  };
  if (tuning.breakEvenAfterFirst && !position.breakEven) {
    patch.breakEven = true;
    // Cover the exit fee, plus a buffer of `breakEvenBufferR` risk units so a
    // normal post-target consolidation wobble does not immediately stop the
    // runner out for a near-zero gain — see `breakEvenBufferR` doc comment.
    const riskDistance = riskUnit(position);
    const buffer = riskDistance * (tuning.breakEvenBufferR || 0);
    patch.stopLoss = position.entry + direction(position) * (position.entry * FEE * 2 - buffer);
  }
  return { patch, freedMargin };
}

/**
 * Trailing stop update for a position that is far enough in profit.
 *
 * Once the trade reaches {@link TRAIL_ARM_R}, the stop follows the best price
 * seen, giving back a fixed fraction of the original risk distance.
 *
 * @param position the open position.
 * @param price current mark price.
 * @returns the patch to apply — empty when nothing changed.
 */
export function trailPatch(
  position: Position,
  price: number,
  tuning: ExitTuning = DEFAULT_EXITS
): Partial<Position> {
  const dir = direction(position);
  const riskDistance = riskUnit(position);
  const extreme = dir === 1 ? Math.max(position.extreme, price) : Math.min(position.extreme, price);
  const profitR = riskDistance ? (dir * (extreme - position.entry)) / riskDistance : 0;
  const patch: Partial<Position> = {};
  if (extreme !== position.extreme) patch.extreme = extreme;
  if (profitR >= tuning.trailArmR && riskDistance) {
    const trail = extreme - dir * riskDistance * tuning.trailGiveback;
    const better = dir === 1 ? trail > position.stopLoss : trail < position.stopLoss;
    if (better) {
      patch.stopLoss = trail;
      patch.trailingArmed = true;
    }
  }
  return patch;
}

/**
 * Final settlement of the portion of a position that is still open.
 *
 * Profit booked at earlier take-profit levels was already paid into the balance,
 * so only the open remainder settles here.
 *
 * @param position the position being closed.
 * @param price the exit price.
 * @param feeRate taker fee as a fraction of notional.
 * @returns total lifetime pnl, the amount settling now, and the net trade result.
 */
export function closeSettlement(
  position: Position,
  price: number,
  feeRate = FEE
): { total: number; settling: number; net: number } {
  const dir = direction(position);
  const remaining = position.remainingQuantity ?? position.quantity;
  const gross = dir * (price - position.entry) * remaining;
  const fee = remaining * price * feeRate;
  // The open portion can never lose more than the collateral still behind it.
  const total = Math.max(gross - fee, -position.margin) + (position.realisedPnl || 0);
  return {
    total,
    settling: total - (position.realisedPnl || 0),
    // What the trade actually made, entry fee included. That fee left the balance
    // when the position opened, so it is not part of what settles now — but a
    // trade result that ignores it overstates every single outcome.
    net: total - (position.entryFee || 0),
  };
}

/**
 * The outcome of trimming a position for an adverse regime flip.
 */
export type TrimResult = {
  /** Quantity closed by this trim, at market. */
  trimmedQty: number;
  /** Net profit (or loss) booked by this trim, after fees. */
  bookedPnl: number;
  /** Quantity still open afterwards. */
  remaining: number;
};

/**
 * Trim part of an open position when the market regime has genuinely turned
 * against it — e.g. a LONG held while the regime now reads TREND_DOWN.
 *
 * Unlike the take-profit ladder this fires at the current mark, not a resting
 * limit level: the whole point is to cut exposure immediately once the thesis
 * looks wrong, not to wait for a specific price. Fires at most once per
 * position (the caller sets `Position.regimeTrimmed` from the patch below).
 *
 * @param position the open position to trim.
 * @param price current mark price.
 * @param portion fraction of the remaining size to close, e.g. 0.5 = half.
 * @param feeRate taker fee as a fraction of notional.
 * @returns the trim result, or null when the remaining size is too small to split.
 */
export function trimForRegimeFlip(
  position: Position,
  price: number,
  portion: number,
  feeRate = FEE
): TrimResult | null {
  const remaining = position.remainingQuantity ?? position.quantity;
  const trimmedQty = remaining * Math.max(0.05, Math.min(0.95, portion));
  if (!(trimmedQty > 0) || trimmedQty >= remaining) return null;
  const gross = direction(position) * (price - position.entry) * trimmedQty;
  const fee = trimmedQty * price * feeRate;
  return {
    trimmedQty,
    bookedPnl: gross - fee,
    remaining: remaining - trimmedQty,
  };
}

/**
 * Position changes that follow a regime-flip trim — mirrors
 * {@link partialFillPatch} but for a market trim rather than a ladder fill.
 *
 * @param position the position before the trim.
 * @param trim the result produced by {@link trimForRegimeFlip}.
 * @returns the patch to apply and the collateral released by the closed portion.
 */
export function regimeTrimPatch(
  position: Position,
  trim: TrimResult
): { patch: Partial<Position>; freedMargin: number } {
  const remaining = position.remainingQuantity ?? position.quantity;
  const freedMargin = position.margin * (trim.trimmedQty / remaining);
  const patch: Partial<Position> = {
    remainingQuantity: trim.remaining,
    realisedPnl: position.realisedPnl + trim.bookedPnl,
    margin: position.margin - freedMargin,
    notional: position.notional * (trim.remaining / remaining),
    regimeTrimmed: true,
  };
  return { patch, freedMargin };
}

/**
 * Unrealised pnl on the portion of a position that is still open.
 *
 * Profit already booked at a take-profit level is deliberately excluded: it was
 * paid into the balance the moment that tranche closed, so counting it here too
 * would inflate equity by the booked amount.
 *
 * @param position the open position.
 * @param price current mark price.
 * @returns open pnl in quote currency.
 */
export function openPnl(position: Position, price: number): number {
  const remaining = position.remainingQuantity ?? position.quantity;
  return direction(position) * (price - position.entry) * remaining;
}

/**
 * Ratchet stop-loss up progressively as price advances (+2.2R, +3.2R, +4.2R)
 * to lock in banked profits so a winning trade never returns to flat break-even.
 *
 * @param position the open position.
 * @param price current mark price.
 * @returns new stop price and locked R level, or null if no ratchet applies.
 */
export function progressiveProfitLock(
  position: Position,
  price: number
): { stopLoss: number; rLocked: number } | null {
  const rUnit = riskUnit(position);
  if (!(rUnit > 0)) return null;
  const dir = direction(position);
  const currentR = (dir * (price - position.entry)) / rUnit;

  let rLocked: number | null = null;
  if (currentR >= 4.2) rLocked = 2.75;
  else if (currentR >= 3.2) rLocked = 1.75;
  else if (currentR >= 2.2) rLocked = 0.75;

  if (rLocked === null) return null;
  const targetStop = position.entry + dir * (rLocked * rUnit);
  const isBetter = dir === 1 ? targetStop > position.stopLoss : targetStop < position.stopLoss;
  if (!isBetter) return null;

  return { stopLoss: targetStop, rLocked };
}

/**
 * Detect parabolic blow-off top climax (extreme RSI + 2.5x volume surge)
 * to harvest profit at the peak before a sharp reversal.
 *
 * @param position open position.
 * @param candles recent candles for volume average.
 * @param rsiVal current RSI.
 * @returns true when blow-off top conditions are met.
 */
export function detectBlowOffTop(
  position: Position,
  candles: Candle[],
  rsiVal?: number
): boolean {
  if (!Number.isFinite(rsiVal)) return false;
  const isLong = position.side === 'LONG';
  const rsiExtreme = isLong ? (rsiVal as number) >= 82 : (rsiVal as number) <= 18;
  if (!rsiExtreme) return false;

  if (!candles || candles.length < 15) return true; // RSI extreme alone qualifies if volume data is sparse
  const sample = candles.slice(-21, -1);
  const avgVol = sample.reduce((acc, c) => acc + c.volume, 0) / Math.max(1, sample.length);
  const latestVol = candles[candles.length - 1]?.volume ?? 0;
  return avgVol > 0 && latestVol >= avgVol * 2.2;
}

/**
 * Volatility-based dynamic Chandelier trailing stop for runners.
 *
 * @param position open position.
 * @param peakPrice highest price reached since entry.
 * @param atr current ATR value.
 * @param multiplier ATR multiplier (defaults to 1.5).
 * @returns trailing stop price.
 */
export function chandelierStop(
  position: Position,
  peakPrice: number,
  atr: number,
  multiplier = 1.5
): number {
  const dir = direction(position);
  return peakPrice - dir * (atr * multiplier);
}

/**
 * Early Profit Protection: move stop loss to break-even once price reaches
 * an early milestone (e.g. +1.2R) before TP1 fills, preventing a near-target
 * trade from collapsing back into a full loss.
 *
 * @param position open position.
 * @param price current mark price.
 * @param thresholdR R multiple to trigger early protection (default 1.2R).
 * @returns new stop price or null if not triggered.
 */
export function earlyProfitProtect(
  position: Position,
  price: number,
  thresholdR = 1.2
): { stopLoss: number } | null {
  if (position.breakEven) return null;
  const rUnit = riskUnit(position);
  if (!(rUnit > 0)) return null;
  const dir = direction(position);
  const currentR = (dir * (price - position.entry)) / rUnit;
  if (currentR < thresholdR) return null;

  // Set stop to cover round-trip taker fees
  const targetStop = position.entry + dir * (position.entry * FEE * 2);
  const isBetter = dir === 1 ? targetStop > position.stopLoss : targetStop < position.stopLoss;
  if (!isBetter) return null;
  return { stopLoss: targetStop };
}

