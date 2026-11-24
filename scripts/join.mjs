#!/usr/bin/env node
import { resolvePublicLedger } from '../src/public-network.mjs';
import { inferenceRoutes } from '../src/inference-routes.mjs';

try {
  const ledger = await resolvePublicLedger();
  const {url,state,mode} = ledger;
  const readyProviders = (await inferenceRoutes(ledger)).map(({offer,...summary})=>summary);
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
