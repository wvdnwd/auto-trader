import { useState } from 'react';
import styles from './trader-app.module.css';
import { fetchChart } from './api.js';
import { coinInfo, splitSymbol } from './coin-info.js';
import { pct, price as fmtPrice } from './format.js';
import { SignalChart } from './signal-chart.js';
import type { ChartData, Signal } from './types.js';

export type SignalListProps = {
  /** Ranked signals from the latest scan. */
  signals: Signal[];
  /** Minimum confidence required for an entry, used to shade the bar. */
  threshold: number;
  /** Opens the chart for a symbol, drawing the swing/golden zone the engine is watching. */
  onOpenChart?: (symbol: string) => void;
};

/**
 * Ranked list of scanned markets with direction, regime and conviction,
 * now featuring an expandable chart with wait-zone drawings, multi-timeframe
 * switching, and strategic explanations.
 */
export function SignalList({ signals, threshold, onOpenChart }: SignalListProps) {
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [inlineChart, setInlineChart] = useState<Record<string, ChartData | null>>({});
  const [inlineLoading, setInlineLoading] = useState<Record<string, boolean>>({});
  const [inlineError, setInlineError] = useState<Record<string, string | null>>({});

  const toggleExpand = (symbol: string) => {
    if (expandedSymbol === symbol) {
      setExpandedSymbol(null);
      return;
    }
    setExpandedSymbol(symbol);
    if (!inlineChart[symbol]) {
      setInlineLoading((prev) => ({ ...prev, [symbol]: true }));
      setInlineError((prev) => ({ ...prev, [symbol]: null }));
      fetchChart(symbol, 'Min60')
        .then((data) => setInlineChart((prev) => ({ ...prev, [symbol]: data })))
        .catch((err) => setInlineError((prev) => ({ ...prev, [symbol]: (err as Error).message })))
        .finally(() => setInlineLoading((prev) => ({ ...prev, [symbol]: false })));
    }
  };

  if (!signals.length) {
    return <p className={styles.empty}>Nog geen scan uitgevoerd — even geduld.</p>;
  }

  return (
    <div className={styles.rows}>
      {signals.slice(0, 10).map((s) => {
        const passes = s.confidence >= threshold;
        const isExpanded = expandedSymbol === s.symbol;
        const chartData = inlineChart[s.symbol];
        const loading = inlineLoading[s.symbol];
        const err = inlineError[s.symbol];

        return (
          <div key={s.symbol} className={styles.signal}>
            <div className={styles.rowTop}>
              <div className={styles.symbolWrap}>
                <span className={styles.coinBadge} style={{ background: coinInfo(s.symbol).color }}>
                  {splitSymbol(s.symbol).base.slice(0, 1)}
                </span>
                <span className={styles.symbolText}>
                  <span className={styles.symbol}>{s.symbol.replace('_', '/')}</span>
                  <span className={styles.coinName}>{coinInfo(s.symbol).name}</span>
                </span>
                <span className={`${styles.tag} ${s.side === 'LONG' ? styles.long : styles.short}`}>
                  {s.side}
                </span>
                <span className={`${styles.tag} ${styles.neutral}`}>{s.regime}</span>
                {s.alignedWithHigher ? (
                  <span className={`${styles.tag} ${styles.safe}`}>1u ✓ {s.higherRegime}</span>
                ) : s.higherRegime === 'CHOP' ? (
                  <span className={`${styles.tag} ${styles.amber}`}>1u CHOP</span>
                ) : (
                  <span className={`${styles.tag} ${styles.neutral}`}>1u {s.higherRegime}</span>
                )}
                {s.plannedLeverage !== null && (
                  <span
                    className={`${styles.tag} ${styles.lev}`}
                    title="Hefboom die de engine nu zou gebruiken voor dit signaal"
                  >
                    {s.plannedLeverage}x
                  </span>
                )}
              </div>
              <span className={`${styles.pnl} ${passes ? styles.up : ''}`} style={{ fontSize: '0.82rem' }}>
                {pct(s.confidence, 0)}
              </span>
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <button
                  type="button"
                  className={`${styles.miniBtn} ${isExpanded ? styles.miniBtnActive : ''}`}
                  onClick={() => toggleExpand(s.symbol)}
                  title="Toon/verberg interactieve grafiek en wachtzone analyse"
                >
                  {isExpanded ? '📊 Sluit grafiek ▴' : '📊 Grafiek & Wachtzone ▾'}
                </button>
                {onOpenChart && (
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => onOpenChart(s.symbol)}
                    title="Open in volledig scherm"
                  >
                    ↗
                  </button>
                )}
              </div>
            </div>
            <div className={styles.confBar}>
              <div
                className={styles.confFill}
                style={{
                  width: `${Math.min(100, s.confidence * 100)}%`,
                  background: passes ? 'var(--green)' : 'var(--muted)',
                }}
              />
            </div>
            <div className={styles.meta}>
              <span>
                Prijs<b>{fmtPrice(s.price)}</b>
              </span>
              <span>
                ATR<b>{pct(s.atrPct, 2)}</b>
              </span>
              <span>
                Hoger TF<b>{s.higherRegime}</b>
              </span>
              <span>
                Ruimte<b>{Number.isFinite(s.roomToStructure) ? `${s.roomToStructure.toFixed(1)}R` : '—'}</b>
              </span>
            </div>

            {s.fib && (
              <div className={styles.meta}>
                <span>
                  Fib swing<b>{fmtPrice(s.fib.swingLow)} – {fmtPrice(s.fib.swingHigh)}</b>
                </span>
                <span>
                  Golden zone<b>
                    {fmtPrice(s.fib.retracements.find((l) => l.ratio === 0.618)!.price)} –{' '}
                    {fmtPrice(s.fib.retracements.find((l) => l.ratio === 0.382)!.price)}
                  </b>
                </span>
              </div>
            )}

            {/* The named conditions the engine weighed before allowing this entry. */}
            {s.checks?.length > 0 && (
              <div className={styles.checks}>
                {s.checks.map((c) => (
                  <span
                    key={c.name}
                    className={`${styles.check} ${c.passed ? '' : styles.checkFail}`}
                    title={c.detail}
                  >
                    {c.passed ? '✓' : '✗'} {c.name}
                  </span>
                ))}
              </div>
            )}

            {/* Expandable Inline Chart with Timeframes, Drawings & Hoe/Wat Explanation */}
            {isExpanded && (
              <div className={styles.inlineChartWrap}>
                {loading && (
                  <p className={styles.empty} style={{ padding: '0.8rem 0' }}>
                    Grafiek en wachtzone laden voor {s.symbol.replace('_', '/')}…
                  </p>
                )}
                {err && (
                  <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.6rem 0' }}>
                    <p className={styles.empty} style={{ color: 'var(--red)' }}>
                      Grafiek kon niet worden geladen: {err}
                    </p>
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={() => {
                        setInlineLoading((prev) => ({ ...prev, [s.symbol]: true }));
                        setInlineError((prev) => ({ ...prev, [s.symbol]: null }));
                        fetchChart(s.symbol, 'Min60')
                          .then((data) => setInlineChart((prev) => ({ ...prev, [s.symbol]: data })))
                          .catch((e) => setInlineError((prev) => ({ ...prev, [s.symbol]: (e as Error).message })))
                          .finally(() => setInlineLoading((prev) => ({ ...prev, [s.symbol]: false })));
                      }}
                    >
                      🔄 Opnieuw
                    </button>
                  </div>
                )}
                {!loading && !err && (
                  <SignalChart
                    candles={chartData?.candles}
                    signal={chartData?.signal || s}
                    symbol={s.symbol}
                    position={chartData?.position}
                    plannedTrade={chartData?.plannedTrade}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
