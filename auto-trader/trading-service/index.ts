export { TradingService, computeStats } from './trading-service.js';
export type { Snapshot, Stats } from './trading-service.js';
export { Engine, CORE_UNIVERSE, MEME_UNIVERSE } from './engine.js';
export { MarketData, isCryptoPerp } from './market-data.js';
export type { ContractDetail } from './market-data.js';
export { Store } from './store.js';
export {
  DEFAULT_RISK,
  concentrationBlock,
  correlationGroup,
  isPositionDerisked,
  planTrade,
  tradingBlockedReason,
} from './risk.js';
export { buildSignal, detectRegime, checkLtfReversal } from './strategy.js';
export {
  MexcExchangeAdapter,
  hasExchangeCredentials,
  isLiveTradingEnabled,
  signRequest,
  toSortedQuery,
} from './exchange-adapter.js';
export type {
  ClosePositionInput,
  ExchangeAccountAsset,
  ExchangeOrderResult,
  ExchangePosition,
  LiveTradingStatus,
  OpenType,
  OrderIntent,
  PlaceOrderInput,
} from './exchange-adapter.js';
export { Backtest } from './backtest.js';
export type { MarketHistory } from './backtest.js';
export { BacktestRunner, normaliseConfig } from './backtest-runner.js';
export { Optimizer, buildGrid, score, applyCandidate } from './optimizer.js';
export type { Candidate, Trial } from './optimizer.js';
export { OptimizerRunner, bestParams } from './optimizer-runner.js';
export {
  getMarketSession,
  computeAsianRange,
  sessionWeightModifiers,
} from './sessions.js';
export type { SessionInfo, AsianRange } from './sessions.js';
export {
  findPivots,
  getDealingRange,
  detectFairValueGaps,
  detectOrderBlocks,
  detectLiquiditySweep,
  detectMarketStructureBreaks,
  planImbalanceScalp,
  computeVolumeProfile,
  detectSmtDivergence,
  analyzeMarketStructure,
} from './market-structure.js';
export type {
  Account,
  BacktestConfig,
  BacktestResult,
  BacktestStatus,
  BacktestTrade,
  BlockedState,
  Candle,
  EngineEvent,
  EquityPoint,
  MarketSession,
  OptimizeStatus,
  OptimizeTrial,
  Position,
  Regime,
  RiskConfig,
  Side,
  Signal,
  Ticker,
  TradePlan,
} from './types.js';
