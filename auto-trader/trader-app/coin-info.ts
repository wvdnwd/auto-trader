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
  FARTCOIN: { name: 'Fartcoin', color: '#8b5a2b' },
  PENGU: { name: 'Pudgy Penguins', color: '#00b4d8' },
  SPX: { name: 'SPX6900', color: '#e63946' },
  POPCAT: { name: 'Popcat', color: '#f4a261' },
  BOME: { name: 'BOOK OF MEME', color: '#2a9d8f' },
  TURBO: { name: 'Turbo', color: '#ffb703' },
  PNUT: { name: 'Peanut the Squirrel', color: '#d4a373' },
  MOODENG: { name: 'Moo Deng', color: '#e76f51' },
  BRETT: { name: 'Brett', color: '#1d3557' },
  MEW: { name: 'cat in a dogs world', color: '#f72585' },
  GOAT: { name: 'Goatseus Maximus', color: '#7209b7' },
  TRUMP: { name: 'Official Trump', color: '#c1121f' },
  MELANIA: { name: 'Melania', color: '#f3722c' },
  CHILLGUY: { name: 'Just a Chill Guy', color: '#577590' },
  PURR: { name: 'Purr', color: '#9d4edd' },
  ANIME: { name: 'AnimeCoin', color: '#ff70a6' },
  VINE: { name: 'Vine', color: '#38b000' },
  PUMP: { name: 'Pump', color: '#ff0054' },
  BABY: { name: 'Baby', color: '#ffd166' },
  FLOKI: { name: 'Floki', color: '#ff9f1c' },
  '1000FLOKI': { name: 'Floki (1k)', color: '#ff9f1c' },
  '1000BONK': { name: 'Bonk (1k)', color: '#f5a623' },
  NEIRO: { name: 'Neiro', color: '#ffaa00' },
  '1000NEIRO': { name: 'Neiro (1k)', color: '#ffaa00' },
  NEIROETH: { name: 'Neiro Ethereum', color: '#ffaa00' },
  '1000000MOG': { name: 'Mog (1M)', color: '#00f5d4' },
  '1000DOGS': { name: 'Dogs (1k)', color: '#2b2d42' },
  CATI: { name: 'Catizen', color: '#4361ee' },
  HMSTR: { name: 'Hamster Kombat', color: '#ee9b00' },
  ACT: { name: 'Act I : AI Prophecy', color: '#9b5de5' },
  VIRTUAL: { name: 'Virtuals Protocol', color: '#4cc9f0' },
  AI16Z: { name: 'ai16z', color: '#06d6a0' },
  AIXBT: { name: 'aixbt', color: '#118ab2' },
  ZEREBRO: { name: 'Zerebro', color: '#8338ec' },
  GRIFFAIN: { name: 'Griffain', color: '#3a86ff' },
  KAITO: { name: 'Kaito', color: '#fb5607' },
  PROMPT: { name: 'Prompt', color: '#ffbe0b' },
  ARKM: { name: 'Arkham', color: '#22223b' },
  BERA: { name: 'Berachain', color: '#c77dff' },
  MON: { name: 'Monad', color: '#7b2cbf' },
  IP: { name: 'Story Protocol', color: '#3f37c9' },
  S: { name: 'Sonic', color: '#4895ef' },
  MOVE: { name: 'Movement', color: '#48cae4' },
  OM: { name: 'MANTRA', color: '#e07a5f' },
  MORPHO: { name: 'Morpho', color: '#3d5a80' },
  SYRUP: { name: 'Maple Syrup', color: '#d4a373' },
  RESOLV: { name: 'Resolv', color: '#2b9348' },
  AERO: { name: 'Aerodrome', color: '#0077b6' },
  RAY: { name: 'Raydium', color: '#00b4d8' },
  BIGTIME: { name: 'Big Time', color: '#f77f00' },
  PIXEL: { name: 'Pixels', color: '#fcbf49' },
  ACE: { name: 'Fusionist', color: '#d62828' },
  MAVIA: { name: 'Heroes of Mavia', color: '#003049' },
  SUPER: { name: 'SuperVerse', color: '#6a040f' },
  ZK: { name: 'ZKsync', color: '#3a0ca3' },
  BLAST: { name: 'Blast', color: '#fcff4b' },
  SCR: { name: 'Scroll', color: '#ffb703' },
  LINEA: { name: 'Linea', color: '#14213d' },
  EIGEN: { name: 'EigenLayer', color: '#2d00f7' },
  PYTH: { name: 'Pyth Network', color: '#7209b7' },
  JTO: { name: 'Jito', color: '#48cae4' },
  BLUR: { name: 'Blur', color: '#ff6700' },
};

/**
 * Split a venue contract symbol into its base coin and quote asset.
 *
 * @param symbol contract symbol, e.g. `BTC_USDT`, `BTC_USDC`, or `BTC-PERP`.
 * @returns the base ticker (e.g. `BTC`) and quote ticker (e.g. `USDC`).
 */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  if (symbol.includes('_')) {
    const [base, quote] = symbol.split('_');
    const displayQuote = quote === 'USDT' ? 'USDC' : (quote || 'USDC');
    return { base: base || symbol, quote: displayQuote };
  }
  if (symbol.includes('-')) {
    const [base, quote] = symbol.split('-');
    return { base: base || symbol, quote: quote || 'USDC' };
  }
  return { base: symbol, quote: 'USDC' };
}

/**
 * Format a contract symbol for display in the UI (Hyperliquid USDC standard).
 * E.g. 'BTC_USDT' -> 'BTC/USDC', 'SOL_USDC' -> 'SOL/USDC', 'ETH' -> 'ETH/USDC'.
 */
export function formatSymbol(symbol: string): string {
  if (!symbol) return '';
  const { base, quote } = splitSymbol(symbol);
  return `${base}/${quote || 'USDC'}`;
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
