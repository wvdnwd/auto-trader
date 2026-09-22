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
  pullbackFilter: {
    title: 'Sniper Pullback Filter',
    desc: 'Wacht op dip naar de EMA21 of Fibonacci Golden Zone (0.618 - 0.65) voordat er wordt ingestapt.',
    example: 'Voorkomt kopen na een grote groene candle op de top van een beweging.',
  },
  breakoutBypass: {
    title: 'Breakout Momentum Bypass',
    desc: 'Staat directe instap toe bij een explosieve volume-uitbraak (≥ 1.8x volume) zonder op een pullback te wachten.',
    example: 'Handig bij nieuws of sterke pumps waar de koers in één rechte lijn doorstoot.',
  },
  dynamicRunners: {
    title: 'Dynamische Runners (5.0R)',
    desc: 'Verhoogt het uiteindelijke winstdoel van de runner-portie naar 5.0R bij sterke altcoin-trends.',
    example: 'Zodra TP1 is gehaald en stop op break-even staat, laat de bot de rest van de trade veel langer lopen voor maximale winst.',
  },
  btcChopFilter: {
    title: 'Bitcoin Chop Filter',
    desc: 'Pauzeert nieuwe altcoin posities wanneer Bitcoin zich in een zijwaartse consolidatie (CHOP) bevindt.',
    example: 'Voorkomt dat altcoins worden meegetrokken in valse uitbraken zolang BTC richtingloos is.',
  },
  pauseNewEntries: {
    title: 'Standby Modus',
    desc: 'Pauzeert het openen van nieuwe posities onmiddellijk, terwijl alle lopende posities actief beheerd blijven.',
    example: 'Gebruik dit tijdens grote macro-economische events (zoals CPI of rentebesluiten) of wanneer je de bot tijdelijk wilt laten uitfaseren.',
  },
  mssProtection: {
    title: 'Marktstructuur-bescherming (MSS / CHoCH)',
    desc: 'Sluit trades direct bij een officiële trendbreuk (Market Structure Shift / Change of Character).',
    example: 'Als een Long positie openstaat en een 15m candle sluit ónder de meest recente swing low, sluit de bot direct om winst vast te houden of verlies te beperken.',
  },
  premiumDiscountFilter: {
    title: 'Premium vs. Discount Filter',
    desc: 'Zorgt ervoor dat Longs alleen worden geopend in de Discount zone (<50% van de swing range) en Shorts in Premium (>50%).',
    example: 'Koopt goedkoop in de onderste helft en verkoopt duur in de bovenste helft.',
  },
  imbalanceScalp: {
    title: 'Imbalance / Golden Zone Scalps',
    desc: 'Detecteert liquiditeits-sweeps en opent trades gericht op het vullen van Fair Value Gaps (FVG).',
    example: 'Snelle intraday setups met een strakke stop-loss onder de sweep wick.',
  },
  ltfSniper5m: {
    title: '5-Minuten Sniper Trigger',
    desc: 'Controleert op de 5-minuten grafiek of de dip daadwerkelijk afremt met een groene candle of hammer.',
    example: 'Verfijnt de instap tot op de minuut zodat je niet instapt terwijl de koers nog hard omlaag glijdt.',
  },
  smtFilter: {
    title: 'SMT Divergentie Filter',
    desc: 'Vergelijkt swing highs/lows tussen de altcoin en BTC om Smart Money accumulatie of distributie te spotten.',
    example: 'Als BTC een lower low maakt maar de altcoin een higher low, toont de altcoin verborgen koperskracht (bullish SMT).',
  },
  volumeProfile: {
    title: 'Volume Profile & POC',
    desc: 'Berekent het Point of Control (prijsniveau met het meeste handelsvolume) en Value Area.',
    example: 'Gebruikt de POC als magneet voor take-profit en sterke steun/weerstand voor stop-loss.',
  },
};

const SLIDER_DEFS: Record<string, SliderDef> = {
  maxOpenPositions: { key: 'maxOpenPositions', labelKey: 'riskMaxPositions', min: 1, max: 20, step: 1 },
  maxSameSidePositions: { key: 'maxSameSidePositions', labelKey: 'riskMaxSameSidePositions', min: 1, max: 20, step: 1 },
  entryCooldownMinutes: { key: 'entryCooldownMinutes', labelKey: 'riskEntryCooldown', min: 0, max: 60, step: 1 },
  targetStakePct: { key: 'targetStakePct', labelKey: 'riskTargetStake', min: 2, max: 100, step: 1, percent: true },
  trendFlipTrimPortion: { key: 'trendFlipTrimPortion', labelKey: 'riskTrendFlipPortion', min: 10, max: 90, step: 5, percent: true },
};

const FIELD_DEFS: Record<string, FieldDef> = {
  baseRiskPct: { key: 'baseRiskPct', labelKey: 'riskBaseRisk', step: 0.1, percent: true },
  maxRiskPct: { key: 'maxRiskPct', labelKey: 'riskMaxRisk', step: 0.1, percent: true },
  minStakePct: { key: 'minStakePct', labelKey: 'riskMinStake', step: 1, percent: true },
  minTradeMarginUsdt: { key: 'minTradeMarginUsdt', labelKey: 'riskMinTradeMargin', step: 5 },
  minConfidence: { key: 'minConfidence', labelKey: 'riskMinConviction', step: 1, percent: true },
  highConvictionConfidence: { key: 'highConvictionConfidence', labelKey: 'riskHighConviction', step: 1, percent: true },
  maxLeverage: { key: 'maxLeverage', labelKey: 'riskMaxLeverage', step: 1 },
  maxOverflowPositions: { key: 'maxOverflowPositions', labelKey: 'riskOverflowPositions', step: 1 },
  maxTotalMarginPct: { key: 'maxTotalMarginPct', labelKey: 'riskMaxMargin', step: 5, percent: true },
  maxDrawdownPct: { key: 'maxDrawdownPct', labelKey: 'riskStopDrawdown', step: 1, percent: true },
  dailyLossLimitPct: { key: 'dailyLossLimitPct', labelKey: 'riskDailyLossLimit', step: 1, percent: true },
  trailArmR: { key: 'trailArmR', labelKey: 'riskTrailArm', step: 0.1 },
  trailGiveback: { key: 'trailGiveback', labelKey: 'riskTrailGiveback', step: 5, percent: true },
  chopPauseStreak: { key: 'chopPauseStreak', labelKey: 'riskChopPause', step: 1 },
  maxFundingRateLong: { key: 'maxFundingRateLong', labelKey: 'riskFundingFilter', step: 0.01, percent: true },
};

const SLIDERS = Object.values(SLIDER_DEFS);
const FIELDS = Object.values(FIELD_DEFS);

/**
 * Editable risk settings — the guardrails the engine sizes every trade against.
 * Grouped into 5 clear thematic categories.
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

  const renderSwitchCard = (
    id: string,
    title: string,
    sub: string,
    checked: boolean,
    onChange: (val: boolean) => void,
    helpKey?: string
  ) => {
    const isHelpOpen = helpKey ? openHelp === helpKey : false;
    return (
      <div
        key={id}
        className={`${styles.switchCard} ${checked ? styles.switchCardActive : ''}`}
        style={{ flexDirection: 'column', gap: '0.4rem' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.65rem', width: '100%' }}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => {
              onChange(e.target.checked);
              setIsDirty(true);
            }}
          />
          <label htmlFor={id} className={styles.switchCardText} style={{ cursor: 'pointer', flex: 1 }}>
            <span className={styles.switchCardTitle}>{title}</span>
            <span className={styles.switchCardSub}>{sub}</span>
          </label>
          {helpKey && HELP_TEXTS[helpKey] && (
            <button
              type="button"
              className={`${styles.helpBtn} ${isHelpOpen ? styles.helpBtnActive : ''}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpenHelp(isHelpOpen ? null : helpKey);
              }}
              title="Uitleg bekijken"
              aria-label={`Uitleg voor ${title}`}
            >
              ?
            </button>
          )}
        </div>
        {isHelpOpen && HELP_TEXTS[helpKey] && (
          <div className={styles.helpBox} style={{ width: '100%', margin: '0.2rem 0 0 0' }}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS[helpKey].title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS[helpKey].desc}</p>
            {HELP_TEXTS[helpKey].example && (
              <p className={styles.helpExample}>
                <b>Voorbeeld:</b> {HELP_TEXTS[helpKey].example}
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSlider = (s: SliderDef) => {
    const isHelpOpen = openHelp === s.key;
    return (
      <div key={s.key} className={styles.field} style={{ gridColumn: '1 / -1' }}>
        <div className={styles.fieldHeader}>
          <label htmlFor={s.key}>
            {t(s.labelKey)} — <strong>{format(s, draft[s.key] ?? s.min)}</strong>
          </label>
          {HELP_TEXTS[s.key] && (
            <button
              type="button"
              className={`${styles.helpBtn} ${isHelpOpen ? styles.helpBtnActive : ''}`}
              onClick={() => setOpenHelp(isHelpOpen ? null : s.key)}
              title="Uitleg bekijken"
              aria-label={`Uitleg voor ${t(s.labelKey)}`}
            >
              ?
            </button>
          )}
        </div>
        {isHelpOpen && HELP_TEXTS[s.key] && (
          <div className={styles.helpBox}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS[s.key].title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS[s.key].desc}</p>
            {HELP_TEXTS[s.key].example && (
              <p className={styles.helpExample}>
                <b>Voorbeeld:</b> {HELP_TEXTS[s.key].example}
              </p>
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
    );
  };

  const renderInput = (f: FieldDef) => {
    const isHelpOpen = openHelp === f.key;
    return (
      <div key={f.key} className={styles.field}>
        <div className={styles.fieldHeader}>
          <label htmlFor={f.key}>{t(f.labelKey)}</label>
          {HELP_TEXTS[f.key] && (
            <button
              type="button"
              className={`${styles.helpBtn} ${isHelpOpen ? styles.helpBtnActive : ''}`}
              onClick={() => setOpenHelp(isHelpOpen ? null : f.key)}
              title="Uitleg bekijken"
              aria-label={`Uitleg voor ${t(f.labelKey)}`}
            >
              ?
            </button>
          )}
        </div>
        {isHelpOpen && HELP_TEXTS[f.key] && (
          <div className={styles.helpBox}>
            <span className={styles.helpTitle}>💡 {HELP_TEXTS[f.key].title}</span>
            <p className={styles.helpDesc}>{HELP_TEXTS[f.key].desc}</p>
            {HELP_TEXTS[f.key].example && (
              <p className={styles.helpExample}>
                <b>Voorbeeld:</b> {HELP_TEXTS[f.key].example}
              </p>
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
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Category 1: 🛡️ Kernbeveiliging & Risicolimieten */}
      <div className={styles.riskCategoryCard}>
        <div className={styles.riskCategoryHead}>
          <span className={styles.riskCategoryTitle}>🛡️ Kernbeveiliging & Risicolimieten</span>
          <span className={styles.riskCategoryDesc}>Bescherming tegen overmatig verlies en te snelle trade-opeenvolging</span>
        </div>
        <div className={styles.riskCategoryBody}>
          <div className={styles.riskSwitchesGrid}>
            {renderSwitchCard(
              'pauseNewEntries',
              '⏸️ Standby Modus (Geen nieuwe trades)',
              'Pauzeert het openen van nieuwe posities direct, terwijl actieve trades (TP, SL, trailing) worden beheerd.',
              pauseNewEntries,
              setPauseNewEntries,
              'pauseNewEntries'
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.4rem' }}>
            {renderSlider(SLIDER_DEFS.maxOpenPositions)}
            {renderSlider(SLIDER_DEFS.maxSameSidePositions)}
            {renderSlider(SLIDER_DEFS.entryCooldownMinutes)}
          </div>

          <div className={styles.riskInputsGrid} style={{ marginTop: '0.5rem' }}>
            {renderInput(FIELD_DEFS.dailyLossLimitPct)}
            {renderInput(FIELD_DEFS.maxDrawdownPct)}
            {renderInput(FIELD_DEFS.maxTotalMarginPct)}
          </div>
        </div>
      </div>

      {/* Category 2: 🎯 Instap- & Timingfilters */}
      <div className={styles.riskCategoryCard}>
        <div className={styles.riskCategoryHead}>
          <span className={styles.riskCategoryTitle}>🎯 Instap- & Timingfilters</span>
          <span className={styles.riskCategoryDesc}>Voorkomt het vangen van vallende messen en kopen op de top</span>
        </div>
        <div className={styles.riskCategoryBody}>
          <div className={styles.riskSwitchesGrid}>
            {renderSwitchCard(
              'ltfSniper5m',
              '🎯 5-Minuten Sniper Trigger (LTF)',
              'Wacht tot de 5m micro-ommekeer is bevestigd met een groene candle of hammer-wick vóór instap.',
              ltfSniper5m,
              setLtfSniper5m,
              'ltfSniper5m'
            )}
            {renderSwitchCard(
              'reversal15m',
              '🕯️ 15m Ommekeer-bevestiging',
              'Wacht bij een dip op een groene 15m candle of kopers-wick (nooit een vallend mes vangen).',
              reversal15m,
              setReversal15m,
              'reversal15mRequired'
            )}
            {renderSwitchCard(
              'pullbackFilter',
              '🎯 Sniper Pullback Filter',
              'Wacht op een dip naar de EMA21 of de Fibonacci Golden Zone — trade nooit op de top.',
              pullbackFilter,
              setPullbackFilter,
              'pullbackFilter'
            )}
            {renderSwitchCard(
              'imbalanceScalp',
              '⚡ Imbalance / Golden Zone Scalps',
              'Snelle setups naar de Fair Value Gap (FVG) of Fib 0.618 na een liquiditeits-sweep met strakke stop.',
              imbalanceScalp,
              setImbalanceScalp,
              'imbalanceScalp'
            )}
            {renderSwitchCard(
              'premiumDiscountFilter',
              '⚖️ Premium vs. Discount (50% Eq)',
              'Blokkeert LONGs in de dure Premium zone (>50%) en SHORTs in Discount (<50%). Nooit kopen op de top!',
              premiumDiscountFilter,
              setPremiumDiscountFilter,
              'premiumDiscountFilter'
            )}
            {renderSwitchCard(
              'breakoutBypass',
              '🚀 Breakout Momentum Bypass',
              'Staat directe instap toe bij een explosieve volume-uitbraak (≥ 1.8x) zonder op een pullback te wachten.',
              breakoutBypass,
              setBreakoutBypass,
              'breakoutBypass'
            )}
          </div>
        </div>
      </div>

      {/* Category 3: 🧠 Smart Money & Markt-Afstemming */}
      <div className={styles.riskCategoryCard}>
        <div className={styles.riskCategoryHead}>
          <span className={styles.riskCategoryTitle}>🧠 Smart Money & Markt-Afstemming</span>
          <span className={styles.riskCategoryDesc}>Afstemming op Bitcoin-trend, institutionele order flow en funding rates</span>
        </div>
        <div className={styles.riskCategoryBody}>
          <div className={styles.riskSwitchesGrid}>
            {renderSwitchCard(
              'mssProtection',
              '🔄 Marktstructuur-bescherming (MSS / CHoCH)',
              'Sluit openstaande trades direct bij een officiële trendbreuk (candle body close door structuurniveau).',
              mssProtection,
              setMssProtection,
              'mssProtection'
            )}
            {renderSwitchCard(
              'smtFilter',
              '⚡ SMT Divergentie Filter vs. BTC',
              'Vergelijkt swing highs/lows tussen altcoins en BTC om Smart Money accumulatie/distributie te spotten.',
              smtFilter,
              setSmtFilter,
              'smtFilter'
            )}
            {renderSwitchCard(
              'volumeProfile',
              '📊 Volume Profile & Point of Control (POC)',
              'Berekent POC (piekvolume) en Value Area; gebruikt POC als koersmagneet en steun/weerstand.',
              volumeProfile,
              setVolumeProfile,
              'volumeProfile'
            )}
            {renderSwitchCard(
              'btcChopFilter',
              '🛡️ Bitcoin Chop Filter',
              'Pauzeert nieuwe altcoin trades wanneer Bitcoin in zijwaartse consolidatie zit om valse uitbraken te vermijden.',
              btcChopFilter,
              setBtcChopFilter,
              'btcChopFilter'
            )}
            {renderSwitchCard(
              'rsFilter',
              '💪 Marktleiders filter (Relative Strength)',
              'Alleen altcoin longs die minstens gelijke tred houden met Bitcoin (voorkomt trage achterblijvers).',
              rsFilter,
              setRsFilter,
              'rsFilterEnabled'
            )}
          </div>

          <div className={styles.riskInputsGrid} style={{ marginTop: '0.5rem' }}>
            {renderInput(FIELD_DEFS.maxFundingRateLong)}
          </div>
        </div>
      </div>

      {/* Category 4: 💰 Inleg, Kapitaal & Hefboom */}
      <div className={styles.riskCategoryCard}>
        <div className={styles.riskCategoryHead}>
          <span className={styles.riskCategoryTitle}>💰 Inleg, Kapitaal & Hefboom</span>
          <span className={styles.riskCategoryDesc}>Positiegrootte, maximale leverage en opschaling bij hoge conviction</span>
        </div>
        <div className={styles.riskCategoryBody}>
          <div className={styles.riskSwitchesGrid}>
            {renderSwitchCard(
              'turboMode',
              '🚀 Turbo Modus',
              'Zoekt snellere intraday setups met een hogere hefboom binnen veilige liquidatiemarges.',
              turbo,
              setTurbo,
              'turboMode'
            )}
          </div>

          <div style={{ marginTop: '0.4rem' }}>
            {renderSlider(SLIDER_DEFS.targetStakePct)}
          </div>

          <div className={styles.riskInputsGrid} style={{ marginTop: '0.5rem' }}>
            {renderInput(FIELD_DEFS.maxLeverage)}
            {renderInput(FIELD_DEFS.minStakePct)}
            {renderInput(FIELD_DEFS.minTradeMarginUsdt)}
            {renderInput(FIELD_DEFS.baseRiskPct)}
            {renderInput(FIELD_DEFS.maxRiskPct)}
            {renderInput(FIELD_DEFS.minConfidence)}
            {renderInput(FIELD_DEFS.highConvictionConfidence)}
            {renderInput(FIELD_DEFS.maxOverflowPositions)}
          </div>
        </div>
      </div>

      {/* Category 5: 📈 Winstnames, Trailing Stop & Exits */}
      <div className={styles.riskCategoryCard}>
        <div className={styles.riskCategoryHead}>
          <span className={styles.riskCategoryTitle}>📈 Winstnames, Trailing Stop & Exits</span>
          <span className={styles.riskCategoryDesc}>Beheer van runners, trailing stop triggers en trendomslag-afbouw</span>
        </div>
        <div className={styles.riskCategoryBody}>
          <div className={styles.riskSwitchesGrid}>
            {renderSwitchCard(
              'dynamicRunners',
              '📈 Dynamische Runners (5.0R)',
              'Verhoogt runner-winstdoelen naar 5.0R op sterke altcoin uitbraken na veiligstellen van TP1.',
              dynamicRunners,
              setDynamicRunners,
              'dynamicRunners'
            )}
            {renderSwitchCard(
              'trendFlipProtection',
              '🔄 Trendwissel-bescherming',
              'Schakelt automatische gedeeltelijke verkoop in zodra de markt echt van richting wisselt tegen je positie.',
              trendFlipProtection,
              setTrendFlipProtection,
              'trendFlipProtection'
            )}
          </div>

          <div style={{ marginTop: '0.4rem' }}>
            {renderSlider(SLIDER_DEFS.trendFlipTrimPortion)}
          </div>

          <div className={styles.riskInputsGrid} style={{ marginTop: '0.5rem' }}>
            {renderInput(FIELD_DEFS.trailArmR)}
            {renderInput(FIELD_DEFS.trailGiveback)}
            {renderInput(FIELD_DEFS.chopPauseStreak)}
          </div>
        </div>
      </div>

      {/* Save / Reset Bar */}
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
