import { SignalChart } from './signal-chart.js';
import type { Candle, Signal } from './types.js';

function makeCandles(count: number, start: number, trendPerBar: number): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const wiggle = Math.sin(i / 3) * (start * 0.006);
    const open = price;
    const close = price + trendPerBar + wiggle;
    out.push({
      time: 1700000000 + i * 3600,
      open,
      high: Math.max(open, close) + start * 0.003,
      low: Math.min(open, close) - start * 0.003,
      close,
      volume: 1000 + Math.abs(wiggle) * 50,
    });
    price = close;
  }
  return out;
}

const candles = makeCandles(90, 60000, -35);

const waitingSignal: Signal = {
  symbol: 'BTC_USDT',
  side: 'SHORT',
  confidence: 0.67,
  regime: 'TREND_DOWN',
  price: candles[candles.length - 1].close,
  atrPct: 0.018,
  reasons: ['EMA21 onder EMA50', 'MACD histogram negatief'],
  higherRegime: 'CHOP',
  alignedWithHigher: false,
  swingLow: Math.min(...candles.map((c) => c.low)),
  swingHigh: Math.max(...candles.map((c) => c.high)),
  roomToStructure: 1.4,
  checks: [
    { name: 'Hoger tijdsframe', passed: false, detail: '4u-regime CHOP — nog geen bevestiging (niet tegengesteld, maar ook niet bevestigd)' },
    { name: 'Consistente richting', passed: true, detail: 'Regressiehelling -0.120% per bar' },
    { name: 'Volumebevestiging', passed: true, detail: 'Volume 1.05x t.o.v. gemiddelde' },
  ],
  fib: {
    swingHigh: Math.max(...candles.map((c) => c.high)),
    swingLow: Math.min(...candles.map((c) => c.low)),
    direction: 'DOWN',
    retracements: [
      { ratio: 0.382, price: candles[candles.length - 1].close * 1.02 },
      { ratio: 0.618, price: candles[candles.length - 1].close * 1.055 },
    ],
    extensions: [],
    nearest: { ratio: 0.5, price: candles[candles.length - 1].close * 1.035 },
    distanceToNearest: 0.08,
  },
  plannedLeverage: null,
};

const readySignal: Signal = {
  ...waitingSignal,
  alignedWithHigher: true,
  higherRegime: 'TREND_DOWN',
  checks: [
    { name: 'Hoger tijdsframe', passed: true, detail: '4u-trend TREND_DOWN bevestigt richting' },
    { name: 'Consistente richting', passed: true, detail: 'Regressiehelling -0.120% per bar' },
  ],
};

/** A signal still waiting on higher-timeframe confirmation — shows the "waiting on" panel. */
export const WaitingForConfirmation = () => (
  <div style={{ background: '#080b14', padding: 24, maxWidth: 780 }}>
    <SignalChart candles={candles} signal={waitingSignal} symbol="BTC_USDT" />
  </div>
);

/** A signal where every entry condition has cleared — ready-to-fire state. */
export const ReadyToEnter = () => (
  <div style={{ background: '#080b14', padding: 24, maxWidth: 780 }}>
    <SignalChart candles={candles} signal={readySignal} symbol="BTC_USDT" />
  </div>
);

/** Not enough history yet to score the market. */
export const InsufficientHistory = () => (
  <div style={{ background: '#080b14', padding: 24, maxWidth: 780 }}>
    <SignalChart candles={candles.slice(0, 1)} signal={null} symbol="BTC_USDT" />
  </div>
);
