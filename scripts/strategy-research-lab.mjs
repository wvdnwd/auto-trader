#!/usr/bin/env node
/**
 * INSTITUTIONAL-GRADE STRATEGY RESEARCH LAB  (standalone, no external deps)
 *
 * A rigorous, no-lookahead, conservative-cost, portfolio-level backtester that
 * evaluates four independent strategy archetypes and two ensembles over the
 * cached 1H universe in data/candles_cache/.
 *
 * Design rules (non-negotiable for this tool):
 *  - Signals are computed on bar i using only data up to and including bar i CLOSE.
 *  - Orders fill at bar i+1 OPEN.
 *  - Stops / targets are evaluated intrabar on the following bars using high/low.
 *  - If stop and target are both touched within the same bar, the STOP fills first.
 *  - Higher-timeframe bars (4H, 1D) are only ever read once their bucket has CLOSED.
 *  - Costs are charged on both entry and exit notional, plus hourly-approximated funding.
 *  - Results are reported BOTH with costs (primary) and without costs (secondary).
 *
 * Usage:  node scripts/strategy-research-lab.mjs
 * Writes: data/strategy_research_results.json
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'data', 'candles_cache');
const OUT_FILE = path.join(ROOT, 'data', 'strategy_research_results.json');

const START_EQUITY = 10000;

// Conservative cost model
const FEE_PER_SIDE = 0.00045;   // Hyperliquid taker fee per side
const SLIPPAGE_PER_SIDE = 0.0003; // 3 bps price adjustment, adverse to the trade
const FUNDING_PER_8H = 0.0001;  // ~0.03%/day applied on notional while a perp is open

// Risk / portfolio
const RISK_PCT = 0.01;          // 1.0% of current equity risked per trade
const LEVERAGE_CAP = 5;         // notional <= 5x equity slice
const MAX_POSITIONS = 5;
const MAX_POSITION_NOTIONAL_PCT = 0.25; // no position > 25% of equity notional

const LONG_MIN_BARS = 30000;
const BROAD_MIN_BARS = 8000;

const HOUR = 3600;
const H4 = 4 * HOUR;
const D1 = 24 * HOUR;

// ---------------------------------------------------------------------------
// Small utilities
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

// ---------------------------------------------------------------------------
// Indicators (all operate on Float32Array / plain arrays, return Float32Array)
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
  for (let i = period; i < n; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function sma(src, period) {
  const n = src.length;
  const out = new Float32Array(n).fill(NaN);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (isNum(v)) { sum += v; cnt++; }
    if (i >= period) {
      const old = src[i - period];
      if (isNum(old)) { sum -= old; cnt--; }
    }
    if (i >= period - 1 && cnt === period) out[i] = sum / period;
  }
  return out;
}

function rollingStd(src, period, meanArr) {
  const n = src.length;
  const out = new Float32Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let s = 0, s2 = 0, cnt = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (isNum(v)) { s += v; s2 += v * v; cnt++; }
    }
    if (cnt !== period) continue;
    const m = s / cnt;
    const varv = Math.max(0, s2 / cnt - m * m);
    out[i] = Math.sqrt(varv);
  }
  return out;
}

function rollingMedian(src, period) {
  const n = src.length;
  const out = new Float32Array(n).fill(NaN);
  const minCount = Math.max(3, period >> 1);
  for (let i = period; i < n; i++) {
    const w = [];
    for (let j = i - period; j < i; j++) {
      const v = src[j];
      if (isNum(v)) w.push(v);
    }
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
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  atr[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    atr[i] = prev;
  }
  return atr;
}

function wilderRSI(close, period) {
  const n = close.length;
  const out = new Float32Array(n).fill(NaN);
  if (n <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
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
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dx = new Float32Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + plusDM[i];
      mS = mS - mS / period + minusDM[i];
    }
    const pdi = trS === 0 ? 0 : 100 * pS / trS;
    const mdi = trS === 0 ? 0 : 100 * mS / trS;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
  }
  let seed = 0;
  for (let i = period; i < period + period; i++) seed += dx[i];
  let adx = seed / period;
  out[2 * period - 1] = adx;
  for (let i = 2 * period; i < n; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    out[i] = adx;
  }
  return out;
}

// Donchian shifted by 1: output at i uses bars [i-period, i-1] (excludes current bar).
function donchian(high, low, period) {
  const n = high.length;
  const up = new Float32Array(n).fill(NaN);
  const lo = new Float32Array(n).fill(NaN);
  const dqH = [];
  const dqL = [];
  let hh = 0, lh = 0;
  for (let i = 1; i < n; i++) {
    const add = i - 1;
    while (dqH.length > hh && high[dqH[dqH.length - 1]] <= high[add]) dqH.pop();
    dqH.push(add);
    while (dqL.length > lh && low[dqL[dqL.length - 1]] >= low[add]) dqL.pop();
    dqL.push(add);
    const cut = i - period - 1;
    while (dqH.length > hh && dqH[hh] <= cut) hh++;
    while (dqL.length > lh && dqL[lh] <= cut) lh++;
    if (i >= period) {
      up[i] = high[dqH[hh]];
      lo[i] = low[dqL[lh]];
    }
  }
  return { up, lo };
}

// ---------------------------------------------------------------------------
// Resampling: OHLCV aggregation bucketed by floor(time / interval)
// ---------------------------------------------------------------------------

function resample(time, open, high, low, close, volume, interval) {
  const n = time.length;
  const t = [], o = [], h = [], l = [], c = [], v = [];
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
    time: Float64Array.from(t),
    open: Float32Array.from(o),
    high: Float32Array.from(h),
    low: Float32Array.from(l),
    close: Float32Array.from(c),
    volume: Float32Array.from(v),
  };
}

// Returns a monotonic-pointer lookup: last bucket index whose close time
// (bucketStart + interval) is <= t. Never returns a partly-formed bucket.
function makeClosedLookup(bucketTimes, interval) {
  let p = -1;
  return function lookup(t) {
    while (p + 1 < bucketTimes.length && bucketTimes[p + 1] + interval <= t) p++;
    return p;
  };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function listSymbolFiles() {
  const files = fs.readdirSync(CACHE_DIR).filter((f) => /_1h\.json$/.test(f));
  files.sort();
  return files.map((f) => ({
    file: path.join(CACHE_DIR, f),
    sym: f.replace(/_1h\.json$/, ''),
  }));
}

function loadRaw(entry) {
  const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const n = raw.length;
  const time = new Int32Array(n);
  const open = new Float32Array(n);
  const high = new Float32Array(n);
  const low = new Float32Array(n);
  const close = new Float32Array(n);
  const volume = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    time[i] = r.time;
    open[i] = r.open;
    high[i] = r.high;
    low[i] = r.low;
    close[i] = r.close;
    volume[i] = r.volume;
  }
  return { sym: entry.sym, n, time, open, high, low, close, volume };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const files = listSymbolFiles();

  console.log('============================================================================');
  console.log('  STRATEGY RESEARCH LAB — institutional-grade, no-lookahead, cost-aware');
  console.log('============================================================================');
  console.log('');
  console.log('COST MODEL (primary run; a zero-cost mirror run is also reported):');
  console.log(`  taker fee per side ............ ${FEE_PER_SIDE} (${(FEE_PER_SIDE * 100).toFixed(4)}%)`);
  console.log(`  slippage per side ............. ${SLIPPAGE_PER_SIDE} (${(SLIPPAGE_PER_SIDE * 100).toFixed(4)}%) applied as price adjustment adverse to the trade`);
  console.log(`  round-trip explicit cost ...... ~${((FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2 * 100).toFixed(4)}% of notional`);
  console.log(`  funding (approx) .............. ${FUNDING_PER_8H} per 8h ≈ ${(FUNDING_PER_8H * 3 * 100).toFixed(4)}%/day on notional while open`);
  console.log(`  ASSUMPTION: funding is approximated (the cached data has no funding series);`);
  console.log(`              it is charged as notional * ${FUNDING_PER_8H}/8 per open 1H bar.`);
  console.log('');
  console.log('RISK / PORTFOLIO:');
  console.log(`  start equity .................. $${START_EQUITY}`);
  console.log(`  risk per trade ................ ${RISK_PCT * 100}% of current equity (distance to initial stop)`);
  console.log(`  leverage cap .................. ${LEVERAGE_CAP}x   (notional <= min(${LEVERAGE_CAP}x equity, ${MAX_POSITION_NOTIONAL_PCT * 100}% equity); the 25% cap binds)`);
  console.log(`  max concurrent positions ...... ${MAX_POSITIONS}`);
  console.log(`  one position per symbol ....... enforced`);
  console.log('');

  // ---- load all raw series -------------------------------------------------
  const rawSyms = [];
  const allTimes = new Set();
  for (const entry of files) {
    const s = loadRaw(entry);
    if (!s) continue;
    rawSyms.push(s);
    for (let i = 0; i < s.n; i++) allTimes.add(s.time[i]);
  }
  const globalArr = Array.from(allTimes).sort((a, b) => a - b);
  const GLOBAL = Float64Array.from(globalArr);
  const NG = GLOBAL.length;

  const longUniverse = rawSyms.filter((s) => s.n >= LONG_MIN_BARS).map((s) => s.sym).sort();
  const broadUniverse = rawSyms.filter((s) => s.n >= BROAD_MIN_BARS).map((s) => s.sym).sort();

  console.log('DATA / UNIVERSE SELECTION');
  console.log(`  symbols loaded ................ ${rawSyms.length}`);
  console.log(`  global 1H timeline ........... ${NG} bars, ${tsToDate(GLOBAL[0])} -> ${tsToDate(GLOBAL[NG - 1])}`);
  console.log(`  LONG_UNIVERSE (>= ${LONG_MIN_BARS} bars) : ${longUniverse.length} symbols`);
  console.log(`  BROAD_UNIVERSE (>= ${BROAD_MIN_BARS} bars): ${broadUniverse.length} symbols`);
  console.log('');
  console.log('  LONG_UNIVERSE:');
  console.log('    ' + longUniverse.join(', '));
  console.log('');
  console.log('  BROAD_UNIVERSE:');
  console.log('    ' + broadUniverse.join(', '));
  console.log('');

  const symByTime = new Map();
  for (const s of rawSyms) symByTime.set(s.sym, s);
  const BTC = symByTime.get('BTC_USDT');
  if (!BTC) throw new Error('BTC_USDT missing — required for market regime');

  // ---- build BTC market-regime arrays on the global timeline ---------------
  const btcH4 = resample(BTC.time, BTC.open, BTC.high, BTC.low, BTC.close, BTC.volume, H4);
  const btcD1 = resample(BTC.time, BTC.open, BTC.high, BTC.low, BTC.close, BTC.volume, D1);
  const btcH4Ema50 = ema(btcH4.close, 50);
  const btcH4Ema200 = ema(btcH4.close, 200);
  const btcH4Adx = wilderADX(btcH4.high, btcH4.low, btcH4.close, 14);
  const btcD1Adx = wilderADX(btcD1.high, btcD1.low, btcD1.close, 14);
  const btcD1Ema20 = ema(btcD1.close, 20);
  const btcD1Ema50 = ema(btcD1.close, 50);

  const btc4On = new Uint8Array(NG);
  const btc4Trend = new Uint8Array(NG);
  const btc1dRange = new Uint8Array(NG);
  const btc1dRiskOn = new Uint8Array(NG);
  const btcRet24 = new Float32Array(NG).fill(NaN);

  const btcH4Lookup = makeClosedLookup(btcH4.time, H4);
  const btcD1Lookup = makeClosedLookup(btcD1.time, D1);
  {
    let bp = -1;
    for (let g = 0; g < NG; g++) {
      const t = GLOBAL[g];
      while (bp + 1 < BTC.n && BTC.time[bp + 1] <= t) bp++;
      if (bp < 0) continue;
      const i = bp;
      if (i >= 24) btcRet24[g] = BTC.close[i] / BTC.close[i - 24] - 1;
      const h = btcH4Lookup(t);
      if (h >= 0) {
        btc4On[g] = isNum(btcH4Ema50[h]) && isNum(btcH4Ema200[h]) && btcH4Ema50[h] > btcH4Ema200[h] ? 1 : 0;
        btc4Trend[g] = isNum(btcH4Adx[h]) && btcH4Adx[h] > 20 ? 1 : 0;
      }
      const d = btcD1Lookup(t);
      if (d >= 0) {
        btc1dRange[g] = isNum(btcD1Adx[d]) && btcD1Adx[d] < 25 ? 1 : 0;
        btc1dRiskOn[g] = isNum(btcD1Ema20[d]) && isNum(btcD1Ema50[d]) && btcD1Ema20[d] > btcD1Ema50[d] ? 1 : 0;
      }
    }
  }

  // map raw symbol time -> global index (monotonic merge)
  function makeGlobalIndexLookup(s) {
    let p = 0;
    return function gi(t) {
      while (p + 1 < NG && GLOBAL[p] < t) p++;
      return p;
    };
  }

  // ---- per-symbol feature engineering + signals ----------------------------
  let integrityHtfChecks = 0;
  let integrityHtfViolations = 0;
  let integrityFillAfterSignal = 0;

  for (const s of rawSyms) {
    const n = s.n;
    s.inLong = s.n >= LONG_MIN_BARS;
    s.inBroad = s.n >= BROAD_MIN_BARS;

    // 1H indicators
    const atr14 = wilderATR(s.high, s.low, s.close, 14);
    const atr22 = wilderATR(s.high, s.low, s.close, 22);
    const rsi14 = wilderRSI(s.close, 14);
    const adx14 = wilderADX(s.high, s.low, s.close, 14);
    const ema20 = ema(s.close, 20);
    const sma20 = sma(s.close, 20);
    const volSma20 = sma(s.volume, 20);
    const d20 = donchian(s.high, s.low, 20);
    const d55 = donchian(s.high, s.low, 55);
    const kelU = new Float32Array(n).fill(NaN);
    const kelL = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (isNum(ema20[i]) && isNum(atr14[i])) { kelU[i] = ema20[i] + 2 * atr14[i]; kelL[i] = ema20[i] - 2 * atr14[i]; }
    }
    const atrPct = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (isNum(atr14[i]) && s.close[i] > 0) atrPct[i] = atr14[i] / s.close[i];
    const atrPctSma20 = sma(atrPct, 20);
    const atrPctMed20 = rollingMedian(atrPct, 20);

    // higher timeframes
    const h4 = resample(s.time, s.open, s.high, s.low, s.close, s.volume, H4);
    const h4Ema50 = ema(h4.close, 50);
    const h4Ema200 = ema(h4.close, 200);
    const h4Adx = wilderADX(h4.high, h4.low, h4.close, 14);
    const h4Lookup = makeClosedLookup(h4.time, H4);

    // store simulation-time arrays
    s.atr14 = atr14;
    s.atr22 = atr22;
    s.ema20 = ema20;

    s.sigA = new Int8Array(n);
    s.sigB = new Int8Array(n);
    s.sigC = new Uint8Array(n);
    s.dQual = new Uint8Array(n);
    s.rs = new Float32Array(n).fill(NaN);

    const giLookup = makeGlobalIndexLookup(s);
    for (let i = 0; i < n; i++) {
      const t = s.time[i];
      const g = giLookup(t);
      const h = h4Lookup(t);
      if (h >= 0) {
        // closed-bucket integrity: the referenced bucket's close time must be <= bar time
        integrityHtfChecks++;
        if (h4.time[h] + H4 > t) integrityHtfViolations++;
      }
      const sym4On = h >= 0 && isNum(h4Ema50[h]) && isNum(h4Ema200[h]) ? h4Ema50[h] > h4Ema200[h] : false;
      const sym4Trend = h >= 0 && isNum(h4Adx[h]) && h4Adx[h] > 20;

      const rs = isNum(btcRet24[g]) && i >= 24 ? (s.close[i] / s.close[i - 24] - 1) - btcRet24[g] : NaN;
      s.rs[i] = rs;

      // A) MTF trend + vol breakout
      const c = s.close[i];
      const atr = atr14[i];
      if (isNum(c) && isNum(atr) && isNum(atrPct[i]) && isNum(atrPctSma20[i])) {
        const breakoutUp = (isNum(d20.up[i]) && c > d20.up[i]) || (isNum(kelU[i]) && c > kelU[i]);
        const breakoutDn = (isNum(d20.lo[i]) && c < d20.lo[i]) || (isNum(kelL[i]) && c < kelL[i]);
        const volExp = atrPct[i] > atrPctSma20[i];
        const relStr = isNum(rs);
        if (btc4On[g] && btc4Trend[g] && sym4On && sym4Trend && breakoutUp && volExp && relStr && rs > 0) s.sigA[i] = 1;
        else if (!btc4On[g] && btc4Trend[g] && !sym4On && sym4Trend && breakoutDn && volExp && relStr && rs < 0) s.sigA[i] = -1;
      }

      // B) mean-reversion sweep (range only)
      if (isNum(rsi14[i]) && isNum(d20.up[i]) && isNum(d20.lo[i]) && isNum(atr)) {
        const ranging = adx14[i] < 20 && btc1dRange[g] === 1;
        if (ranging) {
          if (s.low[i] < d20.lo[i] && c > d20.lo[i] && rsi14[i] < 25) s.sigB[i] = 1;
          else if (s.high[i] > d20.up[i] && c < d20.up[i] && rsi14[i] > 75) s.sigB[i] = -1;
        }
      }

      // C) trend pyramid (long only)
      if (isNum(c) && isNum(atr) && isNum(atrPct[i]) && isNum(atrPctMed20[i])) {
        if (isNum(d55.up[i]) && c > d55.up[i] && sym4On && atrPct[i] > atrPctMed20[i]) s.sigC[i] = 1;
      }

      // D) cross-sectional vol-weighted RS momentum qualifier
      if (isNum(volSma20[i]) && isNum(ema20[i]) && isNum(rs)) {
        if (s.volume[i] > 3 * volSma20[i] && rs > 0 && c > ema20[i]) s.dQual[i] = 1;
      }
    }
    // sma20 is retained for B targets (captured at signal time)
    s.sma20 = sma20;
  }

  console.log(`ENGINE INTEGRITY: closed-HTF bucket checks = ${integrityHtfChecks}, violations = ${integrityHtfViolations}`);
  console.log('');

  // ------------------------------------------------------------------------
  // Portfolio simulation
  // ------------------------------------------------------------------------

  const yearOf = new Int8Array(NG);
  const yearNames = new Map();
  for (let g = 0; g < NG; g++) {
    const y = new Date(GLOBAL[g] * 1000).getUTCFullYear();
    yearOf[g] = y - 2000;
    yearNames.set(y - 2000, y);
  }
  const allYears = Array.from(new Set(GLOBAL.length ? Array.from(yearOf) : [])).sort();
  const yearLabel = (yk) => String(2000 + yk);
  const yearStart = new Map();
  for (let g = 0; g < NG; g++) if (!yearStart.has(yearOf[g])) yearStart.set(yearOf[g], g);

  function runPortfolio(strategyIds, useCosts) {
    const enabled = new Set(strategyIds);
    const costF = useCosts ? 1 : 0;
    const feeRate = FEE_PER_SIDE * costF;
    const slipRate = SLIPPAGE_PER_SIDE * costF;

    const posMap = new Map();
    const pendingEntry = new Map();
    const pendingExit = new Set();
    const lastClose = new Map();
    const trades = [];
    const eq = new Float64Array(NG);
    const daily = new Map();

    let realized = START_EQUITY;
    let equityMark = START_EQUITY;
    let peak = START_EQUITY;
    let maxDD = 0;
    let barsWithPos = 0;
    let totalSteps = 0;

    const cur = new Int32Array(rawSyms.length);
    let dQualList = [];

    const canOpenSym = (sym) =>
      !posMap.has(sym) && !pendingEntry.has(sym) && !pendingExit.has(sym) &&
      (posMap.size + pendingEntry.size) < MAX_POSITIONS;

    const queueEntry = (sym, pe) => {
      pendingEntry.set(sym, pe);
    };

    function feeOf(notional) { return notional * feeRate; }

    function openUnitCost(notional) { return notional * feeRate; }

    function fillEntry(s, i, g, t, pe) {
      if (pe.signalIndex >= i) throw new Error(`LOOKAHEAD VIOLATION: fill bar ${i} <= signal bar ${pe.signalIndex} for ${s.sym}`);
      integrityFillAfterSignal++;
      const dir = pe.dir;
      const entryFill = dir > 0 ? s.open[i] * (1 + slipRate) : s.open[i] * (1 - slipRate);
      let stopAbs;
      if (pe.stopMode === 'abs') stopAbs = pe.stopAbs;
      else stopAbs = dir > 0 ? entryFill - pe.stopDist : entryFill + pe.stopDist;
      const dist = dir > 0 ? entryFill - stopAbs : stopAbs - entryFill;
      if (!(dist > 0)) return;
      let qty = pe.riskAmount / dist;
      const maxN = Math.min(LEVERAGE_CAP * equityMark, MAX_POSITION_NOTIONAL_PCT * equityMark);
      if (qty * entryFill > maxN) qty = maxN / entryFill;
      if (!(qty > 0)) return;
      const actualRisk = qty * dist; // true $ risk at the initial stop after the notional cap
      const entryFee = feeOf(qty * entryFill);
      realized -= entryFee;

      const pos = {
        sym: s.sym,
        strategy: pe.strategy,
        dir,
        units: [{ qty, entry: entryFill, stop: stopAbs, risk: actualRisk, closed: false }],
        totalRisk: actualRisk,
        grossPl: 0,
        feesPaid: entryFee,
        funding: 0,
        entryTime: t,
        entryIndex: i,
        initialEntry: entryFill,
        initialR: dist,
        maxFavR: 0,
        highSince: dir > 0 ? s.high[i] : s.low[i],
        trailStop: dir > 0 ? -Infinity : Infinity,
        target: pe.targetAbs != null ? pe.targetAbs : null,
        timeStopBar: pe.timeStopBars ? i + pe.timeStopBars : null,
        entryEquity: equityMark,
        isPyramid: pe.strategy === 'C',
        addIdx: 0,
        addLevels: null,
      };
      if (pe.strategy === 'C') {
        pos.addLevels = [0.5, 1.0, 1.5].map((f) => entryFill + dir * f * dist);
      }
      posMap.set(s.sym, pos);
    }

    function exitUnit(s, p, u, fill, t) {
      u.closed = true;
      u.exit = fill;
      u.exitTime = t;
      const gross = (fill - u.entry) * u.qty * p.dir;
      const fee = feeOf(fill * u.qty);
      realized += gross - fee;
      p.grossPl += gross;
      p.feesPaid += fee;
    }

    function finalizePosition(p, t) {
      const pnl = p.grossPl - p.feesPaid - p.funding;
      trades.push({
        sym: p.sym,
        strategy: p.strategy,
        dir: p.dir,
        entryTime: p.entryTime,
        exitTime: t,
        entry: p.initialEntry,
        risk: p.totalRisk,
        pnl,
        grossPl: p.grossPl,
        fees: p.feesPaid,
        funding: p.funding,
        r: p.totalRisk > 0 ? pnl / p.totalRisk : 0,
        equityAtEntry: p.entryEquity,
        units: p.units.length,
        lastExitIndex: p.entryIndex,
      });
      posMap.delete(p.sym);
    }

    function closeAll(s, i, t) {
      const p = posMap.get(s.sym);
      if (!p) return;
      const dir = p.dir;
      const fill0 = s.open[i];
      const fill = dir > 0 ? fill0 * (1 - slipRate) : fill0 * (1 + slipRate);
      for (const u of p.units) if (!u.closed) exitUnit(s, p, u, fill, t);
      finalizePosition(p, t);
    }

    function manage(s, i, g, t) {
      const p = posMap.get(s.sym);
      if (!p) return;
      const dir = p.dir;
      const long = dir > 0;

      // funding accrual (approximate, hourly slice of the 8h rate)
      if (useCosts) {
        let notional = 0;
        for (const u of p.units) if (!u.closed) notional += u.qty * s.close[i];
        const f = notional * FUNDING_PER_8H / 8;
        realized -= f;
        p.funding += f;
      }

      // B time stop
      if (p.timeStopBar != null && i >= p.timeStopBar) {
        closeAll(s, i, t);
        return;
      }

      // stops (stop-first rule)
      const stopped = [];
      for (const u of p.units) {
        if (u.closed) continue;
        const eff = long ? Math.max(u.stop, p.trailStop) : Math.min(u.stop, p.trailStop);
        const hit = long ? s.low[i] <= eff : s.high[i] >= eff;
        if (hit) stopped.push({ u, eff });
      }
      let didStop = false;
      if (stopped.length) {
        didStop = true;
        for (const { u, eff } of stopped) {
          let raw = long ? Math.min(eff, s.open[i]) : Math.max(eff, s.open[i]);
          const fill = long ? raw * (1 - slipRate) : raw * (1 + slipRate);
          exitUnit(s, p, u, fill, t);
        }
      }

      // target (B only; single unit). Only if no stop this bar.
      if (!didStop && p.target != null) {
        const u = p.units.find((x) => !x.closed);
        const hit = u ? (long ? s.high[i] >= p.target : s.low[i] <= p.target) : false;
        if (hit) {
          const raw = p.target;
          const fill = long ? raw * (1 - slipRate) : raw * (1 + slipRate);
          exitUnit(s, p, u, fill, t);
        }
      }

      // pyramiding adds (C, long only)
      if (p.isPyramid && dir > 0 && !didStop && p.addLevels) {
        while (p.addIdx < p.addLevels.length && s.high[i] >= p.addLevels[p.addIdx]) {
          const level = p.addLevels[p.addIdx];
          const a = s.atr14[i];
          if (!isNum(a)) { p.addIdx++; continue; }
          let raw = Math.max(level, s.open[i]);
          const fill = raw * (1 + slipRate);
          const stopAdd = fill - 2 * a;
          const unitRisk = 0.005 * p.entryEquity;
          let qty = unitRisk / (fill - stopAdd);
          const maxN = Math.min(LEVERAGE_CAP * equityMark, MAX_POSITION_NOTIONAL_PCT * equityMark);
          if (qty * fill > maxN) qty = maxN / fill;
          if (qty > 0) {
            const actualUnitRisk = qty * (fill - stopAdd);
            const ef = feeOf(qty * fill);
            realized -= ef;
            p.feesPaid += ef;
            p.units.push({ qty, entry: fill, stop: stopAdd, risk: actualUnitRisk, closed: false });
            p.totalRisk += actualUnitRisk;
          }
          p.addIdx++;
        }
      }

      // trailing updates
      if (p.units.some((u) => !u.closed)) {
        if (p.strategy === 'A') {
          const fav = long ? (s.high[i] - p.initialEntry) / p.initialR : (p.initialEntry - s.low[i]) / p.initialR;
          if (fav > p.maxFavR) p.maxFavR = fav;
          if (p.maxFavR >= 1) {
            let cand = NaN;
            if (long) {
              let lo = Infinity;
              for (let j = Math.max(0, i - 10); j < i; j++) if (s.low[j] < lo) lo = s.low[j];
              cand = lo;
            } else {
              let hi = -Infinity;
              for (let j = Math.max(0, i - 10); j < i; j++) if (s.high[j] > hi) hi = s.high[j];
              cand = hi;
            }
            if (isNum(cand)) p.trailStop = long ? Math.max(p.trailStop, cand) : Math.min(p.trailStop, cand);
          }
        } else if (p.strategy === 'C') {
          p.highSince = Math.max(p.highSince, s.high[i]);
          const a = s.atr22[i];
          if (isNum(a)) {
            const cand = p.highSince - 3 * a;
            p.trailStop = Math.max(p.trailStop, cand);
          }
        } else if (p.strategy === 'D') {
          p.highSince = Math.max(p.highSince, s.high[i]);
          if (isNum(s.ema20[i])) p.trailStop = Math.max(p.trailStop, s.ema20[i]);
          const a = s.atr14[i];
          if (isNum(a)) p.trailStop = Math.max(p.trailStop, p.highSince - 2.5 * a);
        }
      }

      if (!p.units.some((u) => !u.closed)) {
        // remaining risk data for record (entryIndex kept)
        finalizePosition(p, t);
      }
    }

    function queueSignals(s, i, g, t, gi) {
      const sym = s.sym;
      // A regime-flip exits
      if (enabled.has('A') && posMap.has(sym) && posMap.get(sym).strategy === 'A') {
        const p = posMap.get(sym);
        if (p.dir > 0 && (!btc4On[g] || !btc4Trend[g])) pendingExit.add(sym);
        if (p.dir < 0 && (btc4On[g] || !btc4Trend[g])) pendingExit.add(sym);
      }

      if (s.inLong && enabled.has('A') && canOpenSym(sym)) {
        if (s.sigA[i] === 1) queueEntry(sym, { strategy: 'A', dir: 1, stopMode: 'dist', stopDist: 1.5 * s.atr14[i], riskAmount: RISK_PCT * equityMark, signalIndex: i });
        else if (s.sigA[i] === -1) queueEntry(sym, { strategy: 'A', dir: -1, stopMode: 'dist', stopDist: 1.5 * s.atr14[i], riskAmount: RISK_PCT * equityMark, signalIndex: i });
      }
      if (s.inLong && enabled.has('B') && canOpenSym(sym)) {
        if (s.sigB[i] === 1 && isNum(s.atr14[i]) && isNum(s.sma20[i])) {
          queueEntry(sym, { strategy: 'B', dir: 1, stopMode: 'abs', stopAbs: s.low[i] - 1.5 * s.atr14[i], targetAbs: s.sma20[i], riskAmount: RISK_PCT * equityMark, timeStopBars: 48, signalIndex: i });
        } else if (s.sigB[i] === -1 && isNum(s.atr14[i]) && isNum(s.sma20[i])) {
          queueEntry(sym, { strategy: 'B', dir: -1, stopMode: 'abs', stopAbs: s.high[i] + 1.5 * s.atr14[i], targetAbs: s.sma20[i], riskAmount: RISK_PCT * equityMark, timeStopBars: 48, signalIndex: i });
        }
      }
      if (s.inLong && enabled.has('C') && canOpenSym(sym) && s.sigC[i] === 1 && isNum(s.atr14[i])) {
        queueEntry(sym, { strategy: 'C', dir: 1, stopMode: 'dist', stopDist: 2 * s.atr14[i], riskAmount: RISK_PCT * equityMark, signalIndex: i });
      }
    }

    for (let g = 0; g < NG; g++) {
      const t = GLOBAL[g];
      dQualList = [];

      for (let si = 0; si < rawSyms.length; si++) {
        const s = rawSyms[si];
        let i = cur[si];
        while (i < s.n && s.time[i] < t) i++;
        cur[si] = i;
        if (i >= s.n || s.time[i] !== t) continue;

        const sym = s.sym;
        // 1) pending exit at open
        if (pendingExit.has(sym)) {
          if (posMap.has(sym)) closeAll(s, i, t);
          pendingExit.delete(sym);
        }
        // 2) pending entry at open
        if (pendingEntry.has(sym)) {
          const pe = pendingEntry.get(sym);
          pendingEntry.delete(sym);
          if (!posMap.has(sym) && posMap.size < MAX_POSITIONS) fillEntry(s, i, g, t, pe);
        }
        // 3) intrabar management
        if (posMap.has(sym)) manage(s, i, g, t);
        // 4) last close for mark-to-market
        lastClose.set(sym, s.close[i]);
        // 5) signals at close
        queueSignals(s, i, g, t, g);

        // D qualifier collection
        if (enabled.has('D') && s.inBroad && s.dQual[i] === 1) {
          dQualList.push({ sym, rs: s.rs[i], i, g });
        }
      }

      // post-loop cross-sectional D
      if (enabled.has('D')) {
        if (dQualList.length > 1) dQualList.sort((a, b) => b.rs - a.rs);
        if (dQualList.length) {
          const present = new Set(dQualList.map((x) => x.sym));
          const thr = Math.max(1, Math.ceil(0.2 * dQualList.length));
          for (const [sym, p] of posMap) {
            if (p.strategy !== 'D') continue;
            if (!present.has(sym)) { pendingExit.add(sym); continue; }
            const rank = dQualList.findIndex((x) => x.sym === sym) + 1;
            if (rank > thr) pendingExit.add(sym);
          }
          if (btc1dRiskOn[g]) {
            const K = Math.max(1, Math.min(3, Math.ceil(0.05 * dQualList.length)));
            for (let k = 0; k < K && k < dQualList.length; k++) {
              const rec = dQualList[k];
              if (canOpenSym(rec.sym) && isNum(rec.rs)) {
                queueEntry(rec.sym, { strategy: 'D', dir: 1, stopMode: 'dist', stopDist: 1.5 * symByTime.get(rec.sym).atr14[rec.i], riskAmount: RISK_PCT * equityMark, signalIndex: rec.i });
              }
            }
          }
        } else {
          // no qualifiers: any held D position must exit
          for (const [sym, p] of posMap) if (p.strategy === 'D') pendingExit.add(sym);
        }
      }

      // mark to market
      let eqv = realized;
      if (posMap.size) {
        for (const [sym, p] of posMap) {
          const mark = lastClose.has(sym) ? lastClose.get(sym) : p.initialEntry;
          for (const u of p.units) {
            if (u.closed) continue;
            eqv += (mark - u.entry) * u.qty * p.dir;
          }
        }
      }
      equityMark = eqv;
      eq[g] = eqv;
      if (eqv > peak) peak = eqv;
      const dd = peak > 0 ? (peak - eqv) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      if (posMap.size > 0) barsWithPos++;
      const day = Math.floor(t / D1);
      daily.set(day, eqv);
    }

    // ---------- metrics ----------
    const summary = summarize({ trades, eq, daily, maxDD, barsWithPos, totalSteps: NG, useCosts, strategyIds });
    return summary;
  }

  function summarize({ trades, eq, daily, maxDD, barsWithPos, totalSteps, useCosts, strategyIds }) {
    const nT = trades.length;
    let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0;
    let sumR = 0, sumPct = 0, sumWinR = 0, sumLossR = 0;
    let bestR = -Infinity, worstR = Infinity, bestPnl = -Infinity, worstPnl = Infinity;
    let curWin = 0, curLoss = 0, maxWinStreak = 0, maxLossStreak = 0;
    const bySym = new Map();
    const byYear = new Map();

    for (const tr of trades) {
      const pnl = tr.pnl;
      if (pnl >= 0) { wins++; grossProfit += pnl; sumWinR += tr.r; curWin++; curLoss = 0; }
      else { losses++; grossLoss += -pnl; sumLossR += tr.r; curLoss++; curWin = 0; }
      if (curWin > maxWinStreak) maxWinStreak = curWin;
      if (curLoss > maxLossStreak) maxLossStreak = curLoss;
      sumR += tr.r;
      sumPct += tr.equityAtEntry > 0 ? pnl / tr.equityAtEntry : 0;
      if (tr.r > bestR) bestR = tr.r;
      if (tr.r < worstR) worstR = tr.r;
      if (pnl > bestPnl) bestPnl = pnl;
      if (pnl < worstPnl) worstPnl = pnl;
      bySym.set(tr.sym, (bySym.get(tr.sym) || 0) + 1);
      const y = new Date(tr.exitTime * 1000).getUTCFullYear();
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(tr);
    }

    const startEq = eq[0] || START_EQUITY;
    const finalEq = eq[eq.length - 1];
    const firstT = GLOBAL[0];
    const lastT = GLOBAL[NG - 1] + HOUR;
    const years = (lastT - firstT) / (365.25 * 86400);
    const roi = finalEq / START_EQUITY - 1;
    const cagr = years > 0 ? Math.pow(finalEq / START_EQUITY, 1 / years) - 1 : NaN;

    // daily Sharpe
    const days = Array.from(daily.keys()).sort((a, b) => a - b);
    const rets = [];
    for (let k = 1; k < days.length; k++) {
      const prev = daily.get(days[k - 1]);
      const cur = daily.get(days[k]);
      if (prev > 0) rets.push(cur / prev - 1);
    }
    let sharpe = NaN;
    if (rets.length > 2) {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const v = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1);
      const sd = Math.sqrt(v);
      sharpe = sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
    }

    const perYear = [];
    for (const y of allYears) {
      const a = yearStart.get(y);
      let b = a;
      while (b + 1 < NG && yearOf[b + 1] === y) b++;
      const base = a > 0 ? eq[a - 1] : START_EQUITY;
      const endEq = eq[b];
      const yTrades = byYear.get(2000 + y) || [];
      let yw = 0, yl = 0, ygp = 0, ygl = 0;
      for (const tr of yTrades) {
        if (tr.pnl >= 0) { yw++; ygp += tr.pnl; } else { yl++; ygl += -tr.pnl; }
      }
      let ypeak = eq[a], ydd = 0;
      for (let g = a; g <= b; g++) {
        if (eq[g] > ypeak) ypeak = eq[g];
        const d = ypeak > 0 ? (ypeak - eq[g]) / ypeak : 0;
        if (d > ydd) ydd = d;
      }
      perYear.push({
        year: yearLabel(y),
        trades: yTrades.length,
        wins: yw,
        losses: yl,
        winRate: yTrades.length ? yw / yTrades.length : NaN,
        profitFactor: ygl > 0 ? ygp / ygl : (ygp > 0 ? Infinity : NaN),
        roi: base > 0 ? endEq / base - 1 : NaN,
        maxDD: ydd,
      });
    }

    const symCounts = Array.from(bySym.entries()).sort((a, b) => b[1] - a[1]);

    return {
      strategyIds,
      useCosts,
      trades: nT,
      wins,
      losses,
      winRate: nT ? wins / nT : NaN,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : NaN),
      expectancyR: nT ? sumR / nT : NaN,
      expectancyPct: nT ? (sumPct / nT) * 100 : NaN,
      avgWinR: wins ? sumWinR / wins : NaN,
      avgLossR: losses ? sumLossR / losses : NaN,
      bestR: nT ? bestR : NaN,
      worstR: nT ? worstR : NaN,
      bestPnl: nT ? bestPnl : NaN,
      worstPnl: nT ? worstPnl : NaN,
      maxWinStreak,
      maxLossStreak,
      roiPct: roi * 100,
      cagrPct: cagr * 100,
      maxDDPct: maxDD * 100,
      sharpe,
      exposurePct: totalSteps ? (barsWithPos / totalSteps) * 100 : 0,
      finalEquity: finalEq,
      years,
      periodStart: tsToDate(firstT),
      periodEnd: tsToDate(GLOBAL[NG - 1]),
      firstTrade: nT ? tsToDate(Math.min(...trades.map((x) => x.entryTime))) : null,
      lastTrade: nT ? tsToDate(Math.max(...trades.map((x) => x.exitTime))) : null,
      weakSample: nT < 30,
      perYear,
      symCounts,
    };
  }

  // ------------------------------------------------------------------------
  // Run everything
  // ------------------------------------------------------------------------

  const RUNS = [
    { id: 'A', label: 'A  MTF_TREND_VOL_BREAKOUT', strategies: ['A'] },
    { id: 'B', label: 'B  MEAN_REVERSION_SWEEP', strategies: ['B'] },
    { id: 'C', label: 'C  TREND_PYRAMID_ATR_TRAIL', strategies: ['C'] },
    { id: 'D', label: 'D  VOL_WEIGHTED_RS_MOMENTUM', strategies: ['D'] },
    { id: 'ACD', label: 'BLEND A+C+D', strategies: ['A', 'C', 'D'] },
    { id: 'ABCD', label: 'BLEND A+B+C+D', strategies: ['A', 'B', 'C', 'D'] },
  ];

  const results = {};
  for (const run of RUNS) {
    const withCosts = runPortfolio(run.strategies, true);
    const withoutCosts = runPortfolio(run.strategies, false);
    results[run.id] = { label: run.label, strategies: run.strategies, withCosts, withoutCosts };
  }

  // ------------------------------------------------------------------------
  // Reporting
  // ------------------------------------------------------------------------

  function printMetricsTable(title, key) {
    console.log('----------------------------------------------------------------------------');
    console.log(title);
    console.log('----------------------------------------------------------------------------');
    const head = ['metric', ...RUNS.map((r) => r.id.padStart(14))];
    console.log(head.join(''));
    const rows = [
      ['trades', (s) => s.trades],
      ['win rate', (s) => pct(s.winRate, 1)],
      ['profit factor', (s) => fmt(s.profitFactor, 3)],
      ['expectancy R', (s) => fmt(s.expectancyR, 3)],
      ['expectancy %', (s) => fmt(s.expectancyPct, 3) + '%'],
      ['avg win R', (s) => fmt(s.avgWinR, 2)],
      ['avg loss R', (s) => fmt(s.avgLossR, 2)],
      ['best R', (s) => fmt(s.bestR, 2)],
      ['worst R', (s) => fmt(s.worstR, 2)],
      ['max win streak', (s) => s.maxWinStreak],
      ['max loss streak', (s) => s.maxLossStreak],
      ['gross profit', (s) => '$' + fmt(s.grossProfit, 0)],
      ['gross loss', (s) => '$' + fmt(s.grossLoss, 0)],
      ['ROI %', (s) => fmt(s.roiPct, 1) + '%'],
      ['CAGR %', (s) => fmt(s.cagrPct, 1) + '%'],
      ['max drawdown %', (s) => fmt(s.maxDDPct, 1) + '%'],
      ['sharpe (daily)', (s) => fmt(s.sharpe, 2)],
      ['exposure %', (s) => fmt(s.exposurePct, 1) + '%'],
      ['final equity', (s) => '$' + fmt(s.finalEquity, 0)],
      ['weak sample', (s) => (s.weakSample ? 'YES(<30)' : 'no')],
    ];
    for (const [name, fn] of rows) {
      const cells = RUNS.map((r) => String(fn(results[r.id][key])).padStart(14));
      console.log(name.padEnd(18) + cells.join(''));
    }
    console.log('');
  }

  console.log('============================================================================');
  console.log('  RESULTS — PRIMARY (WITH COSTS: fee + slippage + approximated funding)');
  console.log('============================================================================');
  console.log('');
  console.log('Period covered by all runs: ' + tsToDate(GLOBAL[0]) + ' -> ' + tsToDate(GLOBAL[NG - 1]) + `  (${(results.A.withCosts.years).toFixed(2)} years)`);
  console.log('');
  printMetricsTable('PER-ARCHETYPE PORTFOLIO METRICS (with costs)', 'withCosts');

  console.log('============================================================================');
  console.log('  RESULTS — SECONDARY (WITHOUT COSTS: clean fills, no fee/slippage/funding)');
  console.log('============================================================================');
  console.log('');
  printMetricsTable('PER-ARCHETYPE PORTFOLIO METRICS (without costs)', 'withoutCosts');

  // per-year breakdown (with costs)
  console.log('============================================================================');
  console.log('  PER-YEAR BREAKDOWN (with costs)   [PF / WR / ROI / maxDD]');
  console.log('============================================================================');
  console.log('');
  for (const run of RUNS) {
    const s = results[run.id].withCosts;
    console.log(`${run.id}  ${run.label}`);
    console.log('  year |   trades |    PF  |    WR  |    ROI  |  maxDD');
    for (const y of s.perYear) {
      const pf = y.profitFactor === Infinity ? '   Inf' : fmt(y.profitFactor, 2).padStart(6);
      console.log(
        `  ${y.year} | ${String(y.trades).padStart(8)} | ${pf} | ${pct(y.winRate, 1).padStart(6)} | ${(fmt(y.roi * 100, 1) + '%').padStart(7)} | ${(fmt(y.maxDD * 100, 1) + '%').padStart(6)}`,
      );
    }
    console.log('');
  }

  // per-symbol trade counts for trend archetypes
  console.log('============================================================================');
  console.log('  PER-SYMBOL TRADE COUNTS (trend archetypes A and C, with costs)');
  console.log('============================================================================');
  for (const id of ['A', 'C']) {
    const s = results[id].withCosts;
    console.log('');
    console.log(`  ${id}: total ${s.trades} trades across ${s.symCounts.length} symbols`);
    console.log('   ' + s.symCounts.map(([sym, c]) => `${sym}:${c}`).join('  '));
  }
  console.log('');

  // integrity report
  console.log('============================================================================');
  console.log('  INTEGRITY CHECKS');
  console.log('============================================================================');
  console.log(`  fills validated to occur strictly after their signal bar : ${integrityFillAfterSignal} (throws on violation)`);
  console.log(`  closed-HTF bucket checks / violations .................. : ${integrityHtfChecks} / ${integrityHtfViolations}`);
  console.log('  fill rule  = bar i+1 OPEN  |  HTF rule = closed buckets only');
  console.log('  stop/target tie rule = STOP fills first');
  console.log('  higher-tf resampling = OHLCV aggregation on floor(time/interval) buckets');
  console.log('');

  const implementationNotes = [
    'Funding is approximated: no funding series exists in the cache, so funding is charged as notional * 0.0001 / 8 on every open 1H bar (~0.03%/day).',
    'R multiples are computed against the ACTUAL $ risk taken at the initial stop after the 25%-of-equity notional cap is applied (not the requested 1%).',
    'Per-position notional is capped at 25% of equity; the 5x leverage cap therefore never binds (25% is stricter).',
    'A: the optional "bank 50% at +2R" partial exit is DISABLED to keep single-exit trade accounting; regime requires BTC 4H EMA50/200 direction AND 4H ADX>20 on BOTH BTC and the symbol; trailing uses Donchian(10) opposite extreme once +1R.',
    'B: stop is anchored to the sweep-bar extreme -/+ 1.5*ATR(14); target is the fixed SMA20 value at the signal bar; market time-stop at 48 bars.',
    'C: initial unit risks 1% of current equity; up to 3 adds at +0.5R/+1.0R/+1.5R (4 units total), each risking 0.5% of ORIGINAL equity with its own 2*ATR stop; 1R = 2*ATR(14); chandelier trail = highest_high(since entry) - 3*ATR(22); stops never move down.',
    'D: qualifier = volume > 3*SMA20(volume) AND rs(24h sym-BTC) > 0 AND close > EMA20; rank by rs, take top 5% clamped to [1,3]; regime = BTC 1D EMA20 > EMA50; exit when the symbol is no longer a qualifier, its rs rank falls below the top 20% of qualifiers, or the stop/trail is hit; trail = max(initial stop, EMA20, highest_high - 2.5*ATR(14)).',
    'Cross-sectional survivorship: the cached symbol list is today\'s universe; symbols that were delisted/never listed over the window are absent, which biases cross-sectional (D) results optimistically.',
    '1H granularity only: intrabar sequencing uses high/low with the conservative stop-first assumption; there is no tick data.',
  ];
  console.log('============================================================================');
  console.log('  IMPLEMENTATION NOTES / INTERPRETATIONS');
  console.log('============================================================================');
  for (const n of implementationNotes) console.log('  - ' + n);
  console.log('');

  // ---- write JSON ----------------------------------------------------------
  const out = {
    generatedAt: new Date().toISOString(),
    costModel: {
      feePerSide: FEE_PER_SIDE,
      slippagePerSide: SLIPPAGE_PER_SIDE,
      fundingPer8h: FUNDING_PER_8H,
      fundingNote: 'Approximated: cached data has no funding series; charged as notional * fundingPer8h/8 per open 1H bar.',
      roundTripExplicitPct: (FEE_PER_SIDE + SLIPPAGE_PER_SIDE) * 2,
    },
    risk: {
      startEquity: START_EQUITY,
      riskPct: RISK_PCT,
      leverageCap: LEVERAGE_CAP,
      maxPositions: MAX_POSITIONS,
      maxPositionNotionalPct: MAX_POSITION_NOTIONAL_PCT,
    },
    period: { start: tsToDate(GLOBAL[0]), end: tsToDate(GLOBAL[NG - 1]), globalBars: NG },
    integrity: { fillAfterSignalChecks: integrityFillAfterSignal, htfBucketChecks: integrityHtfChecks, htfBucketViolations: integrityHtfViolations },
    implementationNotes,
    universes: {
      long: longUniverse,
      broad: broadUniverse,
      longCount: longUniverse.length,
      broadCount: broadUniverse.length,
    },
    results: {},
  };
  for (const run of RUNS) {
    const r = results[run.id];
    out.results[run.id] = {
      label: run.label,
      strategies: run.strategies,
      withCosts: r.withCosts,
      withoutCosts: r.withoutCosts,
    };
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, (k, v) => (v === Infinity ? null : v), 2));
  console.log(`Wrote results JSON -> ${OUT_FILE}`);
  console.log(`Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
