# Strategy Research Summary — Regime-Filtered Daily Trend Breakout

Research only. Nothing here enables live trading, and none of these figures are a
guarantee of future performance.

## Method

- **Data**: cached 1H candles in `data/candles_cache/` (145 symbols in the BROAD
  universe, 50 in the LONG universe used for validation). Global timeline
  **2022-08-20 → 2026-09-28 (~4.1 years, 36,000 hourly bars)**.
- **No look-ahead**: signals are computed on bar `i` close using only data up to
  `i`; orders fill at bar `i+1` open; intrabar stops/targets use high/low with a
  conservative stop-first tie rule; higher-timeframe bars are read only after
  their bucket has closed.
- **Costs (charged on both entry and exit notional, plus funding)**:
  - taker fee **0.045% per side**
  - slippage **0.03% per side**, adverse to the trade
  - round-trip explicit cost **≈0.15% of notional**
  - funding **≈0.0001 per 8h ≈ 0.03%/day** on open notional (**approximated** —
    the cache has no funding series; charged as `notional × 0.0001 / 8` per open
    1H bar)
- **Risk model**: 1% of current equity risked per trade (distance to initial
  stop); 5× leverage cap; **25% of equity per-position notional cap** (this binds
  before the 5× cap); at most 5 concurrent positions; one position per symbol;
  $10,000 starting equity.
- Scripts: `scripts/strategy-research-lab.mjs` (archetypes),
  `scripts/strategy-optimizer.mjs` (parameter grid + IS/OOS),
  `scripts/strategy-validation.mjs` (fixed-config robustness).
  Raw results: `data/strategy_research_results.json`,
  `data/strategy_optimizer_results.json`, `data/strategy_validation_results.json`.

## The four archetypes (full 4.1-year run, costs ON)

| # | Archetype | Trades | WR | PF | Exp R | ROI | MaxDD |
| - | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | MTF trend + volatility breakout (regime gate, Donchian/Keltner breakout, ATR% expansion, Donchian(10) trail) | 3,778 | 29.8% | 0.874 | −0.018 | −68.2% | 82.0% |
| B | Mean-reversion sweep (range regime, sweep + reclaim, SMA20 target, 48-bar time stop) | 39 | 41.0% | 0.958 | −0.058 | −0.5% | 4.9% |
| C | Trend pyramid + ATR trail (breakout, up to 3 adds, chandelier 3×ATR22) | 3,286 | 19.8% | 0.855 | −0.350 | −84.5% | 95.5% |
| D | Cross-sectional vol-weighted RS momentum (top-RS selection, EMA20/chandelier trail) | 6,777 | 39.1% | 0.798 | −0.074 | −97.0% | 97.5% |
| — | Blend A+C+D | 9,283 | 31.6% | 0.722 | −0.121 | −99.5% | 99.7% |
| — | Blend A+B+C+D | 9,302 | 31.6% | 0.720 | −0.120 | −99.5% | 99.6% |

**Finding**: over the full 4.1 years with realistic costs, **none of the four
archetypes keeps a positive edge** (every PF is below 1.0). The short-window
results below are the only place the edge appears.

## Optimizer / out-of-sample result

- Split: in-sample 2022-08-20 → 2024-12-31; **out-of-sample 2025-01-01 →
  2026-09-28 (~21 months)**.
- Selected combo `TC-1D-c-N55-LS-P3` (1D, BTC regime, Donchian(55)/Keltner
  breakout, 3×ATR stop, Donchian(10) trail, long/short, **no partial**):
  **n=72, WR 34.7%, PF 2.549, ROI +40.7%, MaxDD 22.0%** (reproduced exactly by
  the independent validation script).
- Partial take-profit sweep on the same OOS window:

| Variant | Trades | WR | PF | ROI | MaxDD |
| --- | ---: | ---: | ---: | ---: | ---: |
| A0 base (no partial) | 72 | 34.7% | 2.549 | +40.7% | 22.0% |
| A1R — bank 1/3 @ +1R, stop→BE | 73 | **43.8%** | **2.222** | +28.1% | **15.5%** |
| A2R — bank 1/3 @ +2R | 73 | 35.6% | 2.098 | +27.3% | 15.4% |
| A3R — bank 1/3 @ +3R | 72 | 34.7% | 2.204 | +30.2% | 17.1% |

## Rolling walk-forward instability

The fixed configuration was rolled through 14 six-month windows (stepped forward
3 months) **without re-fitting** — a stability test, not an optimisation:

- **5 of 14 windows were negative** (PF < 1.0): `2023-04..2023-10`,
  `2024-01..2024-07`, `2024-04..2024-10`, `2025-01..2025-07`,
  `2025-04..2025-10`.
- 9/14 windows had PF > 1.5; only 6/14 had PF > 2.0.
- Median window PF **1.873**; pooled win rate **36.3%** over 292 trades.
- Worst window by PF: `2025-01..2025-07` — 0% WR, PF 0, ROI −4.7% (9 trades, all
  long). Worst by drawdown: `2025-07..2026-01` — MaxDD 21.5%.
- Verdict: **unstable** (more than one negative window) → recommendation
  downgraded.

## The WR / PF / DD trade-off

There is no free lunch between win rate and profitability:

- The no-partial base has the best PF and ROI but the worst win rate (34.7%) and
  a 22.0% drawdown.
- Banking 1/3 at +1R and moving the stop to breakeven **raises win rate to 43.8%
  and cuts MaxDD to 15.5%**, at the cost of PF (2.549 → 2.222) and ROI
  (40.7% → 28.1%). This is the configuration implemented in `regime-trend.ts`.
- The best drawdown-adjusted variant at WR ≥ 45% was `E-s2-chand3` (2×ATR stop,
  chandelier 3×ATR22 trail): WR 45.9%, PF 1.721, MaxDD 13.3%, n=85.
- 9 of 24 OOS variants met both PF ≥ 2.0 and MaxDD ≤ 25%.

**Explicitly not achieved**: no variant — at any trade count — reached
**PF ≥ 2.0 AND WR ≥ 50% AND MaxDD ≤ 25% simultaneously**. The PF/DD target is
reachable; the additional 50% win-rate constraint is not.

## Selected tactic

Implemented as a standalone, pure module in
`auto-trader/trading-service/regime-trend.ts`:

- **Regime**: BTC 1D EMA(50) vs EMA(200) — longs above, shorts below, flat
  (within tolerance) is rejected.
- **Entry**: 1D close > Donchian(55) high OR close > Keltner(EMA20, 2×ATR14),
  gated by ATR%(14) > 50-bar rolling median (volatility expansion).
- **Stop**: 3 × ATR(14).
- **Partial**: bank 1/3 at +1R, move stop to breakeven, trail the remainder.
- **Trail**: Donchian(10) opposite side (chandelier 3×ATR22 available as an
  option).
- **Sizing**: fixed 1% risk, long/short, 5× leverage cap and 25% notional cap.

Measured OOS profile (costs on): **PF 2.22, WR 43.8%, MaxDD 15.5%, 73 trades,
ROI +28.1%**.

## Caveats

- **Survivorship bias**: the cached symbol list is today's universe; symbols that
  were delisted or never listed are absent. This biases the cross-sectional (D)
  results optimistically.
- **1H granularity only**: intrabar sequencing uses high/low with a stop-first
  assumption; there is no tick or order-book data.
- **Funding is approximated**: no funding series exists in the cache.
- **Multiple-comparison / overfitting risk**: 24 configurations were evaluated on
  a single fixed OOS window, and the chosen variant is selected on the same data
  it is judged on. Treat the single best as partly in-sample; weight the rolling
  walk-forward and cross-universe results more heavily.
- **Instability**: 5/14 rolling windows were negative, so the tactic is
  best-evidenced rather than robustly validated.
- **Small sample**: 73 OOS trades; short-window figures (including the headline
  PF 2.22 / WR 43.8%) do not generalise on their own.
- These are **research estimates, not a guarantee**. No live-trading change should
  be made on this evidence alone.
