import { describe, expect, it, vi } from 'vitest';
import {
  intervalSeconds,
  loadReplayTimingHistory,
  replayWarmupStarts,
  TIMING_WARMUP_BARS,
} from './replay-warmup.js';

const INTERVALS = ['Min1', 'Min5', 'Min15', 'Min30', 'Min60', 'Hour4', 'Day1'];

describe('replay warmup starts', () => {
  it.each(INTERVALS)('loads 24-hour ticker and 80-bar context for %s', (interval) => {
    const from = 1_700_000_000;
    const seconds = intervalSeconds(interval);
    const starts = replayWarmupStarts(from, interval, interval);
    const duration = Math.max(80 * seconds, 86_400 + seconds);

    expect(starts.entryFrom).toBe(Math.floor((from - duration) / seconds) * seconds);
    expect((from - starts.entryFrom) / seconds).toBeGreaterThanOrEqual(80);
    expect(from - starts.entryFrom).toBeGreaterThanOrEqual(86_400 + seconds);
    expect(starts.higherFrom).toBe(Math.floor((from - 80 * seconds) / seconds) * seconds);
  });

  it('aligns unaligned bounds independently to each interval', () => {
    const from = 1_700_000_123;
    const entrySeconds = intervalSeconds('Min5');
    const higherSeconds = intervalSeconds('Hour4');
    const starts = replayWarmupStarts(from, 'Min5', 'Hour4');
    const entryDuration = Math.max(80 * entrySeconds, 86_400 + entrySeconds);

    expect(starts.entryFrom).toBe(Math.floor((from - entryDuration) / entrySeconds) * entrySeconds);
    expect(starts.higherFrom).toBe(Math.floor((from - 80 * higherSeconds) / higherSeconds) * higherSeconds);
    expect(starts.entryFrom % entrySeconds).toBe(0);
    expect(starts.higherFrom % higherSeconds).toBe(0);
  });

  it('loads 15 aligned timing bars before the scored start', () => {
    const from = 1_700_000_123;
    const starts = replayWarmupStarts(from, 'Min60', 'Hour4');
    const min15 = intervalSeconds('Min15');
    const min5 = intervalSeconds('Min5');

    expect(starts.timing15mFrom).toBe(Math.floor(from / min15) * min15 - TIMING_WARMUP_BARS * min15);
    expect(starts.timing5mFrom).toBe(Math.floor(from / min5) * min5 - TIMING_WARMUP_BARS * min5);
    expect(starts.timing15mFrom % min15).toBe(0);
    expect(starts.timing5mFrom % min5).toBe(0);
    expect(from - starts.timing15mFrom).toBeGreaterThanOrEqual(3 * 60 * 60 + 45 * 60);
    expect(from - starts.timing5mFrom).toBeGreaterThanOrEqual(75 * 60);
  });

  it('reuses only exact-interval arrays whose requested range covers timing warmup and replay end', async () => {
    const from = 1_700_000_000;
    const to = from + 5_000;
    const starts = replayWarmupStarts(from, 'Min15', 'Min60');
    const reused = Array.from({ length: TIMING_WARMUP_BARS }, (_, i) => ({
      time: starts.timing15mFrom + i * intervalSeconds('Min15'),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    const history = vi.fn(async (_symbol: string, _interval: string, start: number) =>
      Array.from({ length: TIMING_WARMUP_BARS }, (_, i) => ({
        time: start + i * 300,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
      }))
    );

    const timing = await loadReplayTimingHistory(
      history,
      'TEST_USDT',
      from,
      to,
      [{ interval: 'Min15', from: starts.entryFrom, to, candles: reused }]
    );

    expect(timing.timing15m).toBe(reused);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith('TEST_USDT', 'Min5', starts.timing5mFrom, to);
  });

  it('fetches real timing intervals when available ranges do not qualify for reuse', async () => {
    const from = 1_700_000_000;
    const to = from + 5_000;
    const starts = replayWarmupStarts(from, 'Min60', 'Hour4');
    const history = vi.fn(async (_symbol: string, interval: string, start: number) =>
      Array.from({ length: TIMING_WARMUP_BARS }, (_, i) => ({
        time: start + i * intervalSeconds(interval),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
      }))
    );
    const source = Array.from({ length: TIMING_WARMUP_BARS }, (_, i) => ({
      time: starts.timing15mFrom + i * intervalSeconds('Min15'),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));

    const timing = await loadReplayTimingHistory(history, 'TEST_USDT', from, to, [
      { interval: 'Min15', from: starts.timing15mFrom + 900, to, candles: source },
      { interval: 'Min5', from: starts.timing5mFrom, to: to - 1, candles: source },
      { interval: 'Min60', from: starts.timing15mFrom, to, candles: source },
    ]);

    expect(history.mock.calls.map(([, interval]) => interval).sort()).toEqual(['Min15', 'Min5']);
    expect(timing.timing15m).toHaveLength(TIMING_WARMUP_BARS);
    expect(timing.timing5m).toHaveLength(TIMING_WARMUP_BARS);
  });

  it('does not pad short or failed timing histories', async () => {
    const from = 1_700_000_000;
    const history = vi.fn(async (_symbol: string, interval: string) => {
      if (interval === 'Min5') throw new Error('offline');
      return Array.from({ length: TIMING_WARMUP_BARS - 1 }, () => ({
        time: from,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
      }));
    });

    await expect(loadReplayTimingHistory(history, 'TEST_USDT', from, from + 100)).resolves.toEqual({});
  });

  it('rejects page-cap suffixes that start after the aligned timing start', async () => {
    const from = 1_700_000_000;
    const to = from + 5_000;
    const starts = replayWarmupStarts(from, 'Min15', 'Min15');
    const suffix = (interval: string, start: number) =>
      Array.from({ length: TIMING_WARMUP_BARS }, (_, i) => ({
        time: start + intervalSeconds(interval) * (i + 1),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
      }));
    const history = vi.fn(async (_symbol: string, interval: string, start: number) => suffix(interval, start));

    await expect(
      loadReplayTimingHistory(history, 'TEST_USDT', from, to, [
        {
          interval: 'Min15',
          from: starts.timing15mFrom,
          to,
          candles: suffix('Min15', starts.timing15mFrom),
        },
      ])
    ).resolves.toEqual({});
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('accepts complete aligned timing histories', async () => {
    const from = 1_700_000_000;
    const to = from + 5_000;
    const history = vi.fn(async (_symbol: string, interval: string, start: number) =>
      Array.from({ length: TIMING_WARMUP_BARS }, (_, i) => ({
        time: start + i * intervalSeconds(interval),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
      }))
    );

    const timing = await loadReplayTimingHistory(history, 'TEST_USDT', from, to);
    const starts = replayWarmupStarts(from, 'Min15', 'Min15');

    expect(timing.timing15m).toHaveLength(TIMING_WARMUP_BARS);
    expect(timing.timing5m).toHaveLength(TIMING_WARMUP_BARS);
    expect(timing.timing15m?.[0].time).toBe(starts.timing15mFrom);
    expect(timing.timing5m?.[0].time).toBe(starts.timing5mFrom);
  });

  it('rejects unknown intervals instead of silently using a fallback', () => {
    expect(() => replayWarmupStarts(1_700_000_000, 'Min7', 'Min60')).toThrow('onbekend interval Min7');
    expect(() => replayWarmupStarts(1_700_000_000, 'Min15', 'Hour2')).toThrow('onbekend interval Hour2');
  });
});
