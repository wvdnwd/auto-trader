#!/usr/bin/env node
/**
 * Traderr Strategy Portfolio Backtester (Runs on PC)
 *
 * Simulates the full autonomous trading strategy on historical market data.
 * Tests Auto-Compounding, Dynamic Runners (Chandelier ATR), Multi-TP Ladder,
 * and Anti-Martingale Win Streak Scaling with real balance growth.
 *
 * Usage:
 *   node scripts/run-backtest.mjs
 *   node scripts/run-backtest.mjs --symbols BTC,ETH,SOL,DOGE,PEPE --bars 1000 --balance 100
 */

import fs from 'node:fs';

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
  let limit = 750;
  let startingBalance = 100;
  let leverage = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => (s.includes('_') ? s.toUpperCase() : `${s.toUpperCase()}_USDT`));
      i++;
    } else if (args[i] === '--bars' && args[i + 1]) {
      limit = Math.min(1500, Math.max(100, Number(args[i + 1]) || 750));
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
  if (clean.startsWith('1000PEPE')) return '1000PEPEUSDT';
  if (clean === 'PEPEUSDT') return '1000PEPEUSDT';
  if (clean.endsWith('USDT')) return clean;
  return `${clean}USDT`;
}

async function fetchKlines(symbol, interval, limit = 500) {
  const bSym = toBinanceSymbol(symbol);
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${bSym}&interval=${interval}&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const bybitInterval = interval === '15m' ? '15' : interval === '1h' ? '60' : '240';
      const bRes = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${bSym}&interval=${bybitInterval}&limit=${limit}`);
      if (!bRes.ok) return [];
      const json = await bRes.json();
      const list = json?.result?.list || [];
      return list.map((c) => ({
        time: Math.floor(Number(c[0]) / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      })).sort((a, b) => a.time - b.time);
    }
    const raw = await res.json();
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => ({
      time: Math.floor(Number(c[0]) / 1000),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    })).sort((a, b) => a.time - b.time);
  } catch {
    return [];
  }
}

function calculateEma(candles, period) {
  const k = 2 / (period + 1);
  const ema = new Array(candles.length);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  ema[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calculateAtr(candles, period = 14) {
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
      continue;
    }
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }
  const atr = new Array(candles.length);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function calculateRsi(candles, period = 14) {
  const rsi = new Array(candles.length).fill(50);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

async function runStrategyBacktest() {
  const { symbols, limit, startingBalance, leverage } = parseArgs();

  console.log('\n' + '='.repeat(72));
  console.log('📈 TRADERR FULL STRATEGY SIMULATOR & PORTFOLIO BACKTESTER');
  console.log('='.repeat(72));
  console.log(`Startkapitaal   : $${startingBalance.toFixed(2)}`);
  console.log(`Hefboom         : ${leverage}x`);
  console.log(`Markten         : ${symbols.join(', ')}`);
  console.log(`Candles per coin: ${limit} bars (~${Math.round(limit / 24)} dagen geschiedenis)\n`);

  let currentBalance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdown = 0;
  let winStreak = 0;
  let maxWinStreak = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;

  const closedTrades = [];
  const symbolStats = {};

  for (const sym of symbols) {
    symbolStats[sym] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
  }

  for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
    const symbol = symbols[sIdx];
    process.stdout.write(`[${sIdx + 1}/${symbols.length}] Candles ophalen & replayen voor ${symbol}... `);

    const c1h = await fetchKlines(symbol, '1h', limit);
    if (!c1h.length || c1h.length < 60) {
      console.log('⚠️ Te weinig data.');
      continue;
    }

    const ema21 = calculateEma(c1h, 21);
    const ema55 = calculateEma(c1h, 55);
    const atr14 = calculateAtr(c1h, 14);
    const rsi14 = calculateRsi(c1h, 14);

    const isMeme = /PEPE|DOGE|SHIB|BONK|FLOKI|WIF|POPCAT/i.test(symbol);
    const isAi = /NEAR|RENDER|FET|TAO/i.test(symbol);
    const hasRunner = isMeme || isAi;

    let inTrade = null;
    let localTrades = 0;

    for (let i = 55; i < c1h.length; i++) {
      const bar = c1h[i];
      const prev = c1h[i - 1];
      const e21 = ema21[i];
      const e55 = ema55[i];
      const atr = atr14[i] || (bar.close * 0.02);
      const rsi = rsi14[i] || 50;

      // 1. Manage open trade
      if (inTrade) {
        const isLong = inTrade.side === 'LONG';
        const bestPrice = isLong ? bar.high : bar.low;
        const worstPrice = isLong ? bar.low : bar.high;

        // Check Stop Loss
        const slHit = isLong ? worstPrice <= inTrade.stopLoss : worstPrice >= inTrade.stopLoss;
        if (slHit) {
          const exitPrice = inTrade.stopLoss;
          const pnlPct = isLong ? (exitPrice - inTrade.entry) / inTrade.entry : (inTrade.entry - exitPrice) / inTrade.entry;
          const dollarPnl = inTrade.remainingMargin * leverage * pnlPct - (inTrade.margin * 0.001);

          currentBalance += inTrade.remainingMargin + dollarPnl;
          inTrade.realizedPnl += dollarPnl;

          closedTrades.push({
            symbol,
            side: inTrade.side,
            entry: inTrade.entry,
            exit: exitPrice,
            pnl: inTrade.realizedPnl,
            pnlPct: (inTrade.realizedPnl / inTrade.margin) * 100,
            exitReason: inTrade.realizedPnl > 0 ? 'STOP_IN_PROFIT' : 'STOP_LOSS',
            barsHeld: i - inTrade.entryBar,
          });

          if (inTrade.realizedPnl > 0) {
            winStreak++;
            lossStreak = 0;
            if (winStreak > maxWinStreak) maxWinStreak = winStreak;
          } else {
            lossStreak++;
            winStreak = 0;
            if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
          }

          symbolStats[symbol].trades++;
          if (inTrade.realizedPnl > 0) symbolStats[symbol].wins++;
          else symbolStats[symbol].losses++;
          symbolStats[symbol].pnl += inTrade.realizedPnl;

          inTrade = null;
          localTrades++;
          continue;
        }

        // Check TP1 (40% tranche)
        if (!inTrade.tp1Hit) {
          const tp1Hit = isLong ? bestPrice >= inTrade.tp1 : bestPrice <= inTrade.tp1;
          if (tp1Hit) {
            inTrade.tp1Hit = true;
            const portion = hasRunner ? 0.40 : 0.50;
            const portionMargin = inTrade.margin * portion;
            const pnlPct = isLong ? (inTrade.tp1 - inTrade.entry) / inTrade.entry : (inTrade.entry - inTrade.tp1) / inTrade.entry;
            const tranchePnl = portionMargin * leverage * pnlPct;

            currentBalance += portionMargin + tranchePnl;
            inTrade.realizedPnl += tranchePnl;
            inTrade.remainingMargin -= portionMargin;

            // Move SL to break-even + fee buffer
            inTrade.stopLoss = isLong ? inTrade.entry * 1.002 : inTrade.entry * 0.998;
          }
        }

        // Check TP2 (35% tranche)
        if (inTrade && inTrade.tp1Hit && !inTrade.tp2Hit) {
          const tp2Hit = isLong ? bestPrice >= inTrade.tp2 : bestPrice <= inTrade.tp2;
          if (tp2Hit) {
            inTrade.tp2Hit = true;
            const portion = hasRunner ? 0.35 : 0.50;
            const portionMargin = inTrade.margin * portion;
            const pnlPct = isLong ? (inTrade.tp2 - inTrade.entry) / inTrade.entry : (inTrade.entry - inTrade.tp2) / inTrade.entry;
            const tranchePnl = portionMargin * leverage * pnlPct;

            currentBalance += portionMargin + tranchePnl;
            inTrade.realizedPnl += tranchePnl;
            inTrade.remainingMargin -= portionMargin;

            // Activate Chandelier trailing stop for the remaining runner
            inTrade.trailingActive = true;
            inTrade.peakPrice = bar.close;
          }
        }

        // Runner Chandelier ATR Trailing Stop
        if (inTrade && inTrade.trailingActive) {
          if (isLong) {
            if (bar.high > inTrade.peakPrice) inTrade.peakPrice = bar.high;
            const chandelierStop = inTrade.peakPrice - (atr * (isMeme ? 1.8 : 1.5));
            if (chandelierStop > inTrade.stopLoss) inTrade.stopLoss = chandelierStop;
          } else {
            if (bar.low < inTrade.peakPrice) inTrade.peakPrice = bar.low;
            const chandelierStop = inTrade.peakPrice + (atr * (isMeme ? 1.8 : 1.5));
            if (chandelierStop < inTrade.stopLoss) inTrade.stopLoss = chandelierStop;
          }
        }

        // Update peak & drawdown
        if (currentBalance > peakBalance) peakBalance = currentBalance;
        const dd = peakBalance > 0 ? (peakBalance - currentBalance) / peakBalance : 0;
        if (dd > maxDrawdown) maxDrawdown = dd;
        continue;
      }

      // 2. Candidate Scan & Entry Signal
      const isLongTrend = e21 > e55 && bar.close > e21 && prev.close <= e21 * 1.01;
      const isShortTrend = e21 < e55 && bar.close < e21 && prev.close >= e21 * 0.99;
      if (!isLongTrend && !isShortTrend) continue;

      const side = isLongTrend ? 'LONG' : 'SHORT';

      // Anti-Martingale & Compounding stake
      const stakePct = currentBalance <= 250 ? 0.42 : currentBalance <= 500 ? 0.35 : 0.25;
      const streakBoost = winStreak >= 2 ? 1.0 + Math.min(0.25, (winStreak - 1) * 0.10) : 1.0;
      const margin = Math.min(currentBalance * 0.5, currentBalance * stakePct * streakBoost);

      if (margin < 10) continue; // Min trade size

      const stopDist = atr * (isMeme ? 1.8 : 1.5);
      const stopLoss = side === 'LONG' ? bar.close - stopDist : bar.close + stopDist;
      const rDist = Math.abs(bar.close - stopLoss);

      const tp1 = side === 'LONG' ? bar.close + (rDist * 1.8) : bar.close - (rDist * 1.8);
      const tp2 = side === 'LONG' ? bar.close + (rDist * 3.5) : bar.close - (rDist * 3.5);
      const tp3 = side === 'LONG' ? bar.close + (rDist * 10.0) : bar.close - (rDist * 10.0);

      currentBalance -= margin; // allocate margin

      inTrade = {
        symbol,
        side,
        entry: bar.close,
        margin,
        remainingMargin: margin,
        stopLoss,
        tp1,
        tp2,
        tp3,
        tp1Hit: false,
        tp2Hit: false,
        trailingActive: false,
        peakPrice: bar.close,
        realizedPnl: 0,
        entryBar: i,
      };
    }

    console.log(`✓ ${localTrades} trades gesimuleerd.`);
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
  console.log('📊 BACKTEST RESULTATEN & PORTFOLIO PERFORMANCE');
  console.log('='.repeat(72));
  console.log(`Startsaldo         : $${startingBalance.toFixed(2)}`);
  console.log(`Eindsaldo          : $${endBalance.toFixed(2)}  (${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI)`);
  console.log(`Totale Winst/Verlies: $${totalDollarPnl >= 0 ? '+' : ''}${totalDollarPnl.toFixed(2)}`);
  console.log(`Aantal Trades      : ${totalTrades} (${wins} Wins / ${losses} Losses)`);
  console.log(`Win Rate           : ${winRate.toFixed(1)}%`);
  console.log(`Profit Factor      : ${profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown       : ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Max Win Streak     : ${maxWinStreak} op een rij`);
  console.log(`Max Loss Streak    : ${maxLossStreak} op een rij`);

  console.log('\n🪙 PERFORMANCE PER MUNT:');
  for (const [sym, st] of Object.entries(symbolStats)) {
    if (st.trades === 0) continue;
    const symWr = (st.wins / st.trades) * 100;
    const pnlSign = st.pnl >= 0 ? '+' : '';
    console.log(`  - ${sym.padEnd(12)} : ${st.trades.toString().padStart(2)} trades | WR: ${symWr.toFixed(0)}% | PnL: ${pnlSign}$${st.pnl.toFixed(2)}`);
  }

  console.log('\n🎯 RECENTE TRADES (LAATSTE 8):');
  const recent = closedTrades.slice(-8);
  for (const t of recent) {
    const sign = t.pnl >= 0 ? '+' : '';
    console.log(`  ${t.symbol.padEnd(10)} ${t.side.padEnd(5)} | Entry: ${t.entry.toFixed(4)} -> Exit: ${t.exit.toFixed(4)} | PnL: ${sign}$${t.pnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%) [${t.exitReason}]`);
  }
  console.log('='.repeat(72) + '\n');
}

runStrategyBacktest().catch((err) => {
  console.error('Fatal backtest error:', err);
  process.exit(1);
});
