import { rankProviders } from './routing.mjs';
import { listRelayOffers } from './relay-client.mjs';

export function relayOrigins(ledger) {
  const committee = ledger.checkpoint?.authority?.payload?.validators;
  return committee ? [...new Set(committee.map(v=>v.url))] : [ledger.url];
}

// Direct measurements include the provider round trip. A relay measurement is
// the client's round trip to the mailbox, so prefer a proven direct route in auto.
export async function inferenceRoutes(ledger,{transport='auto',payer,maxOutputTokens=1,reasoning=false,provider}={}) {
  if (!['auto','direct','relay'].includes(transport)) throw Error('Transport must be auto, direct or relay');
  const state = ledger.checkpoint?.state ?? ledger.state;
  const eligible = new Set(state.providers.filter(a=>a!==payer && (!provider || provider===a)));
  if (!eligible.size) return [];
  const direct = transport==='relay' ? [] : await rankProviders(state,{payer,ledgerUrl:ledger.url,maxOutputTokens,reasoning});
  const result = direct.filter(r=>eligible.has(r.provider)).map(r=>({...r,transport:'direct',latencyKind:'provider-rtt'}));
  if (transport==='direct') return result;
  const batches = await Promise.allSettled(relayOrigins(ledger).map(url=>
    listRelayOffers(url,state.chainId,{maxOutputTokens,reasoning})));
  const relayed = batches.flatMap(b=>b.status==='fulfilled' ? b.value : []).sort((a,b)=>a.latencyMs-b.latencyMs);
  const seen = new Set(result.map(r=>r.provider));
  for (const r of relayed) {
    if (eligible.has(r.provider) && !seen.has(r.provider)) {
      result.push({...r,transport:'relay',latencyKind:'relay-rtt'});
      seen.add(r.provider);
    }
  }
  return result;
}
