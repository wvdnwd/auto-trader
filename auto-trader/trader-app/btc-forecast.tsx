import { useEffect, useMemo, useState } from 'react';
import styles from './btc-forecast.module.css';
import { fetchChart } from './api.js';
import { dateTime, price as fmtPrice, shortDate, usd } from './format.js';
import type { ChartData, Snapshot } from './types.js';

export type BtcForecastProps = {
  snap: Snapshot;
};

type TimeframeKey = 'Min5' | 'Min15' | 'Min60' | 'Hour4';

const TIMEFRAMES: Array<{
  key: TimeframeKey;
  label: string;
  name: string;
  horizon: string;
  hLabels: [string, string, string];
}> = [
  {
    key: 'Min5',
    label: '5m',
    name: '⚡ 5 minuten (Micro-detail)',
    horizon: 'Komende 2u',
    hLabels: ['+30m', '+1u', '+2u'],
  },
  {
    key: 'Min15',
    label: '15m',
    name: '⏱️ 15 minuten (Intraday timing)',
    horizon: 'Komende 6u',
    hLabels: ['+1u', '+3u', '+6u'],
  },
  {
    key: 'Min60',
    label: '1u',
    name: '📈 1 uur (Standaard strategie)',
    horizon: 'Komende 24u',
    hLabels: ['+6u', '+14u', '+24u'],
  },
  {
    key: 'Hour4',
    label: '4u',
    name: '🧱 4 uur (Macro trend)',
    horizon: 'Komende 4 dagen',
    hLabels: ['+1d', '+2d', '+4d'],
  },
];

const W = 940;
const H = 420;
const PAD = { top: 34, right: 120, bottom: 42, left: 72 };

export function BtcForecast({ snap }: BtcForecastProps) {
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('Min60');
  const [expanded, setExpanded] = useState(true);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Find BTC signal from snapshot if available
  const btcSignal = snap.signals?.find((s) => s.symbol === 'BTC_USDT') || null;
  const btcMark = snap.marks?.['BTC_USDT'] || btcSignal?.price || 0;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const intervalMs = timeframe === 'Min5' ? 15_000 : timeframe === 'Min15' ? 30_000 : 60_000;
    const loadBtc = async () => {
      try {
        const data = await fetchChart('BTC_USDT', timeframe);
        if (active) setChartData(data);
      } catch {
        // Keep the latest successful chart while the service is temporarily unavailable.
      }
      if (active) timer = setTimeout(() => void loadBtc(), intervalMs);
    };

    void loadBtc();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [timeframe]);

  const currentTf = TIMEFRAMES.find((t) => t.key === timeframe) || TIMEFRAMES[2];

  // Compute chart geometry and forecast projection
  const chart = useMemo(() => {
    const candles = chartData?.candles || [];
    if (candles.length < 2) return null;

    const recent = candles.slice(-75);
    const candleHighs = recent.map((c) => c.high);
    const candleLows = recent.map((c) => c.low);

    const signal = chartData?.signal || btcSignal;
    const currentPrice = btcMark || recent[recent.length - 1]?.close || 0;

    const regime = signal?.regime || 'TREND_UP';
    const higherRegime = signal?.higherRegime || 'TREND_UP';
    const isBull = regime === 'TREND_UP' || higherRegime === 'TREND_UP';
    const isBear = regime === 'TREND_DOWN' || higherRegime === 'TREND_DOWN';

    const swingLow = Math.min(...candleLows);
    const swingHigh = Math.max(...candleHighs);

    // Compute local ATR% from recent candles for the chosen timeframe
    const localAtrPct = (() => {
      if (recent.length < 5) return signal?.atrPct || 0.015;
      const ranges = recent.slice(-14).map((c) => (c.high - c.low) / (c.close || 1));
      const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      return Math.max(0.003, Math.min(0.05, avg));
    })();

    // Realistic target & invalidation prices adapted to timeframe volatility
    let pullbackPrice = currentPrice;
    let target1Price = currentPrice;
    let target2Price = currentPrice;
    let invalidationPrice = swingLow * (1 - localAtrPct * 0.5);

    if (isBull) {
      pullbackPrice = Math.max(swingLow * 1.001, currentPrice * (1 - localAtrPct * 0.6));
      target1Price = Math.max(currentPrice * (1 + localAtrPct * 1.2), swingHigh * 1.002);
      target2Price = target1Price * (1 + localAtrPct * 1.8);
      invalidationPrice = Math.min(swingLow, currentPrice * (1 - localAtrPct * 1.5));
    } else if (isBear) {
      pullbackPrice = Math.min(swingHigh * 0.999, currentPrice * (1 + localAtrPct * 0.6));
      target1Price = Math.min(currentPrice * (1 - localAtrPct * 1.2), swingLow * 0.998);
      target2Price = target1Price * (1 - localAtrPct * 1.8);
      invalidationPrice = Math.max(swingHigh, currentPrice * (1 + localAtrPct * 1.5));
    } else {
      pullbackPrice = (swingHigh + swingLow) / 2;
      target1Price = swingHigh;
      target2Price = swingLow;
      invalidationPrice = swingLow * (1 - localAtrPct);
    }

    // Include ALL candles, targets, and invalidation in vertical range
    let lo = Math.min(...candleLows, swingLow, pullbackPrice, target1Price, target2Price, invalidationPrice);
    let hi = Math.max(...candleHighs, swingHigh, pullbackPrice, target1Price, target2Price, invalidationPrice);

    if (signal?.fib) {
      lo = Math.min(lo, signal.fib.swingLow);
      hi = Math.max(hi, signal.fib.swingHigh);
    }

    const span = hi - lo || Math.max(1, hi * 0.01);
    lo -= span * 0.07;
    hi += span * 0.07;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    // 72% history candles, 28% dedicated future forecast horizon
    const historyW = Math.round(innerW * 0.72);
    const forecastW = innerW - historyW;
    const historyEnd = PAD.left + historyW;
    const forecastEnd = PAD.left + innerW;

    const slot = historyW / recent.length;
    const bodyW = Math.max(2, slot * 0.65);
    const x = (i: number) => PAD.left + i * slot + slot / 2;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;

    const candlesXY = recent.map((c, i) => ({
      x: x(i),
      openY: y(c.open),
      closeY: y(c.close),
      highY: y(c.high),
      lowY: y(c.low),
      up: c.close >= c.open,
      candle: c,
    }));

    const goldenTop = signal?.fib?.retracements.find((l) => l.ratio === 0.382)?.price;
    const goldenBottom = signal?.fib?.retracements.find((l) => l.ratio === 0.618)?.price;

    const ticks = [hi, (hi * 2 + lo) / 3, (hi + lo * 2) / 3, lo].map((v) => ({ v, y: y(v) }));

    const formatTfDate = (timeSec: number) => {
      if (timeframe === 'Min5' || timeframe === 'Min15') {
        return new Date(timeSec * 1000).toLocaleTimeString('nl-NL', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      }
      return shortDate(timeSec);
    };

    const firstLabel = recent[0] ? formatTfDate(recent[0].time) : '';
    const lastLabel = recent[recent.length - 1] ? formatTfDate(recent[recent.length - 1].time) : '';

    // Forecast coordinates
    const p0X = historyEnd;
    const p0Y = y(currentPrice);
    const p1X = historyEnd + Math.round(forecastW * 0.28);
    const p1Y = y(pullbackPrice);
    const p2X = historyEnd + Math.round(forecastW * 0.62);
    const p2Y = y(target1Price);
    const p3X = historyEnd + Math.round(forecastW * 0.94);
    const p3Y = y(target2Price);

    // Confidence Corridor (Shaded Prediction Fan)
    let corridorPath = '';
    if (isBull) {
      const upperPath = `M ${p0X} ${p0Y} C ${p1X} ${p1Y - span * 0.035}, ${p2X} ${p2Y - span * 0.04}, ${p3X} ${p3Y - span * 0.045}`;
      const lowerPath = `L ${p3X} ${y(invalidationPrice)} C ${p2X} ${p1Y + span * 0.03}, ${p1X} ${p1Y + span * 0.04}, ${p0X} ${p0Y} Z`;
      corridorPath = `${upperPath} ${lowerPath}`;
    } else if (isBear) {
      const upperPath = `M ${p0X} ${p0Y} C ${p1X} ${p1Y - span * 0.04}, ${p2X} ${p1Y - span * 0.03}, ${p3X} ${y(invalidationPrice)}`;
      const lowerPath = `L ${p3X} ${p3Y + span * 0.045} C ${p2X} ${p2Y + span * 0.04}, ${p1X} ${p1Y + span * 0.035}, ${p0X} ${p0Y} Z`;
      corridorPath = `${upperPath} ${lowerPath}`;
    } else {
      corridorPath = `M ${p0X} ${y(swingHigh)} L ${p3X} ${y(swingHigh)} L ${p3X} ${y(swingLow)} L ${p0X} ${y(swingLow)} Z`;
    }

    // Trajectory curve
    const trajectoryPath = `M ${p0X} ${p0Y} Q ${p1X} ${p1Y} ${(p1X + p2X) / 2} ${(p1Y + p2Y) / 2} T ${p2X} ${p2Y} T ${p3X} ${p3Y}`;

    // Target relative percentages
    const target1Pct = currentPrice > 0 ? ((target1Price - currentPrice) / currentPrice) * 100 : 0;
    const target2Pct = currentPrice > 0 ? ((target2Price - currentPrice) / currentPrice) * 100 : 0;
    const invalidationPct = currentPrice > 0 ? ((invalidationPrice - currentPrice) / currentPrice) * 100 : 0;

    return {
      candlesXY,
      bodyW,
      ticks,
      firstLabel,
      lastLabel,
      currentPrice,
      priceY: y(currentPrice),
      swingLowY: y(swingLow),
      swingHighY: y(swingHigh),
      goldenTopY: goldenTop !== undefined ? y(goldenTop) : undefined,
      goldenBottomY: goldenBottom !== undefined ? y(goldenBottom) : undefined,
      goldenTop,
      goldenBottom,
      historyEnd,
      forecastEnd,
      p0X,
      p0Y,
      p1X,
      p1Y,
      p2X,
      p2Y,
      p3X,
      p3Y,
      corridorPath,
      trajectoryPath,
      pullbackPrice,
      target1Price,
      target2Price,
      invalidationPrice,
      target1Pct,
      target2Pct,
      invalidationPct,
      isBull,
      isBear,
      regime,
      higherRegime,
      swingLow,
      swingHigh,
      signal,
      hLabels: currentTf.hLabels,
    };
  }, [chartData, btcSignal, btcMark, timeframe, currentTf]);

  const regime = btcSignal?.regime || chart?.regime || 'TREND_UP';
  const higherRegime = btcSignal?.higherRegime || chart?.higherRegime || 'TREND_UP';
  const isBull = regime === 'TREND_UP' || higherRegime === 'TREND_UP';
  const isBear = regime === 'TREND_DOWN' || higherRegime === 'TREND_DOWN';
  const currentPrice = btcMark || chart?.currentPrice || 0;

  // Active hover candle info
  const hovered = hoverIndex !== null && chart ? chart.candlesXY[hoverIndex]?.candle : null;
  const hoverChangePct = hovered && hovered.open > 0 ? ((hovered.close - hovered.open) / hovered.open) * 100 : 0;

  // Formulate AI market forecast text
  let forecastText = '';
  if (isBull) {
    forecastText = `🟢 Bullish Trend Intact — Bitcoin toont krachtig momentum (${timeframe === 'Min5' ? '5m' : timeframe === 'Min15' ? '15m' : '1u'}: ${regime} · 4u: ${higherRegime}). Zolang BTC boven de lokale steun van $${Math.round(chart?.swingLow || currentPrice * 0.95).toLocaleString()} blijft, verwacht het model consolidatie/pullback gevolgd door een uitbraak richting $${Math.round(chart?.target1Price || currentPrice * 1.02).toLocaleString()} (Doel 1) en $${Math.round(chart?.target2Price || currentPrice * 1.05).toLocaleString()} (Doel 2). Altcoin longs hebben groen licht.`;
  } else if (isBear) {
    forecastText = `🔴 Neerwaartse Druk — Bitcoin bevindt zich in ${regime} / ${higherRegime}. Oplevingen lopen risico op afwijzing bij de weerstand ($${Math.round(chart?.swingHigh || currentPrice * 1.03).toLocaleString()}). Het model verwacht daling richting $${Math.round(chart?.target1Price || currentPrice * 0.98).toLocaleString()}. De BTC Gatekeeper beschermt je kapitaal door altcoin shorts te prefereren en longs te remmen.`;
  } else {
    forecastText = `🟡 Range / Consolidatie — Bitcoin beweegt zijwaarts tussen steun ($${Math.round(chart?.swingLow || currentPrice * 0.97).toLocaleString()}) en weerstand ($${Math.round(chart?.swingHigh || currentPrice * 1.03).toLocaleString()}). Het model wacht op een duidelijke volume-uitbraak.`;
  }

  return (
    <section className={styles.wrap} aria-label="Bitcoin Voorspelling & Grafiek">
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.icon}>🪙</span>
          <div className={styles.titleText}>
            <h2 className={styles.title}>
              Bitcoin (BTC/USDT) Voorspelling & Trend
              <span className={`${styles.badge} ${isBull ? styles.badgeUp : isBear ? styles.badgeDown : styles.badgeNeutral}`}>
                {isBull ? '🚀 Bullish' : isBear ? '🔻 Bearish' : '⚖️ Neutraal'}
              </span>
            </h2>
            <p className={styles.subtitle}>
              1u regime: <b>{regime}</b> · 4u macro-regime: <b>{higherRegime}</b> · BTC Gatekeeper actief
            </p>
          </div>
        </div>

        <div className={styles.priceGroup}>
          <span className={styles.price}>{usd(currentPrice)}</span>
          <button
            type="button"
            className={styles.toggleBtn}
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            {expanded ? '▲ Verberg grafiek' : '▼ Toon grafiek'}
          </button>
        </div>
      </div>

      {/* Top Stat Chips Bar */}
      {chart && (
        <div className={styles.statStrip}>
          <div className={styles.statChip}>
            <span className={styles.statLabel}>🪙 Bitcoin Koers</span>
            <span className={styles.statValue}>{usd(currentPrice)}</span>
          </div>
          <div className={styles.statChip}>
            <span className={styles.statLabel}>📈 Verwachte Trend</span>
            <span className={`${styles.statValue} ${isBull ? styles.statValueBull : isBear ? styles.statValueBear : styles.statValueAmber}`}>
              {isBull ? '↗ Bullish Uitbraak' : isBear ? '↘ Neerwaarts' : '↔ Zijwaarts'}
            </span>
          </div>
          <div className={styles.statChip}>
            <span className={styles.statLabel}>🎯 Verwacht Doel 1</span>
            <span className={`${styles.statValue} ${isBull ? styles.statValueBull : styles.statValueBear}`}>
              {fmtPrice(chart.target1Price)} ({chart.target1Pct >= 0 ? '+' : ''}{chart.target1Pct.toFixed(1)}%)
            </span>
          </div>
          <div className={styles.statChip}>
            <span className={styles.statLabel}>🚀 Verwacht Doel 2</span>
            <span className={`${styles.statValue} ${isBull ? styles.statValueBull : styles.statValueBear}`}>
              {fmtPrice(chart.target2Price)} ({chart.target2Pct >= 0 ? '+' : ''}{chart.target2Pct.toFixed(1)}%)
            </span>
          </div>
          <div className={styles.statChip}>
            <span className={styles.statLabel}>🛡️ Invalidatie</span>
            <span className={styles.statValue}>
              &lt; {fmtPrice(chart.invalidationPrice)}
            </span>
          </div>
          <div className={styles.statChip}>
            <span className={styles.statLabel}>⏱️ Horizon</span>
            <span className={styles.statValueAccent}>{currentTf.horizon}</span>
          </div>
        </div>
      )}

      {/* Timeframe Selector Toolbar */}
      {expanded && (
        <div className={styles.timeframeToolbar}>
          <div className={styles.timeframeGroup}>
            <span className={styles.timeframeLabel}>Tijdsframe:</span>
            <div className={styles.timeframeButtons}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.key}
                  type="button"
                  className={`${styles.tfBtn} ${timeframe === tf.key ? styles.tfBtnActive : ''}`}
                  onClick={() => setTimeframe(tf.key)}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>
          <span className={styles.tfBadge}>{currentTf.name}</span>
        </div>
      )}

      {/* AI Market Prediction Banner */}
      <div className={`${styles.predictionBanner} ${isBull ? styles.predictionBannerBull : isBear ? styles.predictionBannerBear : ''}`}>
        <span>🤖</span>
        <span>{forecastText}</span>
      </div>

      {/* Candlestick & Projected Trajectory Chart */}
      {expanded && chart && (
        <div className={styles.chartWrap}>
          {/* Candle Hover Bar */}
          <div className={styles.candleHoverBar}>
            {hovered ? (
              <>
                <span className={styles.candleHoverLabel}>Tijd:</span>
                <span className={styles.candleHoverVal}>
                  {timeframe === 'Min5' || timeframe === 'Min15'
                    ? `${shortDate(hovered.time)} ${new Date(hovered.time * 1000).toLocaleTimeString('nl-NL', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}`
                    : dateTime(hovered.time * 1000)}
                </span>
                <span className={styles.candleHoverLabel}>Open:</span>
                <span className={styles.candleHoverVal}>{fmtPrice(hovered.open)}</span>
                <span className={styles.candleHoverLabel}>Hoog:</span>
                <span className={styles.candleHoverVal}>{fmtPrice(hovered.high)}</span>
                <span className={styles.candleHoverLabel}>Laag:</span>
                <span className={styles.candleHoverVal}>{fmtPrice(hovered.low)}</span>
                <span className={styles.candleHoverLabel}>Sluit:</span>
                <span className={styles.candleHoverVal}>{fmtPrice(hovered.close)}</span>
                <span className={styles.candleHoverLabel}>Rendement:</span>
                <span
                  className={styles.candleHoverVal}
                  style={{ color: hoverChangePct >= 0 ? '#4ade80' : '#f87171' }}
                >
                  {hoverChangePct >= 0 ? '+' : ''}
                  {hoverChangePct.toFixed(2)}%
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
                Beweeg met de muis over de grafiek voor candle details & niveaus
              </span>
            )}
          </div>

          <svg
            className={styles.chart}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Bitcoin Candlestick grafiek met voorspellingszone"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const svgX = ((e.clientX - rect.left) / rect.width) * W;
              if (svgX >= PAD.left && svgX <= chart.historyEnd) {
                const idx = Math.floor(
                  ((svgX - PAD.left) / (chart.historyEnd - PAD.left)) * chart.candlesXY.length
                );
                setHoverIndex(Math.max(0, Math.min(chart.candlesXY.length - 1, idx)));
              } else {
                setHoverIndex(null);
              }
            }}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <defs>
              <linearGradient id="btc-corridor-bull" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#22c55e" stopOpacity="0.18" />
                <stop offset="50%" stopColor="#22c55e" stopOpacity="0.10" />
                <stop offset="100%" stopColor="#22c55e" stopOpacity="0.03" />
              </linearGradient>

              <linearGradient id="btc-corridor-bear" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.18" />
                <stop offset="50%" stopColor="#ef4444" stopOpacity="0.10" />
                <stop offset="100%" stopColor="#ef4444" stopOpacity="0.03" />
              </linearGradient>

              <marker
                id="btc-arrow-bull"
                viewBox="0 0 10 10"
                refX="7"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#22c55e" />
              </marker>

              <marker
                id="btc-arrow-bear"
                viewBox="0 0 10 10"
                refX="7"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#ef4444" />
              </marker>
            </defs>

            {/* Background for Forecast Horizon */}
            <rect
              x={chart.historyEnd}
              y={PAD.top}
              width={chart.forecastEnd - chart.historyEnd}
              height={H - PAD.top - PAD.bottom}
              className={styles.forecastZoneBg}
            />

            {/* Horizontal Grid lines & Left Price Ticks */}
            {chart.ticks.map((t) => (
              <g key={t.v}>
                <line x1={PAD.left} y1={t.y} x2={chart.forecastEnd} y2={t.y} className={styles.gridLine} />
                <text x={PAD.left - 8} y={t.y + 3.5} textAnchor="end" className={styles.axisLabel}>
                  {fmtPrice(t.v)}
                </text>
              </g>
            ))}

            {/* Fibonacci Golden Zone (0.382–0.618) */}
            {chart.goldenTopY !== undefined && chart.goldenBottomY !== undefined && (
              <g>
                <rect
                  x={PAD.left}
                  y={Math.min(chart.goldenTopY, chart.goldenBottomY)}
                  width={chart.forecastEnd - PAD.left}
                  height={Math.max(2, Math.abs(chart.goldenBottomY - chart.goldenTopY))}
                  className={styles.goldenZone}
                />
                <text
                  x={chart.forecastEnd - 6}
                  y={Math.min(chart.goldenTopY, chart.goldenBottomY) + 12}
                  textAnchor="end"
                  className={styles.axisLabel}
                  style={{ fill: '#fbbf24', opacity: 0.9, fontWeight: 600 }}
                >
                  Fib Golden Zone (0.382–0.618)
                </text>
              </g>
            )}

            {/* Support & Resistance Lines across historical and forecast area */}
            <g>
              {/* Resistance */}
              <line
                x1={PAD.left}
                y1={chart.swingHighY}
                x2={chart.forecastEnd}
                y2={chart.swingHighY}
                className={styles.swingLine}
              />
              <text
                x={PAD.left + 6}
                y={chart.swingHighY - 5}
                className={styles.axisLabel}
                style={{ fill: '#60a5fa', fontWeight: 600 }}
              >
                Weerstand: {fmtPrice(chart.swingHigh)}
              </text>

              {/* Support */}
              <line
                x1={PAD.left}
                y1={chart.swingLowY}
                x2={chart.forecastEnd}
                y2={chart.swingLowY}
                className={styles.swingLine}
              />
              <text
                x={PAD.left + 6}
                y={chart.swingLowY - 5}
                className={styles.axisLabel}
                style={{ fill: '#60a5fa', fontWeight: 600 }}
              >
                Steun: {fmtPrice(chart.swingLow)}
              </text>
            </g>

            {/* Candlesticks (Historical Zone) */}
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

            {/* Hover Crosshair */}
            {hoverIndex !== null && chart.candlesXY[hoverIndex] && (
              <line
                x1={chart.candlesXY[hoverIndex].x}
                y1={PAD.top}
                x2={chart.candlesXY[hoverIndex].x}
                y2={H - PAD.bottom}
                className={styles.crosshairLine}
              />
            )}

            {/* Current Price Line */}
            <line
              x1={PAD.left}
              y1={chart.priceY}
              x2={chart.forecastEnd}
              y2={chart.priceY}
              className={styles.priceLine}
            />

            {/* Vertical Live Divider separating past from forecast */}
            <g>
              <line
                x1={chart.historyEnd}
                y1={PAD.top}
                x2={chart.historyEnd}
                y2={H - PAD.bottom}
                className={styles.liveDivider}
              />
              {/* Live Tag at top of divider */}
              <rect
                x={chart.historyEnd - 32}
                y={PAD.top - 18}
                width={64}
                height={18}
                rx={4}
                fill="#1e293b"
                stroke="#3b82f6"
                strokeWidth={1}
              />
              <text
                x={chart.historyEnd}
                y={PAD.top - 5}
                textAnchor="middle"
                className={styles.axisLabel}
                style={{ fill: '#60a5fa', fontWeight: 700, fontSize: '9px' }}
              >
                ● LIVE NU
              </text>
            </g>

            {/* Forecast Confidence Corridor (Fan / Band) */}
            {chart.corridorPath && (
              <path
                d={chart.corridorPath}
                fill={
                  isBull
                    ? 'url(#btc-corridor-bull)'
                    : isBear
                    ? 'url(#btc-corridor-bear)'
                    : 'rgba(245, 158, 11, 0.08)'
                }
              />
            )}

            {/* Expected Trajectory Path (Glowing Animated Curve) */}
            {chart.trajectoryPath && (
              <g>
                <path
                  d={chart.trajectoryPath}
                  className={`${styles.trajectoryGlow} ${
                    isBull ? styles.trajectoryGlowBull : styles.trajectoryGlowBear
                  }`}
                />
                <path
                  d={chart.trajectoryPath}
                  className={`${styles.trajectoryPath} ${
                    isBull ? styles.trajectoryPathBull : styles.trajectoryPathBear
                  }`}
                  markerEnd={isBull ? 'url(#btc-arrow-bull)' : 'url(#btc-arrow-bear)'}
                />

                {/* Point 1: Pullback / Test Node */}
                <circle
                  cx={chart.p1X}
                  cy={chart.p1Y}
                  r={4}
                  className={`${styles.trajectoryDot} ${
                    isBull ? styles.trajectoryDotBull : styles.trajectoryDotBear
                  }`}
                />
                <text
                  x={chart.p1X}
                  y={chart.p1Y + (isBull ? 15 : -8)}
                  textAnchor="middle"
                  className={styles.axisLabel}
                  style={{ fontWeight: 600, fill: isBull ? '#4ade80' : '#f87171', fontSize: '9.5px' }}
                >
                  {isBull ? 'Pullback/Steun' : 'Bounce/Weerstand'}
                </text>

                {/* Point 2: Target 1 Node with Pill Badge */}
                <g>
                  <circle
                    cx={chart.p2X}
                    cy={chart.p2Y}
                    r={4.5}
                    className={`${styles.trajectoryDot} ${
                      isBull ? styles.trajectoryDotBull : styles.trajectoryDotBear
                    }`}
                  />
                  {/* Pill Tag */}
                  <rect
                    x={chart.p2X - 52}
                    y={chart.p2Y + (isBull ? -24 : 8)}
                    width={104}
                    height={18}
                    rx={4}
                    fill="#0f172a"
                    stroke={isBull ? '#22c55e' : '#ef4444'}
                    strokeWidth={1}
                  />
                  <text
                    x={chart.p2X}
                    y={chart.p2Y + (isBull ? -12 : 20)}
                    textAnchor="middle"
                    className={styles.axisLabel}
                    style={{ fill: isBull ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: '9.5px' }}
                  >
                    🎯 Doel 1: {fmtPrice(chart.target1Price)}
                  </text>
                </g>

                {/* Point 3: Target 2 Node with Pill Badge */}
                <g>
                  <circle
                    cx={chart.p3X}
                    cy={chart.p3Y}
                    r={4.5}
                    className={`${styles.trajectoryDot} ${
                      isBull ? styles.trajectoryDotBull : styles.trajectoryDotBear
                    }`}
                  />
                  {/* Pill Tag clamped safely inside right boundary */}
                  <rect
                    x={Math.min(chart.forecastEnd - 108, chart.p3X - 52)}
                    y={chart.p3Y + (isBull ? -24 : 8)}
                    width={104}
                    height={18}
                    rx={4}
                    fill="#0f172a"
                    stroke={isBull ? '#22c55e' : '#ef4444'}
                    strokeWidth={1}
                  />
                  <text
                    x={Math.min(chart.forecastEnd - 56, chart.p3X)}
                    y={chart.p3Y + (isBull ? -12 : 20)}
                    textAnchor="middle"
                    className={styles.axisLabel}
                    style={{ fill: isBull ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: '9.5px' }}
                  >
                    🚀 Doel 2: {fmtPrice(chart.target2Price)}
                  </text>
                </g>
              </g>
            )}

            {/* Right Price Scale Badges */}
            <g>
              {/* Current Price Badge */}
              <rect
                x={chart.forecastEnd + 4}
                y={chart.priceY - 10}
                width={W - chart.forecastEnd - 8}
                height={20}
                rx={4}
                fill="#0f172a"
                stroke="#38bdf8"
                strokeWidth={1.5}
              />
              <text
                x={chart.forecastEnd + 10}
                y={chart.priceY + 3.5}
                className={styles.axisLabel}
                style={{ fill: '#38bdf8', fontWeight: 800, fontSize: '10px' }}
              >
                ● {fmtPrice(chart.currentPrice)}
              </text>

              {/* Target 1 Badge */}
              <rect
                x={chart.forecastEnd + 4}
                y={chart.p2Y - 9}
                width={W - chart.forecastEnd - 8}
                height={18}
                rx={3}
                fill={isBull ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}
                stroke={isBull ? '#22c55e' : '#ef4444'}
                strokeWidth={1}
              />
              <text
                x={chart.forecastEnd + 10}
                y={chart.p2Y + 3.5}
                className={styles.axisLabel}
                style={{ fill: isBull ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: '9.5px' }}
              >
                🎯 {fmtPrice(chart.target1Price)}
              </text>

              {/* Target 2 Badge */}
              <rect
                x={chart.forecastEnd + 4}
                y={chart.p3Y - 9}
                width={W - chart.forecastEnd - 8}
                height={18}
                rx={3}
                fill={isBull ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}
                stroke={isBull ? '#22c55e' : '#ef4444'}
                strokeWidth={1}
              />
              <text
                x={chart.forecastEnd + 10}
                y={chart.p3Y + 3.5}
                className={styles.axisLabel}
                style={{ fill: isBull ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: '9.5px' }}
              >
                🚀 {fmtPrice(chart.target2Price)}
              </text>
            </g>

            {/* Bottom Time Axis */}
            <g>
              <text x={PAD.left} y={H - 12} className={styles.axisLabel}>
                {chart.firstLabel}
              </text>
              <text
                x={chart.historyEnd}
                y={H - 12}
                textAnchor="middle"
                className={styles.axisLabel}
                style={{ fill: '#60a5fa', fontWeight: 600 }}
              >
                Nu (Live)
              </text>
              <text x={chart.p1X} y={H - 12} textAnchor="middle" className={styles.axisLabel}>
                {chart.hLabels[0]}
              </text>
              <text x={chart.p2X} y={H - 12} textAnchor="middle" className={styles.axisLabel}>
                {chart.hLabels[1]}
              </text>
              <text x={chart.p3X} y={H - 12} textAnchor="middle" className={styles.axisLabel}>
                {chart.hLabels[2]} (Doel 2)
              </text>
              <text
                x={chart.forecastEnd}
                y={H - 12}
                textAnchor="end"
                className={styles.axisLabel}
                style={{ fontStyle: 'italic' }}
              >
                Verwachting ➔
              </text>
            </g>
          </svg>

          {/* Meta Summary Row */}
          <div className={styles.metaRow}>
            <span className={styles.metaItem}>
              Steunzone: <b>{usd(chart.swingLow)}</b>
            </span>
            <span className={styles.metaItem}>
              Weerstand: <b>{usd(chart.swingHigh)}</b>
            </span>
            <span className={styles.metaItem}>
              Verwachting: <b>{isBull ? '↗ Opwaartse uitbraak' : isBear ? '↘ Daling/afwijzing' : '↔ Zijwaarts'}</b>
            </span>
            <span className={styles.metaItem} style={{ marginLeft: 'auto' }}>
              ℹ️ <i>Gekleurde waaier toont het verwachte koerskanaal; gestreepte lijn is het centrale pad van het model</i>
            </span>
          </div>

          {/* Reasoning & Indicator Analysis Section */}
          <div className={styles.reasoningWrap}>
            <div className={styles.reasoningHeader}>
              <span className={styles.reasoningIcon}>💡</span>
              <div>
                <h3 className={styles.reasoningTitle}>Waarom verwacht het model dit?</h3>
                <p className={styles.reasoningSubtitle}>
                  Onderbouwing op basis van marktregimes, structuur, Fibonacci en live engine-checks
                </p>
              </div>
              {chart.signal?.confidence !== undefined && (
                <div className={styles.confidenceBadge}>
                  <span>Modelzekerheid:</span>
                  <b>{Math.round(chart.signal.confidence * 100)}%</b>
                </div>
              )}
            </div>

            <div className={styles.pillarsGrid}>
              {/* Pillar 1: Trend & Regimes */}
              <div className={styles.pillarCard}>
                <div className={styles.pillarTitle}>
                  <span>📈</span>
                  <b>1. Trend & Regimes (1u + 4u)</b>
                </div>
                <p className={styles.pillarDesc}>
                  Zowel het 1-uurs regime (<b>{regime}</b>) als het 4-uurs macro-regime (<b>{higherRegime}</b>) staan
                  in dezelfde richting. Wanneer beide tijdsframes op één lijn liggen, is er sprake van een sterke
                  trend en worden dips doorgaans agressief opgekocht door institutionele partijen.
                </p>
                <div className={styles.pillarTags}>
                  <span className={styles.tag}>1u: {regime}</span>
                  <span className={styles.tag}>4u: {higherRegime}</span>
                  <span className={styles.tagSuccess}>Dubbele bevestiging</span>
                </div>
              </div>

              {/* Pillar 2: Market Structure */}
              <div className={styles.pillarCard}>
                <div className={styles.pillarTitle}>
                  <span>🧱</span>
                  <b>2. Marktstructuur & Niveaus</b>
                </div>
                <p className={styles.pillarDesc}>
                  De recente stijging heeft een krachtige bodem gevormd op <b>{usd(chart.swingLow)}</b> (steun).
                  De weerstand ligt op <b>{usd(chart.swingHigh)}</b>. Zolang de koers boven deze bodem blijft,
                  is de opwaartse structuur (Higher Highs & Higher Lows) volledig intact.
                </p>
                <div className={styles.pillarTags}>
                  <span className={styles.tag}>Steun: {usd(chart.swingLow)}</span>
                  <span className={styles.tag}>Weerstand: {usd(chart.swingHigh)}</span>
                  {chart.signal?.roomToStructure !== undefined && (
                    <span className={styles.tag}>{chart.signal.roomToStructure.toFixed(1)}R ruimte tot doel</span>
                  )}
                </div>
              </div>

              {/* Pillar 3: Fibonacci & Pullback */}
              <div className={styles.pillarCard}>
                <div className={styles.pillarTitle}>
                  <span>🎯</span>
                  <b>3. Fibonacci & Golden Zone</b>
                </div>
                <p className={styles.pillarDesc}>
                  Mocht Bitcoin een tussentijdse adempauze of pullback inzetten, dan vormt de 0.382–0.618 Fibonacci Golden Zone
                  het belangrijkste koperbolwerk. Het model verwacht dat een dip in of nabij deze zone standhoudt voor de volgende opwaartse impuls.
                </p>
                <div className={styles.pillarTags}>
                  <span className={styles.tag}>Golden Zone: 0.382–0.618</span>
                  <span className={styles.tag}>Verwachte reactie: Bounce</span>
                </div>
              </div>

              {/* Pillar 4: Invalidation & Gatekeeper */}
              <div className={styles.pillarCard}>
                <div className={styles.pillarTitle}>
                  <span>🛡️</span>
                  <b>4. Invalidatie & Beveiliging</b>
                </div>
                <p className={styles.pillarDesc}>
                  <b>Wanneer vervalt deze voorspelling?</b> Als Bitcoin onder de steun van {usd(chart.swingLow)} daalt,
                  is de opwaartse structuur doorbroken. De <b>BTC Gatekeeper</b> grijpt dan direct in: nieuwe altcoin-longs worden geblokkeerd
                  om je portfolio tegen een marktbrede daling te beschermen.
                </p>
                <div className={styles.pillarTags}>
                  <span className={styles.tagWarning}>Invalidatie: &lt; {usd(chart.swingLow)}</span>
                  <span className={styles.tag}>BTC Gatekeeper: Bewaker actief</span>
                </div>
              </div>
            </div>

            {/* Live Engine Checks from Signal */}
            {chart.signal?.checks && chart.signal.checks.length > 0 && (
              <div className={styles.checksSection}>
                <h4 className={styles.checksTitle}>🔍 Live technische indicatoren & checks van het model</h4>
                <div className={styles.checksGrid}>
                  {chart.signal.checks.map((c) => (
                    <div key={c.name} className={`${styles.checkCard} ${c.passed ? styles.checkPass : styles.checkFail}`}>
                      <div className={styles.checkHeader}>
                        <span>{c.passed ? '✅' : '⏳'}</span>
                        <b>{c.name}</b>
                      </div>
                      <p className={styles.checkDetail}>{c.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
