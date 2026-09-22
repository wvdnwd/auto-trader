import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { AccountModel, EventModel, ExchangeCredentialsModel, PositionModel, ScoutModel } from './models.js';
import type { EngineEvent, LearningState, Position, Side } from './types.js';

export function getCredentialsFilePath(): string {
  const candidates = [
    path.resolve(process.cwd(), '.mexc-credentials.json'),
    path.resolve('c:/Users/Gebruiker/Desktop/traderr', '.mexc-credentials.json'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return candidates[0];
}

export function readStoredCredentialsFile(): { apiKey: string; apiSecret: string; liveTrading?: boolean } {
  try {
    const p = getCredentialsFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object') {
        return {
          apiKey: String(data.apiKey || ''),
          apiSecret: String(data.apiSecret || ''),
          liveTrading: Boolean(data.liveTrading),
        };
      }
    }
  } catch {
    // ignore
  }
  return { apiKey: '', apiSecret: '', liveTrading: false };
}

export function writeStoredCredentialsFile(data: { apiKey: string; apiSecret: string; liveTrading?: boolean }): void {
  const pathsToTry = [
    path.resolve('c:/Users/Gebruiker/Desktop/traderr', '.mexc-credentials.json'),
    path.resolve(process.cwd(), '.mexc-credentials.json'),
  ];
  for (const p of pathsToTry) {
    try {
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
      break;
    } catch {
      // try next
    }
  }
}

const STARTING_BALANCE = Number(process.env.PAPER_START_BALANCE || 10_000);

export function getStoreStateFilePath(tenantId = 'main'): string {
  const dir = path.resolve(process.cwd(), 'data');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return path.resolve(dir, `store-${tenantId}.json`);
}

/**
 * Persistence layer for the paper trading engine.
 *
 * All data access goes through this repository so the engine never touches
 * the database models directly. Every document is scoped by `tenantId` —
 * `'main'` for the deployment owner, or a per-browser client id for anyone
 * else using a shared link — so multiple people can use the same deployment
 * with fully independent paper accounts, MEXC connections and history.
 */
export class Store {
  private connected = false;

  private eventsSincePrune = 0;

  constructor(private readonly tenantId: string = 'main') {
    this.loadMemoryState();
  }

  /** In-memory fallback used when no database is reachable. */
  private memory: {
    positions: Position[];
    events: EngineEvent[];
    account: AccountState;
    scout: ScoutState;
    exchangeCredentials: ExchangeCredentials;
    learning: LearningState;
  } = {
    positions: [],
    events: [],
    account: {
      balance: STARTING_BALANCE,
      startingBalance: STARTING_BALANCE,
      realisedPnl: 0,
      peakEquity: STARTING_BALANCE,
      dayStartEquity: STARTING_BALANCE,
      dayKey: new Date().toISOString().slice(0, 10),
    },
    scout: { universeExtras: [], cooldowns: {}, lastRunAt: null },
    exchangeCredentials: { apiKey: '', apiSecret: '' },
    learning: { factorStats: {}, penalties: {} },
  };

  private loadMemoryState(): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    try {
      const p = getStoreStateFilePath(this.tenantId);
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (Array.isArray(raw.positions)) this.memory.positions = raw.positions;
          if (Array.isArray(raw.events)) this.memory.events = raw.events;
          if (raw.account && typeof raw.account === 'object') {
            this.memory.account = { ...this.memory.account, ...raw.account };
          }
          if (raw.scout && typeof raw.scout === 'object') {
            this.memory.scout = { ...this.memory.scout, ...raw.scout };
          }
          if (raw.learning && typeof raw.learning === 'object') {
            this.memory.learning = {
              factorStats: { ...this.memory.learning.factorStats, ...(raw.learning.factorStats || {}) },
              penalties: { ...this.memory.learning.penalties, ...(raw.learning.penalties || {}) },
            };
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  private persistMemoryState(): void {
    if (this.connected || process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    try {
      const p = getStoreStateFilePath(this.tenantId);
      fs.writeFileSync(p, JSON.stringify(this.memory, null, 2), 'utf8');
    } catch {
      // Non-fatal
    }
  }

  /**
   * Connect to the built-in MongoDB. Falls back to in-memory state when the
   * database is unavailable so the engine keeps running.
   *
   * @returns true when connected to MongoDB.
   */
  async connect(): Promise<boolean> {
    const url = process.env.MONGO_URL;
    if (!url) return false;
    try {
      await mongoose.connect(url, { serverSelectionTimeoutMS: 5_000 });
      this.connected = true;
      await this.account();
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  /**
   * Read the account state, seeding it on first run.
   *
   * @returns the persisted account state.
   */
  async account(): Promise<AccountState> {
    if (!this.connected) return this.memory.account;
    const existing = await AccountModel.findOne({ key: this.tenantId }).lean();
    if (existing) {
      return {
        balance: existing.balance,
        startingBalance: existing.startingBalance,
        realisedPnl: existing.realisedPnl,
        peakEquity: existing.peakEquity,
        dayStartEquity: existing.dayStartEquity || existing.startingBalance,
        dayKey: existing.dayKey || new Date().toISOString().slice(0, 10),
      };
    }
    const seeded: AccountState = {
      balance: STARTING_BALANCE,
      startingBalance: STARTING_BALANCE,
      realisedPnl: 0,
      peakEquity: STARTING_BALANCE,
      dayStartEquity: STARTING_BALANCE,
      dayKey: new Date().toISOString().slice(0, 10),
    };
    await AccountModel.create({ key: this.tenantId, ...seeded });
    return seeded;
  }

  /**
   * Persist the account state.
   *
   * @param state the new account state.
   */
  async saveAccount(state: AccountState): Promise<void> {
    if (!this.connected) {
      this.memory.account = state;
      this.persistMemoryState();
      return;
    }
    await AccountModel.updateOne({ key: this.tenantId }, { $set: state }, { upsert: true });
  }

  /**
   * Atomically add to the account's balance and/or realised pnl.
   *
   * Every entry, exit and partial take-profit changes these two fields by a
   * relative amount. The engine's live cycle and a manual close from the
   * dashboard can both settle a trade in the same instant, so a plain
   * read-modify-write (`account()` then `saveAccount()`) can lose one side's
   * update when both reads happen before either write lands. `$inc` is applied
   * by MongoDB itself against the stored value, so two concurrent deltas both
   * land regardless of ordering. The in-memory fallback mutates its object
   * directly with no `await` in between the read and the write, which is
   * equally race-free since nothing else can interleave inside one synchronous
   * step of the event loop.
   *
   * @param delta amounts to add; omitted fields are left unchanged.
   * @returns the account state after the delta is applied.
   */
  async applyBalanceDelta(delta: { balance?: number; realisedPnl?: number }): Promise<AccountState> {
    if (!this.connected) {
      if (delta.balance) this.memory.account.balance += delta.balance;
      if (delta.realisedPnl) this.memory.account.realisedPnl += delta.realisedPnl;
      this.persistMemoryState();
      return { ...this.memory.account };
    }
    await this.account(); // ensure the document exists before an upsert-by-$inc
    const inc: Record<string, number> = {};
    if (delta.balance) inc.balance = delta.balance;
    if (delta.realisedPnl) inc.realisedPnl = delta.realisedPnl;
    const doc = await AccountModel.findOneAndUpdate(
      { key: this.tenantId },
      { $inc: inc },
      { new: true, upsert: true }
    ).lean();
    return {
      balance: doc!.balance,
      startingBalance: doc!.startingBalance,
      realisedPnl: doc!.realisedPnl,
      peakEquity: doc!.peakEquity,
      dayStartEquity: doc!.dayStartEquity || doc!.startingBalance,
      dayKey: doc!.dayKey || new Date().toISOString().slice(0, 10),
    };
  }

  /**
   * Atomically raise the recorded equity peak, never lower it.
   *
   * Drawdown protection compares live equity against this peak, so it must
   * never regress from a stale read racing a concurrent update. `$max` is
   * evaluated by MongoDB against the stored value, so concurrent callers can
   * only ever push it up, never clobber a higher value with an older one.
   *
   * @param equity current equity to consider as the new peak.
   */
  async applyPeakEquity(equity: number): Promise<void> {
    if (!this.connected) {
      const prev = this.memory.account.peakEquity;
      this.memory.account.peakEquity = Math.max(this.memory.account.peakEquity, equity);
      if (this.memory.account.peakEquity !== prev) this.persistMemoryState();
      return;
    }
    await AccountModel.updateOne({ key: this.tenantId }, { $max: { peakEquity: equity } }, { upsert: true });
  }

  /**
   * Roll the daily loss-limit baseline over to a new day, exactly once.
   *
   * Only writes when the stored day key still differs from `dayKey`, so two
   * concurrent cycles racing the day boundary cannot both roll it (which would
   * reset `dayStartEquity` twice and undercount the day's realised loss).
   *
   * @param dayKey the new day, `YYYY-MM-DD`.
   * @param dayStartEquity equity to baseline the new day against.
   */
  async rollDay(dayKey: string, dayStartEquity: number): Promise<void> {
    if (!this.connected) {
      if (this.memory.account.dayKey === dayKey) return;
      this.memory.account.dayKey = dayKey;
      this.memory.account.dayStartEquity = dayStartEquity;
      this.persistMemoryState();
      return;
    }
    await AccountModel.updateOne(
      { key: this.tenantId, dayKey: { $ne: dayKey } },
      { $set: { dayKey, dayStartEquity } },
      { upsert: true }
    );
  }

  /**
   * List positions by status.
   *
   * @param status `OPEN` or `CLOSED`.
   * @param limit max number of documents to return.
   * @returns matching positions, newest first for closed trades.
   */
  async positions(status: 'OPEN' | 'CLOSED', limit = 200): Promise<Position[]> {
    if (!this.connected) {
      return this.memory.positions
        .filter((p) => p.status === status)
        .sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt))
        .slice(0, limit)
        .map((p) => ({ ...p }));
    }
    const docs = await PositionModel.find({ status, tenantId: this.tenantId })
      .sort({ openedAt: -1 })
      .limit(limit)
      .lean();
    return docs.map((doc) => toPosition(doc as unknown as Record<string, unknown>));
  }

  /**
   * Fetch a single position by id.
   *
   * @param id position id.
   * @returns the position, or null when it does not exist.
   */
  async position(id: string): Promise<Position | null> {
    if (!this.connected) {
      const found = this.memory.positions.find((p) => p.id === id);
      return found ? { ...found } : null;
    }
    const doc = await PositionModel.findOne({ id, tenantId: this.tenantId }).lean();
    return doc ? toPosition(doc as unknown as Record<string, unknown>) : null;
  }

  /**
   * Get the current adaptive self-learning state.
   */
  async learning(): Promise<LearningState> {
    return this.memory.learning || { factorStats: {}, penalties: {} };
  }

  /**
   * Update the adaptive self-learning state and persist it.
   */
  async updateLearning(patch: Partial<LearningState>): Promise<void> {
    this.memory.learning = {
      factorStats: { ...this.memory.learning.factorStats, ...(patch.factorStats || {}) },
      penalties: { ...this.memory.learning.penalties, ...(patch.penalties || {}) },
    };
    this.persistMemoryState();
  }

  /**
   * Insert a newly opened position.
   *
   * @param position the position to store.
   */
  async insertPosition(position: Position): Promise<void> {
    if (!this.connected) {
      this.memory.positions.push(position);
      this.persistMemoryState();
      return;
    }
    await PositionModel.create({ ...position, tenantId: this.tenantId });
  }

  /**
   * Update mutable fields of an existing position.
   *
   * @param id position id.
   * @param patch fields to update.
   */
  async updatePosition(id: string, patch: Partial<Position>): Promise<void> {
    if (!this.connected) {
      const idx = this.memory.positions.findIndex((p) => p.id === id);
      if (idx >= 0) {
        this.memory.positions[idx] = { ...this.memory.positions[idx], ...patch };
        this.persistMemoryState();
      }
      return;
    }
    await PositionModel.updateOne({ id, tenantId: this.tenantId }, { $set: patch });
  }

  /**
   * Atomically transition a position from OPEN to CLOSED.
   *
   * The engine cycle and a manual close can run concurrently, so settlement must
   * claim the position exactly once — otherwise the pnl would be credited twice.
   *
   * @param id position id.
   * @param patch closing fields to write.
   * @returns true when this caller won the race and the position was closed.
   */
  async settlePosition(id: string, patch: Partial<Position>): Promise<boolean> {
    if (!this.connected) {
      const idx = this.memory.positions.findIndex((p) => p.id === id && p.status === 'OPEN');
      if (idx < 0) return false;
      this.memory.positions[idx] = { ...this.memory.positions[idx], ...patch, status: 'CLOSED' };
      this.persistMemoryState();
      return true;
    }
    const res = await PositionModel.updateOne(
      { id, status: 'OPEN', tenantId: this.tenantId },
      { $set: { ...patch, status: 'CLOSED' } }
    );
    return res.modifiedCount === 1;
  }

  /**
   * Append an engine log line.
   *
   * @param event the event to store.
   */
  async addEvent(event: EngineEvent): Promise<void> {
    if (!this.connected) {
      this.memory.events.unshift(event);
      this.memory.events = this.memory.events.slice(0, 300);
      return;
    }
    await EventModel.create({ ...event, tenantId: this.tenantId });
    this.eventsSincePrune += 1;
    // Keep the log bounded so it cannot grow without limit over a long run.
    if (this.eventsSincePrune >= 200) {
      this.eventsSincePrune = 0;
      const cutoff = await EventModel.find({ tenantId: this.tenantId }).sort({ at: -1 }).skip(1000).limit(1).lean();
      if (cutoff.length)
        await EventModel.deleteMany({ tenantId: this.tenantId, at: { $lt: cutoff[0].at } });
    }
  }

  /**
   * Read the most recent engine log lines.
   *
   * @param limit max number of lines.
   * @returns events, newest first.
   */
  async events(limit = 80): Promise<EngineEvent[]> {
    if (!this.connected) return this.memory.events.slice(0, limit);
    const docs = await EventModel.find({ tenantId: this.tenantId }).sort({ at: -1 }).limit(limit).lean();
    return docs.map((d) => ({ at: d.at, level: d.level as EngineEvent['level'], message: d.message }));
  }

  /**
   * Wipe all trading history and reset the account to its starting balance.
   */
  async reset(): Promise<void> {
    const fresh: AccountState = {
      balance: STARTING_BALANCE,
      startingBalance: STARTING_BALANCE,
      realisedPnl: 0,
      peakEquity: STARTING_BALANCE,
      dayStartEquity: STARTING_BALANCE,
      dayKey: new Date().toISOString().slice(0, 10),
    };
    if (!this.connected) {
      this.memory = {
        positions: [],
        events: [],
        account: fresh,
        scout: this.memory.scout,
        exchangeCredentials: this.memory.exchangeCredentials,
        learning: { factorStats: {}, penalties: {} },
      };
      return;
    }
    await Promise.all([
      PositionModel.deleteMany({ tenantId: this.tenantId }),
      EventModel.deleteMany({ tenantId: this.tenantId }),
    ]);
    await this.saveAccount(fresh);
  }

  /**
   * Read persisted market-scout state, seeding it on first run.
   *
   * @returns admitted extra symbols and active cooldowns.
   */
  async scoutState(): Promise<ScoutState> {
    if (!this.connected) return { ...this.memory.scout };
    const existing = await ScoutModel.findOne({ key: this.tenantId }).lean();
    if (existing) {
      return {
        universeExtras: existing.universeExtras || [],
        cooldowns: existing.cooldowns || {},
        lastRunAt: existing.lastRunAt ?? null,
      };
    }
    await ScoutModel.create({ key: this.tenantId, universeExtras: [], cooldowns: {} });
    return { universeExtras: [], cooldowns: {}, lastRunAt: null };
  }

  /**
   * Admit a symbol into the persisted live universe.
   *
   * `$addToSet` makes this idempotent — re-admitting an already-approved symbol
   * (e.g. a retry after a crash) never creates a duplicate entry.
   *
   * @param symbol contract symbol that cleared the scout's backtest bar.
   */
  async addScoutUniverseSymbol(symbol: string): Promise<void> {
    if (!this.connected) {
      if (!this.memory.scout.universeExtras.includes(symbol)) this.memory.scout.universeExtras.push(symbol);
      return;
    }
    await ScoutModel.updateOne({ key: this.tenantId }, { $addToSet: { universeExtras: symbol } }, { upsert: true });
  }

  /**
   * Put a symbol on cooldown after it fails the scout's backtest bar, so the
   * next scan does not immediately retest the same rejected market.
   *
   * @param symbol contract symbol that failed.
   * @param until unix ms timestamp after which it may be retested.
   */
  async setScoutCooldown(symbol: string, until: number): Promise<void> {
    if (!this.connected) {
      this.memory.scout.cooldowns[symbol] = until;
      return;
    }
    await ScoutModel.updateOne(
      { key: this.tenantId },
      { $set: { [`cooldowns.${symbol}`]: until } },
      { upsert: true }
    );
  }

  /**
   * Record when the scout last completed a run.
   *
   * @param at unix ms timestamp.
   */
  async setScoutLastRun(at: number): Promise<void> {
    if (!this.connected) {
      this.memory.scout.lastRunAt = at;
      return;
    }
    await ScoutModel.updateOne({ key: this.tenantId }, { $set: { lastRunAt: at } }, { upsert: true });
  }

  /**
   * Read the MEXC API credentials entered from the dashboard, if any.
   *
   * These take priority over the `MEXC_API_KEY` / `MEXC_API_SECRET` environment
   * variables so a shared deployment can be handed to someone else and they
   * connect their own MEXC account from the UI, without needing access to the
   * hosting environment's configuration.
   *
   * @returns the stored credentials, or empty strings when none are set.
   */
  async exchangeCredentials(): Promise<ExchangeCredentials> {
    if (!this.connected) {
      if (this.memory.exchangeCredentials.apiKey && this.memory.exchangeCredentials.apiSecret) {
        return { ...this.memory.exchangeCredentials };
      }
      const disk = readStoredCredentialsFile();
      if (disk.apiKey && disk.apiSecret) {
        this.memory.exchangeCredentials = { apiKey: disk.apiKey, apiSecret: disk.apiSecret };
        if (disk.liveTrading) process.env.LIVE_TRADING_ENABLED = 'true';
        return { ...this.memory.exchangeCredentials };
      }
      if (process.env.MEXC_API_KEY && process.env.MEXC_API_SECRET) {
        return { apiKey: process.env.MEXC_API_KEY, apiSecret: process.env.MEXC_API_SECRET };
      }
      return { ...this.memory.exchangeCredentials };
    }
    const doc = await ExchangeCredentialsModel.findOne({ key: this.tenantId }).lean();
    if (doc?.apiKey && doc?.apiSecret) {
      return { apiKey: doc.apiKey, apiSecret: doc.apiSecret };
    }
    const disk = readStoredCredentialsFile();
    return { apiKey: disk.apiKey || '', apiSecret: disk.apiSecret || '' };
  }

  /**
   * Save (or clear, when passed empty strings) the MEXC API credentials
   * entered from the dashboard.
   *
   * @param credentials the API key and secret to store.
   */
  async saveExchangeCredentials(credentials: ExchangeCredentials): Promise<void> {
    this.memory.exchangeCredentials = { ...credentials };
    writeStoredCredentialsFile({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      liveTrading: Boolean(credentials.apiKey && credentials.apiSecret && process.env.LIVE_TRADING_ENABLED === 'true'),
    });
    if (credentials.apiKey && credentials.apiSecret) {
      process.env.MEXC_API_KEY = credentials.apiKey;
      process.env.MEXC_API_SECRET = credentials.apiSecret;
    } else {
      delete process.env.MEXC_API_KEY;
      delete process.env.MEXC_API_SECRET;
      process.env.LIVE_TRADING_ENABLED = 'false';
    }
    if (this.connected) {
      await ExchangeCredentialsModel.updateOne({ key: this.tenantId }, { $set: credentials }, { upsert: true });
    }
  }
}

/**
 * Persisted account fields owned by the store.
 */
export type AccountState = {
  balance: number;
  startingBalance: number;
  realisedPnl: number;
  peakEquity: number;
  dayStartEquity: number;
  dayKey: string;
};

/**
 * Persisted market-scout fields owned by the store.
 */
export type ScoutState = {
  universeExtras: string[];
  /** Symbol -> unix ms timestamp until which it should not be retested. */
  cooldowns: Record<string, number>;
  lastRunAt: number | null;
};

/**
 * MEXC API credentials entered from the dashboard and persisted by the store.
 */
export type ExchangeCredentials = {
  apiKey: string;
  apiSecret: string;
};

function toPosition(doc: Record<string, unknown>): Position {
  return {
    id: String(doc.id),
    symbol: String(doc.symbol),
    side: doc.side as Side,
    entry: Number(doc.entry),
    quantity: Number(doc.quantity),
    leverage: Number(doc.leverage),
    margin: Number(doc.margin),
    notional: Number(doc.notional),
    stopLoss: Number(doc.stopLoss),
    takeProfit: Number(doc.takeProfit),
    takeProfits: Array.isArray(doc.takeProfits)
      ? (doc.takeProfits as Record<string, unknown>[]).map((t) => ({
          price: Number(t.price),
          portion: Number(t.portion),
          rMultiple: Number(t.rMultiple),
          hit: Boolean(t.hit),
          hitAt: t.hitAt === undefined ? undefined : Number(t.hitAt),
          realised: t.realised === undefined ? undefined : Number(t.realised),
        }))
      : [],
    remainingQuantity: Number(doc.remainingQuantity ?? doc.quantity),
    realisedPnl: Number(doc.realisedPnl ?? 0),
    entryFee: Number(doc.entryFee ?? 0),
    initialRisk: Number(doc.initialRisk ?? 0),
    breakEven: Boolean(doc.breakEven),
    extreme: Number(doc.extreme),
    trailingArmed: Boolean(doc.trailingArmed),
    regimeTrimmed: Boolean(doc.regimeTrimmed),
    openedAt: Number(doc.openedAt),
    closedAt: doc.closedAt ? Number(doc.closedAt) : undefined,
    exit: doc.exit ? Number(doc.exit) : undefined,
    pnl: doc.pnl !== undefined ? Number(doc.pnl) : undefined,
    pnlPct: doc.pnlPct !== undefined ? Number(doc.pnlPct) : undefined,
    exitReason: doc.exitReason as Position['exitReason'],
    status: doc.status as 'OPEN' | 'CLOSED',
    confidence: Number(doc.confidence || 0),
    regime: (doc.regime as Position['regime']) || 'CHOP',
    reasons: (doc.reasons as string[]) || [],
    live: Boolean(doc.live),
    liveContractSize: doc.liveContractSize !== undefined ? Number(doc.liveContractSize) : undefined,
    liveOrderId: doc.liveOrderId as string | undefined,
    liveStopOrderId: (doc.liveStopOrderId as string | undefined) ?? null,
    postMortem: doc.postMortem ? (doc.postMortem as Position['postMortem']) : undefined,
    entryChecks: Array.isArray(doc.entryChecks) ? (doc.entryChecks as Position['entryChecks']) : undefined,
  };
}
