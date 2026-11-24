import { startProviderRelay } from './relay-client.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

// A registered provider makes outbound connections only. Each relay gets its
// own ephemeral transport keys, while the adapter serializes local GPU work.
export function manageProviderRelays({wallet,chainId,adapter,node,enabled=true,intervalMs=5000}) {
  const workers = new Map();
  let pending, stopped = false, reason = enabled ? 'waiting-for-model' : 'disabled';
  async function update() {
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
    for (const [url,worker] of workers) {
      if (!origins.has(url)) {
        // A slow local health probe or an idle unload must not interrupt a
        // signed job already being answered. Let it return its sealed receipt.
        if (worker.status().state==='busy') continue;
        workers.delete(url);
        await worker.close();
      }
    }
    if (stopped) return;
    for (const relayUrl of origins) {
      if (workers.has(relayUrl)) continue;
      workers.set(relayUrl,startProviderRelay({wallet,chainId,relayUrl,adapterUrl:adapter.url,
        readState:async()=>{
          const current = node.snapshot().checkpoint;
          if (!current || current.state.chainId !== chainId) throw Error('Waiting for verified network state');
          return current.state;
        }}));
    }
  }
  function sync() {
    if (!stopped && !pending) pending = update().catch(()=>{reason='error';}).finally(()=>{pending=undefined;});
  }
  sync();
  const timer = setInterval(sync,intervalMs);
  timer.unref();
  return {
    status() {
      const states = [...workers.values()].map(w=>w.status().state);
      const mode = ['busy','ready','error','offline'].find(s=>states.includes(s)) ?? reason;
      return {mode,reachableRelays:states.filter(s=>s==='ready'||s==='busy').length,backendUrl:adapter?.backendUrl ?? null};
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
      await Promise.allSettled([...workers.values()].map(w=>w.close()));
      workers.clear();
    }
  };
}
