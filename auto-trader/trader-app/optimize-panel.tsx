import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './backtest.module.css';
import { applyBestParams, fetchOptimize, startOptimize } from './api.js';
import { BacktestForm } from './backtest-form.js';
import { pct, signed } from './format.js';
import type { BacktestConfig, OptimizeStatus, OptimizeTrial } from './types.js';

/** How often progress is polled while a search runs. */
const POLL_MS = 1500;

/** Labels for the parameters the search varies. */
const PARAM_LABELS: Record<string, string> = {
  maxLeverage: 'Max hefboom',
  minConfidence: 'Min. conviction',
  atrStopMultiple: 'Stop (× ATR)',
  firstTargetR: 'Eerste target',
  firstTargetPortion: 'Deel bij target 1',
  finalTargetR: 'Laatste target',
  trailArmR: 'Trailing vanaf',
  requireHigherAlignment: 'Hoger TF vereist',
};

function formatParam(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'ja' : 'nee';
  if (typeof value !== 'number') return String(value);
  if (key === 'minConfidence' || key === 'firstTargetPortion') return pct(value, 0);
  if (key === 'maxLeverage') return `${value}×`;
  if (key.endsWith('R')) return `${value}R`;
  return String(value);
}

/** A plain-language reading of a search result. */
export type Verdict = {
  /** Style class conveying good / neutral / bad. */
  tone: string;
  /** Sentence shown to the user. */
  text: string;
  /** Machine-readable verdict, used in tests and for styling decisions. */
  kind: 'edge' | 'inconsistent' | 'overfit' | 'lucky' | 'none' | 'insufficient';
};

/**
 * Judge a search result.
 *
 * The out-of-sample expectancy is the whole point: a set of parameters that only
 * performs on the window it was chosen on has learned that window's noise, not a
 * repeatable edge. Reporting a lucky test window as success would defeat the
 * reason for splitting the data in the first place.
 *
 * @param best the top-ranked trial of the search.
 * @returns the verdict to display.
 */
export function verdictFor(best: OptimizeTrial): Verdict {
  const test = best.testResult;
  const train = best.trainResult;

  // Too few trades on either side and the comparison means nothing — this is
  // checked before anything else, because a handful of trades can show any
  // result at all and it would still be noise.
  if (test.trades < 30 || train.trades < 30) {
    return {
      kind: 'insufficient',
      tone: styles.neutral,
      text: `Te weinig trades om iets te concluderen (${train.trades} training, ${test.trades} test). Kies een langere periode of meer markten.`,
    };
  }

  // The two windows must agree. A set that loses on training and wins on test
  // has not found anything repeatable — it got lucky on one window, and reading
  // that as an edge is exactly the mistake this whole split exists to prevent.
  const gap = Math.abs(train.expectancyR - test.expectancyR);
  const bothPositive = train.expectancyR > 0.03 && test.expectancyR > 0.03;

  if (bothPositive && gap < 0.12) {
    return {
      kind: 'edge',
      tone: styles.good,
      text: `Consistente edge: ${train.expectancyR.toFixed(2)}R per trade op de trainingsdata en ${test.expectancyR.toFixed(2)}R op data die de zoektocht nooit zag. Dat de twee zo dicht bij elkaar liggen, is het sterkste signaal dat dit geen toeval is.`,
    };
  }
  if (bothPositive) {
    return {
      kind: 'inconsistent',
      tone: styles.neutral,
      text: `Beide periodes positief (${train.expectancyR.toFixed(2)}R training, ${test.expectancyR.toFixed(2)}R test), maar ze verschillen te veel om op te bouwen. Test een langere periode voordat je dit vertrouwt.`,
    };
  }
  if (train.expectancyR > 0.1 && test.expectancyR <= 0.03) {
    return {
      kind: 'overfit',
      tone: styles.bad,
      text: `Overfit: ${train.expectancyR.toFixed(2)}R per trade op de trainingsdata, maar ${test.expectancyR.toFixed(2)}R op onbekende data. Deze instellingen hebben de ruis van die periode geleerd, geen echte edge.`,
    };
  }
  if (train.expectancyR <= 0.03 && test.expectancyR > 0.1) {
    return {
      kind: 'lucky',
      tone: styles.neutral,
      text: `Onbetrouwbaar: verlies op de trainingsdata (${train.expectancyR.toFixed(2)}R) maar winst op de testperiode (${test.expectancyR.toFixed(2)}R). Dat is geluk in één venster, geen edge — een echte edge werkt in beide.`,
    };
  }
  return {
    kind: 'none',
    tone: styles.bad,
    text: `Geen bruikbare edge gevonden: beste is ${test.expectancyR.toFixed(2)}R per trade out-of-sample. De strategie zelf moet beter, niet de instellingen.`,
  };
}

/**
 * Parameter search view.
 *
 * Every candidate is scored twice: on a training window, and on a later window
 * held back from the selection. Only the second number is trustworthy, and the
 * panel shows both side by side so the difference is visible.
 */
export function OptimizePanel() {
  const [status, setStatus] = useState<OptimizeStatus>({
    state: 'idle',
    message: '',
    progress: 0,
    trials: [],
    best: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const requestId = useRef(0);

  const busy = status.state === 'loading' || status.state === 'running';

  const poll = useCallback(async (runId = generation.current) => {
    const currentRequest = ++requestId.current;
    try {
      const next = await fetchOptimize();
      if (!mounted.current || runId !== generation.current || currentRequest !== requestId.current) return;
      setStatus(next);
      if (next.state === 'loading' || next.state === 'running') {
        timer.current = setTimeout(() => void poll(runId), POLL_MS);
      }
    } catch (err) {
      if (!mounted.current || runId !== generation.current || currentRequest !== requestId.current) return;
      const message = (err as Error).message;
      setError(message);
      setStatus({ state: 'error', message, progress: 0, trials: [], best: null });
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

  const run = useCallback(
    async (config: Partial<BacktestConfig>) => {
      const runId = ++generation.current;
      requestId.current++;
      if (timer.current) clearTimeout(timer.current);
      setError(null);
      setApplied(false);
      setApplying(false);
      setStatus({ state: 'loading', message: 'Optimalisatie starten…', progress: 0, trials: [], best: null });
      try {
        const initial = await startOptimize(config);
        if (!mounted.current || runId !== generation.current) return;
        setStatus(initial);
        if (initial.state === 'loading' || initial.state === 'running') {
          timer.current = setTimeout(() => void poll(runId), POLL_MS);
        }
      } catch (err) {
        if (!mounted.current || runId !== generation.current) return;
        const message = (err as Error).message;
        setError(message);
        setStatus({ state: 'error', message, progress: 0, trials: [], best: null });
      }
    },
    [poll]
  );

  const apply = useCallback(async () => {
    const runId = generation.current;
    setApplying(true);
    try {
      await applyBestParams();
      if (mounted.current && runId === generation.current) setApplied(true);
    } catch (err) {
      if (mounted.current && runId === generation.current) setError((err as Error).message);
    } finally {
      if (mounted.current && runId === generation.current) setApplying(false);
    }
  }, []);

  const best = status.best;
  const call = best ? verdictFor(best) : null;

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h2>Optimalisatie</h2>
        <p>
          Test honderden combinaties van instellingen tegen historische data. De zoektocht kiest op
          de eerste 65% van de periode en toetst op de laatste 35% — data die hij nooit zag. Alleen
          dat tweede getal zegt iets over de toekomst.
        </p>
      </div>

      <BacktestForm onRun={run} busy={busy} submitLabel="Zoektocht starten" />

      {(error || status.state === 'error') && (
        <div className={styles.error}>{error || status.message}</div>
      )}

      {busy && (
        <div className={styles.progress}>
          <div className={styles.progressBar}>
            <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
          </div>
          <span className={styles.progressText}>{status.message}</span>
        </div>
      )}

      {status.state === 'done' && best && call && (
        <div className={styles.summary}>
          <div className={`${styles.verdict} ${call.tone}`}>
            <strong>{call.text}</strong>
            <span>
              Training {signed(best.trainResult.totalReturnPct, (v) => pct(v, 1))} ·{' '}
              {best.trainResult.trades} trades — Test{' '}
              {signed(best.testResult.totalReturnPct, (v) => pct(v, 1))} · {best.testResult.trades}{' '}
              trades
            </span>
          </div>

          <div className={styles.paramGrid}>
            {Object.entries(best.params).map(([key, value]) => (
              <div key={key} className={styles.exitCell}>
                <span className={styles.exitName}>{PARAM_LABELS[key] || key}</span>
                <span className={styles.exitCount}>{formatParam(key, value)}</span>
              </div>
            ))}
          </div>

          <div className={styles.applyRow}>
            <button type="button" className={styles.runBtn} onClick={apply} disabled={applied || applying || busy}>
              {applying ? 'Toepassen…' : applied ? 'Toegepast op de engine' : 'Pas beste instellingen toe'}
            </button>
            {best.testResult.expectancyR <= 0 && (
              <span className={styles.warnText}>
                Let op: deze instellingen waren ook out-of-sample niet winstgevend.
              </span>
            )}
          </div>

          <div className={styles.tradesBox}>
            <h3>Top {status.trials.length} combinaties</h3>
            <div className={styles.tradeScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Hefboom</th>
                    <th>Conviction</th>
                    <th>Stop</th>
                    <th>Target</th>
                    <th>Hoger TF</th>
                    <th className={styles.num}>Train R</th>
                    <th className={styles.num}>Test R</th>
                    <th className={styles.num}>Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {status.trials.map((t, i) => (
                    <tr key={i}>
                      <td>{formatParam('maxLeverage', t.params.maxLeverage)}</td>
                      <td>{formatParam('minConfidence', t.params.minConfidence)}</td>
                      <td>{t.params.atrStopMultiple}× ATR</td>
                      <td>{t.params.firstTargetR}R</td>
                      <td className={styles.dim}>{t.params.requireHigherAlignment ? 'ja' : 'nee'}</td>
                      <td
                        className={`${styles.num} ${t.trainResult.expectancyR >= 0 ? styles.up : styles.down}`}
                      >
                        {t.trainResult.expectancyR.toFixed(2)}
                      </td>
                      <td
                        className={`${styles.num} ${t.testResult.expectancyR >= 0 ? styles.up : styles.down}`}
                      >
                        {t.testResult.expectancyR.toFixed(2)}
                      </td>
                      <td className={`${styles.num} ${styles.dim}`}>{t.testResult.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {status.state === 'idle' && !busy && (
        <p className={styles.empty}>
          Kies markten en een periode. Een zoektocht test 160 combinaties en duurt een paar minuten —
          langere periodes geven betrouwbaardere uitkomsten.
        </p>
      )}
    </div>
  );
}
