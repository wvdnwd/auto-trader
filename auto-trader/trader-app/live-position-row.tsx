import { useState } from 'react';
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
  /** Realign or reset Take Profit targets and Stop Loss. */
  onRealignTpSl?: (id: string, custom?: { stopLoss?: number; takeProfits?: Array<{ price: number; portion?: number }> }) => Promise<void> | void;
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
export function LivePositionRow({ position, plan, onClose, onReduce, onRealignTpSl, onOpenChart }: LivePositionRowProps) {
  const [showTpSlModal, setShowTpSlModal] = useState(false);
  const [realigning, setRealigning] = useState(false);
  const [customSl, setCustomSl] = useState<string>('');
  const [customTp1, setCustomTp1] = useState<string>('');
  const [customTp2, setCustomTp2] = useState<string>('');
  const [customTp3, setCustomTp3] = useState<string>('');
  const [realignSuccess, setRealignSuccess] = useState<string | null>(null);

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

      {(onClose || onOpenChart || (onRealignTpSl && plan)) && (
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
          {onRealignTpSl && plan && (
            <button
              type="button"
              className={`${styles.miniBtn} ${showTpSlModal ? styles.miniBtnActive : ''}`}
              onClick={() => {
                setCustomSl(String(plan.stopLoss));
                if (levels[0]) setCustomTp1(String(levels[0].price));
                if (levels[1]) setCustomTp2(String(levels[1].price));
                if (levels[2]) setCustomTp3(String(levels[2].price));
                setShowTpSlModal(!showTpSlModal);
                setRealignSuccess(null);
              }}
              title="Take Profit en Stop Loss herberekenen of handmatig aanpassen op de exchange"
              style={{ background: 'rgba(251, 191, 36, 0.12)', borderColor: '#fbbf24', color: '#fbbf24' }}
            >
              🎯 Reset TP/SL
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

      {showTpSlModal && onRealignTpSl && plan && (
        <div
          style={{
            marginTop: '0.6rem',
            padding: '0.75rem',
            background: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid rgba(251, 191, 36, 0.3)',
            borderRadius: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            fontSize: '0.8rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: '#fbbf24' }}>
              🎯 TP & SL Opnieuw Instellen op Exchange ({position.symbol} {position.side})
            </span>
            <button
              type="button"
              className={styles.miniBtn}
              onClick={() => setShowTpSlModal(false)}
              style={{ minHeight: '24px', padding: '0.1rem 0.4rem', fontSize: '0.7rem' }}
            >
              ✕
            </button>
          </div>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.75rem' }}>
            Laat de bot de optimale doelen automatisch herberekenen op basis van de huidige marktprijs en ATR, of pas ze hieronder handmatig aan.
            Orders worden direct op de exchange gesynchroniseerd.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.2rem' }}>
            <button
              type="button"
              className={styles.miniBtn}
              disabled={realigning}
              onClick={async () => {
                try {
                  setRealigning(true);
                  await onRealignTpSl(plan.id);
                  setRealignSuccess('✅ TP & SL succesvol automatisch herberekend en bijgewerkt op exchange!');
                  setTimeout(() => setShowTpSlModal(false), 2000);
                } catch (err) {
                  alert(`Fout bij herberekenen TP/SL: ${(err as Error).message}`);
                } finally {
                  setRealigning(false);
                }
              }}
              style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', fontWeight: 600 }}
            >
              {realigning ? 'Bezig met herberekenen…' : '⚡ Automatisch herberekenen (ATR/Markt)'}
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.3rem',
              paddingTop: '0.4rem',
              borderTop: '1px dashed rgba(255, 255, 255, 0.1)',
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#f87171', marginBottom: '0.15rem' }}>
                Stop Loss (SL)
              </label>
              <input
                type="number"
                step="any"
                value={customSl}
                onChange={(e) => setCustomSl(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  color: 'var(--text)',
                  padding: '0.25rem 0.4rem',
                  fontSize: '0.75rem',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#4ade80', marginBottom: '0.15rem' }}>
                Take Profit 1 (TP1)
              </label>
              <input
                type="number"
                step="any"
                value={customTp1}
                onChange={(e) => setCustomTp1(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  color: 'var(--text)',
                  padding: '0.25rem 0.4rem',
                  fontSize: '0.75rem',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#4ade80', marginBottom: '0.15rem' }}>
                Take Profit 2 (TP2)
              </label>
              <input
                type="number"
                step="any"
                value={customTp2}
                onChange={(e) => setCustomTp2(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  color: 'var(--text)',
                  padding: '0.25rem 0.4rem',
                  fontSize: '0.75rem',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#4ade80', marginBottom: '0.15rem' }}>
                Take Profit 3 (TP3)
              </label>
              <input
                type="number"
                step="any"
                value={customTp3}
                onChange={(e) => setCustomTp3(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  color: 'var(--text)',
                  padding: '0.25rem 0.4rem',
                  fontSize: '0.75rem',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.4rem', marginTop: '0.2rem' }}>
            <button
              type="button"
              className={styles.miniBtn}
              disabled={realigning}
              onClick={async () => {
                const sl = parseFloat(customSl);
                const tp1 = parseFloat(customTp1);
                const tp2 = parseFloat(customTp2);
                const tp3 = parseFloat(customTp3);
                if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(tp1) || tp1 <= 0) {
                  alert('Vul minimaal een geldige Stop Loss en TP1 prijs in.');
                  return;
                }
                const tps: Array<{ price: number; portion: number }> = [{ price: tp1, portion: 0.33 }];
                if (Number.isFinite(tp2) && tp2 > 0) tps.push({ price: tp2, portion: 0.33 });
                if (Number.isFinite(tp3) && tp3 > 0) tps.push({ price: tp3, portion: 0.34 });
                else tps[tps.length - 1].portion = 1 - (tps.length - 1) * 0.33;

                try {
                  setRealigning(true);
                  await onRealignTpSl(plan.id, { stopLoss: sl, takeProfits: tps });
                  setRealignSuccess('✅ Nieuwe TP & SL opgeslagen en gesynchroniseerd op exchange!');
                  setTimeout(() => setShowTpSlModal(false), 2000);
                } catch (err) {
                  alert(`Fout bij opslaan TP/SL: ${(err as Error).message}`);
                } finally {
                  setRealigning(false);
                }
              }}
              style={{ background: 'rgba(34, 197, 94, 0.2)', borderColor: '#22c55e', color: '#4ade80', fontWeight: 600 }}
            >
              {realigning ? 'Opslaan…' : '💾 Handmatige TP/SL Toepassen'}
            </button>
          </div>

          {realignSuccess && (
            <div style={{ color: '#4ade80', fontSize: '0.75rem', fontWeight: 600 }}>
              {realignSuccess}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
