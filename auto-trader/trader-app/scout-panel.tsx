import styles from './trader-app.module.css';
import { approveScoutCandidate, dismissScoutCandidate } from './api.js';
import { duration, pct, since, time } from './format.js';
import type { ScoutStatus } from './types.js';

export type ScoutPanelProps = {
  /** State of the background job that widens the trading universe over time. */
  scout: ScoutStatus;
  /** Called after a candidate is approved or dismissed, to refresh the snapshot. */
  onDecision?: () => void;
};

/**
 * Shows the background market scout: candidates awaiting manual approval,
 * which extra markets it has admitted into the live universe, when it last
 * ran, and the outcome of its recent tests.
 */
export function ScoutPanel({ scout, onDecision }: ScoutPanelProps) {
  const decide = (action: (symbol: string) => Promise<unknown>, symbol: string) => {
    void action(symbol).then(() => onDecision?.());
  };

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>Marktscan</h2>
        <span className={styles.count}>{scout.universeExtras.length} toegevoegd</span>
      </div>
      <div className={styles.panelBody}>
        <p className={styles.cardSub} style={{ marginBottom: '0.75rem' }}>
          {scout.running
            ? 'Bezig met het testen van nieuwe markten…'
            : scout.lastRunAt
              ? `Laatste scan ${since(scout.lastRunAt)} geleden`
              : 'Nog geen scan uitgevoerd'}
          {scout.nextRunAt && !scout.running ? ` · volgende over ${duration(Date.now(), scout.nextRunAt)}` : ''}
        </p>

        {scout.pending.length > 0 && (
          <div className={styles.rows} style={{ marginBottom: '0.9rem' }}>
            {scout.pending.map((r) => (
              <div key={`pending-${r.symbol}`} className={`${styles.signal} ${styles.pendingCard}`}>
                <div className={styles.rowTop}>
                  <div className={styles.symbolWrap}>
                    <span className={styles.symbol}>{r.symbol.replace('_', '/')}</span>
                    <span className={`${styles.tag} ${styles.amber}`}>wacht op goedkeuring</span>
                  </div>
                  <span className={styles.logTime}>{time(r.testedAt)}</span>
                </div>
                <div className={styles.meta}>
                  <span>
                    PF<b>{Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '—'}</b>
                  </span>
                  <span>
                    Verwachting<b>{r.expectancyR.toFixed(3)}R</b>
                  </span>
                  <span>
                    Trades<b>{r.trades}</b>
                  </span>
                  <span>
                    Max DD<b>{pct(r.maxDrawdownPct, 1)}</b>
                  </span>
                </div>
                <p className={styles.cardSub}>{r.reason}</p>
                <div className={styles.scoutActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => decide(approveScoutCandidate, r.symbol)}
                  >
                    Keur goed — voeg toe aan universum
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => decide(dismissScoutCandidate, r.symbol)}
                  >
                    Wijs af
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {scout.universeExtras.length > 0 && (
          <div className={styles.meta} style={{ marginBottom: '0.75rem' }}>
            {scout.universeExtras.map((s) => (
              <span key={s} className={`${styles.tag} ${styles.safe}`}>
                {s.replace('_', '/')}
              </span>
            ))}
          </div>
        )}

        {scout.recent.length ? (
          <div className={styles.rows}>
            {scout.recent.map((r) => (
              <div key={`${r.symbol}-${r.testedAt}`} className={styles.signal}>
                <div className={styles.rowTop}>
                  <div className={styles.symbolWrap}>
                    <span className={styles.symbol}>{r.symbol.replace('_', '/')}</span>
                    <span className={`${styles.tag} ${r.passed ? styles.safe : styles.neutral}`}>
                      {r.passed ? 'geslaagd' : 'afgewezen'}
                    </span>
                  </div>
                  <span className={styles.logTime}>{time(r.testedAt)}</span>
                </div>
                <div className={styles.meta}>
                  <span>
                    PF<b>{Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '—'}</b>
                  </span>
                  <span>
                    Verwachting<b>{r.expectancyR.toFixed(3)}R</b>
                  </span>
                  <span>
                    Trades<b>{r.trades}</b>
                  </span>
                  <span>
                    Max DD<b>{pct(r.maxDrawdownPct, 1)}</b>
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>
            Elke 2 dagen worden 3 nieuwe markten getest op de laatste 6 maanden historie - alleen
            markten die de bestaande kwaliteitslat halen worden toegevoegd aan het live universum.
          </p>
        )}
      </div>
    </section>
  );
}
