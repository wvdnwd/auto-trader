import styles from './trader-app.module.css';
import { coinInfo, splitSymbol } from './coin-info.js';
import { dateTime, price as fmtPrice, pct, qty, signed, since, usd } from './format.js';
import type { LiveExchangePosition, Position } from './types.js';

export type LivePositionRowProps = {
  /** The position as reported directly by MEXC or Hyperliquid. */
  position: LiveExchangePosition;
  /** The matching strategy plan with SL, TP targets, and sizing. */
  plan?: Position;
  /** Called when the user force-closes an open position. */
  onClose?: (id: string) => void;
  /** Called when the user partially closes an open position (e.g. 50%). */
  onReduce?: (id: string, fraction?: number) => void;
  /** Opens the candlestick chart for this position's symbol, with entry/stop/target overlays. */
  onOpenChart?: (symbol: string) => void;
};

/**
 * An open position on MEXC/Hyperliquid with full visibility into the strategy's planned
 * Take-Profit targets (with expected dollar profit per rung) and Stop-Loss point
 * (with maximum risk in dollars), as well as liquidation distance and live PnL.
 *
 * @param props position data and actions.
 * @returns the rendered row.
 */
export function LivePositionRow({ position, plan, onClose, onReduce, onOpenChart }: LivePositionRowProps) {
  const coin = splitSymbol(position.symbol).base;
  const info = coinInfo(position.symbol);
  const dir = position.side === 'LONG' ? 1 : -1;

  // Margin collateral committed to this position
  const margin =
    plan?.margin ??
    (position.entryPrice > 0 && position.vol > 0
      ? (position.entryPrice * position.vol) / Math.max(1, position.leverage)
      : 0);

  // Return on equity (unrealised)
  const pnlPct = margin > 0 ? position.unrealisedPnl / margin : 0;

  // Liquidation distance as a percentage of the mark price
  const liqDistancePct =
    position.markPrice > 0
      ? Math.abs(position.markPrice - position.liquidationPrice) / position.markPrice
      : 0;

  // Stop-Loss price & maximum risk calculation
  const slPrice = plan?.stopLoss;
  const slDistance = slPrice !== undefined ? Math.abs(position.entryPrice - slPrice) : 0;
  const slRiskAmount = -slDistance * position.vol;
  const distToStopPct =
    position.markPrice > 0 && slPrice !== undefined && slPrice > 0
      ? Math.abs(position.markPrice - slPrice) / position.markPrice
      : 0;

  // Staged Take-Profit rungs
  const levels = plan?.takeProfits || [];
  const filledCount = levels.filter((t) => t.hit).length;
  const totalProjectedProfit = levels.reduce(
    (acc, lvl) => acc + dir * (lvl.price - position.entryPrice) * (position.vol * lvl.portion),
    0
  );
  const rrRatio =
    slRiskAmount !== 0 && totalProjectedProfit > 0
      ? (totalProjectedProfit / Math.abs(slRiskAmount)).toFixed(1)
      : '—';

  // Range bar boundaries
  const allPrices = [
    position.entryPrice,
    position.markPrice,
    ...(slPrice !== undefined ? [slPrice] : []),
    ...levels.map((l) => l.price),
  ];
  const low = Math.min(...allPrices);
  const high = Math.max(...allPrices);
  const span = high - low;
  const markerPos = span > 0 ? ((position.markPrice - low) / span) * 100 : 50;
  const entryPos = span > 0 ? ((position.entryPrice - low) / span) * 100 : 50;
  const stopPos = span > 0 && slPrice !== undefined ? ((slPrice - low) / span) * 100 : 50;

  const openTime = position.openedAt || plan?.openedAt;

  return (
    <div className={styles.row}>
      <div className={styles.rowTop}>
        <div className={styles.symbolWrap}>
          <span className={styles.coinBadge} style={{ background: info.color }}>
            {coin.slice(0, 1)}
          </span>
          <span className={styles.symbolText}>
            <span className={styles.symbol}>{position.symbol.replace('_', '/')}</span>
            <span className={styles.coinName}>{info.name}</span>
          </span>
          <span className={`${styles.tag} ${position.side === 'LONG' ? styles.long : styles.short}`}>
            {position.side}
          </span>
          <span className={`${styles.tag} ${styles.lev}`}>{position.leverage}x</span>
          <span className={`${styles.tag} ${styles.short}`} title="Rechtstreeks van MEXC opgehaald">
            🔴 MEXC
          </span>
          {plan?.trailingArmed && <span className={`${styles.tag} ${styles.neutral}`}>TRAIL</span>}
          {plan?.breakEven && !plan?.trailingArmed && (
            <span className={`${styles.tag} ${styles.safe}`}>BREAK-EVEN</span>
          )}
          {filledCount > 0 && (
            <span className={`${styles.tag} ${styles.safe}`}>
              TP {filledCount}/{levels.length}
            </span>
          )}
        </div>
        <div className={styles.topRight}>
          {openTime ? (
            <span className={styles.timestamp}>🕒 {dateTime(openTime)}</span>
          ) : null}
          <div className={`${styles.pnl} ${position.unrealisedPnl >= 0 ? styles.up : styles.down}`}>
            {signed(position.unrealisedPnl, (v) => usd(v))}{' '}
            <span style={{ opacity: 0.7 }}>({signed(pnlPct, (v) => pct(v, 1))})</span>
          </div>
        </div>
      </div>

      <div className={styles.meta}>
        <span>
          Entry<b>{fmtPrice(position.entryPrice)}</b>
        </span>
        <span>
          Mark<b>{fmtPrice(position.markPrice)}</b>
        </span>
        <span>
          Grootte<b>{qty(position.vol)} {coin}</b>
        </span>
        <span>
          Inzet (Marge)<b>{usd(margin)}</b>
        </span>
        {openTime ? (
          <span>
            Geopend<b>{dateTime(openTime)}</b>
          </span>
        ) : null}
        {openTime ? (
          <span>
            Looptijd<b>{since(openTime)}</b>
          </span>
        ) : null}
      </div>

      <div className={styles.meta}>
        {slPrice !== undefined ? (
          <span>
            Stop-loss (SL)
            <b className={styles.down}>
              {fmtPrice(slPrice)}{' '}
              <span style={{ fontSize: '0.85em', fontWeight: 600 }}>
                (-{usd(Math.abs(slRiskAmount))})
              </span>
            </b>
          </span>
        ) : (
          <span>
            Stop-loss<b>—</b>
          </span>
        )}
        {slPrice !== undefined ? (
          <span>
            Afstand tot SL
            <b className={distToStopPct < 0.03 ? styles.down : undefined}>
              {pct(distToStopPct, 1)}
            </b>
          </span>
        ) : null}
        <span>
          Liquidatie
          <b className={liqDistancePct < 0.1 ? styles.down : undefined}>
            {fmtPrice(position.liquidationPrice)}
          </b>
        </span>
        <span>
          Afstand tot liquidatie
          <b className={liqDistancePct < 0.1 ? styles.down : undefined}>
            {pct(liqDistancePct, 1)}
          </b>
        </span>
      </div>

      {levels.length > 0 && (
        <>
          <div className={styles.bar}>
            {levels.map((level, i) => {
              const at = span > 0 ? ((level.price - low) / span) * 100 : 50;
              return (
                <div
                  key={level.rMultiple ?? i}
                  className={`${styles.tick} ${level.hit ? styles.tickHit : ''}`}
                  style={{ left: `${Math.max(0, Math.min(100, at))}%` }}
                  title={`TP${i + 1} · ${fmtPrice(level.price)}`}
                />
              );
            })}
            <div
              className={styles.entryMarker}
              style={{ left: `${Math.max(0, Math.min(100, entryPos))}%` }}
              title={`Instap · ${fmtPrice(position.entryPrice)}`}
            />
            {slPrice !== undefined && (
              <div
                className={styles.stopMarker}
                style={{ left: `${Math.max(0, Math.min(100, stopPos))}%` }}
                title={`Stop-loss · ${fmtPrice(slPrice)}`}
              />
            )}
            <div
              className={styles.marker}
              style={{ left: `${Math.max(0, Math.min(100, markerPos))}%` }}
              title={`Huidige markprijs · ${fmtPrice(position.markPrice)}`}
            />
          </div>
          <div className={styles.barLegend}>
            <span><i className={styles.swatchEntry} /> Instap</span>
            <span><i className={styles.swatchTp} /> Take-profit</span>
            <span><i className={styles.swatchStop} /> Stop-loss</span>
            <span><i className={styles.swatchMark} /> Huidige prijs</span>
          </div>

          <div className={styles.tpTable}>
            <div className={`${styles.tpRow} ${styles.tpHead}`}>
              <span>Take-profit</span>
              <span className={styles.tpValue}>Munt / Deel</span>
              <span className={styles.tpValue}>Winst</span>
              <span className={styles.tpValue}>% Rendement</span>
            </div>
            {levels.map((level, i) => {
              const portionQty = position.vol * level.portion;
              const projected = dir * (level.price - position.entryPrice) * portionQty;
              const priceGainPct =
                position.entryPrice > 0
                  ? ((level.price - position.entryPrice) / position.entryPrice) * dir
                  : 0;
              const allocatedMargin = margin * level.portion;
              const amountPct =
                allocatedMargin > 0
                  ? projected / allocatedMargin
                  : priceGainPct * position.leverage;
              const movedStop = i === 0 && level.hit && plan?.breakEven;
              return (
                <div
                  key={level.rMultiple ?? i}
                  className={`${styles.tpRow} ${level.hit ? styles.tpRowHit : ''}`}
                >
                  <span className={styles.tpLabel}>
                    {level.hit ? '✓' : '○'} TP{i + 1}
                    <span className={styles.tpPrice}>
                      {fmtPrice(level.price)} ({signed(priceGainPct, (v) => pct(v, 1))})
                      {movedStop && <span className={styles.tpStopMoved}> · SL → break-even</span>}
                    </span>
                  </span>
                  <span className={styles.tpValue}>
                    {qty(portionQty)} {coin}
                    <span className={styles.tpPrice}>({Math.round(level.portion * 100)}%)</span>
                  </span>
                  <span className={`${styles.tpValue} ${styles.up}`}>
                    +{usd(projected)}
                  </span>
                  <span className={`${styles.tpValue} ${styles.up}`}>
                    +{pct(amountPct, 1)}
                  </span>
                </div>
              );
            })}
            <div className={styles.tpFoot}>
              <span className={styles.tpFootItem}>
                Winstpotentieel: <b className={styles.up}>+{usd(totalProjectedProfit)}</b>
              </span>
              {slPrice !== undefined && (
                <span className={styles.tpFootItem}>
                  Max. risico (SL): <b className={styles.down}>-{usd(Math.abs(slRiskAmount))}</b>
                </span>
              )}
              {rrRatio !== '—' && (
                <span className={styles.tpFootItem}>
                  R:R: <b>{rrRatio}:1</b>
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {plan?.reasons && plan.reasons.length > 0 && (
        <div className={styles.reasons}>
          {plan.reasons.slice(0, 4).map((r) => (
            <span key={r} className={styles.reason}>
              {r}
            </span>
          ))}
        </div>
      )}

      {(onClose || onOpenChart) && (
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
          {onReduce && plan && (
            <button
              type="button"
              className={styles.miniBtn}
              onClick={() => onReduce(plan.id, 0.5)}
              title="50% van deze live positie direct met winst verzilveren"
              style={{ background: 'rgba(56, 189, 248, 0.15)', borderColor: '#38bdf8', color: '#38bdf8' }}
            >
              ✂️ 50% Winst
            </button>
          )}
          {onClose && plan && (
            <button type="button" className={styles.miniBtn} onClick={() => onClose(plan.id)}>
              Sluit positie
            </button>
          )}
        </div>
      )}
    </div>
  );
}
