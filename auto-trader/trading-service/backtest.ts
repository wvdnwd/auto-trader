import {
  BREAK_EVEN_BUFFER_R,
  FEE,
  type ExitTuning,
  closeSettlement,
  direction,
  fillTakeProfits,
  isLiquidated,
  isStopHit,
  openPnl,
  partialFillPatch,
  riskUnit,
  stopReason,
  trailPatch,
} from './exits.js';
import { DEFAULT_RISK, concentrationBlock, isPositionDerisked, planTrade, tradingBlockedReason } from './risk.js';
import { buildSignal } from './strategy.js';
import type {
  Account,
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  Candle,
  EquityPoint,
  GroupBucket,
  MonthlyBucket,
  Position,
  SymbolBucket,
  RiskConfig,
  Signal,
  Ticker,
} from './types.js';

/** Interval lengths in seconds, used to align the entry and confirmation series. */
const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Min60: 3600,
  Hour4: 14_400,
  Day1: 86_400,
};

/** Bars of history the strategy needs before it can produce a signal. */
const WARMUP_BARS = 60;

/**
 * Bars handed to the strategy per evaluation.
 *
 * The indicators only look back ~60 bars, so slicing the entire history on every
 * bar is wasted work that grows quadratically with the length of the run. This
 * window is comfortably larger than anything the strategy reads.
 */
const LOOKBACK = 140;

/**
 * Everything the backtest needs to know about one market, pre-loaded.
 */
export type MarketHistory = {
  symbol: string;
  /** Entry-timeframe candles, oldest first. */
  candles: Candle[];
  /** Confirmation-timeframe candles, oldest first. */
  higher: Candle[];
};

type SimPosition = Position & { entryBar: number };

/**
 * Replay historical candles through the live strategy, risk and exit logic.
 *
 * The point of this class is that it does not reimplement any trading decision.
 * Signals come from the same `buildSignal`, sizing from the same `planTrade`, and
 * exits from the same functions the live engine calls — so a result here is a
 * statement about the real system, not about a parallel simplified copy of it.
 */
export class Backtest {
  private readonly risk: RiskConfig;

  private readonly exits: ExitTuning;

  private readonly feeRate: number;

  private balance: number;

  private realised = 0;

  private peakEquity: number;

  private open: SimPosition[] = [];

  private closed: BacktestTrade[] = [];

  private curve: EquityPoint[] = [];

  private blockedBars = 0;

  private seq = 0;

  /** Per-market cursor into the confirmation series, advanced as the run moves. */
  private higherCursor = new Map<string, number>();

  /** Per-market cursor into the entry series, advanced as the run moves. */
  private indexCursor = new Map<string, number>();

  /** Markets by symbol, so exit management does not scan the list each bar. */
  private bySymbol = new Map<string, MarketHistory>();

  /** UTC day currently being replayed, for the daily loss limit. */
  private currentDay = 0;

  /** Equity at the open of {@link currentDay}. */
  private dayOpenEquity = 0;

  /** Deepest drawdown seen, tracked live so lean runs need no curve. */
  private maxDrawdown = 0;

  /** Equity at the most recent bar. */
  private lastEquity = 0;

  /** Bars replayed, counted for the annualisation and Sharpe maths. */
  private barCount = 0;

  /** Running sum and sum-of-squares of per-bar returns, for Sharpe. */
  private returnSum = 0;

  private returnSquares = 0;

  private returnCount = 0;

  /** Equity at the previous bar, for the per-bar return series. */
  private prevEquity = 0;

  /**
   * @param markets pre-loaded history per market.
   * @param config the run parameters.
   * @param lean when true, the equity curve and trade log are summarised and then
   *   discarded. A parameter search runs hundreds of backtests, and retaining
   *   every point of every curve is what exhausts memory — the statistics are
   *   identical either way.
   */
  constructor(
    private readonly markets: MarketHistory[],
    private readonly config: BacktestConfig,
    private readonly lean = false
  ) {
    this.risk = { ...DEFAULT_RISK, ...config.risk };
    this.exits = {
      trailArmR: this.risk.trailArmR,
      trailGiveback: this.risk.trailGiveback,
      breakEvenAfterFirst: this.risk.breakEvenAfterFirst,
      breakEvenBufferR: this.risk.breakEvenBufferR ?? BREAK_EVEN_BUFFER_R,
    };
    this.feeRate = config.feeRate ?? FEE;
    this.balance = config.startingBalance;
    this.peakEquity = config.startingBalance;
    this.lastEquity = config.startingBalance;
    this.prevEquity = config.startingBalance;
    for (const m of markets) this.bySymbol.set(m.symbol, m);
  }

  /**
   * Run the full replay.
   *
   * Each bar is processed in two phases, mirroring reality: exits are evaluated
   * against the bar's own high and low first, then entries are considered on the
   * close. A position can therefore never be opened and stopped out within the
   * same bar on information it could not have had.
   *
   * @returns the trades, equity curve and summary statistics.
   */
  run(): BacktestResult {
    const timeline = this.buildTimeline();
    if (!timeline.length) {
      throw new Error('geen historische candles gevonden voor deze periode');
    }

    for (let i = 0; i < timeline.length; i += 1) {
      const bar = timeline[i];
      const prices = this.pricesAt(bar);

      this.manageExits(bar, prices, i);
      this.considerEntries(bar, i, prices);

      const equity = this.equityAt(prices);
      this.peakEquity = Math.max(this.peakEquity, equity);
      const drawdownPct = this.peakEquity > 0 ? (this.peakEquity - equity) / this.peakEquity : 0;
      this.maxDrawdown = Math.max(this.maxDrawdown, drawdownPct);
      this.lastEquity = equity;
      this.trackReturn(equity);
      // In lean mode only the last point is kept — enough to close the run out
      // without holding thousands of points per candidate.
      const point: EquityPoint = {
        time: bar,
        equity: round(equity, 2),
        drawdownPct,
        openPositions: this.open.length,
      };
      if (this.lean) this.curve[0] = point;
      else this.curve.push(point);
    }

    // Close anything still open at the final price so the result is complete.
    const last = timeline[timeline.length - 1];
    const finalPrices = this.pricesAt(last);
    // Snapshot: settling removes entries from this.open as we go.
    const stillOpen = this.open.slice();
    for (const position of stillOpen) {
      const price = finalPrices.get(position.symbol) ?? position.entry;
      this.settle(position, price, 'MANUAL', last, timeline.length - 1);
    }

    // Rewrite the closing point so it reflects the settled book. Without this the
    // curve still shows open positions and the final equity excludes their exit —
    // the reported return would silently disagree with the trade log.
    const settledEquity = this.equityAt(finalPrices);
    this.peakEquity = Math.max(this.peakEquity, settledEquity);
    const finalDrawdown =
      this.peakEquity > 0 ? Math.max(0, (this.peakEquity - settledEquity) / this.peakEquity) : 0;
    this.maxDrawdown = Math.max(this.maxDrawdown, finalDrawdown);
    this.lastEquity = settledEquity;
    this.curve[this.curve.length - 1] = {
      time: last,
      equity: round(settledEquity, 2),
      drawdownPct: finalDrawdown,
      openPositions: 0,
    };

    return this.summarise(timeline);
  }

  /** Accumulate the per-bar return series used for the Sharpe ratio. */
  private trackReturn(equity: number): void {
    this.barCount += 1;
    if (this.prevEquity > 0) {
      const r = (equity - this.prevEquity) / this.prevEquity;
      this.returnSum += r;
      this.returnSquares += r * r;
      this.returnCount += 1;
    }
    this.prevEquity = equity;
  }

  /** Ordered union of every bar timestamp across all markets. */
  private buildTimeline(): number[] {
    const times = new Set<number>();
    for (const market of this.markets) {
      for (let i = WARMUP_BARS; i < market.candles.length; i += 1) times.add(market.candles[i].time);
    }
    return [...times].sort((a, b) => a - b);
  }

  /** Close price of every market at or before a timestamp. */
  private pricesAt(time: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const market of this.markets) {
      const bar = this.barAt(market, time);
      if (bar) out.set(market.symbol, bar.close);
    }
    return out;
  }

  private barAt(market: MarketHistory, time: number): Candle | null {
    const index = this.indexAt(market, time);
    return index >= 0 ? market.candles[index] : null;
  }

  /**
   * Index of the bar that closes exactly at `time`, or -1.
   *
   * The timeline only moves forward, so a per-market cursor finds the bar in a
   * step or two. Falls back to a binary search if a caller jumps backwards.
   */
  private indexAt(market: MarketHistory, time: number): number {
    const candles = market.candles;
    let cursor = this.indexCursor.get(market.symbol) ?? 0;
    if (cursor < candles.length && candles[cursor].time <= time) {
      while (cursor + 1 < candles.length && candles[cursor + 1].time <= time) cursor += 1;
      this.indexCursor.set(market.symbol, cursor);
      return candles[cursor].time === time ? cursor : -1;
    }

    let lo = 0;
    let hi = candles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = candles[mid].time;
      if (t === time) {
        this.indexCursor.set(market.symbol, mid);
        return mid;
      }
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Run exit management against the bar's actual range.
   *
   * Using high and low rather than the close is what makes the result honest: a
   * stop that price traded through intrabar was hit, even if the bar closed back
   * on the right side of it.
   */
  private manageExits(time: number, prices: Map<string, number>, bar: number): void {
    // Snapshot: exits remove entries from this.open while we iterate.
    const active = this.open.slice();
    for (const position of active) {
      const market = this.bySymbol.get(position.symbol);
      if (!market) continue;
      const index = this.indexAt(market, time);
      if (index < 0) continue;
      const candle = market.candles[index];
      const dir = direction(position);

      // Adverse extreme of the bar — the price that would have hit a stop.
      const adverse = dir === 1 ? candle.low : candle.high;
      // Favourable extreme — the price that would have filled a target.
      const favourable = dir === 1 ? candle.high : candle.low;

      if (isLiquidated(position, adverse)) {
        this.settle(position, adverse, 'LIQUIDATED', time, bar);
        continue;
      }

      // Pessimistic ordering: when a bar covers both the stop and a target, assume
      // the stop filled first. Anything else would flatter the results.
      if (isStopHit(position, adverse)) {
        this.settle(position, position.stopLoss, stopReason(position), time, bar);
        continue;
      }

      const fill = fillTakeProfits(position, favourable, this.feeRate);
      if (fill) {
        if (fill.allDone) {
          const total = position.realisedPnl + fill.bookedPnl;
          this.bookTrade(position, {
            exit: fill.levels[fill.levels.length - 1].price,
            pnl: total - position.entryFee,
            reason: 'TAKE_PROFIT',
            closedAt: time,
            bar,
          });
          this.balance += position.margin + fill.bookedPnl;
          this.realised += fill.bookedPnl;
          this.open = this.open.filter((p) => p.id !== position.id);
          continue;
        }
        const { patch, freedMargin } = partialFillPatch(position, fill, this.exits);
        Object.assign(position, patch);
        this.balance += freedMargin + fill.bookedPnl;
        this.realised += fill.bookedPnl;
      }

      const ageHours = (time - position.openedAt / 1000) / 3600;
      if (ageHours > this.risk.maxPositionHours) {
        this.settle(position, candle.close, 'MAX_AGE', time, bar);
        continue;
      }

      const staleHours = this.risk.maxStaleHours ?? 12;
      const isDerisked = isPositionDerisked(position);
      if (!isDerisked && ageHours > staleHours) {
        const dir = direction(position);
        const r = riskUnit(position);
        const currentR = r > 0 ? (dir * (candle.close - position.entry)) / r : 0;
        if (currentR < 0.8) {
          this.settle(position, candle.close, 'STALE_TRADE', time, bar);
          continue;
        }
      }

      Object.assign(position, trailPatch(position, favourable, this.exits));
    }
  }

  private considerEntries(time: number, bar: number, prices: Map<string, number>): void {
    const equity = this.equityAt(prices);
    const dayPnlPct = this.dayPnlPct(time, equity);
    const account = this.account(equity);

    const atRisk = this.open.filter((p) => !isPositionDerisked(p));
    const blocked = tradingBlockedReason(account, this.open.length, dayPnlPct, this.risk, atRisk.length);
    if (blocked) {
      if (blocked.kind === 'halt') this.blockedBars += 1;
      return;
    }

    const held = new Set(this.open.map((p) => p.symbol));
    const signals: Signal[] = [];
    for (const market of this.markets) {
      if (held.has(market.symbol)) continue;
      const signal = this.signalAt(market, time);
      if (signal) signals.push(signal);
    }
    signals.sort((a, b) => b.confidence - a.confidence);

    let slots = this.risk.maxOpenPositions - atRisk.length;
    let live = account;
    const book = atRisk.map((p) => ({ symbol: p.symbol, side: p.side }));
    for (const signal of signals) {
      if (slots <= 0) break;
      // Concentration check before sizing: only at-risk positions count against same-side exposure
      if (concentrationBlock(signal, book, this.risk)) continue;
      const plan = planTrade(signal, live, this.risk);
      if (!plan) continue;
      const fee = plan.notional * this.feeRate;
      if (plan.margin + fee > this.balance) continue;

      this.seq += 1;
      const position: SimPosition = {
        id: `bt-${this.seq}`,
        symbol: plan.symbol,
        side: plan.side,
        entry: plan.entry,
        quantity: plan.quantity,
        leverage: plan.leverage,
        margin: plan.margin,
        notional: plan.notional,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
        takeProfits: plan.takeProfits,
        remainingQuantity: plan.quantity,
        realisedPnl: 0,
        entryFee: fee,
        initialRisk: Math.abs(plan.entry - plan.stopLoss),
        breakEven: false,
        extreme: plan.entry,
        trailingArmed: false,
        openedAt: time * 1000,
        status: 'OPEN',
        confidence: plan.confidence,
        regime: plan.regime,
        reasons: plan.reasons,
        entryBar: bar,
      };
      this.open.push(position);
      this.balance -= plan.margin + fee;
      this.realised -= fee;
      slots -= 1;
      // Re-read equity so each further entry is sized against the capital that
      // is actually still free after the ones already taken this bar.
      live = this.account(this.equityAt(prices));
    }
  }

  /**
   * Build a signal for a market as of a given bar, using only the candles that
   * had closed by then. This is the guard against lookahead bias.
   */
  private signalAt(market: MarketHistory, time: number): Signal | null {
    const index = this.indexAt(market, time);
    if (index < WARMUP_BARS) return null;
    // Bounded window rather than the whole history — same inputs, linear cost.
    const candles = market.candles.slice(Math.max(0, index + 1 - LOOKBACK), index + 1);
    const higher = this.higherUpTo(market, time);

    const bar = market.candles[index];
    const dayAgo = time - 86_400;
    let volume = 0;
    let prior = candles[0];
    for (let i = candles.length - 1; i >= 0; i -= 1) {
      if (candles[i].time < dayAgo) break;
      volume += candles[i].volume * candles[i].close;
      prior = candles[i];
    }
    const ticker: Ticker = {
      symbol: market.symbol,
      lastPrice: bar.close,
      // Rolling 24h volume from the replayed window, so the liquidity filter
      // behaves the way it would have at the time.
      quoteVolume24h: volume,
      changeRate24h: prior.close ? (bar.close - prior.close) / prior.close : 0,
      // Funding is not available historically — treated as neutral rather than
      // guessed, so the backtest never credits a signal it could not have had.
      fundingRate: 0,
    };
    return buildSignal(ticker, candles, higher);
  }

  /**
   * Confirmation-timeframe candles that had closed by `time`.
   *
   * Walks a cursor forward across the run instead of re-filtering the whole
   * series on every bar.
   */
  private higherUpTo(market: MarketHistory, time: number): Candle[] {
    const cutoff = time - this.higherSeconds();
    let end = this.higherCursor.get(market.symbol) ?? 0;
    while (end < market.higher.length && market.higher[end].time <= cutoff) end += 1;
    this.higherCursor.set(market.symbol, end);
    return market.higher.slice(Math.max(0, end - LOOKBACK), end);
  }

  private higherSeconds(): number {
    return INTERVAL_SECONDS[this.config.higherInterval] || 3600;
  }

  private settle(
    position: SimPosition,
    price: number,
    reason: NonNullable<Position['exitReason']>,
    time: number,
    bar: number
  ): void {
    const { settling, net } = closeSettlement(position, price, this.feeRate);
    this.bookTrade(position, { exit: price, pnl: net, reason, closedAt: time, bar });
    this.balance += position.margin + settling;
    this.realised += settling;
    this.open = this.open.filter((p) => p.id !== position.id);
  }

  private bookTrade(
    position: SimPosition,
    outcome: {
      exit: number;
      pnl: number;
      reason: NonNullable<Position['exitReason']>;
      closedAt: number;
      bar: number;
    }
  ): void {
    this.closed.push({
      symbol: position.symbol,
      side: position.side,
      entry: position.entry,
      exit: round(outcome.exit, 8),
      quantity: position.quantity,
      leverage: position.leverage,
      margin: position.margin,
      openedAt: position.openedAt / 1000,
      closedAt: outcome.closedAt,
      barsHeld: outcome.bar - position.entryBar,
      pnl: round(outcome.pnl, 2),
      pnlPct: position.margin ? outcome.pnl / position.margin : 0,
      rMultiple: this.rMultipleOf(position, outcome.pnl),
      exitReason: outcome.reason,
      confidence: position.confidence,
      regime: position.regime,
    });
  }

  /** Result expressed in units of the risk originally taken on the trade. */
  private rMultipleOf(position: SimPosition, pnl: number): number {
    const riskAmount = riskUnit(position) * position.quantity;
    return riskAmount ? round(pnl / riskAmount, 2) : 0;
  }

  private equityAt(prices: Map<string, number>): number {
    let equity = this.balance;
    for (const position of this.open) {
      const price = prices.get(position.symbol) || position.entry;
      equity += position.margin + Math.max(openPnl(position, price), -position.margin);
    }
    return equity;
  }

  private account(equity: number): Account {
    const usedMargin = this.open.reduce((a, p) => a + p.margin, 0);
    return {
      balance: this.balance,
      equity,
      usedMargin,
      realisedPnl: this.realised,
      unrealisedPnl: equity - this.balance - usedMargin,
      startingBalance: this.config.startingBalance,
      peakEquity: this.peakEquity,
      drawdownPct: this.peakEquity > 0 ? Math.max(0, (this.peakEquity - equity) / this.peakEquity) : 0,
    };
  }

  /**
   * Realised + unrealised move since the start of the current UTC day.
   *
   * The opening equity of each day is recorded once when the day rolls over,
   * rather than scanning back through the curve on every bar.
   */
  private dayPnlPct(time: number, equity: number): number {
    const dayStart = Math.floor(time / 86_400) * 86_400;
    if (dayStart !== this.currentDay) {
      this.currentDay = dayStart;
      this.dayOpenEquity = this.barCount ? this.lastEquity : this.config.startingBalance;
    }
    const base = this.dayOpenEquity;
    return base ? (equity - base) / base : 0;
  }

  private summarise(timeline: number[]): BacktestResult {
    const trades = this.closed;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const finalEquity = round(this.barCount ? this.lastEquity : this.config.startingBalance, 2);
    const maxDrawdown = this.maxDrawdown;

    const days = (timeline[timeline.length - 1] - timeline[0]) / 86_400 || 1;
    const totalReturn = (finalEquity - this.config.startingBalance) / this.config.startingBalance;

    const byReason: Record<string, { count: number; pnl: number }> = {};
    for (const trade of trades) {
      const key = trade.exitReason;
      byReason[key] = byReason[key] || { count: 0, pnl: 0 };
      byReason[key].count += 1;
      byReason[key].pnl = round(byReason[key].pnl + trade.pnl, 2);
    }

    return {
      config: this.config,
      startedAt: timeline[0],
      endedAt: timeline[timeline.length - 1],
      bars: timeline.length,
      startingBalance: this.config.startingBalance,
      finalEquity,
      totalReturnPct: round(totalReturn, 4),
      // Compounded to a yearly figure, so windows of different length compare.
      annualisedReturnPct: round((1 + totalReturn) ** (365 / days) - 1, 4),
      maxDrawdownPct: round(maxDrawdown, 4),
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? round(wins.length / trades.length, 4) : 0,
      avgWin: wins.length ? round(grossWin / wins.length, 2) : 0,
      avgLoss: losses.length ? round(-grossLoss / losses.length, 2) : 0,
      profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
      expectancyR: trades.length
        ? round(trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length, 3)
        : 0,
      avgBarsHeld: trades.length
        ? Math.round(trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length)
        : 0,
      // Risk-adjusted: mean bar return over its standard deviation, annualised.
      sharpe: this.sharpe(),
      haltedBars: this.blockedBars,
      exitBreakdown: byReason,
      ...monthlyStats(trades),
      bySymbol: symbolStats(trades),
      byRegime: groupBy(trades, (t) => t.regime),
      bySide: groupBy(trades, (t) => t.side),
      // A lean run keeps the statistics but drops the per-bar and per-trade
      // detail, which is what makes a few hundred runs fit in memory.
      equityCurve: this.lean ? [] : this.curve,
      tradeLog: this.lean ? [] : trades,
    };
  }

  private sharpe(): number {
    const n = this.returnCount;
    if (n < 2) return 0;
    const mean = this.returnSum / n;
    const variance = (this.returnSquares - n * mean * mean) / (n - 1);
    const sd = Math.sqrt(Math.max(0, variance));
    if (!sd) return 0;
    const barsPerYear = (365 * 86_400) / (INTERVAL_SECONDS[this.config.interval] || 900);
    return round((mean / sd) * Math.sqrt(barsPerYear), 2);
  }
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Group closed trades by any attribute, worst contributor last.
 *
 * @param trades the closed trades of a run.
 * @param key picks the attribute to group on.
 * @returns one bucket per distinct value, sorted by profit.
 */
function groupBy(trades: BacktestTrade[], key: (t: BacktestTrade) => string): GroupBucket[] {
  const buckets = new Map<string, GroupBucket & { rSum: number }>();
  for (const trade of trades) {
    const k = key(trade);
    const bucket = buckets.get(k) || { key: k, pnl: 0, trades: 0, wins: 0, expectancyR: 0, rSum: 0 };
    bucket.pnl = round(bucket.pnl + trade.pnl, 2);
    bucket.trades += 1;
    bucket.rSum += trade.rMultiple;
    if (trade.pnl > 0) bucket.wins += 1;
    buckets.set(k, bucket);
  }
  return [...buckets.values()]
    .map(({ rSum, ...b }) => ({ ...b, expectancyR: round(rSum / b.trades, 3) }))
    .sort((a, b) => b.pnl - a.pnl);
}

/**
 * Group closed trades by market, best contributor first.
 *
 * @param trades the closed trades of a run.
 * @returns per-market profit, trade count and expectancy.
 */
function symbolStats(trades: BacktestTrade[]): SymbolBucket[] {
  const buckets = new Map<string, SymbolBucket & { rSum: number }>();
  for (const trade of trades) {
    const bucket = buckets.get(trade.symbol) || {
      symbol: trade.symbol,
      pnl: 0,
      trades: 0,
      wins: 0,
      expectancyR: 0,
      rSum: 0,
    };
    bucket.pnl = round(bucket.pnl + trade.pnl, 2);
    bucket.trades += 1;
    bucket.rSum += trade.rMultiple;
    if (trade.pnl > 0) bucket.wins += 1;
    buckets.set(trade.symbol, bucket);
  }
  return [...buckets.values()]
    .map(({ rSum, ...b }) => ({ ...b, expectancyR: round(rSum / b.trades, 3) }))
    .sort((a, b) => b.pnl - a.pnl);
}

/**
 * Group closed trades by calendar month and measure how concentrated the profit is.
 *
 * A headline return says nothing about whether an edge is repeatable. Four flat
 * months and one spectacular one produce the same total as five steady months,
 * but only the second is worth trusting with money — so the concentration is
 * computed here and reported next to the total.
 *
 * @param trades the closed trades of a run.
 * @returns monthly buckets plus the concentration and hit-rate summary.
 */
function monthlyStats(
  trades: BacktestTrade[]
): Pick<BacktestResult, 'monthly' | 'bestMonthShare' | 'positiveMonthRate'> {
  const buckets = new Map<string, MonthlyBucket>();
  for (const trade of trades) {
    const date = new Date(trade.closedAt * 1000);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = buckets.get(month) || { month, pnl: 0, trades: 0, wins: 0 };
    bucket.pnl = round(bucket.pnl + trade.pnl, 2);
    bucket.trades += 1;
    if (trade.pnl > 0) bucket.wins += 1;
    buckets.set(month, bucket);
  }

  const monthly = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
  const totalPnl = monthly.reduce((a, m) => a + m.pnl, 0);
  const bestMonth = monthly.reduce((best, m) => Math.max(best, m.pnl), 0);
  const positive = monthly.filter((m) => m.pnl > 0).length;

  return {
    monthly,
    // Only meaningful for a profitable run: for a losing one the ratio would be
    // a negative or inflated number that reads as significant when it is not.
    bestMonthShare: totalPnl > 0 ? round(bestMonth / totalPnl, 3) : 0,
    positiveMonthRate: monthly.length ? round(positive / monthly.length, 3) : 0,
  };
}
