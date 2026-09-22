import { useMemo, useState } from 'react';
import styles from './trader-app.module.css';
import { pct, signed, usd } from './format.js';
import { PositionRow } from './position-row.js';
import type { Position, Stats } from './types.js';

export type HistoryPanelProps = {
  /** All closed positions from the engine. */
  closed: Position[];
  /** Overall trade statistics. */
  stats: Stats;
  /** Opens the chart for a position's symbol. */
  onOpenChart?: (symbol: string) => void;
};

type FilterType = 'all' | 'wins' | 'losses';
type SortType = 'newest' | 'oldest' | 'pnlDesc' | 'pnlAsc';

/**
 * Dedicated trade history dashboard tab — performance KPIs, filterable trade log,
 * and post-mortem breakdown of all closed positions.
 */
export function HistoryPanel({ closed, stats, onOpenChart }: HistoryPanelProps) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortType>('newest');

  // Compute total realized PnL from closed positions
  const totalRealizedPnl = useMemo(() => {
    return closed.reduce((sum, p) => sum + (p.realisedPnl || 0), 0);
  }, [closed]);

  const wins = useMemo(() => closed.filter((p) => (p.realisedPnl || 0) > 0), [closed]);
  const losses = useMemo(() => closed.filter((p) => (p.realisedPnl || 0) < 0), [closed]);

  const displayedPositions = useMemo(() => {
    let list = [...closed];

    // Filter by win/loss
    if (filter === 'wins') {
      list = list.filter((p) => (p.realisedPnl || 0) > 0);
    } else if (filter === 'losses') {
      list = list.filter((p) => (p.realisedPnl || 0) < 0);
    }

    // Filter by search query
    if (query.trim()) {
      const q = query.trim().toUpperCase();
      list = list.filter((p) => p.symbol.toUpperCase().includes(q));
    }

    // Sort
    list.sort((a, b) => {
      if (sort === 'newest') return (b.closedAt || b.openedAt || 0) - (a.closedAt || a.openedAt || 0);
      if (sort === 'oldest') return (a.closedAt || a.openedAt || 0) - (b.closedAt || b.openedAt || 0);
      if (sort === 'pnlDesc') return (b.realisedPnl || 0) - (a.realisedPnl || 0);
      if (sort === 'pnlAsc') return (a.realisedPnl || 0) - (b.realisedPnl || 0);
      return 0;
    });

    return list;
  }, [closed, filter, query, sort]);

  return (
    <div className={styles.historyPanelWrap}>
      {/* KPI Performance Summary */}
      <div className={styles.historyStatsGrid}>
        <div className={styles.historyStatCard}>
          <span className={styles.historyStatLabel}>Gesloten Trades</span>
          <span className={styles.historyStatVal}>{closed.length}</span>
          <span className={styles.cardSub}>
            {wins.length} winst · {losses.length} verlies
          </span>
        </div>

        <div className={styles.historyStatCard}>
          <span className={styles.historyStatLabel}>Winrate</span>
          <span className={styles.historyStatVal}>{closed.length ? pct(stats.winRate, 0) : '—'}</span>
          <span className={styles.cardSub}>
            {stats.wins} winst van {stats.trades} trades
          </span>
        </div>

        <div className={styles.historyStatCard}>
          <span className={styles.historyStatLabel}>Totale PnL</span>
          <span className={`${styles.historyStatVal} ${totalRealizedPnl >= 0 ? styles.up : styles.down}`}>
            {signed(totalRealizedPnl, (v) => usd(v))}
          </span>
          <span className={styles.cardSub}>Gerealiseerd netto resultaat</span>
        </div>

        <div className={styles.historyStatCard}>
          <span className={styles.historyStatLabel}>Profit Factor</span>
          <span className={styles.historyStatVal}>
            {closed.length ? (Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞') : '—'}
          </span>
          <span className={styles.cardSub}>
            Gem. winst {usd(stats.avgWin, 0)} · gem. verlies {usd(stats.avgLoss, 0)}
          </span>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className={styles.historyFilterBar}>
        <div className={styles.historyFilterGroup}>
          <button
            type="button"
            className={`${styles.historyFilterBtn} ${filter === 'all' ? styles.historyFilterBtnActive : ''}`}
            onClick={() => setFilter('all')}
          >
            Alle ({closed.length})
          </button>
          <button
            type="button"
            className={`${styles.historyFilterBtn} ${filter === 'wins' ? styles.historyFilterBtnActive : ''}`}
            onClick={() => setFilter('wins')}
          >
            🟢 Winst ({wins.length})
          </button>
          <button
            type="button"
            className={`${styles.historyFilterBtn} ${filter === 'losses' ? styles.historyFilterBtnActive : ''}`}
            onClick={() => setFilter('losses')}
          >
            🔴 Verlies ({losses.length})
          </button>
        </div>

        <div className={styles.historyFilterGroup}>
          <input
            type="text"
            className={styles.historySearchInput}
            placeholder="Zoek op symbool (bijv. BTC)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className={styles.historySearchInput}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortType)}
          >
            <option value="newest">Nieuwste eerst</option>
            <option value="oldest">Oudste eerst</option>
            <option value="pnlDesc">Hoogste winst</option>
            <option value="pnlAsc">Grootste verlies</option>
          </select>
        </div>
      </div>

      {/* Trades List */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2>📜 Gesloten Posities Logboek</h2>
          <span className={styles.count}>{displayedPositions.length} van {closed.length}</span>
        </div>
        <div className={styles.panelBody}>
          {displayedPositions.length > 0 ? (
            <div className={styles.rows}>
              {displayedPositions.map((p) => (
                <PositionRow key={p.id} position={p} onOpenChart={onOpenChart} />
              ))}
            </div>
          ) : (
            <p className={styles.empty}>
              {closed.length === 0
                ? 'Er zijn nog geen gesloten trades. Zodra een open positie TP of SL bereikt, verschijnt hij hier in het logboek.'
                : 'Geen trades gevonden die aan de zoek- of filtercriteria voldoen.'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
