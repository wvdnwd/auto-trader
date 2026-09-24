import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { AccountModel, EventModel, ExchangeCredentialsModel, PositionModel, ScoutModel } from './models.js';
import type { EngineEvent, LearningState, Position, Side } from './types.js';

const STARTING_BALANCE = Number(process.env.PAPER_START_BALANCE || 10_000);

export function getStoreStateFilePath(): string {
  const dir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir, 'store-main.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Persistence layer for the paper trading engine.
 *
 * All data access goes through this repository. The service deliberately uses
 * one fixed `main` account; request headers cannot select a storage namespace.
 */
export class Store {
  private readonly tenantId = 'main';
  private connected = false;
  private storageFailed = false;
  private failureHandler?: () => void;

  private eventsSincePrune = 0;

  isHealthy(): boolean {
    return !this.storageFailed;
  }

  onFailure(handler: () => void): void {
    this.failureHandler = handler;
    if (this.storageFailed) handler();
  }

  private assertHealthy(): void {
    if (this.storageFailed) throw new Error('Trading storage is unavailable');
  }

  private async storageOperation<T>(operation: () => PromiseLike<T>): Promise<T> {
    this.assertHealthy();
    try {
      return await operation();
    } catch {
      this.storageFailed = true;
      this.failureHandler?.();
      throw new Error('Trading storage operation failed');
    }
  }

  private async migrateLegacyPositions(): Promise<void> {
    await this.storageOperation(() => PositionModel.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: this.tenantId } }
    ));
  }

  constructor() {
    this.loadMemoryState();
  }

  /** Runtime state used only for explicitly enabled non-live local development. */
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
    exchangeCredentials: { apiKey: '', apiSecret: '', walletAddress: '', privateKey: '', isTestnet: false, venue: 'mexc' },
    learning: { factorStats: {}, penalties: {} },
  };

  private loadMemoryState(): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    const p = getStoreStateFilePath();
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (!isRecord(raw)) {
      throw new Error('Stored trading state is invalid');
    }
    if (raw.positions !== undefined && !Array.isArray(raw.positions)) throw new Error('Stored positions are invalid');
    if (raw.events !== undefined && !Array.isArray(raw.events)) throw new Error('Stored events are invalid');
    for (const position of (raw.positions || []) as unknown[]) {
      if (!isRecord(position) ||
          typeof position.id !== 'string' ||
          typeof position.symbol !== 'string' ||
          !['LONG', 'SHORT'].includes(String(position.side)) ||
          !['OPEN', 'CLOSED'].includes(String(position.status)) ||
          !['entry', 'quantity', 'leverage', 'margin', 'notional', 'stopLoss', 'takeProfit', 'openedAt']
            .every((field) => Number.isFinite(position[field]))) {
        throw new Error('Stored position data is invalid');
      }
    }
    for (const event of (raw.events || []) as unknown[]) {
      if (!isRecord(event) || !Number.isFinite(event.at) || typeof event.message !== 'string') {
        throw new Error('Stored event data is invalid');
      }
    }
    for (const field of ['account', 'scout', 'learning']) {
      const value = raw[field];
      if (value !== undefined && !isRecord(value)) {
        throw new Error(`Stored ${field} state is invalid`);
      }
    }
    if (isRecord(raw.account) &&
        !['balance', 'startingBalance', 'realisedPnl', 'peakEquity']
          .every((field) => Number.isFinite(raw.account![field]))) {
      throw new Error('Stored account balances are invalid');
    }
    if (isRecord(raw.scout) &&
        (raw.scout.universeExtras !== undefined && !Array.isArray(raw.scout.universeExtras) ||
          raw.scout.cooldowns !== undefined && !isRecord(raw.scout.cooldowns))) {
      throw new Error('Stored scout state is invalid');
    }
    if (isRecord(raw.learning) &&
        (raw.learning.factorStats !== undefined && !isRecord(raw.learning.factorStats) ||
          raw.learning.penalties !== undefined && !isRecord(raw.learning.penalties))) {
      throw new Error('Stored learning state is invalid');
    }
    if (Array.isArray(raw.positions)) {
      this.memory.positions = (raw.positions as Position[]).map((position) => ({
        ...position,
        // Old records cannot prove whether a scale-in happened; keep their R neutral.
        scaleInCount: position.scaleInCount ?? 1,
      }));
    }
    if (Array.isArray(raw.events)) this.memory.events = raw.events as EngineEvent[];
    if (raw.account && typeof raw.account === 'object') {
      this.memory.account = { ...this.memory.account, ...raw.account } as AccountState;
    }
    if (raw.scout && typeof raw.scout === 'object') {
      this.memory.scout = { ...this.memory.scout, ...raw.scout } as ScoutState;
    }
    if (raw.learning && typeof raw.learning === 'object') {
      const learning = raw.learning as Partial<LearningState>;
      this.memory.learning = {
        factorStats: { ...this.memory.learning.factorStats, ...(learning.factorStats || {}) },
        penalties: { ...this.memory.learning.penalties, ...(learning.penalties || {}) },
      };
    }
  }

  private persistMemoryState(): void {
    if (this.connected || process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    this.assertHealthy();
    try {
      const p = getStoreStateFilePath();
      fs.writeFileSync(p, JSON.stringify({
        positions: this.memory.positions,
        events: this.memory.events,
        account: this.memory.account,
        scout: this.memory.scout,
        learning: this.memory.learning,
      }, null, 2), 'utf8');
    } catch {
      this.storageFailed = true;
      this.failureHandler?.();
      throw new Error('Trading storage write failed');
    }
  }

  /**
   * Connect to MongoDB. In-memory operation is allowed only when the service
   * explicitly opts in for non-live local development.
   */
  async connect(): Promise<boolean> {
    const url = process.env.MONGO_URL;
    if (!url) {
      if (process.env.ALLOW_IN_MEMORY_STORE === 'true') this.persistMemoryState();
      return false;
    }
    try {
      await mongoose.connect(url, { serverSelectionTimeoutMS: 5_000 });
      this.connected = true;
      await this.migrateLegacyPositions();
      await this.account();
      return true;
    } catch {
      this.connected = false;
      this.storageFailed = true;
      this.failureHandler?.();
      throw new Error('Persistent storage connection failed');
    }
  }

  /**
   * Read the account state, seeding it on first run.
   *
   * @returns the persisted account state.
   */
  async account(): Promise<AccountState> {
    this.assertHealthy();
    if (!this.connected) return this.memory.account;
    const existing = await this.storageOperation(() => AccountModel.findOne({ key: this.tenantId }).lean());
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
    await this.storageOperation(() => AccountModel.create({ key: this.tenantId, ...seeded }));
    return seeded;
  }

  /**
   * Persist the account state.
   *
   * @param state the new account state.
   */
  async saveAccount(state: AccountState): Promise<void> {
    this.assertHealthy();
    if (!this.connected) {
      this.memory.account = state;
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => AccountModel.updateOne({ key: this.tenantId }, { $set: state }, { upsert: true }));
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
    this.assertHealthy();
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
    const doc = await this.storageOperation(() => AccountModel.findOneAndUpdate(
      { key: this.tenantId },
      { $inc: inc },
      { new: true, upsert: true }
    ).lean());
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
    this.assertHealthy();
    if (!this.connected) {
      const prev = this.memory.account.peakEquity;
      this.memory.account.peakEquity = Math.max(this.memory.account.peakEquity, equity);
      if (this.memory.account.peakEquity !== prev) this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => AccountModel.updateOne({ key: this.tenantId }, { $max: { peakEquity: equity } }, { upsert: true }));
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
    this.assertHealthy();
    if (!this.connected) {
      if (this.memory.account.dayKey === dayKey) return;
      this.memory.account.dayKey = dayKey;
      this.memory.account.dayStartEquity = dayStartEquity;
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => AccountModel.updateOne(
      { key: this.tenantId, dayKey: { $ne: dayKey } },
      { $set: { dayKey, dayStartEquity } },
      { upsert: true }
    ));
  }

  /**
   * List positions by status.
   *
   * @param status `OPEN` or `CLOSED`.
   * @param limit max number of documents to return.
   * @returns matching positions, newest first for closed trades.
   */
  async positions(status: 'OPEN' | 'CLOSED', limit = 200): Promise<Position[]> {
    this.assertHealthy();
    if (!this.connected) {
      const matching = this.memory.positions
        .filter((p) => p.status === status)
        .sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt));
      return (limit > 0 ? matching.slice(0, limit) : matching).map((p) => ({ ...p }));
    }
    let query = PositionModel.find({ status, tenantId: this.tenantId }).sort({ openedAt: -1 });
    if (limit > 0) query = query.limit(limit);
    const docs = await this.storageOperation(() => query.lean());
    return docs.map((doc) => toPosition(doc as unknown as Record<string, unknown>));
  }

  /**
   * Fetch a single position by id.
   *
   * @param id position id.
   * @returns the position, or null when it does not exist.
   */
  async position(id: string): Promise<Position | null> {
    this.assertHealthy();
    if (!this.connected) {
      const found = this.memory.positions.find((p) => p.id === id);
      return found ? { ...found } : null;
    }
    const doc = await this.storageOperation(() => PositionModel.findOne({ id, tenantId: this.tenantId }).lean());
    return doc ? toPosition(doc as unknown as Record<string, unknown>) : null;
  }

  /**
   * Get the current adaptive self-learning state.
   */
  async learning(): Promise<LearningState> {
    this.assertHealthy();
    return this.memory.learning || { factorStats: {}, penalties: {} };
  }

  /**
   * Update the adaptive self-learning state and persist it.
   */
  async updateLearning(patch: Partial<LearningState>): Promise<void> {
    this.assertHealthy();
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
    this.assertHealthy();
    if (!this.connected) {
      this.memory.positions.push(position);
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => PositionModel.create({ ...position, tenantId: this.tenantId }));
  }

  /**
   * Update mutable fields of an existing position.
   *
   * @param id position id.
   * @param patch fields to update.
   */
  async updatePosition(id: string, patch: Partial<Position>): Promise<void> {
    this.assertHealthy();
    if (!this.connected) {
      const idx = this.memory.positions.findIndex((p) => p.id === id);
      if (idx >= 0) {
        this.memory.positions[idx] = { ...this.memory.positions[idx], ...patch };
        this.persistMemoryState();
      }
      return;
    }
    await this.storageOperation(() => PositionModel.updateOne({ id, tenantId: this.tenantId }, { $set: patch }));
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
    this.assertHealthy();
    if (!this.connected) {
      const idx = this.memory.positions.findIndex((p) => p.id === id && p.status === 'OPEN');
      if (idx < 0) return false;
      this.memory.positions[idx] = { ...this.memory.positions[idx], ...patch, status: 'CLOSED' };
      this.persistMemoryState();
      return true;
    }
    const res = await this.storageOperation(() => PositionModel.updateOne(
      { id, status: 'OPEN', tenantId: this.tenantId },
      { $set: { ...patch, status: 'CLOSED' } }
    ));
    return res.modifiedCount === 1;
  }

  /**
   * Append an engine log line.
   *
   * @param event the event to store.
   */
  async addEvent(event: EngineEvent): Promise<void> {
    this.assertHealthy();
    if (!this.connected) {
      this.memory.events.unshift(event);
      this.memory.events = this.memory.events.slice(0, 300);
      return;
    }
    await this.storageOperation(() => EventModel.create({ ...event, tenantId: this.tenantId }));
    this.eventsSincePrune += 1;
    // Keep the log bounded so it cannot grow without limit over a long run.
    if (this.eventsSincePrune >= 200) {
      this.eventsSincePrune = 0;
      const cutoff = await this.storageOperation(() => EventModel.find({ tenantId: this.tenantId }).sort({ at: -1 }).skip(1000).limit(1).lean());
      if (cutoff.length)
        await this.storageOperation(() => EventModel.deleteMany({ tenantId: this.tenantId, at: { $lt: cutoff[0].at } }));
    }
  }

  /**
   * Read the most recent engine log lines.
   *
   * @param limit max number of lines.
   * @returns events, newest first.
   */
  async events(limit = 80): Promise<EngineEvent[]> {
    this.assertHealthy();
    if (!this.connected) return this.memory.events.slice(0, limit);
    const docs = await this.storageOperation(() => EventModel.find({ tenantId: this.tenantId }).sort({ at: -1 }).limit(limit).lean());
    return docs.map((d) => ({ at: d.at, level: d.level as EngineEvent['level'], message: d.message }));
  }

  /**
   * Wipe all trading history and reset the account to its starting balance.
   */
  async reset(): Promise<void> {
    this.assertHealthy();
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
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => Promise.all([
      PositionModel.deleteMany({ tenantId: this.tenantId }),
      EventModel.deleteMany({ tenantId: this.tenantId }),
    ]));
    await this.saveAccount(fresh);
  }

  /**
   * Read persisted market-scout state, seeding it on first run.
   *
   * @returns admitted extra symbols and active cooldowns.
   */
  async scoutState(): Promise<ScoutState> {
    this.assertHealthy();
    if (!this.connected) return { ...this.memory.scout };
    const existing = await this.storageOperation(() => ScoutModel.findOne({ key: this.tenantId }).lean());
    if (existing) {
      return {
        universeExtras: existing.universeExtras || [],
        cooldowns: existing.cooldowns || {},
        lastRunAt: existing.lastRunAt ?? null,
      };
    }
    await this.storageOperation(() => ScoutModel.create({ key: this.tenantId, universeExtras: [], cooldowns: {} }));
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
    this.assertHealthy();
    if (!this.connected) {
      if (!this.memory.scout.universeExtras.includes(symbol)) this.memory.scout.universeExtras.push(symbol);
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => ScoutModel.updateOne({ key: this.tenantId }, { $addToSet: { universeExtras: symbol } }, { upsert: true }));
  }

  /**
   * Put a symbol on cooldown after it fails the scout's backtest bar, so the
   * next scan does not immediately retest the same rejected market.
   *
   * @param symbol contract symbol that failed.
   * @param until unix ms timestamp after which it may be retested.
   */
  async setScoutCooldown(symbol: string, until: number): Promise<void> {
    this.assertHealthy();
    if (!this.connected) {
      this.memory.scout.cooldowns[symbol] = until;
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => ScoutModel.updateOne(
      { key: this.tenantId },
      { $set: { [`cooldowns.${symbol}`]: until } },
      { upsert: true }
    ));
  }

  /**
   * Record when the scout last completed a run.
   *
   * @param at unix ms timestamp.
   */
  async setScoutLastRun(at: number): Promise<void> {
    this.assertHealthy();
    if (!this.connected) {
      this.memory.scout.lastRunAt = at;
      this.persistMemoryState();
      return;
    }
    await this.storageOperation(() => ScoutModel.updateOne({ key: this.tenantId }, { $set: { lastRunAt: at } }, { upsert: true }));
  }

  /**
   * Read credentials for the single service, falling back only to its process
   * environment when no stored main-instance credentials exist.
   *
   * @returns the stored credentials, or empty strings when none are set.
   */
  async exchangeCredentials(): Promise<ExchangeCredentials> {
    this.assertHealthy();
    if (this.connected) {
      const doc = await this.storageOperation(() => ExchangeCredentialsModel.findOne({ key: this.tenantId }).lean());
      if (doc) {
        const d = doc as unknown as Record<string, unknown>;
        if (d.apiKey || d.walletAddress) {
          return {
            apiKey: (d.apiKey as string) || '',
            apiSecret: (d.apiSecret as string) || '',
            walletAddress: (d.walletAddress as string) || '',
            privateKey: (d.privateKey as string) || '',
            isTestnet: Boolean(d.isTestnet),
            venue: (d.venue as 'mexc' | 'hyperliquid') || (d.apiKey ? 'mexc' : 'hyperliquid'),
          };
        }
      }
    }
    if (this.memory.exchangeCredentials.apiKey || this.memory.exchangeCredentials.walletAddress) {
      return { ...this.memory.exchangeCredentials };
    }
    return {
      apiKey: process.env.MEXC_API_KEY || '',
      apiSecret: process.env.MEXC_API_SECRET || '',
      walletAddress: process.env.HYPERLIQUID_WALLET || '',
      privateKey: process.env.HYPERLIQUID_PRIVATE_KEY || '',
      isTestnet: process.env.HYPERLIQUID_TESTNET === 'true',
      venue: (process.env.EXCHANGE_VENUE as 'mexc' | 'hyperliquid') || (process.env.HYPERLIQUID_WALLET ? 'hyperliquid' : 'mexc'),
    };
  }

  /**
   * Save (or clear, when passed empty strings) the MEXC API credentials
   * entered from the dashboard.
   *
   * @param credentials the API key and secret to store.
   */
  async saveExchangeCredentials(credentials: ExchangeCredentials): Promise<void> {
    this.assertHealthy();
    if (this.connected) {
      await this.storageOperation(() => ExchangeCredentialsModel.updateOne({ key: this.tenantId }, { $set: credentials }, { upsert: true }));
    }
    this.memory.exchangeCredentials = { ...credentials };
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
   * MEXC API credentials persisted for the single service instance.
 */
export type ExchangeCredentials = {
  apiKey?: string;
  apiSecret?: string;
  walletAddress?: string;
  privateKey?: string;
  isTestnet?: boolean;
  venue?: 'mexc' | 'hyperliquid';

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
    scaleInCount: doc.scaleInCount === undefined ? 1 : Number(doc.scaleInCount),
    scaledInAt: doc.scaledInAt === undefined ? undefined : Number(doc.scaledInAt),
    scaleInMargin: doc.scaleInMargin === undefined ? undefined : Number(doc.scaleInMargin),
    profitLockR: doc.profitLockR === undefined ? undefined : Number(doc.profitLockR),
    climaxTrimmed: Boolean(doc.climaxTrimmed),
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
