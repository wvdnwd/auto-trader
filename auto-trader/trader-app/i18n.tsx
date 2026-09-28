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
  tabHistory: { nl: '📜 Geschiedenis', en: '📜 History' },
  tabBacktest: { nl: 'Backtest', en: 'Backtest' },
  tabWalkforward: { nl: 'Walk-forward', en: 'Walk-forward' },
  tabOptimize: { nl: 'Optimaliseren', en: 'Optimize' },
  tabOptions: { nl: '⚙️ Opties', en: '⚙️ Options' },
  retry: { nl: 'Opnieuw proberen', en: 'Try again' },
  liveWarningTitle: { nl: 'LIVE TRADING — Hyperliquid L1 DEX', en: 'LIVE TRADING — Hyperliquid L1 DEX' },
  liveWarningBody: {
    nl: 'Elke order, stop en take-profit die hieronder verschijnt wordt ook echt op Hyperliquid L1 geplaatst met USDC als onderpand.',
    en: 'Every order, stop and take-profit shown below is placed for real on Hyperliquid L1 using USDC collateral.',
  },
  paperTitle: { nl: 'Hyperliquid koppeling vereist.', en: 'Hyperliquid connection required.' },
  paperBody: {
    nl: 'Koppel je Hyperliquid wallet adres en private key via ⚙️ Opties om live te handelen op de L1 DEX.',
    en: 'Connect your Hyperliquid wallet address and private key via ⚙️ Options to trade live on the L1 DEX.',
  },
  hyperliquidLinkLabel: { nl: 'Hyperliquid-koppeling:', en: 'Hyperliquid connection:' },
  hyperliquidLinkEnabled: {
    nl: 'live order-uitvoering ingeschakeld — de engine plaatst echte orders direct op Hyperliquid L1.',
    en: 'live order execution enabled — the engine places real orders directly on Hyperliquid L1.',
  },
  hyperliquidLinkConfigured: {
    nl: 'Hyperliquid wallet gekoppeld (klaar voor live trading).',
    en: 'Hyperliquid wallet connected (ready for live trading).',
  },
  hyperliquidLinkNone: {
    nl: 'nog niet gekoppeld — voeg je Hyperliquid wallet adres en private key toe zodra je klaar bent voor live uitvoering.',
    en: 'not connected yet — add your Hyperliquid wallet address and private key whenever you are ready for live execution.',
  },
  changeKey: { nl: 'Wallet & sleutel wijzigen', en: 'Change wallet & key' },
  enterOwnKey: { nl: 'Hyperliquid koppelen', en: 'Connect Hyperliquid' },
  placeTestOrderBtn: { nl: 'Testorder plaatsen', en: 'Place test order' },
  enableLive: { nl: 'Schakel live uitvoering in', en: 'Enable live execution' },
  disableLive: { nl: 'Pauzeer live uitvoering', en: 'Pause live execution' },
  enableLiveConfirm: {
    nl: 'Live order-uitvoering INSCHAKELEN? De engine plaatst dan echte orders met USDC op Hyperliquid L1.',
    en: 'ENABLE live order execution? The engine will then place real orders with USDC on Hyperliquid L1.',
  },
  disableLiveConfirm: {
    nl: 'Live order-uitvoering pauzeren?',
    en: 'Pause live order execution?',
  },
  testOrderIntro: {
    nl: 'Plaatst een echte, kleine order rechtstreeks op Hyperliquid L1 (los van de strategie) om te controleren of je wallet orders mag plaatsen en laten vullen. De order wordt na plaatsing direct weer gesloten, tenzij je "open laten staan" aanvinkt.',
    en: 'Places a real, small order directly on Hyperliquid L1 (separate from the strategy) to confirm your wallet can place and fill orders. The order is immediately closed again after placement unless you check "keep open".',
  },
  market: { nl: 'Market', en: 'Market' },
  direction: { nl: 'Richting', en: 'Direction' },
  long: { nl: 'Long', en: 'Long' },
  short: { nl: 'Short', en: 'Short' },
  amountUsdt: { nl: 'Bedrag (USDC)', en: 'Amount (USDC)' },
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
  testOrderLeftOpen: { nl: ' — open gelaten op Hyperliquid L1.', en: ' — left open on Hyperliquid L1.' },
  testOrderConfirm: {
    nl: 'Echte testorder van {{amount}} USDC ({{lev}}x) op {{symbol}} plaatsen op Hyperliquid? Dit gebruikt echt geld.',
    en: 'Place a real test order of {{amount}} USDC ({{lev}}x) on {{symbol}} on Hyperliquid? This uses real money.',
  },
  placeTestOrderAndClose: { nl: 'Plaats testorder & sluit direct', en: 'Place test order & close immediately' },
  close: { nl: 'Sluiten', en: 'Close' },
  cancel: { nl: 'Annuleren', en: 'Cancel' },
  save: { nl: 'Opslaan', en: 'Save' },
  saveAndConnect: { nl: 'Opslaan & koppelen', en: 'Save & connect' },
  removeConnection: { nl: 'Koppeling verwijderen', en: 'Remove connection' },
  removeConnectionConfirm: {
    nl: 'Hyperliquid-koppeling verwijderen?',
    en: 'Remove the Hyperliquid connection?',
  },
  apiKeyLabel: { nl: 'Wallet Adres', en: 'Wallet Address' },
  apiSecretLabel: { nl: 'Private Key', en: 'Private Key' },
  apiKeyFormIntro: {
    nl: 'Vul je Hyperliquid wallet adres (0x...) en private key in voor geautomatiseerde handel via Hyperliquid L1. Gegevens worden veilig bewaard in de lokale database.',
    en: 'Enter your Hyperliquid wallet address (0x...) and private key for automated trading via Hyperliquid L1. Data is safely stored in the local database.',
  },
  howToConnectTitle: { nl: 'Hoe koppel je Hyperliquid L1?', en: 'How to connect Hyperliquid L1' },
  howToConnectStep1: {
    nl: '1. Ga naar app.hyperliquid.xyz en verbind je Web3-wallet (MetaMask, Rabby, etc.).',
    en: '1. Go to app.hyperliquid.xyz and connect your Web3 wallet (MetaMask, Rabby, etc.).',
  },
  howToConnectStep2: {
    nl: '2. Zorg voor USDC op Hyperliquid L1 (stort via Arbitrum of Hyperliquid Bridge).',
    en: '2. Ensure you have USDC on Hyperliquid L1 (deposit via Arbitrum or Hyperliquid Bridge).',
  },
  howToConnectStep3: {
    nl: '3. (Aanbevolen) Maak in app.hyperliquid.xyz onder Settings → API / Agent Wallets een Agent Wallet aan.',
    en: '3. (Recommended) Under Settings → API / Agent Wallets on app.hyperliquid.xyz, create an Agent Wallet.',
  },
  howToConnectStep4: {
    nl: '4. Vul hieronder je Wallet Adres (0x...) en Private Key in.',
    en: '4. Enter your Wallet Address (0x...) and Private Key below.',
  },
  howToConnectStep5: {
    nl: '5. Sla op en doe optioneel een kleine testorder (bv. 10 USDC) om de koppeling te testen.',
    en: '5. Save and optionally place a small test order (e.g. 10 USDC) to verify the connection.',
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
  hyperliquidBalanceError: {
    nl: 'Hyperliquid-saldo kon niet worden opgehaald: {{err}}. Controleer de verbinding met Hyperliquid L1.',
    en: 'Could not fetch Hyperliquid balance: {{err}}. Check the connection with Hyperliquid L1.',
  },
  equity: { nl: 'Equity', en: 'Equity' },
  sinceStart: { nl: '{{v}} sinds start', en: '{{v}} since start' },
  fromHyperliquid: { nl: 'rechtstreeks van Hyperliquid L1', en: 'directly from Hyperliquid L1' },
  freeBalance: { nl: 'Vrij saldo (USDC)', en: 'Free balance (USDC)' },
  inUse: { nl: '{{v}} in gebruik', en: '{{v}} in use' },
  openPnl: { nl: 'Open P&L (USDC)', en: 'Open P&L (USDC)' },
  positionsOpen: { nl: '{{n}} posities open', en: '{{n}} positions open' },
  winRate: { nl: 'Win rate', en: 'Win rate' },
  winLossOf: { nl: '{{w}}W / {{l}}L over {{t}} trades', en: '{{w}}W / {{l}}L of {{t}} trades' },
  profitFactor: { nl: 'Profit factor', en: 'Profit factor' },
  avgOf: { nl: 'gem. {{w}} / {{l}}', en: 'avg. {{w}} / {{l}}' },
  drawdown: { nl: 'Drawdown', en: 'Drawdown' },
  limit: { nl: 'limiet {{v}}', en: 'limit {{v}}' },
  openPositions: { nl: 'Open posities', en: 'Open positions' },
  noOpenPositionsHyperliquid: {
    nl: 'Geen open posities op Hyperliquid — de engine wacht op een setup met genoeg conviction.',
    en: 'No open positions on Hyperliquid — the engine is waiting for a setup with enough conviction.',
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
    nl: 'Live marktdata via Hyperliquid L1 Info API · order execution via Hyperliquid DEX · leverage en positiegrootte worden volledig automatisch bepaald uit volatiliteit en conviction.',
    en: 'Live market data via Hyperliquid L1 Info API · order execution via Hyperliquid DEX · leverage and position size are fully automatic from volatility and conviction.',
  },
  chartLoadFailed: { nl: 'Grafiek laden mislukt: {{err}}', en: 'Failed to load chart: {{err}}' },
  chartLoading: { nl: 'Grafiek laden…', en: 'Loading chart…' },
  connecting: { nl: 'Verbinden met trading engine…', en: 'Connecting to trading engine…' },
  connectFailed: { nl: 'Verbinden mislukt: {{err}}', en: 'Connection failed: {{err}}' },
  apiAuthRequired: {
    nl: 'API-toegang vereist. Voer de TRADER_API_TOKEN van deze installatie in; deze blijft alleen in dit browsertabblad bewaard.',
    en: 'API access required. Enter this installation’s TRADER_API_TOKEN; it is kept only in this browser tab.',
  },
  apiTokenLabel: { nl: 'API-token', en: 'API token' },
  apiTokenSubmit: { nl: 'Verbinden', en: 'Connect' },
  hyperliquidUnavailable: { nl: 'Hyperliquid-gegevens niet beschikbaar', en: 'Hyperliquid data unavailable' },
  hyperliquidPositionsUnavailable: {
    nl: 'Open Hyperliquid-posities zijn niet beschikbaar zolang de exchange-read mislukt.',
    en: 'Open Hyperliquid positions are unavailable while the exchange read is failing.',
  },
  shareTitle: { nl: 'Beveiligde dashboardtoegang', en: 'Protected dashboard access' },
  shareBody: {
    nl: 'Dit is één beschermde installatie: geautoriseerde operators zien hetzelfde account en dezelfde instellingen. Deel de API-token niet en publiceer de server niet rechtstreeks via HTTP.',
    en: 'This is one protected installation: authorized operators share the same account and settings. Do not share the API token or expose the server directly over HTTP.',
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
