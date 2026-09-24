import { useEffect, useRef, useState } from 'react';
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
  const [showAllChecks, setShowAllChecks] = useState<Record<string, boolean>>({});
  const mounted = useRef(false);
  const requestIds = useRef<Record<string, number>>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const symbol of Object.keys(requestIds.current)) requestIds.current[symbol]++;
    };
  }, []);

  const loadInlineChart = (symbol: string) => {
    const requestId = (requestIds.current[symbol] || 0) + 1;
    requestIds.current[symbol] = requestId;
    setInlineLoading((prev) => ({ ...prev, [symbol]: true }));
    setInlineError((prev) => ({ ...prev, [symbol]: null }));
    void fetchChart(symbol, 'Min60')
      .then((data) => {
        if (mounted.current && requestIds.current[symbol] === requestId) {
          setInlineChart((prev) => ({ ...prev, [symbol]: data }));
        }
      })
      .catch((err) => {
        if (mounted.current && requestIds.current[symbol] === requestId) {
          setInlineError((prev) => ({ ...prev, [symbol]: (err as Error).message }));
        }
      })
      .finally(() => {
        if (mounted.current && requestIds.current[symbol] === requestId) {
          setInlineLoading((prev) => ({ ...prev, [symbol]: false }));
        }
      });
  };

  const toggleExpand = (symbol: string) => {
    if (expandedSymbol === symbol) {
      setExpandedSymbol(null);
      return;
    }
    setExpandedSymbol(symbol);
    if (!inlineChart[symbol]) {
      loadInlineChart(symbol);
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
        const passedChecks = s.checks?.filter((c) => c.passed) || [];
        const failedChecks = s.checks?.filter((c) => !c.passed) || [];
        const isChecksExpanded = Boolean(showAllChecks[s.symbol]);

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

            {/* Clean Structured Meta Grid */}
            <div className={styles.signalMetaGrid}>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Prijs</span>
                <span className={styles.metaVal}>{fmtPrice(s.price)}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>ATR</span>
                <span className={styles.metaVal}>{pct(s.atrPct, 2)}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Hoger TF</span>
                <span className={styles.metaVal}>{s.higherRegime}</span>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Ruimte</span>
                <span className={styles.metaVal}>
                  {Number.isFinite(s.roomToStructure) ? `${s.roomToStructure.toFixed(1)}R` : '—'}
                </span>
              </div>
              {s.fib && (
                <>
                  <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Golden Zone</span>
                    <span className={`${styles.metaVal} ${styles.metaHighlight}`}>
                      {fmtPrice(s.fib.retracements.find((l) => l.ratio === 0.618)!.price)} –{' '}
                      {fmtPrice(s.fib.retracements.find((l) => l.ratio === 0.382)!.price)}
                    </span>
                  </div>
                  <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Fib Swing</span>
                    <span className={styles.metaVal}>
                      {fmtPrice(s.fib.swingLow)} – {fmtPrice(s.fib.swingHigh)}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Clean Confluence Bar (Shows only unmet/waiting conditions & summary) */}
            {s.checks?.length > 0 && (
              <div className={styles.confluenceBar}>
                <span
                  className={`${styles.confluencePill} ${
                    failedChecks.length === 0 ? styles.confluencePillReady : styles.confluencePillPending
                  }`}
                >
                  {failedChecks.length === 0
                    ? `🎯 Alle ${s.checks.length} checks OK`
                    : `⏳ ${passedChecks.length}/${s.checks.length} Confluences`}
                </span>

                {/* Show ONLY the failed/unmet checks so user immediately sees what is missing */}
                {failedChecks.map((c) => (
                  <span
                    key={c.name}
                    className={`${styles.check} ${styles.checkFail}`}
                    title={c.detail}
                  >
                    ✗ {c.name}
                  </span>
                ))}

                <button
                  type="button"
                  className={styles.checkToggleBtn}
                  onClick={() =>
                    setShowAllChecks((prev) => ({ ...prev, [s.symbol]: !prev[s.symbol] }))
                  }
                  title="Toon/verberg alle individuele checks"
                >
                  {isChecksExpanded ? 'Details verbergen ▴' : `Alle checks (${passedChecks.length}✓) ▾`}
                </button>
              </div>
            )}

            {/* Expanded full checklist if toggled */}
            {isChecksExpanded && s.checks?.length > 0 && (
              <div className={styles.checksExpanded}>
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
                      onClick={() => loadInlineChart(s.symbol)}
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
