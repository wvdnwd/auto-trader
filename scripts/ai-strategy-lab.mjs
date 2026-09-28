#!/usr/bin/env node
/**
 * Traderr Creative AI Quant Lab (Wild Archetype Explorator)
 *
 * Runs on your local RTX 5070 Ti via Ollama.
 * Explores totally unique, unorthodox trading archetypes:
 * - Trend Breakouts
 * - Mean Reversion / Dip Buying
 * - Volatility Squeezes
 * - Liquidity Sweeps & Wick Reversals
 * - Parabolic Blow-Off Counter-Trading
 *
 * Usage:
 *   node scripts/ai-strategy-lab.mjs --model qwen2.5-coder:7b-instruct-q5_K_M --iterations 50
 */

import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve(process.cwd(), 'data/candles_cache');
const LEADERBOARD_FILE = path.resolve(process.cwd(), 'data/ai_strategy_leaderboard.json');

const DEFAULT_SYMBOLS = ['NEAR_USDT', 'PEPE_USDT', 'SUI_USDT', 'SOL_USDT', 'BTC_USDT'];

function parseArgs() {
  const args = process.argv.slice(2);
  let model = 'qwen2.5-coder:7b-instruct-q5_K_M';
  let iterations = 30;
  let symbols = DEFAULT_SYMBOLS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (args[i] === '--iterations' && args[i + 1]) {
      iterations = Number(args[i + 1]) || 30;
      i++;
    } else if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => (s.includes('_') ? s.toUpperCase() : `${s.toUpperCase()}_USDT`));
      i++;
    }
  }
  return { model, iterations, symbols };
}

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

function runBacktest(strategy, marketData, timeline, startingBalance = 100, leverage = 5) {
  let currentBalance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdown = 0;
  let winStreak = 0;
  let lossStreak = 0;

  const openPositions = [];
  const closedTrades = [];

  const {
    archetype = 'TREND_SNIPER',
    fastEma = 21,
    slowEma = 55,
    useMacroEma = true,
    minVolRatio = 1.3,
    minRsi = 45,
    maxRsi = 68,
    minAtrPct = 0.012,
    onlyLong = false,
    tp1R = 1.1,
    tp1Portion = 0.65,
    tp2R = 2.5,
    tp2Portion = 0.20,
    lockProfitR = 0.35,
    stopAtrMultiple = 1.5,
  } = strategy;

  const customEmaFast = {};
  const customEmaSlow = {};
  for (const [sym, md] of Object.entries(marketData)) {
    customEmaFast[sym] = calculateEma(md.candles, fastEma);
    customEmaSlow[sym] = calculateEma(md.candles, slowEma);
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

      // Stop loss
      const slHit = isLong ? worstPrice <= pos.stopLoss : worstPrice >= pos.stopLoss;
      if (slHit) {
        const exitPrice = pos.stopLoss;
        const pnlPct = isLong ? (exitPrice - pos.entry) / pos.entry : (pos.entry - exitPrice) / pos.entry;
        const tranchePnl = pos.remainingMargin * leverage * pnlPct - (pos.margin * 0.001);

        pos.realizedPnl += tranchePnl;
        currentBalance += pos.remainingMargin + tranchePnl;

        closedTrades.push({ symbol: pos.symbol, pnl: pos.realizedPnl });

        if (pos.realizedPnl > 0) {
          winStreak++;
          lossStreak = 0;
        } else {
          lossStreak++;
          winStreak = 0;
        }

        openPositions.splice(pIdx, 1);
        continue;
      }

      // TP1 hit
      if (!pos.tp1Hit) {
        const tp1Hit = isLong ? bestPrice >= pos.tp1 : bestPrice <= pos.tp1;
        if (tp1Hit) {
          pos.tp1Hit = true;
          const portionMargin = pos.margin * tp1Portion;
          const pnlPct = isLong ? (pos.tp1 - pos.entry) / pos.entry : (pos.entry - pos.tp1) / pos.entry;
          const tranchePnl = portionMargin * leverage * pnlPct;

          currentBalance += portionMargin + tranchePnl;
          pos.realizedPnl += tranchePnl;
          pos.remainingMargin -= portionMargin;

          // Lock profit
          pos.stopLoss = isLong ? pos.entry + (pos.rDist * lockProfitR) : pos.entry - (pos.rDist * lockProfitR);
        }
      }

      // TP2 hit
      if (pos.tp1Hit && !pos.tp2Hit) {
        const tp2Hit = isLong ? bestPrice >= pos.tp2 : bestPrice <= pos.tp2;
        if (tp2Hit) {
          pos.tp2Hit = true;
          const portionMargin = pos.margin * tp2Portion;
          const pnlPct = isLong ? (pos.tp2 - pos.entry) / pos.entry : (pos.entry - pos.tp2) / pos.entry;
          const tranchePnl = portionMargin * leverage * pnlPct;

          currentBalance += portionMargin + tranchePnl;
          pos.realizedPnl += tranchePnl;
          pos.remainingMargin -= portionMargin;
          pos.trailingActive = true;
          pos.peakPrice = isLong ? bar.high : bar.low;
        }
      }

      // Trailing runner
      if (pos.trailingActive) {
        if (isLong) {
          if (bar.high > pos.peakPrice) pos.peakPrice = bar.high;
          const trail = pos.peakPrice - (atr * 1.5);
          if (trail > pos.stopLoss) pos.stopLoss = trail;
        } else {
          if (bar.low < pos.peakPrice) pos.peakPrice = bar.low;
          const trail = pos.peakPrice + (atr * 1.5);
          if (trail < pos.stopLoss) pos.stopLoss = trail;
        }
      }
    }

    if (currentBalance > peakBalance) peakBalance = currentBalance;
    const currentDd = peakBalance > 0 ? (peakBalance - currentBalance) / peakBalance : 0;
    if (currentDd > maxDrawdown) maxDrawdown = currentDd;

    if (openPositions.length >= 2 || currentBalance < 15) continue;

    // Candidates
    const candidates = [];

    for (const [sym, md] of Object.entries(marketData)) {
      if (openPositions.some((p) => p.symbol === sym)) continue;
      const idx = md.timeMap.get(time);
      if (idx === undefined || idx < 50) continue;

      const bar = md.candles[idx];
      const atr = md.atr14[idx] || (bar.close * 0.02);
      if (minAtrPct > 0 && (atr / bar.close) < minAtrPct) continue;

      const eFast = customEmaFast[sym][idx];
      const eSlow = customEmaSlow[sym][idx];
      const e200 = md.ema200[idx];
      const rsi = md.rsi14[idx] || 50;
      const prevVolSlice = md.candles.slice(Math.max(0, idx - 20), idx);
      const avgVol = prevVolSlice.reduce((a, b) => a + b.volume, 0) / (prevVolSlice.length || 1);
      const volRatio = bar.volume / (avgVol || 1);

      let signalFound = false;
      let side = 'LONG';

      if (archetype === 'MEAN_REVERSION') {
        // Dip Buy when oversold RSI in uptrend
        if (rsi < minRsi && bar.close > (e200 || eSlow)) {
          signalFound = true;
          side = 'LONG';
        } else if (!onlyLong && rsi > maxRsi && bar.close < (e200 || eSlow)) {
          signalFound = true;
          side = 'SHORT';
        }
      } else if (archetype === 'VOLATILITY_SQUEEZE') {
        // Squeeze Expansion: Volume explosion + low ATR breakout
        if (volRatio >= Math.max(1.6, minVolRatio) && bar.close > eFast && eFast > eSlow) {
          signalFound = true;
          side = 'LONG';
        }
      } else if (archetype === 'PARABOLIC_BLOWOFF_SHORT') {
        // Exhaustion Short on Extreme RSI
        if (!onlyLong && rsi >= 76 && volRatio >= 1.8 && bar.close < bar.open) {
          signalFound = true;
          side = 'SHORT';
        }
      } else {
        // Standard TREND_SNIPER / Pullback
        const isLongTrend = eFast > eSlow && (eFast - eSlow) / eSlow > 0.003 && (!useMacroEma || !e200 || bar.close > e200);
        const isShortTrend = !onlyLong && eFast < eSlow && (eSlow - eFast) / eSlow > 0.003 && (!useMacroEma || !e200 || bar.close < e200);
        if (isLongTrend || isShortTrend) {
          side = isLongTrend ? 'LONG' : 'SHORT';
          if (volRatio >= minVolRatio) {
            const touched = side === 'LONG' ? bar.low <= eFast * 1.008 && bar.close > eFast : bar.high >= eFast * 0.992 && bar.close < eFast;
            if (touched) signalFound = true;
          }
        }
      }

      if (signalFound) {
        candidates.push({ symbol: sym, side, bar, atr, volRatio });
      }
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => b.volRatio - a.volRatio);
    const best = candidates[0];

    // Stake sizing
    let streakMult = 1.0;
    if (winStreak >= 2) streakMult = Math.min(1.25, 1.0 + (winStreak - 1) * 0.10);
    else if (lossStreak === 2) streakMult = 0.65;
    else if (lossStreak >= 3) streakMult = 0.45;

    const margin = Math.min(currentBalance * 0.40, Math.max(10, currentBalance * 0.30 * streakMult));
    if (margin > currentBalance || margin < 10) continue;

    const entryPrice = best.bar.close;
    const isMeme = /PEPE|DOGE|BONK/i.test(best.symbol);
    const stopMult = isMeme ? stopAtrMultiple * 1.3 : stopAtrMultiple;
    const stopDist = Math.max(best.atr * stopMult, entryPrice * 0.01);
    const stopLoss = best.side === 'LONG' ? entryPrice - stopDist : entryPrice + stopDist;
    const rDist = Math.abs(entryPrice - stopLoss);

    currentBalance -= margin;

    openPositions.push({
      symbol: best.symbol,
      side: best.side,
      entry: entryPrice,
      margin,
      remainingMargin: margin,
      stopLoss,
      rDist,
      tp1: best.side === 'LONG' ? entryPrice + (rDist * tp1R) : entryPrice - (rDist * tp1R),
      tp2: best.side === 'LONG' ? entryPrice + (rDist * tp2R) : entryPrice - (rDist * tp2R),
      tp1Hit: false,
      tp2Hit: false,
      trailingActive: false,
      peakPrice: entryPrice,
      realizedPnl: 0,
    });
  }

  // Settle
  for (const pos of openPositions) {
    const md = marketData[pos.symbol];
    const lastBar = md.candles[md.candles.length - 1];
    const isLong = pos.side === 'LONG';
    const exitPrice = lastBar.close;
    const pnlPct = isLong ? (exitPrice - pos.entry) / pos.entry : (pos.entry - exitPrice) / pos.entry;
    pos.realizedPnl += pos.remainingMargin * leverage * pnlPct;
    currentBalance += pos.remainingMargin + pos.realizedPnl;
    closedTrades.push({ symbol: pos.symbol, pnl: pos.realizedPnl });
  }

  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const total = closedTrades.length;
  const grossProfit = closedTrades.filter((t) => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
  const grossLoss = Math.abs(closedTrades.filter((t) => t.pnl < 0).reduce((a, b) => a + b.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  return {
    finalBalance: currentBalance,
    roiPct: ((currentBalance - startingBalance) / startingBalance) * 100,
    totalTrades: total,
    wins,
    losses: total - wins,
    winRate,
    profitFactor,
    maxDrawdown: maxDrawdown * 100,
  };
}

async function askOllamaForCreativeStrategy(model, bestSoFar, history) {
  const prompt = `You are a wild, creative AI Quantitative Research Engineer.
Invent a UNIQUE trading strategy concept for crypto perpetuals (SOL, NEAR, SUI, PEPE, BTC).

Archetypes to explore:
1. TREND_SNIPER (pullback to EMA)
2. MEAN_REVERSION (buying oversold RSI dips in uptrend)
3. VOLATILITY_SQUEEZE (explosive expansion after consolidation)
4. PARABOLIC_BLOWOFF_SHORT (fading extreme RSI spikes)

Current Best Strategy (${bestSoFar.strategy.name || 'Baseline'}):
- Win Rate: ${bestSoFar.stats.winRate.toFixed(1)}% (${bestSoFar.stats.wins}W / ${bestSoFar.stats.losses}L)
- Profit Factor: ${bestSoFar.stats.profitFactor.toFixed(2)}
- ROI: +${bestSoFar.stats.roiPct.toFixed(1)}%

Hypothesize a wildly creative strategy. Return ONLY valid JSON in this exact structure:
{
  "name": "Creative Strategy Name (e.g. Oversold RSI Dip Scalper)",
  "reasoning": "Why this archetype beats traditional trend-following",
  "archetype": "MEAN_REVERSION",
  "fastEma": 21,
  "slowEma": 55,
  "useMacroEma": true,
  "minVolRatio": 1.4,
  "minRsi": 35,
  "maxRsi": 70,
  "minAtrPct": 0.012,
  "onlyLong": true,
  "tp1R": 1.0,
  "tp1Portion": 0.70,
  "tp2R": 2.2,
  "tp2Portion": 0.20,
  "lockProfitR": 0.35,
  "stopAtrMultiple": 1.5
}`;

  try {
    const res = await globalThis.fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
      }),
    });
    const data = await res.json();
    return JSON.parse(data.response);
  } catch (err) {
    return null;
  }
}

async function main() {
  const { model, iterations, symbols } = parseArgs();

  console.log(`\n========================================================================`);
  console.log(`🚀 TRADERR CREATIVE AI QUANT LAB (WILD ARCHETYPE EXPLORER)`);
  console.log(`========================================================================`);
  console.log(`GPU Engine       : NVIDIA RTX 5070 Ti (16 GB VRAM)`);
  console.log(`Ollama Model     : ${model}`);
  console.log(`AI Rondes        : ${iterations} Creatieve Experimenten`);
  console.log(`Markten          : ${symbols.join(', ')}`);
  console.log(`Kosten           : $0.00 (100% Lokaal & Vrij)`);
  console.log(`========================================================================\n`);

  const marketData = {};
  for (const sym of symbols) {
    const file = path.resolve(CACHE_DIR, `${sym}_1h.json`);
    if (!fs.existsSync(file)) continue;
    const candles = JSON.parse(fs.readFileSync(file, 'utf8')).slice(-2000);
    marketData[sym] = {
      symbol: sym,
      candles,
      ema200: calculateEma(candles, 200),
      atr14: calculateAtr(candles, 14),
      rsi14: calculateRsi(candles, 14),
      timeMap: new Map(candles.map((c, idx) => [c.time, idx])),
    };
  }

  const btcTimes = marketData['BTC_USDT']?.candles.map((c) => c.time) || [];
  const timeline = btcTimes.slice(200);

  const baselineStrategy = {
    name: 'High-Rate Scalper (#1 Winner)',
    archetype: 'TREND_SNIPER',
    fastEma: 26,
    slowEma: 70,
    useMacroEma: true,
    minVolRatio: 1.8,
    minRsi: 45,
    maxRsi: 63,
    minAtrPct: 0.015,
    onlyLong: false,
    tp1R: 1.0,
    tp1Portion: 0.70,
    tp2R: 2.4,
    tp2Portion: 0.25,
    lockProfitR: 0.30,
    stopAtrMultiple: 1.6,
  };

  const baselineStats = runBacktest(baselineStrategy, marketData, timeline);
  console.log(`📌 Baseline Record: WinRate ${baselineStats.winRate.toFixed(1)}% | PF ${baselineStats.profitFactor.toFixed(2)} | ROI +${baselineStats.roiPct.toFixed(1)}% | ${baselineStats.wins}W / ${baselineStats.losses}L\n`);

  let bestSoFar = { strategy: baselineStrategy, stats: baselineStats };
  const history = [bestSoFar];
  let leaderboard = [];

  if (fs.existsSync(LEADERBOARD_FILE)) {
    try {
      leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    } catch {}
  }
  if (!leaderboard.length) leaderboard.push(bestSoFar);

  for (let round = 1; round <= iterations; round++) {
    process.stdout.write(`[Ronde ${round}/${iterations}] AI (${model}) bedenkt nieuwe tactiek... `);
    const startT = Date.now();
    const candidate = await askOllamaForCreativeStrategy(model, bestSoFar, history);
    const duration = ((Date.now() - startT) / 1000).toFixed(1);

    if (!candidate) {
      console.log(`⚠️ Ollama fout.`);
      continue;
    }

    console.log(`✓ (${duration}s)`);
    console.log(`   💡 Tactiek [${candidate.archetype || 'CUSTOM'}]: "${candidate.name}"`);
    if (candidate.reasoning) {
      console.log(`   📝 Rationale: ${candidate.reasoning}`);
    }

    const stats = runBacktest(candidate, marketData, timeline);
    console.log(
      `   📊 Resultaat: WR ${stats.winRate.toFixed(1)}% (${stats.wins}W/${stats.losses}L) | PF ${stats.profitFactor.toFixed(2)} | ROI ${stats.roiPct >= 0 ? '+' : ''}${stats.roiPct.toFixed(1)}% | DD ${stats.maxDrawdown.toFixed(1)}%`
    );

    if (stats.totalTrades >= 5 && stats.winRate >= bestSoFar.stats.winRate) {
      console.log(`   🔥 NIEUW RECORD GEVONDEN! Opgeslagen op Leaderboard.`);
      bestSoFar = { strategy: candidate, stats };
    }

    history.push({ strategy: candidate, stats });
    leaderboard.push({ strategy: candidate, stats });
    console.log(``);
  }

  leaderboard.sort((a, b) => (b.stats.winRate * 2 + b.stats.profitFactor * 10) - (a.stats.winRate * 2 + a.stats.profitFactor * 10));
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));

  console.log(`========================================================================`);
  console.log(`🏆 LEADERBOARD VAN BESTE DOOR AI BEDACHTE TACTIEKEN`);
  console.log(`========================================================================`);
  console.log(
    `Rang`.padEnd(6) +
    `Strategie Naam`.padEnd(36) +
    `Win Rate`.padEnd(12) +
    `Profit Factor`.padEnd(16) +
    `ROI`.padEnd(12) +
    `Trades`
  );
  console.log(`------------------------------------------------------------------------`);
  for (let i = 0; i < Math.min(7, leaderboard.length); i++) {
    const item = leaderboard[i];
    console.log(
      `#${i + 1}`.padEnd(6) +
      item.strategy.name.slice(0, 34).padEnd(36) +
      `${item.stats.winRate.toFixed(1)}%`.padEnd(12) +
      item.stats.profitFactor.toFixed(2).padEnd(16) +
      `${item.stats.roiPct >= 0 ? '+' : ''}${item.stats.roiPct.toFixed(1)}%`.padEnd(12) +
      `${item.stats.totalTrades} (${item.stats.wins}W/${item.stats.losses}L)`
    );
  }
  console.log(`========================================================================\n`);
}

main().catch(console.error);
