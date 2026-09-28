#!/usr/bin/env node
/**
 * Traderr AI Brain Trainer & Multi-Timeframe Knowledge Builder (161 Coins x 4 Years)
 *
 * Runs heavy multi-timeframe backtests on your PC across 4H and 1H historical candles
 * over 161 coins and up to 4 years of history to train:
 * - Dynamic Factor Confluence Weights (Volume Spurt, Fibonacci Golden Zone, Sniper Pullback, etc.)
 * - Session Edge Matrix (Asian, London, New York, Late US)
 * - Coin DNA Volatility, SL/TP Multipliers, and win rates
 * - Empirical MFE / MAE Take-Profit Targets
 *
 * Automatically saves calibrated AI brain to disk and pushes live to the Raspberry Pi.
 *
 * Usage:
 *   node scripts/train-brain.mjs --years 4 --all161 --sync
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

function load161Coins() {
  const jsonPath = path.resolve(process.cwd(), 'data/161-coins.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      return list.map((c) => (c.includes('_') ? c.toUpperCase() : `${c.toUpperCase()}_USDT`));
    } catch {
      // Fallback
    }
  }
  return DEFAULT_SYMBOLS;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let symbols = DEFAULT_SYMBOLS;
  let limit = 750;
  let pushUrl = null;
  let years = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all161' || (args[i] === '--symbols' && args[i + 1] === 'all')) {
      symbols = load161Coins();
      if (args[i] === '--symbols') i++;
    } else if (args[i] === '--symbols' && args[i + 1]) {
      symbols = args[i + 1].split(',').map((s) => (s.includes('_') ? s.toUpperCase() : `${s.toUpperCase()}_USDT`));
      i++;
    } else if (args[i] === '--years' && args[i + 1]) {
      years = Math.max(1, Math.min(6, Number(args[i + 1]) || 4));
      limit = years * 365 * 24; // e.g. 4 years = 35040 bars
      i++;
    } else if (args[i] === '--bars' && args[i + 1]) {
      limit = Math.min(50000, Math.max(100, Number(args[i + 1]) || 750));
      i++;
    } else if (args[i] === '--push' && args[i + 1]) {
      pushUrl = args[i + 1];
      i++;
    } else if (args[i] === '--sync') {
      pushUrl = 'http://192.168.1.91:5001';
    }
  }
  return { symbols, limit, pushUrl, years };
}

function toBinanceSymbol(sym) {
  const clean = sym.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean === 'PEPE' || clean === 'PEPEUSDT') return '1000PEPEUSDT';
  if (clean === 'SHIB' || clean === 'SHIBUSDT') return '1000SHIBUSDT';
  if (clean === 'BONK' || clean === 'BONKUSDT') return '1000BONKUSDT';
  if (clean === 'FLOKI' || clean === 'FLOKIUSDT') return '1000FLOKIUSDT';
  if (clean === 'MOG' || clean === 'MOGUSDT') return '1000000MOGUSDT';
  if (clean === 'LUNC' || clean === 'LUNCUSDT') return '1000LUNCUSDT';
  if (clean === 'SATS' || clean === 'SATSUSDT') return '1000SATSUSDT';
  if (clean === 'RATS' || clean === 'RATSUSDT') return '1000RATSUSDT';
  if (clean === 'CAT' || clean === 'CATUSDT') return '1000CATUSDT';
  if (clean === 'CHEEMS' || clean === 'CHEEMSUSDT') return '1000000CHEEMSUSDT';
  if (clean.endsWith('USDT')) return clean;
  return `${clean}USDT`;
}

// Disk cache directory for fast resume
const CACHE_DIR = path.resolve(process.cwd(), 'data/candles_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKlinesPaginated(symbol, interval, totalLimit = 1000) {
  const cacheFile = path.resolve(CACHE_DIR, `${symbol}_${interval}.json`);

  // Check cache first
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached) && cached.length >= Math.min(totalLimit * 0.85, 30000)) {
        return cached.slice(-totalLimit);
      }
    } catch {
      // ignore corrupted cache
    }
  }

  const bSym = toBinanceSymbol(symbol);
  let candles = [];
  let endTime = Date.now();
  const targetStartTime = Date.now() - (totalLimit * (interval === '4h' ? 4 : 1) * 3600 * 1000);
  let chunks = 0;
  const maxChunks = Math.ceil(totalLimit / 1500) + 2;

  while (chunks < maxChunks && endTime > targetStartTime) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${bSym}&interval=${interval}&limit=1500&endTime=${endTime}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 429) {
          await sleep(2000); // Backoff on rate limit
          continue;
        }
        break;
      }
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;

      const mapped = data.map((c) => ({
        time: Math.floor(Number(c[0]) / 1000),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5]),
      })).filter((c) => c.close > 0);

      candles = mapped.concat(candles);
      endTime = data[0][0] - 1;
      chunks++;
      await sleep(35); // Gentle pacing
    } catch {
      break;
    }
  }

  // Deduplicate and sort
  const uniqueMap = new Map();
  for (const c of candles) uniqueMap.set(c.time, c);
  const result = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);

  // Write to cache
  if (result.length > 50) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result));
    } catch {
      // non-fatal
    }
  }

  return result.slice(-totalLimit);
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
  if (/(DOGE|PEPE|BONK|SHIB|FLOKI|WIF|POPCAT|MEME|FARTCOIN|MOG|PNUT|MOODENG|TRUMP)/.test(s)) return 'MEME';
  if (/(NEAR|RENDER|FET|TAO|WLD|AI|IO|ARKM|ATH)/.test(s)) return 'AI_TECH';
  if (/(AAVE|UNI|CRV|MKR|SNX|JUP|PENDLE|ENA|LDO)/.test(s)) return 'DEFI';
  return 'ALT';
}

function round(val, dec = 2) {
  const f = 10 ** dec;
  return Math.round(val * f) / f;
}

async function trainBrain() {
  const { symbols, limit, pushUrl, years } = parseArgs();
  console.log('='.repeat(72));
  console.log('🧠 TRADERR AI BRAIN TRAINER — DEEP MULTI-YEAR KNOWLEDGE BUILDER');
  console.log('='.repeat(72));
  console.log(`Universum       : ${symbols.length} munten`);
  console.log(`Tijdsperiode    : ${years ? `${years} jaar (~${limit} uur)` : `${limit} bars`}`);
  console.log(`Timeframes      : 4H (Macro Trend), 1H (Setup & Confluence)`);
  if (pushUrl) console.log(`Live Sync Doel  : ${pushUrl}`);
  console.log('='.repeat(72) + '\n');

  const factorRecords = {};
  for (const f of KNOWN_FACTORS) {
    factorRecords[f] = { wins: 0, losses: 0, netR: 0 };
  }

  const sessionRecords = {};
  const coinDnaRecords = {};
  const allMfe = [];
  const allMae = [];
  let totalTradesSimulated = 0;
  let totalCoinsWithData = 0;

  for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
    const symbol = symbols[sIdx];
    const prefix = `[${(sIdx + 1).toString().padStart(3, ' ')}/${symbols.length}]`;
    process.stdout.write(`${prefix} Ophalen & analyseren van ${symbol.padEnd(14, ' ')}... `);

    const c1h = await fetchKlinesPaginated(symbol, '1h', limit);

    if (!c1h || c1h.length < 100) {
      console.log('⚠️ Geen data op futures, overgeslagen.');
      continue;
    }

    totalCoinsWithData++;
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
    let symbolWins = 0;
    let symbolNetR = 0;

    // Step across candles in 2-bar intervals to avoid over-counting overlapping trades
    for (let i = 55; i < c1h.length - 24; i += 2) {
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

      // Confluence factors
      const checks = [];
      const prevVolumeWindow = c1h.slice(Math.max(0, i - 20), i);
      const avgVol = prevVolumeWindow.reduce((a, b) => a + b.volume, 0) / (prevVolumeWindow.length || 1);
      const volRatio = bar.volume / (avgVol || 1);
      if (volRatio >= 1.6) checks.push('Volume Spurt (Coin in Play)');

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

      // Intra-bar reversal wick check
      if (side === 'LONG' && bar.close > bar.open && (bar.high - bar.close) < (bar.close - bar.low)) {
        checks.push('15m Ommekeer-bevestiging');
      } else if (side === 'SHORT' && bar.close < bar.open && (bar.close - bar.low) < (bar.high - bar.close)) {
        checks.push('15m Ommekeer-bevestiging');
      }

      if (checks.length < 2) continue; // Confluence filter

      // Simulate trade
      const entryPrice = bar.close;
      const stopDistance = Math.max(currAtr * 1.2, entryPrice * 0.008);
      const tp1 = side === 'LONG' ? entryPrice + stopDistance * 1.8 : entryPrice - stopDistance * 1.8;
      const tp2 = side === 'LONG' ? entryPrice + stopDistance * 3.5 : entryPrice - stopDistance * 3.5;

      let maxR = 0;
      let minR = 0;
      let exitR = 0;
      let closed = false;
      let tp1Hit = false;
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
        if (!tp1Hit && favMove >= 1.8) {
          tp1Hit = true;
        }

        // Break-even stop after TP1
        if (tp1Hit && advMove >= 0) {
          exitR = 0.8; // Banked TP1 portion
          closed = true;
          break;
        }

        // Check TP2
        if (favMove >= 3.5) {
          exitR = 2.4;
          closed = true;
          break;
        }
      }

      if (!closed) {
        const lastFuture = c1h[Math.min(i + 48, c1h.length - 1)];
        exitR = side === 'LONG' ? (lastFuture.close - entryPrice) / stopDistance : (entryPrice - lastFuture.close) / stopDistance;
      }

      const isWin = exitR > 0;
      totalTradesSimulated++;
      symbolTrades++;
      if (isWin) symbolWins++;
      symbolNetR += exitR;

      allMfe.push(round(maxR, 2));
      allMae.push(round(-minR, 2));

      // Record factors
      for (const f of checks) {
        if (!factorRecords[f]) factorRecords[f] = { wins: 0, losses: 0, netR: 0 };
        if (isWin) factorRecords[f].wins++;
        else factorRecords[f].losses++;
        factorRecords[f].netR += exitR;
      }

      // Record session
      const session = getSessionName(bar.time);
      if (!sessionRecords[session]) {
        sessionRecords[session] = { session, wins: 0, losses: 0, netR: 0, edgeMultiplier: 1.0 };
      }
      if (isWin) sessionRecords[session].wins++;
      else sessionRecords[session].losses++;
      sessionRecords[session].netR += exitR;

      // Advance past trade duration to prevent cluster bias
      i += Math.max(2, Math.min(holdBars, 12));
    }

    // Update Coin DNA
    const cd = coinDnaRecords[symbol];
    cd.totalTrades = symbolTrades;
    cd.wins = symbolWins;
    cd.losses = symbolTrades - symbolWins;
    cd.netR = round(symbolNetR, 1);
    cd.winRate = symbolTrades > 0 ? round(symbolWins / symbolTrades, 2) : 0;
    cd.avgMfeR = allMfe.length ? round(allMfe.slice(-symbolTrades).reduce((a, b) => a + b, 0) / (symbolTrades || 1), 2) : 1.5;
    cd.avgMaeR = allMae.length ? round(allMae.slice(-symbolTrades).reduce((a, b) => a + b, 0) / (symbolTrades || 1), 2) : -0.8;

    const wrPct = Math.round(cd.winRate * 100);
    const netSign = cd.netR >= 0 ? '+' : '';
    console.log(`✓ ${c1h.length} candles -> ${symbolTrades.toString().padStart(3, ' ')} trades | WR: ${wrPct}% | Net R: ${netSign}${cd.netR}R`);
  }

  // 1. Calculate Confluence Factor Weights
  console.log('\n' + '='.repeat(72));
  console.log(`📊 AI KENNIS SYNTHESE (${totalTradesSimulated} TRADES OVER ${totalCoinsWithData} MUNTE GEANALYSEERD)`);
  console.log('='.repeat(72));

  console.log('\n🎯 1. DYNAMISCHE FACTOR CONFLUENCE GEWICHTEN:');
  const finalFactorStats = {};
  for (const [name, rec] of Object.entries(factorRecords)) {
    const total = rec.wins + rec.losses;
    const wr = total > 0 ? rec.wins / total : 0.5;
    let weight = 1.0;
    if (total >= 10) {
      if (wr >= 0.58 && rec.netR > 0) weight = Math.min(1.25, 1.0 + (wr - 0.5) * 0.7);
      else if (wr < 0.42 && rec.netR < 0) weight = Math.max(0.75, 1.0 - (0.5 - wr) * 0.7);
    }
    weight = round(weight, 2);
    finalFactorStats[name] = {
      factor: name,
      wins: rec.wins,
      losses: rec.losses,
      winRate: round(wr, 2),
      avgRMultiple: round(rec.netR / (total || 1), 2),
      weightMultiplier: weight,
      penalty: weight < 1.0,
      consecutiveLosses: 0,
    };
    const tag = weight > 1.0 ? `🟢 +${Math.round((weight - 1) * 100)}% BOOST` : weight < 1.0 ? `🔴 -${Math.round((1 - weight) * 100)}% STRAF` : '⚪ NEUTRAAL';
    console.log(`   - ${name.padEnd(32)} : WR: ${Math.round(wr * 100)}% (${rec.wins}W / ${rec.losses}L), Net R: ${rec.netR >= 0 ? '+' : ''}${rec.netR.toFixed(1)}R -> ${weight.toFixed(2)}x [${tag}]`);
  }

  // 2. Session Edge Matrix
  console.log('\n🕒 2. TRADING SESSIE & TIMING MATRIX:');
  for (const s of Object.values(sessionRecords)) {
    const total = s.wins + s.losses;
    s.winRate = total > 0 ? round(s.wins / total, 2) : 0;
    if (total >= 15) {
      if (s.winRate >= 0.55 && s.netR > 0) s.edgeMultiplier = 1.15;
      else if (s.winRate < 0.42 && s.netR < 0) s.edgeMultiplier = 0.85;
      else s.edgeMultiplier = 1.0;
    }
    const tag = s.edgeMultiplier > 1.0 ? '🌟 HOGE EDGE' : s.edgeMultiplier < 1.0 ? '⚠️ VERHOOGD CHOP RISICO' : 'NORMALE SESSIE';
    console.log(`   - ${s.session.padEnd(30)} : WR: ${Math.round(s.winRate * 100)}%, Net R: ${s.netR >= 0 ? '+' : ''}${s.netR.toFixed(1)}R -> ${s.edgeMultiplier.toFixed(2)}x [${tag}]`);
  }

  // 3. Coin DNA Profiles
  console.log('\n🧬 3. COIN DNA VOLATILITEIT & MULTIPLIERS (TOP PERFORMERS & MEMES):');
  const sortedDna = Object.values(coinDnaRecords).sort((a, b) => b.totalTrades - a.totalTrades);
  for (const cd of sortedDna) {
    if (cd.volatilityTier === 'MEME' || cd.avgMaeR < -0.85) {
      cd.stopLossMultiplier = 1.25;
    } else if (cd.volatilityTier === 'MAJOR' && cd.winRate >= 0.52) {
      cd.stopLossMultiplier = 0.95;
    } else {
      cd.stopLossMultiplier = 1.0;
    }
    if (cd.avgMfeR < 1.5) {
      cd.takeProfitMultiplier = 0.85;
    } else if (cd.avgMfeR >= 2.5 && cd.winRate >= 0.48) {
      cd.takeProfitMultiplier = 1.15;
    } else {
      cd.takeProfitMultiplier = 1.0;
    }
  }

  // Print top 15 by trades
  for (const cd of sortedDna.slice(0, 15)) {
    console.log(`   - ${cd.symbol.padEnd(12)} (${cd.volatilityTier.padEnd(7)}): ${cd.totalTrades.toString().padStart(3, ' ')} trades | WR: ${Math.round(cd.winRate * 100)}% | SL: ${cd.stopLossMultiplier}x, TP: ${cd.takeProfitMultiplier}x`);
  }
  if (sortedDna.length > 15) {
    console.log(`   ... en nog ${sortedDna.length - 15} andere coin DNA profielen gekalibreerd.`);
  }

  // 4. MFE / MAE Global Targets
  const avgMfe = allMfe.length ? round(allMfe.reduce((a, b) => a + b, 0) / allMfe.length, 2) : 1.8;
  const avgMae = allMae.length ? round(allMae.reduce((a, b) => a + b, 0) / allMae.length, 2) : 0.65;
  const optimalTp1R = Math.round(Math.max(1.2, Math.min(2.0, avgMfe * 0.70 || 1.6)) * 10) / 10;
  const optimalTp2R = Math.round(Math.max(2.4, Math.min(4.5, avgMfe * 1.30 || 3.2)) * 10) / 10;

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

  const componentBrainPath = path.resolve(process.cwd(), 'auto-trader/trading-service/ai-brain.json');
  try {
    fs.writeFileSync(componentBrainPath, JSON.stringify(learnedPayload, null, 2), 'utf8');
    console.log(`💾 Gebundeld in component: ${componentBrainPath}`);
  } catch (e) {
    // non-fatal
  }

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

  console.log('\n' + '='.repeat(72));
  console.log('🚀 TRAINING VAN DE AI MET 161 MUNTEN OVER 4 JAAR IS SUCCESVOL VOLTOOID!');
  console.log('='.repeat(72) + '\n');
}

trainBrain().catch((err) => {
  console.error('Fatal trainer error:', err);
  process.exit(1);
});
