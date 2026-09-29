import { describe, expect, it } from 'vitest';
import { extractHlOrderId, toHyperliquidCloid } from './hyperliquid-adapter.js';

// Pure-function tests only: they never construct the production adapter and make
// no network calls.
describe('toHyperliquidCloid', () => {
  it('returns undefined when no external oid is supplied', () => {
    expect(toHyperliquidCloid(undefined)).toBeUndefined();
    expect(toHyperliquidCloid('')).toBeUndefined();
  });

  it('produces a 34-char 0x-prefixed 32-hex cloid accepted by the SDK pattern', () => {
    const cloid = toHyperliquidCloid('f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(cloid).toBeDefined();
    expect(cloid).toHaveLength(34);
    expect(cloid).toMatch(/^0x[a-fA-F0-9]{32}$/);
  });

  it('is deterministic and distinct per external oid', () => {
    const a = toHyperliquidCloid('order-a');
    const b = toHyperliquidCloid('order-b');
    expect(toHyperliquidCloid('order-a')).toBe(a);
    expect(a).not.toBe(b);
  });
});

describe('extractHlOrderId', () => {
  it('reads the oid from filled and resting acknowledgements', () => {
    expect(extractHlOrderId({ filled: { oid: 123, totalSz: '1', avgPx: '100' } })).toBe('123');
    expect(extractHlOrderId({ resting: { oid: 456 } })).toBe('456');
  });

  it('returns null for statuses that carry no oid', () => {
    expect(extractHlOrderId('waitingForFill')).toBeNull();
    expect(extractHlOrderId('waitingForTrigger')).toBeNull();
    expect(extractHlOrderId({ error: 'order rejected' })).toBeNull();
    expect(extractHlOrderId(null)).toBeNull();
    expect(extractHlOrderId(undefined)).toBeNull();
  });
});
