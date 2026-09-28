import { describe, expect, it, beforeEach } from 'vitest';
import { ErrorLogger } from './error-logger.js';

describe('ErrorLogger', () => {
  let logger: ErrorLogger;

  beforeEach(() => {
    logger = ErrorLogger.getInstance();
    logger.clearErrors();
  });

  it('records error with proper fields', () => {
    const err = new Error('Hyperliquid API timeout');
    const logged = logger.error('Hyperliquid', err, { endpoint: '/order' });

    expect(logged.id).toBeDefined();
    expect(logged.level).toBe('error');
    expect(logged.source).toBe('Hyperliquid');
    expect(logged.message).toBe('Hyperliquid API timeout');
    expect(logged.stack).toBeDefined();
    expect(logged.details).toEqual({ endpoint: '/order' });
    expect(logged.occurrences).toBe(1);
    expect(logger.getTotalCount()).toBe(1);
  });

  it('deduplicates identical consecutive errors within 30s', () => {
    const logged1 = logger.error('Engine', 'Database connection refused');
    const logged2 = logger.error('Engine', 'Database connection refused');

    expect(logged1.id).toBe(logged2.id);
    expect(logged2.occurrences).toBe(2);
    expect(logger.getTotalCount()).toBe(1);
    expect(logger.getErrors()).toHaveLength(1);
  });

  it('filters errors by source', () => {
    logger.error('Hyperliquid', 'Order failed');
    logger.error('Engine', 'Scan loop warning');
    logger.warn('MarketData', 'Rate limit hit');

    expect(logger.getErrors(10, 'Hyperliquid')).toHaveLength(1);
    expect(logger.getErrors(10, 'Engine')).toHaveLength(1);
    expect(logger.getErrors(10, 'MarketData')).toHaveLength(1);
    expect(logger.getErrors(10, 'ALL')).toHaveLength(3);
  });

  it('clears all errors', () => {
    logger.error('Engine', 'Error 1');
    logger.warn('MarketData', 'Warn 1');
    expect(logger.getTotalCount()).toBe(2);

    logger.clearErrors();
    expect(logger.getTotalCount()).toBe(0);
    expect(logger.getErrors()).toHaveLength(0);
  });
});
