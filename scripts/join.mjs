#!/usr/bin/env node
import { resolvePublicLedger } from '../src/public-network.mjs';
import { inspectInferenceRoutes } from '../src/inference-routes.mjs';

try {
  const ledger = await resolvePublicLedger();
  const {url,state,mode} = ledger;
  const {routes,diagnostic} = await inspectInferenceRoutes(ledger);
  const readyProviders = routes.map(({offer,...summary})=>summary);
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
    readyProviders,
    diagnostic
  }, null, 2));
} catch (error) {
  console.error('Public GPUChain connection failed:', error.message);
  process.exitCode = 1;
}
