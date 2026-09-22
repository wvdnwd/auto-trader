import { render, screen } from '@testing-library/react';
import { SignalChart, waitingOn } from './signal-chart.js';
import type { Candle, Signal } from './types.js';

function makeCandles(count: number, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const o = start + i * 0.2;
    out.push({ time: i * 3600, open: o, high: o + 1, low: o - 1, close: o + 0.3, volume: 100 });
  }
  return out;
}

const baseSignal: Signal = {
  symbol: 'BTC_USDT',
  side: 'SHORT',
  confidence: 0.67,
  regime: 'TREND_DOWN',
  price: 120,
  atrPct: 0.02,
  reasons: [],
  higherRegime: 'CHOP',
  alignedWithHigher: false,
  swingLow: 100,
  swingHigh: 140,
  roomToStructure: 1.2,
  checks: [
    { name: 'Hoger tijdsframe', passed: false, detail: '4u-regime CHOP — nog geen bevestiging' },
    { name: 'Volumebevestiging', passed: true, detail: 'Volume 1.1x' },
  ],
  fib: null,
  plannedLeverage: null,
};

describe('SignalChart', () => {
  it('renders a candlestick chart when there is enough history', () => {
    render(<SignalChart candles={makeCandles(30)} signal={baseSignal} symbol="BTC_USDT" />);
    expect(screen.getByRole('img', { name: /BTC\/USDT/ })).toBeTruthy();
  });

  it('falls back to an empty state with too little history', () => {
    render(<SignalChart candles={[]} signal={null} symbol="BTC_USDT" />);
    expect(screen.getByText(/Te weinig candles/)).toBeTruthy();
  });

  it('lists every unmet check as a plain-language waiting reason', () => {
    render(<SignalChart candles={makeCandles(30)} signal={baseSignal} symbol="BTC_USDT" />);
    expect(screen.getByText(/4u-regime CHOP/)).toBeTruthy();
  });
});

describe('waitingOn', () => {
  it('reports nothing missing once every check passes', () => {
    const ready: Signal = {
      ...baseSignal,
      alignedWithHigher: true,
      higherRegime: 'TREND_DOWN',
      checks: [{ name: 'Hoger tijdsframe', passed: true, detail: '1u-trend TREND_DOWN bevestigt richting' }],
    };
    expect(waitingOn(ready)).toEqual([]);
  });

  it('flags a signal with no data at all', () => {
    expect(waitingOn(null)[0]).toMatch(/Nog niet genoeg candles/);
  });
});
