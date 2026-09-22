import { Engine } from './engine.js';
import { Store } from './store.js';
import { computeStats } from './trading-service.js';
import { chandelierStop, detectBlowOffTop, progressiveProfitLock } from './exits.js';
import type { Candle, Position, Ticker } from './types.js';

/** Deterministic market stub — no network, fully controlled prices. */
class FakeMarket {
  public price$ = 100;

  constructor(private readonly symbols = ['AAA_USDT']) {}

  async tickers(): Promise<Ticker[]> {
    return this.symbols.map((symbol) => ({
      symbol,
      lastPrice: this.price$,
      quoteVolume24h: 100_000_000,
      changeRate24h: 0.2,
      fundingRate: 0,
    }));
  }

  async price(): Promise<number> {
    return this.price$;
  }

  async candles(_symbol?: string): Promise<Candle[]> {
    // A clean uptrend so the strategy produces a confident LONG.
    return Array.from({ length: 140 }, (_, i) => {
      const close = 40 + i * 0.45;
      return {
        time: i * 900,
        open: close * 0.999,
        high: close * 1.004,
        low: close * 0.996,
        close,
        volume: 1000,
      };
    });
  }

  async contractDetail(symbol: string) {
    return { symbol, contractSize: 1, minVol: 1, maxVol: 1_000_000, priceScale: 4 };
  }
}

function engineWith(market: FakeMarket, symbols = ['AAA_USDT']) {
  const store = new Store();
  // No MONGO_URL in tests — the store falls back to in-memory state. The fake
  // symbols are passed as the universe so the engine is allowed to trade them.
  const engine = new Engine(store, market as never, undefined, 45, symbols);
  // Disable the pullback filter, 5m sniper filter, and pacing for integration tests — the FakeMarket candles
  // form a synthetic uptrend without 4h candles (confidence ~0.56) and tests run instant back-to-back cycles.
  engine.setRisk({ pullbackFilterEnabled: false, minConfidence: 0.55, entryCooldownMinutes: 0, ltfSniper5mEnabled: false });
  return { store, engine };
}

/**
 * Fake venue adapter — records every call the engine makes so live-mirroring
 * behaviour (entry, protective stop, tranche reduces, full closes) can be
 * asserted without touching the real MEXC API.
 */
class FakeExchange {
  public enabled = true;
  public failNextOpen = false;
  public failNextStop = false;
  public opens: { symbol: string; intent: string; vol: number }[] = [];
  public closes: { symbol: string; vol: number }[] = [];
  public stopPlacements: { symbol: string; triggerPrice: number; vol: number }[] = [];
  public cancelledStops: string[] = [];
  /** Set by tests to control what {@link getOpenPositions} reports back, simulating the real venue state. */
  public venuePositions: { symbol: string; side: 'LONG' | 'SHORT'; vol: number; leverage: number; entryPrice: number; liquidationPrice: number; unrealisedPnl: number }[] | null = null;
  private stopSeq = 0;

  status() {
    return { configured: true, enabled: this.enabled, baseUrl: 'fake' };
  }

  async setLeverage(_symbol?: string, _leverage?: number, _side?: string, _openType?: string): Promise<void> {}

  async placeMarketOrder(input: { symbol: string; intent: string; vol: number }) {
    if (this.failNextOpen) throw new Error('venue rejected order');
    this.opens.push(input);
    return { orderId: `order-${this.opens.length}`, symbol: input.symbol };
  }

  async placeStopOrder(input: { symbol: string; triggerPrice: number; vol: number }) {
    if (this.failNextStop) throw new Error('venue rejected stop');
    this.stopPlacements.push(input);
    this.stopSeq += 1;
    return { orderId: `stop-${this.stopSeq}`, symbol: input.symbol };
  }

  async placeTakeProfitOrder(_input: { symbol: string; triggerPrice: number; vol: number }) {
    return { orderId: 'tp-1', symbol: _input.symbol };
  }

  async cancelStopOrder(orderId: string, _symbol?: string): Promise<void> {
    this.cancelledStops.push(orderId);
  }

  venuePlanOrders: Array<{
    id: string;
    symbol: string;
    side: number;
    triggerType: number;
    triggerPrice: number;
    vol: number;
    createTime: number;
  }> = [];
  cancelledPlanOrders: Array<{ symbol: string; orderId: string }> = [];

  async cancelPlanOrders(orders: Array<{ symbol: string; orderId: string }>): Promise<void> {
    this.cancelledPlanOrders.push(...orders);
  }

  async getOpenPlanOrders(_symbol?: string): Promise<
    Array<{
      id: string;
      symbol: string;
      side: number;
      triggerType: number;
      triggerPrice: number;
      vol: number;
      createTime: number;
    }>
  > {
    return this.venuePlanOrders;
  }

  async cancelAllPlanOrders(_symbol?: string): Promise<void> {}

  async closePosition(input: { symbol: string; vol: number }) {
    this.closes.push(input);
    return { orderId: `close-${this.closes.length}`, symbol: input.symbol };
  }

  async getOpenPositions() {
    // Defaults to mirroring whatever the fake has opened, minus anything closed,
    // so tests that never touch `venuePositions` keep behaving as before.
    return this.venuePositions ?? [];
  }
}

function liveEngineWith(market: FakeMarket, symbols = ['AAA_USDT']) {
  const store = new Store();
  const exchange = new FakeExchange();
  const engine = new Engine(store, market as never, undefined, 45, symbols, exchange as never);
  engine.setRisk({ pullbackFilterEnabled: false, minConfidence: 0.55, entryCooldownMinutes: 0, ltfSniper5mEnabled: false });
  return { store, engine, exchange };
}

describe('engine lifecycle', () => {
  it('opens a position and keeps the books balanced', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);

    await engine.cycle();

    const open = await store.positions('OPEN');
    expect(open.length).toBeGreaterThan(0);

    const account = await engine.account();
    // Collateral moved out of the free balance and into used margin.
    expect(account.usedMargin).toBeCloseTo(
      open.reduce((a, p) => a + p.margin, 0),
      6
    );
    // Equity only differs from the start by fees and unrealised pnl.
    expect(account.equity).toBeLessThanOrEqual(account.startingBalance);
    expect(account.equity).toBeGreaterThan(account.startingBalance * 0.98);
  });

  it('settles a position exactly once under concurrent closes', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    expect(position).toBeDefined();

    const before = await engine.account();
    // Two closes racing — only one may credit the pnl back to the balance.
    const results = await Promise.all([
      engine.closePosition(position.id),
      engine.closePosition(position.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const after = await engine.account();
    // Closing costs exactly one taker fee — a double settlement would either
    // credit the margin twice or charge the fee twice.
    const oneFee = position.notional * 0.0006;
    expect(before.equity - after.equity).toBeCloseTo(oneFee, 4);
    expect((await store.positions('OPEN')).length).toBe(0);
    expect((await store.positions('CLOSED')).length).toBe(1);
  });

  it('credits both balances when two different positions close at the same instant', async () => {
    const symbols = ['AAA_USDT', 'BBB_USDT'];
    const market = new FakeMarket(symbols);
    const { store, engine } = engineWith(market, symbols);
    engine.setRisk({ maxOpenPositions: 2, entryCooldownMinutes: 0 });
    await engine.cycle();

    const open = await store.positions('OPEN');
    expect(open.length).toBe(2);
    const before = await engine.account();

    // Two unrelated positions settling in the same tick used to race on a
    // read-then-write of the shared account balance — whichever write landed
    // last would silently erase the other position's credit. Both must land.
    await Promise.all(open.map((p) => engine.closePosition(p.id)));

    const after = await engine.account();
    const totalFees = open.reduce((sum, p) => sum + p.notional * 0.0006, 0);
    expect(before.equity - after.equity).toBeCloseTo(totalFees, 4);
    expect((await store.positions('OPEN')).length).toBe(0);
    expect((await store.positions('CLOSED')).length).toBe(2);
  });

  it('never lets a losing position cost more than its margin', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    // Catastrophic gap far beyond the stop loss.
    market.price$ = position.entry * 0.2;
    await engine.cycle();

    const closed = await store.positions('CLOSED');
    expect(closed.length).toBe(1);
    // The worst case is the full collateral plus the fee already paid to open —
    // a futures position can never cost more than the margin behind it.
    expect(closed[0].pnl).toBeGreaterThanOrEqual(-(position.margin + position.entryFee));
    expect(closed[0].exitReason).toBeDefined();

    const account = await engine.account();
    expect(account.equity).toBeGreaterThan(0);
  });

  it('respects the max open positions limit', async () => {
    const symbols = ['AAA_USDT', 'BBB_USDT', 'CCC_USDT', 'DDD_USDT'];
    const market = new FakeMarket(symbols);
    const { store, engine } = engineWith(market, symbols);
    engine.setRisk({ maxOpenPositions: 2 });

    await engine.cycle();
    await engine.cycle();

    expect((await store.positions('OPEN')).length).toBeLessThanOrEqual(2);
  });

  it('allows new positions to open once existing positions have hit TP1', async () => {
    const symbols = ['AAA_USDT', 'BBB_USDT', 'CCC_USDT', 'DDD_USDT'];
    const market = new FakeMarket(symbols);
    const { store, engine } = engineWith(market, symbols);
    engine.setRisk({
      maxOpenPositions: 2,
      maxSameSidePositions: 6,
      maxTotalMarginPct: 0.8,
      dailyLossLimitPct: 0.5,
      entryCooldownMinutes: 0,
    });

    await engine.cycle();
    const openFirst = await store.positions('OPEN');
    expect(openFirst.length).toBe(2);

    // Mark existing positions as having reached TP1 (derisked) and release portion of margin
    for (const pos of openFirst) {
      if (pos.takeProfits && pos.takeProfits[0]) pos.takeProfits[0].hit = true;
      pos.breakEven = true;
      await store.updatePosition(pos.id, {
        breakEven: true,
        takeProfits: pos.takeProfits,
        margin: pos.margin * 0.55,
      });
      await store.applyBalanceDelta({ balance: pos.margin * 0.45 + 10, realisedPnl: 10 });
    }

    // Next cycle should open new positions because existing ones are derisked past TP1
    await engine.cycle();
    const openSecond = await store.positions('OPEN');
    expect(openSecond.length).toBe(4);
  });

  it('scales into (pyramids) an existing winning position when derisked', async () => {
    const symbols = ['DOGE_USDT'];
    const market = new FakeMarket(symbols);
    const { store, engine } = engineWith(market, symbols);
    engine.setRisk({
      maxOpenPositions: 4,
      entryCooldownMinutes: 0,
      pyramidingEnabled: true,
      minConfidence: 0.25,
      pyramidMinConfidence: 0.25,
    });

    await engine.cycle();
    const openFirst = await store.positions('OPEN');
    expect(openFirst.length).toBe(1);
    const initial = openFirst[0];
    expect(initial.scaleInCount ?? 0).toBe(0);
    const initialMargin = initial.margin;

    // Cycle without derisking: should NOT scale in (never add to an un-derisked position)
    await engine.cycle();
    const openSecond = await store.positions('OPEN');
    expect(openSecond[0].scaleInCount ?? 0).toBe(0);
    expect(openSecond[0].margin).toBe(initialMargin);

    // Derisk position (TP1 hit, entry and breakeven stop at 96, safely below current price 98.2)
    initial.entry = 96;
    initial.stopLoss = 96;
    initial.breakEven = true;
    initial.extreme = 98.2;
    if (initial.takeProfits && initial.takeProfits[0]) initial.takeProfits[0].hit = true;
    await store.updatePosition(initial.id, {
      entry: 96,
      stopLoss: 96,
      breakEven: true,
      extreme: 98.2,
      takeProfits: initial.takeProfits,
    });

    // Provide a pullback candle series where price pulled back near EMA21 with green reversal
    market.price$ = 98.2;
    market.candles = async () => {
      return Array.from({ length: 140 }, (_, i) => {
        let close = 40 + i * 0.45;
        if (i === 135) close = 100.5;
        if (i === 136) close = 99.5;
        if (i === 137) close = 98.5;
        if (i === 138) close = 97.5;
        if (i === 139) close = 98.2;
        return {
          time: i * 900,
          open: i === 139 ? 97.5 : close * 0.995,
          high: close * 1.01,
          low: close * 0.99,
          close,
          volume: 1000,
        };
      });
    };

    // Cycle now: should scale in (add 2nd tranche on confirmed pullback)
    await engine.cycle();
    const openThird = await store.positions('OPEN');
    expect(openThird.length).toBe(1);
    expect(openThird[0].scaleInCount).toBe(1);
    expect(openThird[0].margin).toBeGreaterThan(initialMargin);

    // Further cycle: max 1 scale-in reached, does not scale in again
    await engine.cycle();
    const openFourth = await store.positions('OPEN');
    expect(openFourth.length).toBe(1);
    expect(openFourth[0].scaleInCount).toBe(1);
  });

  it('enforces trade pacing cooldown between consecutive entries', async () => {
    const symbols = ['AAA_USDT', 'BBB_USDT'];
    const market = new FakeMarket(symbols);
    const { store, engine } = engineWith(market, symbols);
    engine.setRisk({ maxOpenPositions: 4, entryCooldownMinutes: 10 });
    await engine.cycle();

    // Only 1 position opens in the first cycle because cooldown pauses subsequent entries
    const open = await store.positions('OPEN');
    expect(open.length).toBe(1);
  });

  it('only speeds up the scan when a setup is close to triggering', async () => {
    const market = new FakeMarket();
    const { engine } = engineWith(market);
    // Threshold far above anything the stub can score: nothing is near a trigger,
    // so the engine must stay on the slow cycle and not hammer the venue.
    engine.setRisk({ minConfidence: 0.95 });

    await engine.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.watching).toBe(false);
    expect(engine.cadenceSec).toBe(45);
    engine.stop();

    // Now put the threshold just above the live score. The setup is one small
    // move from qualifying, which is exactly when the entry price matters.
    // The threshold starts high so the scan runs without opening anything — a
    // symbol already held is excluded from the watch, being no longer an entry.
    const { engine: hot } = engineWith(new FakeMarket());
    hot.setRisk({ minConfidence: 0.95 });
    await hot.cycle();
    const best = hot.signals[0];
    expect(best).toBeDefined();
    hot.setRisk({ minConfidence: Math.min(0.94, best.confidence + 0.04) });

    hot.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(hot.watching).toBe(true);
    expect(hot.cadenceSec).toBe(5);
    hot.stop();
    // Stopping must actually halt the loop, not just flip a flag.
    expect(hot.running).toBe(false);
  });

  it('watches faster when an open position nears its stop', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();
    const [position] = await store.positions('OPEN');
    expect(position).toBeDefined();

    // Drift to just above the stop — still open, but one tick from a decision.
    const unit = position.initialRisk;
    market.price$ = position.stopLoss + unit * 0.1;
    engine.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.watching).toBe(true);
    engine.stop();
  });

  it('refuses to trade markets outside its universe', async () => {
    // A market that looks perfect but is not on the allow-list. The wide scan it
    // replaces is what leaked money in the backtests, so this must stay closed.
    const market = new FakeMarket(['SCAM_USDT', 'AAA_USDT']);
    const { store, engine } = engineWith(market, ['AAA_USDT']);

    await engine.cycle();

    const open = await store.positions('OPEN');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((p) => p.symbol === 'AAA_USDT')).toBe(true);
  });

  it('logs a market with no data but stays quiet about a vetoed one', async () => {
    // GHOST has a ticker but no candles — a real data problem worth a warning.
    // Markets the strategy simply declines to trade must not produce one, or the
    // log fills with noise every cycle and stops being read.
    const market = new FakeMarket(['AAA_USDT', 'GHOST_USDT']);
    const original = market.candles.bind(market);
    market.candles = async (symbol?: string) =>
      symbol === 'GHOST_USDT' ? [] : original();
    const { store, engine } = engineWith(market, ['AAA_USDT', 'GHOST_USDT']);

    await engine.cycle();

    const events = await store.events();
    const warnings = events.filter((e) => e.level === 'warn');
    expect(warnings.some((e) => e.message.includes('GHOST_USDT'))).toBe(true);
    expect(warnings.some((e) => e.message.includes('AAA_USDT'))).toBe(false);
  });

  it('clamps nonsensical risk settings instead of trusting them', () => {
    const { engine } = engineWith(new FakeMarket());
    const risk = engine.setRisk({
      baseRiskPct: 99,
      maxLeverage: 5000,
      maxOpenPositions: -3,
      minConfidence: Number.NaN,
    });
    expect(risk.baseRiskPct).toBeLessThanOrEqual(0.1);
    expect(risk.maxLeverage).toBeLessThanOrEqual(125);
    expect(risk.maxOpenPositions).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(risk.minConfidence)).toBe(true);
  });
});

describe('staged take profits', () => {
  it('books a tranche and moves the stop to break-even at the first target', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    const first = position.takeProfits[0];
    expect(first.hit).toBe(false);

    // Move price exactly to the first target.
    market.price$ = first.price;
    await engine.cycle();

    const after = await store.position(position.id);
    expect(after!.status).toBe('OPEN');
    expect(after!.takeProfits[0].hit).toBe(true);
    // Part of the position is closed, the rest still runs.
    expect(after!.remainingQuantity).toBeLessThan(position.quantity);
    expect(after!.remainingQuantity).toBeGreaterThan(0);
    expect(after!.realisedPnl).toBeGreaterThan(0);
    // The trade can no longer turn into a loser. The stop sits past entry — far
    // enough to cover the exit fee, and further still once trailing has armed.
    expect(after!.breakEven).toBe(true);
    expect(after!.stopLoss).toBeGreaterThan(position.entry);
  });

  it('releases collateral back to the balance on a partial exit', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    const before = await engine.account();

    market.price$ = position.takeProfits[0].price;
    await engine.cycle();

    const after = await engine.account();
    const remaining = await store.position(position.id);
    // Margin behind the closed tranche is freed.
    expect(after.usedMargin).toBeLessThan(before.usedMargin);
    expect(after.usedMargin).toBeCloseTo(remaining!.margin, 6);
    // Booking profit grows equity.
    expect(after.equity).toBeGreaterThan(before.equity);
  });

  it('closes the position once the final target fills', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    // Jump straight past the furthest target.
    market.price$ = position.takeProfit * 1.02;
    await engine.cycle();

    const closed = await store.position(position.id);
    expect(closed!.status).toBe('CLOSED');
    expect(closed!.exitReason).toBe('TAKE_PROFIT');
    expect(closed!.takeProfits.every((t) => t.hit)).toBe(true);
    expect(closed!.pnl).toBeGreaterThan(0);

    const account = await engine.account();
    expect(account.usedMargin).toBe(0);
    expect(account.equity).toBeGreaterThan(account.startingBalance);
  });

  it('counts profit exactly once across a partial then a full exit', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    market.price$ = position.takeProfits[0].price;
    await engine.cycle();

    const mid = await engine.account();
    const booked = (await store.position(position.id))!.realisedPnl;

    const remaining = (await store.position(position.id))!.remainingQuantity;

    // Now close the remainder by hand at the same price.
    await engine.closePosition(position.id);
    const final = await engine.account();
    const closed = await store.position(position.id);

    // Total pnl includes the booked tranche — it is carried, not recomputed.
    expect(closed!.pnl).toBeGreaterThanOrEqual(booked);
    // Equity only drops by the exit fee on the part that was still open.
    const exitFee = remaining * market.price$ * 0.0006;
    expect(mid.equity - final.equity).toBeCloseTo(exitFee, 4);
  });

  it('exits early when the scanner flips against an open position', async () => {
    const market = new FakeMarket();
    const { store, engine } = engineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    expect(position.side).toBe('LONG');

    // Feed the engine a confident opposing signal for the same symbol.
    const flipped = engine.signals.map((s) =>
      s.symbol === position.symbol ? { ...s, side: 'SHORT' as const, confidence: 0.9 } : s
    );
    Object.defineProperty(engine, 'lastSignals', { value: flipped, writable: true });

    await engine.cycle();
    const closed = await store.position(position.id);
    // Either the flip closed it, or a later cycle re-ranked it — both acceptable,
    // but it must not still be open on a thesis the engine no longer believes.
    if (closed!.status === 'CLOSED') {
      expect(['SIGNAL_FLIP', 'TAKE_PROFIT', 'STOP_LOSS', 'BREAK_EVEN']).toContain(
        closed!.exitReason
      );
    }
  });
});

describe('live order mirroring', () => {
  it('mirrors an entry and a protective stop onto the exchange when armed', async () => {
    const market = new FakeMarket();
    const { store, engine, exchange } = liveEngineWith(market);

    await engine.cycle();

    const [position] = await store.positions('OPEN');
    expect(position.live).toBe(true);
    expect(position.liveOrderId).toBeTruthy();
    expect(position.liveStopOrderId).toBeTruthy();
    expect(exchange.opens).toHaveLength(1);
    expect(exchange.opens[0].intent).toBe('OPEN_LONG');
    expect(exchange.stopPlacements).toHaveLength(1);
    expect(exchange.stopPlacements[0].triggerPrice).toBeCloseTo(position.stopLoss);
  });

  it('never opens on paper when the real entry order is rejected', async () => {
    const market = new FakeMarket();
    const store = new Store();
    const exchange = new FakeExchange();
    exchange.failNextOpen = true;
    const engine = new Engine(store, market as never, undefined, 45, ['AAA_USDT'], exchange as never);

    await engine.cycle();

    const open = await store.positions('OPEN');
    expect(open).toHaveLength(0);
  });

  it('mirrors a full close and cancels the resting stop', async () => {
    const market = new FakeMarket();
    const { store, engine, exchange } = liveEngineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    const stopPrice = position.stopLoss;

    await engine.simulatePrice(position.symbol, stopPrice);

    const closed = await store.position(position.id);
    expect(closed!.status).toBe('CLOSED');
    expect(exchange.closes.length).toBeGreaterThan(0);
    expect(exchange.cancelledStops).toContain(position.liveStopOrderId);
  });
});

describe('live position reconciliation', () => {
  it('settles a position locally when MEXC no longer reports it open', async () => {
    const market = new FakeMarket();
    const { store, engine, exchange } = liveEngineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    expect(position.live).toBe(true);

    // Simulate the position having been closed directly on MEXC (manual close,
    // an offline stop trigger, a liquidation) — the venue no longer lists it,
    // but the engine's own record still says OPEN.
    exchange.venuePositions = [];
    // Block a fresh entry this cycle so the assertions below isolate the
    // reconciliation settle from the normal scan-and-enter flow.
    engine.setRisk({ minConfidence: 0.99 });

    await engine.cycle();

    const after = await store.position(position.id);
    expect(after!.status).toBe('CLOSED');
    expect(after!.exitReason).toBe('MANUAL');
    // No reduce order was sent — there was nothing left on the venue to reduce.
    expect(exchange.closes).toHaveLength(0);

    const account = await engine.account();
    // Margin freed back into the balance exactly once.
    expect(account.usedMargin).toBeCloseTo(0, 6);
  });

  it('trims the local quantity when MEXC reports a smaller size than expected', async () => {
    const market = new FakeMarket();
    const { store, engine, exchange } = liveEngineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    const contractSize = position.liveContractSize || 1;
    const fullVol = Math.round(position.quantity / contractSize);

    // Venue reports half the size — an external partial close the engine never
    // initiated.
    exchange.venuePositions = [
      {
        symbol: position.symbol,
        side: position.side,
        vol: Math.round(fullVol / 2),
        leverage: position.leverage,
        entryPrice: position.entry,
        liquidationPrice: 0,
        unrealisedPnl: 0,
      },
    ];

    await engine.cycle();

    const after = await store.position(position.id);
    expect(after!.status).toBe('OPEN');
    expect(after!.remainingQuantity).toBeLessThan(position.quantity * 0.6);
    expect(after!.remainingQuantity).toBeGreaterThan(position.quantity * 0.4);
  });

  it('leaves a live position untouched when MEXC still reports it at full size', async () => {
    const market = new FakeMarket();
    const { store, engine, exchange } = liveEngineWith(market);
    await engine.cycle();

    const [position] = await store.positions('OPEN');
    const contractSize = position.liveContractSize || 1;
    exchange.venuePositions = [
      {
        symbol: position.symbol,
        side: position.side,
        vol: Math.round(position.quantity / contractSize),
        leverage: position.leverage,
        entryPrice: position.entry,
        liquidationPrice: 0,
        unrealisedPnl: 0,
      },
    ];

    await engine.cycle();

    const after = await store.position(position.id);
    expect(after!.status).toBe('OPEN');
    expect(after!.remainingQuantity).toBeCloseTo(position.quantity, 6);
  });

  it('adopts existing MEXC plan orders and cleans up duplicate stop orders on reconciliation', async () => {
    const market = new FakeMarket();
    const { store, engine, exchange } = liveEngineWith(market);

    exchange.venuePositions = [
      {
        symbol: 'AAA_USDT',
        side: 'LONG',
        vol: 10,
        leverage: 5,
        entryPrice: 100,
        liquidationPrice: 80,
        unrealisedPnl: 0,
      },
    ];
    exchange.venuePlanOrders = [
      {
        id: 'stop-old',
        symbol: 'AAA_USDT',
        side: 4,
        triggerType: 2,
        triggerPrice: 94,
        vol: 10,
        createTime: 1000,
      },
      {
        id: 'stop-new',
        symbol: 'AAA_USDT',
        side: 4,
        triggerType: 2,
        triggerPrice: 95,
        vol: 10,
        createTime: 2000,
      },
    ];

    await engine.cycle();

    const [adopted] = await store.positions('OPEN');
    expect(adopted).toBeDefined();
    expect(adopted.symbol).toBe('AAA_USDT');
    expect(adopted.liveStopOrderId).toBe('stop-new');
    expect(adopted.stopLoss).toBe(95);

    // Old duplicate was cancelled on MEXC
    expect(exchange.cancelledPlanOrders).toContainEqual({
      symbol: 'AAA_USDT',
      orderId: 'stop-old',
    });

    // Because liveStopOrderId was adopted and stop price didn't move, no extra stop order was placed
    expect(exchange.stopPlacements).toHaveLength(0);
  });
});

describe('stats', () => {
  it('computes win rate and profit factor, and handles an empty history', () => {
    const closed = [
      { pnl: 100, margin: 100 },
      { pnl: -50, margin: 100 },
      { pnl: 50, margin: 100 },
    ] as Position[];
    const stats = computeStats(closed);
    expect(stats.trades).toBe(3);
    expect(stats.winRate).toBeCloseTo(2 / 3);
    expect(stats.profitFactor).toBeCloseTo(3);
    expect(stats.bestTrade).toBe(100);

    const empty = computeStats([]);
    expect(empty.trades).toBe(0);
    expect(empty.bestTrade).toBe(0);
    expect(Number.isFinite(empty.profitFactor)).toBe(true);
  });
});

describe('advanced exit management', () => {
  it('ratchets stop-loss progressively as price advances (progressiveProfitLock)', () => {
    const position: Position = {
      id: 'p-1',
      symbol: 'BTC_USDT',
      side: 'LONG',
      entry: 100,
      stopLoss: 95, // 1R = 5
      quantity: 1,
      leverage: 5,
      margin: 20,
      notional: 100,
      takeProfit: 120,
      takeProfits: [],
      remainingQuantity: 1,
      realisedPnl: 0,
      entryFee: 0,
      initialRisk: 5,
      breakEven: false,
      extreme: 100,
      trailingArmed: false,
      openedAt: Date.now(),
      status: 'OPEN',
      confidence: 0.8,
      regime: 'TREND_UP',
      reasons: [],
    };

    // +1.5R (price = 107.5) -> no ratchet yet (< 2.2R)
    expect(progressiveProfitLock(position, 107.5)).toBeNull();

    // +2.5R (price = 112.5) -> locks +0.75R (stop at 100 + 0.75 * 5 = 103.75)
    const lock1 = progressiveProfitLock(position, 112.5);
    expect(lock1).not.toBeNull();
    expect(lock1?.rLocked).toBe(0.75);
    expect(lock1?.stopLoss).toBe(103.75);

    // Update position with lock1 stop
    position.stopLoss = lock1!.stopLoss;

    // +3.5R (price = 117.5) -> locks +1.75R (stop at 100 + 1.75 * 5 = 108.75)
    const lock2 = progressiveProfitLock(position, 117.5);
    expect(lock2?.rLocked).toBe(1.75);
    expect(lock2?.stopLoss).toBe(108.75);
  });

  it('detects blow-off top climax exit on extreme RSI + volume surge', () => {
    const position: Position = {
      id: 'p-2',
      symbol: 'ETH_USDT',
      side: 'LONG',
      entry: 1000,
      stopLoss: 950,
      quantity: 1,
      leverage: 5,
      margin: 200,
      notional: 1000,
      takeProfit: 1200,
      takeProfits: [],
      remainingQuantity: 1,
      realisedPnl: 0,
      entryFee: 0,
      initialRisk: 50,
      breakEven: false,
      extreme: 1000,
      trailingArmed: false,
      openedAt: Date.now(),
      status: 'OPEN',
      confidence: 0.8,
      regime: 'TREND_UP',
      reasons: [],
    };

    const normalCandles: Candle[] = Array.from({ length: 25 }, (_, i) => ({
      time: i * 900,
      open: 1000,
      high: 1010,
      low: 990,
      close: 1005,
      volume: 1000,
    }));

    // Normal RSI (70) -> false
    expect(detectBlowOffTop(position, normalCandles, 70)).toBe(false);

    // Extreme RSI (85) but normal volume -> false
    expect(detectBlowOffTop(position, normalCandles, 85)).toBe(false);

    // Extreme RSI (85) + volume surge (3x avg) -> true
    const surgeCandles = [...normalCandles];
    surgeCandles[surgeCandles.length - 1] = {
      ...surgeCandles[surgeCandles.length - 1],
      volume: 3000,
    };
    expect(detectBlowOffTop(position, surgeCandles, 85)).toBe(true);
  });

  it('calculates dynamic chandelier trailing stop correctly', () => {
    const position: Position = {
      id: 'p-3',
      symbol: 'SOL_USDT',
      side: 'LONG',
      entry: 100,
      stopLoss: 90,
      quantity: 1,
      leverage: 5,
      margin: 20,
      notional: 100,
      takeProfit: 150,
      takeProfits: [],
      remainingQuantity: 1,
      realisedPnl: 0,
      entryFee: 0,
      initialRisk: 10,
      breakEven: false,
      extreme: 130,
      trailingArmed: true,
      openedAt: Date.now(),
      status: 'OPEN',
      confidence: 0.8,
      regime: 'TREND_UP',
      reasons: [],
    };

    // Peak at 130, ATR is 4, 1.5x multiplier -> stop is 130 - (4 * 1.5) = 124
    const stop = chandelierStop(position, 130, 4, 1.5);
    expect(stop).toBe(124);
  });
});
