import { useMemo } from 'react';
import styles from './backtest.module.css';
import { usd } from './format.js';
import type { EquityPoint } from './types.js';

/** Props for {@link EquityChart}. */
export type EquityChartProps = {
  /** The equity curve to plot, oldest first. */
  curve: EquityPoint[];
  /** Balance the run started with, drawn as the break-even line. */
  startingBalance: number;
};

const W = 720;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 20, left: 52 };

/**
 * Equity curve of a backtest, with the break-even line and drawdown shading.
 *
 * Drawn as an inline SVG rather than a chart library — the shape is simple and
 * this keeps the dashboard free of an extra dependency.
 */
export function EquityChart({ curve, startingBalance }: EquityChartProps) {
  const chart = useMemo(() => {
    if (curve.length < 2) return null;
    // Long runs produce far more points than pixels, so sample down to keep the
    // path small without changing the visible shape.
    const stride = Math.max(1, Math.floor(curve.length / 600));
    const points = curve.filter((_, i) => i % stride === 0 || i === curve.length - 1);

    const values = points.map((p) => p.equity).concat(startingBalance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.max(1, max * 0.01);
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (i / (points.length - 1)) * innerW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - PAD.bottom).toFixed(1)} L${PAD.left},${(
      H - PAD.bottom
    ).toFixed(1)} Z`;

    const ticks = [hi, (hi + lo) / 2, lo].map((v) => ({ v, y: y(v) }));
    const final = points[points.length - 1].equity;
    return {
      line,
      area,
      ticks,
      breakEvenY: y(startingBalance),
      up: final >= startingBalance,
      first: points[0],
      last: points[points.length - 1],
    };
  }, [curve, startingBalance]);

  if (!chart) {
    return <p className={styles.empty}>Te weinig datapunten om een grafiek te tekenen.</p>;
  }

  const stroke = chart.up ? 'var(--green)' : 'var(--red)';
  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Equity van ${usd(chart.first.equity)} naar ${usd(chart.last.equity)}`}
    >
      <defs>
        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {chart.ticks.map((t) => (
        <g key={t.v}>
          <line x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} className={styles.gridLine} />
          <text x={PAD.left - 8} y={t.y + 3} textAnchor="end" className={styles.axisLabel}>
            {usd(t.v, 0)}
          </text>
        </g>
      ))}

      <line
        x1={PAD.left}
        y1={chart.breakEvenY}
        x2={W - PAD.right}
        y2={chart.breakEvenY}
        className={styles.breakEven}
      />

      <path d={chart.area} fill="url(#equityFill)" />
      <path d={chart.line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
