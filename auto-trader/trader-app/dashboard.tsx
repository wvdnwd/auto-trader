import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './trader-app.module.css';
import {
  closeExchangePosition,
  closePosition,
  fetchChart,
  fetchSnapshot,
  placeTestOrder,
  resetAccount,
  runCycle,
  saveExchangeCredentials,
  setEngineRunning,
  setLiveTrading,
  updateRisk,
} from './api.js';
import type { TestOrderResult } from './api.js';
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

/**
 * The autonomous trading dashboard — account health, open positions, the live
 * scanner ranking, engine log and the risk controls, polled in real time.
 */
export function Dashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'live' | 'history' | 'backtest' | 'walkforward' | 'optimize' | 'options'>('live');
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiSecretInput, setApiSecretInput] = useState('');
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
  const [testError, setTestError] = useState<string | null>(null);
  const [showHowTo, setShowHowTo] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const mounted = useRef(true);
  const { t, lang, setLang } = useLanguage();

  const load = useCallback(async () => {
    try {
      const next = await fetchSnapshot();
      // Ignore a late response that arrives after the component unmounted.
      if (!mounted.current) return;
      setSnap(next);
      setError(null);
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [load]);

  useEffect(() => {
    if (!chartSymbol) return;
    setChart(null);
    setChartError(null);
    fetchChart(chartSymbol)
      .then((data) => mounted.current && setChart(data))
      .catch((err) => mounted.current && setChartError((err as Error).message));
  }, [chartSymbol]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!snap) {
    return (
      <div className={styles.app}>
        <div className={styles.shell}>
          <p className={styles.empty}>{error ? t('connectFailed', { err: error }) : t('connecting')}</p>
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
  const openCount = isLive && liveAccount && !liveAccount.error ? liveAccount.open.length : snap.open.length;
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
            <span className={styles.status}>
              <span className={`${styles.dot} ${snap.running ? styles.dotLive : ''}`} />
              {snap.running ? (snap.watching ? t('statusLiveWatching') : t('statusLive')) : t('statusPaused')}
            </span>
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
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2000);
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
                  <b>{t('mexcLinkLabel')}</b>{' '}
                  {snap.exchange.enabled
                    ? t('mexcLinkEnabled')
                    : snap.exchange.configured
                      ? t('mexcLinkConfigured')
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
                    <label htmlFor="test-amount">{t('amountUsdt')}</label>
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
                        placeTestOrder(testSymbol.trim(), testSide, testAmount, testLeverage, testKeepOpen, testTpPct, testSlPct)
                          .then((res) => {
                            setTestResult(res);
                            void load();
                          })
                          .catch((err) => setTestError((err as Error).message))
                          .finally(() => setTestBusy(false));
                      }}
                    >
                      {testBusy
                        ? t('busy')
                        : testKeepOpen
                          ? '🚀 Plaats testorder & laat open (met TP/SL)'
                          : t('placeTestOrderAndClose')}
                    </button>
                    {testResult && !testResult.closeOrderId && (
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnDanger}`}
                        disabled={testBusy}
                        onClick={() => {
                          if (!window.confirm(`Positie op ${testSymbol} nu sluiten op MEXC?`)) return;
                          setTestBusy(true);
                          closeExchangePosition(testSymbol.trim())
                            .then(() => {
                              setTestResult(null);
                              void load();
                            })
                            .catch((err) => setTestError((err as Error).message))
                            .finally(() => setTestBusy(false));
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
                          await saveExchangeCredentials(apiKeyInput.trim(), apiSecretInput.trim());
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
                <RiskPanel risk={risk} onSave={(patch: Partial<RiskConfig>) => act(() => updateRisk(patch))} />
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
              {isLive && liveAccount && !liveAccount.error ? usd(liveAccount.equity) : usd(account.equity)}
            </p>
            {isLive && liveAccount && !liveAccount.error ? (
              <p className={styles.cardSub}>{t('fromMexc')}</p>
            ) : (
              <p className={`${styles.cardSub} ${totalPnl >= 0 ? styles.up : styles.down}`}>
                {t('sinceStart', { v: signed(totalPnl, (v) => usd(v)) })}
              </p>
            )}
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('freeBalance')}{isLive ? ' (MEXC)' : ''}</p>
            <p className={styles.cardValue}>
              {isLive && liveAccount && !liveAccount.error ? usd(liveAccount.available) : usd(account.balance)}
            </p>
            <p className={styles.cardSub}>
              {t('inUse', {
                v:
                  isLive && liveAccount && !liveAccount.error ? usd(liveAccount.frozen) : usd(account.usedMargin),
              })}
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardLabel}>{t('openPnl')}{isLive ? ' (MEXC)' : ''}</p>
            <p
              className={`${styles.cardValue} ${
                (isLive && liveAccount && !liveAccount.error ? liveAccount.unrealisedPnl : account.unrealisedPnl) >= 0
                  ? styles.up
                  : styles.down
              }`}
            >
              {signed(
                isLive && liveAccount && !liveAccount.error ? liveAccount.unrealisedPnl : account.unrealisedPnl,
                (v) => usd(v)
              )}
            </p>
            <p className={styles.cardSub}>
              {t('positionsOpen', {
                n: `${openCount} / ${maxOpen}`,
              })}
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
                <h2>{t('openPositions')}{isLive ? ' (MEXC)' : ''}</h2>
                <span
                  className={`${styles.count} ${openCount > maxOpen ? styles.countOverflow : ''}`}
                  title={`${openCount} open / max ${maxOpen} trades (TP1 bereikt of overflow)`}
                >
                  {openCount} / {maxOpen}
                </span>
              </div>
              <div className={styles.panelBody}>
                {isLive && liveAccount && !liveAccount.error ? (
                  liveAccount.open.length ? (
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
                              onOpenChart={setChartSymbol}
                            />
                          );
                        })}
                    </div>
                  ) : (
                    <p className={styles.empty}>{t('noOpenPositionsMexc')}</p>
                  )
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
                    setChartError(null);
                    setChart(null);
                    fetchChart(chartSymbol)
                      .then((data) => mounted.current && setChart(data))
                      .catch((err) => mounted.current && setChartError((err as Error).message));
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
                        setChart(null);
                        setChartError(null);
                        fetchChart(chartSymbol)
                          .then((data) => mounted.current && setChart(data))
                          .catch((e) => mounted.current && setChartError((e as Error).message));
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
                  position={chart.position || snap?.open?.find((p) => p.symbol === chart.symbol)}
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
