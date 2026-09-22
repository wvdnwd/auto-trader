import { MemoryRouter } from 'react-router-dom';
import { TraderApp } from './trader-app.js';
import { PositionRow } from './position-row.js';
import { SignalList } from './signal-list.js';
import { RiskPanel } from './risk-panel.js';
import type { Position, RiskConfig, Signal } from './types.js';

const openPosition: Position = {
  id: '1',
  symbol: 'BTC_USDT',
  side: 'LONG',
  entry: 78_400,
  quantity: 0.0255,
  leverage: 5,
  margin: 400,
  notional: 2000,
  stopLoss: 74_500,
  takeProfit: 86_800,
  takeProfits: [
    { price: 83_080, portion: 0.35, rMultiple: 1.2, hit: false },
    { price: 85_150, portion: 0.35, rMultiple: 2.5, hit: false },
    { price: 86_800, portion: 0.3, rMultiple: 4, hit: false },
  ],
  remainingQuantity: 0.0255,
  realisedPnl: 0,
  breakEven: false,
  trailingArmed: false,
  openedAt: Date.now() - 5_400_000,
  status: 'OPEN',
  confidence: 0.62,
  regime: 'TREND_UP',
  reasons: ['Regime TREND_UP', 'EMA21 boven EMA55 (1.24%)', 'RSI 58.2'],
};

const shortPosition: Position = {
  ...openPosition,
  id: '2',
  symbol: 'SOL_USDT',
  side: 'SHORT',
  entry: 142.5,
  quantity: 14.2,
  leverage: 8,
  margin: 253,
  notional: 2024,
  stopLoss: 142.5,
  takeProfit: 128.4,
  takeProfits: [
    { price: 134.0, portion: 0.4, rMultiple: 1.2, hit: true, hitAt: Date.now() - 900_000, realised: 48.2 },
    { price: 128.4, portion: 0.6, rMultiple: 2.2, hit: false },
  ],
  remainingQuantity: 8.52,
  realisedPnl: 48.2,
  breakEven: true,
  trailingArmed: true,
  confidence: 0.71,
  regime: 'TREND_DOWN',
  reasons: ['Regime TREND_DOWN', 'MACD histogram negatief', 'Funding 0.012% tegen longs'],
};

const closedPosition: Position = {
  ...openPosition,
  id: '3',
  symbol: 'ETH_USDT',
  status: 'CLOSED',
  entry: 2450,
  exit: 2618,
  pnl: 168.4,
  pnlPct: 0.42,
  remainingQuantity: 0,
  realisedPnl: 168.4,
  takeProfits: [
    { price: 2545, portion: 0.4, rMultiple: 1.2, hit: true, realised: 62.1 },
    { price: 2618, portion: 0.6, rMultiple: 2.2, hit: true, realised: 106.3 },
  ],
  closedAt: Date.now() - 600_000,
  exitReason: 'TAKE_PROFIT',
};

const signals: Signal[] = [
  {
    symbol: 'BTC_USDT',
    side: 'LONG',
    confidence: 0.64,
    regime: 'TREND_UP',
    price: 78_406,
    atrPct: 0.009,
    reasons: [],
    higherRegime: 'TREND_UP',
    alignedWithHigher: true,
    swingLow: 76_900,
    swingHigh: 81_200,
    roomToStructure: 3.4,
    checks: [
      { name: 'Hoger tijdsframe', passed: true, detail: '1u-trend TREND_UP bevestigt richting' },
      { name: 'Consistente richting', passed: true, detail: 'Regressiehelling 0.042% per bar' },
      { name: 'Volumebevestiging', passed: true, detail: 'Volume 1.31x t.o.v. gemiddelde' },
      { name: 'Geen uitgeputte beweging', passed: true, detail: '1.2 ATR in 3 bars' },
      { name: 'Ruimte tot structuur', passed: true, detail: '3.4R tot eerstvolgende weerstand' },
    ],
    fib: null,
    plannedLeverage: 14,
  },
  {
    symbol: 'SOL_USDT',
    side: 'SHORT',
    confidence: 0.48,
    regime: 'TREND_DOWN',
    price: 142.5,
    atrPct: 0.021,
    reasons: [],
    higherRegime: 'RANGE',
    alignedWithHigher: false,
    swingLow: 136.2,
    swingHigh: 148.9,
    roomToStructure: 1.6,
    checks: [
      { name: 'Hoger tijdsframe', passed: true, detail: '1u-trend RANGE neutraal' },
      { name: 'Consistente richting', passed: true, detail: 'Regressiehelling -0.031% per bar' },
      { name: 'Volumebevestiging', passed: false, detail: 'Volume 0.58x t.o.v. gemiddelde' },
      { name: 'Geen uitgeputte beweging', passed: true, detail: '1.8 ATR in 3 bars' },
      { name: 'Ruimte tot structuur', passed: true, detail: '1.6R tot eerstvolgende steun' },
    ],
    fib: null,
    plannedLeverage: null,
  },
  {
    symbol: 'DOGE_USDT',
    side: 'LONG',
    confidence: 0.19,
    regime: 'CHOP',
    price: 0.1284,
    atrPct: 0.018,
    reasons: [],
    higherRegime: 'CHOP',
    alignedWithHigher: false,
    swingLow: 0.1241,
    swingHigh: 0.1319,
    roomToStructure: 0.9,
    checks: [
      { name: 'Verhandelbaar regime', passed: false, detail: 'Regime CHOP' },
      { name: 'Ruimte tot structuur', passed: false, detail: '0.9R tot eerstvolgende weerstand' },
    ],
    fib: null,
    plannedLeverage: null,
  },
];

const risk: RiskConfig = {
  baseRiskPct: 0.01,
  maxRiskPct: 0.02,
  maxLeverage: 12,
  minLeverage: 2,
  maxOpenPositions: 5,
  maxTotalMarginPct: 0.5,
  maxDrawdownPct: 0.25,
  dailyLossLimitPct: 0.08,
  minConfidence: 0.45,
  maxPositionHours: 48,
  atrStopMultiple: 3,
  trailArmR: 1.8,
  trailGiveback: 0.6,
  firstTargetR: 1.8,
  firstTargetPortion: 0.3,
  finalTargetR: 3.6,
  breakEvenAfterFirst: true,
  requireHigherAlignment: true,
  maxSameSidePositions: 10,
  maxPerGroup: 2,
  minStakePct: 0.05,
  targetStakePct: 0.2,
  highConvictionConfidence: 0.7,
  maxOverflowPositions: 3,
  chopPauseStreak: 6,
  trendFlipProtection: true,
  trendFlipTrimPortion: 0.5,
};

const frame = { background: '#080b14', padding: '1.5rem', minHeight: '100vh' };

/**
 * The full dashboard, connected to the live trading service.
 */
export const TraderAppBasic = () => {
  return (
    <MemoryRouter>
      <TraderApp />
    </MemoryRouter>
  );
};

/**
 * Open positions — a profitable long and a short with its trailing stop armed.
 */
export const OpenPositions = () => (
  <div style={frame}>
    <PositionRow position={openPosition} mark={80_100} onClose={() => {}} />
    <div style={{ height: '0.75rem' }} />
    <PositionRow position={shortPosition} mark={131.4} onClose={() => {}} />
    <div style={{ height: '0.75rem' }} />
    <PositionRow position={closedPosition} />
  </div>
);

/**
 * Scanner ranking — signals above the threshold are eligible for entry.
 */
export const ScannerRanking = () => (
  <div style={frame}>
    <SignalList signals={signals} threshold={0.35} />
  </div>
);

/**
 * The risk controls that govern sizing, leverage and the portfolio guardrails.
 */
export const RiskControls = () => (
  <div style={frame}>
    <RiskPanel risk={risk} onSave={() => {}} />
  </div>
);
