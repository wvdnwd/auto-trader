/**
 * Whether a contract is a USDT-quoted crypto perpetual rather than a tokenized
 * stock, index, metal, or energy contract.
 */
const NON_CRYPTO =
  /^(XAU|XAG|XAUT|XPT|XPD|SILVER|GOLD|USOIL|UKOIL|WTI|BRENT|NGAS|SPX|SPX500|SPY|NDX|NAS100|DJI|DAX|FTSE|NIKKEI|HSI|US30|US500|VIX)_|STOCK|_INDEX|PREMARKET|SOXL|TSLA|TESLA|AAPL|NVDA|NVIDIA|MSTR|AMZN|MSFT|GOOGL/i;

/**
 * Check whether a symbol is a USDT-quoted crypto perpetual.
 */
export function isCryptoPerp(symbol: string): boolean {
  if (!symbol.endsWith('_USDT')) return false;
  return !NON_CRYPTO.test(symbol);
}
