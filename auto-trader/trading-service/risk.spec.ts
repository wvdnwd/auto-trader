import {
  DEFAULT_RISK,
  concentrationBlock,
  correlationGroup,
  planTrade,
  tradingBlockedReason,
} from './risk.js';
import type { Account, Signal } from './types.js';

const account: Account = {
  balance: 10_000,
  equity: 10_000,
  usedMargin: 0,
  realisedPnl: 0,
  unrealisedPnl: 0,
  startingBalance: 10_000,
  peakEquity: 10_000,
  drawdownPct: 0,
};

const signal: Signal = {
  symbol: 'BTC_USDT',
  side: 'LONG',
  confidence: 0.65,
  regime: 'TREND_UP',
  price: 70_000,
  atrPct: 0.01,
  reasons: ['test'],
  higherRegime: 'TREND_UP',
  alignedWithHigher: true,
  swingLow: NaN,
  swingHigh: NaN,
  roomToStructure: 3,
  checks: [],
  fib: null,
  plannedLeverage: null,
};

describe('trade sizing', () => {
  it('respects the risk, leverage and margin budgets (no stake override)', () => {
    // `targetStakePct` is a deliberate override that is allowed to push margin
    // (and therefore riskPct) above the risk-budget size — see its doc comment
    // on RiskConfig. This test isolates the underlying risk-budget path itself,
    // which must still hold to `maxRiskPct` when that override is not in play.
    const budgetOnly = { ...DEFAULT_RISK, targetStakePct: undefined };
    const plan = planTrade(signal, account, budgetOnly);
    expect(plan).not.toBeNull();
    expect(plan!.riskPct).toBeLessThanOrEqual(budgetOnly.maxRiskPct + 0.0001);
    expect(plan!.leverage).toBeLessThanOrEqual(budgetOnly.maxLeverage);
    // One trade may never exceed its equal share of the portfolio margin budget.
    const perTradeCap = (account.equity * budgetOnly.maxTotalMarginPct) / budgetOnly.maxOpenPositions;
    expect(plan!.margin).toBeLessThanOrEqual(perTradeCap + 0.01);
    expect(plan!.stopLoss).toBeLessThan(plan!.entry);
    expect(plan!.takeProfit).toBeGreaterThan(plan!.entry);
  });

  it('scales the stake between minStakePct and targetStakePct by confidence', () => {
    // Per user request: stake is no longer a flat number — it ranges from
    // `minStakePct` (5%) at `minConfidence` up to `targetStakePct` (20%) at
    // `highConvictionConfidence` (70%+), and is additionally scaled down when
    // leverage runs above the 8x baseline so the dollar risk at the stop does
    // not compound with the leverage.
    const highConviction = { ...signal, confidence: DEFAULT_RISK.highConvictionConfidence };
    const plan = planTrade(highConviction, account, DEFAULT_RISK);
    expect(plan).not.toBeNull();
    const expectedStakePct = (DEFAULT_RISK.targetStakePct as number) * Math.min(1, 8 / plan!.leverage);
    expect(plan!.margin).toBeCloseTo(account.equity * expectedStakePct, 0);
    // Per-trade cap is `targetStakePct` of equity (20%) directly, not the
    // margin budget split evenly across all slots — see doc comment in
    // planTrade on `perTradeCap`.
    const perTradeCap = account.equity * (DEFAULT_RISK.targetStakePct as number);
    expect(plan!.margin).toBeLessThanOrEqual(perTradeCap + 0.01);
    expect(plan!.leverage).toBeLessThanOrEqual(DEFAULT_RISK.maxLeverage);

    // A signal barely past minConfidence stakes much less than one at
    // highConvictionConfidence.
    const barelyIn = { ...signal, confidence: DEFAULT_RISK.minConfidence + 0.001 };
    const lowPlan = planTrade(barelyIn, account, DEFAULT_RISK)!;
    expect(lowPlan.margin).toBeLessThan(plan!.margin);
  });

  it('keeps the stop loss inside the liquidation price', () => {
    // A very volatile market forces a wide stop; leverage must shrink so the
    // stop is always hit before the position would be liquidated.
    const volatile: Signal = { ...signal, atrPct: 0.05, confidence: 0.9 };
    const plan = planTrade(volatile, account, { ...DEFAULT_RISK, maxLeverage: 125 });
    expect(plan).not.toBeNull();
    const stopDistance = Math.abs(plan!.entry - plan!.stopLoss) / plan!.entry;
    const liquidationDistance = 1 / plan!.leverage;
    expect(stopDistance).toBeLessThan(liquidationDistance);
  });

  it('inverts stop and target for shorts', () => {
    const plan = planTrade({ ...signal, side: 'SHORT' }, account, DEFAULT_RISK);
    expect(plan!.stopLoss).toBeGreaterThan(plan!.entry);
    expect(plan!.takeProfit).toBeLessThan(plan!.entry);
  });

  it('rejects low conviction, drained balances and broken input', () => {
    expect(planTrade({ ...signal, confidence: 0.1 }, account, DEFAULT_RISK)).toBeNull();
    expect(planTrade(signal, { ...account, balance: 1, equity: 1 }, DEFAULT_RISK)).toBeNull();
    expect(planTrade({ ...signal, price: 0 }, account, DEFAULT_RISK)).toBeNull();
    expect(planTrade({ ...signal, atrPct: NaN }, account, DEFAULT_RISK)).toBeNull();
  });

  it('halves the risk budget while in drawdown', () => {
    const healthy = planTrade(signal, account, DEFAULT_RISK);
    const drawn = planTrade(signal, { ...account, drawdownPct: 0.15 }, DEFAULT_RISK);
    expect(drawn!.riskPct).toBeLessThan(healthy!.riskPct);
  });
});

describe('take profit ladder', () => {
  it('stages targets that add up to the whole position', () => {
    const plan = planTrade(signal, account, DEFAULT_RISK)!;
    expect(plan.takeProfits.length).toBeGreaterThanOrEqual(2);
    const total = plan.takeProfits.reduce((a, t) => a + t.portion, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(plan.takeProfits.every((t) => !t.hit)).toBe(true);
  });

  it('orders targets outward from entry and ends at the final target', () => {
    const plan = planTrade(signal, account, DEFAULT_RISK)!;
    const prices = plan.takeProfits.map((t) => t.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    expect(prices.every((p) => p > plan.entry)).toBe(true);
    expect(plan.takeProfit).toBe(prices[prices.length - 1]);
  });

  it('mirrors the ladder below entry for shorts', () => {
    const plan = planTrade({ ...signal, side: 'SHORT' }, account, DEFAULT_RISK)!;
    const prices = plan.takeProfits.map((t) => t.price);
    expect(prices.every((p) => p < plan.entry)).toBe(true);
    expect([...prices].sort((a, b) => b - a)).toEqual(prices);
  });

  it('refuses a trade the higher timeframe does not confirm', () => {
    // This is the single most important filter in the profile: every parameter
    // set that performed out-of-sample had it on, and every set without it lost
    // money. Trading against the higher timeframe is where the edge disappears.
    expect(planTrade({ ...signal, alignedWithHigher: false }, account, DEFAULT_RISK)).toBeNull();
    expect(planTrade(signal, account, DEFAULT_RISK)).not.toBeNull();
  });

  it('keeps a runner when the higher timeframe confirms and there is room', () => {
    const confirmed = planTrade(signal, account, DEFAULT_RISK)!;
    expect(confirmed.takeProfits.length).toBe(3);

    // Confirmed but boxed in by nearby structure: no room for a third rung.
    const tight = planTrade({ ...signal, roomToStructure: 1.5 }, account, DEFAULT_RISK)!;
    expect(tight.takeProfits.length).toBe(2);
  });

  it('can still trade unconfirmed setups when the filter is switched off', () => {
    const relaxed = { ...DEFAULT_RISK, requireHigherAlignment: false };
    const plan = planTrade(
      { ...signal, alignedWithHigher: false, roomToStructure: 1.5 },
      account,
      relaxed
    );
    expect(plan).not.toBeNull();
    expect(plan!.takeProfits.length).toBe(2);
  });

  it('takes profit earlier in a range than in a trend', () => {
    const ranging = planTrade({ ...signal, regime: 'RANGE' }, account, DEFAULT_RISK)!;
    const trending = planTrade(signal, account, DEFAULT_RISK)!;
    const lastR = (p: typeof ranging) => p.takeProfits[p.takeProfits.length - 1].rMultiple;
    expect(lastR(ranging)).toBeLessThan(lastR(trending));
  });

  it('anchors the stop behind market structure when a swing is nearby', () => {
    // A swing low 2% below price, within the sane band around the volatility stop.
    const structural = planTrade(
      { ...signal, swingLow: 70_000 * 0.98 },
      account,
      DEFAULT_RISK
    )!;
    const volatilityOnly = planTrade(signal, account, DEFAULT_RISK)!;
    expect(structural.stopLoss).not.toBeCloseTo(volatilityOnly.stopLoss, 2);
    expect(structural.stopLoss).toBeLessThan(70_000 * 0.98);
    expect(structural.reasons.some((r) => r.includes('marktstructuur'))).toBe(true);
  });

  it('boosts leverage in turbo mode beyond maxLeverage when volatility allows', () => {
    const calmSignal = { ...signal, atrPct: 0.005, confidence: 0.85 };
    const normalPlan = planTrade(calmSignal, account, DEFAULT_RISK)!;
    const turboPlan = planTrade(calmSignal, account, { ...DEFAULT_RISK, turboMode: true })!;

    expect(normalPlan.leverage).toBeLessThanOrEqual(DEFAULT_RISK.maxLeverage);
    expect(turboPlan.leverage).toBeGreaterThan(DEFAULT_RISK.maxLeverage);
  });

  it('handles sub-cent meme tokens with dynamic precision without zero-rounding', () => {
    const memeSignal = { ...signal, symbol: 'PEPE_USDT', price: 0.000000012, atrPct: 0.02 };
    const plan = planTrade(memeSignal, account, DEFAULT_RISK);

    expect(plan).not.toBeNull();
    expect(plan!.stopLoss).toBeGreaterThan(0);
    expect(plan!.stopLoss).toBeLessThan(plan!.entry);
    for (const tp of plan!.takeProfits) {
      expect(tp.price).toBeGreaterThan(plan!.entry);
      // Ensure the stop and targets are distinct from entry (not rounded to entry or zero)
      expect(tp.price).not.toBe(plan!.entry);
      expect(plan!.stopLoss).not.toBe(plan!.entry);
    }
  });
});

describe('portfolio gates', () => {
  it('halts trading when a risk limit trips', () => {
    const drawdown = tradingBlockedReason({ ...account, drawdownPct: 0.3 }, 0, 0, DEFAULT_RISK);
    expect(drawdown?.kind).toBe('halt');
    expect(drawdown?.message).toContain('drawdown');

    const daily = tradingBlockedReason(account, 0, -0.1, DEFAULT_RISK);
    expect(daily?.kind).toBe('halt');
    expect(daily?.message).toContain('Daglimiet');
  });

  it('reports a full portfolio as capacity, not as a risk halt', () => {
    expect(tradingBlockedReason(account, DEFAULT_RISK.maxOpenPositions, 0, DEFAULT_RISK)?.kind).toBe(
      'capacity'
    );
    // maxTotalMarginPct is 0.20 (20% of equity) so the budget is $2,000 of
    // the $10,000 equity — use it up entirely to trip this gate.
    const full = account.equity * DEFAULT_RISK.maxTotalMarginPct;
    expect(tradingBlockedReason({ ...account, usedMargin: full }, 0, 0, DEFAULT_RISK)?.kind).toBe(
      'capacity'
    );
  });

  it('allows trading when every gate passes', () => {
    expect(tradingBlockedReason(account, 0, 0, DEFAULT_RISK)).toBeNull();
  });
});

describe('concentration limits', () => {
  it('groups instruments that move together', () => {
    expect(correlationGroup('BTC_USDT')).toBe(correlationGroup('ETH_USDT'));
    expect(correlationGroup('DOGE_USDT')).toBe(correlationGroup('PEPE_USDT'));
    expect(correlationGroup('FLOKI_USDT')).toBe('memes');
    expect(correlationGroup('FARTCOIN_USDT')).toBe('memes');
    expect(correlationGroup('PENGU_USDT')).toBe('memes');
    expect(correlationGroup('POPCAT_USDT')).toBe('memes');
    expect(correlationGroup('1000BONK_USDT')).toBe('memes');
    expect(correlationGroup('SOL_USDT')).toBe('layer1');
    expect(correlationGroup('AVAX_USDT')).toBe('layer1');
    expect(correlationGroup('FET_USDT')).toBe('ai');
    expect(correlationGroup('RENDER_USDT')).toBe('ai');
    expect(correlationGroup('UNI_USDT')).toBe('defi');
    expect(correlationGroup('AAVE_USDT')).toBe('defi');
    expect(correlationGroup('BTC_USDT')).not.toBe(correlationGroup('DOGE_USDT'));
    expect(correlationGroup('ARB_USDT')).toBe('alts');
  });

  it('refuses a book that is entirely one-way once maxSameSidePositions is reached', () => {
    // maxSameSidePositions now matches maxOpenPositions (4) per user request —
    // an all-one-direction book is allowed when every signal agrees, so this
    // only trips once the book is genuinely full on one side.
    const open = Array.from({ length: DEFAULT_RISK.maxSameSidePositions }, (_, i) => ({
      symbol: `SYM${i}_USDT`,
      side: 'LONG' as const,
    }));
    expect(concentrationBlock({ symbol: 'AVAX_USDT', side: 'LONG' }, open, DEFAULT_RISK)).toContain(
      'eenzijdig'
    );
    // The opposite side is still allowed — it reduces net exposure.
    expect(concentrationBlock({ symbol: 'AVAX_USDT', side: 'SHORT' }, open, DEFAULT_RISK)).toBeNull();
  });

  it('does not treat the alts catch-all as a single cluster', () => {
    const open = [
      { symbol: 'ARB_USDT', side: 'LONG' as const },
      { symbol: 'OP_USDT', side: 'LONG' as const },
    ];
    // Capping `alts` like a real cluster would block most of the book, since
    // nearly every altcoin lands in it.
    expect(concentrationBlock({ symbol: 'AVAX_USDT', side: 'SHORT' }, open, DEFAULT_RISK)).toBeNull();
  });

  it('caps how many correlated markets can be held at once', () => {
    const open = [
      { symbol: 'BTC_USDT', side: 'LONG' as const },
      { symbol: 'ETH_USDT', side: 'LONG' as const },
    ];
    expect(concentrationBlock({ symbol: 'BTC_USDT', side: 'SHORT' }, open, DEFAULT_RISK)).toContain(
      'majors'
    );
    // An uncorrelated market is fine.
    expect(concentrationBlock({ symbol: 'ARB_USDT', side: 'SHORT' }, open, DEFAULT_RISK)).toBeNull();
  });

  it('allows the first position in an empty book', () => {
    expect(concentrationBlock({ symbol: 'BTC_USDT', side: 'LONG' }, [], DEFAULT_RISK)).toBeNull();
  });
});
