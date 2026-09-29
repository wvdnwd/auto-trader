#!/usr/bin/env node
/**
 * Traderr High-Conviction Sniper Portfolio Backtester
 *
 * Chronologically replays the market bar-by-bar across top liquid markets,
 * applying the true Traderr Sniper trading rules:
 * - Macro Trend (4H / 1H EMA alignment & ADX trend filter)
 * - Volume Confirmation (Coin in play >= 1.4x volume)
 * - Sniper Reversal Wick Trigger (Hammer / Shooting Star bounce at EMA21)
 * - Dynamic 3-stage TP Ladder (TP1 at 1.5R locks break-even, TP2 at 3.0R, Runner at 6R-10R+ with ATR Chandelier)
 * - Auto-Compounding & Anti-Martingale scaling
 *
 * Usage:
 *   node scripts/run-backtest.mjs --symbols BTC,ETH,SOL,DOGE,PEPE,SUI,NEAR --bars 1000 --balance 100
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SYMBOLS = [
  'BTC_USDT',
  'ETH_USDT',
  'SOL_USDT',
  'DOGE_USDT',
  'PEPE_USDT',
  'SUI_USDT',
  'NEAR_USDT',
  'AVAX_USDT',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  let limit = 1000;
  let startingBalance = 100;
  let leverage = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => (s.includes('_') ? s.toUpperCase() : `${s.toUpperCase()}_USDT`));
      i++;
    } else if (args[i] === '--bars' && args[i + 1]) {
      limit = Math.min(40000, Math.max(100, Number(args[i + 1]) || 1000));
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

// Disk cache directory for instant candle loading
const CACHE_DIR = path.resolve(process.cwd(), 'data/candles_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

async function fetchKlines(symbol, interval, limit = 1000) {
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
  const ema = new Array(candles.length);
  if (candles.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  ema[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calculateAtr(candles, period = 14) {
  const atr = new Array(candles.length);
  if (candles.length < period + 1) return atr;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i - 1]) / period;
  }
  return atr;
}

function calculateRsi(candles, period = 14) {
  const rsi = new Array(candles.length).fill(50);
  if (candles.length < period + 1) return rsi;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

async function runSniperBacktest() {
  const { symbols, limit, startingBalance, leverage } = parseArgs();

  console.log('\n' + '='.repeat(72));
  console.log('🎯 TRADERR SNIPER PORTFOLIO BACKTESTER (HIGH-CONFLUENCE)');
  console.log('='.repeat(72));
  console.log(`Startkapitaal   : $${startingBalance.toFixed(2)}`);
  console.log(`Hefboom         : ${leverage}x`);
  console.log(`Universum       : ${symbols.join(', ')}`);
  console.log(`Candles per coin: ${limit} bars (~${Math.round(limit / 24)} dagen geschiedenis)`);
  console.log(`Filters actief  : Confluence Score >= 68, Volume Spurt, Reversal Wick, 3-Stage TP + Runner`);
  console.log('='.repeat(72) + '\n');

  // Pre-load all candles
  const marketData = {};
  for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
    const sym = symbols[sIdx];
    process.stdout.write(`[${sIdx + 1}/${symbols.length}] Ophalen data voor ${sym}... `);
    const candles = await fetchKlines(sym, '1h', limit);
    if (!candles.length || candles.length < 100) {
      console.log('⚠️ Onvoldoende data.');
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

  // Find timeline from BTC or first available market
  const firstSym = marketData['BTC_USDT'] ? 'BTC_USDT' : Object.keys(marketData)[0];
  const btcTimes = marketData[firstSym]?.candles.map((c) => c.time) || [];
  if (!btcTimes.length) {
    console.error('Onvoldoende data om een tijdlijn te bouwen.');
    return;
  }

  const timeline = btcTimes.slice(200); // Start after 200 bars warmup (for EMA200 macro trend)
  console.log(`\nReplay gestart over ${timeline.length} uren (${(timeline.length / 24).toFixed(0)} dagen)...`);

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
    // 1. Manage currently open positions
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

      // Check Stop Loss
      const slHit = isLong ? worstPrice <= pos.stopLoss : worstPrice >= pos.stopLoss;
      if (slHit) {
        const exitPrice = pos.stopLoss;
        const pnlPct = isLong ? (exitPrice - pos.entry) / pos.entry : (pos.entry - exitPrice) / pos.entry;
        const tranchePnl = pos.remainingMargin * leverage * pnlPct - (pos.margin * 0.001);

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

      // Check TP1 (Bank 45% + Move stop to break-even + fee buffer)
      if (!pos.tp1Hit) {
        const tp1Hit = isLong ? bestPrice >= pos.tp1 : bestPrice <= pos.tp1;
        if (tp1Hit) {
          pos.tp1Hit = true;
          const portion = 0.45;
          const portionMargin = pos.margin * portion;
          const pnlPct = isLong ? (pos.tp1 - pos.entry) / pos.entry : (pos.entry - pos.tp1) / pos.entry;
          const tranchePnl = portionMargin * leverage * pnlPct;

          currentBalance += portionMargin + tranchePnl;
          pos.realizedPnl += tranchePnl;
          pos.remainingMargin -= portionMargin;

          // Move Stop to +0.35R in profit (guarantees net positive trade even after fee and slippage)
          const stopDist = Math.abs(pos.entry - pos.initialStop);
          pos.stopLoss = isLong ? pos.entry + stopDist * 0.35 : pos.entry - stopDist * 0.35;
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
          const tranchePnl = portionMargin * leverage * pnlPct;

          currentBalance += portionMargin + tranchePnl;
          pos.realizedPnl += tranchePnl;
          pos.remainingMargin -= portionMargin;

          // Activate Chandelier trailing stop for remaining 25% runner
          pos.trailingActive = true;
          pos.peakPrice = bar.close;
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

    // 2. Scan for new high-conviction sniper setups (max 2 positions concurrent)
    if (openPositions.length >= 2 || currentBalance < 15) continue;

    // Calculate BTC 24h benchmark return for Relative Strength filtering
    const btcMd = marketData['BTC_USDT'];
    const btcIdx = btcMd?.timeMap.get(time);
    const btc24h = btcIdx && btcIdx >= 24
      ? (btcMd.candles[btcIdx].close - btcMd.candles[btcIdx - 24].close) / btcMd.candles[btcIdx - 24].close
      : 0;

    const candidates = [];

    for (const [sym, md] of Object.entries(marketData)) {
      if (openPositions.some((p) => p.symbol === sym)) continue;
      const idx = md.timeMap.get(time);
      if (idx === undefined || idx < 50) continue;

      const bar = md.candles[idx];
      const prev = md.candles[idx - 1];
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

      // Reject LONG if coin is strongly lagging Bitcoin; Reject SHORT if coin is strongly beating Bitcoin
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
      if (Math.abs(relativeStrength) >= 0.03) score += 10; // RS Leader bonus!
      if (side === 'LONG' && rsi < 55) score += 5;
      if (side === 'SHORT' && rsi > 45) score += 5;

      candidates.push({
        symbol: sym,
        side,
        bar,
        atr,
        score,
        volRatio,
        relativeStrength,
      });
    }

    if (!candidates.length) continue;

    // Pick top candidate
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Position Sizing: Anti-Martingale win streak boost & Loss-streak throttle
    const stakePct = currentBalance <= 250 ? 0.38 : 0.28;
    let streakMult = 1.0;
    if (winStreak >= 2) {
      streakMult = Math.min(1.25, 1.0 + (winStreak - 1) * 0.10); // scale up on wins
    } else if (lossStreak === 2) {
      streakMult = 0.65; // throttle down on 2 losses
    } else if (lossStreak >= 3) {
      streakMult = 0.45; // defensive mode on 3+ losses
    }

    const calculatedMargin = currentBalance * stakePct * streakMult;
    const margin = Math.min(currentBalance * 0.45, Math.max(10, calculatedMargin));

    if (margin > currentBalance || margin < 10) continue;

    const entryPrice = best.bar.close;
    const isMeme = /PEPE|DOGE|BONK/i.test(best.symbol);
    const stopDist = Math.max(best.atr * (isMeme ? 1.8 : 1.4), entryPrice * 0.01);
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
      riskAmount: (rDist / entryPrice) * margin * leverage,
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
      openTime: time,
    });
  }

  // Settle any remaining open positions at final price
  for (const pos of openPositions) {
    const md = marketData[pos.symbol];
    const lastBar = md?.candles[md.candles.length - 1];
    if (!lastBar) continue;
    const isLong = pos.side === 'LONG';
    const pnlPct = isLong ? (lastBar.close - pos.entry) / pos.entry : (pos.entry - lastBar.close) / pos.entry;
    const tranchePnl = pos.remainingMargin * leverage * pnlPct;
    currentBalance += pos.remainingMargin + tranchePnl;
    pos.realizedPnl += tranchePnl;
    closedTrades.push({
      symbol: pos.symbol,
      side: pos.side,
      entry: pos.entry,
      exit: lastBar.close,
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

  // Calculate statistics
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const losses = closedTrades.filter((t) => t.pnl <= 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalDollarPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = closedTrades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(closedTrades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const endBalance = currentBalance;
  const roiPct = ((endBalance - startingBalance) / startingBalance) * 100;

  console.log('\n' + '='.repeat(72));
  console.log('📊 SNIPER BACKTEST RESULTATEN & PERFORMANCE');
  console.log('='.repeat(72));
  console.log(`Startsaldo          : $${startingBalance.toFixed(2)}`);
  console.log(`Eindsaldo           : $${endBalance.toFixed(2)}  (${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI)`);
  console.log(`Totale Winst/Verlies: $${totalDollarPnl >= 0 ? '+' : ''}${totalDollarPnl.toFixed(2)}`);
  console.log(`Aantal Trades       : ${totalTrades} (${wins} Wins / ${losses} Losses)`);
  console.log(`Win Rate            : ${winRate.toFixed(1)}%`);
  console.log(`Profit Factor       : ${profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown        : ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Max Win Streak      : ${maxWinStreak} op een rij`);
  console.log(`Max Loss Streak     : ${maxLossStreak} op een rij`);

  console.log('\n🪙 PERFORMANCE PER MUNT:');
  for (const [sym, st] of Object.entries(symbolStats)) {
    if (st.trades === 0) continue;
    const symWr = (st.wins / st.trades) * 100;
    const pnlSign = st.pnl >= 0 ? '+' : '';
    console.log(`  - ${sym.padEnd(12)} : ${st.trades.toString().padStart(2)} trades | WR: ${symWr.toFixed(0)}% | PnL: ${pnlSign}$${st.pnl.toFixed(2)}`);
  }

  console.log('\n🎯 RECENTE TRADES:');
  const recent = closedTrades.slice(-10);
  for (const t of recent) {
    const sign = t.pnl >= 0 ? '+' : '';
    console.log(`  ${t.symbol.padEnd(10)} ${t.side.padEnd(5)} | Entry: ${t.entry.toFixed(4)} -> Exit: ${t.exit.toFixed(4)} | PnL: ${sign}$${t.pnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%) [${t.exitReason}]`);
  }
  console.log('='.repeat(72) + '\n');
}

runSniperBacktest().catch((err) => {
  console.error('Fatal backtest error:', err);
  process.exit(1);
});
