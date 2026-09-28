#!/usr/bin/env node
/**
 * Traderr Comprehensive Improvement Backtest Suite
 *
 * Backtests individual and combined improvements side-by-side on the exact same market data:
 * 1. Baseline Sniper (EMA200 macro trend, RS vs BTC, Loss throttle, +0.35R profit lock)
 * 2. + Sector Correlation Cap (Max 1 position per cluster: Layer1, Meme, AI, DeFi, Major)
 * 3. + Weekend-Chop Filter (Min confluence score 72 on Sat/Sun vs 68 on weekdays)
 * 4. + ATR-Normalized Dynamic Leverage (3x on high-volatility/memes, 6x on low-volatility majors)
 * 5. + All Improvements Combined (The Complete Institutional Sniper)
 *
 * Usage:
 *   node scripts/compare-improvements.mjs --symbols NEAR,PEPE,SUI,SOL,BTC,ETH,DOGE,AVAX --bars 2000
 */

import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve(process.cwd(), 'data/candles_cache');

const DEFAULT_SYMBOLS = [
  'NEAR_USDT',
  'PEPE_USDT',
  'SUI_USDT',
  'SOL_USDT',
  'BTC_USDT',
  'ETH_USDT',
  'DOGE_USDT',
  'AVAX_USDT',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  let limit = 2000;
  let startingBalance = 100;
  let leverage = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => (s.includes('_') ? s.toUpperCase() : `${s.toUpperCase()}_USDT`));
      i++;
    } else if (args[i] === '--bars' && args[i + 1]) {
      limit = Math.min(5000, Math.max(100, Number(args[i + 1]) || 2000));
      i++;
    } else if (args[i] === '--balance' && args[i + 1]) {
      startingBalance = Math.max(10, Number(args[i + 1]) || 100);
      i++;
    } else if (args[i] === '--leverage' && args[i + 1]) {
      leverage = Math.max(1, Math.min(20, Number(args[i + 1]) || 5));
      i++;
    }
  }
  return { symbols, limit, startingBalance, leverage };
}

function toBinanceSymbol(sym) {
  const clean = sym.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean === 'PEPE' || clean === 'PEPEUSDT') return '1000PEPEUSDT';
  if (clean === 'SHIB' || clean === 'SHIBUSDT') return '1000SHIBUSDT';
  if (clean === 'BONK' || clean === 'BONKUSDT') return '1000BONKUSDT';
  if (clean === 'FLOKI' || clean === 'FLOKIUSDT') return '1000FLOKIUSDT';
  if (clean === 'MOG' || clean === 'MOGUSDT') return '1000000MOGUSDT';
  if (clean.endsWith('USDT')) return clean;
  return `${clean}USDT`;
}

async function fetchKlines(symbol, interval, limit = 2000) {
  const cacheFile = path.resolve(CACHE_DIR, `${symbol}_${interval}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached) && cached.length >= limit) {
        return cached.slice(-limit);
      }
    } catch {}
  }

  const bSym = toBinanceSymbol(symbol);
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${bSym}&interval=${interval}&limit=${Math.min(1500, limit)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = await res.json();
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => ({
      time: Math.floor(Number(c[0]) / 1000),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    })).filter((c) => c.close > 0);
  } catch {
    return [];
  }
}

function calculateEma(candles, period) {
  const k = 2 / (period + 1);
  const emas = new Array(candles.length);
  let sum = 0;
  for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
  let prevEma = sum / Math.min(period, candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      emas[i] = candles[i].close;
    } else if (i === period - 1) {
      emas[i] = prevEma;
    } else {
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

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

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

function getSector(symbol) {
  const norm = symbol.toUpperCase().replace(/_USDT$|_USDC$/i, '');
  if (/^(BTC|ETH)$/i.test(norm)) return 'MAJOR';
  if (/^(SOL|SUI|NEAR|AVAX|ADA|DOT|APT|SEI)$/i.test(norm)) return 'LAYER1';
  if (/^(PEPE|1000PEPE|DOGE|SHIB|BONK|1000BONK|FLOKI|WIF|POPCAT|MOG)$/i.test(norm)) return 'MEME';
  if (/^(FET|RENDER|TAO|WLD|ARKM)$/i.test(norm)) return 'AI';
  if (/^(UNI|AAVE|CRV|PENDLE|CAKE|AERO)$/i.test(norm)) return 'DEFI';
  return 'ALT';
}

function isWeekend(time) {
  const date = new Date(time * 1000);
  const day = date.getUTCDay(); // 0 is Sunday, 6 is Saturday
  const hour = date.getUTCHours();
  if (day === 6) return true; // Saturday
  if (day === 0 && hour < 22) return true; // Sunday until 22:00 UTC
  return false;
}

/**
 * Replay the market under a specific configuration set
 */
function runSimulation({
  marketData,
  timeline,
  startingBalance,
  defaultLeverage,
  config: {
    useSectorCap = false,
    useWeekendFilter = false,
    useDynamicLeverage = false,
    useMinVolatility = false,
  } = {},
}) {
  let currentBalance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdown = 0;
  let winStreak = 0;
  let maxWinStreak = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;

  const openPositions = [];
  const closedTrades = [];
  const symbolStats = {};

  for (const sym of Object.keys(marketData)) {
    symbolStats[sym] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
  }

  for (const time of timeline) {
    // 1. Manage open positions
    for (let pIdx = openPositions.length - 1; pIdx >= 0; pIdx--) {
      const pos = openPositions[pIdx];
      const md = marketData[pos.symbol];
      const candleIdx = md?.timeMap.get(time);
      if (candleIdx === undefined) continue;

      const bar = md.candles[candleIdx];
      const atr = md.atr14[candleIdx] || (bar.close * 0.02);
      const isLong = pos.side === 'LONG';
      const bestPrice = isLong ? bar.high : bar.low;
      const worstPrice = isLong ? bar.low : bar.high;
      const currentLev = pos.leverage;

      // Check Stop Loss
      const slHit = isLong ? worstPrice <= pos.stopLoss : worstPrice >= pos.stopLoss;
      if (slHit) {
        const exitPrice = pos.stopLoss;
        const pnlPct = isLong ? (exitPrice - pos.entry) / pos.entry : (pos.entry - exitPrice) / pos.entry;
        const tranchePnl = pos.remainingMargin * currentLev * pnlPct - (pos.margin * 0.001);

        pos.realizedPnl += tranchePnl;
        currentBalance += pos.remainingMargin + tranchePnl;

        closedTrades.push({
          symbol: pos.symbol,
          side: pos.side,
          entry: pos.entry,
          exit: exitPrice,
          pnl: pos.realizedPnl,
          pnlPct: (pos.realizedPnl / pos.margin) * 100,
          exitReason: pos.realizedPnl > 0 ? 'STOP_IN_PROFIT' : 'STOP_LOSS',
          rMultiple: pos.realizedPnl / (pos.riskAmount || 1),
        });

        if (pos.realizedPnl > 0) {
          winStreak++;
          lossStreak = 0;
          if (winStreak > maxWinStreak) maxWinStreak = winStreak;
        } else {
          lossStreak++;
          winStreak = 0;
          if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
        }

        symbolStats[pos.symbol].trades++;
        if (pos.realizedPnl > 0) symbolStats[pos.symbol].wins++;
        else symbolStats[pos.symbol].losses++;
        symbolStats[pos.symbol].pnl += pos.realizedPnl;

        openPositions.splice(pIdx, 1);
        continue;
      }

      // Check TP1 (Bank 45% + Move stop to +0.35R in profit)
      if (!pos.tp1Hit) {
        const tp1Hit = isLong ? bestPrice >= pos.tp1 : bestPrice <= pos.tp1;
        if (tp1Hit) {
          pos.tp1Hit = true;
          const portion = 0.45;
          const portionMargin = pos.margin * portion;
          const pnlPct = isLong ? (pos.tp1 - pos.entry) / pos.entry : (pos.entry - pos.tp1) / pos.entry;
          const tranchePnl = portionMargin * currentLev * pnlPct;

          currentBalance += portionMargin + tranchePnl;
          pos.realizedPnl += tranchePnl;
          pos.remainingMargin -= portionMargin;

          // Move Stop to +0.35R in profit (locks net green trade)
          pos.stopLoss = isLong ? pos.entry + (pos.rDist * 0.35) : pos.entry - (pos.rDist * 0.35);
        }
      }

      // Check TP2 (Bank 30% + Arm trailing runner)
      if (pos.tp1Hit && !pos.tp2Hit) {
        const tp2Hit = isLong ? bestPrice >= pos.tp2 : bestPrice <= pos.tp2;
        if (tp2Hit) {
          pos.tp2Hit = true;
          const portion = 0.30;
          const portionMargin = pos.margin * portion;
          const pnlPct = isLong ? (pos.tp2 - pos.entry) / pos.entry : (pos.entry - pos.tp2) / pos.entry;
          const tranchePnl = portionMargin * currentLev * pnlPct;

          currentBalance += portionMargin + tranchePnl;
          pos.realizedPnl += tranchePnl;
          pos.remainingMargin -= portionMargin;

          pos.trailingActive = true;
          pos.peakPrice = isLong ? bar.high : bar.low;
        }
      }

      // Trailing Runner (Chandelier ATR Stop with Parabolic Climax tightening)
      if (pos.trailingActive) {
        const currRsi = md.rsi14[candleIdx] || 50;
        const isClimax = currRsi > 80 || (/PEPE|DOGE|BONK/i.test(pos.symbol) && currRsi > 78);
        const atrMult = isClimax ? 0.75 : (/PEPE|DOGE|BONK/i.test(pos.symbol) ? 1.8 : 1.4);
        if (isLong) {
          if (bar.high > pos.peakPrice) pos.peakPrice = bar.high;
          const trailStop = pos.peakPrice - (atr * atrMult);
          if (trailStop > pos.stopLoss) pos.stopLoss = trailStop;
        } else {
          if (bar.low < pos.peakPrice) pos.peakPrice = bar.low;
          const trailStop = pos.peakPrice + (atr * atrMult);
          if (trailStop < pos.stopLoss) pos.stopLoss = trailStop;
        }
      }
    }

    // Update peak equity
    if (currentBalance > peakBalance) peakBalance = currentBalance;
    const currentDd = peakBalance > 0 ? (peakBalance - currentBalance) / peakBalance : 0;
    if (currentDd > maxDrawdown) maxDrawdown = currentDd;

    // 2. Scan for new sniper setups (max 2 positions concurrent)
    if (openPositions.length >= 2 || currentBalance < 15) continue;

    // BTC 24h benchmark return for Relative Strength filtering
    const btcMd = marketData['BTC_USDT'];
    const btcIdx = btcMd?.timeMap.get(time);
    const btc24h = btcIdx && btcIdx >= 24
      ? (btcMd.candles[btcIdx].close - btcMd.candles[btcIdx - 24].close) / btcMd.candles[btcIdx - 24].close
      : 0;

    const weekendNow = isWeekend(time);
    const minConfluenceRequired = (useWeekendFilter && weekendNow) ? 72 : 68;

    const candidates = [];

    for (const [sym, md] of Object.entries(marketData)) {
      if (openPositions.some((p) => p.symbol === sym)) continue;

      // Sector correlation cap: Max 1 position per cluster
      if (useSectorCap) {
        const symSector = getSector(sym);
        const hasSameSector = openPositions.some((p) => getSector(p.symbol) === symSector);
        if (hasSameSector) continue;
      }

      const idx = md.timeMap.get(time);
      if (idx === undefined || idx < 50) continue;

      const bar = md.candles[idx];
      const e21 = md.ema21[idx];
      const e55 = md.ema55[idx];
      const e200 = md.ema200[idx];
      const atr = md.atr14[idx] || (bar.close * 0.02);
      const rsi = md.rsi14[idx] || 50;

      // Rule 1: Clear Trend Alignment & Separation with 4H Macro Trend (EMA200)
      const isLongTrend = e21 > e55 && e21 > md.ema21[idx - 1] && (e21 - e55) / e55 > 0.003 && (!e200 || bar.close > e200);
      const isShortTrend = e21 < e55 && e21 < md.ema21[idx - 1] && (e55 - e21) / e55 > 0.003 && (!e200 || bar.close < e200);
      if (!isLongTrend && !isShortTrend) continue;

      const side = isLongTrend ? 'LONG' : 'SHORT';

      // Rule 1b: Relative Strength (RS vs BTC) Filter
      const coin24h = idx >= 24 ? (bar.close - md.candles[idx - 24].close) / md.candles[idx - 24].close : 0;
      const relativeStrength = coin24h - btc24h;

      if (sym !== 'BTC_USDT') {
        if (side === 'LONG' && relativeStrength < -0.015) continue;
        if (side === 'SHORT' && relativeStrength > 0.015) continue;
      }

      // Rule 2: Volume Confirmation (relative volume >= 1.3x)
      const prevVolSlice = md.candles.slice(Math.max(0, idx - 20), idx);
      const avgVol = prevVolSlice.reduce((a, b) => a + b.volume, 0) / (prevVolSlice.length || 1);
      const volRatio = bar.volume / (avgVol || 1);
      if (volRatio < 1.3) continue;

      // Rule 3: Sniper Reversal Wick Trigger at EMA21
      let wickTrigger = false;
      if (side === 'LONG') {
        const touchedEma = bar.low <= e21 * 1.008 && bar.close > e21;
        const hammerWick = (bar.close - bar.low) > (bar.high - bar.close) * 1.3 && bar.close > bar.open;
        const healthyRsi = rsi >= 45 && rsi <= 68;
        if (touchedEma && hammerWick && healthyRsi) wickTrigger = true;
      } else {
        const touchedEma = bar.high >= e21 * 0.992 && bar.close < e21;
        const shootingStar = (bar.high - bar.close) > (bar.close - bar.low) * 1.3 && bar.close < bar.open;
        const healthyRsi = rsi >= 32 && rsi <= 55;
        if (touchedEma && shootingStar && healthyRsi) wickTrigger = true;
      }

      if (!wickTrigger) continue;

      // Confluence score calculation (68 to 100)
      let score = 70;
      if (volRatio >= 2.0) score += 10;
      if (Math.abs(relativeStrength) >= 0.03) score += 10; // RS Leader bonus
      if (side === 'LONG' && rsi < 55) score += 5;
      if (side === 'SHORT' && rsi > 45) score += 5;

      if (score < minConfluenceRequired) continue;
      if (useMinVolatility && (atr / bar.close) < 0.012) continue; // Skip sleepy low-volatility coins

      candidates.push({
        symbol: sym,
        side,
        bar,
        atr,
        atrPct: atr / bar.close,
        score,
        volRatio,
        relativeStrength,
      });
    }

    if (!candidates.length) continue;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Determine leverage: dynamic vs fixed
    let activeLev = defaultLeverage;
    if (useDynamicLeverage) {
      const isMeme = /PEPE|DOGE|BONK/i.test(best.symbol);
      if (isMeme || best.atrPct >= 0.035) {
        activeLev = 3; // 3x on volatile memes to prevent wicks
      } else if (best.atrPct <= 0.02) {
        activeLev = 6; // 6x on stable majors
      } else {
        activeLev = 4;
      }
    }

    // Position sizing with Anti-Martingale & Loss-streak throttle
    const stakePct = currentBalance <= 250 ? 0.38 : 0.28;
    let streakMult = 1.0;
    if (winStreak >= 2) {
      streakMult = Math.min(1.25, 1.0 + (winStreak - 1) * 0.10);
    } else if (lossStreak === 2) {
      streakMult = 0.65;
    } else if (lossStreak >= 3) {
      streakMult = 0.45;
    }

    const calculatedMargin = currentBalance * stakePct * streakMult;
    const margin = Math.min(currentBalance * 0.45, Math.max(10, calculatedMargin));
    if (margin > currentBalance || margin < 10) continue;

    const entryPrice = best.bar.close;
    const isMeme = /PEPE|DOGE|BONK/i.test(best.symbol);
    const stopMult = useDynamicLeverage && isMeme ? 2.0 : (isMeme ? 1.8 : 1.4);
    const stopDist = Math.max(best.atr * stopMult, entryPrice * 0.01);
    const stopLoss = best.side === 'LONG' ? entryPrice - stopDist : entryPrice + stopDist;
    const rDist = Math.abs(entryPrice - stopLoss);

    const tp1 = best.side === 'LONG' ? entryPrice + (rDist * 1.5) : entryPrice - (rDist * 1.5);
    const tp2 = best.side === 'LONG' ? entryPrice + (rDist * 3.0) : entryPrice - (rDist * 3.0);
    const tp3 = best.side === 'LONG' ? entryPrice + (rDist * 8.0) : entryPrice - (rDist * 8.0);

    currentBalance -= margin;

    openPositions.push({
      symbol: best.symbol,
      side: best.side,
      entry: entryPrice,
      margin,
      remainingMargin: margin,
      riskAmount: (rDist / entryPrice) * margin * activeLev,
      stopLoss,
      initialStop: stopLoss,
      rDist,
      tp1,
      tp2,
      tp3,
      tp1Hit: false,
      tp2Hit: false,
      trailingActive: false,
      peakPrice: entryPrice,
      realizedPnl: 0,
      leverage: activeLev,
    });
  }

  // Settle any remaining open positions at simulation end
  for (const pos of openPositions) {
    const md = marketData[pos.symbol];
    const lastBar = md.candles[md.candles.length - 1];
    const isLong = pos.side === 'LONG';
    const exitPrice = lastBar.close;
    const pnlPct = isLong ? (exitPrice - pos.entry) / pos.entry : (pos.entry - exitPrice) / pos.entry;
    const tranchePnl = pos.remainingMargin * pos.leverage * pnlPct;
    pos.realizedPnl += tranchePnl;
    currentBalance += pos.remainingMargin + tranchePnl;

    closedTrades.push({
      symbol: pos.symbol,
      side: pos.side,
      entry: pos.entry,
      exit: exitPrice,
      pnl: pos.realizedPnl,
      pnlPct: (pos.realizedPnl / pos.margin) * 100,
      exitReason: 'SIMULATION_END',
      rMultiple: pos.realizedPnl / (pos.riskAmount || 1),
    });

    symbolStats[pos.symbol].trades++;
    if (pos.realizedPnl > 0) symbolStats[pos.symbol].wins++;
    else symbolStats[pos.symbol].losses++;
    symbolStats[pos.symbol].pnl += pos.realizedPnl;
  }

  const grossProfit = closedTrades.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
  const grossLoss = Math.abs(closedTrades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const total = closedTrades.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  return {
    finalBalance: currentBalance,
    roiPct: ((currentBalance - startingBalance) / startingBalance) * 100,
    netProfit: currentBalance - startingBalance,
    totalTrades: total,
    wins,
    losses: total - wins,
    winRate,
    profitFactor,
    maxDrawdown: maxDrawdown * 100,
    maxWinStreak,
    maxLossStreak,
    symbolStats,
  };
}

async function main() {
  const { symbols, limit, startingBalance, leverage } = parseArgs();

  console.log(`\n========================================================================`);
  console.log(`🔬 TRADERR IMPROVEMENT MATRIX BACKTESTER`);
  console.log(`========================================================================`);
  console.log(`Universum       : ${symbols.join(', ')}`);
  console.log(`Bars per coin   : ${limit} (~${Math.round(limit / 24)} dagen)`);
  console.log(`Startkapitaal   : $${startingBalance.toFixed(2)}`);
  console.log(`========================================================================\n`);

  const marketData = {};
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    process.stdout.write(`[${i + 1}/${symbols.length}] Ophalen data voor ${sym}... `);
    const candles = await fetchKlines(sym, '1h', limit);
    if (candles.length < 210) {
      console.log(`⚠️ Te weinig data (${candles.length} bars), overgeslagen.`);
      continue;
    }
    const ema21 = calculateEma(candles, 21);
    const ema55 = calculateEma(candles, 55);
    const ema200 = calculateEma(candles, 200);
    const atr14 = calculateAtr(candles, 14);
    const rsi14 = calculateRsi(candles, 14);

    marketData[sym] = {
      symbol: sym,
      candles,
      ema21,
      ema55,
      ema200,
      atr14,
      rsi14,
      timeMap: new Map(candles.map((c, idx) => [c.time, idx])),
    };
    console.log(`✓ ${candles.length} bars geladen.`);
  }

  const firstSym = marketData['BTC_USDT'] ? 'BTC_USDT' : Object.keys(marketData)[0];
  const btcTimes = marketData[firstSym]?.candles.map((c) => c.time) || [];
  const timeline = btcTimes.slice(200);

  console.log(`\nSimulatie starten over ${timeline.length} uren (${(timeline.length / 24).toFixed(0)} dagen)...`);

  const tests = [
    {
      name: '1. Baseline Sniper (Huidig)',
      config: { useSectorCap: false, useWeekendFilter: false, useDynamicLeverage: false },
    },
    {
      name: '2. + Sector Correlation Cap',
      config: { useSectorCap: true, useWeekendFilter: false, useDynamicLeverage: false },
    },
    {
      name: '3. + Weekend-Chop Filter',
      config: { useSectorCap: false, useWeekendFilter: true, useDynamicLeverage: false },
    },
    {
      name: '4. + ATR-Normalized Dynamic Leverage',
      config: { useSectorCap: false, useWeekendFilter: false, useDynamicLeverage: true },
    },
    {
      name: '5. + Min Volatility (ATR >= 1.8%)',
      config: { useSectorCap: false, useWeekendFilter: false, useDynamicLeverage: false, useMinVolatility: true },
    },
    {
      name: '6. + Sector Cap + Min Volatility',
      config: { useSectorCap: true, useWeekendFilter: false, useDynamicLeverage: false, useMinVolatility: true },
    },
    {
      name: '7. 🚀 ALLE VERBETERINGEN GECOMBINEERD',
      config: { useSectorCap: true, useWeekendFilter: true, useDynamicLeverage: true, useMinVolatility: true },
    },
  ];

  const results = [];
  for (const test of tests) {
    const res = runSimulation({
      marketData,
      timeline,
      startingBalance,
      defaultLeverage: leverage,
      config: test.config,
    });
    results.push({ name: test.name, ...res });
  }

  console.log(`\n========================================================================================================`);
  console.log(`📊 RESULTATEN VERGELIJKING (MATRIX)`);
  console.log(`========================================================================================================`);
  console.log(
    `Strategie Variant`.padEnd(38) +
    `Eindsaldo`.padEnd(14) +
    `ROI`.padEnd(12) +
    `ProfitFactor`.padEnd(14) +
    `WinRate`.padEnd(10) +
    `Trades`.padEnd(10) +
    `Max DD`
  );
  console.log(`--------------------------------------------------------------------------------------------------------`);

  for (const r of results) {
    const balanceStr = `$${r.finalBalance.toFixed(2)}`;
    const roiStr = `${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`;
    const pfStr = r.profitFactor.toFixed(2);
    const wrStr = `${r.winRate.toFixed(1)}%`;
    const tradesStr = `${r.totalTrades} (${r.wins}W/${r.losses}L)`;
    const ddStr = `${r.maxDrawdown.toFixed(1)}%`;

    console.log(
      r.name.padEnd(38) +
      balanceStr.padEnd(14) +
      roiStr.padEnd(12) +
      pfStr.padEnd(14) +
      wrStr.padEnd(10) +
      tradesStr.padEnd(10) +
      ddStr
    );
  }
  console.log(`========================================================================================================\n`);

  // Detailed breakdown of the best performing variant
  const bestVariant = [...results].sort((a, b) => b.finalBalance - a.finalBalance)[0];
  console.log(`🏆 BESTE STRATEGIE: ${bestVariant.name}`);
  console.log(`   Eindsaldo: $${bestVariant.finalBalance.toFixed(2)} (${bestVariant.roiPct >= 0 ? '+' : ''}${bestVariant.roiPct.toFixed(1)}% ROI)`);
  console.log(`   Profit Factor: ${bestVariant.profitFactor.toFixed(2)} | Win Rate: ${bestVariant.winRate.toFixed(1)}% | Max DD: ${bestVariant.maxDrawdown.toFixed(1)}%`);
  console.log(`\n🪙 Performance per munt voor '${bestVariant.name}':`);
  for (const [sym, stats] of Object.entries(bestVariant.symbolStats)) {
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(0) : '0';
    const pnlSign = stats.pnl >= 0 ? '+' : '';
    console.log(`   - ${sym.padEnd(12)} : ${stats.trades} trades | WR: ${wr}% | PnL: ${pnlSign}$${stats.pnl.toFixed(2)}`);
  }
}

main().catch(console.error);
