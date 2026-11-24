import { once } from 'node:events';
import { createProviderServer, createStrataBackend } from './provider.mjs';
import { requestJson } from './http.mjs';

const defaults = ['http://127.0.0.1:8080', 'http://127.0.0.1:8000'];

function loopbackOrigin(value) {
  const url = new URL(value);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
      !['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['/','/v1','/v1/'].includes(url.pathname)) throw Error('Automatic Strata detection requires a loopback origin');
  return url.origin;
}

// Discover only running local services. The existing provider validates the loaded
// model, context and native KV metrics again on every inference. No model is launched.
export async function startAutoProvider({wallet,chainId,readState,backendUrls,listenPort=8789,
  intervalMs=5000,apiKey,engine,modelId,probeTimeoutMs=1000}) {
  if (!Number.isInteger(listenPort) || listenPort<0 || listenPort>65535 ||
      !Number.isSafeInteger(intervalMs) || intervalMs<1 ||
      !Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs<1 ||
      typeof readState!=='function') throw Error('Invalid automatic provider configuration');
  if (engine!==undefined && !['strata','ryzenstrata'].includes(engine)) throw Error('Unknown Strata engine');
  const origins = [...new Set((backendUrls ?? defaults).map(loopbackOrigin))];
  if (!origins.length) throw Error('Specify at least one local Strata origin');

  let selected, server, refreshing, closing;
  const backends = new Map();
  const headers = apiKey && backendUrls ? {authorization:'Bearer '+apiKey} : undefined;

  async function detect(origin) {
    // Do not send a credential to a default port during service discovery.
    const health = await requestJson(origin+'/health',{headers,timeoutMs:probeTimeoutMs,maxBytes:16384});
    if (health?.loaded!==true || !['strata','ryzenstrata'].includes(health.service?.toLowerCase())) return null;
    // RYZENStrata uses the canonical Q2_0 profile. Upstream installations can
    // also advertise a bare weight ID with an explicit Qwen family alias.
    const mode = engine ?? (health.model==='qwen3.8-flash-next-q2_0' ? 'ryzenstrata' : 'strata');
    const key = origin+'|'+mode;
    if (!backends.has(key)) backends.set(key,createStrataBackend({strataUrl:origin,engine:mode,modelId,
      apiKey:headers ? apiKey : undefined}));
    const backend = backends.get(key);
    await backend.profile(probeTimeoutMs);
    return backend;
  }

  async function scan() {
    for (const origin of origins) {
      let backend;
      try { backend = await detect(origin); } catch { /* The local engine can be off or still loading. */ }
      if (closing) return;
      if (!backend) continue;
      selected = {origin,backend};
      if (!server) {
        const next = createProviderServer({wallet,chainId,readState,getBackend:()=>selected?.backend});
        try {
          next.listen(listenPort,'127.0.0.1');
          await once(next,'listening');
          server = next;
        } catch (err) {
          // A separately managed provider owns the port. Leave its lifecycle to its owner.
          if (err.code!=='EADDRINUSE') throw err;
        }
      }
      return;
    }
    selected = undefined;
  }

  function refresh() {
    if (closing) return closing;
    refreshing ??= scan().finally(()=>{ refreshing = undefined; });
    return refreshing;
  }
  await refresh();
  const timer = setInterval(()=>{refresh().catch(()=>{});},intervalMs);
  timer.unref();
  return {
    get url() { return server?.listening ? 'http://127.0.0.1:'+server.address().port : null; },
    get backendUrl() { return server?.listening ? selected?.origin ?? null : null; },
    refresh,
    close() {
      if (!closing) {
        clearInterval(timer);
        closing = (async()=>{
          await refreshing?.catch(()=>{});
          if (server?.listening) await new Promise(resolve=>server.close(resolve));
          selected = undefined;
        })();
      }
      return closing;
    }
  };
}
