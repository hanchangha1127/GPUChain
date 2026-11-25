import { DISTRIBUTION_RESERVE } from './reserve-policy.mjs';
import { decodeAmount } from './amount.mjs';

export const LEGACY_STARTER_GRANT_AMOUNT = 100_000_000_000;
export const STARTER_GRANT_AMOUNT = 1_000_000_000_000;
export const MAX_STARTER_WALLETS = 1_000_000;
export const LEGACY_STARTER_GRANT_PROTOCOL = 'gpuchain/starter-grant/recorded-wallet/v1';
export const STARTER_GRANT_PROTOCOL = 'gpuchain/starter-grant/recorded-wallet/v2';
export const STARTER_AUTHORIZATION_V2 = 'authorize-starter-grants-v2';

export function starterGrantAmount(state) {
  const m=state.starterMandate;
  return !m || m.authorization?.payload.type===STARTER_AUTHORIZATION_V2
    ? STARTER_GRANT_AMOUNT : LEGACY_STARTER_GRANT_AMOUNT;
}

// The first v2 permission signs the highest existing v1 claim height. Later
// permissions preserve this cutover so old claims keep their original value.
export function legacyStarterThrough(state) {
  const permission=state.starterMandate?.authorization?.payload;
  if (permission?.type===STARTER_AUTHORIZATION_V2) return permission.legacyThrough;
  return Object.values(state.starterClaims ?? {}).reduce((last,height)=>Math.max(last,height),0);
}

export function remainingStarterClaims(state) {
  const m=state.starterMandate;
  if (!m?.active) return 0;
  const unit=starterGrantAmount(state);
  const budget=(decodeAmount(m.cap)-decodeAmount(m.spent))/BigInt(unit);
  if (unit===LEGACY_STARTER_GRANT_AMOUNT) return Number(budget);
  return Math.min(Number(budget),MAX_STARTER_WALLETS-Object.keys(state.starterClaims ?? {}).length);
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
  const claims=state.starterClaims;
  return claims && Object.hasOwn(claims,address) ? claims[address] : null;
}

export function starterClaimAmount(state,address) {
  const height=starterClaimHeight(state,address);
  if (height===null) return null;
  const grant=starterGrantAmount(state);
  return grant===STARTER_GRANT_AMOUNT && height<=legacyStarterThrough(state) ? LEGACY_STARTER_GRANT_AMOUNT : grant;
}
