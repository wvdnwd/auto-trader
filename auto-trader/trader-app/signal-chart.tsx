import { useMemo, useState } from 'react';
import styles from './signal-chart.module.css';
import { price as fmtPrice, shortDate } from './format.js';
import type { Candle, Position, Signal, TradePlan } from './types.js';

/** Props for {@link SignalChart}. */
export type SignalChartProps = {
  /** Entry-timeframe candles the strategy scores, oldest first. */
  candles: Candle[];
  /** The current signal for this symbol, used to draw the swing, golden zone and checks. */
  signal: Signal | null;
  /** Contract symbol, e.g. `BTC_USDT`, used only for the aria-label. */
  symbol: string;
  /** Active open position for this symbol, if any. */
  position?: Position | null;
  /** Planned trade with TP ladder and SL, if computable. */
  plannedTrade?: TradePlan | null;
};

const W = 760;
const H = 400;
const PAD = { top: 22, right: 120, bottom: 26, left: 65 };

/**
 * Build a plain-language explanation of what the engine is waiting for on
 * this symbol, from the same named checks shown in the scanner list.
 *
 * @param signal the signal to explain, or null when there is not enough data.
 * @returns one sentence per unmet condition; empty when everything passed.
 */
export function waitingOn(signal: Signal | null): string[] {
  if (!signal) return ['Nog niet genoeg candles om een signaal te berekenen.'];
  const failed = (signal.checks || []).filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  if (signal.checks?.some((c) => c.name === 'Hoger tijdsframe' && c.passed) && !signal.alignedWithHigher) {
    failed.unshift(
      `Hoger tijdsframe bevestigt nog niet: 4u-regime is ${signal.higherRegime}, moet ${
        signal.side === 'LONG' ? 'TREND_UP' : 'TREND_DOWN'
      } zijn voor een instap.`
    );
  }
  return failed;
}

/**
 * Candlestick chart of the exact data the strategy is scoring, with the swing
 * high/low, Fibonacci golden zone, current price, TP1/TP2/TP3 targets, Stop Loss,
 * and an expected price trajectory projection drawn on top.
 */
export function SignalChart({ candles = [], signal, symbol, position, plannedTrade }: SignalChartProps) {
  const [showTargets, setShowTargets] = useState(true);
  const [showRoute, setShowRoute] = useState(true);
  const [showFib, setShowFib] = useState(true);
  const [showStructure, setShowStructure] = useState(true);

  const chart = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const validCandles = candles.filter(
      (c) =>
        c &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.close)
    );
    if (validCandles.length < 2) return null;
    const recent = validCandles.slice(-100);
    const highs = recent.map((c) => c.high);
    const lows = recent.map((c) => c.low);
    let lo = Math.min(...lows);
    let hi = Math.max(...highs);

    if (signal?.fib) {
      if (Number.isFinite(signal.fib.swingLow)) lo = Math.min(lo, signal.fib.swingLow);
      if (Number.isFinite(signal.fib.swingHigh)) hi = Math.max(hi, signal.fib.swingHigh);
    }

    // Determine entry reference price
    const lastClose = recent[recent.length - 1]?.close;
    const rawEntry = position?.entry ?? plannedTrade?.entry ?? signal?.price ?? lastClose;
    const entryPrice = Number.isFinite(rawEntry) && rawEntry > 0 ? rawEntry : lastClose;
    const side = position?.side ?? plannedTrade?.side ?? signal?.side ?? 'LONG';
    const dir = side === 'LONG' ? 1 : -1;

    // Determine Stop Loss
    let slPrice: number | undefined = position?.stopLoss ?? plannedTrade?.stopLoss;
    if (slPrice === undefined && signal && Number.isFinite(signal.price) && signal.price > 0) {
      const stopDist = Math.max(0.015, (signal.atrPct || 0.02) * 1.5);
      slPrice = signal.price * (1 - dir * stopDist);
    }

    // Determine Take Profit targets
    let tps: Array<{ price: number; portion?: number; rMultiple?: number; hit?: boolean; label: string }> = [];
    if (position?.takeProfits?.length) {
      tps = position.takeProfits
        .filter((t) => Number.isFinite(t.price) && t.price > 0)
        .map((t, idx) => ({
          price: t.price,
          portion: t.portion,
          rMultiple: t.rMultiple,
          hit: t.hit,
          label: `TP${idx + 1}`,
        }));
    } else if (plannedTrade?.takeProfits?.length) {
      tps = plannedTrade.takeProfits
        .filter((t) => Number.isFinite(t.price) && t.price > 0)
        .map((t, idx) => ({
          price: t.price,
          portion: t.portion,
          rMultiple: t.rMultiple,
          hit: false,
          label: `TP${idx + 1}`,
        }));
    } else if (signal && Number.isFinite(signal.price) && signal.price > 0) {
      const stopDist = Math.max(0.015, (signal.atrPct || 0.02) * 1.5);
      tps = [
        { price: signal.price * (1 + dir * stopDist * 1.5), portion: 0.33, rMultiple: 1.5, hit: false, label: 'TP1' },
        { price: signal.price * (1 + dir * stopDist * 2.5), portion: 0.33, rMultiple: 2.5, hit: false, label: 'TP2' },
        { price: signal.price * (1 + dir * stopDist * 3.5), portion: 0.34, rMultiple: 3.5, hit: false, label: 'TP3' },
      ];
    }

    // CRITICAL: Sort tps strictly outward from entryPrice, then assign TP1, TP2, TP3...
    // This guarantees TP1 is always the closest milestone, and prevents zigzag curves.
    const sortedTps = [...tps].sort((a, b) => (side === 'LONG' ? a.price - b.price : b.price - a.price));
    tps = sortedTps.map((t, idx) => ({
      ...t,
      label: `TP${idx + 1}`,
    }));

    // Expand span to fit targets and stop
    if (slPrice !== undefined && Number.isFinite(slPrice) && slPrice > 0) {
      lo = Math.min(lo, slPrice);
      hi = Math.max(hi, slPrice);
    }
    for (const tp of tps) {
      if (Number.isFinite(tp.price) && tp.price > 0) {
        lo = Math.min(lo, tp.price);
        hi = Math.max(hi, tp.price);
      }
    }

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      lo = 0.95 * (lastClose || 100);
      hi = 1.05 * (lastClose || 100);
    }

    const span = hi - lo || Math.max(1, hi * 0.01);
    lo -= span * 0.05;
    hi += span * 0.05;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const slot = innerW / recent.length;
    const bodyW = Math.max(1, slot * 0.6);
    const x = (i: number) => PAD.left + i * slot + slot / 2;
    const y = (v: number) => {
      if (!Number.isFinite(v)) return PAD.top;
      const normalized = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
      return PAD.top + (1 - normalized) * innerH;
    };

    const candlesXY = recent.map((c, i) => ({
      x: x(i),
      openY: y(c.open),
      closeY: y(c.close),
      highY: y(c.high),
      lowY: y(c.low),
      up: c.close >= c.open,
      time: c.time,
    }));

    const goldenTop = signal?.fib?.retracements?.find((l) => l.ratio === 0.382)?.price;
    const goldenBottom = signal?.fib?.retracements?.find((l) => l.ratio === 0.618)?.price;

    const inRange = (v: number) => Number.isFinite(v) && v >= PAD.top - 0.5 && v <= H - PAD.bottom + 0.5;

    const fibAnchorLines: Array<{ label: string; ratio: number; price: number; y: number }> = [];
    if (signal?.fib) {
      const isUp = signal.fib.direction === 'UP';
      const topPrice = signal.fib.swingHigh;
      const botPrice = signal.fib.swingLow;
      if (Number.isFinite(topPrice) && Number.isFinite(botPrice)) {
        const topY = y(topPrice);
        const botY = y(botPrice);
        if (inRange(topY)) {
          fibAnchorLines.push({
            label: isUp ? 'Fib 0.000 Top' : 'Fib 1.000 Top',
            ratio: isUp ? 0 : 1,
            price: topPrice,
            y: topY,
          });
        }
        if (inRange(botY)) {
          fibAnchorLines.push({
            label: isUp ? 'Fib 1.000 Bodem' : 'Fib 0.000 Bodem',
            ratio: isUp ? 1 : 0,
            price: botPrice,
            y: botY,
          });
        }
      }
    }

    const retracementLines = (signal?.fib?.retracements || [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => ({ ratio: l.ratio, price: l.price, y: y(l.price) }))
      .filter((l) => inRange(l.y));

    const extensionLines = (signal?.fib?.extensions || [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => ({ ratio: l.ratio, price: l.price, y: y(l.price) }))
      .filter((l) => inRange(l.y));

    const ticks = [hi, (hi + lo) / 2, lo].map((v) => ({ v, y: y(v) }));
    const firstLabel = recent[0]?.time ? shortDate(recent[0].time) : '';
    const lastLabel = recent[recent.length - 1]?.time ? shortDate(recent[recent.length - 1].time) : '';

    const goldenLow =
      goldenBottom !== undefined && goldenTop !== undefined ? Math.min(goldenBottom, goldenTop) : undefined;
    const goldenHigh =
      goldenBottom !== undefined && goldenTop !== undefined ? Math.max(goldenBottom, goldenTop) : undefined;

    // Calculate TP and SL lines with Y coordinates and relative %
    const tpLines = tps.map((tp) => {
      const pct = entryPrice > 0 ? ((tp.price - entryPrice) / entryPrice) * 100 : 0;
      return {
        label: tp.label,
        price: tp.price,
        y: y(tp.price),
        hit: tp.hit,
        pct: Number.isFinite(pct) ? pct : 0,
      };
    });

    const slLine =
      slPrice !== undefined && Number.isFinite(slPrice) && slPrice > 0
        ? {
            price: slPrice,
            y: y(slPrice),
            pct: entryPrice > 0 ? ((slPrice - entryPrice) / entryPrice) * 100 : 0,
          }
        : undefined;

    const pocPrice = signal?.marketStructure?.volumeProfile?.poc;
    const pocY = pocPrice !== undefined && inRange(y(pocPrice)) ? y(pocPrice) : undefined;

    // Generate expected price trajectory curve
    let trajectoryPath = '';
    const trajectoryPoints: Array<{ x: number; y: number; label: string }> = [];

    if (candlesXY.length > 0 && tps.length > 0) {
      const last = candlesXY[candlesXY.length - 1];
      const startX = last.x;
      const startY = last.closeY;
      const entryY = y(entryPrice);

      const p1X = startX + 25;
      const p1Y = entryY;
      trajectoryPoints.push({ x: p1X, y: p1Y, label: 'Instap' });

      const tp1Y = tps[0] ? y(tps[0].price) : entryY;
      const p2X = startX + 50;
      trajectoryPoints.push({ x: p2X, y: tp1Y, label: 'TP1' });

      const tp2Y = tps[1] ? y(tps[1].price) : tp1Y;
      const p3X = startX + 75;
      trajectoryPoints.push({ x: p3X, y: tp2Y, label: 'TP2' });

      const tp3Y = tps[2] ? y(tps[2].price) : tp2Y;
      const p4X = Math.min(W - PAD.right - 10, startX + 100);
      trajectoryPoints.push({ x: p4X, y: tp3Y, label: 'TP3' });

      if ([startX, startY, p1X, p1Y, p2X, tp1Y, p3X, tp2Y, p4X, tp3Y].every((n) => Number.isFinite(n))) {
        trajectoryPath = `M ${startX} ${startY} Q ${p1X} ${p1Y} ${p2X} ${tp1Y} T ${p3X} ${tp2Y} T ${p4X} ${tp3Y}`;
      }
    }

    return {
      candlesXY,
      bodyW,
      ticks,
      firstLabel,
      lastLabel,
      side,
      entryPrice,
      priceY: signal && Number.isFinite(signal.price) ? y(signal.price) : undefined,
      swingLowY: signal && Number.isFinite(signal.swingLow) ? y(signal.swingLow) : undefined,
      swingHighY: signal && Number.isFinite(signal.swingHigh) ? y(signal.swingHigh) : undefined,
      goldenTopY: goldenTop !== undefined ? y(goldenTop) : undefined,
      goldenBottomY: goldenBottom !== undefined ? y(goldenBottom) : undefined,
      goldenLow,
      goldenHigh,
      pocPrice,
      pocY,
      fibAnchorLines,
      fibDirection: signal?.fib?.direction,
      fibSwingHigh: signal?.fib?.swingHigh,
      fibSwingLow: signal?.fib?.swingLow,
      retracementLines,
      extensionLines,
      tpLines,
      slLine,
      trajectoryPath,
      trajectoryPoints,
    };
  }, [candles, signal, position, plannedTrade]);

  const notes = waitingOn(signal);

  if (!chart) {
    return <p className={styles.empty}>Te weinig candles om een grafiek te tekenen.</p>;
  }

  const isLong = chart.side === 'LONG';

  // Left-side label collision resolution: structure lines vs fib anchors
  const topAnchor = chart.fibAnchorLines.find((a) => a.ratio === 0 || a.label.includes('Top'));
  const botAnchor = chart.fibAnchorLines.find((a) => a.ratio === 1 || a.label.includes('Bodem'));

  let swingHighLabelY = chart.swingHighY !== undefined ? chart.swingHighY - 4 : undefined;
  let fibTopLabelY = topAnchor ? topAnchor.y - 4 : undefined;
  if (
    showStructure &&
    showFib &&
    chart.swingHighY !== undefined &&
    topAnchor &&
    Math.abs(chart.swingHighY - topAnchor.y) < 16
  ) {
    swingHighLabelY = chart.swingHighY - 6;
    fibTopLabelY = topAnchor.y + 11;
  }

  let swingLowLabelY = chart.swingLowY !== undefined ? chart.swingLowY - 4 : undefined;
  let fibBotLabelY = botAnchor ? botAnchor.y - 4 : undefined;
  if (
    showStructure &&
    showFib &&
    chart.swingLowY !== undefined &&
    botAnchor &&
    Math.abs(chart.swingLowY - botAnchor.y) < 16
  ) {
    swingLowLabelY = chart.swingLowY + 11;
    fibBotLabelY = botAnchor.y - 6;
  }

  // Right-side collision tracker: ensure TP/SL always have priority
  const occupiedRightY: number[] = [];
  if (showTargets) {
    chart.tpLines.forEach((t) => {
      if (Number.isFinite(t.y)) occupiedRightY.push(t.y);
    });
    if (chart.slLine && Number.isFinite(chart.slLine.y)) occupiedRightY.push(chart.slLine.y);
  }

  const canShowFibLabel = (y: number, ratio: number) => {
    if (!Number.isFinite(y)) return false;
    const isKey = [0.236, 0.382, 0.5, 0.618, 0.786, 1.272, 1.618].some((r) => Math.abs(r - ratio) < 0.005);
    if (!isKey) return false;
    if (occupiedRightY.some((oy) => Math.abs(oy - y) < 14)) return false;
    occupiedRightY.push(y);
    return true;
  };

  return (
    <div className={styles.wrap}>
      {/* Visual Prediction Banner */}
      <div className={`${styles.projectionCard} ${isLong ? '' : styles.projectionCardShort}`}>
        <div className={styles.projectionTitle}>
          <span>{isLong ? '🚀' : '🔻'}</span>
          <span>
            <b>Verwachte koersroute ({chart.side}):</b>{' '}
            {isLong
              ? 'Consolidatie/pullback in instapzone ➔ opwaartse impuls richting TP1, TP2 en TP3'
              : 'Pullback/afwijzing bij weerstand ➔ neerwaartse impuls richting TP1, TP2 en TP3'}
          </span>
        </div>
        <div className={styles.projectionTargets}>
          {chart.tpLines.map((tp) => (
            <span key={tp.label} className={styles.projectionBadge}>
              🎯 <b>{tp.label}:</b> {fmtPrice(tp.price)} ({tp.pct >= 0 ? '+' : ''}
              {tp.pct.toFixed(1)}%) {tp.hit ? '✅ (Geraakt)' : ''}
            </span>
          ))}
          {chart.slLine && (
            <span className={styles.projectionBadge}>
              🛡️ <b>Stop Loss:</b> {fmtPrice(chart.slLine.price)} ({chart.slLine.pct >= 0 ? '+' : ''}
              {chart.slLine.pct.toFixed(1)}%)
            </span>
          )}
          {signal?.marketStructure?.smtDivergence && (
            <span className={styles.projectionBadge} style={{ borderColor: '#a855f7', color: '#c084fc' }}>
              ⚡ <b>SMT {signal.marketStructure.smtDivergence.type}:</b> {signal.marketStructure.smtDivergence.reason}
            </span>
          )}
        </div>
      </div>

      {/* Fibonacci Analysis & Golden Zone Status Card */}
      {chart.goldenLow !== undefined && chart.goldenHigh !== undefined && (
        <div className={styles.fibCard}>
          <div className={styles.fibTitle}>
            <span>📏</span>
            <span>
              <b>Fibonacci Analyse ({chart.fibDirection === 'UP' ? 'Opwaartse impuls' : 'Neerwaartse impuls'}):</b>{' '}
              {(() => {
                const p = signal?.price ?? 0;
                if (p >= chart.goldenLow && p <= chart.goldenHigh) {
                  return '🎯 Koers bevindt zich nu in de Golden Zone (0.382–0.618) — sterke reactiezone!';
                }
                if (chart.side === 'LONG') {
                  return p > chart.goldenHigh
                    ? '⏳ Koers staat boven de Golden Zone — wacht op pullback richting de zone.'
                    : '⚠️ Koers is onder de Golden Zone gezakt.';
                }
                return p < chart.goldenLow
                  ? '⏳ Koers staat onder de Golden Zone — wacht op pullback omhoog richting de zone.'
                  : '⚠️ Koers is boven de Golden Zone gestegen.';
              })()}
            </span>
          </div>
          <div className={styles.fibDetails}>
            <span className={styles.fibBadge}>
              🟡 <b>Golden Zone:</b> {fmtPrice(chart.goldenLow)} – {fmtPrice(chart.goldenHigh)}
            </span>
            {chart.fibSwingHigh !== undefined && chart.fibSwingLow !== undefined && (
              <span className={styles.fibBadge}>
                📍 <b>Impuls bereik:</b> {fmtPrice(chart.fibSwingLow)} ➔ {fmtPrice(chart.fibSwingHigh)}
              </span>
            )}
            {signal && (
              <span className={styles.fibBadge}>
                🛡️ <b>Stop anchor (structuur):</b>{' '}
                {chart.side === 'LONG' ? fmtPrice(signal.swingLow) : fmtPrice(signal.swingHigh)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Layer Filter Toolbar */}
      <div className={styles.filterBar}>
        <span className={styles.filterTitle}>Lagen:</span>
        <button
          type="button"
          className={`${styles.filterBtn} ${showTargets ? styles.filterBtnActive : ''}`}
          onClick={() => setShowTargets(!showTargets)}
        >
          🎯 Doelen (TP/SL)
        </button>
        <button
          type="button"
          className={`${styles.filterBtn} ${showRoute ? styles.filterBtnActive : ''}`}
          onClick={() => setShowRoute(!showRoute)}
        >
          🚀 Koersroute
        </button>
        <button
          type="button"
          className={`${styles.filterBtn} ${showFib ? styles.filterBtnActive : ''}`}
          onClick={() => setShowFib(!showFib)}
        >
          📏 Fibonacci
        </button>
        <button
          type="button"
          className={`${styles.filterBtn} ${showStructure ? styles.filterBtnActive : ''}`}
          onClick={() => setShowStructure(!showStructure)}
        >
          🧱 Structuur
        </button>
      </div>

      <svg
        className={styles.chart}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Candlestick grafiek van ${symbol.replace('_', '/')}`}
      >
        <defs>
          <marker
            id="arrow-long"
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#22c55e" />
          </marker>
          <marker
            id="arrow-short"
            viewBox="0 0 10 10"
            refX="6"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ef4444" />
          </marker>
        </defs>

        {chart.ticks.map((t) => (
          <g key={t.v}>
            <line x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} className={styles.gridLine} />
            <text x={PAD.left - 8} y={t.y + 3} textAnchor="end" className={styles.axisLabel}>
              {fmtPrice(t.v)}
            </text>
          </g>
        ))}

        {showFib && chart.goldenTopY !== undefined && chart.goldenBottomY !== undefined && (
          <rect
            x={PAD.left}
            y={Math.min(chart.goldenTopY, chart.goldenBottomY)}
            width={W - PAD.left - PAD.right}
            height={Math.max(2, Math.abs(chart.goldenBottomY - chart.goldenTopY))}
            className={styles.goldenZone}
          />
        )}

        {/* Fibonacci Anchor Lines (0.000 Top & 1.000 Bodem) */}
        {showFib &&
          chart.fibAnchorLines.map((a) => {
            const isTop = a.ratio === 0 || a.label.includes('Top');
            const labelY = isTop ? (fibTopLabelY ?? a.y - 3) : (fibBotLabelY ?? a.y - 3);
            return (
              <g key={a.label}>
                <line
                  x1={PAD.left}
                  y1={a.y}
                  x2={W - PAD.right}
                  y2={a.y}
                  className={styles.fibRetracement}
                  style={{ strokeWidth: 1.2, strokeDasharray: '4 2', opacity: 0.85 }}
                />
                <text
                  x={PAD.left + 6}
                  y={labelY}
                  textAnchor="start"
                  className={styles.fibLabel}
                  style={{ fontWeight: 600, fill: '#fbbf24' }}
                >
                  {a.label}: {fmtPrice(a.price)}
                </text>
              </g>
            );
          })}

        {/* Structure Support / Resistance lines (Stop anchors) */}
        {showStructure && chart.swingHighY !== undefined && signal && (
          <g>
            <line
              x1={PAD.left}
              y1={chart.swingHighY}
              x2={W - PAD.right}
              y2={chart.swingHighY}
              className={styles.swingLine}
            />
            <text
              x={PAD.left + 6}
              y={swingHighLabelY ?? chart.swingHighY - 3}
              className={styles.axisLabel}
              style={{ fill: '#60a5fa', fontWeight: 600 }}
            >
              Weerstand (structuur): {fmtPrice(signal.swingHigh)}
            </text>
          </g>
        )}
        {showStructure && chart.swingLowY !== undefined && signal && (
          <g>
            <line
              x1={PAD.left}
              y1={chart.swingLowY}
              x2={W - PAD.right}
              y2={chart.swingLowY}
              className={styles.swingLine}
            />
            <text
              x={PAD.left + 6}
              y={swingLowLabelY ?? chart.swingLowY - 3}
              className={styles.axisLabel}
              style={{ fill: '#60a5fa', fontWeight: 600 }}
            >
              Steun (structuur): {fmtPrice(signal.swingLow)}
            </text>
          </g>
        )}

        {/* Volume Profile Point of Control (POC) */}
        {chart.pocY !== undefined && chart.pocPrice !== undefined && (
          <g>
            <line
              x1={PAD.left}
              y1={chart.pocY}
              x2={W - PAD.right}
              y2={chart.pocY}
              stroke="#d946ef"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <rect
              x={PAD.left + 6}
              y={chart.pocY - 14}
              width={110}
              height={14}
              rx={3}
              fill="#18181b"
              fillOpacity={0.85}
              stroke="#d946ef"
              strokeWidth={1}
            />
            <text
              x={PAD.left + 10}
              y={chart.pocY - 3}
              fill="#f472b6"
              fontSize={10}
              fontWeight={600}
            >
              POC: {fmtPrice(chart.pocPrice)}
            </text>
          </g>
        )}

        {/* Fibonacci Retracements */}
        {showFib &&
          chart.retracementLines.map((l) => (
            <g key={`fib-r-${l.ratio}`}>
              <line x1={PAD.left} y1={l.y} x2={W - PAD.right} y2={l.y} className={styles.fibRetracement} />
              {canShowFibLabel(l.y, l.ratio) && (
                <text x={W - PAD.right - 4} y={l.y - 3} textAnchor="end" className={styles.fibLabel}>
                  {l.ratio.toFixed(3)} ({fmtPrice(l.price)})
                </text>
              )}
            </g>
          ))}

        {/* Fibonacci Extensions */}
        {showFib &&
          chart.extensionLines.map((l) => (
            <g key={`fib-e-${l.ratio}`}>
              <line x1={PAD.left} y1={l.y} x2={W - PAD.right} y2={l.y} className={styles.fibExtension} />
              {canShowFibLabel(l.y, l.ratio) && (
                <text x={W - PAD.right - 4} y={l.y - 3} textAnchor="end" className={styles.fibLabel}>
                  {l.ratio.toFixed(3)} ext ({fmtPrice(l.price)})
                </text>
              )}
            </g>
          ))}

        {/* Take Profit Lines & Badges */}
        {showTargets &&
          chart.tpLines.map((tp) => (
            <g key={tp.label}>
              <line
                x1={PAD.left}
                y1={tp.y}
                x2={W - PAD.right}
                y2={tp.y}
                className={tp.hit ? styles.tpLineHit : styles.tpLine}
              />
              <rect
                x={W - PAD.right + 4}
                y={tp.y - 9}
                width={PAD.right - 8}
                height={18}
                rx={4}
                className={tp.hit ? styles.tpBadgeBgHit : styles.tpBadgeBg}
              />
              <text x={W - 8} y={tp.y + 4} textAnchor="end" className={styles.tpBadgeText}>
                {tp.label}: {fmtPrice(tp.price)} ({tp.pct >= 0 ? '+' : ''}
                {tp.pct.toFixed(1)}%)
              </text>
            </g>
          ))}

        {/* Stop Loss Line & Badge */}
        {showTargets && chart.slLine && (
          <g>
            <line
              x1={PAD.left}
              y1={chart.slLine.y}
              x2={W - PAD.right}
              y2={chart.slLine.y}
              className={styles.slLine}
            />
            <rect
              x={W - PAD.right + 4}
              y={chart.slLine.y - 9}
              width={PAD.right - 8}
              height={18}
              rx={4}
              className={styles.slBadgeBg}
            />
            <text x={W - 8} y={chart.slLine.y + 4} textAnchor="end" className={styles.slBadgeText}>
              SL: {fmtPrice(chart.slLine.price)} ({chart.slLine.pct >= 0 ? '+' : ''}
              {chart.slLine.pct.toFixed(1)}%)
            </text>
          </g>
        )}

        {/* Candlesticks */}
        {chart.candlesXY.map((c, i) => (
          <g key={i} className={c.up ? styles.up : styles.down}>
            <line x1={c.x} y1={c.highY} x2={c.x} y2={c.lowY} className={styles.wick} />
            <rect
              x={c.x - chart.bodyW / 2}
              y={Math.min(c.openY, c.closeY)}
              width={chart.bodyW}
              height={Math.max(1, Math.abs(c.closeY - c.openY))}
              className={styles.body}
            />
          </g>
        ))}

        {/* Current Price Line */}
        {chart.priceY !== undefined && (
          <line x1={PAD.left} y1={chart.priceY} x2={W - PAD.right} y2={chart.priceY} className={styles.priceLine} />
        )}

        {/* Projected Expected Price Path ("Tekening wat die verwacht") */}
        {showRoute && chart.trajectoryPath && (
          <g>
            <path
              d={chart.trajectoryPath}
              className={`${styles.trajectoryGlow} ${isLong ? styles.trajectoryGlowLong : styles.trajectoryGlowShort}`}
            />
            <path
              d={chart.trajectoryPath}
              className={`${styles.trajectoryPath} ${isLong ? styles.trajectoryPathLong : styles.trajectoryPathShort}`}
              markerEnd={isLong ? 'url(#arrow-long)' : 'url(#arrow-short)'}
            />
            {chart.trajectoryPoints.map((pt) => {
              const labelAbove = isLong ? pt.label !== 'Instap' : pt.label === 'Instap';
              const badgeY = labelAbove ? pt.y - 18 : pt.y + 6;
              const textY = labelAbove ? pt.y - 7 : pt.y + 17;
              return (
                <g key={pt.label}>
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={4}
                    className={`${styles.trajectoryDot} ${isLong ? styles.trajectoryDotLong : styles.trajectoryDotShort}`}
                  />
                  <rect
                    x={pt.x - 18}
                    y={badgeY}
                    width={36}
                    height={15}
                    rx={3}
                    className={styles.trajectoryLabelBg}
                  />
                  <text
                    x={pt.x}
                    y={textY}
                    textAnchor="middle"
                    className={styles.trajectoryLabelText}
                    style={{ fill: isLong ? '#4ade80' : '#f87171' }}
                  >
                    {pt.label}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        <text x={PAD.left} y={H - 6} className={styles.axisLabel}>
          {chart.firstLabel}
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" className={styles.axisLabel}>
          {chart.lastLabel}
        </text>
      </svg>

      <div className={styles.legend}>
        <span>
          <i className={styles.swatchGolden} /> Golden zone (0.382–0.618)
        </span>
        <span>
          <i className={styles.swatchFibR} /> Fibonacci (0.0 / 1.0 & retracements)
        </span>
        <span>
          <i className={styles.swatchSwing} /> Structuur steun/weerstand
        </span>
        <span>
          <i className={styles.swatchTp} /> Take Profit (TP1, TP2, TP3)
        </span>
        <span>
          <i className={styles.swatchSl} /> Stop Loss (SL)
        </span>
        <span>
          <i className={styles.swatchTrajectory} /> Verwachte koersroute
        </span>
        <span>
          <i className={styles.swatchPrice} /> Huidige prijs
        </span>
        <span>
          <i style={{ display: 'inline-block', width: 12, height: 2, background: '#d946ef', verticalAlign: 'middle', marginRight: 4 }} /> Point of Control (POC)
        </span>
      </div>

      <div className={styles.waiting}>
        <h4>Waar de bot op wacht</h4>
        {notes.length === 0 ? (
          <p className={styles.ready}>Alle voorwaarden zijn vervuld — instap kan bij de volgende scan volgen.</p>
        ) : (
          <ul>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
