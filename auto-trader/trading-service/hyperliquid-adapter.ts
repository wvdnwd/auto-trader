import {
  ExchangeClient,
  InfoClient,
  HttpTransport,
  MAINNET_API_URL,
  TESTNET_API_URL,
} from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
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

export const HYPERLIQUID_MAINNET_API = MAINNET_API_URL;
export const HYPERLIQUID_TESTNET_API = TESTNET_API_URL;

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

  private account: PrivateKeyAccount | null = null;
  private exchangeClient: ExchangeClient | null = null;
  private infoClient: InfoClient;

  private metaUniverse: Array<{ szDecimals: number; name: string; maxLeverage: number }> = [];
  private metaLoadedAt = 0;

  constructor(
    walletAddress = process.env.HYPERLIQUID_WALLET || '',
    privateKey = process.env.HYPERLIQUID_PRIVATE_KEY || '',
    isTestnet = process.env.HYPERLIQUID_TESTNET === 'true'
  ) {
    this.walletAddress = walletAddress.trim();
    this.privateKey = privateKey.trim();
    this.isTestnet = isTestnet;
    this.baseUrl = isTestnet ? TESTNET_API_URL : MAINNET_API_URL;

    const transport = new HttpTransport({ isTestnet: this.isTestnet });
    this.infoClient = new InfoClient({ transport });
    this.initClients();
  }

  private initClients(): void {
    const transport = new HttpTransport({ isTestnet: this.isTestnet });
    this.infoClient = new InfoClient({ transport });
    if (this.privateKey) {
      try {
        const formattedKey = (this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`) as `0x${string}`;
        this.account = privateKeyToAccount(formattedKey);
        if (!this.walletAddress) {
          this.walletAddress = this.account.address;
        }
        this.exchangeClient = new ExchangeClient({ transport, wallet: this.account });
      } catch {
        this.account = null;
        this.exchangeClient = null;
      }
    } else {
      this.account = null;
      this.exchangeClient = null;
    }
  }

  setCredentials(walletAddress: string, privateKey: string, isTestnet = false): void {
    this.walletAddress = walletAddress.trim();
    this.privateKey = privateKey.trim();
    this.isTestnet = isTestnet;
    this.baseUrl = isTestnet ? TESTNET_API_URL : MAINNET_API_URL;
    this.initClients();
  }

  isConfigured(): boolean {
    return Boolean(this.walletAddress);
  }

  status(): LiveTradingStatus {
    const isArmedReady = Boolean(this.walletAddress && this.privateKey && this.exchangeClient);
    const enabled = isArmedReady && process.env.LIVE_TRADING_ENABLED === 'true';
    return {
      configured: Boolean(this.walletAddress),
      enabled,
      baseUrl: this.baseUrl,
      executionDisabledReason: enabled
        ? undefined
        : !this.walletAddress
        ? 'Hyperliquid walletadres ontbreekt'
        : !this.privateKey
        ? 'Hyperliquid private key ontbreekt voor live orders (alleen read-only modus)'
        : !this.exchangeClient
        ? 'Hyperliquid private key is ongeldig (moet een geldige 32-byte hex key zijn)'
        : 'Hyperliquid live trading staat uitgeschakeld (LIVE_TRADING_ENABLED=true vereist)',
      venue: this.venue,
    };
  }

  /**
   * Fetch USDC account balance from Hyperliquid clearinghouse state.
   */
  async getAccountAssets(): Promise<ExchangeAccountAsset[]> {
    if (!this.walletAddress) return [];
    try {
      const state = await this.infoClient.clearinghouseState({ user: this.walletAddress as `0x${string}` });
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
    if (!this.walletAddress) return [];
    try {
      const state = await this.infoClient.clearinghouseState({ user: this.walletAddress as `0x${string}` });
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
   * Place an order on Hyperliquid using limit with slippage and FrontendMarket TIF.
   */
  async placeMarketOrder(input: PlaceOrderInput): Promise<ExchangeOrderResult> {
    this.assertArmed();
    if (!this.exchangeClient) {
      throw new Error('Hyperliquid exchangeClient niet geïnitialiseerd — private key vereist');
    }

    const { assetId, szDecimals, coin } = await this.getCoinMeta(input.symbol);
    const isBuy = input.intent === 'OPEN_LONG' || input.intent === 'CLOSE_SHORT';
    const isReduce = input.intent === 'CLOSE_LONG' || input.intent === 'CLOSE_SHORT';

    // Set leverage before opening
    if (input.intent === 'OPEN_LONG' || input.intent === 'OPEN_SHORT') {
      await this.setLeverage(input.symbol, input.leverage || 5, isBuy ? 'LONG' : 'SHORT', input.openType || 'isolated').catch(() => {});
    }

    // Determine market execution price with 5% slippage bound from mid
    const mids = await this.infoClient.allMids();
    const midStr = mids[coin];
    if (!midStr) {
      throw new Error(`Geen actuele mid-prijs gevonden voor ${coin} op Hyperliquid`);
    }
    const midPrice = Number(midStr);
    const slippagePrice = isBuy ? midPrice * 1.05 : midPrice * 0.95;

    const formattedPrice = formatPrice(slippagePrice, szDecimals);
    const formattedSize = formatSize(input.vol, szDecimals);

    if (Number(formattedSize) <= 0) {
      throw new Error(`Ordergrootte ${input.vol} te klein voor ${coin} (minimaal ${Math.pow(10, -szDecimals)})`);
    }

    const res = await this.exchangeClient.order({
      orders: [
        {
          a: assetId,
          b: isBuy,
          p: formattedPrice,
          s: formattedSize,
          r: isReduce,
          t: { limit: { tif: 'FrontendMarket' } },
        },
      ],
      grouping: 'na',
    });

    const status = res.response.data.statuses[0];
    if (typeof status === 'object' && 'error' in status) {
      throw new Error(`Hyperliquid order geweigerd: ${status.error}`);
    }

    let orderId = `hl-${Date.now()}`;
    if (typeof status === 'object') {
      if ('filled' in status) orderId = String(status.filled.oid);
      else if ('resting' in status) orderId = String(status.resting.oid);
    }

    // Place attached stop loss or take profit trigger orders if requested
    if (input.stopLossPrice && (input.intent === 'OPEN_LONG' || input.intent === 'OPEN_SHORT')) {
      await this.placeStopOrder({
        symbol: input.symbol,
        side: input.intent === 'OPEN_LONG' ? 'LONG' : 'SHORT',
        vol: input.vol,
        triggerPrice: input.stopLossPrice,
      }).catch(() => {});
    }
    if (input.takeProfitPrice && (input.intent === 'OPEN_LONG' || input.intent === 'OPEN_SHORT')) {
      await this.placeTakeProfitOrder({
        symbol: input.symbol,
        side: input.intent === 'OPEN_LONG' ? 'LONG' : 'SHORT',
        vol: input.vol,
        triggerPrice: input.takeProfitPrice,
      }).catch(() => {});
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
    if (!this.exchangeClient) {
      throw new Error('Hyperliquid exchangeClient niet geïnitialiseerd — private key vereist');
    }

    const { assetId, szDecimals } = await this.getCoinMeta(input.symbol);
    // When protecting a LONG, sell to exit (b = false); when protecting a SHORT, buy to exit (b = true)
    const isBuy = input.side === 'SHORT';
    const formattedPrice = formatPrice(input.triggerPrice, szDecimals);
    const formattedSize = formatSize(input.vol, szDecimals);

    const res = await this.exchangeClient.order({
      orders: [
        {
          a: assetId,
          b: isBuy,
          p: formattedPrice,
          s: formattedSize,
          r: true,
          t: {
            trigger: {
              isMarket: true,
              triggerPx: formattedPrice,
              tpsl: 'sl',
            },
          },
        },
      ],
      grouping: 'na',
    });

    const status = res.response.data.statuses[0];
    if (typeof status === 'object' && 'error' in status) {
      throw new Error(`Hyperliquid stop order geweigerd: ${status.error}`);
    }

    let orderId = `hl-sl-${Date.now()}`;
    if (typeof status === 'object') {
      if ('resting' in status) orderId = String(status.resting.oid);
      else if ('filled' in status) orderId = String(status.filled.oid);
    }

    return {
      orderId,
      symbol: input.symbol,
    };
  }

  async placeTakeProfitOrder(input: PlaceStopOrderInput): Promise<ExchangeOrderResult> {
    this.assertArmed();
    if (!this.exchangeClient) {
      throw new Error('Hyperliquid exchangeClient niet geïnitialiseerd — private key vereist');
    }

    const { assetId, szDecimals } = await this.getCoinMeta(input.symbol);
    // When taking profit on a LONG, sell (b = false); when taking profit on a SHORT, buy (b = true)
    const isBuy = input.side === 'SHORT';
    const formattedPrice = formatPrice(input.triggerPrice, szDecimals);
    const formattedSize = formatSize(input.vol, szDecimals);

    const res = await this.exchangeClient.order({
      orders: [
        {
          a: assetId,
          b: isBuy,
          p: formattedPrice,
          s: formattedSize,
          r: true,
          t: {
            trigger: {
              isMarket: true,
              triggerPx: formattedPrice,
              tpsl: 'tp',
            },
          },
        },
      ],
      grouping: 'na',
    });

    const status = res.response.data.statuses[0];
    if (typeof status === 'object' && 'error' in status) {
      throw new Error(`Hyperliquid TP order geweigerd: ${status.error}`);
    }

    let orderId = `hl-tp-${Date.now()}`;
    if (typeof status === 'object') {
      if ('resting' in status) orderId = String(status.resting.oid);
      else if ('filled' in status) orderId = String(status.filled.oid);
    }

    return {
      orderId,
      symbol: input.symbol,
    };
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    this.assertArmed();
    if (!this.exchangeClient) return;
    const oid = Number(orderId);
    if (!Number.isFinite(oid)) return;

    let assetId = 0;
    if (symbol) {
      const meta = await this.getCoinMeta(symbol);
      assetId = meta.assetId;
    } else {
      const openOrders = await this.infoClient.frontendOpenOrders({ user: this.walletAddress as `0x${string}` });
      const target = openOrders.find((o) => o.oid === oid);
      if (target) {
        const meta = await this.getCoinMeta(target.coin);
        assetId = meta.assetId;
      }
    }

    await this.exchangeClient.cancel({
      cancels: [{ a: assetId, o: oid }],
    });
  }

  async cancelStopOrder(orderId: string, symbol?: string): Promise<void> {
    return this.cancelOrder(orderId, symbol);
  }

  async cancelPlanOrders(orders: Array<{ symbol: string; orderId: string }>): Promise<void> {
    this.assertArmed();
    if (!this.exchangeClient || !orders.length) return;
    const cancels: Array<{ a: number; o: number }> = [];
    for (const o of orders) {
      const oid = Number(o.orderId);
      if (Number.isFinite(oid)) {
        try {
          const meta = await this.getCoinMeta(o.symbol);
          cancels.push({ a: meta.assetId, o: oid });
        } catch {
          // ignore
        }
      }
    }
    if (cancels.length) {
      await this.exchangeClient.cancel({ cancels });
    }
  }

  async cancelAllPlanOrders(symbol?: string): Promise<void> {
    this.assertArmed();
    if (!this.exchangeClient || !this.walletAddress) return;
    try {
      const openOrders = await this.infoClient.frontendOpenOrders({ user: this.walletAddress as `0x${string}` });
      const cleanCoin = symbol ? this.normalizeCoin(symbol) : null;
      const filtered = openOrders.filter((o) => !cleanCoin || o.coin === cleanCoin);
      if (!filtered.length) return;

      const cancels: Array<{ a: number; o: number }> = [];
      for (const o of filtered) {
        const meta = await this.getCoinMeta(o.coin);
        cancels.push({ a: meta.assetId, o: o.oid });
      }
      if (cancels.length) {
        await this.exchangeClient.cancel({ cancels });
      }
    } catch {
      // ignore
    }
  }

  async setLeverage(symbol: string, leverage: number, side: Side, openType: OpenType = 'isolated'): Promise<void> {
    this.assertArmed();
    if (!this.exchangeClient) return;
    void side;
    try {
      const { assetId, maxLeverage } = await this.getCoinMeta(symbol);
      const validLev = Math.max(1, Math.min(Math.round(leverage), maxLeverage));
      await this.exchangeClient.updateLeverage({
        asset: assetId,
        isCross: openType === 'cross',
        leverage: validLev,
      });
    } catch {
      // ignore
    }
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
    if (!this.walletAddress) return [];
    try {
      const openOrders = await this.infoClient.frontendOpenOrders({ user: this.walletAddress as `0x${string}` });
      const cleanCoin = symbol ? this.normalizeCoin(symbol) : null;
      return openOrders
        .filter((o) => !cleanCoin || o.coin === cleanCoin)
        .map((o) => ({
          id: String(o.oid),
          symbol: o.coin.includes('_') ? o.coin : `${o.coin}_USDT`,
          side: o.side === 'B' ? 1 : 2,
          triggerType: o.isTrigger ? 1 : 0,
          triggerPrice: Number(o.triggerPx || o.limitPx),
          vol: Number(o.sz),
          createTime: o.timestamp,
        }));
    } catch {
      return [];
    }
  }

  private async getCoinMeta(symbol: string): Promise<{ assetId: number; szDecimals: number; maxLeverage: number; coin: string }> {
    if (!this.metaUniverse.length || Date.now() - this.metaLoadedAt > 300_000) {
      const meta = await this.infoClient.meta();
      this.metaUniverse = meta.universe;
      this.metaLoadedAt = Date.now();
    }
    const coin = this.normalizeCoin(symbol);
    const assetId = this.metaUniverse.findIndex((u) => u.name === coin);
    if (assetId === -1) {
      throw new Error(`Coin ${coin} (${symbol}) niet gevonden in Hyperliquid perpetuals universum`);
    }
    const item = this.metaUniverse[assetId];
    return {
      assetId,
      szDecimals: item.szDecimals,
      maxLeverage: item.maxLeverage,
      coin,
    };
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
}
