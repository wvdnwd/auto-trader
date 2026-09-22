import { render, screen } from '@testing-library/react';
import { PositionRow } from './position-row.js';
import { SignalList } from './signal-list.js';
import { duration, pct, usd } from './format.js';
import type { Position, Signal } from './types.js';

const base: Position = {
  id: '1',
  symbol: 'BTC_USDT',
  side: 'LONG',
  entry: 100,
  quantity: 10,
  leverage: 5,
  margin: 200,
  notional: 1000,
  stopLoss: 95,
  takeProfit: 115,
  takeProfits: [
    { price: 106, portion: 0.4, rMultiple: 1.2, hit: false },
    { price: 115, portion: 0.6, rMultiple: 3, hit: false },
  ],
  remainingQuantity: 10,
  realisedPnl: 0,
  breakEven: false,
  trailingArmed: false,
  openedAt: Date.now() - 3_600_000,
  status: 'OPEN',
  confidence: 0.6,
  regime: 'TREND_UP',
  reasons: ['Regime TREND_UP'],
};

describe('PositionRow', () => {
  it('computes live pnl from the mark price on open positions', () => {
    render(<PositionRow position={base} mark={110} />);
    // 10 units * $10 move = +$100 on $200 margin.
    expect(screen.getByText(/\+\$100/)).toBeTruthy();
    expect(screen.getByText(/\+50\.0%/)).toBeTruthy();
  });

  it('adds booked profit to the live pnl after a partial exit', () => {
    const partial: Position = {
      ...base,
      remainingQuantity: 6,
      realisedPnl: 24,
      margin: 120,
      breakEven: true,
      takeProfits: [
        { price: 106, portion: 0.4, rMultiple: 1.2, hit: true, realised: 24 },
        { price: 115, portion: 0.6, rMultiple: 3, hit: false },
      ],
    };
    // 6 units * $10 move = $60 live, plus $24 already banked.
    render(<PositionRow position={partial} mark={110} />);
    expect(screen.getByText(/\+\$84/)).toBeTruthy();
    expect(screen.getByText('TP 1/2')).toBeTruthy();
    expect(screen.getByText('BREAK-EVEN')).toBeTruthy();
  });

  it('renders the full profit ladder', () => {
    render(<PositionRow position={base} mark={102} />);
    expect(screen.getByText(/1\.2R/)).toBeTruthy();
    expect(screen.getByText(/3R/)).toBeTruthy();
  });

  it('uses the realised pnl on closed positions instead of the mark', () => {
    const closed: Position = {
      ...base,
      status: 'CLOSED',
      exit: 115,
      pnl: 148,
      closedAt: base.openedAt + 7_200_000,
      exitReason: 'TAKE_PROFIT',
    };
    render(<PositionRow position={closed} mark={9999} />);
    expect(screen.getByText(/\+\$148/)).toBeTruthy();
    expect(screen.getByText('TAKE_PROFIT')).toBeTruthy();
  });

  it('flags an open position with no live price', () => {
    render(<PositionRow position={base} />);
    expect(screen.getByText('GEEN PRIJS')).toBeTruthy();
  });
});

describe('SignalList', () => {
  it('renders ranked signals and an empty state', () => {
    const signals: Signal[] = [
      {
        symbol: 'ETH_USDT',
        side: 'SHORT',
        confidence: 0.72,
        regime: 'TREND_DOWN',
        price: 2500,
        atrPct: 0.012,
        reasons: [],
        higherRegime: 'TREND_DOWN',
        alignedWithHigher: true,
        swingLow: 2400,
        swingHigh: 2600,
        roomToStructure: 2.4,
        checks: [{ name: 'Hoger tijdsframe', passed: true, detail: '1u-trend TREND_DOWN' }],
        fib: null,
        plannedLeverage: null,
      },
    ];
    const { rerender } = render(<SignalList signals={signals} threshold={0.35} />);
    expect(screen.getByText('ETH/USDT')).toBeTruthy();
    expect(screen.getByText('SHORT')).toBeTruthy();

    rerender(<SignalList signals={[]} threshold={0.35} />);
    expect(screen.getByText(/Nog geen scan/)).toBeTruthy();
  });
});

describe('formatters', () => {
  it('formats money, percentages and durations', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(-20)).toBe('-$20.00');
    expect(pct(0.0125)).toBe('1.25%');
    expect(duration(0, 5_400_000)).toBe('1u 30m');
    expect(duration(0, 60_000)).toBe('1m');
  });
});
