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
import { ErrorLogger } from './error-logger.js';
import { normalizeCoin } from './market-data.js';

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

  // Cache balance for 15 seconds to avoid Hyperliquid rate limits
  private balanceCache: { equity: number; available: number; frozen: number; at: number } | null = null;
  private readonly BALANCE_CACHE_TTL = 15_000;

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
   * Fetch USDC account balance from Hyperliquid.
   * Supports both standard (cross-margin) and unified accounts.
   * For unified accounts, spot USDC is already counted as margin — we use
   * `marginSummary.accountValue` which includes spot collateral.
   * Results are cached for 15 s to prevent rate limiting from frequent polls.
   */
  async getAccountAssets(): Promise<ExchangeAccountAsset[]> {
    if (!this.walletAddress) return [];

    // Return cached value if still fresh
    const now = Date.now();
    if (this.balanceCache && now - this.balanceCache.at < this.BALANCE_CACHE_TTL) {
      return [{ currency: 'USDC', ...this.balanceCache }];
    }

    try {
      const user = this.walletAddress as `0x${string}`;

      // Fetch perp and spot in parallel
      const [perpState, spotState] = await Promise.all([
        this.infoClient.clearinghouseState({ user }),
        this.infoClient.spotClearinghouseState({ user }),
      ]);

      // Unified accounts: marginSummary.accountValue already includes spot collateral
      // Standard accounts: crossMarginSummary.accountValue is perp-only
      const marginValue = Number((perpState as { marginSummary?: { accountValue?: string } }).marginSummary?.accountValue || 0);
      const crossValue = Number(perpState.crossMarginSummary?.accountValue || 0);
      const perpEquity = Math.max(marginValue, crossValue);
      const perpAvailable = Number(perpState.withdrawable || 0);

      // Spot USDC (token index 0 = USDC on Hyperliquid)
      const spotUsdc = (spotState.balances || []).find(
        (b: { coin: string; total: string; hold: string }) => b.coin === 'USDC'
      );
      const spotTotal = Number(spotUsdc?.total || 0);
      const spotHold = Number(spotUsdc?.hold || 0);
      const spotAvailable = Math.max(0, spotTotal - spotHold);

      // For unified accounts, marginValue already includes spot USDC — don't double count
      const isUnified = marginValue > crossValue;
      const totalEquity = isUnified ? perpEquity : perpEquity + spotTotal;
      const totalAvailable = isUnified ? perpAvailable + spotAvailable : perpAvailable + spotAvailable;
      const frozen = Math.max(0, totalEquity - totalAvailable);

      this.balanceCache = { equity: totalEquity, available: totalAvailable, frozen, at: now };

      return [{ currency: 'USDC', equity: totalEquity, available: totalAvailable, frozen }];
    } catch {
      return [];
    }
  }


  /**
   * Transfer USDC from the spot account to the perp account (or vice versa).
   * Required before the bot can open leveraged perpetual positions.
   *
   * @param amount USDC amount to transfer (e.g. 200)
   * @param toPerp true = spot→perp, false = perp→spot
   */
  async spotToPerpTransfer(amount: number, toPerp = true): Promise<{ ok: boolean; message: string }> {
    if (!this.exchangeClient) {
      return { ok: false, message: 'Private key niet geconfigureerd — kan niet overmaken.' };
    }
    try {
      await this.exchangeClient.usdClassTransfer({ amount: String(amount), toPerp });
      // Invalidate balance cache so next poll reflects new balance
      this.balanceCache = null;
      return { ok: true, message: `${amount} USDC succesvol overgeboekt naar ${toPerp ? 'perp' : 'spot'} account.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
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
          const marginUsed = Number((pos as any).marginUsed || 0);
          return {
            symbol,
            side: (szi > 0 ? 'LONG' : 'SHORT') as Side,
            vol: Math.abs(szi),
            leverage: pos.leverage?.value || 1,
            entryPrice: Number(pos.entryPx || 0),
            liquidationPrice: Number(pos.liquidationPx || 0),
            unrealisedPnl: Number(pos.unrealizedPnl || 0),
            margin: marginUsed > 0 ? marginUsed : undefined,
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

    // Determine dynamic slippage bound and check spread
    const mids = await this.infoClient.allMids();
    const midStr = mids[coin];
    if (!midStr) {
      throw new Error(`Geen actuele mid-prijs gevonden voor ${coin} op Hyperliquid`);
    }
    const midPrice = Number(midStr);

    const isMajor = /^(BTC|ETH|SOL)$/i.test(coin);
    const isMeme = /^(kPEPE|kBONK|kSHIB|kMOG|TRUMP|FARTCOIN|PENGU)$/i.test(coin);
    const slippagePct = isReduce
      ? (isMeme ? 0.035 : 0.02)
      : (isMajor ? 0.008 : isMeme ? 0.025 : 0.015);

    // Spread guard on new entries: reject if book is too illiquid or spread is blown out
    if (!isReduce) {
      try {
        const book = await this.infoClient.l2Book({ coin });
        if (book?.levels?.[0]?.[0] && book?.levels?.[1]?.[0]) {
          const bestBid = Number(book.levels[0][0].px);
          const bestAsk = Number(book.levels[1][0].px);
          if (bestBid > 0 && bestAsk > 0 && midPrice > 0) {
            const spreadPct = (bestAsk - bestBid) / midPrice;
            const maxSpread = isMeme ? 0.025 : 0.012;
            if (spreadPct > maxSpread) {
              throw new Error(
                `Order geweigerd voor ${coin}: spread te wijd (${(spreadPct * 100).toFixed(2)}% > ${(maxSpread * 100).toFixed(2)}%)`
              );
            }
          }
        }
      } catch (bookErr) {
        if ((bookErr as Error).message.includes('spread te wijd')) {
          throw bookErr;
        }
        // Non-fatal if l2Book query fails, proceed with dynamic slippage
      }
    }

    const slippagePrice = isBuy ? midPrice * (1 + slippagePct) : midPrice * (1 - slippagePct);

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
      }).catch((err) => {
        ErrorLogger.getInstance().error(
          'Hyperliquid',
          `Attached stop order mislukt voor ${input.symbol}: ${(err as Error).message}`,
          { symbol: input.symbol, triggerPrice: input.stopLossPrice }
        );
      });
    }
    if (input.takeProfitPrice && (input.intent === 'OPEN_LONG' || input.intent === 'OPEN_SHORT')) {
      await this.placeTakeProfitOrder({
        symbol: input.symbol,
        side: input.intent === 'OPEN_LONG' ? 'LONG' : 'SHORT',
        vol: input.vol,
        triggerPrice: input.takeProfitPrice,
      }).catch((err) => {
        ErrorLogger.getInstance().error(
          'Hyperliquid',
          `Attached take profit order mislukt voor ${input.symbol}: ${(err as Error).message}`,
          { symbol: input.symbol, triggerPrice: input.takeProfitPrice }
        );
      });
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
        .map((o) => {
          const isSell = o.side === 'A';
          const orderTypeLower = (o.orderType || '').toLowerCase();
          const trigCondLower = (o.triggerCondition || '').toLowerCase();
          const isStop = orderTypeLower.includes('stop') || trigCondLower.includes('stop');
          const isTp = orderTypeLower.includes('take profit') || orderTypeLower.includes('tp');

          let side = isSell ? 4 : 2; // 4 = Close Long (Sell), 2 = Close Short (Buy)
          let triggerType = 0;
          if (isSell) {
            triggerType = isStop ? 2 : isTp ? 1 : 0;
          } else {
            triggerType = isStop ? 1 : isTp ? 2 : 0;
          }

          return {
            id: String(o.oid),
            symbol: o.coin.includes('_') ? o.coin : `${o.coin}_USDT`,
            side,
            triggerType,
            triggerPrice: Number(o.triggerPx || o.limitPx),
            vol: Number(o.sz),
            createTime: o.timestamp,
          };
        });
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
    return normalizeCoin(symbol);
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
