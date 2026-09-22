import { useEffect, useState } from 'react';
import styles from './backtest.module.css';
import { fetchMarkets } from './api.js';
import type { BacktestConfig, Ticker } from './types.js';

/** Props for {@link BacktestForm}. */
export type BacktestFormProps = {
  /** Called with the run parameters when the user submits. */
  onRun: (config: Partial<BacktestConfig>) => void;
  /** Disables the form while a run is in flight. */
  busy: boolean;
  /** Label for the submit button, e.g. "Backtest draaien". */
  submitLabel?: string;
  /** Default entry timeframe. */
  defaultInterval?: string;
  /** Default lookback window in days. */
  defaultDays?: number;
};

/** Selectable lookback windows. */
const PERIODS = [
  { label: '7 dagen', days: 7 },
  { label: '14 dagen', days: 14 },
  { label: '30 dagen', days: 30 },
  { label: '60 dagen', days: 60 },
  { label: '90 dagen', days: 90 },
  { label: '180 dagen', days: 180 },
  { label: '1 jaar', days: 365 },
  // Walk-forward needs well over 300 days to fit more than one window.
  { label: '18 maanden', days: 545 },
  { label: '2 jaar', days: 730 },
];

/** Entry timeframes, paired with the confirmation timeframe the engine uses. */
const INTERVALS = [
  { label: '5 minuten', value: 'Min5', higher: 'Min30' },
  { label: '15 minuten', value: 'Min15', higher: 'Min60' },
  { label: '1 uur', value: 'Min60', higher: 'Hour4' },
  { label: '4 uur', value: 'Hour4', higher: 'Day1' },
];

/** Shown until the live market list loads, so the form is usable immediately. */
const FALLBACK = ['BTC_USDT', 'ETH_USDT', 'AVAX_USDT', 'LINK_USDT', 'SOL_USDT', 'BNB_USDT'];

/**
 * Markets pre-selected on load — the same four the live engine trades.
 *
 * These were picked on 12 months of history and held up on the 6 months after
 * it, so a first run shows the configuration that is actually deployed rather
 * than an arbitrary sample.
 */
const CORE = ['BTC_USDT', 'ETH_USDT', 'AVAX_USDT', 'LINK_USDT'];

/**
 * Controls for configuring a historical replay — markets, timeframe, window and
 * starting capital.
 */
export function BacktestForm({
  onRun,
  busy,
  submitLabel = 'Backtest draaien',
  defaultInterval = 'Min60',
  defaultDays = 90,
}: BacktestFormProps) {
  const [markets, setMarkets] = useState<string[]>(FALLBACK);
  const [selected, setSelected] = useState<string[]>(CORE);
  const [days, setDays] = useState(defaultDays);
  const [interval, setInterval] = useState(defaultInterval);
  const [balance, setBalance] = useState(10_000);

  useEffect(() => {
    let active = true;
    void fetchMarkets()
      .then((res) => {
        if (!active) return;
        const symbols = res.markets.map((m: Ticker) => m.symbol);
        if (symbols.length) setMarkets(symbols);
      })
      // The fallback list keeps the form working when the venue is unreachable.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const toggle = (symbol: string) => {
    setSelected((prev) =>
      prev.includes(symbol)
        ? prev.filter((s) => s !== symbol)
        : // More markets means a much longer download, so the list is capped.
          prev.length >= 8
          ? prev
          : [...prev, symbol]
    );
  };

  const submit = () => {
    const now = Math.floor(Date.now() / 1000);
    const pair = INTERVALS.find((i) => i.value === interval) || INTERVALS[1];
    onRun({
      symbols: selected,
      interval: pair.value,
      higherInterval: pair.higher,
      from: now - days * 86_400,
      to: now,
      startingBalance: balance,
    });
  };

  return (
    <div className={styles.form}>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>
          Markten <em>{selected.length}/8</em>
        </span>
        <div className={styles.chips}>
          {markets.slice(0, 24).map((symbol) => (
            <button
              key={symbol}
              type="button"
              className={`${styles.chip} ${selected.includes(symbol) ? styles.chipOn : ''}`}
              onClick={() => toggle(symbol)}
              disabled={busy}
            >
              {symbol.replace('_USDT', '')}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Periode</span>
          <select
            className={styles.select}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={busy}
          >
            {PERIODS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Interval</span>
          <select
            className={styles.select}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            disabled={busy}
          >
            {INTERVALS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Startkapitaal</span>
          <input
            className={styles.input}
            type="number"
            min={100}
            step={500}
            value={balance}
            onChange={(e) => setBalance(Number(e.target.value))}
            disabled={busy}
          />
        </label>
      </div>

      <button
        type="button"
        className={styles.runBtn}
        onClick={submit}
        disabled={busy || !selected.length}
      >
        {busy ? 'Bezig…' : submitLabel}
      </button>
    </div>
  );
}
