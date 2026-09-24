import { adx, rsi, volumeRatio } from './indicators.js';
import type { Candle } from './types.js';

function candlesFromVolumes(volumes: number[]): Candle[] {
  return volumes.map((volume, index) => ({
    time: index * 900,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume,
  }));
}

describe('indicator edge cases', () => {
  it('treats a flat RSI series as neutral and preserves directional extremes', () => {
    expect(rsi(Array(20).fill(100), 14)).toBe(50);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14)).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14)).toBe(0);
  });

  it('requires a complete ADX warm-up', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const close = 100 + Math.sin(i * 0.7) * 3 + i * 0.05;
      const open = i ? 100 + Math.sin((i - 1) * 0.7) * 3 + (i - 1) * 0.05 : close;
      return {
        time: i * 900,
        open,
        high: Math.max(open, close) + 0.5,
        low: Math.min(open, close) - 0.5,
        close,
        volume: 100,
      };
    });

    expect(adx(candles.slice(0, 27), 14)).toBeNaN();
    expect(adx(candles.slice(0, 28), 14)).toBeNaN();
    expect(Number.isFinite(adx(candles.slice(0, 29), 14))).toBe(true);
  });

  it('compares the last closed volume with prior closed bars and ignores the forming bar', () => {
    const candles = candlesFromVolumes([10, 10, 10, 20, 1000]);
    expect(volumeRatio(candles, 3)).toBe(2);

    candles[4].volume = 1_000_000;
    expect(volumeRatio(candles, 3)).toBe(2);
    expect(volumeRatio(candles.slice(0, 4), 3)).toBeNaN();
  });
});
