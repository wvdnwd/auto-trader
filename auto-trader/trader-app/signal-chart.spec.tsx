import { render, screen } from '@testing-library/react';
import { layoutRightBadges, SignalChart, waitingOn } from './signal-chart.js';
import type { Candle, Signal, TradePlan } from './types.js';

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

  it('keeps route points strictly left-to-right inside the plot', () => {
    const plan: TradePlan = {
      symbol: 'BTC_USDT',
      side: 'SHORT',
      entry: 120,
      leverage: 3,
      margin: 50,
      notional: 150,
      quantity: 1.25,
      stopLoss: 124,
      takeProfit: 110,
      takeProfits: [
        { price: 116, portion: 0.4, rMultiple: 1, hit: false },
        { price: 112, portion: 0.6, rMultiple: 2, hit: false },
      ],
      riskPct: 0.01,
      confidence: 0.7,
      regime: 'TREND_DOWN',
      reasons: [],
    };
    render(<SignalChart candles={makeCandles(45, 120)} signal={baseSignal} plannedTrade={plan} symbol="BTC_USDT" />);
    const xs = screen.getAllByTestId('trajectory-point').map((point) => Number(point.getAttribute('data-x')));
    expect(xs.length).toBeGreaterThan(1);
    expect(xs.every((x, i) => x > 60 && x < 635 && (i === 0 || x > xs[i - 1]))).toBe(true);
  });

  it('labels both anchors on a downward Fibonacci impulse in vertical order', () => {
    const downSignal: Signal = {
      ...baseSignal,
      fib: {
        swingHigh: 140,
        swingLow: 100,
        direction: 'DOWN',
        retracements: [
          { ratio: 0.382, price: 124.72 },
          { ratio: 0.618, price: 115.28 },
        ],
        extensions: [],
        nearest: { ratio: 0.5, price: 120 },
        distanceToNearest: 0,
      },
    };
    render(<SignalChart candles={makeCandles(30, 120)} signal={downSignal} symbol="BTC_USDT" />);
    const top = screen.getByText(/Fib 1\.000 Top/);
    const bottom = screen.getByText(/Fib 0\.000 Bodem/);
    expect(Number(top.getAttribute('y'))).toBeLessThan(Number(bottom.getAttribute('y')));
  });

  it('uses the SVG union members safely for live exchange positions', () => {
    const livePosition = {
      symbol: 'BTC_USDT',
      side: 'LONG' as const,
      vol: 0.1,
      leverage: 5,
      entryPrice: 105,
      markPrice: 106,
      liquidationPrice: 85,
      unrealisedPnl: 10,
    };
    render(<SignalChart candles={makeCandles(30)} signal={baseSignal} position={livePosition} symbol="BTC_USDT" />);
    expect(screen.getByRole('img', { name: /BTC\/USDT/ })).toBeTruthy();
    expect(screen.getByText(/Ongerealiseerde winst\/verlies: \+\$10\.00/)).toBeTruthy();
  });
});

describe('layoutRightBadges', () => {
  it('enforces its spacing capacity and adds an overflow badge', () => {
    const badges = Array.from({ length: 30 }, (_, index) => ({
      id: `tp${index}`,
      rawY: 25 + index,
      y: 25 + index,
      kind: 'tp' as const,
      label: `TP${index + 1}`,
      price: 100 + index,
    }));
    const laidOut = layoutRightBadges(badges);
    const ys = laidOut.map((badge) => badge.y);
    expect(laidOut).toHaveLength(19);
    expect(laidOut.some((badge) => badge.kind === 'overflow')).toBe(true);
    expect(ys[0]).toBeGreaterThanOrEqual(35);
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(395);
    expect(ys.every((y, index) => index === 0 || y - ys[index - 1] >= 20)).toBe(true);
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
