/**
 * Human-readable metadata for the crypto perpetuals the engine trades.
 *
 * The venue only gives back a raw contract symbol (e.g. `BTC_USDT`) — this
 * maps the base asset to its full name and a brand colour so the dashboard
 * can show something a person recognises at a glance, instead of just the
 * ticker.
 */
export type CoinInfo = {
  /** Full, human-readable project name, e.g. "Bitcoin". */
  name: string;
  /** Brand colour used for the coin's badge. */
  color: string;
};

/** Known core-universe and common scout-candidate coins. */
const COIN_INFO: Record<string, CoinInfo> = {
  BTC: { name: 'Bitcoin', color: '#f7931a' },
  ETH: { name: 'Ethereum', color: '#8c8fe0' },
  AVAX: { name: 'Avalanche', color: '#e84142' },
  LINK: { name: 'Chainlink', color: '#2a5ada' },
  SOL: { name: 'Solana', color: '#14f195' },
  XRP: { name: 'XRP', color: '#25a6db' },
  DOGE: { name: 'Dogecoin', color: '#c2a633' },
  ADA: { name: 'Cardano', color: '#0033ad' },
  ARB: { name: 'Arbitrum', color: '#28a0f0' },
  OP: { name: 'Optimism', color: '#ff0420' },
  MATIC: { name: 'Polygon', color: '#8247e5' },
  DOT: { name: 'Polkadot', color: '#e6007a' },
  LTC: { name: 'Litecoin', color: '#bfbbbb' },
  BCH: { name: 'Bitcoin Cash', color: '#8dc351' },
  TRX: { name: 'TRON', color: '#ff0013' },
  TON: { name: 'Toncoin', color: '#0098ea' },
  NEAR: { name: 'NEAR Protocol', color: '#00ec97' },
  APT: { name: 'Aptos', color: '#2dd8a7' },
  SUI: { name: 'Sui', color: '#4da2ff' },
  HYPE: { name: 'Hyperliquid', color: '#00d4aa' },
  PEPE: { name: 'Pepe', color: '#4caf1f' },
  SHIB: { name: 'Shiba Inu', color: '#f00500' },
  WIF: { name: 'dogwifhat', color: '#c9a876' },
  BNB: { name: 'BNB', color: '#f0b90b' },
  UNI: { name: 'Uniswap', color: '#ff007a' },
  AAVE: { name: 'Aave', color: '#b6509e' },
  INJ: { name: 'Injective', color: '#00d1ff' },
  FIL: { name: 'Filecoin', color: '#0090ff' },
  ATOM: { name: 'Cosmos', color: '#2e3148' },
  TAO: { name: 'Bittensor', color: '#262626' },
  BONK: { name: 'Bonk', color: '#f5a623' },
  TIA: { name: 'Celestia', color: '#7b2bf9' },
  FET: { name: 'Artificial Superintelligence', color: '#1d2a44' },
  RENDER: { name: 'Render', color: '#e51b24' },
  ONDO: { name: 'Ondo Finance', color: '#1351d8' },
  ENA: { name: 'Ethena', color: '#444444' },
  KAS: { name: 'Kaspa', color: '#70c7ba' },
  SEI: { name: 'Sei', color: '#9b1c2e' },
};

/**
 * Split a venue contract symbol into its base coin and quote asset.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 * @returns the base ticker (e.g. `BTC`) and quote ticker (e.g. `USDT`).
 */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  const [base, quote] = symbol.split('_');
  return { base: base || symbol, quote: quote || '' };
}

/**
 * Look up display metadata for a contract symbol's base coin.
 *
 * Falls back to the raw ticker as the name and a neutral colour for coins
 * outside the known table (e.g. a fresh scout candidate), so the UI never
 * shows a blank field.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`.
 * @returns display name and badge colour for the coin.
 */
export function coinInfo(symbol: string): CoinInfo {
  const { base } = splitSymbol(symbol);
  return COIN_INFO[base] || { name: base, color: '#5b8cff' };
}
