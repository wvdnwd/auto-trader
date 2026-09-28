# Traderr Master Architecture & Program Handover Documentation

This is the complete, definitive technical reference and handover document for the **Traderr** Automated Cryptocurrency Perpetual Trading System.

---

## 1. System Overview & Architecture Map

Traderr is an institutional-grade, composable automated perpetual trading system built on **Bit** (Composable Development Platform), designed for 24/7 autonomous execution on Hyperliquid perps.

```
                  ┌─────────────────────────────────────────┐
                  │          React Web Dashboard            │
                  │   http://192.168.1.91:3000 (Vite UI)    │
                  └────────────────────┬────────────────────┘
                                       │ REST / HTTP
                  ┌────────────────────▼────────────────────┐
                  │       API Gateway & Express App         │
                  │   trading-service.app-root.ts (5001)    │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────▼────────────────────┐
                  │             Engine Loop                 │
                  │    engine.ts (15s cycle tick engine)    │
                  └──────┬──────────────────────────┬───────┘
                         │                          │
        ┌────────────────▼──────┐          ┌────────▼──────────────┐
        │     Risk Engine       │          │   Hyperliquid Adapter │
        │        risk.ts        │          │  exchange-adapter.ts  │
        └───────────────────────┘          └───────────────────────┘
```

---

## 2. Directory & Key File Manifest

### A. Core Trading Engine (`auto-trader/trading-service/`)

| File | Responsibilities |
| :--- | :--- |
| `engine.ts` | **Central Event Loop**: Executes market refreshes, reconciles live exchange positions, applies trailing stops, scans candidates, and handles trade entries. |
| `risk.ts` | **Quantitative Risk Engine**: Position sizing, Kelly allocation, correlation group caps, daily loss limits (-5%), ATR stop geometry, TP ladders, and loss-streak throttles. |
| `market-data.ts` | **Market Data Provider**: Fetches real-time candles, tickers, orderbook depth, funding rates, and open interest from Hyperliquid & Binance. |
| `exchange-adapter.ts` | **Live Execution**: Directly places, modifies, and cancels market, limit, stop-loss, and take-profit orders on Hyperliquid perps. |
| `sessions.ts` | **Market Session Engine**: Evaluates UTC market sessions (Asia 00-08, London 08-13, NY 13-21, Pacific Lull 21-24). |
| `market-structure.ts` | **SMC & Price Action**: Identifies Fair Value Gaps (FVG), swing highs/lows, imbalance scalps, and hammer/shooting-star wicks. |
| `trading-service.app-root.ts` | **Express REST API**: Exposes endpoints (`/snapshot`, `/risk`, `/engine/cycle`, `/engine/start`, `/positions/*`). |
| `types.ts` | **Type Definitions**: All TypeScript interfaces for signals, positions, accounts, tickers, risk configs, and events. |

---

### B. Scripts & Automation Tools (`scripts/`)

| File | Purpose | Usage Command |
| :--- | :--- | :--- |
| `ai-strategy-lab.mjs` | **Local RTX 5070 Ti AI Research Lab**: Queries local Ollama (`qwen2.5-coder:7b`) at 125 tokens/sec to generate, backtest, and leaderboard novel trading strategies. | `node scripts/ai-strategy-lab.mjs --iterations 50` |
| `run-backtest.mjs` | **Portfolio Backtester**: Chronologically replays 4 years of 1H candle data across liquid coins with exact execution math. | `node scripts/run-backtest.mjs --symbols NEAR,PEPE,SUI,SOL,BTC --bars 2000` |
| `compare-improvements.mjs` | **Strategy Matrix Tester**: Compares multiple strategy variants side-by-side on the exact same market replay. | `node scripts/compare-improvements.mjs --symbols NEAR,PEPE,SUI,SOL,BTC,ETH,DOGE,AVAX --bars 2000` |
| `train-brain.mjs` | **AI Neural Brain Trainer**: Calibrates indicator weights and scoring parameters from historical trade logs. | `node scripts/train-brain.mjs` |
| `deploy-to-pi.ps1` | **Raspberry Pi Deployment**: Syncs codebase, installs dependencies, compiles Bit components, and restarts PM2 `traderr` process. | `powershell -ExecutionPolicy Bypass -File .\deploy-to-pi.ps1` |

---

## 3. Bit Workspace Rules & Workflows

1. **Validation Check (Mandatory before git commit)**:
   ```bash
   bit validate trading-service
   ```
   *Checks type-correctness, linting, and runs all 322 unit tests.*

2. **Package Management**:
   ```bash
   bit install [package-name]
   ```
   *Never use `npm install`, `yarn`, or `pnpm` directly.*

3. **Do NOT run `bit build`**: Always use `bit validate` instead.

---

## 4. Live Environment & Remote Raspberry Pi

- **Host**: `spiceprice@192.168.1.91`
- **Process Manager**: PM2 process `traderr` (id 0)
- **Live UI**: `http://192.168.1.91:3000`
- **Live Trading API**: `http://192.168.1.91:5001`
- **Exchange**: Hyperliquid Perpetuals (USDC collateral, live equity ~$240).

### Key Pi Management Commands (via SSH):
```powershell
ssh spiceprice@192.168.1.91 "pm2 status"
ssh spiceprice@192.168.1.91 "pm2 logs traderr --lines 50"
ssh spiceprice@192.168.1.91 "pm2 restart traderr"
```

---

## 5. Active Strategy Profile: "High-Win-Rate AI Sniper"

The live system is configured with the parameters discovered by the local GPU AI Strategy Lab:

- **4H EMA200 Macro Trend Alignment**: Longs allowed only when price > 200 EMA. Counter-trend shorts blocked in bullish market regimes.
- **Fast TP1 Profit Lock**:
  - `firstTargetR`: `1.1` (**Banks 65% profit** on initial 1.1R move).
  - `firstTargetPortion`: `0.65`
  - `lockProfitR`: `0.35` (Ratchet stop to **+0.35R in net profit** immediately upon hitting TP1, ensuring trade cannot turn negative).
- **Protective Stop Loss**: `atrStopMultiple: 1.6` (1.6x ATR).
- **Anti-Drawdown Kelly Throttle**: Cuts stake size by -35% after 2 consecutive losses and -55% after 3+ losses.
- **Parabolic Climax Exit**: Tightens Chandelier trailing stop to 0.8x ATR when RSI > 78-80.
- **Relative Strength Filter**: Rejects lagging altcoins on Longs vs BTC.

---

## 6. Local Hardware & Local AI Alpha Lab

- **GPU**: NVIDIA GeForce RTX 5070 Ti (16 GB VRAM, CUDA 13.0).
- **Ollama Local Server**: `http://localhost:11434` (Running `qwen2.5-coder:7b` & `qwen3.5:9b` at 125 tokens/sec).
- **Leaderboard Output**: `data/ai_strategy_leaderboard.json`.

### How to Run 24/7 AI Research:
```powershell
cd C:\Users\Gebruiker\Desktop\traderr
node scripts/ai-strategy-lab.mjs --iterations 100
```

---

## 7. Master Handover Prompt for Any Incoming AI Agent

To hand over execution to any new AI agent, provide this exact prompt:

```markdown
You are taking over the Traderr codebase. Read HANDOVER.md at the root of c:\Users\Gebruiker\Desktop\traderr to understand the full program architecture.

Current Status:
- Repository: c:\Users\Gebruiker\Desktop\traderr (Bit workspace)
- Validation: Run 'bit validate trading-service' (must pass 322 tests with 0 type errors).
- Live Host: Raspberry Pi at spiceprice@192.168.1.91 running PM2 process 'traderr'.
- Live Exchange: Hyperliquid Perpetuals (~$240 USDC equity).
- Active Strategy: High-Win-Rate AI Sniper (TP1 at 1.1R banking 65%, lock at +0.35R, 4H EMA200 trend alignment).
- Local AI: RTX 5070 Ti running Ollama at http://localhost:11434 (scripts/ai-strategy-lab.mjs).

Follow the rules in HANDOVER.md and AGENTS.md for all code modifications, backtests, and live deployments.
```
