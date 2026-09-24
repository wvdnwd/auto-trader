import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './trader-app.module.css';
import {
  closeExchangePosition,
  closePosition,
  reducePosition,
  fetchChart,
  fetchSnapshot,
  placeTestOrder,
  resetAccount,
  runCycle,
  saveExchangeCredentials,
  setExchangeVenue,
  setApiToken,
  setEngineRunning,
  setLiveTrading,
  updateRisk,
} from './api.js';
import type { TestOrderResult } from './api.js';
import { ApiError } from './api.js';
import { BacktestPage } from './backtest-page.js';
import { HistoryPanel } from './history-panel.js';
import { useLanguage } from './i18n.js';
import { LivePositionRow } from './live-position-row.js';
import { OptimizePanel } from './optimize-panel.js';
import { WalkForwardPanel } from './walk-forward-panel.js';
import { pct, signed, time, usd } from './format.js';
import { PositionRow } from './position-row.js';
import { RiskPanel } from './risk-panel.js';
import { ScoutPanel } from './scout-panel.js';
import { BtcForecast } from './btc-forecast.js';
import { SignalChart } from './signal-chart.js';
import { SignalList } from './signal-list.js';
import type { ChartData, RiskConfig, Snapshot } from './types.js';

const POLL_MS = 6000;

type ChartErrorBoundaryProps = {
  fallback: (err: Error) => ReactNode;
  children: ReactNode;
};

type ChartErrorBoundaryState = {
  error: Error | null;
};

class ChartErrorBoundary extends Component<ChartErrorBoundaryProps, ChartErrorBoundaryState> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('SignalChart render error:', error);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

function playDoubleChime() {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.12, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.18);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(987.77, now + 0.12);
    gain2.gain.setValueAtTime(0.14, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.35);
  } catch {
    // Audio unavailable or blocked
  }
}

/**
 * The autonomous trading dashboard — account health, open positions, the live
 * scanner ranking, engine log and the risk controls, polled in real time.
 */
export function Dashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try {
      return localStorage.getItem('trader_sound_enabled') === 'true';
    } catch {
      return false;
    }
  });
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const prevSnapRef = useRef<Snapshot | null>(null);
  const [tab, setTab] = useState<'live' | 'history' | 'backtest' | 'walkforward' | 'optimize' | 'options'>('live');
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [venueTab, setVenueTab] = useState<'mexc' | 'hyperliquid'>('hyperliquid');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiSecretInput, setApiSecretInput] = useState('');
  const [walletAddressInput, setWalletAddressInput] = useState('');
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [isTestnetInput, setIsTestnetInput] = useState(false);
  const [showTestOrder, setShowTestOrder] = useState(false);
  const [testSymbol, setTestSymbol] = useState('BTC_USDT');
  const [testSide, setTestSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [testAmount, setTestAmount] = useState(1);
  const [testLeverage, setTestLeverage] = useState(5);
  const [testKeepOpen, setTestKeepOpen] = useState(false);
  const [testTpPct, setTestTpPct] = useState(3);
  const [testSlPct, setTestSlPct] = useState(2);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestOrderResult | null>(null);
  const [testedSymbol, setTestedSymbol] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [apiTokenInput, setApiTokenInput] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const mounted = useRef(true);
  const loadRequestId = useRef(0);
  const chartRequestId = useRef(0);
  const busyOperations = useRef(0);
  const linkCopiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { t, lang, setLang } = useLanguage();

  const beginBusy = () => {
    busyOperations.current++;
    setBusy(true);
  };

  const endBusy = () => {
    busyOperations.current = Math.max(0, busyOperations.current - 1);
    if (mounted.current) setBusy(busyOperations.current > 0);
  };

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    try {
      const next = await fetchSnapshot();
      if (!mounted.current || requestId !== loadRequestId.current) return;
      if (soundEnabledRef.current && prevSnapRef.current) {
        const prevOpenIds = new Set(prevSnapRef.current.open.map((p) => p.id));
        const newOpens = next.open.filter((p) => !prevOpenIds.has(p.id));
        const newClosedWithProfit = next.closed.slice(0, 3).some((c) => {
          const wasInPrev = prevSnapRef.current!.closed.some((pc) => pc.id === c.id);
          return !wasInPrev && (c.pnl || 0) > 0;
        });
        const hasHighConvictionSignal = (next.signals || []).some(
          (s) => s.confidence >= 0.88 && !(prevSnapRef.current!.signals || []).some((ps) => ps.symbol === s.symbol && ps.confidence >= 0.88)
        );
        if (newOpens.length > 0 || newClosedWithProfit || hasHighConvictionSignal) {
          playDoubleChime();
        }
      }
      prevSnapRef.current = next;
      setSnap(next);
      setError(null);
      setAuthRequired(false);
    } catch (err) {
      if (!mounted.current || requestId !== loadRequestId.current) return;
      setError((err as Error).message);
      setAuthRequired(err instanceof ApiError && err.status === 401);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (mounted.current) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      mounted.current = false;
      loadRequestId.current++;
      chartRequestId.current++;
      clearTimeout(timer);
      clearTimeout(linkCopiedTimer.current);
    };
  }, [load]);

  const loadChart = useCallback(async (symbol: string) => {
    const requestId = ++chartRequestId.current;
    setChart(null);
    setChartError(null);
    try {
      const data = await fetchChart(symbol);
      if (mounted.current && requestId === chartRequestId.current) setChart(data);
    } catch (err) {
      if (mounted.current && requestId === chartRequestId.current) setChartError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (chartSymbol) void loadChart(chartSymbol);
    else chartRequestId.current++;
    return () => {
      chartRequestId.current++;
    };
  }, [chartSymbol, loadChart]);

  const act = async (fn: () => Promise<unknown>) => {
    beginBusy();
    try {
      await fn();
      await load();
    } catch (err) {
      if (mounted.current) {
        setError((err as Error).message);
        setAuthRequired(err instanceof ApiError && err.status === 401);
      }
    } finally {
      endBusy();
    }
  };

  if (!snap) {
    return (
      <div className={styles.app}>
        <div className={styles.shell}>
          <p className={styles.empty}>{error ? t('connectFailed', { err: error }) : t('connecting')}</p>
          {authRequired && (
            <form
              className={styles.notice}
              onSubmit={(event) => {
                event.preventDefault();
                if (!apiTokenInput.trim()) return;
                if (!setApiToken(apiTokenInput)) {
                  setError('This browser tab cannot store the API token. Allow session storage and retry.');
                  return;
                }
                setApiTokenInput('');
                setAuthRequired(false);
                void load();
              }}
            >
              <label htmlFor="trader-api-token">{t('apiAuthRequired')}</label>
              <input
                id="trader-api-token"
                type="password"
                autoComplete="current-password"
                value={apiTokenInput}
                onChange={(event) => setApiTokenInput(event.target.value)}
              />
              <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!apiTokenInput.trim()}>
                {t('apiTokenSubmit')}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const { account, stats, risk } = snap;
  const totalPnl = account.equity - account.startingBalance;
  // Marks come from the engine so every open position has a live price, even
  // when its market is not in the current scanner ranking.
  const marks = snap.marks || {};
  // Once live trading is armed, the dashboard shows the real MEXC account
  // instead of the internal paper ledger — balances, pnl and open positions
  // all switch to what the exchange itself reports, so there is never a
  // question of which number is the real one.
  const isLive = snap.exchange.enabled;
  const liveAccount = snap.exchangeAccount;
  const liveAccountOk = isLive && liveAccount && !liveAccount.error;
  const openCount = isLive ? (liveAccountOk ? liveAccount.open.length : undefined) : snap.open.length;
  const maxOpen = risk.maxOpenPositions || 10;

  return (
    <div className={styles.app}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.logo}>🤖</div>
            <div className={styles.brandText}>
              <h1>{t('appTitle')}</h1>
              <p>
                {t('appTagline')} ·{' '}
                {snap.scannedAt ? t('lastScan', { time: time(snap.scannedAt) }) : t('notScannedYet')}
                {snap.running && snap.cadenceSec ? t('everySeconds', { s: snap.cadenceSec }) : ''}
              </p>
            </div>
          </div>
          <div className={styles.controls}>
            <span className={styles.langToggle}>
              <button
                type="button"
                className={`${styles.langBtn} ${lang === 'nl' ? styles.langOn : ''}`}
                onClick={() => setLang('nl')}
              >
                NL
              </button>
              <button
                type="button"
                className={`${styles.langBtn} ${lang === 'en' ? styles.langOn : ''}`}
                onClick={() => setLang('en')}
              >
                EN
              </button>
            </span>
            {snap.exchange.enabled && (
              <span
                style={{
                  fontSize: '0.78rem',
                  fontWeight: 800,
                  padding: '3px 8px',
                  borderRadius: '4px',
                  background: snap.exchange.venue === 'hyperliquid' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  color: snap.exchange.venue === 'hyperliquid' ? '#38bdf8' : '#ef4444',
                  border: `1px solid ${snap.exchange.venue === 'hyperliquid' ? '#38bdf8' : '#ef4444'}`,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}
                title={snap.exchange.venue === 'hyperliquid' ? 'Live gekoppeld met Hyperliquid DEX' : 'Live gekoppeld met MEXC Futures'}
              >
                🔴 {snap.exchange.venue?.toUpperCase() || 'MEXC'} LIVE
              </span>
            )}
            <span className={styles.status}>
              <span className={`${styles.dot} ${snap.running ? styles.dotLive : ''}`} />
              {snap.running ? (snap.watching ? t('statusLiveWatching') : t('statusLive')) : t('statusPaused')}
            </span>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                try {
                  localStorage.setItem('trader_sound_enabled', String(next));
                } catch {}
                if (next) playDoubleChime();
              }}
              title={soundEnabled ? 'Geluid uitschakelen' : 'Geluid inschakelen bij signalen en winst'}
              style={{
                background: soundEnabled ? 'rgba(16, 185, 129, 0.15)' : undefined,
                borderColor: soundEnabled ? '#10b981' : undefined,
                color: soundEnabled ? '#10b981' : undefined,
              }}
            >
              {soundEnabled ? '🔔 Geluid: Aan' : '🔕 Geluid: Uit'}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${snap.running ? '' : styles.btnPrimary}`}
              disabled={busy}
              onClick={() => act(() => setEngineRunning(!snap.running))}
            >
              {snap.running ? t('pause') : t('startEngine')}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${risk.pauseNewEntries ? styles.btnPrimary : ''}`}
              disabled={busy}
              onClick={() => act(() => updateRisk({ pauseNewEntries: !risk.pauseNewEntries }))}
              title={
                risk.pauseNewEntries
                  ? 'Hervat het openen van nieuwe trades'
                  : 'Pauzeer nieuwe trade entries (lopende posities blijven actief beheerd)'
              }
            >
              {risk.pauseNewEntries ? '▶️ Hervat entries' : '⏸️ Standby'}
            </button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => act(runCycle)}>
              {busy ? t('busy') : t('scanNow')}
            </button>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href).then(() => {
                  if (!mounted.current) return;
                  setLinkCopied(true);
                  clearTimeout(linkCopiedTimer.current);
                  linkCopiedTimer.current = setTimeout(() => {
                    if (mounted.current) setLinkCopied(false);
                  }, 2000);
                });
              }}
              title={t('shareBody')}
            >
              {linkCopied ? t('linkCopied') : `🔗 ${t('copyLink')}`}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={busy}
              onClick={() => {
                // Destructive: wipes all trades and restores the starting balance.
                if (window.confirm(t('resetConfirm'))) {
                  void act(resetAccount);
                }
              }}
            >
              {t('reset')}
            </button>
          </div>
        </header>

        <div className={styles.notice}>
          <span>🤝</span>
          <span>
            <b>{t('shareTitle')}:</b> {t('shareBody')}
          </span>
        </div>

        <nav className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'live' ? styles.tabOn : ''}`}
            onClick={() => setTab('live')}
          >
            {t('tabLive')}
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'history' ? styles.tabOn : ''}`}
            onClick={() => setTab('history')}
          >
            {t('tabHistory')} ({snap.closed.length})
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'backtest' ? styles.tabOn : ''}`}
            onClick={() => setTab('backtest')}
          >
            {t('tabBacktest')}
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'walkforward' ? styles.tabOn : ''}`}
            onClick={() => setTab('walkforward')}
          >
            {t('tabWalkforward')}
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'optimize' ? styles.tabOn : ''}`}
            onClick={() => setTab('optimize')}
          >
            {t('tabOptimize')}
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'options' ? styles.tabOn : ''}`}
            onClick={() => setTab('options')}
          >
            {t('tabOptions')}
          </button>
        </nav>

        {error && (
          <div className={`${styles.notice} ${styles.blocked}`}>
            <span>⚠️</span>
            <span>{t('connectionProblem', { err: error })}</span>
          </div>
        )}
        {authRequired && (
          <form
            className={`${styles.notice} ${styles.blocked}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (!apiTokenInput.trim()) return;
              if (!setApiToken(apiTokenInput)) {
                setError('This browser tab cannot store the API token. Allow session storage and retry.');
                return;
              }
              setApiTokenInput('');
              setAuthRequired(false);
              void load();
            }}
          >
            <label htmlFor="trader-api-token">{t('apiAuthRequired')}</label>
            <input
              id="trader-api-token"
              type="password"
              autoComplete="current-password"
              value={apiTokenInput}
              onChange={(event) => setApiTokenInput(event.target.value)}
            />
            <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!apiTokenInput.trim()}>
              {t('apiTokenSubmit')}
            </button>
          </form>
        )}


        {snap.blocked && (
          <div
            className={`${styles.notice} ${snap.blocked.kind === 'halt' ? styles.blocked : styles.info}`}
          >
            <span>{snap.blocked.kind === 'halt' ? '🛑' : snap.blocked.kind === 'regime' ? '📉' : 'ℹ️'}</span>
            <span style={{ flex: 1 }}>{snap.blocked.message}</span>
            {risk.pauseNewEntries && (
              <button
                style={{
                  marginLeft: 8,
                  padding: '4px 10px',
                  background: '#10b981',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                }}
                disabled={busy}
                onClick={() => act(() => updateRisk({ pauseNewEntries: false }))}
                title="Hervat het openen van nieuwe trades"
              >
                ▶️ Hervat entries
              </button>
            )}
            {snap.blocked.kind === 'halt' && snap.blocked.message.includes('Daglimiet') && !risk.ignoreDailyLimit && (
              <button
                style={{
                  marginLeft: 8,
                  padding: '4px 10px',
                  background: '#f59e0b',
                  color: '#000',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                }}
                disabled={busy}
                onClick={() => act(() => updateRisk({ ignoreDailyLimit: true }))}
                title="Negeer de daglimiet tot middernacht en laat de bot doorgaan met traden"
              >
                ⚡ Doorgaan
              </button>
            )}
          </div>
        )}

        {risk.ignoreDailyLimit && (
          <div className={`${styles.notice}`} style={{ background: '#78350f', color: '#fde68a', borderColor: '#f59e0b' }}>
            <span>⚠️</span>
            <span style={{ flex: 1 }}>Daglimiet-override actief — bot trade door ondanks daglimiet</span>
            <button
              style={{
                marginLeft: 8,
                padding: '4px 10px',
                background: '#374151',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                fontSize: 12,
              }}
              disabled={busy}
              onClick={() => act(() => updateRisk({ ignoreDailyLimit: false }))}
            >
              Herstellen
            </button>
          </div>
        )}

        {snap.learning?.penalties && Object.values(snap.learning.penalties).some((p) => p.penalizedUntil && p.penalizedUntil > Date.now()) && (
          <div className={styles.notice} style={{ background: '#1e1b4b', color: '#c7d2fe', borderColor: '#4338ca' }}>
            <span>🚫</span>
            <span style={{ flex: 1 }}>
              <b>Strafbankje actief:</b>{' '}
              {Object.values(snap.learning.penalties)
                .filter((p) => p.penalizedUntil && p.penalizedUntil > Date.now())
                .map((p) => `${p.symbol.replace('_', '/')} (nog ${Math.ceil((p.penalizedUntil! - Date.now()) / 3600_000)}u)`)
                .join(', ')} — deze munten worden tijdelijk overgeslagen na 2x verlies op rij.
            </span>
          </div>
        )}

        {!snap.blocked && snap.chopStatus.streak > 0 && (
          <div className={styles.notice}>
            <span>📊</span>
            <span className={styles.exchangeRow}>
              <span>
                <b>{t('chopCounterLabel')}</b>{' '}
                {t('chopCounterBody', {
                  streak: snap.chopStatus.streak,
                  limit: snap.chopStatus.limit,
                  state:
                    snap.chopStatus.streak >= snap.chopStatus.limit - 1
                      ? t('chopAlmostPausing')
                      : t('chopStillSearching'),
                })}
              </span>
              <span className={styles.chopBar}>
                <span
                  className={styles.chopBarFill}
                  style={{ width: `${Math.min(100, (snap.chopStatus.streak / snap.chopStatus.limit) * 100)}%` }}
                />
              </span>
            </span>
          </div>
        )}

        {tab === 'history' && (
          <HistoryPanel
            closed={snap.closed}
            stats={snap.stats}
            onOpenChart={setChartSymbol}
          />
        )}

        {tab === 'backtest' && <BacktestPage />}

        {tab === 'walkforward' && <WalkForwardPanel />}

        {tab === 'optimize' && <OptimizePanel />}

        {tab === 'options' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
            <div className={`${styles.notice} ${snap.exchange.enabled ? styles.blocked : ''}`}>
              <span>{snap.exchange.enabled ? '🔴' : '⚠️'}</span>
              <span>
                {snap.exchange.enabled ? (
                  <>
                    <b>{t('liveWarningTitle')}</b> {t('liveWarningBody')}
                  </>
                ) : (
                  <>
                    <b>{t('paperTitle')}</b> {t('paperBody')}
                  </>
                )}
              </span>
            </div>

            <div className={`${styles.notice} ${snap.exchange.enabled ? styles.blocked : ''}`}>
              <span>{snap.exchange.enabled ? '🔴' : snap.exchange.configured ? '🟡' : '🔌'}</span>
              <span className={styles.exchangeRow}>
                <span>
                  <b>{snap.exchange.venue === 'hyperliquid' ? '⚡ Hyperliquid DEX (L1)' : '🏛️ MEXC Futures'}</b>{' '}
                  {snap.exchange.enabled
                    ? (snap.exchange.venue === 'hyperliquid'
                        ? '🔴 Live trading actief op Hyperliquid L1 — orders worden direct on-chain geplaatst!'
                        : t('mexcLinkEnabled'))
                    : snap.exchange.configured
                      ? (snap.exchange.venue === 'hyperliquid'
                          ? '🟡 Hyperliquid wallet gekoppeld (klaar voor live trading)'
                          : t('mexcLinkConfigured'))
                      : t('mexcLinkNone')}
                </span>
                <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setShowHowTo((s) => !s)}
                  >
                    ❓ {t('howToConnectTitle')}
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={busy}
                    onClick={() => setShowKeyForm((s) => !s)}
                  >
                    {snap.exchange.configured ? t('changeKey') : t('enterOwnKey')}
                  </button>
                  {snap.exchange.configured && (
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={busy}
                      title="Wissel direct tussen Hyperliquid en MEXC"
                      onClick={() => {
                        const targetVenue = snap.exchange.venue === 'hyperliquid' ? 'mexc' : 'hyperliquid';
                        if (window.confirm(`Wil je overschakelen naar ${targetVenue === 'hyperliquid' ? 'Hyperliquid DEX' : 'MEXC Futures'}?`)) {
                          void act(() => setExchangeVenue(targetVenue));
                        }
                      }}
                    >
                      🔄 Wissel naar {snap.exchange.venue === 'hyperliquid' ? 'MEXC' : 'Hyperliquid'}
                    </button>
                  )}
                  {snap.exchange.configured && (
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={busy}
                      onClick={() => {
                        setTestResult(null);
                        setTestError(null);
                        setShowTestOrder((s) => !s);
                      }}
                    >
                      {t('placeTestOrderBtn')}
                    </button>
                  )}
                  {snap.exchange.configured && (
                    <button
                      type="button"
                      className={`${styles.btn} ${snap.exchange.enabled ? styles.btnDanger : styles.btnPrimary}`}
                      disabled={busy}
                      onClick={() => {
                        const next = !snap.exchange.enabled;
                        const question = next ? t('enableLiveConfirm') : t('disableLiveConfirm');
                        if (window.confirm(question)) {
                          void act(() => setLiveTrading(next));
                        }
                      }}
                    >
                      {snap.exchange.enabled ? t('disableLive') : t('enableLive')}
                    </button>
                  )}
                </span>
              </span>
            </div>

            {showHowTo && (
              <div className={styles.notice}>
                <span>📖</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <b>{t('howToConnectTitle')}</b>
                  <span>{t('howToConnectStep1')}</span>
                  <span>{t('howToConnectStep2')}</span>
                  <span>{t('howToConnectStep3')}</span>
                  <span>{t('howToConnectStep4')}</span>
                  <span>{t('howToConnectStep5')}</span>
                </span>
              </div>
            )}

            {showTestOrder && snap.exchange.configured && (
              <div className={styles.notice}>
                <span>🧪</span>
                <span className={styles.exchangeRow} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <span>{t('testOrderIntro')}</span>
                  <div className={styles.field}>
                    <label htmlFor="test-symbol">{t('market')}</label>
                    <input
                      id="test-symbol"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="BTC_USDT"
                      value={testSymbol}
                      disabled={testBusy}
                      onChange={(e) => setTestSymbol(e.target.value.toUpperCase())}
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="test-side">{t('direction')}</label>
                    <select
                      id="test-side"
                      className={styles.select}
                      value={testSide}
                      onChange={(e) => setTestSide(e.target.value as 'LONG' | 'SHORT')}
                    >
                      <option value="LONG">{t('long')}</option>
                      <option value="SHORT">{t('short')}</option>
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="test-amount">{snap.exchange.venue === 'hyperliquid' ? 'Bedrag (USDC)' : t('amountUsdt')}</label>
                    <input
                      id="test-amount"
                      type="number"
                      min={1}
                      step={0.5}
                      value={testAmount}
                      onChange={(e) => setTestAmount(Number(e.target.value))}
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="test-leverage">{t('leverage')}</label>
                    <input
                      id="test-leverage"
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={testLeverage}
                      onChange={(e) => setTestLeverage(Number(e.target.value))}
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="test-tp">🎯 Take Profit (% target)</label>
                    <input
                      id="test-tp"
                      type="number"
                      min={0.5}
                      max={50}
                      step={0.5}
                      value={testTpPct}
                      onChange={(e) => setTestTpPct(Number(e.target.value))}
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="test-sl">🛡️ Stop Loss (% bescherming)</label>
                    <input
                      id="test-sl"
                      type="number"
                      min={0.5}
                      max={50}
                      step={0.5}
                      value={testSlPct}
                      onChange={(e) => setTestSlPct(Number(e.target.value))}
                    />
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '6px', padding: '0.6rem 0.8rem', fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.2rem' }}>
                    <span style={{ color: '#4ade80' }}>
                      🎯 <b>Take Profit trigger:</b> {testSide === 'LONG' ? `+${testTpPct}% boven instapprijs` : `-${testTpPct}% onder instapprijs`}
                    </span>
                    <span style={{ color: '#f87171' }}>
                      🛡️ <b>Stop Loss trigger:</b> {testSide === 'LONG' ? `-${testSlPct}% onder instapprijs` : `+${testSlPct}% boven instapprijs`}
                    </span>
                  </div>
                  <div className={styles.field} style={{ flexDirection: 'row', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem', marginBottom: '0.4rem' }}>
                    <input
                      id="test-keep-open"
                      type="checkbox"
                      checked={testKeepOpen}
                      onChange={(e) => setTestKeepOpen(e.target.checked)}
                      style={{ width: '1.2rem', height: '1.2rem', cursor: 'pointer' }}
                    />
                    <label htmlFor="test-keep-open" style={{ margin: 0, cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
                      {testKeepOpen ? '🔓 Positie OPEN laten op MEXC (met actieve TP & SL triggers)' : '🔒 Direct weer automatisch sluiten na test'}
                    </label>
                  </div>
                  {testError && (
                    <span className={styles.down}>{t('testOrderFailed', { msg: testError })}</span>
                  )}
                  {testResult && (
                    <span className={styles.up} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      <span>{t('testOrderPlaced', { id: testResult.orderId, vol: testResult.vol, price: usd(testResult.price) })}</span>
                      {testResult.tpPrice && (
                        <span style={{ color: '#4ade80' }}>🎯 Take Profit ingesteld op MEXC: <b>${testResult.tpPrice}</b> ({testSide === 'LONG' ? `+${testTpPct}%` : `-${testTpPct}%`})</span>
                      )}
                      {testResult.slPrice && (
                        <span style={{ color: '#f87171' }}>🛡️ Stop Loss ingesteld op MEXC: <b>${testResult.slPrice}</b> ({testSide === 'LONG' ? `-${testSlPct}%` : `+${testSlPct}%`})</span>
                      )}
                      <span>
                        {testResult.closeOrderId
                          ? t('testOrderClosedAgain', { id: testResult.closeOrderId })
                          : t('testOrderLeftOpen')}
                      </span>
                    </span>
                  )}
                  <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={testBusy || !testSymbol.trim() || !(testAmount > 0)}
                      onClick={() => {
                        if (
                          !window.confirm(
                            testKeepOpen
                              ? `Weet je zeker dat je een ECHTE positie wilt openen op ${testSymbol} ($${testAmount}, ${testLeverage}x) met actieve TP (+${testTpPct}%) en SL (-${testSlPct}%)?`
                              : t('testOrderConfirm', { amount: testAmount, lev: testLeverage, symbol: testSymbol })
                          )
                        ) {
                          return;
                        }
                        setTestBusy(true);
                        setTestError(null);
                        setTestResult(null);
                        const symbol = testSymbol.trim().toUpperCase();
                        setTestedSymbol(symbol);
                        placeTestOrder(symbol, testSide, testAmount, testLeverage, testKeepOpen, testTpPct, testSlPct)
                          .then((res) => {
                            if (!mounted.current) return;
                            setTestResult(res);
                            void load();
                          })
                          .catch((err) => {
                            if (!mounted.current) return;
                            setTestedSymbol(null);
                            setTestError((err as Error).message);
                          })
                          .finally(() => {
                            if (mounted.current) setTestBusy(false);
                          });
                      }}
                    >
                      {testBusy
                        ? t('busy')
                        : testKeepOpen
                          ? '🚀 Plaats testorder & laat open (met TP/SL)'
                          : t('placeTestOrderAndClose')}
                    </button>
                    {testResult && !testResult.closeOrderId && testedSymbol && (
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnDanger}`}
                        disabled={testBusy}
                        onClick={() => {
                          if (!window.confirm(`Positie op ${testedSymbol} nu sluiten op MEXC?`)) return;
                          setTestBusy(true);
                          closeExchangePosition(testedSymbol)
                            .then(() => {
                              if (!mounted.current) return;
                              setTestResult(null);
                              setTestedSymbol(null);
                              void load();
                            })
                            .catch((err) => {
                              if (mounted.current) setTestError((err as Error).message);
                            })
                            .finally(() => {
                              if (mounted.current) setTestBusy(false);
                            });
                        }}
                      >
                        Sluit open testpositie nu
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={testBusy}
                      onClick={() => setShowTestOrder(false)}
                    >
                      {t('close')}
                    </button>
                  </span>
                </span>
              </div>
            )}

            {showKeyForm && (
              <div className={styles.notice}>
                <span>🔑</span>
                <span className={styles.exchangeRow} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
                    <button
                      type="button"
                      className={`${styles.btn} ${venueTab === 'hyperliquid' ? styles.btnPrimary : ''}`}
                      onClick={() => setVenueTab('hyperliquid')}
                    >
                      ⚡ Hyperliquid DEX (L1)
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${venueTab === 'mexc' ? styles.btnPrimary : ''}`}
                      onClick={() => setVenueTab('mexc')}
                    >
                      🏛️ MEXC Futures
                    </button>
                  </div>

                  {venueTab === 'hyperliquid' ? (
                    <>
                      <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: '#94a3b8' }}>
                        Verbind via Hyperliquid L1 met USDC als onderpand. Orders worden direct op de on-chain orderboeken geplaatst via EIP-712 ondertekening.
                      </p>
                      <div className={styles.field}>
                        <label htmlFor="hl-wallet-address">Wallet Adres (0x...)</label>
                        <input
                          id="hl-wallet-address"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="0x..."
                          value={walletAddressInput}
                          onChange={(e) => setWalletAddressInput(e.target.value)}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor="hl-private-key">Private Key (voor live trading via Agent Wallet of Main Wallet)</label>
                        <input
                          id="hl-private-key"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="0x... of 64 hex tekens"
                          value={privateKeyInput}
                          onChange={(e) => setPrivateKeyInput(e.target.value)}
                        />
                        <small style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                          Tip: Maak op app.hyperliquid.xyz bij voorkeur een Agent Wallet aan met beperkte rechten voor geautomatiseerde handel.
                        </small>
                      </div>
                      <div style={{ margin: '0.5rem 0 0.8rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input
                          id="hl-testnet"
                          type="checkbox"
                          checked={isTestnetInput}
                          onChange={(e) => setIsTestnetInput(e.target.checked)}
                          style={{ cursor: 'pointer' }}
                        />
                        <label htmlFor="hl-testnet" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
                          Gebruik Hyperliquid Testnet (api.hyperliquid-testnet.xyz)
                        </label>
                      </div>
                      <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          disabled={busy || !walletAddressInput.trim()}
                          onClick={() =>
                            void act(async () => {
                              await saveExchangeCredentials({
                                venue: 'hyperliquid',
                                walletAddress: walletAddressInput.trim(),
                                privateKey: privateKeyInput.trim(),
                                isTestnet: isTestnetInput,
                              });
                              setShowKeyForm(false);
                            })
                          }
                        >
                          ⚡ Verbind & Activeer Hyperliquid
                        </button>
                        {snap.exchange.configured && (
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnDanger}`}
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm('Weet je zeker dat je de exchange verbinding wilt verwijderen?')) {
                                void act(async () => {
                                  await saveExchangeCredentials('', '');
                                  setShowKeyForm(false);
                                });
                              }
                            }}
                          >
                            Verbinding Verbreken
                          </button>
                        )}
                        <button type="button" className={styles.btn} disabled={busy} onClick={() => setShowKeyForm(false)}>
                          {t('cancel')}
                        </button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span>{t('apiKeyFormIntro')}</span>
                      <div className={styles.field}>
                        <label htmlFor="mexc-api-key">{t('apiKeyLabel')}</label>
                        <input
                          id="mexc-api-key"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="mx0v..."
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor="mexc-api-secret">{t('apiSecretLabel')}</label>
                        <input
                          id="mexc-api-secret"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="••••••••"
                          value={apiSecretInput}
                          onChange={(e) => setApiSecretInput(e.target.value)}
                        />
                      </div>
                      <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          disabled={busy || !apiKeyInput.trim() || !apiSecretInput.trim()}
                          onClick={() =>
                            void act(async () => {
                              await saveExchangeCredentials({
                                venue: 'mexc',
                                apiKey: apiKeyInput.trim(),
                                apiSecret: apiSecretInput.trim(),
                              });
                              setApiKeyInput('');
                              setApiSecretInput('');
                              setShowKeyForm(false);
                            })
                          }
                        >
                          {t('saveAndConnect')}
                        </button>
                        {snap.exchange.configured && (
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnDanger}`}
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(t('removeConnectionConfirm'))) {
                                void act(async () => {
                                  await saveExchangeCredentials('', '');
                                  setShowKeyForm(false);
                                });
                              }
                            }}
                          >
                            {t('removeConnection')}
                          </button>
                        )}
                        <button type="button" className={styles.btn} disabled={busy} onClick={() => setShowKeyForm(false)}>
                          {t('cancel')}
                        </button>
                      </span>
                    </>
                  )}
                </span>
              </div>
            )}

            <div className={styles.notice}>
              <span>{snap.notificationsEnabled ? '🔔' : '🔕'}</span>
              <span>
                <b>{t('notificationsLabel')}</b>{' '}
                {snap.notificationsEnabled ? t('notificationsOn') : t('notificationsOff')}
              </span>
            </div>

            <section className={styles.panel} style={{ marginTop: '0.5rem' }}>
              <div className={styles.panelHead}>
                <h2>🛡️ {t('riskManagement')}</h2>
              </div>
              <div className={styles.panelBody}>
          <RiskPanel
            risk={risk}
            onSave={async (patch: Partial<RiskConfig>) => {
              beginBusy();
              try {
                await updateRisk(patch);
                await load();
              } catch (err) {
                if (mounted.current) {
                  setError((err as Error).message);
                  setAuthRequired(err instanceof ApiError && err.status === 401);
                }
                throw err;
              } finally {
                endBusy();
              }
            }}
          />
              </div>
            </section>
          </div>
        )}

        {tab === 'live' && (
          <>
            <BtcForecast snap={snap} />
        {isLive && liveAccount?.error && (
          <div className={`${styles.notice} ${styles.blocked}`}>
            <span>⚠️</span>
            <span>
              {t('mexcBalanceError', { err: liveAccount.error })}
            </span>
          </div>
        )}

        <section className={styles.stats}>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('equity')}{isLive ? ' (MEXC)' : ''}</p>
            <p className={styles.cardValue}>
              {isLive ? (liveAccountOk ? usd(liveAccount.equity) : '—') : usd(account.equity)}
            </p>
            {isLive ? (
              <p className={styles.cardSub}>{liveAccountOk ? t('fromMexc') : t('mexcUnavailable')}</p>
            ) : (
              <p className={`${styles.cardSub} ${totalPnl >= 0 ? styles.up : styles.down}`}>
                {t('sinceStart', { v: signed(totalPnl, (v) => usd(v)) })}
              </p>
            )}
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('freeBalance')}{isLive ? ' (MEXC)' : ''}</p>
            <p className={styles.cardValue}>
              {isLive ? (liveAccountOk ? usd(liveAccount.available) : '—') : usd(account.balance)}
            </p>
            <p className={styles.cardSub}>
              {isLive
                ? liveAccountOk
                  ? t('inUse', { v: usd(liveAccount.frozen) })
                  : t('mexcUnavailable')
                : t('inUse', { v: usd(account.usedMargin) })}
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('openPnl')}{isLive ? ' (MEXC)' : ''}</p>
            <p
              className={`${styles.cardValue} ${
                isLive && !liveAccountOk
                  ? ''
                  : (liveAccountOk ? liveAccount.unrealisedPnl : account.unrealisedPnl) >= 0
                    ? styles.up
                    : styles.down
              }`}
            >
              {isLive
                ? liveAccountOk
                  ? signed(liveAccount.unrealisedPnl, (v) => usd(v))
                  : '—'
                : signed(account.unrealisedPnl, (v) => usd(v))}
            </p>
            <p className={styles.cardSub}>
              {t('positionsOpen', { n: `${openCount ?? '—'} / ${maxOpen}` })}
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('winRate')}</p>
            <p className={styles.cardValue}>{stats.trades ? pct(stats.winRate, 0) : '—'}</p>
            <p className={styles.cardSub}>
              {t('winLossOf', { w: stats.wins, l: stats.losses, t: stats.trades })}
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('profitFactor')}</p>
            <p className={styles.cardValue}>
              {stats.trades ? (Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞') : '—'}
            </p>
            <p className={styles.cardSub}>
              {t('avgOf', { w: usd(stats.avgWin, 0), l: usd(stats.avgLoss, 0) })}
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('drawdown')}</p>
            <p className={`${styles.cardValue} ${account.drawdownPct > 0.1 ? styles.down : ''}`}>
              {pct(account.drawdownPct, 1)}
            </p>
            <p className={styles.cardSub}>{t('limit', { v: pct(risk.maxDrawdownPct, 0) })}</p>
          </div>
        </section>

        <div className={styles.grid}>
          <div className={styles.column}>
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>{t('openPositions')}{isLive ? ` (${snap.exchange.venue?.toUpperCase() || 'MEXC'})` : ''}</h2>
                <span
                  className={`${styles.count} ${openCount !== undefined && openCount > maxOpen ? styles.countOverflow : ''}`}
                  title={openCount === undefined ? t('mexcUnavailable') : `${openCount} open / max ${maxOpen} trades`}
                >
                  {openCount === undefined ? '—' : `${openCount} / ${maxOpen}`}
                </span>
              </div>
              <div className={styles.panelBody}>
                {isLive ? (
                  liveAccountOk ? liveAccount.open.length ? (
                    <div className={styles.rows}>
                      {[...liveAccount.open]
                        .sort((a, b) => {
                          const timeA =
                            a.openedAt ||
                            snap.open.find((o) => o.symbol === a.symbol && o.side === a.side)?.openedAt ||
                            0;
                          const timeB =
                            b.openedAt ||
                            snap.open.find((o) => o.symbol === b.symbol && o.side === b.side)?.openedAt ||
                            0;
                          return timeB - timeA; // Newest first, longest open at the bottom
                        })
                        .map((p) => {
                          const plan = snap.open.find(
                            (o) => o.symbol === p.symbol && o.side === p.side
                          );
                          return (
                            <LivePositionRow
                              key={p.symbol + p.side}
                              position={p}
                              plan={plan}
                              onClose={plan ? (id) => act(() => closePosition(id)) : undefined}
                              onReduce={plan ? (id, frac) => act(() => reducePosition(id, frac)) : undefined}
                              onOpenChart={setChartSymbol}
                            />
                          );
                        })}
                    </div>
                  ) : (
                    <p className={styles.empty}>{t('noOpenPositionsMexc')}</p>
                  )
                  : <p className={styles.empty}>{t('mexcPositionsUnavailable')}</p>
                ) : snap.open.length ? (
                  <div className={styles.rows}>
                    {[...snap.open]
                      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)) // Newest first, longest open at the bottom
                      .map((p) => (
                        <PositionRow
                          key={p.id}
                          position={p}
                          mark={marks[p.symbol]}
                          onClose={(id) => act(() => closePosition(id))}
                          onReduce={(id, frac) => act(() => reducePosition(id, frac))}
                          onOpenChart={setChartSymbol}
                        />
                      ))}
                  </div>
                ) : (
                  <p className={styles.empty}>{t('noOpenPositions')}</p>
                )}
              </div>
            </section>
          </div>

          <div className={styles.column}>
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>{t('scannerRanking')}</h2>
                <span className={styles.count}>{t('threshold', { v: pct(risk.minConfidence, 0) })}</span>
              </div>
              <div className={styles.panelBody}>
                <SignalList
                  signals={snap.signals}
                  threshold={risk.minConfidence}
                  onOpenChart={setChartSymbol}
                />
              </div>
            </section>

            <ScoutPanel scout={snap.scout} onDecision={() => void load()} />

            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <h2>{t('engineLog')}</h2>
              </div>
              <div className={styles.log}>
                {snap.events.length ? (
                  snap.events.map((e) => (
                    <div key={`${e.at}-${e.message}`} className={styles.logLine}>
                      <span className={styles.logTime}>{time(e.at)}</span>
                      <span className={styles[`log${e.level[0].toUpperCase()}${e.level.slice(1)}`]}>
                        {e.message}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className={styles.empty}>{t('noActivityYet')}</p>
                )}
              </div>
            </section>
          </div>
        </div>
          </>
        )}

        <footer className={styles.footer}>{t('footer')}</footer>
      </div>

      {chartSymbol && (
        <div className={styles.modalBackdrop} onClick={() => setChartSymbol(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <h3>{chartSymbol.replace('_', '/')}</h3>
              <button type="button" className={styles.modalClose} onClick={() => setChartSymbol(null)}>
                ✕
              </button>
            </div>
            {chartError ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', alignItems: 'flex-start' }}>
                <p className={styles.empty}>{t('chartLoadFailed', { err: chartError })}</p>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => {
                      void loadChart(chartSymbol);
                  }}
                >
                  🔄 {t('retry')}
                </button>
              </div>
            ) : chart ? (
              <ChartErrorBoundary
                key={chart.symbol}
                fallback={(err) => (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', alignItems: 'flex-start' }}>
                    <p className={styles.empty}>Grafiek kon niet worden getekend: {err.message}</p>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => {
                        void loadChart(chartSymbol);
                      }}
                    >
                      🔄 {t('retry')}
                    </button>
                  </div>
                )}
              >
                <SignalChart
                  candles={chart.candles}
                  signal={chart.signal}
                  symbol={chart.symbol}
                  position={
                    chart.position ||
                    snap?.open?.find((p) => p.symbol === chart.symbol) ||
                    snap?.exchangeAccount?.open?.find((p) => p.symbol === chart.symbol)
                  }
                  plannedTrade={chart.plannedTrade}
                />
              </ChartErrorBoundary>
            ) : (
              <p className={styles.empty}>{t('chartLoading')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
