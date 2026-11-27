import { startProviderRelay } from './relay-client.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

// A registered provider makes outbound connections only. Each relay gets its
// own ephemeral transport keys, while the adapter serializes local GPU work.
export function manageProviderRelays({wallet,chainId,adapter,node,enabled=true,intervalMs=5000}) {
  const workers = new Map();
  let stopping, reason = enabled ? 'waiting-for-model' : 'disabled';
  function retire(url,entry) {
    // Other origins can start immediately. Never install a new key at this
    // origin while its previous worker still owns an admitted job.
    entry.drain??=entry.worker.close().finally(()=>workers.delete(url));
    return entry.drain;
  }
  function update() {
    const {status,checkpoint} = node.snapshot();
    const ready = enabled && adapter?.backendUrl && adapter?.url;
    const registered = checkpoint?.state.providers.includes(wallet.address);
    const origins = new Set();
    if (ready && registered) {
      const urls = checkpoint.authority?.payload.validators.map(v=>v.url) ?? [status.ledgerUrl];
      for (const url of urls.filter(Boolean)) origins.add(normalizeProviderEndpoint(url));
    }
    reason = !enabled ? 'disabled' : !ready ? 'waiting-for-model' : !registered
      ? 'waiting-for-registration' : 'connecting';
    for (const [url,entry] of workers) {
      if (!origins.has(url)) retire(url,entry).catch(()=>{reason='error';});
    }
    for (const relayUrl of origins) {
      if (workers.has(relayUrl)) continue;
      const worker=startProviderRelay({wallet,chainId,relayUrl,adapterUrl:adapter.url,
        readState:async()=>{
          const current = node.snapshot().checkpoint;
          if (!current || current.state.chainId !== chainId) throw Error('Waiting for verified network state');
          return current.state;
        }});
      workers.set(relayUrl,{worker});
    }
  }
  function sync() {
    try { update(); } catch { reason='error'; }
  }
  sync();
  const timer = setInterval(sync,intervalMs);
  timer.unref();
  return {
    status() {
      const states = [...workers.values()].map(entry=>entry.worker.status().state);
      const mode = ['busy','ready','draining','error','offline'].find(s=>states.includes(s)) ?? reason;
      return {mode,reachableRelays:states.filter(s=>s==='ready'||s==='busy').length,backendUrl:adapter?.backendUrl ?? null};
    },
    close() {
      clearInterval(timer);
      stopping??=Promise.all([...workers].map(([url,entry])=>retire(url,entry)))
        .then(results=>({confirmed:results.every(result=>result.confirmed)}));
      return stopping;
    }
  };
}
