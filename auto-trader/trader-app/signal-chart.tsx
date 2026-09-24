import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './signal-chart.module.css';
import { fetchChart } from './api.js';
import { pct, price as fmtPrice, shortDate } from './format.js';
import type { Candle, ChartData, LiveExchangePosition, Position, Signal, TradePlan } from './types.js';

export type TimeframeKey = 'Min5' | 'Min15' | 'Min60' | 'Hour4';

export const TIMEFRAMES: Array<{ key: TimeframeKey; label: string; name: string }> = [
  { key: 'Min5', label: '5m', name: '5m (Sniper detail)' },
  { key: 'Min15', label: '15m', name: '15m (Timing & reversal)' },
  { key: 'Min60', label: '1u', name: '1u (Standaard strategie)' },
  { key: 'Hour4', label: '4u', name: '4u (Macro trend context)' },
];

/** Props for {@link SignalChart}. */
export type SignalChartProps = {
  /** Entry-timeframe candles the strategy scores, oldest first. */
  candles?: Candle[];
  /** The current signal for this symbol, used to draw the swing, golden zone and checks. */
  signal?: Signal | null;
  /** Contract symbol, e.g. `BTC_USDT`, used only for the aria-label. */
  symbol: string;
  /** Active open position for this symbol, if any. */
  position?: Position | LiveExchangePosition | null;
  /** Planned trade with TP ladder and SL, if computable. */
  plannedTrade?: TradePlan | null;
  /** Initial timeframe key (defaults to 'Min60'). */
  initialInterval?: TimeframeKey;
};

const W = 760;
const H = 430;
const PAD = { top: 25, right: 125, bottom: 25, left: 60 };
const ROUTE_WIDTH = 120;
const BADGE_GAP = 20;

type RightBadge = {
  id: string;
  rawY: number;
  y: number;
  kind: 'tp' | 'sl' | 'entry' | 'price' | 'overflow';
  label: string;
  price: number;
  pct?: number;
  hit?: boolean;
};

/** Lay out 18px badges with 2px clearance and a visible overflow count. */
export function layoutRightBadges(badges: RightBadge[]): RightBadge[] {
  const minY = PAD.top + 10;
  const maxY = H - PAD.bottom - 10;
  const capacity = Math.floor((maxY - minY) / BADGE_GAP) + 1;
  let visible = badges;

  if (badges.length > capacity) {
    const priority = (badge: RightBadge) =>
      badge.kind === 'sl' ? 0 : badge.kind === 'entry' ? 1 : badge.kind === 'price' ? 2 : 3;
    const ranked = [...badges].sort(
      (a, b) => priority(a) - priority(b) || Number(a.label.replace('TP', '')) - Number(b.label.replace('TP', ''))
    );
    const shown = ranked.slice(0, capacity - 1);
    const omitted = ranked.slice(capacity - 1);
    visible = [
      ...shown,
      {
        id: 'overflow',
        rawY: omitted.reduce((sum, badge) => sum + badge.rawY, 0) / omitted.length,
        y: 0,
        kind: 'overflow',
        label: `+${omitted.length} levels`,
        price: 0,
      },
    ];
  }

  const laidOut = [...visible]
    .sort((a, b) => a.rawY - b.rawY)
    .map((badge) => ({ ...badge, y: Math.max(minY, badge.rawY) }));
  for (let i = 1; i < laidOut.length; i++) {
    laidOut[i].y = Math.max(laidOut[i].y, laidOut[i - 1].y + BADGE_GAP);
  }
  const overflow = Math.max(0, laidOut[laidOut.length - 1]?.y - maxY);
  if (overflow) laidOut.forEach((badge) => (badge.y -= overflow));
  return laidOut;
}

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
export function SignalChart({
  candles = [],
  signal,
  symbol,
  position,
  plannedTrade,
  initialInterval = 'Min60',
}: SignalChartProps) {
  const [showTargets, setShowTargets] = useState(true);
  const [showRoute, setShowRoute] = useState(true);
  const [showFib, setShowFib] = useState(true);
  const [showStructure, setShowStructure] = useState(true);
  const [candleCount, setCandleCount] = useState<number>(45);
  const [interval, setIntervalState] = useState<TimeframeKey>(initialInterval);
  const [loadedData, setLoadedData] = useState<ChartData | null>(null);
  const [loadingTf, setLoadingTf] = useState(false);
  const mounted = useRef(false);
  const chartRequestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      chartRequestId.current++;
    };
  }, []);

  // Sync state when symbol or initialInterval changes
  useEffect(() => {
    chartRequestId.current++;
    setLoadedData(null);
    setIntervalState(initialInterval);
    setLoadingTf(false);
  }, [symbol, initialInterval]);

  const handleTimeframeChange = (tf: TimeframeKey) => {
    if (tf === interval) return;
    const requestId = ++chartRequestId.current;
    setIntervalState(tf);
    setLoadingTf(true);
    fetchChart(symbol, tf)
      .then((data) => {
        if (!mounted.current || requestId !== chartRequestId.current) return;
        setLoadedData(data);
        setLoadingTf(false);
      })
      .catch((err) => {
        if (!mounted.current || requestId !== chartRequestId.current) return;
        console.warn('Failed to switch timeframe:', err);
        setLoadingTf(false);
      });
  };

  const effectiveCandles = loadedData?.candles || candles || [];
  const effectiveSignal = loadedData?.signal || signal || null;
  const effectivePosition = loadedData?.position || position || null;
  const effectivePlannedTrade = loadedData?.plannedTrade || plannedTrade || null;

  const chart = useMemo(() => {
    if (!effectiveCandles || effectiveCandles.length < 2) return null;
    const validCandles = effectiveCandles.filter(
      (c) =>
        c &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.close)
    );
    if (validCandles.length < 2) return null;
    const recent = validCandles.slice(-candleCount);
    const highs = recent.map((c) => c.high);
    const lows = recent.map((c) => c.low);
    let lo = Math.min(...lows);
    let hi = Math.max(...highs);

    if (effectiveSignal?.fib) {
      if (Number.isFinite(effectiveSignal.fib.swingLow)) lo = Math.min(lo, effectiveSignal.fib.swingLow);
      if (Number.isFinite(effectiveSignal.fib.swingHigh)) hi = Math.max(hi, effectiveSignal.fib.swingHigh);
    }

    // Determine entry reference price
    const lastClose = recent[recent.length - 1]?.close;
    const posEntry = effectivePosition
      ? ('entryPrice' in effectivePosition ? effectivePosition.entryPrice : effectivePosition.entry)
      : undefined;
    const rawEntry = posEntry ?? effectivePlannedTrade?.entry ?? effectiveSignal?.price ?? lastClose;
    const entryPrice = Number.isFinite(rawEntry) && rawEntry > 0 ? rawEntry : lastClose;
    const side = effectivePosition?.side ?? effectivePlannedTrade?.side ?? effectiveSignal?.side ?? 'LONG';
    const dir = side === 'LONG' ? 1 : -1;

    // Determine Stop Loss
    let slPrice: number | undefined =
      (effectivePosition && 'stopLoss' in effectivePosition ? effectivePosition.stopLoss : undefined) ??
      effectivePlannedTrade?.stopLoss;
    if (slPrice === undefined && effectiveSignal && Number.isFinite(effectiveSignal.price) && effectiveSignal.price > 0) {
      const stopDist = Math.max(0.015, (effectiveSignal.atrPct || 0.02) * 1.5);
      slPrice = effectiveSignal.price * (1 - dir * stopDist);
    }

    // Determine Take Profit targets
    let tps: Array<{ price: number; portion?: number; rMultiple?: number; hit?: boolean; label: string }> = [];
    const positionTakeProfits =
      effectivePosition && 'takeProfits' in effectivePosition ? effectivePosition.takeProfits : undefined;
    if (positionTakeProfits?.length) {
      tps = positionTakeProfits
        .filter((t) => Number.isFinite(t.price) && t.price > 0)
        .map((t, idx) => ({
          price: t.price,
          portion: t.portion,
          rMultiple: t.rMultiple,
          hit: t.hit,
          label: `TP${idx + 1}`,
        }));
    } else if (effectivePlannedTrade?.takeProfits?.length) {
      tps = effectivePlannedTrade.takeProfits
        .filter((t) => Number.isFinite(t.price) && t.price > 0)
        .map((t, idx) => ({
          price: t.price,
          portion: t.portion,
          rMultiple: t.rMultiple,
          hit: false,
          label: `TP${idx + 1}`,
        }));
    } else if (effectiveSignal && Number.isFinite(effectiveSignal.price) && effectiveSignal.price > 0) {
      const stopDist = Math.max(0.015, (effectiveSignal.atrPct || 0.02) * 1.5);
      tps = [
        { price: effectiveSignal.price * (1 + dir * stopDist * 1.5), portion: 0.33, rMultiple: 1.5, hit: false, label: 'TP1' },
        { price: effectiveSignal.price * (1 + dir * stopDist * 2.5), portion: 0.33, rMultiple: 2.5, hit: false, label: 'TP2' },
        { price: effectiveSignal.price * (1 + dir * stopDist * 3.5), portion: 0.34, rMultiple: 3.5, hit: false, label: 'TP3' },
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
    const routeWidth = showRoute && tps.length ? Math.min(ROUTE_WIDTH, innerW * 0.3) : 0;
    const candleW = innerW - routeWidth;
    const slot = candleW / recent.length;
    const bodyW = Math.max(3, Math.min(16, slot * 0.72));
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

    const goldenTop = effectiveSignal?.fib?.retracements?.find((l) => l.ratio === 0.382)?.price;
    const goldenBottom = effectiveSignal?.fib?.retracements?.find((l) => l.ratio === 0.618)?.price;

    const inRange = (v: number) => Number.isFinite(v) && v >= PAD.top - 0.5 && v <= H - PAD.bottom + 0.5;

    const fibAnchorLines: Array<{ label: string; ratio: number; price: number; y: number }> = [];
    if (effectiveSignal?.fib) {
      const isUp = effectiveSignal.fib.direction === 'UP';
      const topPrice = effectiveSignal.fib.swingHigh;
      const botPrice = effectiveSignal.fib.swingLow;
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

    const retracementLines = (effectiveSignal?.fib?.retracements || [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => ({ ratio: l.ratio, price: l.price, y: y(l.price) }))
      .filter((l) => inRange(l.y));

    const extensionLines = (effectiveSignal?.fib?.extensions || [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) => ({ ratio: l.ratio, price: l.price, y: y(l.price) }))
      .filter((l) => inRange(l.y));

    const ticks = [
      hi,
      hi - (hi - lo) * 0.25,
      (hi + lo) / 2,
      lo + (hi - lo) * 0.25,
      lo,
    ].map((v) => ({ v, y: y(v) }));
    const firstLabel = recent[0]?.time ? shortDate(recent[0].time) : '';
    const lastLabel = recent[recent.length - 1]?.time ? shortDate(recent[recent.length - 1].time) : '';

    const goldenLow =
      goldenBottom !== undefined && goldenTop !== undefined ? Math.min(goldenBottom, goldenTop) : undefined;
    const goldenHigh =
      goldenBottom !== undefined && goldenTop !== undefined ? Math.max(goldenBottom, goldenTop) : undefined;

    const isPriceInZone =
      goldenLow !== undefined && goldenHigh !== undefined && lastClose >= goldenLow && lastClose <= goldenHigh;
    const isWaitingPullback =
      !effectivePosition &&
      (side === 'LONG'
        ? goldenHigh !== undefined && lastClose > goldenHigh
        : goldenLow !== undefined && lastClose < goldenLow);

    const waitTopY = goldenHigh !== undefined && inRange(y(goldenHigh)) ? y(goldenHigh) : undefined;
    const waitBottomY = goldenLow !== undefined && inRange(y(goldenLow)) ? y(goldenLow) : undefined;

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

    const pocPrice = effectiveSignal?.marketStructure?.volumeProfile?.poc;
    const pocY = pocPrice !== undefined && inRange(y(pocPrice)) ? y(pocPrice) : undefined;

    const entryY = inRange(y(entryPrice)) ? y(entryPrice) : undefined;
    const entryLine = effectivePosition && entryY !== undefined ? { price: entryPrice, y: entryY } : undefined;
    const lastCloseY = lastClose !== undefined && inRange(y(lastClose)) ? y(lastClose) : undefined;

    const rightBadges: RightBadge[] = [];
    tpLines.forEach((tp) => {
      if (inRange(tp.y)) {
        rightBadges.push({
          id: tp.label,
          rawY: tp.y,
          y: tp.y,
          kind: 'tp',
          label: tp.label,
          price: tp.price,
          pct: tp.pct,
          hit: tp.hit,
        });
      }
    });
    if (slLine && inRange(slLine.y)) {
      rightBadges.push({
        id: 'sl',
        rawY: slLine.y,
        y: slLine.y,
        kind: 'sl',
        label: 'SL',
        price: slLine.price,
        pct: slLine.pct,
      });
    }

    if (entryLine) {
      rightBadges.push({
        id: 'entry',
        rawY: entryLine.y,
        y: entryLine.y,
        kind: 'entry',
        label: 'INSTAP',
        price: entryLine.price,
      });
    }

    if (lastCloseY !== undefined && lastClose !== undefined) {
      rightBadges.push({
        id: 'price',
        rawY: lastCloseY,
        y: lastCloseY,
        kind: 'price',
        label: 'NU',
        price: lastClose,
        pct: effectivePosition && entryPrice > 0 ? ((lastClose - entryPrice) / entryPrice) * 100 : undefined,
      });
    }

    const laidOutRightBadges = layoutRightBadges(rightBadges);

    // Generate expected price trajectory curve
    let trajectoryPath = '';
    const trajectoryPoints: Array<{ x: number; y: number; label: string }> = [];

    if (candlesXY.length > 0 && tps.length > 0) {
      const last = candlesXY[candlesXY.length - 1];
      const startX = last.x;
      const startY = last.closeY;
      const entryYVal = y(entryPrice);

      if (isWaitingPullback) {
        // Price is outside the golden zone: show pullback into the zone first, then explosion to TPs!
        const p1X = startX + 28;
        const p1Y = entryYVal;
        trajectoryPoints.push({ x: p1X, y: p1Y, label: 'Pullback' });

        const tp1Y = tps[0] ? y(tps[0].price) : entryYVal;
        const p2X = startX + 56;
        trajectoryPoints.push({ x: p2X, y: tp1Y, label: 'TP1' });

        const tp2Y = tps[1] ? y(tps[1].price) : tp1Y;
        const p3X = startX + 84;
        trajectoryPoints.push({ x: p3X, y: tp2Y, label: 'TP2' });

        const tp3Y = tps[2] ? y(tps[2].price) : tp2Y;
        const p4X = Math.min(W - PAD.right - 10, startX + 110);
        trajectoryPoints.push({ x: p4X, y: tp3Y, label: 'TP3' });

        if ([startX, startY, p1X, p1Y, p2X, tp1Y, p3X, tp2Y, p4X, tp3Y].every((n) => Number.isFinite(n))) {
          // Dip into pullback then curve up to TP1, TP2, TP3
          const midY = side === 'LONG' ? Math.max(startY, p1Y) + 5 : Math.min(startY, p1Y) - 5;
          trajectoryPath = `M ${startX} ${startY} Q ${(startX + p1X) / 2} ${midY} ${p1X} ${p1Y} Q ${(p1X + p2X) / 2} ${(p1Y + tp1Y) / 2} ${p2X} ${tp1Y} T ${p3X} ${tp2Y} T ${p4X} ${tp3Y}`;
        }
      } else {
        // Price is already at/in entry zone
        const p1X = startX + 24;
        const p1Y = entryYVal;
        trajectoryPoints.push({ x: p1X, y: p1Y, label: 'Instap' });

        const tp1Y = tps[0] ? y(tps[0].price) : entryYVal;
        const p2X = startX + 52;
        trajectoryPoints.push({ x: p2X, y: tp1Y, label: 'TP1' });

        const tp2Y = tps[1] ? y(tps[1].price) : tp1Y;
        const p3X = startX + 78;
        trajectoryPoints.push({ x: p3X, y: tp2Y, label: 'TP2' });

        const tp3Y = tps[2] ? y(tps[2].price) : tp2Y;
        const p4X = Math.min(W - PAD.right - 10, startX + 104);
        trajectoryPoints.push({ x: p4X, y: tp3Y, label: 'TP3' });

        if ([startX, startY, p1X, p1Y, p2X, tp1Y, p3X, tp2Y, p4X, tp3Y].every((n) => Number.isFinite(n))) {
          trajectoryPath = `M ${startX} ${startY} Q ${p1X} ${p1Y} ${p2X} ${tp1Y} T ${p3X} ${tp2Y} T ${p4X} ${tp3Y}`;
        }
      }
    }

    return {
      candlesXY,
      lastCandleX: candlesXY[candlesXY.length - 1]?.x ?? W - PAD.right,
      bodyW,
      ticks,
      firstLabel,
      lastLabel,
      side,
      entryPrice,
      lastClose,
      isPriceInZone,
      isWaitingPullback,
      waitTopY,
      waitBottomY,
      priceY: effectiveSignal && Number.isFinite(effectiveSignal.price) ? y(effectiveSignal.price) : undefined,
      swingLowY: effectiveSignal && Number.isFinite(effectiveSignal.swingLow) ? y(effectiveSignal.swingLow) : undefined,
      swingHighY: effectiveSignal && Number.isFinite(effectiveSignal.swingHigh) ? y(effectiveSignal.swingHigh) : undefined,
      goldenTopY: goldenTop !== undefined ? y(goldenTop) : undefined,
      goldenBottomY: goldenBottom !== undefined ? y(goldenBottom) : undefined,
      goldenLow,
      goldenHigh,
      pocPrice,
      pocY,
      entryLine,
      lastCloseY,
      rightBadges: laidOutRightBadges,
      hasActivePosition: Boolean(effectivePosition),
      fibAnchorLines,
      fibDirection: effectiveSignal?.fib?.direction,
      fibSwingHigh: effectiveSignal?.fib?.swingHigh,
      fibSwingLow: effectiveSignal?.fib?.swingLow,
      retracementLines,
      extensionLines,
      tpLines,
      slLine,
      trajectoryPath,
      trajectoryPoints,
    };
  }, [effectiveCandles, effectiveSignal, effectivePosition, effectivePlannedTrade, candleCount, showRoute]);

  const notes = waitingOn(effectiveSignal);

  if (!chart) {
    return <p className={styles.empty}>Te weinig candles om een grafiek te tekenen.</p>;
  }

  const isLong = chart.side === 'LONG';

  // Left-side label collision resolution: structure lines vs fib anchors
  const topAnchor = chart.fibAnchorLines.find((a) => a.label.includes('Top'));
  const botAnchor = chart.fibAnchorLines.find((a) => a.label.includes('Bodem'));

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
      {/* Top Controls: Timeframe Selector & Layer Filters */}
      <div className={styles.topBar}>
        <div className={styles.tfBar}>
          <span className={styles.tfTitle}>Tijdsframe:</span>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              type="button"
              className={`${styles.tfBtn} ${interval === tf.key ? styles.tfBtnActive : ''}`}
              title={tf.name}
              disabled={loadingTf}
              onClick={() => handleTimeframeChange(tf.key)}
            >
              {tf.label}
            </button>
          ))}
          {loadingTf && <span className={styles.tfLoading}>Laden…</span>}
        </div>

        <div className={styles.tfBar}>
          <span className={styles.tfTitle}>Zoom:</span>
          <button
            type="button"
            className={`${styles.tfBtn} ${candleCount === 45 ? styles.tfBtnActive : ''}`}
            onClick={() => setCandleCount(45)}
            title="45 candles — grote, duidelijke candles"
          >
            🔍 Detail (45)
          </button>
          <button
            type="button"
            className={`${styles.tfBtn} ${candleCount === 90 ? styles.tfBtnActive : ''}`}
            onClick={() => setCandleCount(90)}
            title="90 candles — breder trendoverzicht"
          >
            📊 Overzicht (90)
          </button>
        </div>

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
      </div>

      {/* Visual Prediction Banner */}
      <div className={`${styles.projectionCard} ${isLong ? '' : styles.projectionCardShort}`}>
        <div className={styles.projectionTitle}>
          <span>{isLong ? '🚀' : '🔻'}</span>
          <span>
            <b>Verwachte koersroute ({chart.side}):</b>{' '}
            {isLong
              ? chart.isWaitingPullback
                ? 'Wacht op pullback in instapzone ➔ opwaartse reactie richting TP1, TP2 en TP3'
                : 'Instapzone bereikt ➔ opwaartse impuls richting TP1, TP2 en TP3'
              : chart.isWaitingPullback
                ? 'Wacht op pullback omhoog bij weerstand ➔ neerwaartse afwijzing richting TP1, TP2 en TP3'
                : 'Weerstand bereikt ➔ neerwaartse impuls richting TP1, TP2 en TP3'}
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
          {effectiveSignal?.marketStructure?.smtDivergence && (
            <span className={styles.projectionBadge} style={{ borderColor: '#a855f7', color: '#c084fc' }}>
              ⚡ <b>SMT {effectiveSignal.marketStructure.smtDivergence.type}:</b> {effectiveSignal.marketStructure.smtDivergence.reason}
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
                if (effectivePosition) {
                  return `🎯 Positie is ACTIEF (Entry: ${fmtPrice(chart.entryPrice)}) — pullback naar waarde is voltooid, trade koerst richting winstdoelen.`;
                }
                const p = chart.lastClose || effectiveSignal?.price || 0;
                if (chart.isPriceInZone) {
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
            {effectiveSignal && (
              <span className={styles.fibBadge}>
                🛡️ <b>Stop anchor (structuur):</b>{' '}
                {chart.side === 'LONG' ? fmtPrice(effectiveSignal.swingLow) : fmtPrice(effectiveSignal.swingHigh)}
              </span>
            )}
          </div>
        </div>
      )}

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

        {/* Highlighted Wachtzone / Instapgebied (Golden Zone & Pullback) */}
        {showFib && chart.waitTopY !== undefined && chart.waitBottomY !== undefined && (
          <g>
            <rect
              x={PAD.left}
              y={Math.min(chart.waitTopY, chart.waitBottomY)}
              width={W - PAD.left - PAD.right}
              height={Math.max(8, Math.abs(chart.waitBottomY - chart.waitTopY))}
              className={styles.waitZone}
            />
            <line
              x1={PAD.left}
              y1={Math.min(chart.waitTopY, chart.waitBottomY)}
              x2={W - PAD.right}
              y2={Math.min(chart.waitTopY, chart.waitBottomY)}
              className={styles.waitZoneBorder}
            />
            <line
              x1={PAD.left}
              y1={Math.max(chart.waitTopY, chart.waitBottomY)}
              x2={W - PAD.right}
              y2={Math.max(chart.waitTopY, chart.waitBottomY)}
              className={styles.waitZoneBorder}
            />
            <rect
              x={PAD.left + 6}
              y={Math.min(chart.waitTopY, chart.waitBottomY) + 2}
              width={chart.isPriceInZone ? 160 : 225}
              height={15}
              rx={3}
              className={styles.waitZoneBadgeBg}
            />
            <text
              x={PAD.left + 10}
              y={Math.min(chart.waitTopY, chart.waitBottomY) + 13}
              className={styles.waitZoneBadgeText}
            >
              {chart.isPriceInZone
                ? '🎯 INSTAPZONE BEREIKT'
                : isLong
                  ? '⏳ WACHT OP PULLBACK IN DEZE ZONE'
                  : '⏳ WACHT OP PULLBACK OMHOOG IN ZONE'}
            </text>
          </g>
        )}

        {/* Fibonacci Anchor Lines (0.000 Top & 1.000 Bodem) */}
        {showFib &&
          chart.fibAnchorLines.map((a) => {
            const isTop = a.label.includes('Top');
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
        {showStructure && chart.swingHighY !== undefined && effectiveSignal && (
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
              Weerstand (structuur): {fmtPrice(effectiveSignal.swingHigh)}
            </text>
          </g>
        )}
        {showStructure && chart.swingLowY !== undefined && effectiveSignal && (
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
              Steun (structuur): {fmtPrice(effectiveSignal.swingLow)}
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

        {/* Entry Line (when position is active) */}
        {chart.entryLine && (
          <line
            x1={PAD.left}
            y1={chart.entryLine.y}
            x2={W - PAD.right}
            y2={chart.entryLine.y}
            className={styles.entryLine}
          />
        )}

        {/* Current Price Line */}
        {chart.lastCloseY !== undefined && (
          <line
            x1={PAD.left}
            y1={chart.lastCloseY}
            x2={W - PAD.right}
            y2={chart.lastCloseY}
            className={styles.priceLine}
            style={{ stroke: '#fbbf24', strokeDasharray: '3 3', opacity: 0.8 }}
          />
        )}

        {/* Take Profit Lines */}
        {showTargets &&
          chart.tpLines.map((tp) => (
            <line
              key={tp.label}
              x1={PAD.left}
              y1={tp.y}
              x2={W - PAD.right}
              y2={tp.y}
              className={tp.hit ? styles.tpLineHit : styles.tpLine}
            />
          ))}

        {/* Stop Loss Line */}
        {showTargets && chart.slLine && (
          <line
            x1={PAD.left}
            y1={chart.slLine.y}
            x2={W - PAD.right}
            y2={chart.slLine.y}
            className={styles.slLine}
          />
        )}

        {/* Candlesticks (Prominent, crisp & clear) */}
        {chart.candlesXY.map((c, i) => (
          <g key={i} className={c.up ? styles.up : styles.down}>
            <line x1={c.x} y1={c.highY} x2={c.x} y2={c.lowY} className={styles.wick} strokeWidth={1.5} />
            <rect
              x={c.x - chart.bodyW / 2}
              y={Math.min(c.openY, c.closeY)}
              width={chart.bodyW}
              height={Math.max(2, Math.abs(c.closeY - c.openY))}
              rx={1.5}
              className={styles.body}
            />
          </g>
        ))}

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
                    data-testid="trajectory-point"
                    data-x={pt.x}
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

        {/* Right-Side Badges (Zero Collision) */}
        {chart.rightBadges
          .filter((b) => (b.kind === 'tp' || b.kind === 'sl' || b.kind === 'overflow' ? showTargets : true))
          .map((b) => {
            const isEntry = b.kind === 'entry';
            const isPrice = b.kind === 'price';
            const isSl = b.kind === 'sl';
            const isOverflow = b.kind === 'overflow';
            const badgeBg = isOverflow
              ? styles.overflowBadgeBg
              : isEntry
              ? styles.entryBadgeBg
              : isPrice
              ? styles.priceBadgeBg
              : isSl
              ? styles.slBadgeBg
              : b.hit
              ? styles.tpBadgeBgHit
              : styles.tpBadgeBg;
            const badgeText = isOverflow
              ? styles.overflowBadgeText
              : isEntry
              ? styles.entryBadgeText
              : isPrice
              ? styles.priceBadgeText
              : isSl
              ? styles.slBadgeText
              : styles.tpBadgeText;
            const textVal = isEntry
              ? `INSTAP: ${fmtPrice(b.price)}`
              : isPrice
              ? `NU: ${fmtPrice(b.price)}${b.pct !== undefined ? ` (${b.pct >= 0 ? '+' : ''}${b.pct.toFixed(1)}%)` : ''}`
              : isSl
              ? `SL: ${fmtPrice(b.price)}${b.pct !== undefined ? ` (${b.pct >= 0 ? '+' : ''}${b.pct.toFixed(1)}%)` : ''}`
              : isOverflow
                ? b.label
                : `${b.label}: ${fmtPrice(b.price)}${b.pct !== undefined ? ` (${b.pct >= 0 ? '+' : ''}${b.pct.toFixed(1)}%)` : ''}`;
            return (
              <g key={b.id} data-testid="right-badge" data-kind={b.kind} data-center-y={b.y}>
                {Math.abs(b.y - b.rawY) > 2 && (
                  <line
                    x1={W - PAD.right}
                    y1={b.rawY}
                    x2={W - PAD.right + 4}
                    y2={b.y}
                    stroke={isOverflow ? '#a1a1aa' : isEntry ? '#38bdf8' : isPrice ? '#fbbf24' : isSl ? '#ef4444' : '#22c55e'}
                    strokeWidth={1}
                    opacity={0.6}
                  />
                )}
                <rect
                  x={W - PAD.right + 4}
                  y={b.y - 9}
                  width={PAD.right - 8}
                  height={18}
                  rx={4}
                  className={badgeBg}
                />
                <text x={W - 8} y={b.y + 4} textAnchor="end" className={badgeText}>
                  {textVal}
                </text>
              </g>
            );
          })}

        <text x={PAD.left} y={H - 6} className={styles.axisLabel}>
          {chart.firstLabel}
        </text>
        <text x={chart.lastCandleX} y={H - 6} textAnchor="end" className={styles.axisLabel}>
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

      {/* Hoe & Wat: Strategie & Wacht-Uitleg */}
      <div className={styles.howAndWhatCard}>
        <div className={styles.howAndWhatHead}>
          <span className={styles.howAndWhatTitle}>
            💡 <b>Hoe & Wat: Strategie & Wacht-Uitleg</b> ({symbol.replace('_', '/')})
          </span>
          <span
            className={`${styles.howAndWhatStatusBadge} ${
              effectivePosition
                ? styles.statusReady
                : notes.length === 0
                  ? styles.statusReady
                  : chart.isWaitingPullback
                    ? styles.statusWaiting
                    : styles.statusWaiting
            }`}
          >
            {effectivePosition
              ? '🚀 Positie Actief'
              : notes.length === 0
                ? '🎯 Gereed voor instap'
                : chart.isWaitingPullback
                  ? '⏳ Wacht op pullback'
                  : chart.isPriceInZone
                    ? '⏱️ Wacht op trigger in zone'
                    : '⏳ Wacht op voorwaarden'}
          </span>
        </div>

        <p className={styles.howAndWhatSummary}>
          {(() => {
            const sideName = isLong ? 'LONG (Koop)' : 'SHORT (Verkoop)';
            const conf = effectiveSignal ? pct(effectiveSignal.confidence, 0) : '—';
            const lev = effectivePosition
              ? `${effectivePosition.leverage}x`
              : effectiveSignal?.plannedLeverage
                ? `${effectiveSignal.plannedLeverage}x`
                : '5x';

            if (effectivePosition) {
              const pnlVal = 'unrealisedPnl' in effectivePosition ? effectivePosition.unrealisedPnl : undefined;
              const pnlStr =
                pnlVal !== undefined
                  ? ` (Ongerealiseerde winst/verlies: ${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)})`
                  : '';
              return `De ${sideName} positie op ${symbol.replace('_', '/')} is actief geopend op ${fmtPrice(chart.entryPrice)} met ${lev} hefboom${pnlStr}. De instap-pullback naar steun/waarde is reeds succesvol voltooid. De trade koerst nu richting TP1 (${chart.tpLines[0] ? fmtPrice(chart.tpLines[0].price) : '—'}) en TP2 (${chart.tpLines[1] ? fmtPrice(chart.tpLines[1].price) : '—'}) met stop-loss beveiliging op ${chart.slLine ? fmtPrice(chart.slLine.price) : '—'}.`;
            }
            if (notes.length === 0) {
              return `De bot ziet een sterke ${sideName} kans met ${conf} overtuiging (${lev} hefboom). Alle marktstructuur- en momentumvoorwaarden zijn vervuld. Zodra de scanner de volgende cyclus draait, kan de order direct geactiveerd worden.`;
            }
            if (chart.isWaitingPullback && chart.goldenLow !== undefined && chart.goldenHigh !== undefined) {
              return `De overkoepelende structuur is ${isLong ? 'bullish (opwaarts)' : 'bearish (neerwaarts)'}, maar de huidige koers (${fmtPrice(chart.lastClose)}) staat te ver buiten de ideale instap. De bot wacht geduldig tot de prijs terugkeert naar de Golden Zone (${fmtPrice(chart.goldenLow)} – ${fmtPrice(chart.goldenHigh)}) om met minimaal risico in te stappen.`;
            }
            if (chart.isPriceInZone) {
              return `De koers bevindt zich in de Golden Zone (${fmtPrice(chart.goldenLow)} – ${fmtPrice(chart.goldenHigh)})! De bot wacht nu op de micro-timing trigger (een bevestigende reversal candle op het 15m/5m tijdsframe met stijgende RSI) om een valse uitbraak te voorkomen.`;
            }
            return `De bot monitort ${symbol.replace('_', '/')} voor een potentiële ${sideName} positie. Er wordt gewacht op bevestiging van het hogere tijdsframe en het bereiken van de optimale marktstructuur.`;
          })()}
        </p>

        <div className={styles.howAndWhatGrid}>
          <div className={styles.howAndWhatItem}>
            <span className={styles.howAndWhatItemHead}>
              📍 <b>1. Wachtzone & Prijsactie</b>
            </span>
            <p className={styles.howAndWhatItemDesc}>
              {effectivePosition
                ? `Positie is reeds geopend op ${fmtPrice(chart.entryPrice)}. De instap-dip/pullback is voltooid en de trade is nu actief in beheer.`
                : chart.goldenLow !== undefined && chart.goldenHigh !== undefined
                  ? `Golden Zone: ${fmtPrice(chart.goldenLow)} – ${fmtPrice(chart.goldenHigh)} (0.382–0.618 Fib). ${
                      chart.isPriceInZone
                        ? 'Koers is momenteel in de zone.'
                        : chart.isWaitingPullback
                          ? `Wacht op ${isLong ? 'daling' : 'stijging'} van ${Math.abs(((chart.lastClose - (isLong ? chart.goldenHigh : chart.goldenLow)) / chart.lastClose) * 100).toFixed(1)}% naar de zone.`
                          : 'Buiten de zone.'
                    }`
                  : `Huidige prijs is ${fmtPrice(chart.lastClose)}. Wacht op swingstructuur.`}
            </p>
          </div>

          <div className={styles.howAndWhatItem}>
            <span className={styles.howAndWhatItemHead}>
              ⏱️ <b>2. Tijdsframe & Micro-Trigger</b>
            </span>
            <p className={styles.howAndWhatItemDesc}>
              Geselecteerd TF: <b>{TIMEFRAMES.find((t) => t.key === interval)?.label}</b>. 4u-macrotrend is{' '}
              <b>{effectiveSignal?.higherRegime || 'Onbekend'}</b>{' '}
              {effectiveSignal?.alignedWithHigher ? '(✓ Bevestigd)' : '(⏳ Nog niet uitgelijnd)'}. Vereist een bevestigde 15m/5m reversal candle voor orderactivatie.
            </p>
          </div>

          <div className={styles.howAndWhatItem}>
            <span className={styles.howAndWhatItemHead}>
              🛡️ <b>3. Stop Loss Bescherming</b>
            </span>
            <p className={styles.howAndWhatItemDesc}>
              {chart.slLine
                ? `SL op ${fmtPrice(chart.slLine.price)} (${chart.slLine.pct >= 0 ? '+' : ''}${chart.slLine.pct.toFixed(1)}%). Geplaatst onder de structuur/swing ${isLong ? 'low' : 'high'} om verlies strak te begrenzen.`
                : 'SL wordt berekend op basis van ATR en structuursteun.'}
            </p>
          </div>

          <div className={styles.howAndWhatItem}>
            <span className={styles.howAndWhatItemHead}>
              🎯 <b>4. Winstdoelen (TP Ladder)</b>
            </span>
            <p className={styles.howAndWhatItemDesc}>
              {chart.tpLines.length > 0
                ? chart.tpLines
                    .map((t) => `${t.label}: ${fmtPrice(t.price)} (${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(1)}%)`)
                    .join(' · ') + ' (Bij TP1 gaat SL automatisch naar Break-Even)'
                : 'TP doelen worden berekend op 1.5R, 2.5R en 3.5R.'}
            </p>
          </div>
        </div>

        {/* Gedetailleerde Conditie-Checklist */}
        <div className={styles.howAndWhatChecklist}>
          <span style={{ fontSize: '0.76rem', fontWeight: 600, color: 'var(--muted)', marginTop: '0.2rem' }}>
            Condities & Confluenties:
          </span>
          {effectiveSignal?.checks && effectiveSignal.checks.length > 0 ? (
            effectiveSignal.checks.map((c) => (
              <div key={c.name} className={styles.checkRow}>
                <span className={c.passed ? styles.checkSuccess : styles.checkPending}>
                  {c.passed ? '✓' : '⏳'}
                </span>
                <span>
                  <b>{c.name}:</b> {c.detail}
                </span>
              </div>
            ))
          ) : (
            <div className={styles.checkRow}>
              <span className={styles.checkPending}>⏳</span>
              <span>Wachten op volledige evaluatie van de checks…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
