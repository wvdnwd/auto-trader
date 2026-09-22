import styles from './backtest.module.css';
import { EquityChart } from './equity-chart.js';
import { pct, shortDate, signed, usd } from './format.js';
import type { BacktestResult } from './types.js';

/** Props for {@link BacktestSummary}. */
export type BacktestSummaryProps = {
  /** The completed run to display. */
  result: BacktestResult;
};

/** Human-readable label per exit reason. */
const EXIT_LABELS: Record<string, string> = {
  TAKE_PROFIT: 'Target geraakt',
  STOP_LOSS: 'Stop loss',
  TRAILING_STOP: 'Trailing stop',
  BREAK_EVEN: 'Break-even stop',
  SIGNAL_FLIP: 'Signaal gedraaid',
  MAX_AGE: 'Te lang open',
  LIQUIDATED: 'Geliquideerd',
  MANUAL: 'Einde periode',
};

/**
 * Verdict on whether the strategy showed an edge over the tested window.
 *
 * Expectancy is the headline: it says what an average trade returned in units of
 * the risk taken, which is the only figure that survives a change in position size.
 *
 * A profitable total is not enough to call it an edge. If one month produced most
 * of the profit, the rest of the run was flat or negative and the result is a
 * story about that month, not about the strategy — so concentration downgrades
 * the verdict even when the headline looks good.
 */
function verdict(result: BacktestResult): { tone: string; text: string } {
  if (result.trades < 10) {
    return {
      tone: styles.neutral,
      text: `Slechts ${result.trades} trades — te weinig om een conclusie aan te verbinden. Draai een langere periode of meer markten.`,
    };
  }

  const concentrated = result.monthly.length >= 3 && result.bestMonthShare > 0.6;

  if (result.expectancyR > 0.15 && result.profitFactor > 1.3) {
    if (concentrated) {
      return {
        tone: styles.neutral,
        text: `Winstgevend, maar ${pct(result.bestMonthShare, 0)} van de winst komt uit één maand. Zonder die maand blijft er weinig over — behandel dit als één gelukkige periode, niet als bewezen edge.`,
      };
    }
    return {
      tone: styles.good,
      text: `Positieve edge: gemiddeld ${result.expectancyR.toFixed(2)}R per trade over ${result.trades} trades, met een profit factor van ${result.profitFactor.toFixed(2)} en winst in ${pct(result.positiveMonthRate, 0)} van de maanden.`,
    };
  }
  if (result.expectancyR > 0) {
    return {
      tone: styles.neutral,
      text: `Licht positief (${result.expectancyR.toFixed(2)}R per trade), maar te dun om op te vertrouwen — de uitkomst kan ruis zijn.`,
    };
  }
  return {
    tone: styles.bad,
    text: `Geen edge in deze periode: gemiddeld ${result.expectancyR.toFixed(2)}R per trade. Pas de instellingen aan voordat je live gaat.`,
  };
}

/** Month label in Dutch, e.g. `2025-03` -> `mrt 2025`. */
function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  const date = new Date(Date.UTC(Number(year), Number(m) - 1, 1));
  return date.toLocaleDateString('nl-NL', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Results of a completed backtest — headline metrics, equity curve, how the
 * trades ended, and the full trade log.
 */
export function BacktestSummary({ result }: BacktestSummaryProps) {
  const call = verdict(result);
  const pnl = result.finalEquity - result.startingBalance;
  const exits = Object.entries(result.exitBreakdown).sort((a, b) => b[1].count - a[1].count);

  return (
    <div className={styles.summary}>
      <div className={`${styles.verdict} ${call.tone}`}>
        <strong>{call.text}</strong>
        <span>
          {shortDate(result.startedAt)} — {shortDate(result.endedAt)} ·{' '}
          {result.config.symbols.length} markten · {result.config.interval} ·{' '}
          {result.bars.toLocaleString('nl-NL')} bars
        </span>
      </div>

      <div className={styles.metrics}>
        <Metric
          label="Rendement"
          value={signed(result.totalReturnPct, (v) => pct(v, 1))}
          sub={`${signed(pnl, (v) => usd(v, 0))} · ${signed(result.annualisedReturnPct, (v) => pct(v, 0))} per jaar`}
          tone={pnl >= 0 ? styles.up : styles.down}
        />
        <Metric
          label="Expectancy"
          value={`${result.expectancyR > 0 ? '+' : ''}${result.expectancyR.toFixed(2)}R`}
          sub="gemiddeld per trade"
          tone={result.expectancyR >= 0 ? styles.up : styles.down}
        />
        <Metric
          label="Max drawdown"
          value={pct(result.maxDrawdownPct, 1)}
          sub={`limiet ${pct(result.config.risk?.maxDrawdownPct ?? 0.25, 0)}`}
          tone={result.maxDrawdownPct > 0.2 ? styles.down : ''}
        />
        <Metric
          label="Win rate"
          value={pct(result.winRate, 0)}
          sub={`${result.wins}W / ${result.losses}L`}
        />
        <Metric
          label="Profit factor"
          value={Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : '∞'}
          sub={`gem. ${usd(result.avgWin, 0)} / ${usd(result.avgLoss, 0)}`}
        />
        <Metric
          label="Sharpe"
          value={result.sharpe.toFixed(2)}
          sub={`${result.trades} trades · gem. ${result.avgBarsHeld} bars`}
        />
      </div>

      <div className={styles.chartBox}>
        <div className={styles.chartHead}>
          <span>Equity</span>
          <span>
            {usd(result.startingBalance, 0)} → <b>{usd(result.finalEquity, 0)}</b>
          </span>
        </div>
        <EquityChart curve={result.equityCurve} startingBalance={result.startingBalance} />
      </div>

      {result.monthly.length > 1 && (
        <div className={styles.exits}>
          <h3>Resultaat per maand</h3>
          <p className={styles.monthsNote}>
            Winst in {result.monthly.filter((m) => m.pnl > 0).length} van de{' '}
            {result.monthly.length} maanden. De beste maand is goed voor{' '}
            {result.bestMonthShare > 0 ? pct(result.bestMonthShare, 0) : '—'} van de totale winst.
          </p>
          <div className={styles.monthBars}>
            {result.monthly.map((m) => {
              const peak = Math.max(...result.monthly.map((x) => Math.abs(x.pnl))) || 1;
              return (
                <div key={m.month} className={styles.monthBar} title={`${m.trades} trades`}>
                  <div className={styles.monthTrack}>
                    <span
                      className={m.pnl >= 0 ? styles.monthUp : styles.monthDown}
                      style={{ height: `${Math.max(2, (Math.abs(m.pnl) / peak) * 100)}%` }}
                    />
                  </div>
                  <span className={m.pnl >= 0 ? styles.up : styles.down}>
                    {signed(m.pnl, (v) => usd(v, 0))}
                  </span>
                  <span className={styles.monthName}>{monthLabel(m.month)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {result.bySymbol.length > 1 && (
        <div className={styles.exits}>
          <h3>Resultaat per markt</h3>
          <p className={styles.monthsNote}>
            {result.bySymbol.filter((s) => s.pnl > 0).length} van de {result.bySymbol.length}{' '}
            markten waren winstgevend. Markten die structureel verliezen horen niet in de
            selectie — ze betalen hun fees met de winst van de rest.
          </p>
          <div className={styles.exitGrid}>
            {result.bySymbol.map((s) => (
              <div key={s.symbol} className={styles.exitCell}>
                <span className={styles.exitName}>{s.symbol.replace('_USDT', '')}</span>
                <span className={s.pnl >= 0 ? styles.up : styles.down}>
                  {signed(s.pnl, (v) => usd(v, 0))}
                </span>
                <span className={styles.dim}>
                  {s.trades} trades · {s.expectancyR.toFixed(2)}R
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {exits.length > 0 && (
        <div className={styles.exits}>
          <h3>Hoe trades eindigden</h3>
          <div className={styles.exitGrid}>
            {exits.map(([reason, data]) => (
              <div key={reason} className={styles.exitCell}>
                <span className={styles.exitName}>{EXIT_LABELS[reason] || reason}</span>
                <span className={styles.exitCount}>{data.count}×</span>
                <span className={data.pnl >= 0 ? styles.up : styles.down}>
                  {signed(data.pnl, (v) => usd(v, 0))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.tradeLog.length > 0 && (
        <div className={styles.tradesBox}>
          <h3>Trades ({result.tradeLog.length})</h3>
          <div className={styles.tradeScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Markt</th>
                  <th>Richting</th>
                  <th>Datum</th>
                  <th className={styles.num}>Lev</th>
                  <th className={styles.num}>R</th>
                  <th className={styles.num}>P&amp;L</th>
                  <th>Exit</th>
                </tr>
              </thead>
              <tbody>
                {result.tradeLog.map((t, i) => (
                  <tr key={`${t.symbol}-${t.closedAt}-${i}`}>
                    <td>{t.symbol.replace('_USDT', '')}</td>
                    <td>
                      <span className={t.side === 'LONG' ? styles.long : styles.short}>{t.side}</span>
                    </td>
                    <td className={styles.dim}>{shortDate(t.openedAt)}</td>
                    <td className={styles.num}>{t.leverage.toFixed(0)}×</td>
                    <td className={`${styles.num} ${t.rMultiple >= 0 ? styles.up : styles.down}`}>
                      {t.rMultiple > 0 ? '+' : ''}
                      {t.rMultiple.toFixed(2)}
                    </td>
                    <td className={`${styles.num} ${t.pnl >= 0 ? styles.up : styles.down}`}>
                      {signed(t.pnl, (v) => usd(v, 0))}
                    </td>
                    <td className={styles.dim}>{EXIT_LABELS[t.exitReason] || t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = '',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
}) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={`${styles.metricValue} ${tone}`}>{value}</span>
      <span className={styles.metricSub}>{sub}</span>
    </div>
  );
}
