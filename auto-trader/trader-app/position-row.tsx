import { useState } from 'react';
import styles from './trader-app.module.css';
import { coinInfo, splitSymbol } from './coin-info.js';
import { dateTime, duration, price as fmtPrice, pct, qty, signed, since, usd } from './format.js';
import type { Position } from './types.js';

export type PositionRowProps = {
  /** The position to render. */
  position: Position;
  /** Live mark price, used to compute unrealised pnl on open positions. */
  mark?: number;
  /** Called when the user force-closes an open position. */
  onClose?: (id: string) => void;
  /** Opens the candlestick chart for this position's symbol, with entry/stop/target overlays. */
  onOpenChart?: (symbol: string) => void;
};

/**
 * Correlation groups. Mirrors the backend grouping in `risk.ts` — kept as a
 * small local copy rather than a cross-component import because this is a
 * purely cosmetic badge, not a risk decision the UI makes.
 */
const GROUPS: Record<string, RegExp> = {
  majors: /^(BTC|ETH)_/,
  memes: /^(DOGE|SHIB|PEPE|WIF|BONK|FLOKI|TRUMP)_/,
  exchange: /^(BNB|OKB|CRO|FTT)_/,
};

/**
 * The correlation group a symbol belongs to, for display only.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 * @returns the group name, or `alts` when it matches no named cluster.
 */
function correlationGroup(symbol: string): string {
  for (const [name, pattern] of Object.entries(GROUPS)) {
    if (pattern.test(symbol)) return name;
  }
  return 'alts';
}

const GROUP_LABELS: Record<string, string> = {
  majors: 'Majors',
  memes: 'Memes',
  exchange: 'Exchange',
  alts: 'Alts',
};

/**
 * A single position row showing direction, leverage, sizing and live pnl.
 *
 * For open positions it renders a stop/entry/target bar with a marker at the
 * current price so the risk picture is readable at a glance.
 */
export function PositionRow({ position, mark, onClose, onOpenChart }: PositionRowProps) {
  const [showAnalysis, setShowAnalysis] = useState(false);
  const open = position.status === 'OPEN';
  const current = open ? mark ?? position.entry : position.exit ?? position.entry;
  const dir = position.side === 'LONG' ? 1 : -1;
  // Only the still-open portion moves with the market; profit already booked at a
  // take-profit level is added on top, never re-counted against the mark.
  const remaining = position.remainingQuantity ?? position.quantity;
  const booked = position.realisedPnl || 0;
  const live = Math.max(dir * (current - position.entry) * remaining, -position.margin);
  const pnl = open ? live + booked : position.pnl ?? 0;
  // Percentage is measured against the collateral originally committed.
  const baseMargin = position.quantity ? (position.margin * position.quantity) / (remaining || position.quantity) : position.margin;
  const pnlPct = baseMargin ? pnl / baseMargin : 0;
  const stale = open && mark === undefined;

  const low = Math.min(position.stopLoss, position.takeProfit);
  const high = Math.max(position.stopLoss, position.takeProfit);
  const span = high - low;
  const markerPos = span > 0 ? ((current - low) / span) * 100 : 50;
  const entryPos = span > 0 ? ((position.entry - low) / span) * 100 : 50;
  const stopPos = span > 0 ? ((position.stopLoss - low) / span) * 100 : 50;
  const levels = position.takeProfits || [];
  const filled = levels.filter((t) => t.hit).length;
  const group = correlationGroup(position.symbol);

  // R-multiple: current profit expressed as a multiple of the original risk
  // distance (entry to stop) — the same unit the take-profit table already
  // uses for its targets, so this reads consistently next to "1.5R" etc.
  const riskDistance = Math.abs(position.entry - position.stopLoss);
  const currentR = riskDistance > 0 ? (dir * (current - position.entry)) / riskDistance : 0;
  // How close price sits to the stop right now, 0 = at stop, 1 = at entry or beyond.
  const distToStopPct = riskDistance > 0 ? Math.max(0, Math.min(1, (dir * (current - position.stopLoss)) / riskDistance)) : 1;
  // How much of the original position is still running.
  const openPortion = position.quantity
    ? (position.remainingQuantity ?? position.quantity) / position.quantity
    : 1;

  return (
    <div className={styles.row}>
      <div className={styles.rowTop}>
        <div className={styles.symbolWrap}>
          <span className={styles.coinBadge} style={{ background: coinInfo(position.symbol).color }}>
            {splitSymbol(position.symbol).base.slice(0, 1)}
          </span>
          <span className={styles.symbolText}>
            <span className={styles.symbol}>{position.symbol.replace('_', '/')}</span>
            <span className={styles.coinName}>
              {coinInfo(position.symbol).name}
            </span>
          </span>
          <span className={`${styles.tag} ${position.side === 'LONG' ? styles.long : styles.short}`}>
            {position.side}
          </span>
          <span className={`${styles.tag} ${styles.lev}`}>{position.leverage}x</span>
          {position.live && (
            <span
              className={`${styles.tag} ${styles.short}`}
              title="Deze positie staat ook echt open op MEXC"
            >
              🔴 LIVE
            </span>
          )}
          {position.trailingArmed && <span className={`${styles.tag} ${styles.neutral}`}>TRAIL</span>}
          {open && position.breakEven && !position.trailingArmed && (
            <span className={`${styles.tag} ${styles.safe}`}>BREAK-EVEN</span>
          )}
          {open && filled > 0 && (
            <span className={`${styles.tag} ${styles.safe}`}>
              TP {filled}/{levels.length}
            </span>
          )}
          {stale && <span className={`${styles.tag} ${styles.neutral}`}>GEEN PRIJS</span>}
          {!open && position.exitReason && (
            <span className={`${styles.tag} ${styles.neutral}`}>{position.exitReason}</span>
          )}
          <span className={`${styles.tag} ${styles.neutral}`} title="Correlatiegroep — telt mee voor de max-per-groep limiet">
            {GROUP_LABELS[group]}
          </span>
        </div>
        <div className={styles.topRight}>
          {position.openedAt ? (
            <span className={styles.timestamp}>🕒 {dateTime(position.openedAt)}</span>
          ) : null}
          <div className={`${styles.pnl} ${pnl >= 0 ? styles.up : styles.down}`}>
            {signed(pnl, (v) => usd(v))} <span style={{ opacity: 0.7 }}>({signed(pnlPct, (v) => pct(v, 1))})</span>
          </div>
        </div>
      </div>

      <div className={styles.meta}>
        <span>
          Entry<b>{fmtPrice(position.entry)}</b>
        </span>
        <span>
          {open ? 'Mark' : 'Exit'}
          <b>{fmtPrice(current)}</b>
        </span>
        <span>
          Inzet<b>{usd(position.margin)}</b>
        </span>
        <span>
          Geopend<b>{dateTime(position.openedAt)}</b>
        </span>
        {!open && position.closedAt && (
          <span>
            Gesloten<b>{dateTime(position.closedAt)}</b>
          </span>
        )}
        <span>
          Looptijd<b>{open ? since(position.openedAt) : duration(position.openedAt, position.closedAt)}</b>
        </span>
      </div>

      {open && (
        <>
          <div className={styles.bar}>
            {levels.map((level, i) => {
              const at = span > 0 ? ((level.price - low) / span) * 100 : 50;
              return (
                <div
                  key={level.rMultiple}
                  className={`${styles.tick} ${level.hit ? styles.tickHit : ''}`}
                  style={{ left: `${Math.max(0, Math.min(100, at))}%` }}
                  title={`TP${i + 1} · ${level.rMultiple}R · ${Math.round(level.portion * 100)}% @ ${fmtPrice(level.price)}`}
                />
              );
            })}
            <div
              className={styles.entryMarker}
              style={{ left: `${Math.max(0, Math.min(100, entryPos))}%` }}
              title={`Instap · ${fmtPrice(position.entry)}`}
            />
            <div
              className={styles.stopMarker}
              style={{ left: `${Math.max(0, Math.min(100, stopPos))}%` }}
              title={`Stop-loss · ${fmtPrice(position.stopLoss)}`}
            />
            <div
              className={styles.marker}
              style={{ left: `${Math.max(0, Math.min(100, markerPos))}%` }}
              title={`Huidige prijs · ${fmtPrice(current)}`}
            />
          </div>
          <div className={styles.barLegend}>
            <span><i className={styles.swatchEntry} /> Instap</span>
            <span><i className={styles.swatchTp} /> Take-profit</span>
            <span><i className={styles.swatchStop} /> Stop-loss</span>
            <span><i className={styles.swatchMark} /> Huidige prijs</span>
          </div>

          {levels.length > 0 && (
            <div className={styles.tpTable}>
              <div className={`${styles.tpRow} ${styles.tpHead}`}>
                <span>Take-profit</span>
                <span className={styles.tpValue}>Munt</span>
                <span className={styles.tpValue}>Winst</span>
                <span className={styles.tpValue}>%</span>
              </div>
              {levels.map((level, i) => {
                const coin = position.symbol.split('_')[0];
                // Take-profit portions are fractions of the ORIGINAL quantity, not what
                // remains open — matches how the engine sizes each staged target.
                const portionQty = position.quantity * level.portion;
                const projected = dir * (level.price - position.entry) * portionQty;
                const amount = level.hit && level.realised !== undefined ? level.realised : projected;
                const allocatedMargin = position.margin * level.portion;
                const amountPct = allocatedMargin ? amount / allocatedMargin : 0;
                // The engine moves the stop to break-even once the first target fills —
                // surface that on the level that caused it, not as a generic separate note.
                const movedStop = i === 0 && level.hit && position.breakEven;
                return (
                  <div
                    key={level.rMultiple}
                    className={`${styles.tpRow} ${level.hit ? styles.tpRowHit : ''}`}
                  >
                    <span className={styles.tpLabel}>
                      {level.hit ? '✓' : '○'} TP{i + 1}
                      <span className={styles.tpPrice}>
                        {level.rMultiple}R · {fmtPrice(level.price)}
                        {movedStop && <span className={styles.tpStopMoved}> · SL → break-even</span>}
                      </span>
                    </span>
                    <span className={styles.tpValue}>
                      {qty(portionQty)} {coin}
                    </span>
                    <span className={styles.tpValue}>{signed(amount, (v) => usd(v))}</span>
                    <span className={styles.tpValue}>{signed(amountPct, (v) => pct(v, 1))}</span>
                  </div>
                );
              })}
              <div className={styles.tpFoot}>
                <span className={styles.tpFootItem}>
                  Winstpotentieel:{' '}
                  <b className={styles.up}>
                    +{usd(
                      levels.reduce(
                        (acc, l) =>
                          acc + dir * (l.price - position.entry) * (position.quantity * l.portion),
                        0
                      )
                    )}
                  </b>
                </span>
                <span className={styles.tpFootItem}>
                  Max. risico (SL):{' '}
                  <b className={styles.down}>
                    -{usd(Math.abs(position.entry - position.stopLoss) * remaining)}
                  </b>
                </span>
              </div>
            </div>
          )}

          <div className={styles.meta}>
            <span>
              Stop-loss (SL)
              <b className={styles.down}>
                {fmtPrice(position.stopLoss)}{' '}
                <span style={{ fontSize: '0.85em', fontWeight: 600 }}>
                  (-{usd(Math.abs(position.entry - position.stopLoss) * remaining)})
                </span>
              </b>
            </span>
            <span>
              Nog open<b>{pct(openPortion, 0)}</b>
            </span>
            <span>
              Geboekt<b>{usd(position.realisedPnl || 0)}</b>
            </span>
            <span>
              Conviction<b>{pct(position.confidence, 0)}</b>
            </span>
          </div>
          <div className={styles.meta}>
            <span>
              Huidige R<b className={currentR >= 0 ? styles.up : styles.down}>{signed(currentR, (v) => `${v.toFixed(2)}R`)}</b>
            </span>
            <span>
              Afstand tot stop<b>{pct(distToStopPct, 0)}</b>
            </span>
          </div>
        </>
      )}

      {position.reasons.length > 0 && (
        <div className={styles.reasons}>
          {position.reasons.slice(0, 4).map((r) => (
            <span key={r} className={styles.reason}>
              {r}
            </span>
          ))}
        </div>
      )}

      {open && (onClose || onOpenChart) && (
        <div className={styles.rowActions}>
          {onOpenChart && (
            <button
              type="button"
              className={styles.miniBtn}
              onClick={() => onOpenChart(position.symbol)}
            >
              Grafiek
            </button>
          )}
          {onClose && (
            <button type="button" className={styles.miniBtn} onClick={() => onClose(position.id)}>
              Sluit positie
            </button>
          )}
        </div>
      )}

      {!open && position.postMortem && (
        <div className={styles.postMortemWrap}>
          <button
            type="button"
            className={styles.postMortemToggle}
            onClick={() => setShowAnalysis(!showAnalysis)}
          >
            <span>🧠 {showAnalysis ? 'Analyse verbergen' : 'Post-Mortem analyse bekijken'}</span>
            <span
              className={`${styles.verdictBadge} ${
                position.postMortem.verdict === 'WIN'
                  ? styles.up
                  : position.postMortem.verdict === 'LOSS'
                  ? styles.down
                  : styles.neutral
              }`}
            >
              {position.postMortem.verdict === 'WIN'
                ? '🟢 WIN'
                : position.postMortem.verdict === 'LOSS'
                ? '🔴 VERLIES'
                : '⚪ BREAK-EVEN'}{' '}
              ({position.postMortem.rMultiple > 0 ? '+' : ''}
              {position.postMortem.rMultiple}R)
            </span>
          </button>
          {showAnalysis && (
            <div className={styles.postMortemBody}>
              <div className={styles.pmGrid}>
                {position.postMortem.whatWentWell && position.postMortem.whatWentWell.length > 0 && (
                  <div className={styles.pmSection}>
                    <span className={styles.pmSectionTitle}>✅ Wat ging goed:</span>
                    <ul className={styles.pmList}>
                      {position.postMortem.whatWentWell.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {position.postMortem.whatWentWrong && position.postMortem.whatWentWrong.length > 0 && (
                  <div className={styles.pmSection}>
                    <span className={styles.pmSectionTitle}>⚠️ Wat ging fout:</span>
                    <ul className={styles.pmList}>
                      {position.postMortem.whatWentWrong.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {position.postMortem.lesson && (
                <div className={styles.pmLesson}>
                  💡 <b>Lering voor het algoritme:</b> {position.postMortem.lesson}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
