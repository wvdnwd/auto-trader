#!/usr/bin/env node
/**
 * STRATEGY VALIDATION — rigorous validation of the current best OOS configuration.
 *
 * Standalone (no external deps). Reuses the EXACT data loading, resampling,
 * no-lookahead fill semantics (signal at bar i close -> fill at bar i+1 open;
 * stop-first intrabar tie rule), cost model and portfolio engine conventions
 * from scripts/strategy-optimizer.mjs (helpers copied verbatim where possible).
 *
 * WINNER UNDER TEST (fixed config, NOT re-optimised):
 *   "1D regime-filtered Donchian/Keltner breakout, long/short"
 *   tf=1D, regime=BTC 1D EMA50>EMA200 (longs) / <EMA200 (shorts),
 *   entry = close > Donchian(55) high OR Keltner(EMA20, 2*ATR14) breakout,
 *   with ATR%(14) > 50-bar rolling median; stop = 3*ATR14;
 *   trail = Donchian(10) opposite side; no fixed TP;
 *   costs ON, 1% risk, 5x cap, 25% notional cap, max 5 concurrent, one/symbol,
 *   $10k start.  This is optimizer combo TC-1D-c-N55-LS-P3.
 *
 * Tasks:
 *   1. Rolling walk-forward (6-month OOS windows, +3 months step, 2023Q1..2026Q3)
 *      with the config FIXED => a stability test, not a re-optimisation.
 *   2. Variant sweep (partial TP / vol-target sizing / direction / regime & TF /
 *      stop-trail grid) to explore the WR / PF / maxDD trade-off.
 *   3. Universe robustness: LONG (50) vs BROAD (145) vs MAJORS (10).
 *   4. Rank by (PF>=2.0 AND maxDD<=25%) and report the best WR under those
 *      constraints, best PF/DD at WR>=45%, best WR at PF>=2.0.
 *
 * Usage:  node scripts/strategy-validation.mjs
 * Writes: data/strategy_validation_results.json
 *
 * NOTHING in this file modifies engine/source code. Research only.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration (kept identical to scripts/strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'data', 'candles_cache');
const OUT_FILE = path.join(ROOT, 'data', 'strategy_validation_results.json');

const START_EQUITY = 10000;

const FEE_PER_SIDE = 0.00045;      // Hyperliquid taker fee per side
const SLIPPAGE_PER_SIDE = 0.0003;  // 3 bps adverse price adjustment per side
const FUNDING_PER_8H = 0.0001;     // ~0.03%/day on notional while open
const USE_COSTS = true;

const RISK_PCT = 0.01;
const LEVERAGE_CAP = 5;
const MAX_POSITIONS = 5;
const MAX_POSITION_NOTIONAL_PCT = 0.25;

const LONG_MIN_BARS = 30000;
const BROAD_MIN_BARS = 8000;

const VOL_TARGETS = [0.15, 0.20];

const HOUR = 3600;
const H4 = 4 * HOUR;
const D1 = 24 * HOUR;

const OOS_START = Date.UTC(2025, 0, 1) / 1000;
const OOS_END = Date.UTC(2026, 8, 28, 23, 59, 59) / 1000;
const MIN_TRADES_RANK = 20;

const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'].map((m) => m + '_USDT');

const PARTIAL_FRAC = 1 / 3;

// ---------------------------------------------------------------------------
// Small utilities (copied from strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

const isNum = (v) => Number.isFinite(v);

function fmt(v, d = 2) {
  if (v === null || v === undefined) return 'n/a';
  if (Number.isNaN(v)) return 'n/a';
  if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
  return v.toFixed(d);
}

function pct(v, d = 2) {
  if (!Number.isFinite(v)) return 'n/a';
  return (v * 100).toFixed(d) + '%';
}

function tsToDate(t) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function mean(a) { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : NaN; }
function std(a) { if (a.length < 2) return NaN; const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / (a.length - 1)); }

function findBarAtOrAfter(arr, t) {
  let lo = 0; let hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
  return lo < arr.length ? lo : -1;
}

function addMonthsUTC(ts, months) {
  const d = new Date(ts * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()) / 1000;
}

// ---------------------------------------------------------------------------
// Indicators (copied from strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

function ema(src, period) {
  const n = src.length;
  const out = new Float32Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += src[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) { prev = src[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function sma(src, period) {
  const n = src.length;
  const out = new Float32Array(n).fill(NaN);
  let sum = 0; let cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (isNum(v)) { sum += v; cnt++; }
    if (i >= period) { const old = src[i - period]; if (isNum(old)) { sum -= old; cnt--; } }
    if (i >= period - 1 && cnt === period) out[i] = sum / period;
  }
  return out;
}

function rollingMedian(src, period) {
  const n = src.length;
  const out = new Float32Array(n).fill(NaN);
  const minCount = Math.max(3, period >> 1);
  for (let i = period; i < n; i++) {
    const w = [];
    for (let j = i - period; j < i; j++) { const v = src[j]; if (isNum(v)) w.push(v); }
    if (w.length < minCount) continue;
    w.sort((a, b) => a - b);
    out[i] = w.length % 2 ? w[(w.length - 1) >> 1] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
  }
  return out;
}

function wilderATR(high, low, close, period) {
  const n = high.length;
  const atr = new Float32Array(n).fill(NaN);
  if (n < period + 1) return atr;
  const tr = new Float32Array(n);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  atr[period] = prev;
  for (let i = period + 1; i < n; i++) { prev = (prev * (period - 1) + tr[i]) / period; atr[i] = prev; }
  return atr;
}

// Donchian shifted by 1: output at i uses bars [i-period, i-1] (excludes current bar).
function donchian(high, low, period) {
  const n = high.length;
  const up = new Float32Array(n).fill(NaN);
  const lo = new Float32Array(n).fill(NaN);
  const dqH = []; const dqL = [];
  let hh = 0; let lh = 0;
  for (let i = 1; i < n; i++) {
    const add = i - 1;
    while (dqH.length > hh && high[dqH[dqH.length - 1]] <= high[add]) dqH.pop();
    dqH.push(add);
    while (dqL.length > lh && low[dqL[dqL.length - 1]] >= low[add]) dqL.pop();
    dqL.push(add);
    const cut = i - period - 1;
    while (dqH.length > hh && dqH[hh] <= cut) hh++;
    while (dqL.length > lh && dqL[lh] <= cut) lh++;
    if (i >= period) { up[i] = high[dqH[hh]]; lo[i] = low[dqL[lh]]; }
  }
  return { up, lo };
}

// ---------------------------------------------------------------------------
// Resampling (copied from strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

function resample(time, open, high, low, close, volume, interval) {
  const n = time.length;
  const t = []; const o = []; const h = []; const l = []; const c = []; const v = [];
  let curBucket = null;
  for (let i = 0; i < n; i++) {
    const b = Math.floor(time[i] / interval) * interval;
    if (b !== curBucket) {
      curBucket = b;
      t.push(b); o.push(open[i]); h.push(high[i]); l.push(low[i]); c.push(close[i]); v.push(volume[i]);
    } else {
      const k = t.length - 1;
      if (high[i] > h[k]) h[k] = high[i];
      if (low[i] < l[k]) l[k] = low[i];
      c[k] = close[i];
      v[k] += volume[i];
    }
  }
  return {
    time: Float64Array.from(t), open: Float32Array.from(o), high: Float32Array.from(h),
    low: Float32Array.from(l), close: Float32Array.from(c), volume: Float32Array.from(v),
  };
}

function makeClosedLookup(bucketTimes, interval) {
  let p = -1;
  return function lookup(t) {
    while (p + 1 < bucketTimes.length && bucketTimes[p + 1] + interval <= t) p++;
    return p;
  };
}

// ---------------------------------------------------------------------------
// Data loading (copied from strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

function listSymbolFiles() {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => /_1h\.json$/.test(f));
  files.sort();
  return files.map((f) => ({ file: path.join(CACHE_DIR, f), sym: f.replace(/_1h\.json$/, '') }));
}

function loadRaw(entry) {
  const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const n = raw.length;
  const time = new Int32Array(n);
  const open = new Float32Array(n); const high = new Float32Array(n); const low = new Float32Array(n);
  const close = new Float32Array(n); const volume = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    time[i] = r.time; open[i] = r.open; high[i] = r.high; low[i] = r.low; close[i] = r.close; volume[i] = r.volume;
  }
  return { sym: entry.sym, n, time, open, high, low, close, volume };
}

// ---------------------------------------------------------------------------
// Bundle builder (trend purpose; adds the Donchian(20) H1 maps the optimizer
// did not need so the stop/trail grid can use a Donchian(20) trail).
// ---------------------------------------------------------------------------

function mapArrToH1(sym, bundle, arr) {
  const out = new Float32Array(sym.n).fill(NaN);
  if (bundle.tf === HOUR) { out.set(arr); return out; }
  const lookup = makeClosedLookup(bundle.time, bundle.tf);
  for (let i = 0; i < sym.n; i++) {
    const h = lookup(sym.time[i]);
    if (h >= 0) out[i] = arr[h];
  }
  return out;
}

function buildBundle(sym, tf, purpose) {
  const key = purpose + ':' + tf;
  if (sym.bundles[key]) return sym.bundles[key];
  const series = tf === HOUR
    ? { time: sym.time, open: sym.open, high: sym.high, low: sym.low, close: sym.close, volume: sym.volume }
    : resample(sym.time, sym.open, sym.high, sym.low, sym.close, sym.volume, tf);
  const b = { tf, n: series.close.length, time: series.time, open: series.open, high: series.high, low: series.low, close: series.close, volume: series.volume };

  if (purpose === 'trend') {
    b.ema20 = ema(series.close, 20);
    b.ema50 = ema(series.close, 50);
    b.ema200 = ema(series.close, 200);
    b.atr14 = wilderATR(series.high, series.low, series.close, 14);
    b.atr22 = wilderATR(series.high, series.low, series.close, 22);
    const atrPct = new Float32Array(b.n).fill(NaN);
    for (let i = 0; i < b.n; i++) if (isNum(b.atr14[i]) && series.close[i] > 0) atrPct[i] = b.atr14[i] / series.close[i];
    b.atrPct = atrPct;
    b.atrPctMed50 = rollingMedian(atrPct, 50);
    b.d20 = donchian(series.high, series.low, 20);
    b.d55 = donchian(series.high, series.low, 55);
    b.d10 = donchian(series.high, series.low, 10);
    b.d27 = donchian(series.high, series.low, 27);
    b.kelU = new Float32Array(b.n).fill(NaN);
    b.kelL = new Float32Array(b.n).fill(NaN);
    for (let i = 0; i < b.n; i++) if (isNum(b.ema20[i]) && isNum(b.atr14[i])) { b.kelU[i] = b.ema20[i] + 2 * b.atr14[i]; b.kelL[i] = b.ema20[i] - 2 * b.atr14[i]; }
    b.atr22H1 = mapArrToH1(sym, b, b.atr22);
    b.donLo10H1 = mapArrToH1(sym, b, b.d10.lo);
    b.donUp10H1 = mapArrToH1(sym, b, b.d10.up);
    b.donLo20H1 = mapArrToH1(sym, b, b.d20.lo);
    b.donUp20H1 = mapArrToH1(sym, b, b.d20.up);
    b.donLo27H1 = mapArrToH1(sym, b, b.d27.lo);
    b.donUp27H1 = mapArrToH1(sym, b, b.d27.up);
    b.ema20H1 = mapArrToH1(sym, b, b.ema20);
  }
  sym.bundles[key] = b;
  return b;
}

// ---------------------------------------------------------------------------
// BTC regime helpers (copied from strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

let BTC = null;
const btcRegimeLong = new Map(); // key `${tf}` -> Map<bucketStart, +1|-1|0>

function btcRegimeAt(tf, bucketStart) {
  const m = btcRegimeLong.get(tf);
  if (!m) return 0;
  const v = m.get(bucketStart);
  return v === undefined ? 0 : v;
}

// ---------------------------------------------------------------------------
// Signal generation (copied from strategy-optimizer.mjs)
// ---------------------------------------------------------------------------

const sigCache = new Map();

function emptySig(n) {
  return { dir: new Int8Array(n), atr: new Float32Array(n), target: new Float32Array(n).fill(NaN), tstop: new Int32Array(n) };
}

function genTrendSignal(sym, tf, regime, N, side) {
  const key = `trend|${sym.sym}|${tf}|${regime}|${N}|${side}`;
  if (sigCache.has(key)) return sigCache.get(key);
  const bd = sym.bundles['trend:' + tf];
  const out = emptySig(sym.n);
  const donUp = N === 20 ? bd.d20.up : bd.d55.up;
  const donLo = N === 20 ? bd.d20.lo : bd.d55.lo;
  let prevLong = false; let prevShort = false;
  for (let b = 1; b < bd.n; b++) {
    const c = bd.close[b];
    let cl = false; let cs = false;
    if (isNum(c) && isNum(bd.atr14[b]) && isNum(bd.atrPct[b]) && isNum(bd.atrPctMed50[b])) {
      const volExp = bd.atrPct[b] > bd.atrPctMed50[b];
      const upBrk = (isNum(donUp[b]) && c > donUp[b]) || (isNum(bd.kelU[b]) && c > bd.kelU[b]);
      const dnBrk = (isNum(donLo[b]) && c < donLo[b]) || (isNum(bd.kelL[b]) && c < bd.kelL[b]);
      let regLong = false; let regShort = false;
      if (regime === 'a') { regLong = isNum(bd.ema200[b]) && c > bd.ema200[b]; regShort = isNum(bd.ema200[b]) && c < bd.ema200[b]; }
      else if (regime === 'b') { regLong = isNum(bd.ema50[b]) && isNum(bd.ema200[b]) && bd.ema50[b] > bd.ema200[b]; regShort = isNum(bd.ema50[b]) && isNum(bd.ema200[b]) && bd.ema50[b] < bd.ema200[b]; }
      else { const r = btcRegimeAt(tf, bd.time[b]); regLong = r === 1; regShort = r === -1; }
      cl = volExp && upBrk && regLong;
      cs = volExp && dnBrk && regShort;
    }
    if ((cl && !prevLong) || (cs && !prevShort)) {
      const bucketClose = bd.time[b] + bd.tf;
      const i = findBarAtOrAfter(sym.time, bucketClose);
      if (i >= 0) {
        if (cl && !prevLong && (side === 'long' || side === 'both')) { out.dir[i] = 1; out.atr[i] = bd.atr14[b]; }
        else if (cs && !prevShort && (side === 'short' || side === 'both')) { out.dir[i] = -1; out.atr[i] = bd.atr14[b]; }
      }
    }
    prevLong = cl; prevShort = cs;
  }
  sigCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Portfolio simulation (adapted from strategy-optimizer.mjs).
// Extensions vs the optimizer runSim:
//   - optional partial take-profit (bank PARTIAL_FRAC at +X R, move stop to BE);
//   - configurable volatility-target sizing;
//   - Donchian(20) and chandelier(3/4) trail options;
//   - funding stays charged on the REMAINING qty after a partial.
// ---------------------------------------------------------------------------

let integrityFills = 0;
let integrityHtfChecks = 0;
let integrityHtfViolations = 0;

function emptySummary(label, reason) {
  return {
    label, trades: 0, wins: 0, losses: 0, winRate: NaN, profitFactor: NaN, expectancyR: NaN,
    roiPct: NaN, maxDDPct: NaN, finalEquity: START_EQUITY, reason, perYear: [],
    exposurePct: NaN, longTrades: 0, shortTrades: 0, distinctSymbols: 0, topSymbols: [],
    grossPl: NaN, feesPaid: NaN, fundingPaid: NaN, costDragPctOfGross: NaN,
  };
}

function runSim(combo, universe, winStart, winEnd, GLOBAL) {
  const NG = GLOBAL.length;
  let gStart = 0; while (gStart < NG && GLOBAL[gStart] < winStart) gStart++;
  let gEnd = NG - 1; while (gEnd >= 0 && GLOBAL[gEnd] > winEnd) gEnd--;
  if (gEnd < gStart) return emptySummary(combo.id, 'empty window');

  const nSym = universe.length;
  const cur = new Int32Array(nSym);
  const posMap = new Map();
  const pendingEntry = new Map();
  const lastClose = new Map();
  const trades = [];

  let realized = START_EQUITY;
  let equityMark = START_EQUITY;
  let peak = START_EQUITY;
  let maxDD = 0;
  let barsWithPos = 0;
  const dailyRets = [];
  let curDay = null;
  let prevDayEq = START_EQUITY;

  const feeRate = USE_COSTS ? FEE_PER_SIDE : 0;
  const slipRate = USE_COSTS ? SLIPPAGE_PER_SIDE : 0;
  const volTarget = combo.volTarget || VOL_TARGET_ANNUAL_FALLBACK;

  const canOpen = (sym) => !posMap.has(sym) && !pendingEntry.has(sym) && (posMap.size + pendingEntry.size) < MAX_POSITIONS;

  function volScaleNow() {
    if (combo.sizing !== 'volTarget') return 1;
    if (dailyRets.length < 20) return 1;
    const sd = std(dailyRets.slice(-30));
    if (!(sd > 0)) return 1;
    const ann = sd * Math.sqrt(365);
    return Math.max(0.25, Math.min(2, volTarget / ann));
  }

  function fillEntry(s, i, pe) {
    if (pe.signalIndex >= i) throw new Error(`LOOKAHEAD VIOLATION: fill bar ${i} <= signal bar ${pe.signalIndex} for ${s.sym}`);
    integrityFills++;
    const dir = pe.dir;
    const entryFill = dir > 0 ? s.open[i] * (1 + slipRate) : s.open[i] * (1 - slipRate);
    const stopAbs = dir > 0 ? entryFill - pe.stopDist : entryFill + pe.stopDist;
    const dist = dir > 0 ? entryFill - stopAbs : stopAbs - entryFill;
    if (!(dist > 0)) return;
    let qty = pe.riskAmount / dist;
    const maxN = Math.min(LEVERAGE_CAP * equityMark, MAX_POSITION_NOTIONAL_PCT * equityMark);
    if (qty * entryFill > maxN) qty = maxN / entryFill;
    if (!(qty > 0)) return;
    const actualRisk = qty * dist;
    const entryFee = qty * entryFill * feeRate;
    realized -= entryFee;
    const partial = combo.partial ? {
      levelR: combo.partial.levelR,
      frac: combo.partial.frac,
      price: dir > 0 ? entryFill + combo.partial.levelR * dist : entryFill - combo.partial.levelR * dist,
      done: false,
    } : null;
    posMap.set(s.sym, {
      sym: s.sym, dir, qty, initQty: qty, entry: entryFill, initialStop: stopAbs, risk: actualRisk,
      feesPaid: entryFee, funding: 0, grossPl: 0, entryTime: GLOBAL[gCur], entryIndex: i,
      highSince: dir > 0 ? s.high[i] : s.low[i],
      trailStop: dir > 0 ? -Infinity : Infinity,
      target: pe.targetAbs != null && isNum(pe.targetAbs) ? pe.targetAbs : null,
      timeStopBar: pe.timeStopH1 > 0 ? i + pe.timeStopH1 : null,
      partial,
    });
  }

  function exitPortion(s, p, qty, fill, t, isFinal) {
    const gross = (fill - p.entry) * qty * p.dir;
    const fee = fill * qty * feeRate;
    realized += gross - fee;
    p.feesPaid += fee;
    p.grossPl += gross;
    p.qty -= qty;
    if (isFinal || p.qty <= 1e-9) {
      const pnl = p.grossPl - p.feesPaid - p.funding;
      trades.push({
        sym: p.sym, strategy: combo.archetype, dir: p.dir, entryTime: p.entryTime, exitTime: t,
        entry: p.entry, risk: p.risk, pnl, r: p.risk > 0 ? pnl / p.risk : 0,
        fees: p.feesPaid, funding: p.funding, grossPl: p.grossPl,
      });
      posMap.delete(p.sym);
    }
  }

  function exitFull(s, p, fill, t) { exitPortion(s, p, p.qty, fill, t, true); }

  function closeAtMarket(s, i, t) {
    const p = posMap.get(s.sym);
    if (!p) return;
    const raw = s.open[i];
    const fill = p.dir > 0 ? raw * (1 - slipRate) : raw * (1 + slipRate);
    exitFull(s, p, fill, t);
  }

  function manage(s, i, t) {
    const p = posMap.get(s.sym);
    if (!p) return;
    const dir = p.dir; const long = dir > 0;

    if (USE_COSTS) {
      const notional = p.qty * s.close[i];
      const f = notional * FUNDING_PER_8H / 8;
      realized -= f; p.funding += f;
    }

    if (p.timeStopBar != null && i >= p.timeStopBar) { closeAtMarket(s, i, t); return; }

    const eff = long ? Math.max(p.initialStop, p.trailStop) : Math.min(p.initialStop, p.trailStop);
    const hit = long ? s.low[i] <= eff : s.high[i] >= eff;
    if (hit) {
      const raw = long ? Math.min(eff, s.open[i]) : Math.max(eff, s.open[i]);
      const fill = long ? raw * (1 - slipRate) : raw * (1 + slipRate);
      exitFull(s, p, fill, t);
      return;
    }

    if (p.target != null) {
      const thit = long ? s.high[i] >= p.target : s.low[i] <= p.target;
      if (thit) {
        const raw = p.target;
        const fill = long ? raw * (1 - slipRate) : raw * (1 + slipRate);
        exitFull(s, p, fill, t);
        return;
      }
    }

    // partial take-profit (stop is checked BEFORE the partial: conservative tie rule)
    if (p.partial && !p.partial.done) {
      const phit = long ? s.high[i] >= p.partial.price : s.low[i] <= p.partial.price;
      if (phit) {
        const q = Math.min(p.qty, p.initQty * p.partial.frac);
        const fill = long ? p.partial.price * (1 - slipRate) : p.partial.price * (1 + slipRate);
        exitPortion(s, p, q, fill, t, p.qty - q <= 1e-9);
        p.partial.done = true;
        if (posMap.has(s.sym)) p.initialStop = p.entry; // move stop to breakeven
        if (!posMap.has(s.sym)) return;
      }
    }

    // trailing update
    if (long && s.high[i] > p.highSince) p.highSince = s.high[i];
    if (!long && s.low[i] < p.highSince) p.highSince = s.low[i];
    const bd = s.bundles[combo.bundleKey];
    let cand = NaN;
    if (combo.trail.kind === 'chand' && bd) {
      const a = bd.atr22H1[i];
      if (isNum(a)) cand = long ? p.highSince - combo.trail.mult * a : p.highSince + combo.trail.mult * a;
    } else if (combo.trail.kind === 'donch' && bd) {
      const n = combo.trail.n;
      if (n === 10) cand = long ? bd.donLo10H1[i] : bd.donUp10H1[i];
      else if (n === 20) cand = long ? bd.donLo20H1[i] : bd.donUp20H1[i];
      else cand = long ? bd.donLo27H1[i] : bd.donUp27H1[i];
    } else if (combo.trail.kind === 'ema' && bd) {
      cand = bd.ema20H1[i];
    }
    if (isNum(cand)) p.trailStop = long ? Math.max(p.trailStop, cand) : Math.min(p.trailStop, cand);
  }

  let gCur = gStart;
  for (let g = gStart; g <= gEnd; g++) {
    gCur = g;
    const t = GLOBAL[g];
    for (let si = 0; si < nSym; si++) {
      const s = universe[si];
      let i = cur[si];
      while (i < s.n && s.time[i] < t) i++;
      cur[si] = i;
      if (i >= s.n || s.time[i] !== t) continue;

      if (pendingEntry.has(s.sym)) {
        const pe = pendingEntry.get(s.sym);
        pendingEntry.delete(s.sym);
        if (!posMap.has(s.sym) && posMap.size < MAX_POSITIONS) fillEntry(s, i, pe);
      }
      if (posMap.has(s.sym)) manage(s, i, t);
      lastClose.set(s.sym, s.close[i]);

      const sig = combo.sig.get(s.sym);
      if (sig && sig.dir[i] !== 0) {
        const d = sig.dir[i];
        if ((d > 0 && combo.direction !== 'short') || (d < 0 && combo.direction !== 'long')) {
          if (canOpen(s.sym)) {
            pendingEntry.set(s.sym, {
              dir: d, signalIndex: i, stopDist: combo.stopAtrMult * sig.atr[i],
              targetAbs: sig.target[i], timeStopH1: sig.tstop[i],
              riskAmount: RISK_PCT * equityMark * volScaleNow(),
            });
          }
        }
      }
    }

    let eqv = realized;
    if (posMap.size) {
      for (const [sym, p] of posMap) {
        const mark = lastClose.has(sym) ? lastClose.get(sym) : p.entry;
        eqv += (mark - p.entry) * p.qty * p.dir;
      }
    }
    equityMark = eqv;
    if (eqv > peak) peak = eqv;
    const dd = peak > 0 ? (peak - eqv) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (posMap.size > 0) barsWithPos++;

    const day = Math.floor(t / D1);
    if (curDay === null) { curDay = day; prevDayEq = eqv; }
    else if (day !== curDay) {
      dailyRets.push(prevDayEq > 0 ? eqv / prevDayEq - 1 : 0);
      curDay = day; prevDayEq = eqv;
    } else prevDayEq = eqv;
  }

  // force-close everything at the final bar's close
  if (posMap.size) {
    const tEnd = GLOBAL[gEnd];
    for (const [, p] of Array.from(posMap.entries())) {
      const sym = p.sym;
      const mark = lastClose.has(sym) ? lastClose.get(sym) : p.entry;
      const fill = p.dir > 0 ? mark * (1 - slipRate) : mark * (1 + slipRate);
      exitFull({ sym }, p, fill, tEnd);
    }
  }

  // ------------------------------------------------------------------ metrics
  const nT = trades.length;
  let wins = 0; let losses = 0; let grossProfit = 0; let grossLoss = 0; let sumR = 0;
  let fees = 0; let funding = 0; let gross = 0; let longN = 0; let shortN = 0;
  const bySym = new Map();
  const byYear = new Map();
  for (const tr of trades) {
    if (tr.pnl >= 0) { wins++; grossProfit += tr.pnl; } else { losses++; grossLoss += -tr.pnl; }
    sumR += tr.r;
    fees += tr.fees; funding += tr.funding; gross += tr.grossPl;
    if (tr.dir > 0) longN++; else shortN++;
    bySym.set(tr.sym, (bySym.get(tr.sym) || 0) + 1);
    const y = new Date(tr.exitTime * 1000).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(tr);
  }
  const symCounts = Array.from(bySym.entries()).sort((a, b) => b[1] - a[1]);
  const perYear = [];
  for (const y of Array.from(byYear.keys()).sort()) {
    const tY = byYear.get(y);
    let yw = 0; let ygp = 0; let ygl = 0;
    for (const tr of tY) { if (tr.pnl >= 0) { yw++; ygp += tr.pnl; } else { ygl += -tr.pnl; } }
    perYear.push({ year: y, trades: tY.length, winRate: yw / tY.length, profitFactor: ygl > 0 ? ygp / ygl : (ygp > 0 ? Infinity : NaN) });
  }

  return {
    label: combo.id,
    trades: nT,
    wins,
    losses,
    winRate: nT ? wins / nT : NaN,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : NaN),
    expectancyR: nT ? sumR / nT : NaN,
    roiPct: (realized / START_EQUITY - 1) * 100,
    maxDDPct: maxDD * 100,
    finalEquity: realized,
    exposurePct: (barsWithPos / (gEnd - gStart + 1)) * 100,
    perYear,
    longTrades: longN,
    shortTrades: shortN,
    grossPl: gross,
    feesPaid: fees,
    fundingPaid: funding,
    costDragPctOfGross: gross > 0 ? ((fees + funding) / gross) * 100 : NaN,
    topSymbols: symCounts.slice(0, 8),
    distinctSymbols: symCounts.length,
  };
}

const VOL_TARGET_ANNUAL_FALLBACK = 0.17;

// ---------------------------------------------------------------------------
// Config plumbing
// ---------------------------------------------------------------------------

const TF_LABEL = (tf) => (tf === H4 ? '4H' : tf === D1 ? '1D' : '1H');
const TRAIL_LABEL = (tr) => tr.kind === 'chand' ? `chand${tr.mult}` : tr.kind === 'donch' ? `don${tr.n}` : tr.kind;
const REGIME_LABEL = { a: 'price>EMA200', b: 'EMA50>EMA200', c: 'BTC-EMA50>200' };

const sigMapMemo = new Map();
function sigMapFor(tf, regime, N, side, allSyms) {
  const key = `${tf}|${regime}|${N}|${side}`;
  if (sigMapMemo.has(key)) return sigMapMemo.get(key);
  const m = new Map();
  for (const s of allSyms) m.set(s.sym, genTrendSignal(s, tf, regime, N, side));
  sigMapMemo.set(key, m);
  return m;
}

function makeCombo(spec, allSyms) {
  return {
    id: spec.id,
    archetype: 'breakout',
    tf: spec.tf,
    direction: spec.direction,
    sizing: spec.sizing || 'fixed',
    volTarget: spec.volTarget,
    bundleKey: 'trend:' + spec.tf,
    stopAtrMult: spec.stopAtrMult,
    trail: spec.trail,
    partial: spec.partial || null,
    sig: sigMapFor(spec.tf, spec.regime, spec.N, spec.side, allSyms),
    axes: spec.axes || {},
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const log = [];
  const say = (s = '') => { console.log(s); log.push(s); };

  say('============================================================================');
  say('  STRATEGY VALIDATION — fixed-config robustness + variant sweep');
  say('============================================================================');
  say('');
  say('COST MODEL (costs ON for every run; identical to scripts/strategy-optimizer.mjs):');
  say(`  taker fee per side ............ ${FEE_PER_SIDE} (${(FEE_PER_SIDE * 100).toFixed(4)}%)`);
  say(`  slippage per side ............. ${SLIPPAGE_PER_SIDE} (${(SLIPPAGE_PER_SIDE * 100).toFixed(4)}%) adverse price adjustment`);
  say(`  round-trip explicit cost ...... ~${((FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2 * 100).toFixed(4)}% of notional`);
  say(`  funding (approx) .............. ${FUNDING_PER_8H} per 8h ~= ${(FUNDING_PER_8H * 3 * 100).toFixed(4)}%/day on notional while open`);
  say('  ASSUMPTION: no funding series exists in the cache; funding is charged as notional * rate/8 per open 1H bar.');
  say('');
  say('RISK / PORTFOLIO (identical to the optimizer):');
  say(`  start equity .................. $${START_EQUITY}`);
  say(`  risk per trade ................ ${RISK_PCT * 100}% of current equity, or vol-targeted (${VOL_TARGETS.map((v) => (v * 100) + '%').join(' / ')} annual portfolio vol)`);
  say(`  leverage cap .................. ${LEVERAGE_CAP}x  |  notional cap ${MAX_POSITION_NOTIONAL_PCT * 100}% of equity (stricter binds)`);
  say(`  max concurrent ................ ${MAX_POSITIONS}   |  one position per symbol`);
  say('  partial TP (variants only) ..... bank 1/3 at +X R, move stop to breakeven, remainder trails');
  say('');
  say('WINNER UNDER TEST (config is FIXED; no parameter fitting inside any window):');
  say('  id ............................ TC-1D-c-N55-LS-P3');
  say('  signal TF ..................... 1D');
  say('  regime ........................ BTC 1D EMA50>EMA200 => longs, EMA50<EMA200 => shorts');
  say('  entry ......................... close > Donchian(55) high OR Keltner(EMA20,2*ATR14) breakout,');
  say('                                  ATR%(14) > 50-bar rolling median (volatility expansion)');
  say('  stop .......................... 3 * ATR(14)');
  say('  trail ......................... Donchian(10) opposite side (no fixed TP)');
  say('  OOS window .................... 2025-01-01 -> 2026-09-28');
  say('');

  // ---- load data -----------------------------------------------------------
  const files = listSymbolFiles();
  const rawSyms = [];
  const allTimes = new Set();
  for (const entry of files) {
    const s = loadRaw(entry);
    if (!s) continue;
    s.bundles = {};
    rawSyms.push(s);
    for (let i = 0; i < s.n; i++) allTimes.add(s.time[i]);
  }
  const GLOBAL = Float64Array.from(Array.from(allTimes).sort((a, b) => a - b));
  const NG = GLOBAL.length;
  const DATA_END = GLOBAL[NG - 1];

  const LONG = rawSyms.filter((s) => s.n >= LONG_MIN_BARS).sort((a, b) => a.sym.localeCompare(b.sym));
  const BROAD = rawSyms.filter((s) => s.n >= BROAD_MIN_BARS).sort((a, b) => a.sym.localeCompare(b.sym));
  const MAJORSYMS = MAJORS.map((m) => rawSyms.find((s) => s.sym === m)).filter(Boolean);

  say('DATA / UNIVERSE');
  say(`  symbols loaded ................ ${rawSyms.length}`);
  say(`  global 1H timeline ............ ${NG} bars, ${tsToDate(GLOBAL[0])} -> ${tsToDate(DATA_END)}`);
  say(`  LONG_UNIVERSE (>=${LONG_MIN_BARS} bars): ${LONG.length} symbols`);
  say(`  BROAD_UNIVERSE (>=${BROAD_MIN_BARS} bars): ${BROAD.length} symbols`);
  say(`  MAJORS subset (${MAJORSYMS.length}): ` + MAJORSYMS.map((s) => s.sym.replace('_USDT', '')).join(', '));
  say('');

  BTC = rawSyms.find((s) => s.sym === 'BTC_USDT');
  if (!BTC) throw new Error('BTC_USDT missing');
  BTC.bundles = {};

  // build trend bundles for every BROAD symbol at 4H and 1D
  say('Building trend indicator bundles (4H + 1D) for the full BROAD universe...');
  for (const s of BROAD) { buildBundle(s, H4, 'trend'); buildBundle(s, D1, 'trend'); }
  const btcTrend = {};
  for (const tf of [H4, D1]) btcTrend[TF_LABEL(tf)] = buildBundle(BTC, tf, 'trend');
  for (const tf of [H4, D1]) {
    const bd = btcTrend[TF_LABEL(tf)];
    const m = new Map();
    for (let b = 0; b < bd.n; b++) {
      if (isNum(bd.ema50[b]) && isNum(bd.ema200[b])) m.set(bd.time[b], bd.ema50[b] > bd.ema200[b] ? 1 : -1);
      else m.set(bd.time[b], 0);
    }
    btcRegimeLong.set(tf, m);
  }
  say(`  bundles built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  say('');

  // HTF closed-bucket integrity check (trend bundles)
  for (const s of LONG) {
    for (const tf of [H4, D1]) {
      const bd = s.bundles['trend:' + tf];
      const lookup = makeClosedLookup(bd.time, tf);
      for (let i = 0; i < s.n; i += 97) {
        const h = lookup(s.time[i]);
        if (h >= 0) { integrityHtfChecks++; if (bd.time[h] + tf > s.time[i]) integrityHtfViolations++; }
      }
    }
  }
  say(`ENGINE INTEGRITY: closed-HTF bucket checks=${integrityHtfChecks}, violations=${integrityHtfViolations}`);
  say('');

  // ---- sim cache -----------------------------------------------------------
  const simCache = new Map();
  function simCached(spec, universeSyms, winStart, winEnd) {
    const key = [
      spec.tf, spec.regime, spec.N, spec.side, spec.stopAtrMult, TRAIL_LABEL(spec.trail),
      spec.sizing || 'fixed', spec.volTarget || '', spec.partial ? spec.partial.levelR : 'none',
      spec.direction, universeSyms.length, winStart, winEnd,
    ].join('|');
    if (simCache.has(key)) return simCache.get(key);
    const combo = makeCombo(spec, BROAD);
    const res = runSim(combo, universeSyms, winStart, winEnd, GLOBAL);
    res.id = spec.id;
    simCache.set(key, res);
    return res;
  }

  const BASE = {
    tf: D1, regime: 'c', N: 55, side: 'both', direction: 'both',
    stopAtrMult: 3, trail: { kind: 'donch', n: 10 }, sizing: 'fixed', partial: null,
  };

  // ---- TASK 1: rolling walk-forward ---------------------------------------
  say('============================================================================');
  say('  TASK 1 — ROLLING WALK-FORWARD (config FIXED, stability test only)');
  say('============================================================================');
  say('  Windows: 6-month OOS blocks, stepped forward 3 months; each block starts flat');
  say(`  with $${START_EQUITY}; final block may be truncated by the data end (${tsToDate(DATA_END)}).`);
  say('  No fitting/selection happens per window: identical parameters everywhere.');
  say('');

  const wfWindows = [];
  {
    let ws = Date.UTC(2023, 0, 1) / 1000;
    while (ws < DATA_END) {
      const weFull = addMonthsUTC(ws, 6);
      const we = Math.min(weFull, DATA_END);
      if (we - ws >= 120 * 86400) wfWindows.push({ ws, we, truncated: weFull > DATA_END });
      ws = addMonthsUTC(ws, 3);
    }
  }

  const wfRows = [];
  for (const w of wfWindows) {
    const r = simCached(BASE, LONG, w.ws, w.we);
    wfRows.push({
      window: `${tsToDate(w.ws)}..${tsToDate(w.we)}`,
      days: Math.round((w.we - w.ws) / 86400),
      truncated: w.truncated,
      trades: r.trades, winRate: r.winRate, profitFactor: r.profitFactor,
      expectancyR: r.expectancyR, roiPct: r.roiPct, maxDDPct: r.maxDDPct,
      longTrades: r.longTrades, shortTrades: r.shortTrades,
    });
  }

  const wfHeader = ['window'.padEnd(23), 'days'.padStart(4), 'trades'.padStart(6), 'WR'.padStart(7), 'PF'.padStart(7), 'expR'.padStart(8), 'ROI'.padStart(8), 'DD%'.padStart(7), 'L/S'.padStart(9)].join(' ');
  say(wfHeader);
  say('-'.repeat(wfHeader.length));
  for (const r of wfRows) {
    say([
      r.window.padEnd(23), String(r.days).padStart(4), String(r.trades).padStart(6),
      pct(r.winRate, 1).padStart(7), fmt(r.profitFactor, 3).padStart(7), fmt(r.expectancyR, 3).padStart(8),
      fmt(r.roiPct, 1).padStart(8), fmt(r.maxDDPct, 1).padStart(7),
      `${r.longTrades}/${r.shortTrades}`.padStart(9),
    ].join(' '));
  }
  const pfGt15 = wfRows.filter((r) => isNum(r.profitFactor) && r.profitFactor > 1.5).length;
  const pfGt20 = wfRows.filter((r) => isNum(r.profitFactor) && r.profitFactor > 2.0).length;
  const negWindows = wfRows.filter((r) => !(isNum(r.profitFactor) && r.profitFactor >= 1.0));
  const worstPfRow = [...wfRows].filter((r) => isNum(r.profitFactor)).sort((a, b) => a.profitFactor - b.profitFactor)[0];
  const worstDdRow = [...wfRows].filter((r) => isNum(r.maxDDPct)).sort((a, b) => b.maxDDPct - a.maxDDPct)[0];
  const wfMedianPf = (() => { const a = wfRows.map((r) => r.profitFactor).filter(isNum).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN; })();
  const wfAgg = wfRows.reduce((acc, r) => {
    acc.trades += r.trades; acc.tWins += r.trades * (isNum(r.winRate) ? r.winRate : 0);
    return acc;
  }, { trades: 0, tWins: 0 });

  say('');
  say(`  windows total ................. ${wfRows.length}`);
  say(`  windows PF > 1.5 .............. ${pfGt15} / ${wfRows.length}`);
  say(`  windows PF > 2.0 .............. ${pfGt20} / ${wfRows.length}`);
  say(`  negative windows (PF < 1.0) ... ${negWindows.length}${negWindows.length ? ' -> ' + negWindows.map((r) => r.window).join(', ') : ''}`);
  say(`  worst window by PF ............ ${worstPfRow ? worstPfRow.window + '  PF ' + fmt(worstPfRow.profitFactor, 3) + '  DD ' + fmt(worstPfRow.maxDDPct, 1) + '%  ROI ' + fmt(worstPfRow.roiPct, 1) + '%  n ' + worstPfRow.trades : 'n/a'}`);
  say(`  worst window by DD ............ ${worstDdRow ? worstDdRow.window + '  DD ' + fmt(worstDdRow.maxDDPct, 1) + '%  PF ' + fmt(worstDdRow.profitFactor, 3) + '  ROI ' + fmt(worstDdRow.roiPct, 1) + '%' : 'n/a'}`);
  say(`  median window PF .............. ${fmt(wfMedianPf, 3)}   pooled WR ${pct(wfAgg.trades ? wfAgg.tWins / wfAgg.trades : NaN, 1)} over ${wfAgg.trades} trades`);
  const winnerStable = negWindows.length <= 1;
  say(`  STABILITY VERDICT ............. ${winnerStable ? 'ACCEPTABLE (<=1 negative window)' : 'UNSTABLE (' + negWindows.length + ' negative windows) -> downgrade recommendation'}`);
  say('');

  // ---- TASK 2: variant sweep ----------------------------------------------
  say('============================================================================');
  say('  TASK 2 — VARIANT SWEEP (OOS 2025-01-01..2026-09-28, costs ON)');
  say('============================================================================');

  const variants = [];
  function addVariant(group, id, spec, universeSyms, universeName) {
    const u = universeSyms || LONG;
    const r = simCached(spec, u, OOS_START, OOS_END);
    variants.push({
      group, id, universe: universeName || 'LONG',
      axes: {
        tf: TF_LABEL(spec.tf), regime: spec.regime, N: spec.N, side: spec.side, direction: spec.direction,
        stop: spec.stopAtrMult, trail: TRAIL_LABEL(spec.trail),
        sizing: spec.sizing || 'fixed', volTarget: spec.volTarget || null,
        partialR: spec.partial ? spec.partial.levelR : null,
      },
      trades: r.trades, winRate: r.winRate, profitFactor: r.profitFactor, expectancyR: r.expectancyR,
      roiPct: r.roiPct, maxDDPct: r.maxDDPct, longTrades: r.longTrades, shortTrades: r.shortTrades,
      finalEquity: r.finalEquity,
    });
    return r;
  }

  // --- validate the base reproduces the optimizer's stored OOS numbers ---
  const baseRes = addVariant('A-partial', 'A0-base (no partial)', BASE);
  const EXPECT = { trades: 72, winRate: 0.347, profitFactor: 2.549, roiPct: 40.7, maxDDPct: 22.0 };
  const reproOk =
    baseRes.trades === EXPECT.trades &&
    Math.abs(baseRes.winRate - EXPECT.winRate) < 0.02 &&
    Math.abs(baseRes.profitFactor - EXPECT.profitFactor) < 0.05 &&
    Math.abs(baseRes.roiPct - EXPECT.roiPct) < 1.0 &&
    Math.abs(baseRes.maxDDPct - EXPECT.maxDDPct) < 1.0;
  say(`  ENGINE REPRODUCTION CHECK vs stored optimizer result (TC-1D-c-N55-LS-P3):`);
  say(`    expected n=${EXPECT.trades} WR=${pct(EXPECT.winRate, 1)} PF=${fmt(EXPECT.profitFactor, 3)} ROI=${fmt(EXPECT.roiPct, 1)}% DD=${fmt(EXPECT.maxDDPct, 1)}%`);
  say(`    got      n=${baseRes.trades} WR=${pct(baseRes.winRate, 1)} PF=${fmt(baseRes.profitFactor, 3)} ROI=${fmt(baseRes.roiPct, 1)}% DD=${fmt(baseRes.maxDDPct, 1)}%   -> ${reproOk ? 'MATCH' : 'MISMATCH'}`);
  say('');

  // a. partial take-profit
  for (const levelR of [1, 2, 3]) {
    addVariant('A-partial', `A${levelR}R (bank 1/3 @ +${levelR}R, stop->BE)`,
      { ...BASE, partial: { levelR, frac: PARTIAL_FRAC } }, LONG);
  }
  // b. vol-target sizing
  for (const vt of VOL_TARGETS) {
    addVariant('B-sizing', `B-vol${Math.round(vt * 100)} (target ${Math.round(vt * 100)}% ann)`,
      { ...BASE, sizing: 'volTarget', volTarget: vt }, LONG);
  }
  // c. long-only vs long/short
  addVariant('C-direction', 'C-long-only', { ...BASE, side: 'long', direction: 'long' }, LONG);
  // d. regime / tf variants (N=55, both, stop 3 / donch10)
  const regVariants = [
    ['a', D1, 'D-1D-a (price>EMA200)'],
    ['b', D1, 'D-1D-b (EMA50>EMA200)'],
    ['a', H4, 'D-4H-a (price>EMA200)'],
    ['b', H4, 'D-4H-b (EMA50>EMA200)'],
    ['c', H4, 'D-4H-c (BTC-EMA50>200)'],
  ];
  for (const [regime, tf, id] of regVariants) addVariant('D-regime-tf', id, { ...BASE, regime, tf }, LONG);
  // e. stop/trail grid
  const trails = [
    ['chand3', { kind: 'chand', mult: 3 }],
    ['chand4', { kind: 'chand', mult: 4 }],
    ['don10', { kind: 'donch', n: 10 }],
    ['don20', { kind: 'donch', n: 20 }],
  ];
  for (const stop of [2, 3, 4]) {
    for (const [tl, trail] of trails) {
      addVariant('E-stop-trail', `E-s${stop}-${tl}`, { ...BASE, stopAtrMult: stop, trail }, LONG);
    }
  }

  const vHeader = ['id'.padEnd(34), 'n'.padStart(5), 'WR'.padStart(7), 'PF'.padStart(7), 'expR'.padStart(8), 'ROI'.padStart(8), 'DD%'.padStart(7), 'L/S'.padStart(9)].join(' ');
  say(vHeader);
  say('-'.repeat(vHeader.length));
  let lastGroup = null;
  for (const v of variants) {
    if (v.group !== lastGroup) { say(`[${v.group}]`); lastGroup = v.group; }
    say([
      v.id.padEnd(34), String(v.trades).padStart(5), pct(v.winRate, 1).padStart(7),
      fmt(v.profitFactor, 3).padStart(7), fmt(v.expectancyR, 3).padStart(8),
      fmt(v.roiPct, 1).padStart(8), fmt(v.maxDDPct, 1).padStart(7),
      `${v.longTrades}/${v.shortTrades}`.padStart(9),
    ].join(' '));
  }
  say('');

  // ---- TASK 3: universe robustness ----------------------------------------
  say('============================================================================');
  say('  TASK 3 — UNIVERSE ROBUSTNESS (winner config, OOS 2025-01-01..2026-09-28)');
  say('============================================================================');
  const universeRows = [];
  for (const [name, syms] of [['LONG (50)', LONG], ['BROAD (145)', BROAD], ['MAJORS (10)', MAJORSYMS]]) {
    const r = simCached(BASE, syms, OOS_START, OOS_END);
    universeRows.push({
      universe: name, symbols: syms.length, trades: r.trades, winRate: r.winRate,
      profitFactor: r.profitFactor, expectancyR: r.expectancyR, roiPct: r.roiPct,
      maxDDPct: r.maxDDPct, distinctSymbols: r.distinctSymbols, longTrades: r.longTrades, shortTrades: r.shortTrades,
    });
  }
  const uHeader = ['universe'.padEnd(14), 'syms'.padStart(4), 'trades'.padStart(6), 'traded'.padStart(6), 'WR'.padStart(7), 'PF'.padStart(7), 'expR'.padStart(8), 'ROI'.padStart(8), 'DD%'.padStart(7)].join(' ');
  say(uHeader);
  say('-'.repeat(uHeader.length));
  for (const r of universeRows) {
    say([
      r.universe.padEnd(14), String(r.symbols).padStart(4), String(r.trades).padStart(6),
      String(r.distinctSymbols).padStart(6), pct(r.winRate, 1).padStart(7), fmt(r.profitFactor, 3).padStart(7),
      fmt(r.expectancyR, 3).padStart(8), fmt(r.roiPct, 1).padStart(8), fmt(r.maxDDPct, 1).padStart(7),
    ].join(' '));
  }
  say('');

  // ---- TASK 4: ranking / verdict ------------------------------------------
  say('============================================================================');
  say('  TASK 4 — RANKING & VERDICT (target PF>=2.0 AND maxDD<=25%)');
  say('============================================================================');
  const candAll = variants.filter((v) => isNum(v.profitFactor) && isNum(v.maxDDPct));
  const cand = candAll.filter((v) => v.trades >= MIN_TRADES_RANK);

  const passBoth = cand.filter((v) => v.profitFactor >= 2.0 && v.maxDDPct <= 25);
  const passBothAll = candAll.filter((v) => v.profitFactor >= 2.0 && v.maxDDPct <= 25);
  const wr50 = passBoth.filter((v) => v.winRate >= 0.5);
  const wr50All = passBothAll.filter((v) => v.winRate >= 0.5);
  const bestWrUnder = passBoth.length ? [...passBoth].sort((a, b) => b.winRate - a.winRate)[0] : null;
  const bestWrUnderAll = passBothAll.length ? [...passBothAll].sort((a, b) => b.winRate - a.winRate)[0] : null;
  const bestPfUnder = passBoth.length ? [...passBoth].sort((a, b) => b.profitFactor - a.profitFactor)[0] : null;
  const bestDdUnder = passBoth.length ? [...passBoth].sort((a, b) => a.maxDDPct - b.maxDDPct)[0] : null;

  const wr45 = cand.filter((v) => v.winRate >= 0.45);
  const bestAtWr45 = wr45.length ? [...wr45].sort((a, b) => (b.profitFactor) - (a.profitFactor))[0] : null;
  const bestAtWr45Dd = wr45.filter((v) => v.maxDDPct <= 25);
  const bestAtWr45DdRow = bestAtWr45Dd.length ? [...bestAtWr45Dd].sort((a, b) => (b.profitFactor) - (a.profitFactor))[0] : null;

  const pf2 = cand.filter((v) => v.profitFactor >= 2.0);
  const bestWrAtPf2 = pf2.length ? [...pf2].sort((a, b) => b.winRate - a.winRate)[0] : null;
  const pf2Dd = pf2.filter((v) => v.maxDDPct <= 25);
  const bestWrAtPf2Dd = pf2Dd.length ? [...pf2Dd].sort((a, b) => b.winRate - a.winRate)[0] : null;

  say(`  variant configs evaluated ..... ${candAll.length} (ranking requires >= ${MIN_TRADES_RANK} OOS trades; ${cand.length} qualify)`);
  say('');
  say(`  PF >= 2.0 AND maxDD <= 25% .... ${passBoth.length ? 'MET by ' + passBoth.length + ' variant(s)' : 'NOT MET by any variant with >= ' + MIN_TRADES_RANK + ' trades'}`);
  if (passBoth.length) {
    say('    ' + vHeader);
    for (const v of [...passBoth].sort((a, b) => b.profitFactor - a.profitFactor)) {
      say('    ' + [
        v.id.padEnd(34), String(v.trades).padStart(5), pct(v.winRate, 1).padStart(7),
        fmt(v.profitFactor, 3).padStart(7), fmt(v.expectancyR, 3).padStart(8),
        fmt(v.roiPct, 1).padStart(8), fmt(v.maxDDPct, 1).padStart(7), `${v.longTrades}/${v.shortTrades}`.padStart(9),
      ].join(' '));
    }
  }
  say('');
  say('  DIRECT ANSWERS:');
  const answerAll = wr50All.length
    ? 'YES — ' + wr50All.map((v) => `${v.id} (n=${v.trades}, WR ${pct(v.winRate, 1)}, PF ${fmt(v.profitFactor, 3)}, DD ${fmt(v.maxDDPct, 1)}%)`).join('; ')
    : 'NO variant reaches WR>=50% with PF>=2.0 and maxDD<=25%.';
  say(`  Can any variant reach WR>=50% with PF>=2.0 AND maxDD<=25%?`);
  say(`    ALL variants (incl. < ${MIN_TRADES_RANK} trades): ${answerAll}`);
  say(`    >= ${MIN_TRADES_RANK} trades:                         ${wr50.length ? wr50.map((v) => v.id).join(', ') : 'NO'}`);
  say(`  Best WR while PF>=2.0 AND maxDD<=25%: ${bestWrUnder ? `${bestWrUnder.id} -> WR ${pct(bestWrUnder.winRate, 1)}, PF ${fmt(bestWrUnder.profitFactor, 3)}, expR ${fmt(bestWrUnder.expectancyR, 3)}, ROI ${fmt(bestWrUnder.roiPct, 1)}%, DD ${fmt(bestWrUnder.maxDDPct, 1)}%, n ${bestWrUnder.trades}` : 'n/a'}`);
  if (bestWrUnderAll && bestWrUnder && bestWrUnderAll.id !== bestWrUnder.id) {
    say(`    (including < ${MIN_TRADES_RANK}-trade variants: ${bestWrUnderAll.id} -> WR ${pct(bestWrUnderAll.winRate, 1)}, n ${bestWrUnderAll.trades} — low sample)`);
  }
  say(`  Best PF while PF>=2.0 AND maxDD<=25%: ${bestPfUnder ? `${bestPfUnder.id} -> PF ${fmt(bestPfUnder.profitFactor, 3)}, WR ${pct(bestPfUnder.winRate, 1)}, DD ${fmt(bestPfUnder.maxDDPct, 1)}%, n ${bestPfUnder.trades}` : 'n/a'}`);
  say(`  Lowest DD while PF>=2.0 AND maxDD<=25%: ${bestDdUnder ? `${bestDdUnder.id} -> DD ${fmt(bestDdUnder.maxDDPct, 1)}%, PF ${fmt(bestDdUnder.profitFactor, 3)}, WR ${pct(bestDdUnder.winRate, 1)}, n ${bestDdUnder.trades}` : 'n/a'}`);
  say(`  Best PF/DD at WR>=45%: ${bestAtWr45 ? `${bestAtWr45.id} -> PF ${fmt(bestAtWr45.profitFactor, 3)}, DD ${fmt(bestAtWr45.maxDDPct, 1)}%, WR ${pct(bestAtWr45.winRate, 1)}, n ${bestAtWr45.trades}` : 'n/a'}`);
  say(`    ... of which maxDD<=25%: ${bestAtWr45DdRow ? `${bestAtWr45DdRow.id} -> PF ${fmt(bestAtWr45DdRow.profitFactor, 3)}, DD ${fmt(bestAtWr45DdRow.maxDDPct, 1)}%, WR ${pct(bestAtWr45DdRow.winRate, 1)}, n ${bestAtWr45DdRow.trades}` : 'none'}`);
  say(`  Best WR at PF>=2.0 (no DD constraint): ${bestWrAtPf2 ? `${bestWrAtPf2.id} -> WR ${pct(bestWrAtPf2.winRate, 1)}, PF ${fmt(bestWrAtPf2.profitFactor, 3)}, DD ${fmt(bestWrAtPf2.maxDDPct, 1)}%, n ${bestWrAtPf2.trades}` : 'n/a'}`);
  say(`    ... also with maxDD<=25%: ${bestWrAtPf2Dd ? `${bestWrAtPf2Dd.id} -> WR ${pct(bestWrAtPf2Dd.winRate, 1)}, PF ${fmt(bestWrAtPf2Dd.profitFactor, 3)}, DD ${fmt(bestWrAtPf2Dd.maxDDPct, 1)}%, n ${bestWrAtPf2Dd.trades}` : 'none'}`);
  say('');

  // ---- integrity + caveats -------------------------------------------------
  say('============================================================================');
  say('  INTEGRITY CHECKS');
  say('============================================================================');
  say(`  fills validated strictly after signal bar (throws on violation): ${integrityFills}`);
  say(`  closed-HTF bucket checks / violations ......................... : ${integrityHtfChecks} / ${integrityHtfViolations}`);
  say('  fill rule   = bar i close signal -> bar i+1 OPEN fill');
  say('  signal rule = TF signals only emitted on a CLOSED TF bar, edge-triggered, mapped to the first 1H bar at/after the TF close');
  say('  stop/target/partial tie rule = STOP fills first, then target, then partial');
  say(`  engine reproduction of stored optimizer winner ... ${reproOk ? 'MATCH' : 'MISMATCH'}`);
  say('');
  say('============================================================================');
  say('  CAVEATS');
  say('============================================================================');
  say('  - Survivorship bias: the cache is today\'s symbol list; delisted/never-listed symbols are absent.');
  say('  - 1H granularity only: intrabar sequencing uses high/low with a stop-first assumption; no tick/book data.');
  say('  - Funding approximated (no funding series in cache): notional * 0.0001/8 per open 1H bar.');
  say('  - HTF signals are edge-triggered; a signal firing while a position is open (or at max positions) is dropped, not re-queued.');
  say('  - Rolling windows start flat and do not carry positions across window boundaries.');
  say('  - MULTIPLE-COMPARISON / OVERFITTING RISK: this sweep tests many configurations on one fixed OOS period.');
  say('    The winning variant here is selected on the same data it is judged on; treat the single best as in-sample-ish');
  say('    and weight the rolling walk-forward (Task 1) and cross-universe results (Task 3) more heavily.');
  say(`  - The FIXED winner shows ${negWindows.length} negative rolling window(s), so the recommendation is ${winnerStable ? 'kept' : 'DOWNGRADED'}.`);
  say('');

  // ---- write JSON ----------------------------------------------------------
  const out = {
    generatedAt: new Date().toISOString(),
    script: 'scripts/strategy-validation.mjs',
    winner: {
      id: 'TC-1D-c-N55-LS-P3',
      description: '1D regime-filtered Donchian/Keltner breakout, long/short',
      config: {
        tf: '1D', regime: 'BTC 1D EMA50>EMA200', entry: 'close > Donchian(55) high OR Keltner(EMA20,2*ATR14), ATR%(14) > 50-bar median',
        stop: '3*ATR(14)', trail: 'Donchian(10) opposite', fixedTP: null,
        direction: 'long/short', sizing: 'fixed 1% risk', costs: 'ON',
      },
      fixed: true,
      reproducesStoredOptimizer: reproOk,
      storedExpectation: EXPECT,
      reproduced: { trades: baseRes.trades, winRate: baseRes.winRate, profitFactor: baseRes.profitFactor, roiPct: baseRes.roiPct, maxDDPct: baseRes.maxDDPct },
    },
    costModel: {
      feePerSide: FEE_PER_SIDE, slippagePerSide: SLIPPAGE_PER_SIDE, fundingPer8h: FUNDING_PER_8H,
      roundTripExplicitPct: (FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2,
      note: 'Funding approximated: notional * fundingPer8h/8 per open 1H bar. Costs ON for all runs.',
    },
    risk: {
      startEquity: START_EQUITY, riskPct: RISK_PCT, leverageCap: LEVERAGE_CAP, maxPositions: MAX_POSITIONS,
      maxPositionNotionalPct: MAX_POSITION_NOTIONAL_PCT, volTargets: VOL_TARGETS, partialFraction: PARTIAL_FRAC,
    },
    oos: { start: tsToDate(OOS_START), end: tsToDate(OOS_END) },
    period: { start: tsToDate(GLOBAL[0]), end: tsToDate(DATA_END), globalBars: NG },
    universes: {
      longCount: LONG.length, long: LONG.map((s) => s.sym),
      broadCount: BROAD.length, majors: MAJORSYMS.map((s) => s.sym),
    },
    integrity: {
      fillAfterSignalChecks: integrityFills, htfBucketChecks: integrityHtfChecks, htfBucketViolations: integrityHtfViolations,
      engineReproductionMatch: reproOk,
    },
    task1RollingWalkForward: {
      method: 'FIXED config; 6-month OOS windows stepped +3 months; each window starts flat',
      windowsUsed: wfRows.map((r) => ({ window: r.window, days: r.days, truncated: r.truncated, trades: r.trades })),
      results: wfRows,
      summary: {
        windows: wfRows.length, windowsPfGt15: pfGt15, windowsPfGt20: pfGt20,
        negativeWindows: negWindows.map((r) => r.window), medianWindowPf: wfMedianPf,
        pooledWinRate: wfAgg.trades ? wfAgg.tWins / wfAgg.trades : NaN, pooledTrades: wfAgg.trades,
        worstByPf: worstPfRow || null, worstByDd: worstDdRow || null,
        stable: winnerStable,
      },
    },
    task2Variants: variants,
    task3Universe: universeRows,
    task4Verdict: {
      minTradesForRanking: MIN_TRADES_RANK,
      variantsEvaluated: candAll.length,
      variantsQualified: cand.length,
      pf2AndDd25: passBoth.map((v) => v.id),
      pf2AndDd25Count: passBoth.length,
      wr50AndPf2AndDd25All: wr50All.map((v) => v.id),
      wr50AndPf2AndDd25Qualified: wr50.map((v) => v.id),
      bestWrUnderPf2Dd25: bestWrUnder || null,
      bestPfUnderPf2Dd25: bestPfUnder || null,
      lowestDdUnderPf2Dd25: bestDdUnder || null,
      bestPfDdAtWr45: bestAtWr45 || null,
      bestPfDdAtWr45WithDd25: bestAtWr45DdRow || null,
      bestWrAtPf2: bestWrAtPf2 || null,
      bestWrAtPf2AndDd25: bestWrAtPf2Dd || null,
    },
    winnerStable,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, (k, v) => (v === Infinity ? 'Infinity' : (Number.isNaN(v) ? null : v)), 2));
  say(`Wrote results JSON -> ${OUT_FILE}`);
  say(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
