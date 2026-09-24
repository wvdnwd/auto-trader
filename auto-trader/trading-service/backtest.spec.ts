import { Backtest, replayTimingBlockReason, ticker24hFromCandles, type MarketHistory } from './backtest.js';
import { normaliseConfig } from './backtest-runner.js';
import { rankCandidates } from './candidate-ranking.js';
import { FEE } from './exits.js';
import { DEFAULT_RISK } from './risk.js';
import type { BacktestConfig, BacktestTrade, Candle, Position, Signal } from './types.js';

const STEP = 900;

function candles(fn: (i: number) => number, length = 300, startTime = 1_700_000_000): Candle[] {
  return Array.from({ length }, (_, i) => {
    const close = fn(i);
    return {
      time: startTime + i * STEP,
      open: close * 0.999,
      high: close * 1.005,
      low: close * 0.995,
      close,
      volume: 5_000,
    };
  });
}

function market(symbol: string, fn: (i: number) => number, length = 300): MarketHistory {
  const series = candles(fn, length);
  // The confirmation timeframe samples the same path, so the two agree.
  const higher = series
    .filter((_, i) => i % 4 === 0)
    .map((c) => ({ ...c, time: c.time - (c.time % 3600) }));
  return { symbol, candles: series, higher };
}

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbols: ['X_USDT'],
    interval: 'Min15',
    higherInterval: 'Min60',
    from: 1_700_000_000,
    to: 1_700_000_000 + 300 * STEP,
    startingBalance: 10_000,
    ...overrides,
    risk: {
      microTiming15mEnabled: false,
      reversal15mRequired: false,
      ltfSniper5mEnabled: false,
      ...overrides.risk,
    },
  };
}

function openPosition(symbol = 'X_USDT', overrides: Partial<Position> = {}): Position & { entryBar: number } {
  return {
    id: 'seeded-position',
    symbol,
    side: 'LONG',
    entry: 100,
    quantity: 1,
    leverage: 5,
    margin: 20,
    notional: 100,
    stopLoss: 97,
    takeProfit: 110,
    takeProfits: [],
    remainingQuantity: 1,
    realisedPnl: 0,
    entryFee: 0,
    initialRisk: 3,
    breakEven: false,
    extreme: 100,
    trailingArmed: false,
    openedAt: 1_700_000_000_000,
    status: 'OPEN',
    confidence: 0.8,
    regime: 'TREND_UP',
    reasons: [],
    entryBar: 20,
    ...overrides,
  };
}

function replaySignal(symbol: string, confidence = 0.8): Signal {
  return {
    symbol,
    side: 'LONG',
    confidence,
    regime: 'TREND_UP',
    price: 100,
    atrPct: 0.02,
    reasons: [],
    higherRegime: 'TREND_UP',
    alignedWithHigher: true,
    swingLow: 98,
    swingHigh: 102,
    roomToStructure: 5,
    checks: [],
    fib: null,
    plannedLeverage: null,
  };
}

function intervalCandles(interval: number, length: number, startTime = 1_700_000_000): Candle[] {
  return Array.from({ length }, (_, i) => {
    const close = 100 + i * 0.01;
    return {
      time: startTime + i * interval,
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: i + 1,
    };
  });
}

function timingSignal(): Signal {
  return { ...replaySignal('X_USDT'), timingReady: true, reversalConfirmed: true };
}

function timing15m(time: number): Candle[] {
  return intervalCandles(900, 15, time - 15 * 900);
}

function timing5m(time: number, length = 15): Candle[] {
  const bars = intervalCandles(300, length, time - length * 300);
  const previous = bars[bars.length - 2];
  const last = bars[bars.length - 1];
  bars[bars.length - 2] = { ...previous, open: previous.close - 0.01, high: previous.close + 0.1, low: previous.close - 0.1 };
  bars[bars.length - 1] = { ...last, open: last.close - 0.01, high: last.close + 0.1, low: last.close - 0.1 };
  return bars;
}

describe('backtest replay', () => {
  it('abstains when enabled timing gates have no historical inputs', () => {
    const reason = replayTimingBlockReason(timingSignal(), DEFAULT_RISK, undefined, undefined, 1_700_000_000);

    expect(reason).toContain('15m timing gate abstained');
    expect(reason).toContain('missing');
  });

  it('reuses Min5 and Min15 entry candles as exact timing series', () => {
    const time = 1_700_000_000;
    const fiveMinute = timing5m(time);
    const fifteenMinute = timing15m(time);
    const fiveReplay = new Backtest(
      [{ symbol: 'X_USDT', candles: fiveMinute, higher: [] }],
      config({ interval: 'Min5' })
    );
    const fifteenReplay = new Backtest(
      [{ symbol: 'X_USDT', candles: fifteenMinute, higher: [] }],
      config({ interval: 'Min15' })
    );
    const fiveTiming = fiveReplay as unknown as { timing5mAt(market: MarketHistory, time: number): Candle[] | undefined };
    const fifteenTiming = fifteenReplay as unknown as { timing15mAt(market: MarketHistory, time: number): Candle[] | undefined };

    expect(fiveTiming.timing5mAt({ symbol: 'X_USDT', candles: fiveMinute, higher: [] }, time)).toEqual(fiveMinute);
    expect(fifteenTiming.timing15mAt({ symbol: 'X_USDT', candles: fifteenMinute, higher: [] }, time)).toEqual(fifteenMinute);
  });

  it('reuses only a configured higher series whose interval exactly matches timing', () => {
    const time = 1_700_000_000;
    const fiveMinute = timing5m(time);
    const marketHistory = { symbol: 'X_USDT', candles: [], higher: fiveMinute };
    const exactReplay = new Backtest([marketHistory], config({ interval: 'Min60', higherInterval: 'Min5' }));
    const mismatchedReplay = new Backtest([marketHistory], config({ interval: 'Min60', higherInterval: 'Min15' }));
    const timingAccessor = (replay: Backtest) => replay as unknown as {
      timing5mAt(market: MarketHistory, time: number): Candle[] | undefined;
    };

    expect(timingAccessor(exactReplay).timing5mAt(marketHistory, time)).toEqual(fiveMinute);
    expect(timingAccessor(mismatchedReplay).timing5mAt(marketHistory, time)).toBeUndefined();
  });

  it('excludes future and unclosed rows while retaining closed timing context', () => {
    const time = 1_700_000_000;
    const closed = timing15m(time);
    const source = [
      ...closed,
      { ...closed.at(-1)!, time: time - 300 },
      ...intervalCandles(900, 1, time + 900),
    ];
    const history = { symbol: 'X_USDT', candles: [], higher: [], timing15m: source };
    const replay = new Backtest([history], config());
    const timingAt = (replay as unknown as {
      timing15mAt(market: MarketHistory, time: number): Candle[] | undefined;
    }).timing15mAt.bind(replay);

    const evidence = timingAt(history, time);
    expect(evidence).toHaveLength(closed.length);
    expect(evidence?.at(-1)?.time).toBe(time - 900);
    expect(evidence?.every((candle) => candle.time + 900 <= time)).toBe(true);
  });

  it.each([
    { name: 'invalid', mutate: (bars: Candle[]) => { bars[14] = { ...bars[14], close: Number.NaN }; return bars; }, offset: 0 },
    { name: 'stale', mutate: (bars: Candle[]) => bars, offset: 3_600 },
    { name: 'future', mutate: (bars: Candle[]) => bars, future: true },
    { name: 'unclosed', mutate: (bars: Candle[]) => bars.slice(-1), unclosed: true },
  ])('abstains on $name 15m timing evidence', ({ mutate, offset, future, unclosed }) => {
    const time = 1_700_000_000;
    let bars = mutate(timing15m(time));
    if (future) bars = intervalCandles(900, 15, time + 900);
    if (unclosed) bars = [{ ...bars[14], time: time - 600 }];

    const reason = replayTimingBlockReason(timingSignal(), DEFAULT_RISK, bars, timing5m(time), time + (offset ?? 0));

    expect(reason).toContain('15m timing gate abstained');
  });

  it.each([
    { name: 'invalid', mutate: (bars: Candle[]) => { bars[1] = { ...bars[1], low: Number.NaN }; return bars; }, offset: 0 },
    { name: 'stale', mutate: (bars: Candle[]) => bars, offset: 1_200 },
    { name: 'future', mutate: (bars: Candle[]) => bars, future: true },
    { name: 'unclosed', mutate: (bars: Candle[]) => bars.slice(-1), unclosed: true },
  ])('abstains on $name 5m sniper evidence', ({ mutate, offset, future, unclosed }) => {
    const time = 1_700_000_000;
    const evaluatedAt = time + (offset ?? 0);
    let bars = mutate(timing5m(time));
    if (future) bars = timing5m(time + 600);
    if (unclosed) bars = [{ ...bars[1], time: time - 100 }];

    const reason = replayTimingBlockReason(timingSignal(), DEFAULT_RISK, timing15m(evaluatedAt), bars, evaluatedAt);

    expect(reason).toContain('5m sniper gate abstained');
  });

  it.each([
    {
      name: '5m sniper',
      risk: { ...DEFAULT_RISK, microTiming15mEnabled: false, reversal15mRequired: false, ltfSniper5mEnabled: true },
      signal: timingSignal(),
      reason: '5m sniper gate abstained',
    },
    {
      name: '15m reversal fallback',
      risk: { ...DEFAULT_RISK, microTiming15mEnabled: false, reversal15mRequired: true, ltfSniper5mEnabled: true },
      signal: { ...timingSignal(), reversalConfirmed: false },
      reason: '15m reversal gate lacks a valid 5m fallback',
    },
  ])('$name abstains with only $length contiguous closed Min5 bars', ({ risk, signal, reason }) => {
    const time = 1_700_000_000;
    const timing15 = risk.reversal15mRequired ? timing15m(time) : undefined;

    for (const length of [2, 14]) {
      const blockReason = replayTimingBlockReason(signal, risk, timing15, timing5m(time, length), time);
      expect(blockReason).toContain(reason);
      expect(blockReason).toContain('insufficient closed timing candles');
    }
  });

  it.each([
    {
      name: '5m sniper',
      risk: { ...DEFAULT_RISK, microTiming15mEnabled: false, reversal15mRequired: false, ltfSniper5mEnabled: true },
      signal: timingSignal(),
      reason: '5m sniper gate is not confirmed by closed replay candles',
    },
    {
      name: '15m reversal fallback',
      risk: { ...DEFAULT_RISK, microTiming15mEnabled: false, reversal15mRequired: true, ltfSniper5mEnabled: true },
      signal: { ...timingSignal(), reversalConfirmed: false },
      reason: '15m reversal gate lacks a valid 5m fallback: 5m reversal is unconfirmed',
    },
  ])('$name checks RSI once 15 contiguous closed Min5 bars are available', ({ risk, signal, reason }) => {
    const time = 1_700_000_000;
    const blockReason = replayTimingBlockReason(
      signal,
      risk,
      risk.reversal15mRequired ? timing15m(time) : undefined,
      timing5m(time),
      time
    );

    expect(blockReason).toBe(reason);
  });

  it('only opts out of timing evidence when each risk gate is disabled', () => {
    const risk = {
      ...DEFAULT_RISK,
      microTiming15mEnabled: false,
      reversal15mRequired: false,
      ltfSniper5mEnabled: false,
    };

    expect(replayTimingBlockReason(timingSignal(), risk, undefined, undefined, 1_700_000_000)).toBeNull();
    expect(replayTimingBlockReason(timingSignal(), DEFAULT_RISK, undefined, undefined, 1_700_000_000)).not.toBeNull();
  });

  it('does not enter when the enabled 5m gate has no historical series', () => {
    const history = market('X_USDT', (i) => 100 + i * 0.1);
    const replay = new Backtest([history], config({
      risk: {
        microTiming15mEnabled: true,
        reversal15mRequired: true,
        ltfSniper5mEnabled: true,
      },
    }));
    const internals = replay as unknown as {
      signalAt: (item: MarketHistory, time: number) => Signal | null;
      considerEntries: (time: number, bar: number, prices: Map<string, number>) => void;
      open: Position[];
    };
    internals.signalAt = () => timingSignal();

    internals.considerEntries(1_700_000_000, 0, new Map([['X_USDT', 100]]));

    expect(internals.open).toHaveLength(0);
  });

  it('shares live ranking preference and symbol tie-breaks without mutating confidence', () => {
    const quiet = replaySignal('BBB_USDT', 0.8);
    const spurt = replaySignal('AAA_USDT', 0.75);
    quiet.checks = [{ name: 'Volume Spurt', passed: false, detail: '' }];
    spurt.checks = [{ name: 'Volume Spurt', passed: true, detail: '' }];

    expect(rankCandidates([quiet, spurt]).map((signal) => signal.symbol)).toEqual(['AAA_USDT', 'BBB_USDT']);
    expect(spurt.confidence).toBe(0.75);
    expect(rankCandidates([replaySignal('Z_USDT'), replaySignal('A_USDT')]).map((s) => s.symbol)).toEqual([
      'A_USDT', 'Z_USDT',
    ]);
  });

  it.each([
    { interval: 60, name: '1m' },
    { interval: 300, name: '5m' },
  ])('does not create 24h ticker metadata from incomplete $name history', ({ interval }) => {
    const history = intervalCandles(interval, 140);

    expect(ticker24hFromCandles('X_USDT', history, history.length - 1, history.at(-1)!.time + interval, interval)).toBeNull();
  });

  it.each([
    { interval: 60, bars: 1_440 },
    { interval: 300, bars: 288 },
  ])('derives complete 24h metadata from contiguous $interval-second fixtures', ({ interval, bars }) => {
    const history = intervalCandles(interval, bars + 1);
    const index = history.length - 1;
    const time = history[index].time + interval;
    const ticker = ticker24hFromCandles('X_USDT', history, index, time, interval);
    const expectedVolume = history.slice(1).reduce((sum, candle) => sum + candle.volume * candle.close, 0);

    expect(ticker?.quoteVolume24h).toBeCloseTo(expectedVolume, 6);
    expect(ticker?.changeRate24h).toBeCloseTo((history[index].close - history[0].close) / history[0].close, 10);
    expect(ticker?.lastPrice).toBe(history[index].close);
  });

  it('rejects gaps in the trailing 24h candle history', () => {
    const history = intervalCandles(300, 289);
    history[120] = { ...history[120], time: history[120].time + 1 };

    expect(ticker24hFromCandles('X_USDT', history, history.length - 1, history.at(-1)!.time + 300, 300)).toBeNull();
  });

  it('enforces global entry cooldown on simulated time and deterministic same-bar order', () => {
    const markets = [market('BBB_USDT', (i) => 100 + i * 0.1), market('AAA_USDT', (i) => 100 + i * 0.1)];
    const replay = new Backtest(
      markets,
      config({ symbols: markets.map((item) => item.symbol), risk: { entryCooldownMinutes: 10, maxOpenPositions: 4 } })
    );
    const internals = replay as unknown as {
      signalAt: (item: MarketHistory, time: number) => Signal | null;
      considerEntries: (time: number, bar: number, prices: Map<string, number>) => void;
      open: (Position & { entryBar: number })[];
    };
    internals.signalAt = (item) => replaySignal(item.symbol);
    const time = 1_700_000_000;
    const prices = new Map([['AAA_USDT', 100], ['BBB_USDT', 100]]);

    internals.considerEntries(time, 0, prices);
    expect(internals.open.map((position) => position.symbol)).toEqual(['AAA_USDT']);

    internals.considerEntries(time + 599, 1, prices);
    expect(internals.open).toHaveLength(1);
    internals.considerEntries(time + 600, 2, prices);
    expect(internals.open.map((position) => position.symbol)).toEqual(['AAA_USDT', 'BBB_USDT']);
  });

  it('uses candle close times and limits replay to the requested window', () => {
    const from = 1_700_000_000 + 100 * STEP;
    const to = 1_700_000_000 + 150 * STEP;
    const result = new Backtest(
      [market('X_USDT', (i) => 100 + i * 0.1)],
      config({ from, to })
    ).run();

    expect(result.startedAt).toBe(from);
    expect(result.endedAt).toBe(to);
    expect(result.bars).toBe(51);
    expect(result.equityCurve[0].time).toBe(from);
  });

  it('abstains from replay signals when the closed-volume ratio is unavailable', () => {
    const history = market('X_USDT', (i) => 100 + i * 0.1);
    const index = 100;
    history.candles[index - 1] = { ...history.candles[index - 1], volume: Number.NaN };
    const replay = new Backtest([history], config());
    const signalAt = (replay as unknown as {
      signalAt(market: MarketHistory, time: number): unknown;
    }).signalAt.bind(replay);
    const time = history.candles[index].time + STEP;

    expect(signalAt(history, time)).toBeNull();
  });

  it('fills a protective stop at the opening price after a gap through it', () => {
    const history = market('X_USDT', (i) => 100 + i * 0.1);
    const index = 80;
    history.candles[index] = { ...history.candles[index], open: 90, high: 92, low: 89, close: 91 };
    const replay = new Backtest([history], config());
    const internals = replay as unknown as {
      open: (Position & { entryBar: number })[];
      closed: BacktestTrade[];
      manageExits: (time: number, prices: Map<string, number>, bar: number) => void;
    };
    internals.open.push(openPosition());

    const candle = history.candles[index];
    internals.manageExits(candle.time + STEP, new Map(), index);

    expect(internals.closed[0].exitReason).toBe('STOP_LOSS');
    expect(internals.closed[0].exit).toBe(90);
  });

  it('assumes a stop before a take-profit when both are crossed intrabar', () => {
    const history = market('X_USDT', (i) => 100 + i * 0.1);
    const index = 80;
    history.candles[index] = { ...history.candles[index], open: 100, high: 110, low: 96, close: 102 };
    const replay = new Backtest([history], config());
    const internals = replay as unknown as {
      open: (Position & { entryBar: number })[];
      closed: BacktestTrade[];
      manageExits: (time: number, prices: Map<string, number>, bar: number) => void;
    };
    internals.open.push(openPosition());

    const candle = history.candles[index];
    internals.manageExits(candle.time + STEP, new Map(), index);

    expect(internals.closed[0].exitReason).toBe('STOP_LOSS');
    expect(internals.closed[0].exit).toBe(97);
  });

  it('checks a stop armed by the favorable extreme against the same bar low', () => {
    const history = market('X_USDT', (i) => 100 + i * 0.1);
    const index = 80;
    history.candles[index] = { ...history.candles[index], open: 100, high: 104, low: 101, close: 102 };
    const replay = new Backtest([history], config({ risk: { trailArmR: 1, trailGiveback: 0.6 } }));
    const internals = replay as unknown as {
      open: (Position & { entryBar: number })[];
      closed: BacktestTrade[];
      manageExits: (time: number, prices: Map<string, number>, bar: number) => void;
    };
    internals.open.push(openPosition());

    const candle = history.candles[index];
    internals.manageExits(candle.time + STEP, new Map(), index);

    expect(internals.closed[0].exitReason).toBe('TRAILING_STOP');
    expect(internals.closed[0].exit).toBeCloseTo(102.2);
  });

  it('does not settle a missing market at its entry price', () => {
    const replay = new Backtest([market('X_USDT', (i) => 100 + i * 0.1)], config());
    (replay as unknown as { open: Position[] }).open.push(openPosition('MISSING_USDT'));

    expect(() => replay.run()).toThrow('geen afsluitprijs beschikbaar voor MISSING_USDT');
  });

  it('does not settle a position from a stale final market candle', () => {
    const fresh = market('X_USDT', (i) => 100 + i * 0.1);
    const stale = market('STALE_USDT', (i) => 100 + i * 0.1, 200);
    const replay = new Backtest([fresh, stale], config({ symbols: [fresh.symbol, stale.symbol] }));
    (replay as unknown as { open: Position[] }).open.push(
      openPosition(stale.symbol, {
        stopLoss: 1,
        initialRisk: 99,
        openedAt: (1_700_000_000 + 300 * STEP) * 1000,
      })
    );

    expect(() => replay.run()).toThrow('verouderde afsluitprijs voor STALE_USDT');
  });

  it('produces a complete result on a trending market', () => {
    const result = new Backtest([market('X_USDT', (i) => 100 + i * 0.4)], config()).run();
    expect(result.bars).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(result.bars);
    expect(result.finalEquity).toBeGreaterThan(0);
    // Every closed trade must be fully described — an empty log with a non-zero
    // trade count would mean the summary and the ledger disagree.
    expect(result.tradeLog.length).toBe(result.trades);
  });

  it('never leaves a position open when the run ends', () => {
    const result = new Backtest([market('X_USDT', (i) => 100 + i * 0.4)], config()).run();
    const last = result.equityCurve[result.equityCurve.length - 1];
    expect(last.openPositions).toBe(0);
  });

  it('keeps the ledger consistent with the equity curve', () => {
    const result = new Backtest([market('X_USDT', (i) => 100 + i * 0.35)], config()).run();
    const summed = result.tradeLog.reduce((a, t) => a + t.pnl, 0);
    // Final equity must equal the starting balance plus the sum of every trade.
    // Any drift here means margin or booked profit is being double counted.
    expect(result.finalEquity).toBeCloseTo(result.startingBalance + summed, 1);
  });

  it('computes Sharpe from the final settlement-adjusted equity curve', () => {
    const history = market('X_USDT', () => 100);
    const replay = new Backtest([history], config());
    (replay as unknown as { open: (Position & { entryBar: number })[] }).open.push(
      openPosition('X_USDT', {
        stopLoss: 1,
        initialRisk: 99,
        takeProfits: [],
        openedAt: (1_700_000_000 + 295 * STEP) * 1000,
      })
    );

    const result = replay.run();
    const returns = result.equityCurve.map((point, index) => {
      const previous = index ? result.equityCurve[index - 1].equity : result.startingBalance;
      return (point.equity - previous) / previous;
    });
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const expected = (mean / Math.sqrt(variance)) * Math.sqrt((365 * 86_400) / STEP);

    expect(result.equityCurve.at(-1)?.openPositions).toBe(0);
    expect(result.tradeLog.at(-1)?.exitReason).toBe('MANUAL');
    expect(result.equityCurve.at(-1)?.equity).toBeLessThan(result.equityCurve.at(-2)!.equity);
    expect(result.sharpe).toBeCloseTo(expected, 1);
  });

  it('assumes the stop filled first when a bar spans both stop and target', () => {
    // A market that rips up and then collapses through the stop inside the window.
    const whipsaw = market('X_USDT', (i) => (i < 200 ? 100 + i * 0.4 : 180 - (i - 200) * 3));
    const result = new Backtest([whipsaw], config()).run();
    const optimistic = result.tradeLog.filter(
      (t) => t.exitReason === 'TAKE_PROFIT' && t.rMultiple < 0
    );
    // A take-profit can never book a negative R — that would mean the fill was
    // credited at a price the market reached only after the stop was breached.
    expect(optimistic).toHaveLength(0);
  });

  it('charges fees on every trade', () => {
    const free = new Backtest(
      [market('X_USDT', (i) => 100 + i * 0.4)],
      config({ feeRate: 0 })
    ).run();
    const charged = new Backtest(
      [market('X_USDT', (i) => 100 + i * 0.4)],
      config({ feeRate: 0.002 })
    ).run();
    if (charged.trades > 0) {
      expect(charged.finalEquity).toBeLessThan(free.finalEquity);
    }
  });

  it('uses configured fees for risk-constrained replay sizing and entry accounting', () => {
    const configuredFee = 0.02;
    expect(configuredFee).not.toBe(FEE);

    const enter = (feeRate?: number) => {
      const replay = new Backtest(
        [market('X_USDT', (i) => 100 + i * 0.1)],
        feeRate === undefined ? config() : config({ feeRate })
      );
      const internals = replay as unknown as {
        signalAt: (item: MarketHistory, time: number) => Signal | null;
        considerEntries: (time: number, bar: number, prices: Map<string, number>) => void;
        open: (Position & { entryBar: number })[];
        balance: number;
        realised: number;
      };
      internals.signalAt = () => replaySignal('X_USDT');
      internals.considerEntries(1_700_000_000, 0, new Map([['X_USDT', 100]]));
      return { position: internals.open[0], balance: internals.balance, realised: internals.realised };
    };

    const defaultFee = enter();
    const configured = enter(configuredFee);
    const risk = { ...DEFAULT_RISK, ...config().risk };
    const riskBudget = 10_000 * Math.min(risk.maxRiskPct, risk.baseRiskPct * (0.5 + 0.8));
    const lossAtStop = Math.abs(configured.position.entry - configured.position.stopLoss) /
      configured.position.entry +
      configuredFee * (configured.position.entry + configured.position.stopLoss) / configured.position.entry;
    const entryFee = configured.position.notional * configuredFee;

    expect(configured.position.notional).toBeLessThan(defaultFee.position.notional);
    expect(configured.position.notional * lossAtStop).toBeLessThanOrEqual(riskBudget + 0.01);
    expect(configured.position.entryFee).toBeCloseTo(entryFee, 8);
    expect(configured.balance).toBeCloseTo(10_000 - configured.position.margin - entryFee, 8);
    expect(configured.realised).toBeCloseTo(-entryFee, 8);
  });

  it('uses the configured fee when a replay partial fill protects the remaining position', () => {
    const feeRate = 0.02;
    const history = market('X_USDT', (i) => 100 + i * 0.1);
    const index = 80;
    history.candles[index] = { ...history.candles[index], open: 100, high: 106, low: 104.5, close: 105 };
    const replay = new Backtest([history], config({
      feeRate,
      risk: { breakEvenAfterFirst: true, breakEvenBufferR: 0, trailArmR: 100 },
    }));
    const internals = replay as unknown as {
      open: (Position & { entryBar: number })[];
      manageExits: (time: number, prices: Map<string, number>, bar: number) => void;
    };
    internals.open.push(openPosition('X_USDT', {
      takeProfits: [
        { price: 105, portion: 0.4, rMultiple: 2, hit: false },
        { price: 110, portion: 0.6, rMultiple: 3, hit: false },
      ],
      takeProfit: 110,
    }));

    internals.manageExits(history.candles[index].time + STEP, new Map(), index);

    expect(internals.open[0].stopLoss).toBeCloseTo(100 * (1 + feeRate) / (1 - feeRate), 12);
  });

  it('reports drawdown as a positive fraction that never exceeds one', () => {
    const result = new Backtest(
      [market('X_USDT', (i) => 100 + Math.sin(i / 9) * 25)],
      config()
    ).run();
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdownPct).toBeLessThanOrEqual(1);
    expect(result.equityCurve.every((p) => p.drawdownPct >= 0)).toBe(true);
  });

  it('respects the maximum open position limit at every bar', () => {
    const markets = ['A_USDT', 'B_USDT', 'C_USDT', 'D_USDT', 'E_USDT'].map((s, n) =>
      market(s, (i) => 100 + i * (0.3 + n * 0.05))
    );
    const result = new Backtest(
      markets,
      config({ symbols: markets.map((m) => m.symbol), risk: { maxOpenPositions: 2 } })
    ).run();
    expect(result.equityCurve.every((p) => p.openPositions <= 2)).toBe(true);
  });

  it('reports identical statistics in lean mode', () => {
    const series = () => [market('X_USDT', (i) => 100 + Math.sin(i / 11) * 18 + i * 0.25)];
    const full = new Backtest(series(), config()).run();
    const lean = new Backtest(series(), config(), true).run();

    // Lean mode exists purely to save memory during a parameter search. If it
    // changed any statistic, the optimizer would be selecting on different
    // numbers than the ones the user sees on the backtest tab.
    expect(lean.finalEquity).toBeCloseTo(full.finalEquity, 2);
    expect(lean.trades).toBe(full.trades);
    expect(lean.expectancyR).toBeCloseTo(full.expectancyR, 3);
    expect(lean.maxDrawdownPct).toBeCloseTo(full.maxDrawdownPct, 4);
    expect(lean.sharpe).toBeCloseTo(full.sharpe, 1);
    expect(lean.winRate).toBeCloseTo(full.winRate, 4);
    // ...while dropping the heavy payload.
    expect(lean.equityCurve).toHaveLength(0);
    expect(lean.tradeLog).toHaveLength(0);
  });

  it('splits the result into months that reconcile with the trade log', () => {
    // ~80 days of 15m bars with repeated up-legs, so the run spans several
    // calendar months and closes trades in more than one of them.
    const bars = 8000;
    const long = market(
      'X_USDT',
      (i) => 100 + Math.sin(i / 400) * 60 + (i % 1200) * 0.08,
      bars
    );
    const result = new Backtest([long], config({ to: 1_700_000_000 + bars * STEP })).run();

    expect(result.monthly.length).toBeGreaterThan(1);
    // The months must account for every dollar the trade log booked, otherwise
    // the consistency panel would tell a different story than the headline.
    const monthSum = result.monthly.reduce((a, m) => a + m.pnl, 0);
    const tradeSum = result.tradeLog.reduce((a, t) => a + t.pnl, 0);
    expect(monthSum).toBeCloseTo(tradeSum, 1);
    expect(result.monthly.reduce((a, m) => a + m.trades, 0)).toBe(result.trades);
    // Sorted oldest first, so the UI can render them straight through.
    const keys = result.monthly.map((m) => m.month);
    expect([...keys].sort()).toEqual(keys);
    expect(result.positiveMonthRate).toBeGreaterThanOrEqual(0);
    expect(result.positiveMonthRate).toBeLessThanOrEqual(1);
  });

  it('does not report a best-month share for a losing run', () => {
    // A steadily falling market the long-biased strategy cannot profit from.
    const result = new Backtest([market('X_USDT', (i) => 200 - i * 0.3)], config()).run();
    if (result.finalEquity < result.startingBalance) {
      // A ratio against a negative total would read as a large positive number
      // and wrongly imply concentration, so it is suppressed instead.
      expect(result.bestMonthShare).toBe(0);
    }
  });

  it('throws instead of silently returning nothing when there is no data', () => {
    expect(() => new Backtest([{ symbol: 'X_USDT', candles: [], higher: [] }], config()).run()).toThrow();
  });
});

describe('backtest configuration', () => {
  it('fills in sensible defaults', () => {
    const cfg = normaliseConfig({ symbols: ['BTC_USDT'] });
    expect(cfg.interval).toBe('Min15');
    expect(cfg.startingBalance).toBeGreaterThan(0);
    expect(cfg.to).toBeGreaterThan(cfg.from);
  });

  it('rejects a window that cannot produce a signal', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => normaliseConfig({ symbols: ['BTC_USDT'], from: now - 600, to: now })).toThrow();
    expect(() => normaliseConfig({ symbols: [] })).toThrow();
    expect(() =>
      normaliseConfig({ symbols: ['BTC_USDT'], interval: 'Min7' as string })
    ).toThrow();
  });
});
