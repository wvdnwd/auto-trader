#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve(process.cwd(), 'data/candles_cache');
const symbols = ['NEAR_USDT', 'PEPE_USDT', 'SUI_USDT', 'SOL_USDT', 'BTC_USDT'];

function calculateEma(candles, period) {
  const k = 2 / (period + 1);
  const emas = new Array(candles.length);
  let sum = 0;
  for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
  let prevEma = sum / Math.min(period, candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) emas[i] = candles[i].close;
    else if (i === period - 1) emas[i] = prevEma;
    else {
      prevEma = candles[i].close * k + prevEma * (1 - k);
      emas[i] = prevEma;
    }
  }
  return emas;
}

function calculateAtr(candles, period = 14) {
  const atrs = new Array(candles.length);
  let prevAtr = candles[0].high - candles[0].low;
  atrs[0] = prevAtr;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    prevAtr = (prevAtr * (period - 1) + tr) / period;
    atrs[i] = prevAtr;
  }
  return atrs;
}

function calculateRsi(candles, period = 14) {
  const rsis = new Array(candles.length).fill(50);
  if (candles.length <= period) return rsis;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsis[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsis[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsis;
}

const marketData = {};
for (const sym of symbols) {
  const cacheFile = path.resolve(CACHE_DIR, `${sym}_1h.json`);
  if (!fs.existsSync(cacheFile)) continue;
  const candles = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).slice(-2000);
  marketData[sym] = {
    symbol: sym,
    candles,
    ema21: calculateEma(candles, 21),
    ema55: calculateEma(candles, 55),
    ema200: calculateEma(candles, 200),
    atr14: calculateAtr(candles, 14),
    rsi14: calculateRsi(candles, 14),
    timeMap: new Map(candles.map((c, idx) => [c.time, idx])),
  };
}

const timeline = marketData['BTC_USDT'].candles.map(c => c.time).slice(200);

function testSettings(tp1R, tp1Portion, minScore, onlyLong = false) {
  let balance = 100;
  let wins = 0, losses = 0;
  let grossProfit = 0, grossLoss = 0;
  const open = [];

  for (const time of timeline) {
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const md = marketData[pos.symbol];
      const idx = md.timeMap.get(time);
      if (idx === undefined) continue;
      const bar = md.candles[idx];
      const isLong = pos.side === 'LONG';
      const worst = isLong ? bar.low : bar.high;
      const best = isLong ? bar.high : bar.low;

      if (isLong ? worst <= pos.stopLoss : worst >= pos.stopLoss) {
        const exit = pos.stopLoss;
        const pnlPct = isLong ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry;
        const pnl = pos.remMargin * 5 * pnlPct;
        pos.realized += pnl;
        balance += pos.remMargin + pnl;
        if (pos.realized > 0) {
          wins++;
          grossProfit += pos.realized;
        } else {
          losses++;
          grossLoss += Math.abs(pos.realized);
        }
        open.splice(i, 1);
        continue;
      }

      if (!pos.tp1Hit && (isLong ? best >= pos.tp1 : best <= pos.tp1)) {
        pos.tp1Hit = true;
        const marginSlice = pos.margin * tp1Portion;
        const pnlPct = isLong ? (pos.tp1 - pos.entry) / pos.entry : (pos.entry - pos.tp1) / pos.entry;
        const pnl = marginSlice * 5 * pnlPct;
        balance += marginSlice + pnl;
        pos.realized += pnl;
        pos.remMargin -= marginSlice;
        pos.stopLoss = isLong ? pos.entry + (pos.rDist * 0.3) : pos.entry - (pos.rDist * 0.3);
      }
    }

    if (open.length >= 2 || balance < 15) continue;

    for (const [sym, md] of Object.entries(marketData)) {
      if (open.some(p => p.symbol === sym)) continue;
      const idx = md.timeMap.get(time);
      if (idx === undefined || idx < 50) continue;
      const bar = md.candles[idx];
      const e21 = md.ema21[idx], e55 = md.ema55[idx], e200 = md.ema200[idx];
      const atr = md.atr14[idx] || (bar.close * 0.02);
      const rsi = md.rsi14[idx] || 50;

      const isLong = e21 > e55 && e21 > md.ema21[idx - 1] && (e21 - e55) / e55 > 0.003 && (!e200 || bar.close > e200);
      const isShort = e21 < e55 && e21 < md.ema21[idx - 1] && (e55 - e21) / e55 > 0.003 && (!e200 || bar.close < e200);
      if (!isLong && !isShort) continue;
      if (onlyLong && !isLong) continue;

      const side = isLong ? 'LONG' : 'SHORT';
      const prevVolSlice = md.candles.slice(Math.max(0, idx - 20), idx);
      const avgVol = prevVolSlice.reduce((a, b) => a + b.volume, 0) / (prevVolSlice.length || 1);
      const volRatio = bar.volume / (avgVol || 1);
      if (volRatio < 1.3) continue;

      let wick = false;
      if (side === 'LONG') {
        const touched = bar.low <= e21 * 1.008 && bar.close > e21;
        const hammer = (bar.close - bar.low) > (bar.high - bar.close) * 1.3 && bar.close > bar.open;
        if (touched && hammer && rsi >= 45 && rsi <= 68) wick = true;
      } else {
        const touched = bar.high >= e21 * 0.992 && bar.close < e21;
        const star = (bar.high - bar.close) > (bar.close - bar.low) * 1.3 && bar.close < bar.open;
        if (touched && star && rsi >= 32 && rsi <= 55) wick = true;
      }
      if (!wick) continue;

      let score = 70;
      if (volRatio >= 2.0) score += 10;
      if (side === 'LONG' && rsi < 55) score += 5;
      if (score < minScore) continue;

      const margin = Math.min(balance * 0.35, 30);
      balance -= margin;
      const isMeme = sym.includes('PEPE');
      const stopDist = Math.max(atr * (isMeme ? 1.8 : 1.4), bar.close * 0.01);
      const stopLoss = side === 'LONG' ? bar.close - stopDist : bar.close + stopDist;
      const rDist = Math.abs(bar.close - stopLoss);
      const tp1 = side === 'LONG' ? bar.close + (rDist * tp1R) : bar.close - (rDist * tp1R);

      open.push({
        symbol: sym,
        side,
        entry: bar.close,
        margin,
        remMargin: margin,
        stopLoss,
        rDist,
        tp1,
        tp1Hit: false,
        realized: 0,
      });
      break;
    }
  }

  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '99';
  const wr = ((wins / (wins + losses || 1)) * 100).toFixed(1);
  return { balance: balance.toFixed(2), wins, losses, wr, pf };
}

console.log('TP1 R-Multiple | TP1 Portion | Min Score | Only Long | Eindsaldo | W / L     | Win Rate | Profit Factor');
console.log('------------------------------------------------------------------------------------------------------');
const tests = [
  { r: 1.5, portion: 0.45, score: 70, onlyLong: false, name: 'Standaard (1.5R, 45% bank)' },
  { r: 1.0, portion: 0.60, score: 70, onlyLong: false, name: 'Snelle TP1 (1.0R, 60% bank)' },
  { r: 1.0, portion: 0.70, score: 75, onlyLong: false, name: 'Snelle TP1 + Strikte Score 75' },
  { r: 1.2, portion: 0.60, score: 75, onlyLong: false, name: 'TP 1.2R (60% bank) + Score 75' },
  { r: 1.2, portion: 0.60, score: 75, onlyLong: true,  name: 'Bull Market Long Only + TP 1.2R' },
  { r: 1.0, portion: 0.70, score: 75, onlyLong: true,  name: 'Bull Market Long Only + TP 1.0R' },
];

for (const t of tests) {
  const res = testSettings(t.r, t.portion, t.score, t.onlyLong);
  console.log(
    `${t.name.padEnd(35)} | $${res.balance.padEnd(8)} | ${String(res.wins).padStart(2)}W / ${String(res.losses).padStart(2)}L | ${res.wr.padStart(5)}%   | PF ${res.pf}`
  );
}
