import type { Candle } from './types.js';

const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Min60: 3600,
  Hour4: 14_400,
  Day1: 86_400,
};

export const REPLAY_WARMUP_BARS = 80;
export const TIMING_WARMUP_BARS = 15;
const DAY_SECONDS = 86_400;

export type ReplayHistorySource = {
  interval: string;
  from: number;
  to: number;
  candles: Candle[];
};

export type ReplayTimingHistory = {
  timing15m?: Candle[];
  timing5m?: Candle[];
};

/** Return seconds per supported candle interval, rejecting unknown intervals. */
export function intervalSeconds(interval: string): number {
  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds) throw new Error(`onbekend interval ${interval}`);
  return seconds;
}

/** Calculate interval-aligned history starts without changing replay bounds. */
export function replayWarmupStarts(
  from: number,
  entryInterval: string,
  higherInterval: string
): { entryFrom: number; higherFrom: number; timing15mFrom: number; timing5mFrom: number } {
  const entrySeconds = intervalSeconds(entryInterval);
  const higherSeconds = intervalSeconds(higherInterval);
  const entryDuration = Math.max(REPLAY_WARMUP_BARS * entrySeconds, DAY_SECONDS + entrySeconds);
  const alignDown = (time: number, intervalSeconds: number) =>
    Math.floor(time / intervalSeconds) * intervalSeconds;
  const timingStart = (interval: string) => {
    const seconds = intervalSeconds(interval);
    return alignDown(from, seconds) - TIMING_WARMUP_BARS * seconds;
  };

  return {
    entryFrom: alignDown(from - entryDuration, entrySeconds),
    higherFrom: alignDown(from - REPLAY_WARMUP_BARS * higherSeconds, higherSeconds),
    timing15mFrom: timingStart('Min15'),
    timing5mFrom: timingStart('Min5'),
  };
}

/** Load real timing intervals, reusing only exact-interval requests with sufficient range. */
export async function loadReplayTimingHistory(
  history: (symbol: string, interval: string, from: number, to: number) => Promise<Candle[]>,
  symbol: string,
  from: number,
  to: number,
  sources: ReplayHistorySource[] = []
): Promise<ReplayTimingHistory> {
  const starts = replayWarmupStarts(from, 'Min15', 'Min15');

  const load = async (interval: 'Min15' | 'Min5', start: number): Promise<Candle[] | undefined> => {
    const intervalLength = intervalSeconds(interval);
    const coversStart = (candles: Candle[]) => {
      const first = candles[0]?.time;
      const last = candles.at(-1)?.time;
      return (
        candles.length >= TIMING_WARMUP_BARS &&
        typeof first === 'number' &&
        Number.isFinite(first) &&
        typeof last === 'number' &&
        Number.isFinite(last) &&
        first <= start &&
        last + intervalLength >= start
      );
    };
    const reusable = sources.find(
      (source) =>
        source.interval === interval &&
        source.from <= start &&
        source.to >= to &&
        coversStart(source.candles)
    );
    if (reusable) return reusable.candles;

    try {
      const candles = await history(symbol, interval, start, to);
      return coversStart(candles) ? candles : undefined;
    } catch {
      return undefined;
    }
  };

  const [timing15m, timing5m] = await Promise.all([
    load('Min15', starts.timing15mFrom),
    load('Min5', starts.timing5mFrom),
  ]);
  return {
    ...(timing15m ? { timing15m } : {}),
    ...(timing5m ? { timing5m } : {}),
  };
}
