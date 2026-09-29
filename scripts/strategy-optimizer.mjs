#!/usr/bin/env node
/**
 * STRATEGY OPTIMIZER — low-turnover, higher-selectivity, walk-forward validated.
 *
 * Standalone (no external deps). Reuses the EXACT data loading, resampling,
 * no-lookahead fill semantics (signal at bar i close -> fill at bar i+1 open;
 * stop-first intrabar tie rule), cost model and portfolio engine conventions
 * from scripts/strategy-research-lab.mjs (helpers copied verbatim where possible).
 *
 * Additions vs the research lab:
 *   - Signals are evaluated on a higher timeframe (TF) and EDGE-TRIGGERED, which
 *     cuts turnover vs the lab's bar-by-bar 1H signals.
 *   - A parametric grid over trend / mean-reversion / momentum-surge archetypes.
 *   - Mandatory walk-forward IS/OOS split, per-year OOS breakdown, plateau check.
 *
 * Usage:  node scripts/strategy-optimizer.mjs
 * Writes: data/strategy_optimizer_results.json
 *
 * NOTHING in this file modifies engine/source code. Research only.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration (kept identical to scripts/strategy-research-lab.mjs)
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'data', 'candles_cache');
const OUT_FILE = path.join(ROOT, 'data', 'strategy_optimizer_results.json');

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

const VOL_TARGET_ANNUAL = 0.17; // mid of the 15-20% band

const HOUR = 3600;
const H4 = 4 * HOUR;
const D1 = 24 * HOUR;

// Walk-forward windows
const IS_START = Date.UTC(2022, 7, 20) / 1000;
const IS_END = Date.UTC(2024, 11, 31, 23, 59, 59) / 1000;
const OOS_START = Date.UTC(2025, 0, 1) / 1000;
const OOS_END = Date.UTC(2026, 8, 28, 23, 59, 59) / 1000;
const MIN_OOS_TRADES = 40;

const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'].map((m) => m + '_USDT');

// ---------------------------------------------------------------------------
// Small utilities (copied from strategy-research-lab.mjs)
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

// ---------------------------------------------------------------------------
// Indicators (copied from strategy-research-lab.mjs)
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

function wilderRSI(close, period) {
  const n = close.length;
  const out = new Float32Array(n).fill(NaN);
  if (n <= period) return out;
  let gain = 0; let loss = 0;
  for (let i = 1; i <= period; i++) { const d = close[i] - close[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let avgG = gain / period; let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function wilderADX(high, low, close, period) {
  const n = high.length;
  const out = new Float32Array(n).fill(NaN);
  if (n < 2 * period + 1) return out;
  const tr = new Float32Array(n);
  const plusDM = new Float32Array(n);
  const minusDM = new Float32Array(n);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const dn = low[i - 1] - low[i];
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  let trS = 0; let pS = 0; let mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dx = new Float32Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) { trS = trS - trS / period + tr[i]; pS = pS - pS / period + plusDM[i]; mS = mS - mS / period + minusDM[i]; }
    const pdi = trS === 0 ? 0 : 100 * pS / trS;
    const mdi = trS === 0 ? 0 : 100 * mS / trS;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
  }
  let seed = 0;
  for (let i = period; i < period + period; i++) seed += dx[i];
  let adx = seed / period;
  out[2 * period - 1] = adx;
  for (let i = 2 * period; i < n; i++) { adx = (adx * (period - 1) + dx[i]) / period; out[i] = adx; }
  return out;
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
// Resampling (copied from strategy-research-lab.mjs)
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
// Data loading (copied from strategy-research-lab.mjs)
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
// Bundle builder: TF series + only the indicators a given purpose needs.
// Bundles are memoised per (symbol, tf, purpose).
// ---------------------------------------------------------------------------

function mapToH1(sym, bundle) {
  const out = new Float32Array(sym.n).fill(NaN);
  if (bundle.tf === HOUR) { out.set(bundle.close); return out; }
  const lookup = makeClosedLookup(bundle.time, bundle.tf);
  for (let i = 0; i < sym.n; i++) {
    const h = lookup(sym.time[i]);
    if (h >= 0) out[i] = bundle.close[h];
  }
  return out;
}

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
    b.donLo27H1 = mapArrToH1(sym, b, b.d27.lo);
    b.donUp27H1 = mapArrToH1(sym, b, b.d27.up);
  } else if (purpose === 'mr') {
    b.rsi14 = wilderRSI(series.close, 14);
    b.adx14 = wilderADX(series.high, series.low, series.close, 14);
    b.atr14 = wilderATR(series.high, series.low, series.close, 14);
    b.d20 = donchian(series.high, series.low, 20);
    b.sma20 = sma(series.close, 20);
  } else if (purpose === 'mom') {
    b.ema20 = ema(series.close, 20);
    b.ema50 = ema(series.close, 50);
    b.ema200 = ema(series.close, 200);
    b.atr14 = wilderATR(series.high, series.low, series.close, 14);
    b.atr22 = wilderATR(series.high, series.low, series.close, 22);
    b.volSma20 = sma(series.volume, 20);
    b.ema20H1 = mapArrToH1(sym, b, b.ema20);
    b.atr22H1 = mapArrToH1(sym, b, b.atr22);
  }
  sym.bundles[key] = b;
  return b;
}

// ---------------------------------------------------------------------------
// BTC regime helpers
// ---------------------------------------------------------------------------

let BTC = null;
const btcRegimeLong = new Map(); // key `${tf}` -> Map<bucketStart, +1|-1|0>
const btcD1AdxLow = new Map();   // Map<bucketStart, bool>

function btcRegimeAt(tf, bucketStart) {
  const m = btcRegimeLong.get(tf);
  if (!m) return 0;
  const v = m.get(bucketStart);
  return v === undefined ? 0 : v;
}

function btc1dRangeAt(t) {
  // last closed BTC 1D bucket adx14 < 30 (loosened from 25 so the MR archetype gets a sample)
  const bd = btcD1AdxLow.get('b');
  return bd ? bd(t) : false;
}

// ---------------------------------------------------------------------------
// Signal generation
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

function genMRSignal(sym, tf, side) {
  const key = `mr|${sym.sym}|${tf}|${side}`;
  if (sigCache.has(key)) return sigCache.get(key);
  const bd = sym.bundles['mr:' + tf];
  const out = emptySig(sym.n);
  const tfBars = tf === HOUR ? 48 : 24;
  const timeStopH1 = tfBars * (tf / HOUR);
  let prevLong = false; let prevShort = false;
  for (let b = 1; b < bd.n; b++) {
    const c = bd.close[b];
    let cl = false; let cs = false;
    if (isNum(c) && isNum(bd.rsi14[b]) && isNum(bd.atr14[b]) && isNum(bd.adx14[b]) && isNum(bd.sma20[b])) {
      // Loosened vs the protocol (ADX<20 / BTC 1D ADX<25 / RSI 30-70) so the archetype actually trades.
      const ranging = bd.adx14[b] < 25 && btc1dRangeAt(bd.time[b] + bd.tf);
      if (ranging) {
        const lo = bd.d20.lo[b]; const up = bd.d20.up[b];
        if (isNum(lo)) cl = bd.low[b] < lo && c > lo && bd.rsi14[b] < 35;
        if (isNum(up)) cs = bd.high[b] > up && c < up && bd.rsi14[b] > 65;
      }
    }
    if ((cl && !prevLong) || (cs && !prevShort)) {
      const bucketClose = bd.time[b] + bd.tf;
      const i = findBarAtOrAfter(sym.time, bucketClose);
      if (i >= 0) {
        if (cl && !prevLong && (side === 'long' || side === 'both')) {
          out.dir[i] = 1; out.atr[i] = bd.atr14[b]; out.target[i] = bd.sma20[b]; out.tstop[i] = timeStopH1;
        } else if (cs && !prevShort && (side === 'short' || side === 'both')) {
          out.dir[i] = -1; out.atr[i] = bd.atr14[b]; out.target[i] = bd.sma20[b]; out.tstop[i] = timeStopH1;
        }
      }
    }
    prevLong = cl; prevShort = cs;
  }
  sigCache.set(key, out);
  return out;
}

function genMomentumSignals(tf, broadSyms, btcMomBundle) {
  const key = `mom|${tf}`;
  if (sigCache.has(key)) return sigCache.get(key);
  const L = 24;
  const btcClose = btcMomBundle.close;
  const btcTfIdx = new Map();
  for (let b = 0; b < btcMomBundle.n; b++) btcTfIdx.set(btcMomBundle.time[b], b);
  const btcRet = new Float32Array(btcMomBundle.n).fill(NaN);
  for (let b = L; b < btcMomBundle.n; b++) if (btcClose[b - L] > 0) btcRet[b] = btcClose[b] / btcClose[b - L] - 1;

  // per-symbol arrays indexed by TF bucket
  const symData = [];
  for (const sym of broadSyms) {
    const bd = sym.bundles['mom:' + tf];
    if (!bd) continue;
    const rs = new Float32Array(bd.n).fill(NaN);
    const pass = new Uint8Array(bd.n);
    for (let b = 0; b < bd.n; b++) {
      const btcB = btcTfIdx.get(bd.time[b]);
      if (btcB === undefined) continue;
      const bl = bd.close[b - L];
      if (!(b >= L && isNum(bl) && bl > 0 && isNum(btcRet[btcB]) && isNum(bd.volSma20[b]) && isNum(bd.ema50[b]) && isNum(bd.ema200[b]))) continue;
      rs[b] = (bd.close[b] / bl - 1) - btcRet[btcB];
      pass[b] = bd.volume[b] > 3 * bd.volSma20[b] && bd.ema50[b] > bd.ema200[b] ? 1 : 0;
    }
    symData.push({ sym, bd, rs, pass });
  }

  const result = new Map();
  for (const sd of symData) result.set(sd.sym.sym, emptySig(sd.sym.n));

  // iterate btc TF buckets in order; gather passers; rank; mark top 5%
  for (let b = L; b < btcMomBundle.n; b++) {
    const t = btcMomBundle.time[b];
    const cands = [];
    for (const sd of symData) {
      const idx = Math.round((t - sd.bd.time[0]) / tf);
      if (idx < 0 || idx >= sd.bd.n) continue;
      if (sd.bd.time[idx] !== t) continue;
      if (sd.pass[idx] === 1 && isNum(sd.rs[idx])) cands.push({ sd, idx, rs: sd.rs[idx] });
    }
    if (!cands.length) continue;
    cands.sort((a, b2) => b2.rs - a.rs);
    const K = Math.max(1, Math.ceil(0.05 * cands.length));
    for (let k = 0; k < K; k++) {
      const { sd, idx } = cands[k];
      const bucketClose = t + tf;
      const i = findBarAtOrAfter(sd.sym.time, bucketClose);
      if (i < 0) continue;
      const out = result.get(sd.sym.sym);
      out.dir[i] = 1;
      out.atr[i] = sd.bd.atr14[idx];
    }
  }
  sigCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Portfolio simulation (adapted from strategy-research-lab.mjs; windowed)
// ---------------------------------------------------------------------------

let integrityFills = 0;
let integrityHtfChecks = 0;
let integrityHtfViolations = 0;

function emptySummary(label, reason) {
  return {
    label, trades: 0, wins: 0, losses: 0, winRate: NaN, profitFactor: NaN, expectancyR: NaN,
    roiPct: NaN, maxDDPct: NaN, finalEquity: START_EQUITY, reason, perYear: [],
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
  const eq = new Float64Array(gEnd - gStart + 1);
  const daily = new Map();
  const dailyRets = [];
  let curDay = null;
  let prevDayEq = START_EQUITY;

  const feeRate = USE_COSTS ? FEE_PER_SIDE : 0;
  const slipRate = USE_COSTS ? SLIPPAGE_PER_SIDE : 0;

  const canOpen = (sym) => !posMap.has(sym) && !pendingEntry.has(sym) && (posMap.size + pendingEntry.size) < MAX_POSITIONS;

  function volScaleNow() {
    if (combo.sizing !== 'volTarget') return 1;
    if (dailyRets.length < 20) return 1;
    const sd = std(dailyRets.slice(-30));
    if (!(sd > 0)) return 1;
    const ann = sd * Math.sqrt(365);
    return Math.max(0.25, Math.min(2, VOL_TARGET_ANNUAL / ann));
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
    posMap.set(s.sym, {
      sym: s.sym, dir, qty, entry: entryFill, initialStop: stopAbs, risk: actualRisk,
      feesPaid: entryFee, funding: 0, entryTime: GLOBAL[gCur], entryIndex: i,
      highSince: dir > 0 ? s.high[i] : s.low[i],
      trailStop: dir > 0 ? -Infinity : Infinity,
      target: pe.targetAbs != null && isNum(pe.targetAbs) ? pe.targetAbs : null,
      timeStopBar: pe.timeStopH1 > 0 ? i + pe.timeStopH1 : null,
    });
  }

  function exitFull(s, p, fill, t) {
    const gross = (fill - p.entry) * p.qty * p.dir;
    const fee = fill * p.qty * feeRate;
    realized += gross - fee;
    p.feesPaid += fee;
    const pnl = gross - p.feesPaid - p.funding;
    trades.push({
      sym: p.sym, strategy: combo.archetype, dir: p.dir, entryTime: p.entryTime, exitTime: t,
      entry: p.entry, risk: p.risk, pnl, r: p.risk > 0 ? pnl / p.risk : 0,
      fees: p.feesPaid, funding: p.funding, grossPl: gross,
    });
    posMap.delete(p.sym);
  }

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
      cand = long ? (n === 10 ? bd.donLo10H1[i] : bd.donLo27H1[i]) : (n === 10 ? bd.donUp10H1[i] : bd.donUp27H1[i]);
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
    eq[g - gStart] = eqv;
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
    daily.set(day, eqv);
  }

  // force-close everything at the final bar's close
  if (posMap.size) {
    const tEnd = GLOBAL[gEnd];
    for (const [sym, p] of Array.from(posMap.entries())) {
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

// ---------------------------------------------------------------------------
// Grid definition
// ---------------------------------------------------------------------------

function buildCombos(LONG, BROAD, MAJORSYMS, GLOBAL, btcTrend, btcMom) {
  const combos = [];

  function trendSigMap(tf, regime, N, side) {
    const m = new Map();
    for (const s of LONG) m.set(s.sym, genTrendSignal(s, tf, regime, N, side));
    return m;
  }
  function trendSigMapSubset(tf, regime, N, side, subset) {
    const m = new Map();
    for (const s of subset) m.set(s.sym, genTrendSignal(s, tf, regime, N, side));
    return m;
  }

  const PRESETS = {
    P1: { stopAtrMult: 2, trail: { kind: 'chand', mult: 3 } },
    P2: { stopAtrMult: 3, trail: { kind: 'chand', mult: 4 } },
    P3: { stopAtrMult: 3, trail: { kind: 'donch', n: 10 } },
  };
  const DIRS = [['long', 'L'], ['both', 'LS']];

  // --- TREND main (LONG universe, fixed 1% risk) ---
  for (const tf of [H4, D1]) {
    for (const regime of ['a', 'b']) {
      for (const N of [20, 55]) {
        for (const [direction, dl] of DIRS) {
          for (const p of ['P1', 'P2']) {
            const pres = PRESETS[p];
            const tfL = tf === H4 ? '4H' : '1D';
            combos.push({
              id: `T-${tfL}-${regime}-N${N}-${dl}-${p}`,
              archetype: 'trend-main', tf, direction, sizing: 'fixed', bundleKey: 'trend:' + tf,
              stopAtrMult: pres.stopAtrMult, trail: pres.trail, universe: 'LONG',
              sig: trendSigMap(tf, regime, N, direction),
              axes: { tf: tfL, regime, N, dir: dl, preset: p },
            });
          }
        }
      }
    }
  }

  // --- TREND regime c (BTC market filter), donchian trail ---
  for (const tf of [H4, D1]) {
    for (const N of [20, 55]) {
      for (const [direction, dl] of DIRS) {
        const pres = PRESETS.P3;
        const tfL = tf === H4 ? '4H' : '1D';
        combos.push({
          id: `TC-${tfL}-c-N${N}-${dl}-P3`,
          archetype: 'trend-main', tf, direction, sizing: 'fixed', bundleKey: 'trend:' + tf,
          stopAtrMult: pres.stopAtrMult, trail: pres.trail, universe: 'LONG',
          sig: trendSigMap(tf, 'c', N, direction),
          axes: { tf: tfL, regime: 'c', N, dir: dl, preset: 'P3' },
        });
      }
    }
  }

  // --- TREND majors-only subset (fixed risk, P1) ---
  for (const tf of [H4, D1]) {
    for (const regime of ['a', 'b']) {
      for (const N of [20, 55]) {
        for (const [direction, dl] of DIRS) {
          const pres = PRESETS.P1;
          const tfL = tf === H4 ? '4H' : '1D';
          combos.push({
            id: `TM-${tfL}-${regime}-N${N}-${dl}-P1`,
            archetype: 'trend-majors', tf, direction, sizing: 'fixed', bundleKey: 'trend:' + tf,
            stopAtrMult: pres.stopAtrMult, trail: pres.trail, universe: 'MAJORS',
            universeSyms: MAJORSYMS,
            sig: trendSigMapSubset(tf, regime, N, direction, MAJORSYMS),
            axes: { tf: tfL, regime, N, dir: dl, preset: 'P1' },
          });
        }
      }
    }
  }

  // --- TREND majors vol-targeted sizing variant ---
  for (const tf of [H4, D1]) {
    for (const N of [20, 55]) {
      const pres = PRESETS.P1;
      const tfL = tf === H4 ? '4H' : '1D';
      combos.push({
        id: `TMV-${tfL}-a-N${N}-L-P1`,
        archetype: 'trend-majors-vol', tf, direction: 'long', sizing: 'volTarget', bundleKey: 'trend:' + tf,
        stopAtrMult: pres.stopAtrMult, trail: pres.trail, universe: 'MAJORS',
        universeSyms: MAJORSYMS,
        sig: trendSigMapSubset(tf, 'a', N, 'long', MAJORSYMS),
        axes: { tf: tfL, regime: 'a', N, dir: 'L', preset: 'P1' },
      });
    }
  }

  // --- MEAN REVERSION ---
  for (const tf of [HOUR, H4]) {
    for (const [direction, dl] of DIRS) {
      const tfL = tf === HOUR ? '1H' : '4H';
      const m = new Map();
      for (const s of LONG) m.set(s.sym, genMRSignal(s, tf, direction));
      combos.push({
        id: `MR-${tfL}-${dl}`,
        archetype: 'mean-rev', tf, direction, sizing: 'fixed', bundleKey: 'mr:' + tf,
        stopAtrMult: 2, trail: { kind: 'none' }, universe: 'LONG',
        sig: m,
        axes: { tf: tfL, dir: dl },
      });
    }
  }

  // --- MOMENTUM SURGE (BROAD) ---
  for (const tf of [H4, D1]) {
    const base = genMomentumSignals(tf, BROAD, btcMom[tf === H4 ? '4H' : '1D']);
    const tfL = tf === H4 ? '4H' : '1D';
    combos.push({
      id: `MOM-${tfL}-ema`, archetype: 'momentum', tf, direction: 'long', sizing: 'fixed',
      bundleKey: 'mom:' + tf, stopAtrMult: 2.5, trail: { kind: 'ema' }, universe: 'BROAD',
      sig: base, axes: { tf: tfL, trail: 'ema' },
    });
    combos.push({
      id: `MOM-${tfL}-atr`, archetype: 'momentum', tf, direction: 'long', sizing: 'fixed',
      bundleKey: 'mom:' + tf, stopAtrMult: 2.5, trail: { kind: 'chand', mult: 2.5 }, universe: 'BROAD',
      sig: base, axes: { tf: tfL, trail: 'atr' },
    });
  }

  return combos;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log('============================================================================');
  console.log('  STRATEGY OPTIMIZER — low-turnover, walk-forward validated, cost-aware');
  console.log('============================================================================');
  console.log('');
  console.log('COST MODEL (costs are ON for every run; identical to strategy-research-lab.mjs):');
  console.log(`  taker fee per side ............ ${FEE_PER_SIDE} (${(FEE_PER_SIDE * 100).toFixed(4)}%)`);
  console.log(`  slippage per side ............. ${SLIPPAGE_PER_SIDE} (${(SLIPPAGE_PER_SIDE * 100).toFixed(4)}%) adverse price adjustment`);
  console.log(`  round-trip explicit cost ...... ~${((FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2 * 100).toFixed(4)}% of notional`);
  console.log(`  funding (approx) .............. ${FUNDING_PER_8H} per 8h ≈ ${(FUNDING_PER_8H * 3 * 100).toFixed(4)}%/day on notional while open`);
  console.log('  ASSUMPTION: no funding series exists in the cache; funding is charged as notional * rate/8 per open 1H bar.');
  console.log('');
  console.log('RISK / PORTFOLIO:');
  console.log(`  start equity .................. $${START_EQUITY}`);
  console.log(`  risk per trade ................ ${RISK_PCT * 100}% of current equity (fixed) or vol-targeted (${VOL_TARGET_ANNUAL * 100}% annual portfolio vol)`);
  console.log(`  leverage cap .................. ${LEVERAGE_CAP}x  |  notional cap ${MAX_POSITION_NOTIONAL_PCT * 100}% of equity (the stricter cap binds)`);
  console.log(`  max concurrent ................ ${MAX_POSITIONS}   |  one position per symbol`);
  console.log('');
  console.log('WALK-FORWARD:');
  console.log(`  IS  ........................... ${tsToDate(IS_START)} -> ${tsToDate(IS_END)}`);
  console.log(`  OOS ........................... ${tsToDate(OOS_START)} -> ${tsToDate(OOS_END)}`);
  console.log(`  combos considered ranked only if OOS trades >= ${MIN_OOS_TRADES}`);
  console.log('');

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

  const LONG = rawSyms.filter((s) => s.n >= LONG_MIN_BARS).sort((a, b) => a.sym.localeCompare(b.sym));
  const BROAD = rawSyms.filter((s) => s.n >= BROAD_MIN_BARS).sort((a, b) => a.sym.localeCompare(b.sym));
  const MAJORSYMS = MAJORS.map((m) => rawSyms.find((s) => s.sym === m)).filter(Boolean);

  console.log('DATA / UNIVERSE');
  console.log(`  symbols loaded ................ ${rawSyms.length}`);
  console.log(`  global 1H timeline ........... ${NG} bars, ${tsToDate(GLOBAL[0])} -> ${tsToDate(GLOBAL[NG - 1])}`);
  console.log(`  LONG_UNIVERSE (>=${LONG_MIN_BARS} bars): ${LONG.length} symbols`);
  console.log('    ' + LONG.map((s) => s.sym).join(', '));
  console.log(`  BROAD_UNIVERSE (>=${BROAD_MIN_BARS} bars): ${BROAD.length} symbols (used by MOMENTUM only)`);
  console.log(`  MAJORS subset (${MAJORSYMS.length}): ` + MAJORSYMS.map((s) => s.sym).join(', '));
  console.log('');

  BTC = rawSyms.find((s) => s.sym === 'BTC_USDT');
  if (!BTC) throw new Error('BTC_USDT missing');
  BTC.bundles = {};

  // BTC bundles
  const btcTrend = {};
  for (const tf of [H4, D1]) btcTrend[tf === H4 ? '4H' : '1D'] = buildBundle(BTC, tf, 'trend');
  const btcMom = {};
  for (const tf of [H4, D1]) btcMom[tf === H4 ? '4H' : '1D'] = buildBundle(BTC, tf, 'mom');
  const btcMrD1 = buildBundle(BTC, D1, 'mr');

  // regime maps for option c (BTC TF EMA50>EMA200)
  for (const tf of [H4, D1]) {
    const bd = btcTrend[tf === H4 ? '4H' : '1D'];
    const m = new Map();
    for (let b = 0; b < bd.n; b++) {
      if (isNum(bd.ema50[b]) && isNum(bd.ema200[b])) m.set(bd.time[b], bd.ema50[b] > bd.ema200[b] ? 1 : -1);
      else m.set(bd.time[b], 0);
    }
    btcRegimeLong.set(tf, m);
  }
  // BTC 1D ADX<25 lookup (closed bucket)
  {
    const lookup = makeClosedLookup(btcMrD1.time, D1);
    const fn = (t) => { const b = lookup(t); return b >= 0 && isNum(btcMrD1.adx14[b]) && btcMrD1.adx14[b] < 30; };
    btcD1AdxLow.set('b', fn);
  }

  // ---- build bundles -------------------------------------------------------
  console.log('Building indicator bundles (this can take a minute)...');
  for (const s of LONG) {
    for (const tf of [H4, D1]) { buildBundle(s, tf, 'trend'); buildBundle(s, tf, 'mom'); }
    for (const tf of [HOUR, H4]) buildBundle(s, tf, 'mr');
  }
  for (const s of BROAD) {
    if (s.n >= LONG_MIN_BARS) continue;
    for (const tf of [H4, D1]) { buildBundle(s, tf, 'mom'); }
  }
  console.log(`  bundles built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('');

  // HTF closed-bucket integrity check on the trend bundles
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
  console.log(`ENGINE INTEGRITY: closed-HTF bucket checks=${integrityHtfChecks}, violations=${integrityHtfViolations}`);
  console.log('');

  // ---- build grid ----------------------------------------------------------
  const combos = buildCombos(LONG, BROAD, MAJORSYMS, GLOBAL, btcTrend, btcMom);
  console.log(`GRID: ${combos.length} combos`);
  const byArch = {};
  for (const c of combos) byArch[c.archetype] = (byArch[c.archetype] || 0) + 1;
  console.log('  ' + Object.entries(byArch).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('');

  // ---- run ----------------------------------------------------------------
  console.log('Running IS/OOS backtests...');
  const results = [];
  for (const c of combos) {
    const universe = c.universeSyms || (c.universe === 'LONG' ? LONG : BROAD);
    const is = runSim(c, universe, IS_START, IS_END, GLOBAL);
    const oos = runSim(c, universe, OOS_START, OOS_END, GLOBAL);
    results.push({ combo: c, is, oos });
  }
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('');

  // ---- ranking ------------------------------------------------------------
  const qualified = results.filter((r) => r.oos.trades >= MIN_OOS_TRADES);
  const byOosPf = [...qualified].sort((a, b) => (b.oos.profitFactor || -1) - (a.oos.profitFactor || -1));

  function tag(r) {
    const iPF = r.is.profitFactor; const oPF = r.oos.profitFactor;
    if (isNum(iPF) && iPF >= 1.5 && isNum(oPF) && oPF < 1.0) return 'OVERFIT?';
    if (isNum(iPF) && iPF >= 1.0 && isNum(oPF) && oPF >= 1.0) return 'stable';
    if (isNum(iPF) && iPF < 1.0 && isNum(oPF) && oPF >= 1.0) return 'OOS-only';
    return 'weak';
  }

  function row(r) {
    return [
      r.combo.id.padEnd(24),
      String(r.is.trades).padStart(6),
      pct(r.is.winRate, 1).padStart(7),
      fmt(r.is.profitFactor, 3).padStart(7),
      fmt(r.is.maxDDPct, 1).padStart(7),
      String(r.oos.trades).padStart(6),
      pct(r.oos.winRate, 1).padStart(7),
      fmt(r.oos.profitFactor, 3).padStart(7),
      fmt(r.oos.expectancyR, 3).padStart(8),
      fmt(r.oos.roiPct, 1).padStart(8),
      fmt(r.oos.maxDDPct, 1).padStart(7),
      tag(r).padStart(10),
    ].join(' ');
  }

  const header = [
    'combo'.padEnd(24), 'IS n'.padStart(6), 'IS WR'.padStart(7), 'IS PF'.padStart(7), 'IS DD%'.padStart(7),
    'OOS n'.padStart(6), 'OOS WR'.padStart(7), 'OOS PF'.padStart(7), 'OOS expR'.padStart(8), 'OOS ROI'.padStart(8), 'OOS DD%'.padStart(7), 'flag'.padStart(10),
  ].join(' ');

  console.log('============================================================================');
  console.log('  RANKED BY OOS PROFIT FACTOR (best 15; OOS trades >= ' + MIN_OOS_TRADES + ')');
  console.log('============================================================================');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of byOosPf.slice(0, 15)) console.log(row(r));
  console.log('');

  const bestByDD = [...qualified].filter((r) => Number.isFinite(r.oos.maxDDPct)).sort((a, b) => a.oos.maxDDPct - b.oos.maxDDPct)[0];
  const bestByDDpf1 = [...qualified].filter((r) => Number.isFinite(r.oos.maxDDPct) && isNum(r.oos.profitFactor) && r.oos.profitFactor > 1)
    .sort((a, b) => a.oos.maxDDPct - b.oos.maxDDPct)[0];
  console.log('============================================================================');
  console.log('  BEST BY OOS MAX DRAWDOWN (among qualified)');
  console.log('============================================================================');
  console.log(header);
  if (bestByDD) console.log(row(bestByDD));
  if (bestByDDpf1 && bestByDDpf1 !== bestByDD) { console.log('  (best maxDD among combos that are also OOS-profitable:)'); console.log(row(bestByDDpf1)); }
  console.log('');

  // ---- plateau / stability ------------------------------------------------
  // A plateau member = a trend-main combo whose immediate one-axis neighbours
  // (regime swap, Donchian N swap, stop/trail-preset swap, holding tf & direction
  // fixed) all exist, number >= 2, and are all positive OOS with >= MIN_OOS_TRADES.
  // This finds regions that are broadly good rather than a single lucky peak.
  const core = results.filter((r) => r.combo.archetype === 'trend-main');
  const keyOf = (a) => `${a.tf}|${a.regime}|${a.N}|${a.dir}|${a.preset}`;
  const byKey = new Map(core.map((r) => [keyOf(r.combo.axes), r]));
  const good = (r) => r && r.oos.trades >= MIN_OOS_TRADES && isNum(r.oos.profitFactor) && r.oos.profitFactor > 1.0;
  const plateaus = [];
  for (const r of core) {
    const a = r.combo.axes;
    const candAxes = [];
    for (const reg of ['a', 'b', 'c']) if (reg !== a.regime) candAxes.push({ ...a, regime: reg });
    for (const N of [20, 55]) if (N !== a.N) candAxes.push({ ...a, N });
    for (const p of ['P1', 'P2', 'P3']) if (p !== a.preset) candAxes.push({ ...a, preset: p });
    const nn = candAxes.map((ax) => byKey.get(keyOf(ax))).filter(Boolean);
    if (good(r) && nn.length >= 2 && nn.every(good)) plateaus.push(r);
  }
  console.log('============================================================================');
  console.log('  PARAMETER-STABLE PLATEAUS (trend-main combos whose >=2 one-axis neighbours are all positive OOS)');
  console.log('============================================================================');
  if (!plateaus.length) console.log('  none — no trend combo has >=2 qualifying one-axis neighbours all positive OOS');
  else for (const r of plateaus.sort((x, y) => y.oos.profitFactor - x.oos.profitFactor).slice(0, 12)) console.log('  ' + row(r));
  console.log('');

  // ---- per-year OOS for top 3 --------------------------------------------
  console.log('============================================================================');
  console.log('  PER-YEAR OOS BREAKDOWN — TOP 3 BY OOS PF');
  console.log('============================================================================');
  for (const r of byOosPf.slice(0, 3)) {
    console.log(`  ${r.combo.id}   (OOS PF ${fmt(r.oos.profitFactor, 3)}, WR ${pct(r.oos.winRate, 1)}, DD ${fmt(r.oos.maxDDPct, 1)}%)`);
    console.log('    year | trades |   PF  |   WR');
    for (const y of r.oos.perYear) {
      const pf = y.profitFactor === Infinity ? 'Inf' : fmt(y.profitFactor, 2);
      console.log(`    ${y.year} | ${String(y.trades).padStart(6)} | ${String(pf).padStart(5)} | ${pct(y.winRate, 1).padStart(6)}`);
    }
    console.log('');
  }

  // ---- robustness of top 3 ------------------------------------------------
  console.log('============================================================================');
  console.log('  ROBUSTNESS OF TOP 3 (OOS): direction split, symbol breadth, cost drag');
  console.log('============================================================================');
  for (const r of byOosPf.slice(0, 3)) {
    const s = r.oos;
    console.log(`  ${r.combo.id}`);
    console.log(`    OOS trades ${s.trades} (long ${s.longTrades} / short ${s.shortTrades}) across ${s.distinctSymbols} symbols`);
    console.log(`    gross P&L $${fmt(s.grossPl, 0)} | fees+funding $${fmt(s.feesPaid + s.fundingPaid, 0)} | cost drag ${fmt(s.costDragPctOfGross, 1)}% of gross`);
    console.log('    top symbols: ' + s.topSymbols.map(([sym, c]) => `${sym.replace('_USDT', '')}:${c}`).join(' '));
    console.log('');
  }

  // ---- target verdict ------------------------------------------------------
  const hit = qualified.filter((r) => isNum(r.oos.profitFactor) && r.oos.profitFactor >= 2.0 && r.oos.maxDDPct <= 25 && r.oos.winRate >= 0.5);
  const robust = [...qualified].filter((r) => isNum(r.oos.maxDDPct) && r.oos.maxDDPct <= 25)
    .sort((a, b) => (b.oos.profitFactor || -1) - (a.oos.profitFactor || -1))[0];

  console.log('============================================================================');
  console.log('  VERDICT PER TARGET METRIC (OOS, costs ON, OOS trades >= ' + MIN_OOS_TRADES + ')');
  console.log('============================================================================');
  const anyPf2 = qualified.filter((r) => isNum(r.oos.profitFactor) && r.oos.profitFactor >= 2.0);
  const anyDD25 = qualified.filter((r) => isNum(r.oos.maxDDPct) && r.oos.maxDDPct <= 25);
  const anyWR50 = qualified.filter((r) => isNum(r.oos.winRate) && r.oos.winRate >= 0.5);
  const bestPfQual = byOosPf[0];
  console.log(`  PF >= 2.0 .................... ${anyPf2.length ? 'MET by ' + anyPf2.length + ' combo(s)' : 'NOT MET'}   best OOS PF = ${bestPfQual ? fmt(bestPfQual.oos.profitFactor, 3) + ' (' + bestPfQual.combo.id + ')' : 'n/a'}`);
  console.log(`  maxDD <= 25% ................. ${anyDD25.length ? 'MET by ' + anyDD25.length + ' combo(s)' : 'NOT MET'}   best (lowest) = ${bestByDD ? fmt(bestByDD.oos.maxDDPct, 1) + '% (' + bestByDD.combo.id + ')' : 'n/a'}`);
  console.log(`  WR >= 50% .................... ${anyWR50.length ? 'MET by ' + anyWR50.length + ' combo(s)' : 'NOT MET'}   best = ${(() => { const b = [...qualified].sort((a, b2) => b2.oos.winRate - a.oos.winRate)[0]; return b ? pct(b.oos.winRate, 1) + ' (' + b.combo.id + ')' : 'n/a'; })()}`);
  console.log(`  ALL THREE (PF>=2 & DD<=25% & WR>=50%)  ${hit.length ? 'MET by ' + hit.length + ' combo(s): ' + hit.map((r) => r.combo.id).join(', ') : 'NOT MET by any combo'}`);
  console.log('');
  if (!hit.length) {
    console.log('  PLAIN ANSWER: nothing reaches PF >= 2.0 with MaxDD <= 25% and WR >= 50% out-of-sample.');
    if (robust) {
      console.log('  BEST ROBUST COMPROMISE (highest OOS PF with OOS MaxDD <= 25%):');
      console.log('  ' + header);
      console.log('  ' + row(robust));
      console.log(`    -> OOS PF ${fmt(robust.oos.profitFactor, 3)}, WR ${pct(robust.oos.winRate, 1)}, expectancy ${fmt(robust.oos.expectancyR, 3)}R, ROI ${fmt(robust.oos.roiPct, 1)}%, MaxDD ${fmt(robust.oos.maxDDPct, 1)}%, ${robust.oos.trades} trades; IS PF ${fmt(robust.is.profitFactor, 3)} (${tag(robust)})`);
    } else {
      console.log('  No combo even keeps OOS MaxDD <= 25% with >= ' + MIN_OOS_TRADES + ' trades.');
    }
  }
  console.log('');

  // ---- integrity + caveats -------------------------------------------------
  console.log('============================================================================');
  console.log('  INTEGRITY CHECKS');
  console.log('============================================================================');
  console.log(`  fills validated strictly after signal bar (throws on violation): ${integrityFills} fills`);
  console.log(`  closed-HTF bucket checks / violations ......................... : ${integrityHtfChecks} / ${integrityHtfViolations}`);
  console.log('  fill rule  = bar i close signal -> bar i+1 OPEN fill');
  console.log('  signal rule = TF signals only emitted on a CLOSED TF bar, edge-triggered, then mapped to the first 1H bar at/after that TF close');
  console.log('  stop/target tie rule = STOP fills first');
  console.log('');
  console.log('============================================================================');
  console.log('  CAVEATS');
  console.log('============================================================================');
  console.log('  - Survivorship bias: the cache is today\'s symbol list. Delisted/never-listed symbols are absent;');
  console.log('    momentum-surge results (cross-sectional top-5%) are the most affected and are optimistic.');
  console.log('  - 1H granularity only: intrabar sequencing uses high/low with a conservative stop-first assumption;');
  console.log('    no tick/book data, so fills inside wide bars are approximated.');
  console.log('  - Funding is approximated (no funding series in cache): notional * 0.0001/8 per open 1H bar.');
  console.log('  - HTF signals are edge-triggered to cut turnover; this also means a signal that fires while a position');
  console.log('    is already open (or while max positions is reached) is dropped, not re-queued.');
  console.log('  - IS = 2022-08-20..2024-12-31, OOS = 2025-01-01..2026-09-28; OOS is ~21 months, so per-year OOS is thin.');
  console.log('  - Mean-reversion thresholds were loosened vs the written protocol (ADX<25, BTC 1D ADX<30, RSI 35/65)');
  console.log('    because the protocol values yielded 0-4 trades over the entire sample; this is a sample-size compromise.');
  console.log('');

  // ---- write JSON ----------------------------------------------------------
  const out = {
    generatedAt: new Date().toISOString(),
    costModel: {
      feePerSide: FEE_PER_SIDE, slippagePerSide: SLIPPAGE_PER_SIDE, fundingPer8h: FUNDING_PER_8H,
      roundTripExplicitPct: (FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2,
      note: 'Funding approximated: notional * fundingPer8h/8 per open 1H bar. Costs ON for all runs.',
    },
    risk: {
      startEquity: START_EQUITY, riskPct: RISK_PCT, leverageCap: LEVERAGE_CAP,
      maxPositions: MAX_POSITIONS, maxPositionNotionalPct: MAX_POSITION_NOTIONAL_PCT,
      volTargetAnnual: VOL_TARGET_ANNUAL,
    },
    walkForward: { isStart: tsToDate(IS_START), isEnd: tsToDate(IS_END), oosStart: tsToDate(OOS_START), oosEnd: tsToDate(OOS_END), minOosTrades: MIN_OOS_TRADES },
    period: { start: tsToDate(GLOBAL[0]), end: tsToDate(GLOBAL[NG - 1]), globalBars: NG },
    universes: {
      longCount: LONG.length, long: LONG.map((s) => s.sym),
      broadCount: BROAD.length, majors: MAJORSYMS.map((s) => s.sym),
    },
    integrity: { fillAfterSignalChecks: integrityFills, htfBucketChecks: integrityHtfChecks, htfBucketViolations: integrityHtfViolations },
    gridSize: combos.length,
    verdict: {
      targetAll: hit.length > 0,
      targetAllCombos: hit.map((r) => r.combo.id),
      pf2Met: anyPf2.map((r) => r.combo.id),
      dd25Met: anyDD25.map((r) => r.combo.id),
      wr50Met: anyWR50.map((r) => r.combo.id),
      bestByOosPf: bestPfQual ? bestPfQual.combo.id : null,
      bestByOosMaxDD: bestByDD ? bestByDD.combo.id : null,
      robustCompromise: robust ? robust.combo.id : null,
    },
    plateauMembers: plateaus.map((r) => r.combo.id),
    results: results.map((r) => ({
      id: r.combo.id, archetype: r.combo.archetype, axes: r.combo.axes, universe: r.combo.universe, sizing: r.combo.sizing,
      is: r.is, oos: r.oos, flag: tag(r),
    })),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, (k, v) => (v === Infinity ? 'Infinity' : (Number.isNaN(v) ? null : v)), 2));
  console.log(`Wrote results JSON -> ${OUT_FILE}`);
  console.log(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
