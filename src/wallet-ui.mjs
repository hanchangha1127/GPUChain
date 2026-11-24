import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CONTEXT, EPOCH_TOKENS, MODEL, RATES } from './ledger.mjs';
import { isAmount } from './amount.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';
import { requestJson } from './http.mjs';

const assets = [
  ['/', '../ui/wallet/index.html', 'text/html; charset=utf-8'],
  ['/style.css', '../ui/wallet/style.css', 'text/css; charset=utf-8'],
  ['/app.js', '../ui/wallet/app.js', 'text/javascript; charset=utf-8'],
  ['/send.js', '../ui/wallet/send.js', 'text/javascript; charset=utf-8'],
  ['/i18n.js', '../ui/wallet/i18n.js', 'text/javascript; charset=utf-8'],
  ['/amount.mjs', './amount.mjs', 'text/javascript; charset=utf-8'],
];
const headers = {
  'cache-control':'no-store',
  'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options':'nosniff',
  'x-frame-options':'DENY',
  'referrer-policy':'no-referrer',
  'cross-origin-resource-policy':'same-origin',
};
const hex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

function ledgerOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function localProvider(value) {
  const url = new URL(value);
  if (!['127.0.0.1','[::1]','localhost'].includes(url.hostname) || !['http:','https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Wallet UI provider URL must be a loopback HTTP(S) origin');
  }
  return url.origin;
}

// One short, read-only capability check per refresh interval across all open tabs.
function sampler(origin) {
  let sample, expires = 0;
  return () => {
    if (!sample || Date.now() >= expires) {
      expires = Date.now() + 3000;
      sample = requestJson(origin+'/v1/info',{timeoutMs:1200,maxBytes:8192})
        .then(info=>({info}),error=>{
          if ([502,503,504].includes(error.status)) return {adapter:'not-ready'};
          if (error.status || error instanceof SyntaxError) return {adapter:'incompatible'};
          return {adapter:'unavailable'};
        });
    }
    return sample;
  };
}

function overview({status, checkpoint, relay}, sampled) {
  if (!hex64(status?.address) || !hex64(status.chainId)) throw Error('Invalid node identity');
  const state = checkpoint?.state;
  if (Boolean(state) !== status.verified || (state && (state.chainId !== status.chainId ||
      state.height !== status.height || state.tip !== status.tip))) throw Error('Inconsistent local checkpoint');
  const address = status.address;
  const balance = state ? state.balances[address] ?? 0 : null;
  const nonce = state ? state.nonces[address] ?? 0 : null;
  if (state && (!isAmount(balance) || !count(nonce))) throw Error('Invalid account counters');
  const inference = {
    nodeRunsInference:false,
    walletRegistered:state ? state.providers.includes(address) : null,
    adapter:sampled.adapter ?? 'incompatible', providerAddress:null, sameWallet:null,
    providerRegistered:null, busy:null, inferenceActive:null, engine:null, kvCache:null, model:null, contextWindow:null,
  };
  const info = sampled.info;
  if (hex64(info?.provider) && hex64(info.chainId)) {
    if (info.chainId !== status.chainId) inference.adapter = 'different-chain';
    else if (info.model === MODEL && info.contextWindow === CONTEXT) {
      Object.assign(inference,{
        adapter:'online',providerAddress:info.provider,sameWallet:info.provider === address,
        providerRegistered:state ? state.providers.includes(info.provider) : null,
        busy:typeof info.busy === 'boolean' ? info.busy : null,
        inferenceActive:typeof info.inferenceActive === 'boolean' ? info.inferenceActive : null,
        engine:['strata','ryzenstrata'].includes(info.engine) ? info.engine : null,
        kvCache:kvCacheAtLeastQ8(info.kvCache) ? {k:info.kvCache.k,v:info.kvCache.v} : null,
        model:MODEL,contextWindow:CONTEXT,
      });
    }
  }
  // Deliberately construct each field. The wallet file, key, control descriptor,
  // other accounts' balances and the full checkpoint never enter the UI response.
  return {
    sampledAt:new Date().toISOString(),
    relay:relay ? {mode:relay.mode,reachableRelays:relay.reachableRelays,backendUrl:ledgerOrigin(relay.backendUrl)} : null,
    wallet:{address,balanceNanocoins:balance,nonce},
    node:{
      mode:status.mode, verified:status.verified, voting:status.voting, instanceId:status.instanceId,
      lastVerifiedAt:status.lastVerifiedAt ?? null, ledgerUrl:ledgerOrigin(status.ledgerUrl),
      enrollmentStatus:status.enrollmentStatus, pid:process.pid,
      enrollmentError:status.enrollmentError ? 'Enrollment failed' : null,
      syncError:status.syncError ? 'Checkpoint synchronization failed' : null,
    },
    network:{
      name:state?.networkId ?? null,stage:state?.networkStage ?? null,
      chainId:status.chainId,tip:state?.tip ?? null,height:state?.height ?? null,
      epoch:state?.epoch ?? null,epochTokens:state?.epochTokens ?? null,totalWorkTokens:state?.totalWorkTokens ?? null,
      epochTarget:EPOCH_TOKENS,registeredProviders:state?.providers.length ?? null,
      consensus:state ? (checkpoint.authority ? 'quorum' : 'bootstrap') : null,ratesNanoPerToken:RATES,
    },
    inference,
  };
}

async function readSendBody(req) {
  const chunks=[];
  let size=0;
  for await (const part of req) {
    size+=part.length;
    if (size>1024) throw Error('Size limit');
    chunks.push(part);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}

export async function startWalletUi({getSnapshot,port=8791,providerUrl='http://127.0.0.1:8789',sender}) {
  if (typeof getSnapshot !== 'function') throw Error('A local checkpoint reader is required');
  const sample = sampler(localProvider(providerUrl));
  const pages = new Map(await Promise.all(assets.map(async ([path,file,type]) =>
    [path,{data:await readFile(new URL(file,import.meta.url)),type}])));
  const server = createServer(async (req,res) => {
    function send(status,type,body,extra={}) {
      res.writeHead(status,{...headers,...extra,'content-type':type});
      res.end(body);
    }
    function error(code,message,extra) { send(code,'application/json',JSON.stringify({error:message}),extra); }
    try {
      const localPort = req.socket.localPort;
      const host = req.headers.host;
      if ((host !== '127.0.0.1:'+localPort && host !== 'localhost:'+localPort) ||
          (req.headers.origin !== undefined && req.headers.origin !== 'http://'+host) ||
          Object.keys(req.headers).some(key=>key === 'forwarded' || key.startsWith('x-forwarded-'))) {
        return error(403,'Local access only');
      }
      const sendPath=['/api/send/unlock','/api/send/prepare','/api/send/confirm'].includes(req.url);
      if (sendPath && sender) {
        if (req.method!=='POST') return error(405,'Expected POST',{allow:'POST'});
        const origin='http://'+host;
        if (req.headers.origin!==origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site']!=='same-origin')) {
          return error(403,'Requires the local wallet origin');
        }
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json') {
          return error(415,'Expected JSON');
        }
        if (Number(req.headers['content-length'])>1024) return error(413,'Request is too large');
        let body;
        try {body=await readSendBody(req);} catch {return error(400,'Invalid JSON body');}
        const cookieName='gpuSend'+localPort;
        const cookieAttrs='; HttpOnly; SameSite=Strict; Path=/api/send';
        try {
          if (req.url==='/api/send/unlock') {
            const {token,csrfToken,expiresAt}=sender.unlock(body,origin);
            return send(200,'application/json',JSON.stringify({unlocked:true,csrfToken,expiresAt}),{
              'set-cookie':cookieName+'='+token+cookieAttrs+'; Max-Age=300'
            });
          }
          const cookies=(req.headers.cookie ?? '').split(';').map(item=>item.trim()).filter(item=>item.startsWith(cookieName+'='));
          const auth={origin,csrfToken:req.headers['x-gpuchain-csrf'],token:cookies.length===1?cookies[0].slice(cookieName.length+1):null};
          if (req.url==='/api/send/prepare') {
            return send(200,'application/json',JSON.stringify(await sender.prepare(body,auth)));
          }
          return send(200,'application/json',JSON.stringify(await sender.confirm(body,auth)),{
            'set-cookie':cookieName+'='+cookieAttrs+'; Max-Age=0'
          });
        } catch (err) {
          if (Number.isInteger(err.status) && typeof err.code==='string') {
            return send(err.status,'application/json',JSON.stringify({error:err.message,code:err.code}));
          }
          return error(503,'Local wallet action unavailable');
        }
      }
      if (req.method !== 'GET') return error(405,'Expected GET',{allow:'GET'});
      if (req.url === '/api/overview') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return error(403,'Local access only');
        const [snapshot,provider] = await Promise.all([getSnapshot(),sample()]);
        return send(200,'application/json; charset=utf-8',JSON.stringify(overview(snapshot,provider)));
      }
      const page = pages.get(req.url);
      if (page) return send(200,page.type,page.data);
      return error(404,'Route not found');
    } catch { return error(503,'Local wallet status is unavailable'); }
  });
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.listen(port,'127.0.0.1');
  await once(server,'listening');
  const url = 'http://127.0.0.1:'+server.address().port;
  return {url,async close() {
    if (server.listening) await new Promise(resolve=>server.close(resolve));
  }};
}
