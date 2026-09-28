import fs from 'node:fs';
import path from 'node:path';
import type { SystemError } from './types.js';

/**
 * Centralized in-memory and disk-persisted error logging engine.
 * Records exceptions, API failures, order execution errors, and unhandled rejections.
 */
export class ErrorLogger {
  private static instance: ErrorLogger | null = null;
  private readonly maxErrors = 500;
  private errors: SystemError[] = [];
  private totalCount = 0;
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private handlersInstalled = false;

  private constructor() {
    this.loadFromDisk();
    this.setupGlobalHandlers();
  }

  static getInstance(): ErrorLogger {
    if (!ErrorLogger.instance) {
      ErrorLogger.instance = new ErrorLogger();
    }
    return ErrorLogger.instance;
  }

  private getDiskPath(): string {
    const dir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.resolve(dir, 'error-log.json');
  }

  private loadFromDisk(): void {
    try {
      const p = this.getDiskPath();
      if (!fs.existsSync(p)) return;
      const raw = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.errors)) {
        this.errors = data.errors.slice(-this.maxErrors);
        this.totalCount = typeof data.totalCount === 'number' ? data.totalCount : this.errors.length;
      }
    } catch {
      // Ignore disk read or JSON parse errors
    }
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.saveToDisk();
    }, 1000);
  }

  private saveToDisk(): void {
    try {
      const p = this.getDiskPath();
      const payload = {
        totalCount: this.totalCount,
        savedAt: Date.now(),
        errors: this.errors,
      };
      fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Ignore disk write errors
    }
  }

  /**
   * Log an error, warning, or fatal condition.
   */
  log(
    level: 'error' | 'fatal' | 'warn',
    source: string,
    messageOrErr: Error | string | unknown,
    details?: Record<string, unknown> | string
  ): SystemError {
    const at = Date.now();
    let message = '';
    let stack: string | undefined;

    if (messageOrErr instanceof Error) {
      message = messageOrErr.message || String(messageOrErr);
      stack = messageOrErr.stack;
    } else if (typeof messageOrErr === 'string') {
      message = messageOrErr;
    } else if (messageOrErr && typeof messageOrErr === 'object') {
      const rec = messageOrErr as Record<string, unknown>;
      message = typeof rec.message === 'string' ? rec.message : JSON.stringify(messageOrErr);
      stack = typeof rec.stack === 'string' ? rec.stack : undefined;
    } else {
      message = String(messageOrErr);
    }

    // Deduplication: if identical to the previous error within 30 seconds, increment counter
    const last = this.errors[this.errors.length - 1];
    if (
      last &&
      last.source === source &&
      last.message === message &&
      last.level === level &&
      at - last.at < 30_000
    ) {
      last.occurrences = (last.occurrences || 1) + 1;
      last.at = at;
      if (details) last.details = details;
      this.scheduleSave();
      return last;
    }

    const id = `err_${at}_${Math.random().toString(36).slice(2, 7)}`;
    const systemError: SystemError = {
      id,
      at,
      level,
      source,
      message,
      ...(stack ? { stack } : {}),
      ...(details ? { details } : {}),
      occurrences: 1,
    };

    this.errors.push(systemError);
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }
    this.totalCount += 1;

    this.scheduleSave();
    return systemError;
  }

  error(source: string, messageOrErr: Error | string | unknown, details?: Record<string, unknown> | string): SystemError {
    return this.log('error', source, messageOrErr, details);
  }

  warn(source: string, messageOrErr: Error | string | unknown, details?: Record<string, unknown> | string): SystemError {
    return this.log('warn', source, messageOrErr, details);
  }

  fatal(source: string, messageOrErr: Error | string | unknown, details?: Record<string, unknown> | string): SystemError {
    return this.log('fatal', source, messageOrErr, details);
  }

  getErrors(limit = 100, source?: string): SystemError[] {
    let list = this.errors;
    if (source && source !== 'ALL') {
      list = list.filter((e) => e.source.toLowerCase() === source.toLowerCase());
    }
    return list.slice(-limit).reverse();
  }

  getTotalCount(): number {
    return this.errors.length;
  }

  clearErrors(): void {
    this.errors = [];
    this.totalCount = 0;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.saveToDisk();
  }

  setupGlobalHandlers(): void {
    if (this.handlersInstalled) return;
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
    this.handlersInstalled = true;

    process.on('uncaughtException', (err: Error) => {
      console.error('[UNCAUGHT EXCEPTION]', err);
      this.fatal('Process', err, { type: 'uncaughtException' });
    });

    process.on('unhandledRejection', (reason: unknown) => {
      console.error('[UNHANDLED REJECTION]', reason);
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.error('Process', err, { type: 'unhandledRejection' });
    });
  }
}
