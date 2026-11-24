// These exact EVM assets and destination define the authorized public USDT sale.
export const SALE_MERCHANT = '0xe0c5e4e14d70f6db63e67301d34199d696678a2c';
export const SALE_COINS_PER_USDT = 10;
export const SALE_NANO_PER_MICRO = BigInt(SALE_COINS_PER_USDT)*1000n;
export const SALE_TERMS = 'gpuchain:USDT:10-coins-per-USDT:v2';
export const SALE_TOKENS = Object.freeze({
  1:'0xdac17f958d2ee523a2206206994597c13d831ec7',
  56:'0x55d398326f99059ff775485246999027b3197955',
});
