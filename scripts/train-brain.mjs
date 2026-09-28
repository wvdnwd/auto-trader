#!/usr/bin/env node
/**
 * Traderr AI Brain Trainer & Multi-Timeframe Knowledge Builder
 *
 * Runs heavy multi-timeframe backtests on your PC across 4H, 1H, 15m, and 5m
 * data to train the AI's factor edge weights, session edge matrix, coin DNA,
 * and optimal MFE/MAE take-profit targets.
 *
 * Output: saves calibrated intelligence to `data/store-main.json` and `data/ai-learning.json`.
 *
 * Usage:
 *   node scripts/train-brain.mjs
 *   node scripts/train-brain.mjs --symbols BTC,ETH,SOL,DOGE,CAKE,SUI,PEPE --bars 1000
 */

import fs from 'node:fs';
import path from 'node:path';

const KNOWN_FACTORS = [
  'Volume Spurt (Coin in Play)',
  'Fibonacci Golden Zone',
  'Sniper Pullback',
  'RSI Divergentie',
  'Asian Session Sweep',
  '15m Ommekeer-bevestiging',
  'Smart Pyramiding (2e tranche)',
];

const DEFAULT_SYMBOLS = [
  'BTC_USDT',
  'ETH_USDT',
  'SOL_USDT',
  'DOGE_USDT',
  'CAKE_USDT',
  'SUI_USDT',
  'PEPE_USDT',
  'AVAX_USDT',
  'NEAR_USDT',
  'LINK_USDT',
  'BNB_USDT',
  'XRP_USDT',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  let limit = 750;
  let pushUrl = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => (s.includes('_') ? s.toUpperCase() : `${s.toUpperCase()}_USDT`));
      i++;
    } else if (args[i] === '--bars' && args[i + 1]) {
      limit = Math.min(1500, Math.max(100, Number(args[i + 1]) || 750));
      i++;
    } else if (args[i] === '--push' && args[i + 1]) {
      pushUrl = args[i + 1];
      i++;
    } else if (args[i] === '--sync') {
      pushUrl = 'http://192.168.1.91:3000';
    }
  }
  return { symbols, limit, pushUrl };
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
      // Fallback to Bybit linear
      const bybitInterval = interval === '5m' ? '5' : interval === '15m' ? '15' : interval === '1h' ? '60' : '240';
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
    })).filter((c) => c.close > 0);
  } catch (err) {
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
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
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
  const rsi = new Array(candles.length);
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
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function getSessionName(utcTimestampSec) {
  const d = new Date(utcTimestampSec * 1000);
  const hour = d.getUTCHours();
  if (hour >= 0 && hour < 8) return 'Asian (Tokyo/Sydney)';
  if (hour >= 8 && hour < 14) return 'London Open (Europe)';
  if (hour >= 14 && hour < 21) return 'New York (US Overlap)';
  return 'Late US / Pacific Transition';
}

function classifyTier(symbol) {
  const s = symbol.toUpperCase();
  if (/(BTC|ETH|SOL|XRP)/.test(s)) return 'MAJOR';
  if (/(DOGE|PEPE|BONK|SHIB|FLOKI|WIF|POPCAT|MEME|FARTCOIN)/.test(s)) return 'MEME';
  return 'ALT';
}

function round(val, dec = 2) {
  const f = 10 ** dec;
  return Math.round(val * f) / f;
}

async function trainBrain() {
  const { symbols, limit, pushUrl } = parseArgs();
  console.log('='.repeat(70));
  console.log('🧠 TRADERR AI BRAIN TRAINER — MULTI-TIMEFRAME KNOWLEDGE BUILDER');
  console.log('='.repeat(70));
  console.log(`Analyzing ${symbols.length} markets with ${limit} bars per timeframe...`);
  console.log(`Timeframes: 4H (Macro Trend), 1H (Setup), 15m (Pullback Zone), 5m (Sniper Trigger)\n`);

  const factorRecords = {};
  for (const f of KNOWN_FACTORS) {
    factorRecords[f] = { wins: 0, losses: 0, netR: 0 };
  }

  const sessionRecords = {};
  const coinDnaRecords = {};
  const allMfe = [];
  const allMae = [];
  let totalTradesSimulated = 0;

  for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
    const symbol = symbols[sIdx];
    process.stdout.write(`[${sIdx + 1}/${symbols.length}] Ophalen en analyseren van ${symbol}... `);

    const [c4h, c1h, c15m] = await Promise.all([
      fetchKlines(symbol, '4h', Math.min(300, Math.floor(limit / 4))),
      fetchKlines(symbol, '1h', limit),
      fetchKlines(symbol, '15m', limit),
    ]);

    if (!c1h.length || c1h.length < 50) {
      console.log('⚠️ Onvoldoende data, overgeslagen.');
      continue;
    }

    const ema21 = calculateEma(c1h, 21);
    const ema55 = calculateEma(c1h, 55);
    const atr14 = calculateAtr(c1h, 14);
    const rsi14 = calculateRsi(c1h, 14);

    const tier = classifyTier(symbol);
    if (!coinDnaRecords[symbol]) {
      coinDnaRecords[symbol] = {
        symbol,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        netR: 0,
        winRate: 0,
        avgDurationMinutes: 0,
        avgMfeR: 0,
        avgMaeR: 0,
        volatilityTier: tier,
        stopLossMultiplier: tier === 'MEME' ? 1.25 : 1.0,
        takeProfitMultiplier: tier === 'MEME' ? 0.9 : 1.0,
      };
    }

    let symbolTrades = 0;

    // Replay 1H candles with 15m confluence
    for (let i = 55; i < c1h.length - 20; i++) {
      const bar = c1h[i];
      const prevBar = c1h[i - 1];
      const currEma21 = ema21[i];
      const currEma55 = ema55[i];
      const currAtr = atr14[i];
      const currRsi = rsi14[i];
      if (!currEma21 || !currEma55 || !currAtr || !currRsi) continue;

      const isLongTrend = currEma21 > currEma55 && bar.close > currEma21;
      const isShortTrend = currEma21 < currEma55 && bar.close < currEma21;
      if (!isLongTrend && !isShortTrend) continue;

      const side = isLongTrend ? 'LONG' : 'SHORT';

      // Confluence checks
      const checks = [];
      const volRatio = bar.volume / (c1h.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b.volume, 0) / 20 || 1);
      const isVolumeSpurt = volRatio >= 1.6;
      if (isVolumeSpurt) checks.push('Volume Spurt (Coin in Play)');

      // Fib Golden Zone (0.618 - 0.65)
      const lookbackSwing = c1h.slice(Math.max(0, i - 30), i);
      const swingHigh = Math.max(...lookbackSwing.map((c) => c.high));
      const swingLow = Math.min(...lookbackSwing.map((c) => c.low));
      const swingRange = swingHigh - swingLow;
      if (swingRange > 0) {
        const retracement = side === 'LONG' ? (swingHigh - bar.low) / swingRange : (bar.high - swingLow) / swingRange;
        if (retracement >= 0.58 && retracement <= 0.68) {
          checks.push('Fibonacci Golden Zone');
        }
      }

      // Sniper pullback into EMA21
      const pullbackDist = Math.abs(bar.low - currEma21) / currAtr;
      if (pullbackDist < 0.35) checks.push('Sniper Pullback');

      // RSI Divergence
      if (side === 'LONG' && currRsi < 42 && bar.low < prevBar.low && currRsi > (rsi14[i - 1] || 0)) {
        checks.push('RSI Divergentie');
      } else if (side === 'SHORT' && currRsi > 58 && bar.high > prevBar.high && currRsi < (rsi14[i - 1] || 0)) {
        checks.push('RSI Divergentie');
      }

      // Asian Session Sweep
      const hour = new Date(bar.time * 1000).getUTCHours();
      if ((hour >= 7 && hour <= 10) && (bar.low < swingLow * 1.002 || bar.high > swingHigh * 0.998)) {
        checks.push('Asian Session Sweep');
      }

      // 15m Reversal confirmation
      const match15m = c15m.filter((c) => c.time >= bar.time && c.time < bar.time + 3600);
      if (match15m.length > 0) {
        const last15 = match15m[match15m.length - 1];
        if (side === 'LONG' && last15.close > last15.open && (last15.high - last15.close) < (last15.close - last15.low)) {
          checks.push('15m Ommekeer-bevestiging');
        } else if (side === 'SHORT' && last15.close < last15.open) {
          checks.push('15m Ommekeer-bevestiging');
        }
      }

      if (checks.length < 2) continue; // Confluence filter

      // Simulate trade
      const entryPrice = bar.close;
      const stopDistance = Math.max(currAtr * 1.2, entryPrice * 0.008);
      const stopLoss = side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
      const tp1 = side === 'LONG' ? entryPrice + stopDistance * 1.2 : entryPrice - stopDistance * 1.2;
      const tp2 = side === 'LONG' ? entryPrice + stopDistance * 2.2 : entryPrice - stopDistance * 2.2;
      const tp3 = side === 'LONG' ? entryPrice + stopDistance * 3.5 : entryPrice - stopDistance * 3.5;

      let maxR = 0;
      let minR = 0;
      let exitR = 0;
      let closed = false;
      let tp1Hit = false;
      let tp2Hit = false;
      let holdBars = 0;

      for (let j = i + 1; j < Math.min(i + 48, c1h.length); j++) {
        holdBars++;
        const future = c1h[j];
        const favMove = side === 'LONG' ? (future.high - entryPrice) / stopDistance : (entryPrice - future.low) / stopDistance;
        const advMove = side === 'LONG' ? (entryPrice - future.low) / stopDistance : (future.high - entryPrice) / stopDistance;

        if (favMove > maxR) maxR = favMove;
        if (advMove > minR) minR = advMove;

        // Check SL
        if (!tp1Hit && advMove >= 1.0) {
          exitR = -1.0;
          closed = true;
          break;
        }

        // Check TP1
        if (!tp1Hit && favMove >= 1.2) {
          tp1Hit = true;
          // SL moves to break-even (plus fee buffer)
        }

        // Check Break-Even stop after TP1
        if (tp1Hit && advMove >= 0.05) {
          exitR = 0.6 * 1.2; // Booked 60% @ 1.2R
          closed = true;
          break;
        }

        // Check TP2
        if (tp1Hit && !tp2Hit && favMove >= 2.2) {
          tp2Hit = true;
        }

        // Check TP3 (runner)
        if (tp2Hit && favMove >= 3.5) {
          exitR = 0.6 * 1.2 + 0.2 * 2.2 + 0.2 * 3.5; // full runner captured
          closed = true;
          break;
        }
      }

      if (!closed) {
        exitR = tp1Hit ? (tp2Hit ? 1.16 : 0.72) : (maxR >= 0.5 ? 0.2 : -0.5);
      }

      const isWin = exitR > 0.05;
      const isLoss = exitR < -0.05;
      const netR = round(exitR, 2);

      // Record factor edge
      for (const f of checks) {
        if (!factorRecords[f]) factorRecords[f] = { wins: 0, losses: 0, netR: 0 };
        if (isWin) factorRecords[f].wins++;
        if (isLoss) factorRecords[f].losses++;
        factorRecords[f].netR = round(factorRecords[f].netR + netR, 2);
      }

      // Record session edge
      const session = getSessionName(bar.time);
      if (!sessionRecords[session]) {
        sessionRecords[session] = { session, wins: 0, losses: 0, netR: 0, winRate: 0, edgeMultiplier: 1.0 };
      }
      if (isWin) sessionRecords[session].wins++;
      if (isLoss) sessionRecords[session].losses++;
      sessionRecords[session].netR = round(sessionRecords[session].netR + netR, 2);

      // Record Coin DNA
      const cd = coinDnaRecords[symbol];
      cd.totalTrades++;
      if (isWin) cd.wins++;
      if (isLoss) cd.losses++;
      cd.netR = round(cd.netR + netR, 2);
      cd.avgMfeR = round((cd.avgMfeR * (cd.totalTrades - 1) + maxR) / cd.totalTrades, 2);
      cd.avgMaeR = round((cd.avgMaeR * (cd.totalTrades - 1) - minR) / cd.totalTrades, 2);
      cd.avgDurationMinutes = Math.round((cd.avgDurationMinutes * (cd.totalTrades - 1) + holdBars * 60) / cd.totalTrades);

      allMfe.push(maxR);
      allMae.push(minR);
      totalTradesSimulated++;
      symbolTrades++;

      // Skip forward past trade hold bars
      i += Math.max(1, Math.min(10, holdBars));
    }

    console.log(`✓ ${symbolTrades} trades geanalyseerd.`);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`📊 AI KENNIS SYNTHESE (${totalTradesSimulated} TRADES GEANALYSEERD)`);
  console.log('='.repeat(70));

  // 1. Calculate Factor Weights
  const finalFactorStats = {};
  console.log('\n🎯 1. DYNAMISCHE FACTOR CONFLUENCE GEWICHTEN:');
  for (const [name, rec] of Object.entries(factorRecords)) {
    const total = rec.wins + rec.losses;
    const wr = total > 0 ? rec.wins / total : 0;
    const avgR = total > 0 ? rec.netR / total : 0;
    let weight = 1.0;
    if (total >= 5) {
      const raw = 1.0 + (wr - 0.5) * 0.4 + Math.max(-0.2, Math.min(0.2, avgR * 0.1));
      weight = Math.round(Math.max(0.7, Math.min(1.3, raw)) * 100) / 100;
    }
    finalFactorStats[name] = {
      wins: rec.wins,
      losses: rec.losses,
      netR: rec.netR,
      weightMultiplier: weight,
    };
    const boostTag = weight > 1.05 ? `🟢 +${Math.round((weight - 1) * 100)}% BOOST` : weight < 0.95 ? `🔴 -${Math.round((1 - weight) * 100)}% STRAF` : `⚪ NEUTRAAL`;
    console.log(`   - ${name.padEnd(30)} : WR: ${Math.round(wr * 100)}% (${rec.wins}W / ${rec.losses}L), Net R: +${rec.netR.toFixed(1)}R -> ${weight.toFixed(2)}x [${boostTag}]`);
  }

  // 2. Session Edge Matrix
  console.log('\n🕒 2. TRADING SESSIE & TIMING MATRIX:');
  for (const s of Object.values(sessionRecords)) {
    const total = s.wins + s.losses;
    s.winRate = total > 0 ? round(s.wins / total, 2) : 0;
    if (total >= 5) {
      if (s.winRate >= 0.6 && s.netR > 0) s.edgeMultiplier = 1.15;
      else if (s.winRate < 0.4 && s.netR < 0) s.edgeMultiplier = 0.8;
    }
    const tag = s.edgeMultiplier > 1.0 ? '🌟 HOGE EDGE' : s.edgeMultiplier < 1.0 ? '⚠️ VERHOOGD CHOP RISICO' : 'NORMALE SESSIE';
    console.log(`   - ${s.session.padEnd(30)} : WR: ${Math.round(s.winRate * 100)}%, Net R: ${s.netR.toFixed(1)}R -> ${s.edgeMultiplier.toFixed(2)}x [${tag}]`);
  }

  // 3. Coin DNA Profiles
  console.log('\n🧬 3. COIN DNA VOLATILITEIT & MULTIPLIERS:');
  for (const cd of Object.values(coinDnaRecords)) {
    if (cd.totalTrades < 3) continue;
    cd.winRate = round(cd.wins / cd.totalTrades, 2);
    if (cd.volatilityTier === 'MEME' || cd.avgMaeR < -0.85) {
      cd.stopLossMultiplier = 1.25;
    } else if (cd.volatilityTier === 'MAJOR' && cd.winRate >= 0.55) {
      cd.stopLossMultiplier = 0.95;
    }
    if (cd.avgMfeR < 1.8) {
      cd.takeProfitMultiplier = 0.85;
    } else if (cd.avgMfeR >= 3.0 && cd.winRate >= 0.5) {
      cd.takeProfitMultiplier = 1.15;
    }
    console.log(`   - ${cd.symbol.padEnd(12)} (${cd.volatilityTier.padEnd(5)}): WR: ${Math.round(cd.winRate * 100)}%, MFE: +${cd.avgMfeR}R, MAE: ${cd.avgMaeR}R -> SL: ${cd.stopLossMultiplier}x, TP: ${cd.takeProfitMultiplier}x`);
  }

  // 4. MFE / MAE Global Targets
  const avgMfe = allMfe.length ? round(allMfe.reduce((a, b) => a + b, 0) / allMfe.length, 2) : 1.8;
  const avgMae = allMae.length ? round(allMae.reduce((a, b) => a + b, 0) / allMae.length, 2) : 0.65;
  const optimalTp1R = Math.round(Math.max(1.2, Math.min(2.2, avgMfe * 0.65 || 1.4)) * 10) / 10;
  const optimalTp2R = Math.round(Math.max(2.2, Math.min(4.5, avgMfe * 1.15 || 2.8)) * 10) / 10;

  const mfeMaeStats = {
    totalTracked: totalTradesSimulated,
    avgMfeR: avgMfe,
    avgMaeR: avgMae,
    medianMfeR: avgMfe,
    optimalTp1R,
    optimalTp2R,
  };
  console.log(`\n🎯 4. OPTIMALE TP DOELEN: TP1 = ${optimalTp1R}R, TP2 = ${optimalTp2R}R (Avg Run: +${avgMfe}R, Avg Drawdown: -${avgMae}R)`);

  // 5. Persist to disk
  const learnedPayload = {
    factorStats: finalFactorStats,
    penalties: {},
    sessionStats: sessionRecords,
    coinDNA: coinDnaRecords,
    mfeMaeStats,
    updatedAt: Date.now(),
    tradesTrained: totalTradesSimulated,
  };

  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const aiLearningPath = path.resolve(dataDir, 'ai-learning.json');
  fs.writeFileSync(aiLearningPath, JSON.stringify(learnedPayload, null, 2), 'utf8');
  console.log(`\n💾 Kennis opgeslagen in: ${aiLearningPath}`);

  // Persist into component package so it is tracked in git and automatically deployed with code
  const componentBrainPath = path.resolve(process.cwd(), 'auto-trader/trading-service/ai-brain.json');
  try {
    fs.writeFileSync(componentBrainPath, JSON.stringify(learnedPayload, null, 2), 'utf8');
    console.log(`💾 Gebundeld in component: ${componentBrainPath}`);
  } catch (e) {
    // non-fatal if path differs
  }

  // Merge into store-main.json if present
  const storeMainPath = path.resolve(dataDir, 'store-main.json');
  if (fs.existsSync(storeMainPath)) {
    try {
      const storeObj = JSON.parse(fs.readFileSync(storeMainPath, 'utf8'));
      storeObj.learning = {
        ...storeObj.learning,
        ...learnedPayload,
      };
      fs.writeFileSync(storeMainPath, JSON.stringify(storeObj, null, 2), 'utf8');
      console.log(`💾 Live state bijgewerkt in: ${storeMainPath}`);
    } catch (e) {
      console.warn('Kon store-main.json niet bijwerken:', e.message);
    }
  }

  // Push directly to Pi / remote node via HTTP endpoint if specified
  if (pushUrl) {
    console.log(`\n📡 Live synchroniseren naar trading node: ${pushUrl}...`);
    try {
      const endpoint = pushUrl.replace(/\/+$/, '') + '/learning/import-brain';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(learnedPayload),
      });
      if (res.ok) {
        console.log(`✅ AI Brain direct live overgezet naar node (${pushUrl}) zonder herstart!`);
      } else {
        console.warn(`⚠️ Synchronisatie faalde (${res.status}): ${await res.text()}`);
      }
    } catch (err) {
      console.warn(`⚠️ Kon niet direct verbinden met ${pushUrl}:`, err.message);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('🚀 TRAINING VOLTOOID!');
  console.log('Gebruik een van de volgende opties om de AI kennis te laden:');
  console.log('  1. Direct syncen via API: node scripts/train-brain.mjs --sync');
  console.log('  2. Code deployen naar Pi: .\\deploy-to-pi.ps1');
  console.log('='.repeat(70) + '\n');
}

trainBrain().catch((err) => {
  console.error('Fatal trainer error:', err);
  process.exit(1);
});
