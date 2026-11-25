import { DISTRIBUTION_RESERVE } from './reserve-policy.mjs';
import { decodeAmount } from './amount.mjs';

export const LEGACY_STARTER_GRANT_AMOUNT = 100_000_000_000;
export const STARTER_GRANT_AMOUNT = 1_000_000_000_000;
export const MAX_STARTER_WALLETS = 1_000_000;
export const LEGACY_STARTER_GRANT_PROTOCOL = 'gpuchain/starter-grant/recorded-wallet/v1';
export const STARTER_GRANT_PROTOCOL = 'gpuchain/starter-grant/recorded-wallet/v2';
export const STARTER_AUTHORIZATION_V2 = 'authorize-starter-grants-v2';

export function activeStarterMandate(state) {
  return state.starterMandateV2 ?? state.starterMandate;
}

export function starterGrantAmount(state) {
  return state.starterMandate && !state.starterMandateV2 ? LEGACY_STARTER_GRANT_AMOUNT : STARTER_GRANT_AMOUNT;
}

// The first v2 permission signs the highest existing v1 claim height. Later
// permissions preserve this cutover so old claims keep their original value.
export function legacyStarterThrough(state) {
  return Object.values(state.starterClaims ?? {}).reduce((last,height)=>Math.max(last,height),0);
}

export function remainingStarterClaims(state) {
  const m=activeStarterMandate(state);
  if (!m?.active) return 0;
  const unit=starterGrantAmount(state);
  const budget=(decodeAmount(m.cap)-decodeAmount(m.spent))/BigInt(unit);
  if (unit===LEGACY_STARTER_GRANT_AMOUNT) return Number(budget);
  const recipients=Object.keys(state.starterClaims ?? {}).length+Object.keys(state.starterClaimsV2 ?? {}).length;
  return Math.min(Number(budget),MAX_STARTER_WALLETS-recipients);
}

export function knownStarterWallet(state,address) {
  return typeof address==='string' && /^[0-9a-f]{64}$/.test(address) &&
    (Object.hasOwn(state.balances,address) || Object.hasOwn(state.nonces,address) ||
      state.providers.includes(address) || (state.validatorAddresses ?? []).includes(address) ||
      address===state.sequencer);
}

export function starterAddressEligible(state,address) {
  return address!==DISTRIBUTION_RESERVE.address && knownStarterWallet(state,address);
}

export function starterClaimHeight(state,address) {
  if (state.starterClaims && Object.hasOwn(state.starterClaims,address)) return state.starterClaims[address];
  if (state.starterClaimsV2 && Object.hasOwn(state.starterClaimsV2,address)) return state.starterClaimsV2[address];
  return null;
}

export function starterClaimAmount(state,address) {
  if (state.starterClaims && Object.hasOwn(state.starterClaims,address)) return LEGACY_STARTER_GRANT_AMOUNT;
  if (state.starterClaimsV2 && Object.hasOwn(state.starterClaimsV2,address)) return STARTER_GRANT_AMOUNT;
  return null;
}
