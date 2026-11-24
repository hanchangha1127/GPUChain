#!/usr/bin/env node
import { resolvePublicLedger } from '../src/public-network.mjs';
import { rankProviders } from '../src/routing.mjs';

try {
  const {url, state, mode} = await resolvePublicLedger();
  const readyProviders = await rankProviders(state, {ledgerUrl:url});
  console.log(JSON.stringify({
    connected:true,
    verified:true,
    networkId:state.networkId,
    chainId:state.chainId,
    ledgerUrl:url,
    mode,
    height:state.height,
    tip:state.tip,
    registeredProviderCount:state.providers.length,
    readyProviders
  }, null, 2));
} catch (error) {
  console.error('Public testnet connection failed:', error.message);
  process.exitCode = 1;
}
