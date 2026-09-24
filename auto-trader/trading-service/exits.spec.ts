import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXITS,
  FEE,
  earlyProfitProtect,
  fillTakeProfits,
  partialFillPatch,
  regimeTrimPatch,
  trimForRegimeFlip,
} from './exits.js';
import type { Position } from './types.js';

function fakePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'position-1',
    symbol: 'BTC_USDT',
    side: 'LONG',
    entry: 100,
    quantity: 100,
    leverage: 5,
    margin: 100,
    notional: 10_000,
    stopLoss: 95,
    takeProfit: 120,
    takeProfits: [
      { price: 110, portion: 0.4, rMultiple: 2, hit: false },
      { price: 120, portion: 0.6, rMultiple: 4, hit: false },
    ],
    remainingQuantity: 100,
    realisedPnl: 0,
    entryFee: 6,
    initialRisk: 5,
    breakEven: false,
    extreme: 100,
    trailingArmed: false,
    openedAt: 1,
    status: 'OPEN',
    confidence: 0.8,
    regime: 'TREND_UP',
    reasons: [],
    ...overrides,
  };
}

describe('fillTakeProfits', () => {
  it('rejects non-finite or invalid price and fee inputs', () => {
    const position = fakePosition();
    expect(fillTakeProfits(position, NaN)).toBeNull();
    expect(fillTakeProfits(position, Infinity)).toBeNull();
    expect(fillTakeProfits(position, 110, Infinity)).toBeNull();
    expect(fillTakeProfits(position, 110, -0.01)).toBeNull();
  });

  it('caps requested tranches to the quantity actually remaining', () => {
    const position = fakePosition({
      remainingQuantity: 50,
      takeProfits: [
        { price: 105, portion: 0.6, rMultiple: 1, hit: false },
        { price: 106, portion: 0.6, rMultiple: 1.2, hit: false },
      ],
    });

    const fill = fillTakeProfits(position, 110);

    expect(fill?.bookedQty).toBe(50);
    expect(fill?.remaining).toBe(0);
    expect(fill?.filled).toHaveLength(1);
    expect(fill?.levels.map((level) => level.hit)).toEqual([true, false]);
  });

  it('sizes margin and notional reductions against pre-fill remaining quantity', () => {
    const position = fakePosition({ remainingQuantity: 50, margin: 50, notional: 5_000 });
    const fill = {
      levels: [{ price: 110, portion: 0.4, rMultiple: 2, hit: true }],
      bookedQty: 40,
      bookedPnl: 390,
      remaining: 10,
      allDone: false,
      filled: [{ price: 110, portion: 0.4, rMultiple: 2, hit: true }],
    };

    const { patch, freedMargin } = partialFillPatch(position, fill);

    expect(freedMargin).toBe(40);
    expect(patch.margin).toBe(10);
    expect(patch.notional).toBe(1_000);
    expect(patch.remainingQuantity).toBe(10);
  });

  it('moves stops monotonically to a fee-covered level before marking break-even', () => {
    const position = fakePosition();
    const fill = {
      levels: [{ price: 110, portion: 0.4, rMultiple: 2, hit: true }],
      bookedQty: 40,
      bookedPnl: 390,
      remaining: 60,
      allDone: false,
      filled: [{ price: 110, portion: 0.4, rMultiple: 2, hit: true }],
    };
    const { patch } = partialFillPatch(position, fill);
    const feeCoveredLongStop = position.entry * ((1 + FEE) / (1 - FEE));

    expect(patch.stopLoss).toBeGreaterThanOrEqual(feeCoveredLongStop);
    expect(patch.breakEven).toBe(true);

    const alreadyProtected = fakePosition({ stopLoss: 101 });
    const monotonic = partialFillPatch(alreadyProtected, fill).patch;
    expect(monotonic.stopLoss).toBeGreaterThan(101);

    const moreProtected = fakePosition({ stopLoss: 103 });
    expect(partialFillPatch(moreProtected, fill).patch.stopLoss).toBe(103);
  });

  it('uses the exact configured fee-covered stop for both directions', () => {
    const feeRate = 0.003;
    const tuning = { ...DEFAULT_EXITS, breakEvenBufferR: 0 };
    const fill = {
      levels: [{ price: 110, portion: 0.4, rMultiple: 2, hit: true }],
      bookedQty: 40,
      bookedPnl: 390,
      remaining: 60,
      allDone: false,
      filled: [{ price: 110, portion: 0.4, rMultiple: 2, hit: true }],
    };
    for (const side of ['LONG', 'SHORT'] as const) {
      const position = fakePosition({
        side,
        stopLoss: side === 'LONG' ? 95 : 105,
        takeProfit: side === 'LONG' ? 120 : 80,
      });
      const expected = position.entry * (side === 'LONG'
        ? (1 + feeRate) / (1 - feeRate)
        : (1 - feeRate) / (1 + feeRate));
      const { patch } = partialFillPatch(position, fill, tuning, feeRate);

      expect(patch.stopLoss).toBeCloseTo(expected, 12);
      expect(patch.breakEven).toBe(true);
    }
  });

  it('uses the configured fee for early break-even protection in both directions', () => {
    const feeRate = 0.003;
    for (const side of ['LONG', 'SHORT'] as const) {
      const position = fakePosition({
        side,
        stopLoss: side === 'LONG' ? 95 : 105,
        takeProfit: side === 'LONG' ? 120 : 80,
      });
      const price = side === 'LONG' ? 106 : 94;
      const expected = position.entry * (side === 'LONG'
        ? (1 + feeRate) / (1 - feeRate)
        : (1 - feeRate) / (1 + feeRate));

      expect(earlyProfitProtect(position, price, 1.2, feeRate)?.stopLoss).toBeCloseTo(expected, 12);
    }
  });
});

describe('regime flip trim validation', () => {
  it('rejects non-finite and out-of-domain trim inputs before accounting', () => {
    const position = fakePosition();
    expect(trimForRegimeFlip(position, NaN, 0.5)).toBeNull();
    expect(trimForRegimeFlip(position, 105, NaN)).toBeNull();
    expect(trimForRegimeFlip(position, 105, 0.5, NaN)).toBeNull();
    expect(trimForRegimeFlip(position, 0, 0.5)).toBeNull();
    expect(trimForRegimeFlip(position, 105, 1)).toBeNull();
    expect(trimForRegimeFlip(position, 105, 0.5, 1)).toBeNull();
    expect(trimForRegimeFlip(fakePosition({ remainingQuantity: NaN }), 105, 0.5)).toBeNull();
  });

  it('rejects malformed trim results rather than propagating them into position accounting', () => {
    const position = fakePosition();
    const invalid = regimeTrimPatch(position, {
      trimmedQty: 50,
      bookedPnl: NaN,
      remaining: 50,
    });

    expect(invalid).toEqual({ patch: {}, freedMargin: 0 });
    expect(Object.values(invalid.patch).some((value) => typeof value === 'number' && !Number.isFinite(value))).toBe(false);
  });
});
