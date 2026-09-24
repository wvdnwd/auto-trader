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
    expect(report.lesson).toContain('break-even na kosten');
  });

  it('correctly diagnoses a stagnation (dead money) exit', () => {
    const pos = fakePosition({
      openedAt: Date.now() - 150 * 60_000, // 2.5 hours ago
    });

    const report = analyzeClosedTrade(pos, 0.2001, 'STAGNATION', 0.01);
    expect(report.verdict).toBe('BREAK_EVEN');
    expect(report.whatWentWrong.some((w) => w.includes('dead money'))).toBe(true);
    expect(report.lesson).toContain('stagnatie (dead money)');
  });

  it('bases verdict on net PnL even for break-even and stagnation exit reasons', () => {
    expect(analyzeClosedTrade(fakePosition(), 0.2, 'BREAK_EVEN', -2).verdict).toBe('LOSS');
    expect(analyzeClosedTrade(fakePosition(), 0.21, 'STAGNATION', 2).verdict).toBe('WIN');
    const stagnationLoss = analyzeClosedTrade(fakePosition(), 0.19, 'STAGNATION', -2);
    expect(stagnationLoss.verdict).toBe('LOSS');
    expect(stagnationLoss.lesson).toContain('Stop-loss');
  });

  it('keeps R anchored to initial risk instead of mutable margin or stop fields', () => {
    const original = fakePosition({ margin: 40, stopLoss: 0.19 });
    const afterPartials = fakePosition({ margin: 10, stopLoss: 0.205, remainingQuantity: 250 });

    expect(analyzeClosedTrade(original, 0.2, 'MANUAL', 5).rMultiple).toBe(
      analyzeClosedTrade(afterPartials, 0.2, 'MANUAL', 5).rMultiple
    );
  });

  it('does not fabricate R when scale-in tranches have no persisted initial-risk basis', () => {
    const report = analyzeClosedTrade(fakePosition({ scaleInCount: 1 }), 0.22, 'TAKE_PROFIT', 20);
    expect(report.rMultiple).toBe(0);
  });

  it('does not attribute failed or N/A checks as active entry factors', () => {
    const report = analyzeClosedTrade(
      fakePosition({
        reasons: ['Volume Spurt: N/A', 'Fibonacci filter not active'],
        entryChecks: [
          { name: 'Volume Spurt', passed: false, detail: 'N/A' },
          { name: 'Fibonacci Golden Zone', passed: false, detail: 'disabled' },
        ],
      }),
      0.2,
      'MANUAL',
      0
    );

    expect(report.entryFactors).toEqual([]);
  });

  it('does not label a generic reversal as 15m confirmation without explicit timeframe evidence', () => {
    const generic = analyzeClosedTrade(
      fakePosition({
        reasons: ['Reversal pattern confirmed'],
        entryChecks: [{ name: 'Reversal', passed: true, detail: 'Pattern confirmed' }],
      }),
      0.2,
      'MANUAL',
      0
    );
    expect(generic.entryFactors).not.toContain('15m Ommekeer-bevestiging');

    const unconfirmed = analyzeClosedTrade(
      fakePosition({ reasons: ['15m reversal not confirmed'], entryChecks: [] }),
      0.2,
      'MANUAL',
      0
    );
    expect(unconfirmed.entryFactors).not.toContain('15m Ommekeer-bevestiging');

    const explicit = analyzeClosedTrade(
      fakePosition({
        reasons: ['15m pullback-ommekeer bevestigd'],
        entryChecks: [{ name: '15m Reversal', passed: true, detail: 'Hammer confirmed' }],
      }),
      0.2,
      'MANUAL',
      0
    );
    expect(explicit.entryFactors).toContain('15m Ommekeer-bevestiging');
  });

  it('does not infer 15m attribution from a failed explicit check', () => {
    const report = analyzeClosedTrade(
      fakePosition({
        reasons: ['15m reversal confirmed'],
        entryChecks: [{ name: '15m Reversal', passed: false, detail: 'N/A' }],
      }),
      0.2,
      'MANUAL',
      0
    );

    expect(report.entryFactors).not.toContain('15m Ommekeer-bevestiging');
  });
});
