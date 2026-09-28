import { useState, useMemo } from 'react';
import styles from './trader-app.module.css';
import { clearErrors } from './api.js';
import { dateTime, since } from './format.js';
import type { SystemError } from './types.js';

export type ErrorPanelProps = {
  errors?: SystemError[];
  totalCount?: number;
  onCleared?: () => void;
};

export function ErrorPanel({ errors = [], totalCount, onCleared }: ErrorPanelProps) {
  const [filterSource, setFilterSource] = useState<string>('ALL');
  const [filterLevel, setFilterLevel] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [expandedStackIds, setExpandedStackIds] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Sources present in the errors list
  const availableSources = useMemo(() => {
    const s = new Set<string>();
    for (const e of errors) {
      if (e.source) s.add(e.source.toUpperCase());
    }
    return Array.from(s).sort();
  }, [errors]);

  // Filtered error list
  const filteredErrors = useMemo(() => {
    return errors.filter((err) => {
      if (filterSource !== 'ALL' && err.source?.toUpperCase() !== filterSource) {
        return false;
      }
      if (filterLevel !== 'ALL' && err.level?.toUpperCase() !== filterLevel) {
        return false;
      }
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const msg = (err.message || '').toLowerCase();
        const src = (err.source || '').toLowerCase();
        const details = typeof err.details === 'object' ? JSON.stringify(err.details).toLowerCase() : String(err.details || '').toLowerCase();
        if (!msg.includes(term) && !src.includes(term) && !details.includes(term)) {
          return false;
        }
      }
      return true;
    });
  }, [errors, filterSource, filterLevel, searchTerm]);

  const toggleStack = (id: string) => {
    setExpandedStackIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopySingle = async (err: SystemError) => {
    const text = `[${new Date(err.at).toISOString()}] [${err.level.toUpperCase()}] [${err.source}] ${err.message}${
      err.details ? `\nDetails: ${JSON.stringify(err.details, null, 2)}` : ''
    }${err.stack ? `\nStack:\n${err.stack}` : ''}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(err.id);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleCopyAll = async () => {
    if (!filteredErrors.length) return;
    const text = filteredErrors
      .map(
        (err) =>
          `[${new Date(err.at).toISOString()}] [${err.level.toUpperCase()}] [${err.source}] ${err.message} (${err.occurrences || 1}x)${
            err.details ? `\nDetails: ${JSON.stringify(err.details, null, 2)}` : ''
          }${err.stack ? `\nStack:\n${err.stack}` : ''}`
      )
      .join('\n\n----------------------------------------\n\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback('ALL');
      setTimeout(() => setCopyFeedback(null), 2500);
    } catch {
      // ignore
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Weet je zeker dat je het hele foutenlogboek wilt wissen?')) return;
    setClearing(true);
    try {
      await clearErrors();
      setExpandedStackIds(new Set());
      onCleared?.();
    } catch (err) {
      alert(`Wissen mislukt: ${(err as Error).message}`);
    } finally {
      setClearing(false);
    }
  };

  const effectiveCount = totalCount !== undefined ? totalCount : errors.length;

  return (
    <section className={styles.panel} style={{ marginTop: '0.5rem' }}>
      <div className={styles.panelHead}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <h2>🚨 Systeem & Fouten Logboek</h2>
          <span
            style={{
              padding: '0.15rem 0.55rem',
              borderRadius: '999px',
              fontSize: '0.75rem',
              fontWeight: 'bold',
              backgroundColor: effectiveCount > 0 ? '#ef4444' : '#22c55e',
              color: '#ffffff',
            }}
          >
            {effectiveCount > 0 ? `${effectiveCount} melding${effectiveCount === 1 ? '' : 'en'}` : '0 fouten (stabiel)'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {errors.length > 0 && (
            <>
              <button
                type="button"
                className={styles.btn}
                onClick={handleCopyAll}
                title="Kopieer alle getoonde meldingen naar klembord"
              >
                {copyFeedback === 'ALL' ? '✅ Gekopieerd!' : '📋 Log Kopiëren'}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleClear}
                disabled={clearing}
                title="Wis alle opgeslagen foutmeldingen"
              >
                {clearing ? 'Wissen…' : '🗑️ Log Wissen'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className={styles.panelBody}>
        {/* Filters and search bar */}
        {errors.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.6rem',
              alignItems: 'center',
              marginBottom: '1rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            {/* Source filters */}
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: '#888', marginRight: '0.2rem' }}>Bron:</span>
              <button
                type="button"
                className={`${styles.btn} ${filterSource === 'ALL' ? styles.tabOn : ''}`}
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => setFilterSource('ALL')}
              >
                Alle ({errors.length})
              </button>
              {availableSources.map((src) => {
                const count = errors.filter((e) => e.source?.toUpperCase() === src).length;
                return (
                  <button
                    key={src}
                    type="button"
                    className={`${styles.btn} ${filterSource === src ? styles.tabOn : ''}`}
                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                    onClick={() => setFilterSource(src)}
                  >
                    {src} ({count})
                  </button>
                );
              })}
            </div>

            {/* Level filters */}
            <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: '0.4rem', marginRight: '0.2rem' }}>Niveau:</span>
              <button
                type="button"
                className={`${styles.btn} ${filterLevel === 'ALL' ? styles.tabOn : ''}`}
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => setFilterLevel('ALL')}
              >
                Alles
              </button>
              <button
                type="button"
                className={`${styles.btn} ${filterLevel === 'ERROR' ? styles.tabOn : ''}`}
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', color: '#f87171' }}
                onClick={() => setFilterLevel('ERROR')}
              >
                Errors
              </button>
              <button
                type="button"
                className={`${styles.btn} ${filterLevel === 'WARN' ? styles.tabOn : ''}`}
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', color: '#fbbf24' }}
                onClick={() => setFilterLevel('WARN')}
              >
                Waarschuwingen
              </button>
            </div>

            {/* Keyword search input */}
            <div style={{ flex: '1 1 180px', minWidth: '150px' }}>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="🔍 Filter op zoekterm..."
                style={{
                  width: '100%',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  color: '#fff',
                  padding: '0.25rem 0.6rem',
                  fontSize: '0.8rem',
                }}
              />
            </div>
          </div>
        )}

        {/* Empty state: No errors logged */}
        {errors.length === 0 ? (
          <div
            style={{
              padding: '2rem 1rem',
              textAlign: 'center',
              background: 'rgba(34, 197, 94, 0.05)',
              borderRadius: '8px',
              border: '1px solid rgba(34, 197, 94, 0.2)',
            }}
          >
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✨</div>
            <h3 style={{ margin: 0, color: '#4ade80', fontSize: '1rem', fontWeight: 600 }}>
              Geen fouten geregistreerd
            </h3>
            <p className={styles.cardSub} style={{ marginTop: '0.4rem', color: '#86efac' }}>
              Alle engines, order flows en Hyperliquid koppelingen draaien foutloos en stabiel.
            </p>
          </div>
        ) : filteredErrors.length === 0 ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: '#888' }}>
            Geen meldingen gevonden die voldoen aan het huidige filter.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {filteredErrors.map((err) => {
              const isExpanded = expandedStackIds.has(err.id);
              const isFatal = err.level === 'fatal';
              const isWarn = err.level === 'warn';
              const badgeBg = isFatal ? '#7f1d1d' : isWarn ? '#78350f' : '#881337';
              const badgeColor = isFatal ? '#fca5a5' : isWarn ? '#fde68a' : '#fecdd3';
              const borderColor = isFatal ? 'rgba(239, 68, 68, 0.3)' : isWarn ? 'rgba(245, 158, 11, 0.3)' : 'rgba(244, 63, 94, 0.25)';

              return (
                <div
                  key={err.id}
                  style={{
                    background: 'rgba(15, 23, 42, 0.6)',
                    border: `1px solid ${borderColor}`,
                    borderRadius: '8px',
                    padding: '0.75rem 0.9rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                  }}
                >
                  {/* Top metadata row */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '0.4rem',
                    }}
                  >
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      {/* Level tag */}
                      <span
                        style={{
                          backgroundColor: badgeBg,
                          color: badgeColor,
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          fontWeight: 'bold',
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {err.level}
                      </span>

                      {/* Source tag */}
                      <span
                        style={{
                          backgroundColor: 'rgba(59, 130, 246, 0.15)',
                          color: '#93c5fd',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          fontWeight: 600,
                        }}
                      >
                        {err.source}
                      </span>

                      {/* Occurrences count if > 1 */}
                      {err.occurrences && err.occurrences > 1 && (
                        <span
                          style={{
                            backgroundColor: 'rgba(245, 158, 11, 0.2)',
                            color: '#fcd34d',
                            padding: '0.15rem 0.45rem',
                            borderRadius: '4px',
                            fontSize: '0.7rem',
                            fontWeight: 'bold',
                          }}
                        >
                          🔁 {err.occurrences}x herhaald
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                        {dateTime(err.at)} ({since(err.at)} geleden)
                      </span>
                      <button
                        type="button"
                        className={styles.btn}
                        style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                        onClick={() => handleCopySingle(err)}
                        title="Kopieer deze foutmelding"
                      >
                        {copyFeedback === err.id ? '✅ Gekopieerd' : '📋'}
                      </button>
                    </div>
                  </div>

                  {/* Message body */}
                  <div
                    style={{
                      color: '#f1f5f9',
                      fontSize: '0.85rem',
                      fontFamily: 'monospace',
                      wordBreak: 'break-word',
                      lineHeight: '1.4',
                      padding: '0.2rem 0',
                    }}
                  >
                    {err.message}
                  </div>

                  {/* Contextual Details */}
                  {err.details && (
                    <div
                      style={{
                        background: 'rgba(0, 0, 0, 0.25)',
                        padding: '0.4rem 0.6rem',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        color: '#cbd5e1',
                        fontFamily: 'monospace',
                        wordBreak: 'break-all',
                      }}
                    >
                      <span style={{ color: '#94a3b8', fontWeight: 600 }}>Details: </span>
                      {typeof err.details === 'object' ? JSON.stringify(err.details) : String(err.details)}
                    </div>
                  )}

                  {/* Collapsible Stack Trace */}
                  {err.stack && (
                    <div style={{ marginTop: '0.2rem' }}>
                      <button
                        type="button"
                        onClick={() => toggleStack(err.id)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#60a5fa',
                          fontSize: '0.75rem',
                          cursor: 'pointer',
                          padding: '0.2rem 0',
                          textAlign: 'left',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                        }}
                      >
                        <span>{isExpanded ? '▼ Verberg stack trace' : '▶ Bekijk stack trace'}</span>
                      </button>

                      {isExpanded && (
                        <pre
                          style={{
                            marginTop: '0.4rem',
                            padding: '0.6rem 0.8rem',
                            background: '#090d16',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            borderRadius: '6px',
                            color: '#f87171',
                            fontSize: '0.7rem',
                            overflowX: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            fontFamily: 'Consolas, Monaco, monospace',
                            maxHeight: '260px',
                            overflowY: 'auto',
                          }}
                        >
                          {err.stack}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
