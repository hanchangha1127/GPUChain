const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UNIT = 1_000_000_000n;
export const RESERVE_NANOCOINS = '1000000000000000000000';
// Genesis allocations have a safe-integer ceiling. Only one fixed reserve may
// ever be added, so no legitimate balance can exceed this bound.
const MAX = SAFE + BigInt(RESERVE_NANOCOINS);
const MAX_DIGITS = MAX.toString().length;

/** Accept the unique JSON representation of an exact, unsigned nanocoin amount. */
export function decodeAmount(value, label = 'coin amount') {
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && value.length <= MAX_DIGITS && /^[1-9][0-9]*$/.test(value)) {
    const n = BigInt(value);
    if (n > SAFE && n <= MAX) return n;
  }
  throw Error('Invalid ' + label);
}

export function isAmount(value) {
  try { decodeAmount(value); return true; }
  catch { return false; }
}

/** Preserve the representation used by existing signed transactions and checkpoints. */
export function encodeAmount(n, label = 'coin amount') {
  if (typeof n !== 'bigint' || n < 0n || n > MAX) throw Error('Invalid ' + label);
  return n <= SAFE ? Number(n) : n.toString();
}

export function parseCoins(value) {
  if (typeof value !== 'string' || !/^\d{1,16}(?:\.\d{1,9})?$/.test(value)) {
    throw Error('Use a positive coin amount with up to nine decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * UNIT + BigInt(fraction.padEnd(9, '0'));
  if (n === 0n) throw Error('Coin amount must be positive');
  return encodeAmount(n);
}

export function formatCoins(value) {
  const n = decodeAmount(value);
  const fraction = (n % UNIT).toString().padStart(9, '0').replace(/0+$/, '');
  return (n / UNIT).toString() + (fraction ? '.' + fraction : '');
}
