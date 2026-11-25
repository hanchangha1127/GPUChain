import { DISTRIBUTION_RESERVE } from './reserve-policy.mjs';

export const STARTER_GRANT_AMOUNT = 100_000_000_000;
export const STARTER_GRANT_PROTOCOL = 'gpuchain/starter-grant/recorded-wallet/v1';

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
