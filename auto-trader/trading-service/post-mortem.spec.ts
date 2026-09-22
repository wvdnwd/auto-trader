import { describe, expect, it } from 'vitest';
import { analyzeClosedTrade } from './post-mortem.js';
import type { Position } from './types.js';

function fakePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    symbol: 'DOGE_USDT',
    side: 'LONG',
    entry: 0.2,
    quantity: 1000,
    leverage: 5,
    margin: 40,
    notional: 200,
    stopLoss: 0.19,
    takeProfit: 0.236,
    takeProfits: [
      { price: 0.218, portion: 0.5, rMultiple: 1.8, hit: false },
      { price: 0.236, portion: 0.5, rMultiple: 3.6, hit: false },
    ],
    remainingQuantity: 1000,
    realisedPnl: 0,
    entryFee: 0.12,
    initialRisk: 0.01,
    breakEven: false,
    extreme: 0.2,
    trailingArmed: false,
    openedAt: Date.now() - 3600_000, // 1 hour ago
    status: 'OPEN',
    confidence: 0.8,
    regime: 'TREND_UP',
    reasons: ['Volume spurt (2.5x avg) — Coin in Play', 'Fibonacci golden zone bevestigt instap'],
    ...overrides,
  };
}

describe('analyzeClosedTrade (Post-Mortem Engine)', () => {
  it('identifies a win, extracts entry factors and produces positive takeaways', () => {
    const pos = fakePosition({
      breakEven: true,
      trailingArmed: true,
      realisedPnl: 9.0,
      takeProfits: [
        { price: 0.218, portion: 0.5, rMultiple: 1.8, hit: true },
        { price: 0.236, portion: 0.5, rMultiple: 3.6, hit: true },
      ],
    });

    const report = analyzeClosedTrade(pos, 0.236, 'TAKE_PROFIT', 18.0);
    expect(report.verdict).toBe('WIN');
    expect(report.rMultiple).toBeGreaterThan(0);
    expect(report.entryFactors).toContain('Volume Spurt (Coin in Play)');
    expect(report.entryFactors).toContain('Fibonacci Golden Zone');
    expect(report.whatWentWell.some((w) => w.includes('Take-profit'))).toBe(true);
    expect(report.whatWentWell.some((w) => w.includes('Stop-loss tijdig opgetrokken'))).toBe(true);
    expect(report.lesson).toContain('volume-explosie');
  });

  it('identifies a quick stop-loss loss as a potential fakeout', () => {
    const pos = fakePosition({
      openedAt: Date.now() - 10 * 60_000, // 10 minutes ago
    });

    const report = analyzeClosedTrade(pos, 0.19, 'STOP_LOSS', -10.0);
    expect(report.verdict).toBe('LOSS');
    expect(report.rMultiple).toBeLessThan(0);
    expect(report.whatWentWrong.some((w) => w.includes('Snelle stop-out'))).toBe(true);
    expect(report.lesson).toContain('strafbankje');
  });

  it('correctly handles break-even trades', () => {
    const pos = fakePosition({
      breakEven: true,
      realisedPnl: 4.5,
      takeProfits: [
        { price: 0.218, portion: 0.5, rMultiple: 1.8, hit: true },
        { price: 0.236, portion: 0.5, rMultiple: 3.6, hit: false },
      ],
    });

    const report = analyzeClosedTrade(pos, 0.2, 'BREAK_EVEN', 0.0);
    expect(report.verdict).toBe('BREAK_EVEN');
    expect(report.lesson).toContain('saldo bleef 100% beschermd');
  });

  it('correctly diagnoses a stagnation (dead money) exit', () => {
    const pos = fakePosition({
      openedAt: Date.now() - 150 * 60_000, // 2.5 hours ago
    });

    const report = analyzeClosedTrade(pos, 0.2001, 'STAGNATION', 0.1);
    expect(report.verdict).toBe('BREAK_EVEN');
    expect(report.whatWentWrong.some((w) => w.includes('dead money'))).toBe(true);
    expect(report.lesson).toContain('stagnatie (dead money)');
  });
});
