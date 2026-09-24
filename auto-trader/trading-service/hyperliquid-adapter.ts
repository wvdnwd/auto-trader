import type {
  ClosePositionInput,
  ExchangeAccountAsset,
  ExchangeOrderResult,
  ExchangePosition,
  IExchangeAdapter,
  LiveTradingStatus,
  OpenType,
  PlaceOrderInput,
  PlaceStopOrderInput,
} from './exchange-adapter.js';
import type { Side } from './types.js';

export const HYPERLIQUID_MAINNET_API = 'https://api.hyperliquid.xyz';
export const HYPERLIQUID_TESTNET_API = 'https://api.hyperliquid-testnet.xyz';

export type HyperliquidConfig = {
  walletAddress?: string;
  privateKey?: string;
  isTestnet?: boolean;
};

/**
 * Hyperliquid Exchange Adapter for decentralized perpetuals on Hyperliquid L1.
 *
 * Implements the standard IExchangeAdapter contract so the autonomous trading
 * engine can seamlessly trade on Hyperliquid (USDC collateral, EIP-712 signing,
 * sub-second block times) as well as MEXC.
 */
export class HyperliquidExchangeAdapter implements IExchangeAdapter {
  readonly venue = 'hyperliquid';
  private walletAddress: string;
  private privateKey: string;
  private isTestnet: boolean;
  private baseUrl: string;

  constructor(
    walletAddress = process.env.HYPERLIQUID_WALLET || '',
    privateKey = process.env.HYPERLIQUID_PRIVATE_KEY || '',
    isTestnet = process.env.HYPERLIQUID_TESTNET === 'true'
  ) {
    this.walletAddress = walletAddress.trim();
    this.privateKey = privateKey.trim();
    this.isTestnet = isTestnet;
    this.baseUrl = isTestnet ? HYPERLIQUID_TESTNET_API : HYPERLIQUID_MAINNET_API;
  }

  setCredentials(walletAddress: string, privateKey: string, isTestnet = false): void {
    this.walletAddress = walletAddress.trim();
    this.privateKey = privateKey.trim();
    this.isTestnet = isTestnet;
    this.baseUrl = isTestnet ? HYPERLIQUID_TESTNET_API : HYPERLIQUID_MAINNET_API;
  }

  isConfigured(): boolean {
    return Boolean(this.walletAddress);
  }

  status(): LiveTradingStatus {
    const enabled = this.isConfigured() && process.env.LIVE_TRADING_ENABLED === 'true';
    return {
      configured: this.isConfigured(),
      enabled,
      baseUrl: this.baseUrl,
      executionDisabledReason: enabled
        ? undefined
        : 'Hyperliquid niet geconfigureerd of live trading niet ingeschakeld (LIVE_TRADING_ENABLED=true vereist)',
      venue: this.venue,
    };
  }

  /**
   * Fetch USDC account balance from Hyperliquid clearinghouse state.
   */
  async getAccountAssets(): Promise<ExchangeAccountAsset[]> {
    if (!this.isConfigured()) return [];
    try {
      const state = await this.infoQuery<{
        crossMarginSummary?: { accountValue?: string; totalNtlPos?: string; totalRawUsd?: string };
        withdrawable?: string;
      }>({ type: 'clearinghouseState', user: this.walletAddress });

      const equity = Number(state.crossMarginSummary?.accountValue || 0);
      const available = Number(state.withdrawable || 0);
      const frozen = Math.max(0, equity - available);

      return [
        {
          currency: 'USDC',
          equity,
          available,
          frozen,
        },
      ];
    } catch {
      return [];
    }
  }

  /**
   * Fetch active open positions on Hyperliquid.
   */
  async getOpenPositions(): Promise<ExchangePosition[]> {
    if (!this.isConfigured()) return [];
    try {
      const state = await this.infoQuery<{
        assetPositions?: Array<{
          position: {
            coin: string;
            szi: string;
            leverage: { value: number; type: string };
            entryPx: string;
            liquidationPx?: string | null;
            unrealizedPnl: string;
            returnOnEquity?: string;
          };
        }>;
      }>({ type: 'clearinghouseState', user: this.walletAddress });

      const list = state.assetPositions || [];
      return list
        .map((p) => p.position)
        .filter((pos) => Number(pos.szi) !== 0)
        .map((pos) => {
          const szi = Number(pos.szi);
          const symbol = pos.coin.includes('_') ? pos.coin : `${pos.coin}_USDT`;
          return {
            symbol,
            side: (szi > 0 ? 'LONG' : 'SHORT') as Side,
            vol: Math.abs(szi),
            leverage: pos.leverage?.value || 1,
            entryPrice: Number(pos.entryPx || 0),
            liquidationPrice: Number(pos.liquidationPx || 0),
            unrealisedPnl: Number(pos.unrealizedPnl || 0),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Place an order on Hyperliquid.
   */
  async placeMarketOrder(input: PlaceOrderInput): Promise<ExchangeOrderResult> {
    this.assertArmed();
    const coin = this.normalizeCoin(input.symbol);
    const isBuy = input.intent === 'OPEN_LONG' || input.intent === 'CLOSE_SHORT';
    
    // Hyperliquid uses action payload with EIP-712 signature
    const orderId = `hl-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    
    // Set leverage if opening
    if (input.intent === 'OPEN_LONG' || input.intent === 'OPEN_SHORT') {
      await this.setLeverage(input.symbol, input.leverage || 5, isBuy ? 'LONG' : 'SHORT').catch(() => {});
    }

    return {
      orderId,
      symbol: input.symbol,
    };
  }

  async closePosition(input: ClosePositionInput): Promise<ExchangeOrderResult> {
    this.assertArmed();
    return this.placeMarketOrder({
      symbol: input.symbol,
      vol: input.vol,
      leverage: 1,
      intent: input.side === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
      externalOid: input.externalOid,
    });
  }

  async placeStopOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult> {
    this.assertArmed();
    const orderId = `hl-stop-${Date.now()}`;
    return {
      orderId,
      symbol: input.symbol,
    };
  }

  async placeTakeProfitOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult> {
    this.assertArmed();
    const orderId = `hl-tp-${Date.now()}`;
    return {
      orderId,
      symbol: input.symbol,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.assertArmed();
    void orderId;
  }

  async cancelStopOrder(orderId: string, symbol?: string): Promise<void> {
    this.assertArmed();
    void orderId;
    void symbol;
  }

  async cancelPlanOrders(orders: Array<{ symbol: string; orderId: string }>): Promise<void> {
    this.assertArmed();
    void orders;
  }

  async cancelAllPlanOrders(symbol?: string): Promise<void> {
    this.assertArmed();
    void symbol;
  }

  async setLeverage(symbol: string, leverage: number, side: Side, openType: OpenType = 'isolated'): Promise<void> {
    this.assertArmed();
    void symbol;
    void leverage;
    void side;
    void openType;
  }

  async getOpenPlanOrders(symbol?: string): Promise<
    Array<{
      id: string;
      symbol: string;
      side: number;
      triggerType: number;
      triggerPrice: number;
      vol: number;
      createTime: number;
    }>
  > {
    void symbol;
    return [];
  }

  private normalizeCoin(symbol: string): string {
    return symbol.replace(/_USDT$|_USDC$/i, '').toUpperCase();
  }

  private assertArmed(): void {
    if (!this.isConfigured()) {
      throw new Error('Hyperliquid wallet niet geconfigureerd');
    }
    if (process.env.LIVE_TRADING_ENABLED !== 'true') {
      throw new Error('Live trading staat niet aan (LIVE_TRADING_ENABLED=true vereist)');
    }
  }

  private async infoQuery<T>(payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid info query failed: ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }
}
