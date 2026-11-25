// Existing signed v2 quotes and the original mainnet promotion use these terms.
export const SALE_MERCHANT = '0xe0c5e4e14d70f6db63e67301d34199d696678a2c';
export const SALE_COINS_PER_USDT = 10;
export const SALE_NANO_PER_MICRO = BigInt(SALE_COINS_PER_USDT)*1000n;
export const SALE_TERMS = 'gpuchain:USDT:10-coins-per-USDT:v2';
// Configuring v3 records a reference price. The reserve owner must independently
// authorize a spending mandate for these terms before a v3 delivery is valid.
export const SALE_PRICE_COINS_PER_USDT = 2;
export const SALE_PRICE_NANO_PER_MICRO = BigInt(SALE_PRICE_COINS_PER_USDT)*1000n;
export const SALE_PRICE_USDT_PER_COIN = '0.5';
export const SALE_PRICE_TERMS = 'gpuchain:USDT:2-coins-per-USDT:v3';

export function saleNanoPerMicro(terms) {
  if (terms===SALE_TERMS) return SALE_NANO_PER_MICRO;
  if (terms===SALE_PRICE_TERMS) return SALE_PRICE_NANO_PER_MICRO;
  throw Error('Unknown USDT sale price terms');
}
export const SALE_TOKENS = Object.freeze({
  1:'0xdac17f958d2ee523a2206206994597c13d831ec7',
  56:'0x55d398326f99059ff775485246999027b3197955',
});
