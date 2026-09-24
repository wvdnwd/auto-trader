import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './backtest.module.css';
import { fetchWalkForward, startWalkForward } from './api.js';
import { BacktestForm } from './backtest-form.js';
import { pct, shortDate } from './format.js';
import type { BacktestConfig, WalkForwardStatus } from './types.js';

/** How often progress is polled while an analysis is in flight. */
const POLL_MS = 1500;

/** The share of profitable windows below which a strategy is not trustworthy. */
const TARGET_RATE = 0.8;

/**
 * Walk-forward view — evaluates the strategy across every 300-day window in the
 * available history instead of a single hand-picked period.
 *
 * One backtest can always find a flattering stretch of market. This answers the
 * question that actually matters before risking money: across all the history
 * we have, how often did this work, and how bad was the worst run?
 */
export function WalkForwardPanel() {
  const [status, setStatus] = useState<WalkForwardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const requestId = useRef(0);

  const poll = useCallback(async (runId = generation.current) => {
    const currentRequest = ++requestId.current;
    try {
      const next = await fetchWalkForward();
      if (!mounted.current || runId !== generation.current || currentRequest !== requestId.current) return;
      setStatus(next);
      if (next.state === 'loading' || next.state === 'running') {
        timer.current = setTimeout(() => void poll(runId), POLL_MS);
      }
    } catch (err) {
      if (!mounted.current || runId !== generation.current || currentRequest !== requestId.current) return;
      const message = (err as Error).message;
      setError(message);
      setStatus({ state: 'error', message, progress: 0, report: null });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void poll(generation.current);
    return () => {
      mounted.current = false;
      generation.current++;
      requestId.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  const run = async (config: Partial<BacktestConfig>) => {
    const runId = ++generation.current;
    requestId.current++;
    if (timer.current) clearTimeout(timer.current);
    setError(null);
    setStatus({ state: 'loading', message: 'Walk-forward starten…', progress: 0, report: null });
    try {
      const initial = await startWalkForward(config);
      if (!mounted.current || runId !== generation.current) return;
      setStatus(initial);
      if (initial.state === 'loading' || initial.state === 'running') {
        timer.current = setTimeout(() => void poll(runId), POLL_MS);
      }
    } catch (err) {
      if (!mounted.current || runId !== generation.current) return;
      const message = (err as Error).message;
      setError(message);
      setStatus({ state: 'error', message, progress: 0, report: null });
    }
  };

  const busy = status?.state === 'loading' || status?.state === 'running';
  const report = status?.report;

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h2>Walk-forward analyse</h2>
        <p>
          Test de strategie op elk venster van 300 dagen in de beschikbare historie, steeds
          60 dagen opgeschoven. Eén goede backtest zegt weinig — dit laat zien in hoeveel
          van alle periodes de strategie werkte, en hoe slecht de slechtste was.
        </p>
      </div>

      <BacktestForm
        onRun={run}
        busy={busy}
        submitLabel="Walk-forward draaien"
        // A 300-day window needs well over 300 days of history to roll through, so
        // the default period here is far longer than for a single backtest.
        defaultDays={730}
      />

      {error && <div className={styles.error}>{error}</div>}

      {busy && (
        <div className={styles.progress}>
          <div className={styles.progressBar}>
            <span style={{ width: `${Math.round((status?.progress || 0) * 100)}%` }} />
          </div>
          <span>{status?.message}</span>
        </div>
      )}

      {status?.state === 'error' && <div className={styles.error}>{status.message}</div>}

      {report && report.windowCount > 0 && (
        <div className={styles.summary}>
          <div
            className={`${styles.verdict} ${
              report.positiveRate >= TARGET_RATE ? styles.good : styles.bad
            }`}
          >
            <strong>
              {pct(report.positiveRate, 0)} van de {report.windowCount} periodes was winstgevend
              {report.positiveRate >= TARGET_RATE
                ? ' — boven de 80%-drempel.'
                : ' — onder de 80%-drempel.'}
            </strong>
            <span>
              Slechtste periode {pct(report.worstReturnPct, 1)} met een maximale terugval van{' '}
              {pct(report.worstDrawdownPct, 1)}. Dat is het scenario om op te plannen, niet de
              mediaan.
            </span>
          </div>

          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Winstgevende periodes</span>
              <span className={styles.metricValue}>{pct(report.positiveRate, 0)}</span>
              <span className={styles.metricSub}>{report.windowCount} vensters</span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Mediaan rendement</span>
              <span className={`${styles.metricValue} ${styles.up}`}>
                {pct(report.medianReturnPct, 1)}
              </span>
              <span className={styles.metricSub}>per 300 dagen</span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Slechtste periode</span>
              <span
                className={`${styles.metricValue} ${
                  report.worstReturnPct >= 0 ? styles.up : styles.down
                }`}
              >
                {pct(report.worstReturnPct, 1)}
              </span>
              <span className={styles.metricSub}>realistisch slecht scenario</span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Diepste terugval</span>
              <span className={`${styles.metricValue} ${styles.down}`}>
                {pct(report.worstDrawdownPct, 1)}
              </span>
              <span className={styles.metricSub}>over alle vensters</span>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Mediaan profit factor</span>
              <span className={styles.metricValue}>{report.medianProfitFactor.toFixed(2)}</span>
              <span className={styles.metricSub}>winst ÷ verlies</span>
            </div>
          </div>

          <div className={styles.exits}>
            <h3>Alle periodes</h3>
            <div className={styles.exitGrid}>
              {report.windows.map((w) => (
                <div key={w.from} className={styles.exitCell}>
                  <span className={styles.exitName}>
                    {shortDate(w.from)} → {shortDate(w.to)}
                  </span>
                  <span className={w.returnPct >= 0 ? styles.up : styles.down}>
                    {pct(w.returnPct, 1)}
                  </span>
                  <span className={styles.dim}>
                    {w.trades} trades · terugval {pct(w.maxDrawdownPct, 0)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {report && report.windowCount === 0 && (
        <div className={styles.error}>
          Te weinig historie voor een venster van 300 dagen. Kies een langere periode.
        </div>
      )}
    </div>
  );
}
