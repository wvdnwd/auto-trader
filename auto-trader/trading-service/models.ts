import { getModelForClass, modelOptions, prop } from '@typegoose/typegoose';

/**
 * A staged profit target stored inside a position document.
 */
export class TakeProfitDoc {
  @prop({ type: () => Number, required: true })
  public price!: number;

  @prop({ type: () => Number, required: true })
  public portion!: number;

  @prop({ type: () => Number, required: true })
  public rMultiple!: number;

  @prop({ type: () => Boolean, default: false })
  public hit!: boolean;

  @prop({ type: () => Number })
  public hitAt?: number;

  @prop({ type: () => Number })
  public realised?: number;
}

/**
 * Persisted paper position document.
 */
@modelOptions({ schemaOptions: { collection: 'positions', timestamps: true } })
export class PositionDoc {
  /**
   * Fixed service namespace. The HTTP API does not accept tenant selection.
   */
  @prop({ type: () => String, required: true, default: 'main', index: true })
  public tenantId!: string;

  @prop({ type: () => String, required: true, unique: true })
  public id!: string;

  @prop({ type: () => String, required: true, index: true })
  public symbol!: string;

  @prop({ type: () => String, required: true })
  public side!: string;

  @prop({ type: () => Number, required: true })
  public entry!: number;

  @prop({ type: () => Number, required: true })
  public quantity!: number;

  @prop({ type: () => Number, required: true })
  public leverage!: number;

  @prop({ type: () => Number, required: true })
  public margin!: number;

  @prop({ type: () => Number, required: true })
  public notional!: number;

  @prop({ type: () => Number, required: true })
  public stopLoss!: number;

  @prop({ type: () => Number, required: true })
  public takeProfit!: number;

  @prop({ type: () => [TakeProfitDoc], default: [] })
  public takeProfits!: TakeProfitDoc[];

  @prop({ type: () => Number, required: true })
  public remainingQuantity!: number;

  @prop({ type: () => Number, default: 0 })
  public realisedPnl!: number;

  @prop({ type: () => Number, default: 0 })
  public entryFee!: number;

  @prop({ type: () => Number, default: 0 })
  public initialRisk!: number;

  @prop({ type: () => Boolean, default: false })
  public breakEven!: boolean;

  @prop({ type: () => Number, required: true })
  public extreme!: number;

  @prop({ type: () => Boolean, default: false })
  public trailingArmed!: boolean;

  /** True once this position has already been trimmed for an adverse regime flip. */
  @prop({ type: () => Boolean, default: false })
  public regimeTrimmed?: boolean;

  @prop({ type: () => Number, default: 0 })
  public scaleInCount?: number;

  @prop({ type: () => Number })
  public scaledInAt?: number;

  @prop({ type: () => Number })
  public scaleInMargin?: number;

  @prop({ type: () => Number })
  public profitLockR?: number;

  @prop({ type: () => Boolean, default: false })
  public climaxTrimmed?: boolean;

  @prop({ type: () => Number, required: true })
  public openedAt!: number;

  @prop({ type: () => Number })
  public closedAt?: number;

  @prop({ type: () => Number })
  public exit?: number;

  @prop({ type: () => Number })
  public pnl?: number;

  @prop({ type: () => Number })
  public pnlPct?: number;

  @prop({ type: () => String })
  public exitReason?: string;

  @prop({ type: () => String, required: true, index: true })
  public status!: string;

  @prop({ type: () => Number, default: 0 })
  public confidence!: number;

  @prop({ type: () => String, default: 'CHOP' })
  public regime!: string;

  @prop({ type: () => [String], default: [] })
  public reasons!: string[];

  /** True when this position was mirrored onto the real MEXC account at entry. */
  @prop({ type: () => Boolean, default: false })
  public live?: boolean;

  /** Contract size used to convert this position's quantity into MEXC's `vol` units. */
  @prop({ type: () => Number })
  public liveContractSize?: number;

  /** Venue order id for the entry order, when `live`. */
  @prop({ type: () => String })
  public liveOrderId?: string;

  /** Venue order id of the currently resting protective stop order, when `live`. */
  @prop({ type: () => String })
  public liveStopOrderId?: string;

  /** Post-mortem report generated at trade exit. */
  @prop({ type: () => Object })
  public postMortem?: Record<string, unknown>;
}

/**
 * Persisted account state — a single singleton document.
 */
@modelOptions({ schemaOptions: { collection: 'account', timestamps: true } })
export class AccountDoc {
  /** Fixed service namespace; request headers cannot select an account. */
  @prop({ type: () => String, required: true, unique: true, default: 'main' })
  public key!: string;

  @prop({ type: () => Number, required: true })
  public balance!: number;

  @prop({ type: () => Number, required: true })
  public startingBalance!: number;

  @prop({ type: () => Number, required: true })
  public realisedPnl!: number;

  @prop({ type: () => Number, required: true })
  public peakEquity!: number;

  @prop({ type: () => Number, default: 0 })
  public dayStartEquity!: number;

  @prop({ type: () => String, default: '' })
  public dayKey!: string;
}

/**
 * Persisted engine log line.
 */
@modelOptions({ schemaOptions: { collection: 'events' } })
export class EventDoc {
  /** Fixed service namespace; request headers cannot select an account. */
  @prop({ type: () => String, required: true, default: 'main', index: true })
  public tenantId!: string;

  @prop({ type: () => Number, required: true, index: true })
  public at!: number;

  @prop({ type: () => String, required: true })
  public level!: string;

  @prop({ type: () => String, required: true })
  public message!: string;
}

/**
 * Persisted market-scout state — a single singleton document.
 *
 * Tracks which scout-discovered symbols have been admitted into the live
 * universe and which are serving a cooldown after failing their backtest bar,
 * so both survive a service restart.
 */
@modelOptions({ schemaOptions: { collection: 'scout', timestamps: true } })
export class ScoutDoc {
  /** Fixed service namespace; request headers cannot select an account. */
  @prop({ type: () => String, required: true, unique: true, default: 'main' })
  public key!: string;

  @prop({ type: () => [String], default: [] })
  public universeExtras!: string[];

  /** Symbol -> unix ms timestamp until which it should not be retested. */
  @prop({ type: () => Object, default: {} })
  public cooldowns!: Record<string, number>;

  @prop({ type: () => Number })
  public lastRunAt?: number;
}

/**
 * Persisted MEXC API credentials — a single singleton document.
 *
 * Credentials belong to the one explicitly authenticated service instance.
 * Live execution remains disarmed independently of whether keys are present.
 */
@modelOptions({ schemaOptions: { collection: 'exchange_credentials', timestamps: true } })
export class ExchangeCredentialsDoc {
  /** Fixed service namespace; request headers cannot select an account. */
  @prop({ type: () => String, required: true, unique: true, default: 'main' })
  public key!: string;

  @prop({ type: () => String, default: '' })
  public apiKey!: string;

  @prop({ type: () => String, default: '' })
  public apiSecret!: string;

  @prop({ type: () => String, default: '' })
  public walletAddress?: string;

  @prop({ type: () => String, default: '' })
  public privateKey?: string;

  @prop({ type: () => Boolean, default: false })
  public isTestnet?: boolean;

  @prop({ type: () => String, default: 'mexc' })
  public venue?: string;
}

export const PositionModel = getModelForClass(PositionDoc);
export const AccountModel = getModelForClass(AccountDoc);
export const EventModel = getModelForClass(EventDoc);
export const ScoutModel = getModelForClass(ScoutDoc);
export const ExchangeCredentialsModel = getModelForClass(ExchangeCredentialsDoc);
