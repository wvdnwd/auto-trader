# Traderr Project & AI Agent Handover Documentation

This document provides a comprehensive handover for any incoming AI agent or developer to take over the **Traderr** algorithmic perpetual trading system seamlessly.

---

## 1. System Architecture & Environment

| Component | Location / Host | Details |
| :--- | :--- | :--- |
| **Codebase Root** | `c:\Users\Gebruiker\Desktop\traderr` | Bit workspace (`workspace.jsonc`, `.bitmap`). Main branch on git `origin/main`. |
| **Trading Service** | `auto-trader/trading-service/` | TypeScript core engine, risk manager, exchange adapters, market structure analyzers. |
| **Trader App** | `auto-trader/trader-app/` | React dashboard UI (Vite + Bit). |
| **Raspberry Pi Remote** | `spiceprice@192.168.1.91` | PM2 process `traderr` running 24/7. Backend: `http://localhost:5001`, Gateway: `5000`, UI: `http://192.168.1.91:3000`. |
| **Live Exchange** | Hyperliquid Perpetuals | USDC-settled perps (live equity ~$240). |
| **Local AI Hardware** | Local PC (RTX 5070 Ti 16GB) | Ollama running locally at `http://localhost:11434` (~125 tokens/sec). |

---

## 2. Bit Workspace Rules (CRITICAL)

- **Always use `bit validate`**: Runs fast linting, type-checking, and 322 unit tests. Never run `bit build` or `tsc`.
- **Always use `bit install`**: Never use `npm install`, `yarn`, or `pnpm` directly unless specified.
- **Run validation before push**:
  ```bash
  bit validate trading-service
  ```

---

## 3. Current Live Trading Engine & Risk Profile

The live engine on the Pi (`spiceprice@192.168.1.91`) is running the **High-Win-Rate AI Sniper** configuration:

- **4H Macro Trend Confluence**: Longs require price > 200 EMA (1H timeframe). Shorts blocked in bullish macro regimes.
- **Fast TP1 Profit Lock**:
  - `firstTargetR`: `1.1` (Banks **65% profit** on first 1.1R move).
  - `lockProfitR`: `0.35` (Ratchet stop to **+0.35R in net profit** immediately upon hitting TP1, making loss impossible).
  - `firstTargetPortion`: `0.65`
- **Stop Loss**: `atrStopMultiple: 1.6` (1.6x ATR).
- **Anti-Drawdown Kelly Throttle**: Cuts stake size by -35% after 2 consecutive losses and -55% after 3+ losses.
- **Parabolic Climax Trailing**: Tightens Chandelier trailing stop to 0.8x ATR when RSI > 78-80.
- **Relative Strength Filter**: Rejects lagging altcoins on Longs vs Bitcoin.
- **Daily Limit Resync**: Live starting balance is automatically resynced to actual exchange equity ($240+).

---

## 4. Local AI Strategy Lab (NVIDIA RTX 5070 Ti & Ollama)

The PC has a **GeForce RTX 5070 Ti (16 GB VRAM)** running **Ollama** locally at 125 tokens/second (100% free, 0 API tokens used).

### Local Models Available:
- `qwen2.5-coder:7b-instruct-q5_K_M`
- `qwen3.5:9b`
- `qwen2.5-coder:32b`
- `llama3.3:70b`

### How to Run Local AI Strategy Exploration:
```powershell
cd C:\Users\Gebruiker\Desktop\traderr
node scripts/ai-strategy-lab.mjs --iterations 50
```
- Explores 5 archetypes: `TREND_SNIPER`, `MEAN_REVERSION`, `VOLATILITY_SQUEEZE`, `LIQUIDITY_SWEEP`, `PARABOLIC_BLOWOFF_SHORT`.
- Leaderboard saved at: `data/ai_strategy_leaderboard.json`

### Top AI Discoveries currently on Leaderboard:
1. **High-Rate, High-ROI Scalper**: **85.7% Win Rate (6W / 1L)** | Profit Factor 5.28 | +31.2% ROI
2. **Enhanced Hybrid Scalper**: **75.0% Win Rate (9W / 3L)** | Profit Factor 3.41 | +37.7% ROI
3. **High Winrate Scalper Plus X**: **68.8% Win Rate (11W / 5L)** | Profit Factor 2.76 | +32.9% ROI

---

## 5. Useful Commands & Workflows

### A. Inspect Live Pi Status:
```powershell
ssh spiceprice@192.168.1.91 "pm2 status"
curl -s http://192.168.1.91:5001/snapshot
```

### B. Update Risk Config Live on Pi:
```bash
node -e "fetch('http://192.168.1.91:5001/risk', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ ignoreDailyLimit: true, firstTargetR: 1.1, firstTargetPortion: 0.65 }) }).then(r=>r.json()).then(console.log)"
```

### C. Run Local Backtests:
```powershell
node scripts/run-backtest.mjs --symbols NEAR,PEPE,SUI,SOL,BTC --bars 2000 --balance 100
node scripts/compare-improvements.mjs --symbols NEAR,PEPE,SUI,SOL,BTC,ETH,DOGE,AVAX --bars 2000
```

### D. Deploy Code to Raspberry Pi:
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-to-pi.ps1
# Input when prompted: spiceprice@192.168.1.91
```

---

## 6. Pending Next Steps & Roadmap

1. **Monitor Live Execution**: Observe the live trades on Hyperliquid via dashboard `http://192.168.1.91:3000`.
2. **Local AI Exploration**: Run `node scripts/ai-strategy-lab.mjs --iterations 100` overnight to let the RTX 5070 Ti discover new high-winrate mean reversion setups.
3. **Deploy Top Leaderboard Winners**: If a new AI strategy on `data/ai_strategy_leaderboard.json` beats 85.7% Win Rate, apply its JSON parameters via `POST http://192.168.1.91:5001/risk`.
