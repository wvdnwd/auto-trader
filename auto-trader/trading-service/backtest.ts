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
import { rsi, volumeRatio } from './indicators.js';
import { rankCandidates } from './candidate-ranking.js';
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

const DAY_SECONDS = 86_400;

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
  /** Optional historical 15m candles for replaying timing gates on other entry intervals. */
  timing15m?: Candle[];
  /** Optional historical 5m candles for replaying the sniper/reversal fallback gates. */
  timing5m?: Candle[];
};

type TimingEvidence = { candles: Candle[]; reason: null } | { candles: null; reason: string };

/** Return a bounded, valid, closed and fresh timing window as of replay time. */
function timingEvidenceAt(
  source: Candle[] | undefined,
  time: number,
  intervalSeconds: number,
  minimum: number
): TimingEvidence {
  if (!Array.isArray(source) || source.length === 0) {
    return { candles: null, reason: 'historical candles are missing' };
  }

  let lo = 0;
  let hi = source.length - 1;
  let end = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candle = source[mid];
    if (!candle || !Number.isFinite(candle.time)) {
      return { candles: null, reason: 'historical candle timestamps are invalid' };
    }
    if (candle.time + intervalSeconds <= time) {
      end = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (end < 0) return { candles: null, reason: 'no timing candle had closed at replay time' };
  const start = Math.max(0, end + 1 - Math.max(LOOKBACK, minimum));
  const candles = source.slice(start, end + 1);
  if (candles.length < minimum) return { candles: null, reason: 'insufficient closed timing candles' };

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    if (
      !Number.isFinite(candle.time) || !Number.isFinite(candle.open) || candle.open <= 0 ||
      !Number.isFinite(candle.high) || candle.high <= 0 || !Number.isFinite(candle.low) || candle.low <= 0 ||
      !Number.isFinite(candle.close) || candle.close <= 0 || !Number.isFinite(candle.volume) || candle.volume < 0 ||
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.time + intervalSeconds > time ||
      (i > 0 && candle.time - candles[i - 1].time !== intervalSeconds)
    ) return { candles: null, reason: 'closed timing candles are invalid or non-contiguous' };
  }

  const latest = candles[candles.length - 1];
  const age = time - latest.time;
  if (age < intervalSeconds) return { candles: null, reason: 'latest timing candle is future or unclosed' };
  if (age > intervalSeconds * 2) return { candles: null, reason: 'latest timing candle is stale' };
  return { candles, reason: null };
}

/** Explain why replay cannot satisfy an enabled live timing gate. */
export function replayTimingBlockReason(
  signal: Signal,
  risk: RiskConfig,
  timing15m: Candle[] | undefined,
  timing5m: Candle[] | undefined,
  time: number
): string | null {
  if (risk.microTiming15mEnabled !== false || risk.reversal15mRequired !== false) {
    const evidence = timingEvidenceAt(timing15m, time, 900, 15);
    if (!evidence.candles) return `15m timing gate abstained: ${evidence.reason}`;
  }

  if (risk.microTiming15mEnabled !== false && signal.timingReady !== true) {
    return '15m micro-timing gate is not confirmed by closed replay candles';
  }

  if (risk.reversal15mRequired !== false && signal.reversalConfirmed !== true) {
    if (risk.ltfSniper5mEnabled === false) {
      return '15m reversal gate is unconfirmed and the 5m fallback is disabled';
    }
    const fallback = timingEvidenceAt(timing5m, time, 300, 15);
    if (!fallback.candles || !replayLtfReversalReady(fallback.candles, signal.side)) {
      return `15m reversal gate lacks a valid 5m fallback: ${fallback.reason ?? '5m reversal is unconfirmed'}`;
    }
  }

  if (risk.ltfSniper5mEnabled !== false) {
    const evidence = timingEvidenceAt(timing5m, time, 300, 15);
    if (!evidence.candles) return `5m sniper gate abstained: ${evidence.reason}`;
    if (!replayLtfReversalReady(evidence.candles, signal.side)) {
      return '5m sniper gate is not confirmed by closed replay candles';
    }
  }

  return null;
}

/** Replay-time equivalent of the strategy's 5m reversal check, without Date.now(). */
function replayLtfReversalReady(candles: Candle[], side: Signal['side']): boolean {
  if (candles.length >= 15) {
    const value = rsi(candles.map((candle) => candle.close), 14);
    if (!Number.isFinite(value) || (side === 'LONG' && value > 78) || (side === 'SHORT' && value < 22)) {
      return false;
    }
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const range = Math.max(0.0000001, last.high - last.low);
  if (side === 'LONG') {
    const hammer = (Math.min(last.open, last.close) - last.low) / range >= 0.35;
    return !(
      last.close < last.open && previous.close < previous.open && last.close < previous.close && !hammer
    ) && (last.close >= last.open || hammer);
  }

  const star = (last.high - Math.max(last.open, last.close)) / range >= 0.35;
  return !(
    last.close > last.open && previous.close > previous.open && last.close > previous.close && !star
  ) && (last.close <= last.open || star);
}

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

  /** Equity base and value of the latest return, replaceable after final settlement. */
  private lastReturnBase = 0;

  private lastReturnValue = 0;

  /** Simulated timestamp of the most recent entry, in seconds. */
  private lastEntryTime = 0;

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
      const price = finalPrices.get(position.symbol);
      const market = this.bySymbol.get(position.symbol);
      const index = market ? this.latestIndexAt(market, last) : -1;
      if (price === undefined || !market || index < 0) {
        throw new Error(`geen afsluitprijs beschikbaar voor ${position.symbol}`);
      }
      const closedAt = this.closeTime(market.candles[index]);
      if (closedAt !== last) throw new Error(`verouderde afsluitprijs voor ${position.symbol}`);
      const closeBar = timeline.indexOf(closedAt);
      if (closeBar < 0) throw new Error(`geen afsluitbar beschikbaar voor ${position.symbol}`);
      this.settle(position, price, 'MANUAL', closedAt, closeBar);
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
    this.replaceLastReturn(settledEquity);
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
      this.lastReturnBase = this.prevEquity;
      this.lastReturnValue = r;
    }
    this.prevEquity = equity;
  }

  private replaceLastReturn(equity: number): void {
    if (this.returnCount && this.lastReturnBase > 0) {
      const next = (equity - this.lastReturnBase) / this.lastReturnBase;
      this.returnSum += next - this.lastReturnValue;
      this.returnSquares += next * next - this.lastReturnValue * this.lastReturnValue;
      this.lastReturnValue = next;
    }
    this.prevEquity = equity;
  }

  /** Ordered union of every bar timestamp across all markets. */
  private buildTimeline(): number[] {
    const times = new Set<number>();
    for (const market of this.markets) {
      for (let i = WARMUP_BARS; i < market.candles.length; i += 1) {
        const closedAt = this.closeTime(market.candles[i]);
        if (closedAt >= this.config.from && closedAt <= this.config.to) times.add(closedAt);
      }
    }
    return [...times].sort((a, b) => a - b);
  }

  /** Latest available close price of every market at or before a timestamp. */
  private pricesAt(time: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const market of this.markets) {
      const index = this.latestIndexAt(market, time);
      if (index >= 0) out.set(market.symbol, market.candles[index].close);
    }
    return out;
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
    if (cursor < candles.length && this.closeTime(candles[cursor]) <= time) {
      while (cursor + 1 < candles.length && this.closeTime(candles[cursor + 1]) <= time) cursor += 1;
      this.indexCursor.set(market.symbol, cursor);
      return this.closeTime(candles[cursor]) === time ? cursor : -1;
    }

    let lo = 0;
    let hi = candles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.closeTime(candles[mid]);
      if (t === time) {
        this.indexCursor.set(market.symbol, mid);
        return mid;
      }
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Index of the latest candle that had closed at `time`, or -1. */
  private latestIndexAt(market: MarketHistory, time: number): number {
    const candles = market.candles;
    let lo = 0;
    let hi = candles.length - 1;
    let latest = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.closeTime(candles[mid]) <= time) {
        latest = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return latest;
  }

  private closeTime(candle: Candle): number {
    return candle.time + (INTERVAL_SECONDS[this.config.interval] || 900);
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

      if (isLiquidated(position, candle.open)) {
        this.settle(position, candle.open, 'LIQUIDATED', time, bar);
        continue;
      }

      // Pessimistic ordering: when a bar covers both the stop and a target, assume
      // the stop filled first. Anything else would flatter the results.
      if (isStopHit(position, adverse)) {
        const liquidationBeforeStop = isLiquidated(position, adverse) &&
          (dir === 1
            ? position.entry * (1 - 0.9 / position.leverage) >= position.stopLoss
            : position.entry * (1 + 0.9 / position.leverage) <= position.stopLoss);
        if (liquidationBeforeStop) {
          this.settle(position, adverse, 'LIQUIDATED', time, bar);
        } else {
          const gappedThroughStop = dir === 1 ? candle.open <= position.stopLoss : candle.open >= position.stopLoss;
          this.settle(position, gappedThroughStop ? candle.open : position.stopLoss, stopReason(position), time, bar);
        }
        continue;
      }

      if (isLiquidated(position, adverse)) {
        this.settle(position, adverse, 'LIQUIDATED', time, bar);
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
        const { patch, freedMargin } = partialFillPatch(position, fill, this.exits, this.feeRate);
        Object.assign(position, patch);
        this.balance += freedMargin + fill.bookedPnl;
        this.realised += fill.bookedPnl;
      }

      // With OHLC-only data, assume the favorable extreme came before the adverse
      // one; a stop armed by this bar can therefore also be hit within this bar.
      Object.assign(position, trailPatch(position, favourable, this.exits));
      if (isStopHit(position, adverse)) {
        this.settle(position, position.stopLoss, stopReason(position), time, bar);
        continue;
      }

      const ageHours = (time - position.openedAt / 1000) / 3600;
      if (ageHours > this.risk.maxPositionHours) {
        this.settle(position, candle.close, 'MAX_AGE', time, bar);
        continue;
      }

      const staleHours = this.risk.maxStaleHours ?? 12;
      const isDerisked = isPositionDerisked(position, this.feeRate);
      if (!isDerisked && ageHours > staleHours) {
        const dir = direction(position);
        const r = riskUnit(position);
        const currentR = r > 0 ? (dir * (candle.close - position.entry)) / r : 0;
        if (currentR < 0.8) {
          this.settle(position, candle.close, 'STALE_TRADE', time, bar);
          continue;
        }
      }

    }
  }

  private considerEntries(time: number, bar: number, prices: Map<string, number>): void {
    const equity = this.equityAt(prices);
    const dayPnlPct = this.dayPnlPct(time, equity);
    const account = this.account(equity);

    const atRisk = this.open.filter((p) => !isPositionDerisked(p, this.feeRate));
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
      if (!signal) continue;
      const timing15m = this.timing15mAt(market, time);
      const timing5m = this.timing5mAt(market, time);
      if (replayTimingBlockReason(signal, this.risk, timing15m, timing5m, time)) continue;
      signals.push(signal);
    }
    const ranked = rankCandidates(signals);
    const cooldownSeconds = Math.max(0, this.risk.entryCooldownMinutes ?? 0) * 60;

    let slots = this.risk.maxOpenPositions - atRisk.length;
    let live = account;
    const book = atRisk.map((p) => ({ symbol: p.symbol, side: p.side }));
    for (const signal of ranked) {
      if (cooldownSeconds > 0 && this.lastEntryTime > 0 && time - this.lastEntryTime < cooldownSeconds) break;
      if (slots <= 0) break;
      // Concentration check before sizing: only at-risk positions count against same-side exposure
      if (concentrationBlock(signal, book, this.risk)) continue;
      const plan = planTrade(signal, live, this.risk, this.feeRate);
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
      book.push({ symbol: position.symbol, side: position.side });
      this.balance -= plan.margin + fee;
      this.realised -= fee;
      this.lastEntryTime = time;
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
    if (!Number.isFinite(volumeRatio(candles, 20))) return null;
    const higher = this.higherUpTo(market, time);

    const ticker = ticker24hFromCandles(
      market.symbol,
      market.candles,
      index,
      time,
      INTERVAL_SECONDS[this.config.interval] || 900
    );
    if (!ticker) return null;
    return buildSignal(ticker, candles, higher, this.timing15mAt(market, time) ?? []);
  }

  /** Closed 15m evidence available by replay time; Min15 entry candles are real evidence. */
  private timing15mAt(market: MarketHistory, time: number): Candle[] | undefined {
    const source = market.timing15m ?? this.exactTimingSeries(market, 'Min15');
    return timingEvidenceAt(source, time, 900, 15).candles ?? undefined;
  }

  /** Closed 5m evidence available by replay time; Min5 entry candles are real evidence. */
  private timing5mAt(market: MarketHistory, time: number): Candle[] | undefined {
    const source = market.timing5m ?? this.exactTimingSeries(market, 'Min5');
    return timingEvidenceAt(source, time, 300, 2).candles ?? undefined;
  }

  /** Only reuse a series when its declared API interval exactly matches the timing interval. */
  private exactTimingSeries(market: MarketHistory, interval: 'Min5' | 'Min15'): Candle[] | undefined {
    if (this.config.interval === interval) return market.candles;
    if (this.config.higherInterval === interval) return market.higher;
    return undefined;
  }

  /**
   * Confirmation-timeframe candles that had closed by `time`.
   *
   * Walks a cursor forward across the run instead of re-filtering the whole
   * series on every bar.
   */
  private higherUpTo(market: MarketHistory, time: number): Candle[] {
    let end = this.higherCursor.get(market.symbol) ?? 0;
    while (
      end < market.higher.length &&
      market.higher[end].time + this.higherSeconds() <= time
    ) end += 1;
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

/** Build honest 24h ticker metadata only from a complete, contiguous candle window. */
export function ticker24hFromCandles(
  symbol: string,
  candles: Candle[],
  index: number,
  time: number,
  intervalSeconds: number
): Ticker | null {
  if (
    !Number.isInteger(intervalSeconds) || intervalSeconds <= 0 || DAY_SECONDS % intervalSeconds !== 0 ||
    !Number.isInteger(index) || index < 0 || index >= candles.length
  ) return null;

  const bars = DAY_SECONDS / intervalSeconds;
  const first = index - bars + 1;
  if (first < 1) return null;
  const window = candles.slice(first, index + 1);
  const prior = candles[first - 1];
  const current = candles[index];
  const startTime = time - DAY_SECONDS;
  if (
    window.length !== bars || current.time + intervalSeconds !== time ||
    window[0].time !== startTime || prior.time + intervalSeconds !== startTime ||
    !Number.isFinite(prior.close) || prior.close <= 0
  ) return null;

  let quoteVolume24h = 0;
  for (let i = 0; i < window.length; i += 1) {
    const candle = window[i];
    if (
      (i > 0 && candle.time - window[i - 1].time !== intervalSeconds) ||
      !Number.isFinite(candle.volume) || candle.volume < 0 ||
      !Number.isFinite(candle.close) || candle.close <= 0
    ) return null;
    quoteVolume24h += candle.volume * candle.close;
  }
  if (!Number.isFinite(quoteVolume24h)) return null;

  return {
    symbol,
    lastPrice: current.close,
    quoteVolume24h,
    changeRate24h: (current.close - prior.close) / prior.close,
    // No historical funding series is loaded. NaN marks it unavailable; the
    // current strategy treats unavailable funding as neutral, so funding gates
    // remain an explicit live/replay parity limitation.
    fundingRate: Number.NaN,
  };
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
