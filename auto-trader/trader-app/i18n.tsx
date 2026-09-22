import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Supported dashboard languages. */
export type Language = 'nl' | 'en';

const STORAGE_KEY = 'trader-app-language';

/**
 * Translation dictionary. Each key maps to the Dutch and English copy for one
 * piece of UI text. Interpolation uses `{{name}}` placeholders, filled in by
 * {@link useTranslate}.
 */
const DICTIONARY = {
  appTitle: { nl: 'Autonome Futures Trader', en: 'Autonomous Futures Trader' },
  appTagline: {
    nl: 'Scant live markten · kiest long/short · bepaalt leverage & inzet',
    en: 'Scans live markets · picks long/short · sizes leverage & stake',
  },
  lastScan: { nl: 'laatste scan {{time}}', en: 'last scan {{time}}' },
  notScannedYet: { nl: 'nog niet gescand', en: 'not scanned yet' },
  everySeconds: { nl: ' · elke {{s}}s', en: ' · every {{s}}s' },
  statusLiveWatching: { nl: 'Live · setup in zicht', en: 'Live · setup in sight' },
  statusLive: { nl: 'Live', en: 'Live' },
  statusPaused: { nl: 'Gepauzeerd', en: 'Paused' },
  pause: { nl: 'Pauzeer', en: 'Pause' },
  startEngine: { nl: 'Start engine', en: 'Start engine' },
  scanNow: { nl: 'Scan nu', en: 'Scan now' },
  busy: { nl: 'Bezig…', en: 'Working…' },
  reset: { nl: 'Reset', en: 'Reset' },
  resetConfirm: {
    nl: 'Account resetten? Alle posities en historie worden gewist.',
    en: 'Reset account? All positions and history will be wiped.',
  },
  tabLive: { nl: 'Live', en: 'Live' },
  tabBacktest: { nl: 'Backtest', en: 'Backtest' },
  tabWalkforward: { nl: 'Walk-forward', en: 'Walk-forward' },
  tabOptimize: { nl: 'Optimaliseren', en: 'Optimize' },
  tabOptions: { nl: '⚙️ Opties', en: '⚙️ Options' },
  retry: { nl: 'Opnieuw proberen', en: 'Try again' },
  liveWarningTitle: { nl: 'LIVE — er staat echt geld op het spel.', en: 'LIVE — real money is on the line.' },
  liveWarningBody: {
    nl: 'Elke order, stop en take-profit die hieronder verschijnt wordt ook echt op MEXC geplaatst. Dit is geen financieel advies.',
    en: 'Every order, stop and take-profit shown below is also placed for real on MEXC. This is not financial advice.',
  },
  paperTitle: { nl: 'Paper trading met live marktdata.', en: 'Paper trading with live market data.' },
  paperBody: {
    nl: 'Er gaat geen echt geld in om — de engine handelt gesimuleerd tegen echte prijzen. Dit is geen financieel advies.',
    en: 'No real money is involved — the engine trades in simulation against real prices. This is not financial advice.',
  },
  mexcLinkLabel: { nl: 'MEXC-koppeling:', en: 'MEXC connection:' },
  mexcLinkEnabled: {
    nl: 'live order-uitvoering ingeschakeld — de engine plaatst echte orders.',
    en: 'live order execution enabled — the engine places real orders.',
  },
  mexcLinkConfigured: {
    nl: 'API-sleutels aanwezig, live uitvoering nog uitgeschakeld — engine blijft op papier handelen.',
    en: 'API keys present, live execution still off — the engine keeps trading on paper.',
  },
  mexcLinkNone: {
    nl: 'nog niet gekoppeld — voeg je eigen MEXC API-sleutel toe zodra je klaar bent voor live uitvoering.',
    en: 'not connected yet — add your own MEXC API key whenever you are ready for live execution.',
  },
  changeKey: { nl: 'Sleutel wijzigen', en: 'Change key' },
  enterOwnKey: { nl: 'Eigen API-sleutel invoeren', en: 'Enter your own API key' },
  placeTestOrderBtn: { nl: 'Testorder plaatsen', en: 'Place test order' },
  enableLive: { nl: 'Schakel live uitvoering in', en: 'Enable live execution' },
  disableLive: { nl: 'Zet uit — terug naar paper', en: 'Turn off — back to paper' },
  enableLiveConfirm: {
    nl: 'Live order-uitvoering INSCHAKELEN? De engine plaatst dan echte orders met echt geld op MEXC.',
    en: 'ENABLE live order execution? The engine will then place real orders with real money on MEXC.',
  },
  disableLiveConfirm: {
    nl: 'Live order-uitvoering uitschakelen en terugschakelen naar paper trading?',
    en: 'Disable live order execution and switch back to paper trading?',
  },
  testOrderIntro: {
    nl: 'Plaatst een echte, kleine order rechtstreeks op MEXC (los van de strategie) om te controleren of je sleutel orders mag plaatsen en laten vullen. De order wordt na plaatsing direct weer gesloten, tenzij je "open laten staan" aanvinkt.',
    en: 'Places a real, small order directly on MEXC (separate from the strategy) to confirm your key can place and fill orders. The order is immediately closed again after placement unless you check "keep open".',
  },
  market: { nl: 'Market', en: 'Market' },
  direction: { nl: 'Richting', en: 'Direction' },
  long: { nl: 'Long', en: 'Long' },
  short: { nl: 'Short', en: 'Short' },
  amountUsdt: { nl: 'Bedrag (USDT notional)', en: 'Amount (USDT notional)' },
  leverage: { nl: 'Leverage', en: 'Leverage' },
  testOrderFailed: { nl: 'Testorder mislukt: {{msg}}', en: 'Test order failed: {{msg}}' },
  testOrderPlaced: {
    nl: '✅ Order geplaatst ({{id}}) — {{vol}} contracten @ ~{{price}}',
    en: '✅ Order placed ({{id}}) — {{vol}} contracts @ ~{{price}}',
  },
  testOrderClosedAgain: {
    nl: ' — direct weer gesloten ({{id}}). Koppeling werkt.',
    en: ' — closed again immediately ({{id}}). Connection works.',
  },
  testOrderLeftOpen: { nl: ' — open gelaten op MEXC.', en: ' — left open on MEXC.' },
  testOrderConfirm: {
    nl: 'Echte testorder van {{amount}} USDT ({{lev}}x) op {{symbol}} plaatsen op MEXC? Dit gebruikt echt geld.',
    en: 'Place a real test order of {{amount}} USDT ({{lev}}x) on {{symbol}} on MEXC? This uses real money.',
  },
  placeTestOrderAndClose: { nl: 'Plaats testorder & sluit direct', en: 'Place test order & close immediately' },
  close: { nl: 'Sluiten', en: 'Close' },
  cancel: { nl: 'Annuleren', en: 'Cancel' },
  save: { nl: 'Opslaan', en: 'Save' },
  saveAndConnect: { nl: 'Opslaan & koppelen', en: 'Save & connect' },
  removeConnection: { nl: 'Koppeling verwijderen', en: 'Remove connection' },
  removeConnectionConfirm: {
    nl: 'MEXC-koppeling verwijderen? De engine schakelt terug naar paper trading.',
    en: 'Remove the MEXC connection? The engine switches back to paper trading.',
  },
  apiKeyLabel: { nl: 'API key', en: 'API key' },
  apiSecretLabel: { nl: 'API secret', en: 'API secret' },
  apiKeyFormIntro: {
    nl: 'Vul je eigen MEXC API-sleutel in (Futures Lezen + Handelen aan, Opnemen uit). De sleutel wordt versleuteld opgeslagen in de database van deze installatie — niet gedeeld met anderen die deze app draaien.',
    en: 'Enter your own MEXC API key (Futures Read + Trade on, Withdraw off). The key is stored encrypted in this installation\u2019s database — never shared with anyone else running this app.',
  },
  howToConnectTitle: { nl: 'Hoe koppel je je MEXC API-sleutel?', en: 'How to connect your MEXC API key' },
  howToConnectStep1: {
    nl: '1. Log in op mexc.com → Account → API Management.',
    en: '1. Log in at mexc.com → Account → API Management.',
  },
  howToConnectStep2: {
    nl: '2. Maak een nieuwe sleutel aan. Geef alleen "Futures" rechten: Lezen + Handelen aan. Zet "Spot" en "Opnemen/Withdraw" UIT — deze app heeft dat nooit nodig.',
    en: '2. Create a new key. Grant only "Futures" permissions: Read + Trade. Turn "Spot" and "Withdraw" OFF — this app never needs them.',
  },
  howToConnectStep3: {
    nl: '3. (Aanbevolen) Beperk de sleutel tot je eigen IP-adres bij MEXC voor extra veiligheid.',
    en: '3. (Recommended) Restrict the key to your own IP address on MEXC for extra safety.',
  },
  howToConnectStep4: {
    nl: '4. Kopieer de API key en secret hieronder — MEXC toont de secret maar één keer.',
    en: '4. Copy the API key and secret below — MEXC only shows the secret once.',
  },
  howToConnectStep5: {
    nl: '5. Sla op, en test daarna eerst met een kleine testorder (1 USDT) voordat je live uitvoering inschakelt.',
    en: '5. Save, then verify first with a small test order (1 USDT) before enabling live execution.',
  },
  notificationsLabel: { nl: 'Meldingen:', en: 'Notifications:' },
  notificationsOn: {
    nl: 'Telegram/webhook actief — je krijgt een melding bij open/sluit-trades en risico-stops.',
    en: 'Telegram/webhook active — you get notified on open/close trades and risk stops.',
  },
  notificationsOff: {
    nl: 'nog niet ingesteld — stel TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID of NOTIFY_WEBHOOK_URL in om meldingen te ontvangen.',
    en: 'not set up yet — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or NOTIFY_WEBHOOK_URL to receive notifications.',
  },
  connectionProblem: {
    nl: 'Verbindingsprobleem: {{err}} — opnieuw proberen bij de volgende poll.',
    en: 'Connection problem: {{err}} — will retry on the next poll.',
  },
  chopCounterLabel: { nl: 'Chop-teller:', en: 'Chop counter:' },
  chopCounterBody: {
    nl: '{{streak}}/{{limit}} scans zonder kansrijke trend — {{state}}',
    en: '{{streak}}/{{limit}} scans without a promising trend — {{state}}',
  },
  chopAlmostPausing: { nl: 'nieuwe entries pauzeren bijna.', en: 'new entries about to pause.' },
  chopStillSearching: {
    nl: 'markt is nog rustig aan het zoeken naar richting.',
    en: 'market is still quietly searching for direction.',
  },
  mexcBalanceError: {
    nl: 'MEXC-saldo kon niet worden opgehaald: {{err}}. Controleer de API-sleutel en de MEXC-verbinding — tot dit hersteld is tonen de kaarten hieronder geen betrouwbare cijfers.',
    en: 'Could not fetch MEXC balance: {{err}}. Check the API key and the MEXC connection — until this is fixed the cards below do not show reliable numbers.',
  },
  equity: { nl: 'Equity', en: 'Equity' },
  sinceStart: { nl: '{{v}} sinds start', en: '{{v}} since start' },
  fromMexc: { nl: 'rechtstreeks van MEXC', en: 'directly from MEXC' },
  freeBalance: { nl: 'Vrij saldo', en: 'Free balance' },
  inUse: { nl: '{{v}} in gebruik', en: '{{v}} in use' },
  openPnl: { nl: 'Open P&L', en: 'Open P&L' },
  positionsOpen: { nl: '{{n}} posities open', en: '{{n}} positions open' },
  winRate: { nl: 'Win rate', en: 'Win rate' },
  winLossOf: { nl: '{{w}}W / {{l}}L over {{t}} trades', en: '{{w}}W / {{l}}L of {{t}} trades' },
  profitFactor: { nl: 'Profit factor', en: 'Profit factor' },
  avgOf: { nl: 'gem. {{w}} / {{l}}', en: 'avg. {{w}} / {{l}}' },
  drawdown: { nl: 'Drawdown', en: 'Drawdown' },
  limit: { nl: 'limiet {{v}}', en: 'limit {{v}}' },
  openPositions: { nl: 'Open posities', en: 'Open positions' },
  noOpenPositionsMexc: {
    nl: 'Geen open posities op MEXC — de engine wacht op een setup met genoeg conviction.',
    en: 'No open positions on MEXC — the engine is waiting for a setup with enough conviction.',
  },
  noOpenPositions: {
    nl: 'Geen open posities — de engine wacht op een setup met genoeg conviction.',
    en: 'No open positions — the engine is waiting for a setup with enough conviction.',
  },
  tradeHistory: { nl: 'Trade historie', en: 'Trade history' },
  noClosedTrades: { nl: 'Nog geen afgesloten trades.', en: 'No closed trades yet.' },
  scannerRanking: { nl: 'Scanner ranking', en: 'Scanner ranking' },
  threshold: { nl: 'drempel {{v}}', en: 'threshold {{v}}' },
  engineLog: { nl: 'Engine log', en: 'Engine log' },
  noActivityYet: { nl: 'Nog geen activiteit.', en: 'No activity yet.' },
  riskManagement: { nl: 'Risicobeheer', en: 'Risk management' },
  footer: {
    nl: 'Live marktdata via publieke futures-endpoints · gesimuleerde uitvoering · leverage en positiegrootte worden volledig automatisch bepaald uit volatiliteit en conviction.',
    en: 'Live market data via public futures endpoints · simulated execution · leverage and position size are fully automatic from volatility and conviction.',
  },
  chartLoadFailed: { nl: 'Grafiek laden mislukt: {{err}}', en: 'Failed to load chart: {{err}}' },
  chartLoading: { nl: 'Grafiek laden…', en: 'Loading chart…' },
  connecting: { nl: 'Verbinden met trading engine…', en: 'Connecting to trading engine…' },
  connectFailed: { nl: 'Verbinden mislukt: {{err}}', en: 'Connection failed: {{err}}' },
  shareTitle: { nl: 'Delen met anderen', en: 'Share with others' },
  shareBody: {
    nl: 'Iedereen die deze link opent, krijgt zijn eigen onafhankelijke account — eigen papertrading-saldo, eigen MEXC-koppeling en eigen instellingen. Niets daarvan raakt jouw account.',
    en: 'Anyone who opens this link gets their own independent account — their own paper-trading balance, their own MEXC connection and their own settings. None of it touches your account.',
  },
  copyLink: { nl: 'Link kopiëren', en: 'Copy link' },
  linkCopied: { nl: 'Gekopieerd ✓', en: 'Copied ✓' },
  riskTradeSingular: { nl: 'trade', en: 'trade' },
  riskTradePlural: { nl: 'trades', en: 'trades' },
  riskOfBalance: { nl: '{{v}}% van saldo', en: '{{v}}% of balance' },
  riskOfPosition: { nl: '{{v}}% van de positie', en: '{{v}}% of the position' },
  turboModeLabel: { nl: '🚀 Turbo modus — hogere hefboom, snellere trades', en: '🚀 Turbo mode — higher leverage, faster trades' },
  turboModeHint: {
    nl: 'Handig bij een kleiner startsaldo: zoekt sneller resolverende setups met een hogere multiplier, binnen dezelfde liquidatie-veiligheidsmarge.',
    en: 'Useful with a smaller starting balance: looks for faster-resolving setups with a higher multiplier, within the same liquidation safety margin.',
  },
  riskBaseRisk: { nl: 'Basis risico / trade (%)', en: 'Base risk / trade (%)' },
  riskMaxRisk: { nl: 'Max risico / trade (%)', en: 'Max risk / trade (%)' },
  riskMinStake: { nl: 'Min. inzet / trade (% van saldo)', en: 'Min. stake / trade (% of balance)' },
  riskMinTradeMargin: { nl: 'Min. trade-inleg ($)', en: 'Min. trade stake ($)' },
  riskTargetStake: { nl: 'Doel inzet / trade (% van saldo)', en: 'Target stake / trade (% of balance)' },
  riskMinConviction: { nl: 'Min. conviction (%)', en: 'Min. conviction (%)' },
  riskHighConviction: {
    nl: 'Hoge-conviction drempel (%)',
    en: 'High-conviction threshold (%)',
  },
  riskMaxLeverage: { nl: 'Max leverage (x)', en: 'Max leverage (x)' },
  riskMaxPositions: { nl: 'Max open posities', en: 'Max open positions' },
  riskMaxSameSidePositions: {
    nl: 'Max posities zelfde richting (Long of Short)',
    en: 'Max same-direction positions (Long or Short)',
  },
  riskOverflowPositions: { nl: 'Extra posities bij hoge conviction', en: 'Extra positions at high conviction' },
  riskMaxMargin: { nl: 'Max margin in gebruik (%)', en: 'Max margin in use (%)' },
  riskStopDrawdown: { nl: 'Stop bij drawdown (%)', en: 'Stop at drawdown (%)' },
  riskDailyLossLimit: { nl: 'Daglimiet verlies (%)', en: 'Daily loss limit (%)' },
  riskTrailArm: { nl: 'Trailing stop wapenen bij (R)', en: 'Arm trailing stop at (R)' },
  riskTrailGiveback: { nl: 'Trailing terugval-marge (%)', en: 'Trailing giveback margin (%)' },
  riskChopPause: { nl: 'Pauzeer na X scans zonder kans', en: 'Pause after X scans without edge' },
  riskTrendFlipPortion: {
    nl: 'Trendwissel-bescherming: % positie afbouwen',
    en: 'Trend-flip protection: % of position to trim',
  },
  riskEntryCooldown: {
    nl: 'Wachttijd tussen trades (minuten, 0 = uit)',
    en: 'Cooldown between trades (minutes, 0 = disabled)',
  },
  trendFlipProtectionLabel: {
    nl: '🛡️ Trendwissel-bescherming — verkoop deel bij trendomkeer',
    en: '🛡️ Trend-flip protection — sell part on trend reversal',
  },
  trendFlipProtectionHint: {
    nl: 'Zodra de markt echt van richting wisselt tegen een open positie, sluit de engine direct een deel ervan om te veel verlies te voorkomen — de rest blijft normaal beheerd door stop-loss, trailing en take-profit.',
    en: 'As soon as the market genuinely turns against an open position, the engine immediately closes part of it to prevent excessive loss — the rest stays under normal stop-loss, trailing and take-profit management.',
  },
  riskRsFilter: { nl: 'Marktleiders filter (Relative Strength vs BTC)', en: 'Market leaders filter (Relative Strength vs BTC)' },
  riskFundingFilter: { nl: 'Funding Rate squeeze-drempel (%)', en: 'Funding Rate squeeze threshold (%)' },
  riskReversal15m: { nl: '15m ommekeer-bevestiging vereist', en: '15m reversal confirmation required' },
  saveRiskSettings: { nl: 'Risico-instellingen opslaan', en: 'Save risk settings' },
  saving: { nl: 'Opslaan…', en: 'Saving…' },
} as const;

/** Every valid translation key. */
export type TranslationKey = keyof typeof DICTIONARY;

type LanguageContextValue = {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return 'nl';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'en' ? 'en' : 'nl';
}

/**
 * Provides the active dashboard language and a `t()` translation function to
 * the component tree. Persists the choice in `localStorage` so it survives a
 * reload, independently per browser — switching language never affects any
 * other visitor of a shared deployment.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(readStoredLanguage);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      const entry = DICTIONARY[key];
      let text: string = entry ? entry[lang] : key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(new RegExp(`{{${name}}}`, 'g'), String(value));
        }
      }
      return text;
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/**
 * Access the active language, the setter, and the `t()` translation function.
 * Must be used within a {@link LanguageProvider}.
 *
 * @returns the current language state and translation helper.
 */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
