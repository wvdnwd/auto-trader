import { useState, useMemo } from 'react';
import styles from './trader-app.module.css';
import type { LearningState, Position } from './types.js';

export type AiLearningPanelProps = {
  learning?: LearningState;
  openPositions?: Position[];
};

export function AiLearningPanel({ learning, openPositions = [] }: AiLearningPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<'factors' | 'sessions' | 'dna' | 'cluster'>('factors');

  const factorList = useMemo(() => {
    const stats = learning?.factorStats || {};
    const defaultFactors = [
      'Volume Spurt (Coin in Play)',
      'Fibonacci Golden Zone',
      'Sniper Pullback',
      'RSI Divergentie',
      'Asian Session Sweep',
      '15m Ommekeer-bevestiging',
      'Smart Pyramiding (2e tranche)',
    ];

    const allKeys = Array.from(new Set([...defaultFactors, ...Object.keys(stats)]));
    return allKeys.map((name) => {
      const data = stats[name] || { wins: 0, losses: 0, netR: 0, winRate: 0, weightMultiplier: 1.0 };
      const total = data.wins + data.losses;
      const winRate = total > 0 ? (data.winRate !== undefined ? Math.round(data.winRate * 100) : Math.round((data.wins / total) * 100)) : null;
      const weight = data.weightMultiplier ?? 1.0;
      return { name, ...data, total, winRate, weight };
    });
  }, [learning?.factorStats]);

  const sessionList = useMemo(() => {
    const stats = learning?.sessionStats || {};
    const defaultSessions = ['ASIAN', 'LONDON', 'NEW_YORK', 'OVERLAP', 'OFF_HOURS'];
    return defaultSessions.map((key) => {
      const data = stats[key] || { session: key, wins: 0, losses: 0, netR: 0, winRate: 0, edgeMultiplier: 1.0 };
      const total = data.wins + data.losses;
      const winRate = total > 0 ? Math.round(data.winRate * 100) : null;
      return { key, ...data, total, winRate };
    });
  }, [learning?.sessionStats]);

  const dnaList = useMemo(() => {
    const dna = learning?.coinDNA || {};
    return Object.values(dna).sort((a, b) => b.totalTrades - a.totalTrades);
  }, [learning?.coinDNA]);

  const penaltiesList = useMemo(() => {
    const p = learning?.penalties || {};
    return Object.values(p).filter((item) => item.penalizedUntil && item.penalizedUntil > Date.now());
  }, [learning?.penalties]);

  const mfeMae = learning?.mfeMaeStats;
  const cluster = learning?.clusterStatus;

  const activeLongs = openPositions.filter((p) => p.side === 'LONG').length;
  const activeShorts = openPositions.filter((p) => p.side === 'SHORT').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '0.5rem' }}>
      {/* Top Banner */}
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, rgba(59, 130, 246, 0.1) 100%)',
          border: '1px solid rgba(16, 185, 129, 0.25)',
          borderRadius: '12px',
          padding: '1.25rem 1.5rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span>🧠</span>
            <span>AI Zelflerend Systeem & Multi-Factor Intelligentie</span>
          </h2>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--text-muted, #94a3b8)', fontSize: '0.85rem', maxWidth: '750px' }}>
            Het algoritme leert autonoom van elke gesloten trade. Technische factoren, marktsessies, individueel munt-DNA en haalbare MFE/MAE take-profit niveaus worden continu geoptimaliseerd.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span
            style={{
              padding: '0.35rem 0.75rem',
              borderRadius: '999px',
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              color: '#10b981',
              fontSize: '0.8rem',
              fontWeight: 600,
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            ● Actief Zelflerend
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1rem',
        }}
      >
        {/* KPI 1: MFE / MAE Optimal Targets */}
        <div
          style={{
            backgroundColor: 'var(--bg-card, #1e293b)',
            border: '1px solid var(--border, #334155)',
            borderRadius: '10px',
            padding: '1rem',
          }}
        >
          <div style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>
            🎯 MFE/MAE Dynamische Doelen
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 'bold', marginTop: '0.4rem', color: '#38bdf8' }}>
            TP1: +{mfeMae?.optimalTp1R ?? 1.5}R <span style={{ fontSize: '0.9rem', color: '#94a3b8' }}>| TP2: +{mfeMae?.optimalTp2R ?? 3.0}R</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.35rem' }}>
            Gem. Excursie: MFE <span style={{ color: '#10b981' }}>+{mfeMae?.avgMfeR ?? 0}R</span> · Drawdown <span style={{ color: '#ef4444' }}>{mfeMae?.avgMaeR ?? 0}R</span> ({mfeMae?.totalTracked ?? 0} trades)
          </div>
        </div>

        {/* KPI 2: Portfolio Cluster Dampener */}
        <div
          style={{
            backgroundColor: 'var(--bg-card, #1e293b)',
            border: '1px solid var(--border, #334155)',
            borderRadius: '10px',
            padding: '1rem',
          }}
        >
          <div style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>
            🛡️ Cluster & Correlatie Risico
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 'bold', marginTop: '0.4rem', color: '#a855f7' }}>
            {activeLongs} Longs · {activeShorts} Shorts
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.35rem' }}>
            Schaling: <span style={{ color: (cluster?.lastDampener ?? 1.0) < 1.0 ? '#fbbf24' : '#10b981', fontWeight: 600 }}>
              {Math.round((cluster?.lastDampener ?? 1.0) * 100)}% risico
            </span> {(cluster?.lastDampener ?? 1.0) < 1.0 ? '· (Basket-Dampener actief)' : '· (Geen cluster-risico)'}
          </div>
        </div>

        {/* KPI 3: Strafbankje Status */}
        <div
          style={{
            backgroundColor: 'var(--bg-card, #1e293b)',
            border: '1px solid var(--border, #334155)',
            borderRadius: '10px',
            padding: '1rem',
          }}
        >
          <div style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase' }}>
            🚫 Strafbankje Cooldowns
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 'bold', marginTop: '0.4rem', color: penaltiesList.length > 0 ? '#ef4444' : '#10b981' }}>
            {penaltiesList.length} Munten Actief
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.35rem' }}>
            {penaltiesList.length > 0 ? penaltiesList.map((p) => p.symbol).join(', ') : 'Geen munten gestraft (alles vrij)'}
          </div>
        </div>
      </div>

      {/* Sub-Navigation Buttons */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border, #334155)', paddingBottom: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setActiveSubTab('factors')}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.85rem',
            backgroundColor: activeSubTab === 'factors' ? '#3b82f6' : 'transparent',
            color: activeSubTab === 'factors' ? '#ffffff' : 'var(--text-muted, #94a3b8)',
          }}
        >
          📊 Factor-Weging ({factorList.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('sessions')}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.85rem',
            backgroundColor: activeSubTab === 'sessions' ? '#3b82f6' : 'transparent',
            color: activeSubTab === 'sessions' ? '#ffffff' : 'var(--text-muted, #94a3b8)',
          }}
        >
          🕒 Sessie-Matrix ({sessionList.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('dna')}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.85rem',
            backgroundColor: activeSubTab === 'dna' ? '#3b82f6' : 'transparent',
            color: activeSubTab === 'dna' ? '#ffffff' : 'var(--text-muted, #94a3b8)',
          }}
        >
          🧬 Coin DNA ({dnaList.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('cluster')}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.85rem',
            backgroundColor: activeSubTab === 'cluster' ? '#3b82f6' : 'transparent',
            color: activeSubTab === 'cluster' ? '#ffffff' : 'var(--text-muted, #94a3b8)',
          }}
        >
          🛡️ Cluster Beveiliging
        </button>
      </div>

      {/* SUBTAB 1: FACTOR WEIGHING */}
      {activeSubTab === 'factors' && (
        <div style={{ backgroundColor: 'var(--bg-card, #1e293b)', borderRadius: '10px', overflowX: 'auto', border: '1px solid var(--border, #334155)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border, #334155)', color: 'var(--text-muted, #94a3b8)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                <th style={{ padding: '0.75rem 1rem' }}>Confluence Factor</th>
                <th style={{ padding: '0.75rem 1rem' }}>Trades</th>
                <th style={{ padding: '0.75rem 1rem' }}>W / L</th>
                <th style={{ padding: '0.75rem 1rem' }}>Winrate</th>
                <th style={{ padding: '0.75rem 1rem' }}>Netto R</th>
                <th style={{ padding: '0.75rem 1rem' }}>Dynamische AI Weging</th>
              </tr>
            </thead>
            <tbody>
              {factorList.map((f) => {
                const isBoosted = f.weight > 1.05;
                const isPenalized = f.weight < 0.95;
                return (
                  <tr key={f.name} style={{ borderBottom: '1px solid var(--border, #334155)' }}>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>{f.name}</td>
                    <td style={{ padding: '0.75rem 1rem', color: '#94a3b8' }}>{f.total}</td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ color: '#10b981' }}>{f.wins}W</span> / <span style={{ color: '#ef4444' }}>{f.losses}L</span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                      {f.winRate !== null ? (
                        <span style={{ color: f.winRate >= 50 ? '#10b981' : '#ef4444' }}>{f.winRate}%</span>
                      ) : (
                        <span style={{ color: '#64748b' }}>N/A (wacht op trades)</span>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                      <span style={{ color: f.netR > 0 ? '#10b981' : f.netR < 0 ? '#ef4444' : '#94a3b8' }}>
                        {f.netR > 0 ? `+${f.netR}` : f.netR}R
                      </span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span
                        style={{
                          padding: '0.2rem 0.6rem',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          backgroundColor: isBoosted
                            ? 'rgba(16, 185, 129, 0.15)'
                            : isPenalized
                            ? 'rgba(239, 68, 68, 0.15)'
                            : 'rgba(148, 163, 184, 0.15)',
                          color: isBoosted ? '#10b981' : isPenalized ? '#ef4444' : '#94a3b8',
                          border: `1px solid ${isBoosted ? '#10b981' : isPenalized ? '#ef4444' : '#64748b'}`,
                        }}
                      >
                        {isBoosted ? `⚡ +${Math.round((f.weight - 1.0) * 100)}% Boost` : isPenalized ? `🚫 -${Math.round((1.0 - f.weight) * 100)}% Schaling` : '1.0x Neutraal'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* SUBTAB 2: SESSIONS */}
      {activeSubTab === 'sessions' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
          {sessionList.map((s) => {
            const isHighEdge = s.edgeMultiplier > 1.05;
            const isToxic = s.edgeMultiplier < 0.95;
            return (
              <div
                key={s.key}
                style={{
                  backgroundColor: 'var(--bg-card, #1e293b)',
                  border: `1px solid ${isHighEdge ? '#10b981' : isToxic ? '#ef4444' : 'var(--border, #334155)'}`,
                  borderRadius: '10px',
                  padding: '1.2rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '1rem', fontWeight: 'bold' }}>{s.key}</span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: 'bold',
                      padding: '0.15rem 0.5rem',
                      borderRadius: '4px',
                      backgroundColor: isHighEdge ? 'rgba(16,185,129,0.2)' : isToxic ? 'rgba(239,68,68,0.2)' : 'rgba(148,163,184,0.2)',
                      color: isHighEdge ? '#10b981' : isToxic ? '#ef4444' : '#94a3b8',
                    }}
                  >
                    {isHighEdge ? '⚡ Hoge Confluentie' : isToxic ? '🚫 Risico Dampener' : '⚖️ Neutraal'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.8rem', fontSize: '0.85rem' }}>
                  <div>
                    <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Winrate</div>
                    <div style={{ fontWeight: 'bold', color: (s.winRate ?? 0) >= 50 ? '#10b981' : '#ef4444' }}>
                      {s.winRate !== null ? `${s.winRate}%` : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>W / L</div>
                    <div style={{ fontWeight: 'bold' }}>{s.wins}W / {s.losses}L</div>
                  </div>
                  <div>
                    <div style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Netto R</div>
                    <div style={{ fontWeight: 'bold', color: s.netR > 0 ? '#10b981' : s.netR < 0 ? '#ef4444' : '#94a3b8' }}>
                      {s.netR > 0 ? `+${s.netR}` : s.netR}R
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* SUBTAB 3: COIN DNA */}
      {activeSubTab === 'dna' && (
        <div style={{ backgroundColor: 'var(--bg-card, #1e293b)', borderRadius: '10px', overflowX: 'auto', border: '1px solid var(--border, #334155)' }}>
          {dnaList.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>
              Nog geen munt-DNA opgebouwd. Zodra trades sluiten, berekent de bot per munt de optimale stop-loss en take-profit parameters.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border, #334155)', color: 'var(--text-muted, #94a3b8)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                  <th style={{ padding: '0.75rem 1rem' }}>Munt</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Klasse</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Trades</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Winrate</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Gem. MFE</th>
                  <th style={{ padding: '0.75rem 1rem' }}>Gem. MAE</th>
                  <th style={{ padding: '0.75rem 1rem' }}>SL Buffer</th>
                  <th style={{ padding: '0.75rem 1rem' }}>TP Schaling</th>
                </tr>
              </thead>
              <tbody>
                {dnaList.map((dna) => (
                  <tr key={dna.symbol} style={{ borderBottom: '1px solid var(--border, #334155)' }}>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 'bold' }}>{dna.symbol}</td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span
                        style={{
                          padding: '0.15rem 0.5rem',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          fontWeight: 'bold',
                          backgroundColor: dna.volatilityTier === 'MAJOR' ? 'rgba(56, 189, 248, 0.15)' : dna.volatilityTier === 'MEME' ? 'rgba(251, 191, 36, 0.15)' : 'rgba(168, 85, 247, 0.15)',
                          color: dna.volatilityTier === 'MAJOR' ? '#38bdf8' : dna.volatilityTier === 'MEME' ? '#fbbf24' : '#a855f7',
                        }}
                      >
                        {dna.volatilityTier}
                      </span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>{dna.totalTrades}</td>
                    <td style={{ padding: '0.75rem 1rem', color: dna.winRate >= 0.5 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                      {Math.round(dna.winRate * 100)}%
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: '#10b981' }}>+{dna.avgMfeR}R</td>
                    <td style={{ padding: '0.75rem 1rem', color: '#ef4444' }}>{dna.avgMaeR}R</td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>{dna.stopLossMultiplier}x</td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>{dna.takeProfitMultiplier}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* SUBTAB 4: CLUSTER SECURITY */}
      {activeSubTab === 'cluster' && (
        <div style={{ backgroundColor: 'var(--bg-card, #1e293b)', borderRadius: '10px', padding: '1.25rem', border: '1px solid var(--border, #334155)' }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>🛡️ Portfolio Cluster & Markt-Beta Beveiliging</h3>
          <p style={{ margin: '0 0 1rem', color: 'var(--text-muted, #94a3b8)', fontSize: '0.85rem' }}>
            In crypto bewegen altcoins vaak synchroon met Bitcoin. Wanneer meerdere posities in dezelfde richting openstaan (bijvoorbeeld 3 Longs tegelijk), verlaagt het algoritme automatisch de positiegrootte van latere entries om gezamenlijke liquidatie of multi-stop-outs te voorkomen.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.25)', padding: '1rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>0 Open Same-Side Posities</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#10b981', marginTop: '0.25rem' }}>100% Volledig Risico</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>Geen correlatie-overlap</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.25)', padding: '1rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>1 Open Same-Side Positie</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#38bdf8', marginTop: '0.25rem' }}>85% Schaling</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>Lichte voorzorgsdampener</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.25)', padding: '1rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>2 Open Same-Side Posities</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#fbbf24', marginTop: '0.25rem' }}>70% Schaling</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>Correlatie-bescherming actief</div>
            </div>
            <div style={{ backgroundColor: 'rgba(0,0,0,0.25)', padding: '1rem', borderRadius: '8px' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>3+ Open Same-Side Posities</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#ef4444', marginTop: '0.25rem' }}>55% Defensief</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>Maximale mand-bescherming</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
