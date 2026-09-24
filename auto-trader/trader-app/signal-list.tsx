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

type OutbreakInfo = {
  isCoinInPlay: boolean;
  badgeText: string;
  badgeClass: 'badgeSuccess' | 'badgeNeutral';
  statusText: string;
  targetMode: string;
  plan: string;
};

function getOutbreakInfo(s: Signal): OutbreakInfo {
  const spurtCheck = s.checks?.find((c) => c.name === 'Volume Spurt');
  const isCoinInPlay = Boolean(spurtCheck?.passed);
  return {
    isCoinInPlay,
    badgeText: isCoinInPlay ? '🚀 Coin in Play' : 'Normaal Volume',
    badgeClass: isCoinInPlay ? 'badgeSuccess' : 'badgeNeutral',
    statusText: isCoinInPlay ? 'Volume-explosie gedetecteerd' : 'Geen volume-uitbraak',
    targetMode: isCoinInPlay ? 'Runner (TP3 5.0R+)' : 'Standaard Swing (TP 1.8-2.7R)',
    plan: isCoinInPlay
      ? 'Sterk outbreak momentum! Bot mikt op versnelde expansie en hoge multi-R runner targets (TP3 5.0R+).'
      : 'Normaal marktvolume. Bot volgt reguliere swing structuur en wacht op versnelling.',
  };
}

type FibPullbackInfo = {
  gzRange: string;
  swingRange: string;
  badgeText: string;
  badgeClass: 'badgeSuccess' | 'badgeTeal' | 'badgeWarning';
  isBounce: boolean;
  isPriceInGz: boolean;
  status: string;
};

function getFibPullbackInfo(s: Signal): FibPullbackInfo {
  const fibCheck = s.checks?.find((c) => c.name === 'Fibonacci confluentie');
  const pullbackCheck = s.checks?.find((c) => c.name === 'Sniper Pullback');
  const inPullback = Boolean(pullbackCheck?.passed);

  let gzLow = 0;
  let gzHigh = 0;
  if (s.fib?.retracements) {
    const p382 = s.fib.retracements.find((l) => l.ratio === 0.382)?.price ?? 0;
    const p618 = s.fib.retracements.find((l) => l.ratio === 0.618)?.price ?? 0;
    gzLow = Math.min(p382, p618);
    gzHigh = Math.max(p382, p618);
  }

  const isPriceInGz = gzLow > 0 && s.price >= gzLow && s.price <= gzHigh;
  const isBounce = Boolean(
    pullbackCheck?.detail?.toLowerCase().includes('bounce') ||
    pullbackCheck?.detail?.toLowerCase().includes('wick')
  );

  let badgeText = '⏳ Wacht op Retracement';
  let badgeClass: 'badgeSuccess' | 'badgeTeal' | 'badgeWarning' = 'badgeWarning';
  let status = s.side === 'LONG'
    ? 'Koers staat boven de Golden Zone — bot wacht tot prijs zakt naar de zone.'
    : 'Koers staat onder de Golden Zone — bot wacht tot prijs herstelt naar de zone.';

  if (isBounce) {
    badgeText = '🔥 Bounce Bevestigd';
    badgeClass = 'badgeSuccess';
    status = 'Tag & reject bounce gezien vanaf de Golden Zone — instap op de bounce!';
  } else if (isPriceInGz) {
    badgeText = '🎯 In Golden Zone';
    badgeClass = 'badgeSuccess';
    status = 'Koers zit direct in de Golden Zone (0.382–0.618) — klaar voor omkeer!';
  } else if (inPullback) {
    badgeText = '✅ Gezonde Pullback';
    badgeClass = 'badgeTeal';
    status = `Koers binnen gezonde afstand van EMA21 (${pullbackCheck?.detail || 'Pullback OK'}).`;
  }

  return {
    gzRange: gzLow > 0 ? `${fmtPrice(gzLow)} – ${fmtPrice(gzHigh)}` : (s.fib ? 'In berekening' : 'Geen data'),
    swingRange: s.fib ? `${fmtPrice(s.fib.swingLow)} – ${fmtPrice(s.fib.swingHigh)}` : '—',
    badgeText,
    badgeClass,
    isBounce,
    isPriceInGz,
    status,
  };
}

type ActionPlanInfo = {
  badgeText: string;
  badgeClass: 'badgeSuccess' | 'badgeWarning' | 'badgeNeutral';
  actionTitle: string;
  actionDetail: string;
  higherTfText: string;
  leverageText: string;
};

function getActionPlan(s: Signal, threshold: number): ActionPlanInfo {
  const passes = s.confidence >= threshold;
  const failedChecks = s.checks?.filter((c) => !c.passed) || [];
  const pullbackCheck = s.checks?.find((c) => c.name === 'Sniper Pullback');
  const higherTfCheck = s.checks?.find((c) => c.name === 'Hoger tijdsframe');
  const structureCheck = s.checks?.find((c) => c.name === 'Ruimte tot structuur');
  const regimeCheck = s.checks?.find((c) => c.name === 'Verhandelbaar regime');

  let badgeText = `⏳ ${failedChecks.length} Check(s) Open`;
  let badgeClass: 'badgeSuccess' | 'badgeWarning' | 'badgeNeutral' = 'badgeWarning';
  let actionTitle = 'Wachten op confluences';
  const missing = failedChecks.map((c) => c.name).slice(0, 2).join(', ');
  let actionDetail = missing
    ? `Wacht op ontbrekende voorwaarden (${missing}). Bot bewaakt de markt actief.`
    : 'Wachten op bevestiging van het handelssignaal.';

  if (passes && failedChecks.length === 0) {
    badgeText = '⚡ Gereed voor Order';
    badgeClass = 'badgeSuccess';
    actionTitle = 'Klaar voor order';
    actionDetail = `Alle filters zijn groen (${s.checks.length}/${s.checks.length}). Bot wacht op de 5m trigger-kaars om direct een ${s.side} positie te openen met ${s.plannedLeverage ?? 5}x hefboom.`;
  } else if (regimeCheck && !regimeCheck.passed) {
    badgeText = '🛑 CHOP / Geen Trend';
    badgeClass = 'badgeNeutral';
    actionTitle = 'Zijwaartse markt (CHOP)';
    actionDetail = 'De markt zit in chop zonder duidelijke trend. Bot plaatst géén orders om verlies te vermijden.';
  } else if (pullbackCheck && !pullbackCheck.passed) {
    badgeText = '⏳ Wacht op Dip';
    badgeClass = 'badgeWarning';
    actionTitle = 'Niet blind kopen (FOMO-stop)';
    actionDetail = 'Koers is te ver weggelopen. De bot koopt pas bij een gezonde retracement richting de Golden Zone / EMA21.';
  } else if (higherTfCheck && !higherTfCheck.passed) {
    badgeText = '⚠️ Trend Conflict';
    badgeClass = 'badgeWarning';
    actionTitle = 'Hoger tijdsframe conflict';
    actionDetail = `1-uurs regime (${s.higherRegime}) bevestigt de ${s.side} trade nog niet. Bot wacht tot hogere tijdsframes synchroon lopen.`;
  } else if (structureCheck && !structureCheck.passed) {
    badgeText = '⚠️ Weerstand Nabij';
    badgeClass = 'badgeWarning';
    actionTitle = 'Onvoldoende ademruimte';
    actionDetail = `Slechts ${Number.isFinite(s.roomToStructure) ? s.roomToStructure.toFixed(1) : 0}R tot steun/weerstand (minimaal 2.0R vereist).`;
  }

  return {
    badgeText,
    badgeClass,
    actionTitle,
    actionDetail,
    higherTfText: `1u: ${s.higherRegime} ${s.alignedWithHigher ? '✓' : '✗'}`,
    leverageText: s.plannedLeverage ? `${s.plannedLeverage}x hefboom` : 'Geen hefboom ingesteld',
  };
}

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
        const outbreakInfo = getOutbreakInfo(s);
        const fibInfo = getFibPullbackInfo(s);
        const actionPlan = getActionPlan(s, threshold);

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

            {/* 3 Dedicated Strategy Boxes: Outbreak, Golden Zone, Swing Actieplan */}
            <div className={styles.strategyTrioGrid}>
              {/* Box 1: Outbreak & Momentum */}
              <div className={styles.strategyBox}>
                <div className={styles.strategyBoxHead}>
                  <span className={styles.strategyBoxTitle}>🚀 Outbreak & Momentum</span>
                  <span className={`${styles.strategyBadge} ${styles[outbreakInfo.badgeClass]}`}>
                    {outbreakInfo.badgeText}
                  </span>
                </div>
                <div className={styles.strategyBoxBody}>
                  <div className={styles.strategyMetricRow}>
                    <span className={styles.strategyMetricLabel}>Status</span>
                    <span className={styles.strategyMetricVal}>{outbreakInfo.statusText}</span>
                  </div>
                  <div className={styles.strategyMetricRow}>
                    <span className={styles.strategyMetricLabel}>Target Modus</span>
                    <span className={styles.strategyMetricVal}>{outbreakInfo.targetMode}</span>
                  </div>
                  <div
                    className={`${styles.strategyPlanText} ${
                      outbreakInfo.isCoinInPlay ? styles.strategyPlanTextSuccess : ''
                    }`}
                  >
                    {outbreakInfo.plan}
                  </div>
                </div>
              </div>

              {/* Box 2: Fibonacci Golden Zone & Pullback */}
              <div className={styles.strategyBox}>
                <div className={styles.strategyBoxHead}>
                  <span className={styles.strategyBoxTitle}>🎯 Golden Zone & Pullback</span>
                  <span className={`${styles.strategyBadge} ${styles[fibInfo.badgeClass]}`}>
                    {fibInfo.badgeText}
                  </span>
                </div>
                <div className={styles.strategyBoxBody}>
                  <div className={styles.strategyMetricRow}>
                    <span className={styles.strategyMetricLabel}>Golden Zone</span>
                    <span className={`${styles.strategyMetricVal} ${styles.metaHighlight}`}>
                      {fibInfo.gzRange}
                    </span>
                  </div>
                  <div className={styles.strategyMetricRow}>
                    <span className={styles.strategyMetricLabel}>Swing Range</span>
                    <span className={styles.strategyMetricVal}>{fibInfo.swingRange}</span>
                  </div>
                  <div
                    className={`${styles.strategyPlanText} ${
                      fibInfo.isBounce || fibInfo.isPriceInGz
                        ? styles.strategyPlanTextSuccess
                        : styles.strategyPlanTextWarning
                    }`}
                  >
                    {fibInfo.status}
                  </div>
                </div>
              </div>

              {/* Box 3: Swing Trend & Actieplan */}
              <div className={styles.strategyBox}>
                <div className={styles.strategyBoxHead}>
                  <span className={styles.strategyBoxTitle}>📊 Swing Actieplan</span>
                  <span className={`${styles.strategyBadge} ${styles[actionPlan.badgeClass]}`}>
                    {actionPlan.badgeText}
                  </span>
                </div>
                <div className={styles.strategyBoxBody}>
                  <div className={styles.strategyMetricRow}>
                    <span className={styles.strategyMetricLabel}>Trend 1u</span>
                    <span className={styles.strategyMetricVal}>{actionPlan.higherTfText}</span>
                  </div>
                  <div className={styles.strategyMetricRow}>
                    <span className={styles.strategyMetricLabel}>Hefboom</span>
                    <span className={styles.strategyMetricVal}>{actionPlan.leverageText}</span>
                  </div>
                  <div
                    className={`${styles.strategyPlanText} ${
                      actionPlan.badgeClass === 'badgeSuccess'
                        ? styles.strategyPlanTextSuccess
                        : styles.strategyPlanTextWarning
                    }`}
                  >
                    <b>{actionPlan.actionTitle}:</b> {actionPlan.actionDetail}
                  </div>
                </div>
              </div>
            </div>

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
