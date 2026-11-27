import { randomInt } from 'node:crypto';
import { rankProviders } from './routing.mjs';
import { listRelayOffers } from './relay-client.mjs';

export function relayOrigins(ledger) {
  const committee = ledger.checkpoint?.authority?.payload?.validators;
  return committee ? [...new Set(committee.map(v=>v.url))] : [ledger.url];
}

// Direct measurements include the provider round trip. A relay measurement is
// the client's round trip to the mailbox, so prefer a proven direct route in auto.
export async function inspectInferenceRoutes(ledger,{transport='auto',payer,maxOutputTokens=1,reasoning=false,chatProtocol=false,provider,excludeProvider,signal}={}) {
  signal?.throwIfAborted();
  if (!['auto','direct','relay'].includes(transport)) throw Error('Transport must be auto, direct or relay');
  const state = ledger.checkpoint?.state ?? ledger.state;
  const eligible = new Set(state.providers.filter(a=>a!==payer && a!==excludeProvider && (!provider || provider===a)));
  const report={registered:state.providers.length,eligible:eligible.size,relaysChecked:0,relaysReached:0};
  if (!eligible.size) {
    const self=state.providers.length===1 && state.providers[0]===payer;
    return {routes:[],diagnostic:{...report,code:self?'self_provider_only':!state.providers.length?'no_registered_provider':'no_eligible_provider'}};
  }
  const direct = transport==='relay' ? [] : await rankProviders(state,{payer,ledgerUrl:ledger.url,maxOutputTokens,reasoning,chatProtocol,eligible});
  const result = direct.filter(r=>eligible.has(r.provider)).map(r=>({...r,transport:'direct',latencyKind:'provider-rtt'}));
  if (transport==='direct') return {routes:result,diagnostic:{...report,code:result.length?'ready':'no_direct_provider'}};
  const batches = await Promise.allSettled(relayOrigins(ledger).map(url=>
    listRelayOffers(url,state.chainId,{signal})));
  signal?.throwIfAborted();
  report.relaysChecked=batches.length;
  report.relaysReached=batches.filter(b=>b.status==='fulfilled').length;
  let incompatible=false;
  // All providers in a reply share the directory RTT. Give each an equal chance
  // within that group, independently of the order in which their wallets sort.
  const relayed = batches.flatMap(b=>{
    if (b.status!=='fulfilled' || !b.value.length) return [];
    const offers=b.value.filter(r=>{
      if (!eligible.has(r.provider)) return false;
      const p=r.offer.payload;
      const compatible=p.maxOutputTokens>=maxOutputTokens && (!reasoning || p.reasoningOptions===1) &&
        (!chatProtocol || p.chatProtocol===1);
      if (!compatible) incompatible=true;
      return compatible;
    });
    for (let i=offers.length-1;i>0;i--) {
      const j=randomInt(i+1);
      [offers[i],offers[j]]=[offers[j],offers[i]];
    }
    return offers;
  }).sort((a,b)=>a.latencyMs-b.latencyMs);
  const seen = new Set(result.map(r=>r.provider));
  for (const r of relayed) {
    if (eligible.has(r.provider) && !seen.has(r.provider)) {
      result.push({...r,transport:'relay',latencyKind:'relay-rtt'});
      seen.add(r.provider);
    }
  }
  let code='ready';
  if (!result.length) {
    if (!report.relaysReached) code='relay_unreachable';
    else if (report.relaysReached<report.relaysChecked) code='relay_partial';
    else code=incompatible?'provider_capability_mismatch':'no_encrypted_provider';
  }
  return {routes:result,diagnostic:{...report,code}};
}

export async function inferenceRoutes(ledger,options) {
  return (await inspectInferenceRoutes(ledger,options)).routes;
}
