import { useState } from 'react';
import styles from './trader-app.module.css';
import { since } from './format.js';
import type { MarketIntelligence } from './types.js';

export type NewsPanelProps = {
  intelligence?: MarketIntelligence;
  onSelectCoin?: (symbol: string) => void;
};

export function NewsPanel({ intelligence, onSelectCoin }: NewsPanelProps) {
  const [filterCoin, setFilterCoin] = useState<string | null>(null);

  if (!intelligence) {
    return (
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2>📰 Markt & Macro Nieuws</h2>
        </div>
        <div className={styles.panelBody}>
          <p className={styles.cardSub}>Marktinformatie wordt geladen…</p>
        </div>
      </section>
    );
  }

  const { fearAndGreed, macroShield, upcomingMacroEvents, breakingNews } = intelligence;

  // Filter news items if a coin filter is selected
  const filteredNews = filterCoin
    ? breakingNews.filter((n) => n.coins.includes(filterCoin))
    : breakingNews;

  // Fear & Greed color
  const fngScore = fearAndGreed?.score ?? 50;
  const fngColor =
    fngScore >= 75
      ? '#22c55e'
      : fngScore >= 55
        ? '#86efac'
        : fngScore >= 45
          ? '#eab308'
          : fngScore >= 25
            ? '#f97316'
            : '#ef4444';

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>📰 Markt & Macro Nieuws</h2>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          {macroShield.active ? (
            <span
              style={{
                background: 'rgba(239, 68, 68, 0.2)',
                border: '1px solid #ef4444',
                color: '#f87171',
                padding: '0.2rem 0.5rem',
                borderRadius: '6px',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              🛡️ Macro Shield Actief
            </span>
          ) : (
            <span
              style={{
                background: 'rgba(34, 197, 94, 0.15)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                color: '#4ade80',
                padding: '0.2rem 0.5rem',
                borderRadius: '6px',
                fontSize: '0.75rem',
              }}
            >
              🟢 Macro Rustig
            </span>
          )}
          <span className={styles.count}>{breakingNews.length} artikelen</span>
        </div>
      </div>

      <div className={styles.panelBody}>
        {/* Top Cards: Fear & Greed + Macro Shield Status */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
          {/* Fear & Greed Card */}
          <div
            style={{
              padding: '0.75rem 1rem',
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid var(--line)',
              borderRadius: '8px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 600 }}>
                FEAR & GREED INDEX
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
                {fearAndGreed?.updatedAt ? since(fearAndGreed.updatedAt) + ' geleden' : 'vandaag'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
              <span style={{ fontSize: '1.8rem', fontWeight: 800, color: fngColor, fontFamily: 'monospace' }}>
                {fngScore}
              </span>
              <span style={{ fontSize: '1rem', fontWeight: 600, color: fngColor }}>
                {fearAndGreed?.classification || 'Neutral'}
              </span>
            </div>
            {/* Visual meter bar */}
            <div
              style={{
                height: '6px',
                width: '100%',
                background: 'rgba(255,255,255,0.1)',
                borderRadius: '3px',
                marginTop: '0.5rem',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${fngScore}%`,
                  background: fngColor,
                  borderRadius: '3px',
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
            <p style={{ margin: '0.4rem 0 0 0', fontSize: '0.72rem', color: 'var(--muted)' }}>
              {fngScore >= 75
                ? '⚠️ Extreme Greed: Markten oververhit. Bot let extra op valse breakouts en eist strakkere confluences.'
                : fngScore <= 25
                  ? '🛡️ Extreme Fear: Short squeezes mogelijk. Bot filtert shorts in discount en zoekt oversold bounces.'
                  : 'Gezond marktsentiment. Normale MTF confluences en risk sizing van kracht.'}
            </p>
          </div>

          {/* Macro Shield & Economic Events Card */}
          <div
            style={{
              padding: '0.75rem 1rem',
              background: macroShield.active ? 'rgba(239, 68, 68, 0.08)' : 'rgba(15, 23, 42, 0.6)',
              border: macroShield.active ? '1px solid rgba(239, 68, 68, 0.4)' : '1px solid var(--line)',
              borderRadius: '8px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <span style={{ fontSize: '0.8rem', color: macroShield.active ? '#f87171' : 'var(--muted)', fontWeight: 600 }}>
                MACRO SHIELD (FOMC / CPI / RENTE)
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>ForexFactory Fed</span>
            </div>
            {macroShield.active ? (
              <div>
                <p style={{ margin: 0, fontSize: '0.85rem', color: '#f87171', fontWeight: 600 }}>
                  🛑 {macroShield.reason}
                </p>
              </div>
            ) : macroShield.nextEvent ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', padding: '0.1rem 0.35rem', borderRadius: '4px', fontWeight: 600 }}>
                    HIGH USD
                  </span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>
                    {macroShield.nextEvent.title}
                  </span>
                </div>
                <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: 'var(--muted)' }}>
                  Gepland over {Math.round(macroShield.nextEvent.timeUntilMinutes / 60)} uur ({macroShield.nextEvent.timeUntilMinutes} min).
                  Bot pauzeert automatisch 15 min voor publicatie.
                </p>
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted)' }}>
                Geen High-Impact USD data gepland in de komende 7 dagen.
              </p>
            )}

            {upcomingMacroEvents.length > 0 && (
              <div style={{ marginTop: '0.6rem', borderTop: '1px dashed rgba(255,255,255,0.1)', paddingTop: '0.4rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' }}>
                  Aankomende USD Events ({upcomingMacroEvents.length})
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.3rem' }}>
                  {upcomingMacroEvents.slice(0, 4).map((ev, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text)' }}>
                      <span>🔴 {ev.title}</span>
                      <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>
                        {ev.timeUntilMinutes > 60 ? `in ${Math.round(ev.timeUntilMinutes / 60)}u` : `in ${ev.timeUntilMinutes}m`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Filter bar for coins mentioned in news */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Filter op coin:</span>
          <button
            type="button"
            className={`${styles.miniBtn} ${!filterCoin ? styles.miniBtnActive : ''}`}
            onClick={() => setFilterCoin(null)}
            style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem' }}
          >
            Alle ({breakingNews.length})
          </button>
          {Array.from(new Set(breakingNews.flatMap((n) => n.coins))).map((coin) => (
            <button
              key={coin}
              type="button"
              className={`${styles.miniBtn} ${filterCoin === coin ? styles.miniBtnActive : ''}`}
              onClick={() => setFilterCoin(coin === filterCoin ? null : coin)}
              style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem' }}
            >
              {coin.replace('_USDT', '')}
            </button>
          ))}
        </div>

        {/* Breaking News Feed */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {filteredNews.length === 0 ? (
            <p className={styles.cardSub}>Geen nieuwsberichten gevonden voor deze selectie.</p>
          ) : (
            filteredNews.map((item) => {
              const isBull = item.sentiment === 'BULLISH';
              const isBear = item.sentiment === 'BEARISH';
              const badgeBg = isBull ? 'rgba(34, 197, 94, 0.15)' : isBear ? 'rgba(239, 68, 68, 0.15)' : 'rgba(148, 163, 184, 0.1)';
              const badgeColor = isBull ? '#4ade80' : isBear ? '#f87171' : 'var(--muted)';
              const badgeText = isBull ? '🟢 Bullish Katalysator' : isBear ? '🔴 Bearish Risico' : '⚪ Neutraal';

              return (
                <div
                  key={item.id}
                  style={{
                    padding: '0.6rem 0.8rem',
                    background: 'rgba(15, 23, 42, 0.4)',
                    border: '1px solid var(--line)',
                    borderRadius: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 600,
                          padding: '0.1rem 0.35rem',
                          borderRadius: '4px',
                          background: badgeBg,
                          color: badgeColor,
                        }}
                      >
                        {badgeText}
                      </span>
                      {item.coins.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => onSelectCoin?.(c)}
                          style={{
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            padding: '0.1rem 0.35rem',
                            borderRadius: '4px',
                            background: 'rgba(56, 189, 248, 0.15)',
                            color: '#38bdf8',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                          title={`Bekijk grafiek van ${c}`}
                        >
                          {c.replace('_USDT', '')}
                        </button>
                      ))}
                      <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
                        {item.source} · {since(item.publishedAt)} geleden
                      </span>
                    </div>
                  </div>

                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color: 'var(--text)',
                      textDecoration: 'none',
                      lineHeight: 1.35,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text)')}
                  >
                    {item.title} ↗
                  </a>

                  {item.summary && (
                    <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.3 }}>
                      {item.summary}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
