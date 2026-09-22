import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './backtest.module.css';
import { fetchBacktest, startBacktest } from './api.js';
import { BacktestForm } from './backtest-form.js';
import { BacktestSummary } from './backtest-summary.js';
import type { BacktestConfig, BacktestStatus } from './types.js';

/** How often progress is polled while a run is in flight. */
const POLL_MS = 1200;

/**
 * Backtest view — configure a historical window, replay the live strategy over
 * it, and read the result.
 *
 * The replay uses the same signal, sizing and exit code as the live engine, so
 * what this page reports is a statement about the real system.
 */
export function BacktestPage() {
  const [status, setStatus] = useState<BacktestStatus>({
    state: 'idle',
    message: '',
    progress: 0,
    result: null,
  });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const busy = status.state === 'loading' || status.state === 'running';

  const poll = useCallback(async () => {
    try {
      const next = await fetchBacktest();
      setStatus(next);
      if (next.state === 'loading' || next.state === 'running') {
        timer.current = setTimeout(() => void poll(), POLL_MS);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Pick up a run that was already going when the page mounted.
  useEffect(() => {
    void poll();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  const run = useCallback(
    async (config: Partial<BacktestConfig>) => {
      setError(null);
      try {
        setStatus(await startBacktest(config));
        timer.current = setTimeout(() => void poll(), POLL_MS);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [poll]
  );

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h2>Backtest</h2>
        <p>
          Draai de strategie over historische candles. Dezelfde signalen, sizing en exits als live —
          alleen dan op data van het verleden.
        </p>
      </div>

      <BacktestForm onRun={run} busy={busy} />

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

      {status.state === 'done' && status.result && <BacktestSummary result={status.result} />}

      {status.state === 'idle' && !busy && (
        <p className={styles.empty}>
          Kies markten en een periode om te beginnen. Een langere periode geeft een betrouwbaarder
          beeld, maar duurt langer om op te halen.
        </p>
      )}
    </div>
  );
}
