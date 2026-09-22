import { useEffect, useState } from 'react';
import styles from './trader-app.module.css';
import { useLanguage } from './i18n.js';
import type { TranslationKey } from './i18n.js';
import type { RiskConfig } from './types.js';

export type RiskPanelProps = {
  /** Current risk configuration from the engine. */
  risk: RiskConfig;
  /** Persist changed settings to the engine. */
  onSave: (patch: Partial<RiskConfig>) => Promise<void> | void;
};

type FieldDef = { key: keyof RiskConfig; labelKey: TranslationKey; step: number; percent?: boolean };

/** Fields rendered as swipeable range sliders instead of plain number inputs. */
type SliderDef = {
  key: keyof RiskConfig;
  labelKey: TranslationKey;
  min: number;
  max: number;
  step: number;
  percent?: boolean;
};

type HelpInfo = {
  title: string;
  desc: string;
  example?: string;
};

const HELP_TEXTS: Record<string, HelpInfo> = {
  baseRiskPct: {
    title: 'Basis risico / trade (%)',
    desc: 'Het percentage van je totale saldo dat je maximaal verliest als een standaard positie op de stop-loss uitstapt.',
    example: 'Bij 2% en €1.000 saldo riskeer je max. €20 per trade. De bot berekent aan de hand van de afstand tot de stop-loss automatisch de juiste positiegrootte.',
  },
  maxRiskPct: {
    title: 'Max risico / trade (%)',
    desc: 'Het absolute maximum verliespercentage per trade voor signalen met een uitzonderlijk hoge zekerheid (conviction).',
    example: 'Bij topsignalen schaalt de bot het risico dynamisch op tussen het basisrisico (bijv. 2%) en dit maximum (bijv. 3,5%), maar gaat er nooit overheen.',
  },
  minStakePct: {
    title: 'Min. inzet / trade (% van saldo)',
    desc: 'De minimale eigen inleg (margin) die per trade gebruikt moet worden, als percentage van je saldo.',
    example: 'Bij 12% en €300 saldo zet de bot minimaal €36 eigen margin in. Dit voorkomt te kleine posities die door transactiekosten (fees) worden uitgehold.',
  },
  minTradeMarginUsdt: {
    title: 'Min. trade-inleg ($)',
    desc: 'De absolute minimale eigen inleg (margin) per trade in USDT/EUR. Voorkomt dat de bot te kleine trades opent als er weinig saldo vrij is of bij volatiele munten.',
    example: 'Bij 35 opent de bot nooit een trade kleiner dan $35. Heeft de bot minder vrij saldo, dan wacht hij tot een eerdere trade sluit.',
  },
  minConfidence: {
    title: 'Min. conviction (%)',
    desc: 'De minimale kwaliteitsscore die het signaalmodel moet toekennen aan een setup voordat de bot een trade mag openen.',
    example: 'Bij 55% worden alle signalen onder de 55% overgeslagen. Hoe hoger deze drempel, hoe selectiever de bot handelt.',
  },
  highConvictionConfidence: {
    title: 'Hoge-conviction drempel (%)',
    desc: 'De scoregrens waarbij een signaal als een "topkans" wordt aangemerkt.',
    example: 'Boven deze drempel (bijv. 70%) mag de bot extra risico nemen (richting Max risico) en eventueel extra overflow-posities openen als de portefeuille vol zit.',
  },
  maxLeverage: {
    title: 'Max leverage (x)',
    desc: 'Het absolute hefboom-plafond dat de bot mag instellen op MEXC Futures.',
    example: 'Bij 12x zal de bot voor altcoins nooit meer dan 12x hefboom kiezen, zelfs niet bij een strakke stop-loss. Dit beschermt tegen plotselinge liquidaties door uitschieters (wicks).',
  },
  maxOverflowPositions: {
    title: 'Extra posities bij hoge conviction',
    desc: 'Het aantal extra trades dat bovenop het standaard maximum mag worden geopend, uitsluitend voor setups die de hoge-conviction drempel halen.',
    example: 'Staat dit op 2 en heb je al 10 posities open, dan mag een 70%+ setup toch als 11e of 12e trade openen.',
  },
  maxTotalMarginPct: {
    title: 'Max margin in gebruik (%)',
    desc: 'Het percentage van je saldo dat maximaal tegelijkertijd vast mag zitten in open posities (margin).',
    example: 'Bij 95% houdt de bot altijd minimaal 5% vrij saldo achter de hand als buffer voor financieringskosten, fees en marktschommelingen.',
  },
  maxDrawdownPct: {
    title: 'Stop bij drawdown (%)',
    desc: 'De algehele noodrem: als je totale accountwaarde daalt met dit percentage vanaf de all-time piek, stopt de bot direct met nieuwe trades.',
    example: 'Bij 25% bevriest de trading zodra je saldo 25% onder de piek zakt, om ernstige marktcrashes te overleven.',
  },
  dailyLossLimitPct: {
    title: 'Daglimiet verlies (%)',
    desc: 'Het maximale verlies dat binnen 24 uur gemaakt mag worden (gerealiseerd + ongerealiseerd).',
    example: 'Bij 8% worden alle nieuwe entries voor de rest van de dag geblokkeerd zodra er op die dag 8% verlies is geleden.',
  },
  trailArmR: {
    title: 'Trailing stop wapenen bij (R)',
    desc: 'De winst (uitgedrukt in R = aantal keren je initiële stop-loss afstand) die bereikt moet worden voordat de dynamische trailing stop actief wordt.',
    example: 'Bij 1.8R wordt de trailing stop geactiveerd zodra de trade 1,8x je risico aan winst heeft bereikt (bijv. €36 winst bij €20 risico).',
  },
  trailGiveback: {
    title: 'Trailing terugval-marge (%)',
    desc: 'Hoeveel procent van de behaalde piek-winst de koers mag inleveren voordat de trailing stop de positie definitief sluit.',
    example: 'Bij 75% mag de koers corrigeren; valt hij verder terug dan de ingestelde marge, dan pakt de bot direct de resterende winst.',
  },
  chopPauseStreak: {
    title: 'Pauzeer na X scans zonder kans',
    desc: 'Bescherming tegen zijwaartse, saaie markten zonder duidelijke trend (chop).',
    example: 'Als er na X opeenvolgende scans nergens in de markt een signaal boven de minimum conviction te vinden is, pauzeert de bot automatisch nieuwe entries tot de markt weer beweegt.',
  },
  maxOpenPositions: {
    title: 'Max open posities',
    desc: 'Het maximum aantal posities dat tegelijk open mag staan en nog risico loopt.',
    example: 'Trades die TP1 bereiken zijn risicovrij (stop op break-even) en maken hun slot direct vrij voor nieuwe kansen.',
  },
  maxSameSidePositions: {
    title: 'Max posities zelfde richting',
    desc: 'Het maximale aantal gelijktijdige Long óf Short posities.',
    example: 'Voorkomt dat je portfolio te zwaar inzet op één marktzijde (bijv. 10 longs) als de markt plotseling draait.',
  },
  entryCooldownMinutes: {
    title: 'Wachttijd tussen trades (pacing)',
    desc: 'Een afkoelperiode (in minuten) tussen nieuwe posities.',
    example: 'Voorkomt dat de bot tijdens een plotselinge marktpiek binnen enkele seconden al je slots vult met gecorreleerde munten.',
  },
  targetStakePct: {
    title: 'Doel inzet / trade (% van saldo)',
    desc: 'Het streefinzetpercentage van je eigen saldo per positie.',
    example: 'De bot berekent aan de hand van je risico en dit streefpercentage de meest efficiënte hefboom (leverage).',
  },
  trendFlipTrimPortion: {
    title: 'Trendwissel-bescherming: % positie afbouwen',
    desc: 'Het percentage van de positie dat direct wordt gesloten zodra de markttrend van richting verandert tegen je positie in.',
    example: 'Bij 50% wordt direct de helft van de positie verkocht als de 1u/4u trend omdraait, terwijl de rest door stop-loss en trailing beheerd blijft.',
  },
  turboMode: {
    title: 'Turbo modus',
    desc: 'Zoekt snellere intraday setups met een hogere hefboom binnen veilige liquidatiemarges.',
    example: 'Ideaal om een kleiner startsaldo sneller op te bouwen door sneller resolverende trades te pakken.',
  },
  trendFlipProtection: {
    title: 'Trendwissel-bescherming',
    desc: 'Schakelt de automatische gedeeltelijke verkoop in zodra de markt echt van richting wisselt tegen een open positie.',
    example: 'Voorkomt dat een gezonde winstgevende of neutrale positie verandert in een vol verlies als de markttrend abrupt omslaat.',
  },
  rsFilterEnabled: {
    title: 'Marktleiders filter (Relative Strength)',
    desc: 'Vergelijkt de 24u prestatie van de munt met Bitcoin. Voorkomt instappen in achterblijvers wanneer Bitcoin stijgt.',
    example: 'Als Bitcoin +3% stijgt en een altcoin staat op -1%, slaat de bot deze altcoin over. Hij stapt alleen in munten die sterker presteren dan BTC.',
  },
  maxFundingRateLong: {
    title: 'Funding Rate squeeze-drempel (%)',
    desc: 'De maximale rentevergoeding waarbij een Long positie nog geopend mag worden. Voorkomt instappen in overbevolkte markten die kwetsbaar zijn voor een long squeeze.',
    example: 'Bij 0,05% worden longs geblokkeerd als de rente hoger is dan 0,05% per 8 uur (te veel longs in de markt).',
  },
  reversal15mRequired: {
    title: '15m ommekeer-bevestiging',
    desc: 'Voorkomt het vangen van een vallend mes. De bot wacht bij een pullback tot de 15m candle groen sluit of een duidelijke kopers-wick (hammer) toont.',
    example: 'Als de koers op de 15m grafiek hard omlaag dendert, wacht de bot tot kopers de dip opkopen voordat de trade opent.',
  },
};

const SLIDERS: SliderDef[] = [
  { key: 'maxOpenPositions', labelKey: 'riskMaxPositions', min: 1, max: 20, step: 1 },
  { key: 'maxSameSidePositions', labelKey: 'riskMaxSameSidePositions', min: 1, max: 20, step: 1 },
  { key: 'entryCooldownMinutes', labelKey: 'riskEntryCooldown', min: 0, max: 60, step: 1 },
  { key: 'targetStakePct', labelKey: 'riskTargetStake', min: 2, max: 100, step: 1, percent: true },
  { key: 'trendFlipTrimPortion', labelKey: 'riskTrendFlipPortion', min: 10, max: 90, step: 5, percent: true },
];

const FIELDS: FieldDef[] = [
  { key: 'baseRiskPct', labelKey: 'riskBaseRisk', step: 0.1, percent: true },
  { key: 'maxRiskPct', labelKey: 'riskMaxRisk', step: 0.1, percent: true },
  { key: 'minStakePct', labelKey: 'riskMinStake', step: 1, percent: true },
  { key: 'minTradeMarginUsdt', labelKey: 'riskMinTradeMargin', step: 5 },
  { key: 'minConfidence', labelKey: 'riskMinConviction', step: 1, percent: true },
  { key: 'highConvictionConfidence', labelKey: 'riskHighConviction', step: 1, percent: true },
  { key: 'maxLeverage', labelKey: 'riskMaxLeverage', step: 1 },
  { key: 'maxOverflowPositions', labelKey: 'riskOverflowPositions', step: 1 },
  { key: 'maxTotalMarginPct', labelKey: 'riskMaxMargin', step: 5, percent: true },
  { key: 'maxDrawdownPct', labelKey: 'riskStopDrawdown', step: 1, percent: true },
  { key: 'dailyLossLimitPct', labelKey: 'riskDailyLossLimit', step: 1, percent: true },
  { key: 'trailArmR', labelKey: 'riskTrailArm', step: 0.1 },
  { key: 'trailGiveback', labelKey: 'riskTrailGiveback', step: 5, percent: true },
  { key: 'chopPauseStreak', labelKey: 'riskChopPause', step: 1 },
  { key: 'maxFundingRateLong', labelKey: 'riskFundingFilter', step: 0.01, percent: true },
];

/**
 * Editable risk settings — the guardrails the engine sizes every trade against.
 */
export function RiskPanel({ risk, onSave }: RiskPanelProps) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [turbo, setTurbo] = useState(false);
  const [trendFlipProtection, setTrendFlipProtection] = useState(true);
  const [rsFilter, setRsFilter] = useState(true);
  const [reversal15m, setReversal15m] = useState(true);
  const [pullbackFilter, setPullbackFilter] = useState(true);
  const [breakoutBypass, setBreakoutBypass] = useState(true);
  const [dynamicRunners, setDynamicRunners] = useState(true);
  const [btcChopFilter, setBtcChopFilter] = useState(true);
  const [pauseNewEntries, setPauseNewEntries] = useState(false);
  const [mssProtection, setMssProtection] = useState(true);
  const [premiumDiscountFilter, setPremiumDiscountFilter] = useState(true);
  const [imbalanceScalp, setImbalanceScalp] = useState(true);
  const [ltfSniper5m, setLtfSniper5m] = useState(true);
  const [smtFilter, setSmtFilter] = useState(true);
  const [volumeProfile, setVolumeProfile] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [openHelp, setOpenHelp] = useState<string | null>(null);

  useEffect(() => {
    // Prevent background snapshot polling from overwriting user's active changes
    if (isDirty) return;

    const next: Record<string, number> = {};
    for (const f of FIELDS) {
      const raw = risk[f.key] as number;
      next[f.key] = f.percent ? Number((raw * 100).toFixed(2)) : raw;
    }
    for (const s of SLIDERS) {
      const raw = risk[s.key] as number;
      next[s.key] = s.percent ? Number((raw * 100).toFixed(2)) : raw;
    }
    setDraft(next);
    setTurbo(Boolean(risk.turboMode));
    setTrendFlipProtection(risk.trendFlipProtection !== false);
    setRsFilter(Boolean(risk.rsFilterEnabled));
    setReversal15m(risk.reversal15mRequired !== false);
    setPullbackFilter(risk.pullbackFilterEnabled !== false);
    setBreakoutBypass(risk.breakoutBypassEnabled !== false);
    setDynamicRunners(risk.dynamicRunnersEnabled !== false);
    setBtcChopFilter(risk.btcChopFilterEnabled !== false);
    setPauseNewEntries(Boolean(risk.pauseNewEntries));
    setMssProtection(risk.mssProtectionEnabled !== false);
    setPremiumDiscountFilter(risk.premiumDiscountFilterEnabled !== false);
    setImbalanceScalp(risk.imbalanceScalpEnabled !== false);
    setLtfSniper5m(risk.ltfSniper5mEnabled !== false);
    setSmtFilter(risk.smtFilterEnabled !== false);
    setVolumeProfile(risk.volumeProfileEnabled !== false);
  }, [risk, isDirty]);

  const save = async () => {
    setSaving(true);
    const patch: Partial<RiskConfig> = {};
    for (const f of FIELDS) {
      const value = draft[f.key];
      if (!Number.isFinite(value)) continue;
      (patch as Record<string, number>)[f.key] = f.percent ? value / 100 : value;
    }
    for (const s of SLIDERS) {
      const value = draft[s.key];
      if (!Number.isFinite(value)) continue;
      (patch as Record<string, number>)[s.key] = s.percent ? value / 100 : value;
    }
    (patch as Record<string, boolean>).turboMode = turbo;
    (patch as Record<string, boolean>).trendFlipProtection = trendFlipProtection;
    (patch as Record<string, boolean>).rsFilterEnabled = rsFilter;
    (patch as Record<string, boolean>).reversal15mRequired = reversal15m;
    (patch as Record<string, boolean>).pullbackFilterEnabled = pullbackFilter;
    (patch as Record<string, boolean>).breakoutBypassEnabled = breakoutBypass;
    (patch as Record<string, boolean>).dynamicRunnersEnabled = dynamicRunners;
    (patch as Record<string, boolean>).btcChopFilterEnabled = btcChopFilter;
    (patch as Record<string, boolean>).pauseNewEntries = pauseNewEntries;
    (patch as Record<string, boolean>).mssProtectionEnabled = mssProtection;
    (patch as Record<string, boolean>).premiumDiscountFilterEnabled = premiumDiscountFilter;
    (patch as Record<string, boolean>).imbalanceScalpEnabled = imbalanceScalp;
    (patch as Record<string, boolean>).ltfSniper5mEnabled = ltfSniper5m;
    (patch as Record<string, boolean>).smtFilterEnabled = smtFilter;
    (patch as Record<string, boolean>).volumeProfileEnabled = volumeProfile;
    try {
      await onSave(patch);
      setIsDirty(false);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3500);
    } finally {
      setSaving(false);
    }
  };

  const resetDraft = () => {
    const next: Record<string, number> = {};
    for (const f of FIELDS) {
      const raw = risk[f.key] as number;
      next[f.key] = f.percent ? Number((raw * 100).toFixed(2)) : raw;
    }
    for (const s of SLIDERS) {
      const raw = risk[s.key] as number;
      next[s.key] = s.percent ? Number((raw * 100).toFixed(2)) : raw;
    }
    setDraft(next);
    setTurbo(Boolean(risk.turboMode));
    setTrendFlipProtection(risk.trendFlipProtection !== false);
    setRsFilter(Boolean(risk.rsFilterEnabled));
    setReversal15m(risk.reversal15mRequired !== false);
    setPullbackFilter(risk.pullbackFilterEnabled !== false);
    setBreakoutBypass(risk.breakoutBypassEnabled !== false);
    setDynamicRunners(risk.dynamicRunnersEnabled !== false);
    setBtcChopFilter(risk.btcChopFilterEnabled !== false);
    setPauseNewEntries(Boolean(risk.pauseNewEntries));
    setMssProtection(risk.mssProtectionEnabled !== false);
    setPremiumDiscountFilter(risk.premiumDiscountFilterEnabled !== false);
    setImbalanceScalp(risk.imbalanceScalpEnabled !== false);
    setLtfSniper5m(risk.ltfSniper5mEnabled !== false);
    setSmtFilter(risk.smtFilterEnabled !== false);
    setVolumeProfile(risk.volumeProfileEnabled !== false);
    setIsDirty(false);
  };

  const format = (s: SliderDef, raw: number) => {
    if (s.key === 'maxOpenPositions' || s.key === 'maxSameSidePositions') {
      return `${raw} ${raw === 1 ? t('riskTradeSingular') : t('riskTradePlural')}`;
    }
    if (s.key === 'entryCooldownMinutes') return raw === 0 ? 'Direct (0 min)' : `${raw} min`;
    if (s.key === 'trendFlipTrimPortion') return t('riskOfPosition', { v: raw });
    if (s.percent) return t('riskOfBalance', { v: raw });
    return String(raw);
  };

  return (
    <div className={styles.form}>
      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="turboMode" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="turboMode"
              type="checkbox"
              checked={turbo}
              onChange={(e) => {
                setTurbo(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              {t('turboModeLabel')}
              <small>{t('turboModeHint')}</small>
            </span>
          </label>
          <button
            type="button"
            className={`${styles.helpBtn} ${openHelp === 'turboMode' ? styles.helpBtnActive : ''}`}
            onClick={() => setOpenHelp(openHelp === 'turboMode' ? null : 'turboMode')}
            title="Uitleg bekijken"
            aria-label="Uitleg voor Turbo modus"
          >
            ?
          </button>
        </div>
        {openHelp === 'turboMode' && HELP_TEXTS.turboMode && (
          <div className={styles.helpBox}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS.turboMode.title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS.turboMode.desc}</p>
            {HELP_TEXTS.turboMode.example && (
              <p className={styles.helpExample}><b>Voorbeeld:</b> {HELP_TEXTS.turboMode.example}</p>
            )}
          </div>
        )}
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="trendFlipProtection" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="trendFlipProtection"
              type="checkbox"
              checked={trendFlipProtection}
              onChange={(e) => {
                setTrendFlipProtection(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              {t('trendFlipProtectionLabel')}
              <small>{t('trendFlipProtectionHint')}</small>
            </span>
          </label>
          <button
            type="button"
            className={`${styles.helpBtn} ${openHelp === 'trendFlipProtection' ? styles.helpBtnActive : ''}`}
            onClick={() => setOpenHelp(openHelp === 'trendFlipProtection' ? null : 'trendFlipProtection')}
            title="Uitleg bekijken"
            aria-label="Uitleg voor Trendwissel-bescherming"
          >
            ?
          </button>
        </div>
        {openHelp === 'trendFlipProtection' && HELP_TEXTS.trendFlipProtection && (
          <div className={styles.helpBox}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS.trendFlipProtection.title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS.trendFlipProtection.desc}</p>
            {HELP_TEXTS.trendFlipProtection.example && (
              <p className={styles.helpExample}><b>Voorbeeld:</b> {HELP_TEXTS.trendFlipProtection.example}</p>
            )}
          </div>
        )}
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="rsFilter" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="rsFilter"
              type="checkbox"
              checked={rsFilter}
              onChange={(e) => {
                setRsFilter(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              {t('riskRsFilter')}
              <small>Alleen altcoin longs die minstens gelijke tred houden met Bitcoin (voorkomt trage achterblijvers).</small>
            </span>
          </label>
          <button
            type="button"
            className={`${styles.helpBtn} ${openHelp === 'rsFilterEnabled' ? styles.helpBtnActive : ''}`}
            onClick={() => setOpenHelp(openHelp === 'rsFilterEnabled' ? null : 'rsFilterEnabled')}
            title="Uitleg bekijken"
            aria-label="Uitleg voor Marktleiders filter"
          >
            ?
          </button>
        </div>
        {openHelp === 'rsFilterEnabled' && HELP_TEXTS.rsFilterEnabled && (
          <div className={styles.helpBox}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS.rsFilterEnabled.title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS.rsFilterEnabled.desc}</p>
            {HELP_TEXTS.rsFilterEnabled.example && (
              <p className={styles.helpExample}><b>Voorbeeld:</b> {HELP_TEXTS.rsFilterEnabled.example}</p>
            )}
          </div>
        )}
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="reversal15m" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="reversal15m"
              type="checkbox"
              checked={reversal15m}
              onChange={(e) => {
                setReversal15m(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              {t('riskReversal15m')}
              <small>Wacht op een groene 15m candle of kopers-hammer wick (nooit een vallend mes vangen).</small>
            </span>
          </label>
          <button
            type="button"
            className={`${styles.helpBtn} ${openHelp === 'reversal15mRequired' ? styles.helpBtnActive : ''}`}
            onClick={() => setOpenHelp(openHelp === 'reversal15mRequired' ? null : 'reversal15mRequired')}
            title="Uitleg bekijken"
            aria-label="Uitleg voor 15m ommekeer-bevestiging"
          >
            ?
          </button>
        </div>
        {openHelp === 'reversal15mRequired' && HELP_TEXTS.reversal15mRequired && (
          <div className={styles.helpBox}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS.reversal15mRequired.title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS.reversal15mRequired.desc}</p>
            {HELP_TEXTS.reversal15mRequired.example && (
              <p className={styles.helpExample}><b>Voorbeeld:</b> {HELP_TEXTS.reversal15mRequired.example}</p>
            )}
          </div>
        )}
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="pullbackFilter" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="pullbackFilter"
              type="checkbox"
              checked={pullbackFilter}
              onChange={(e) => {
                setPullbackFilter(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              🎯 Sniper Pullback Filter
              <small>Wacht op dip naar EMA21 of Fibonacci golden zone — trad nooit op de top.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="breakoutBypass" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="breakoutBypass"
              type="checkbox"
              checked={breakoutBypass}
              onChange={(e) => {
                setBreakoutBypass(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              🚀 Breakout Momentum Bypass
              <small>Direct instappen bij uitzonderlijke volume-explosies (≥ 1.8x) zonder te wachten op een dip.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="dynamicRunners" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="dynamicRunners"
              type="checkbox"
              checked={dynamicRunners}
              onChange={(e) => {
                setDynamicRunners(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              📈 Dynamische Runners (5.0R)
              <small>Verhoogt de runner-winstdoelen naar 5.0R op sterke altcoin uitbraken na het veiligstellen van TP1.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="btcChopFilter" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="btcChopFilter"
              type="checkbox"
              checked={btcChopFilter}
              onChange={(e) => {
                setBtcChopFilter(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              🛡️ Bitcoin Chop Filter
              <small>Pauzeert nieuwe altcoin trades wanneer Bitcoin in een zijwaartse consolidatie (CHOP) zit om valse uitbraken te vermijden.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="pauseNewEntries" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="pauseNewEntries"
              type="checkbox"
              checked={pauseNewEntries}
              onChange={(e) => {
                setPauseNewEntries(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              ⏸️ Standby Modus (Geen nieuwe trades)
              <small>Pauzeert het openen van nieuwe posities onmiddellijk, terwijl alle lopende posities (TP, SL, trailing) actief beheerd blijven.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="mssProtection" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="mssProtection"
              type="checkbox"
              checked={mssProtection}
              onChange={(e) => {
                setMssProtection(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              🔄 Marktstructuur-bescherming (MSS / CHoCH)
              <small>Sluit openstaande trades direct bij een officiële trendbreuk (candle body close door Higher Low / Lower High) om verlies te voorkomen.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="premiumDiscountFilter" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="premiumDiscountFilter"
              type="checkbox"
              checked={premiumDiscountFilter}
              onChange={(e) => {
                setPremiumDiscountFilter(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              ⚖️ Premium vs. Discount Filter (50% Equilibrium)
              <small>Blokkeert LONGs in de dure Premium zone (&gt;50%) en SHORTs in de Discount zone (&lt;50%). Nooit meer kopen op de top!</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="imbalanceScalp" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="imbalanceScalp"
              type="checkbox"
              checked={imbalanceScalp}
              onChange={(e) => {
                setImbalanceScalp(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              🎯 Imbalance / Golden Zone Scalps
              <small>Snelle trades naar de Fair Value Gap (FVG) of Fibonacci 0.618 na een liquiditeits-sweep, met strakke stop en hoge Risk/Reward.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="ltfSniper5m" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="ltfSniper5m"
              type="checkbox"
              checked={ltfSniper5m}
              onChange={(e) => {
                setLtfSniper5m(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              🎯 5-Minuten Sniper Trigger (LTF)
              <small>Controleert vlak voor instap of de 5m micro-ommekeer is ingezet (groene candle / hammer wick). Voorkomt vangen van een vallend mes.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="smtFilter" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="smtFilter"
              type="checkbox"
              checked={smtFilter}
              onChange={(e) => {
                setSmtFilter(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              ⚡ SMT Divergentie Filter (Smart Money Technique vs. BTC)
              <small>Vergelijkt swing highs en swing lows tussen altcoins en Bitcoin om verborgen institutionele accumulatie of distributie te detecteren.</small>
            </span>
          </label>
        </div>
      </div>

      <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor="volumeProfile" className={styles.turboLabel} style={{ flex: 1 }}>
            <input
              id="volumeProfile"
              type="checkbox"
              checked={volumeProfile}
              onChange={(e) => {
                setVolumeProfile(e.target.checked);
                setIsDirty(true);
              }}
            />
            <span>
              📊 Volume Profile & Point of Control (POC)
              <small>Berekent Point of Control (piekvolume) en Value Area (70% zone). Gebruikt POC als koersmagneet en steun/weerstand.</small>
            </span>
          </label>
        </div>
      </div>

      {SLIDERS.map((s) => (
        <div key={s.key} className={styles.field} style={{ gridColumn: '1 / -1' }}>
          <div className={styles.fieldHeader}>
            <label htmlFor={s.key}>
              {t(s.labelKey)} — <strong>{format(s, draft[s.key] ?? s.min)}</strong>
            </label>
            <button
              type="button"
              className={`${styles.helpBtn} ${openHelp === s.key ? styles.helpBtnActive : ''}`}
              onClick={() => setOpenHelp(openHelp === s.key ? null : s.key)}
              title="Uitleg bekijken"
              aria-label={`Uitleg voor ${t(s.labelKey)}`}
            >
              ?
            </button>
          </div>
          {openHelp === s.key && HELP_TEXTS[s.key] && (
            <div className={styles.helpBox}>
              <span className={styles.helpTitle}>💡 {HELP_TEXTS[s.key].title}</span>
              <p className={styles.helpDesc}>{HELP_TEXTS[s.key].desc}</p>
              {HELP_TEXTS[s.key].example && (
                <p className={styles.helpExample}><b>Voorbeeld:</b> {HELP_TEXTS[s.key].example}</p>
              )}
            </div>
          )}
          <input
            id={s.key}
            type="range"
            className={styles.slider}
            min={s.min}
            max={s.max}
            step={s.step}
            value={draft[s.key] ?? s.min}
            onChange={(e) => {
              setDraft((d) => ({ ...d, [s.key]: Number(e.target.value) }));
              setIsDirty(true);
            }}
          />
          <div className={styles.sliderScale}>
            <span>{s.percent ? `${s.min}%` : s.min}</span>
            <span>{s.percent ? `${s.max}%` : s.max}</span>
          </div>
        </div>
      ))}

      {FIELDS.map((f) => (
        <div key={f.key} className={styles.field}>
          <div className={styles.fieldHeader}>
            <label htmlFor={f.key}>{t(f.labelKey)}</label>
            <button
              type="button"
              className={`${styles.helpBtn} ${openHelp === f.key ? styles.helpBtnActive : ''}`}
              onClick={() => setOpenHelp(openHelp === f.key ? null : f.key)}
              title="Uitleg bekijken"
              aria-label={`Uitleg voor ${t(f.labelKey)}`}
            >
              ?
            </button>
          </div>
          {openHelp === f.key && HELP_TEXTS[f.key] && (
            <div className={styles.helpBox}>
              <span className={styles.helpTitle}>💡 {HELP_TEXTS[f.key].title}</span>
              <p className={styles.helpDesc}>{HELP_TEXTS[f.key].desc}</p>
              {HELP_TEXTS[f.key].example && (
                <p className={styles.helpExample}><b>Voorbeeld:</b> {HELP_TEXTS[f.key].example}</p>
              )}
            </div>
          )}
          <input
            id={f.key}
            type="number"
            step={f.step}
            value={draft[f.key] ?? ''}
            onChange={(e) => {
              setDraft((d) => ({ ...d, [f.key]: Number(e.target.value) }));
              setIsDirty(true);
            }}
          />
        </div>
      ))}

      <div className={styles.formActions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={save}
          disabled={saving || !isDirty}
        >
          {saving ? t('saving') : isDirty ? '💾 ' + t('saveRiskSettings') : '✓ ' + t('saveRiskSettings')}
        </button>
        {isDirty && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={resetDraft}
            disabled={saving}
          >
            Herstellen
          </button>
        )}
        {isDirty && (
          <span className={styles.dirtyBadge}>
            ⚠️ Niet-opgeslagen wijzigingen
          </span>
        )}
        {savedSuccess && (
          <span className={styles.saveNotice}>
            ✓ Instellingen succesvol opgeslagen!
          </span>
        )}
      </div>
    </div>
  );
}
