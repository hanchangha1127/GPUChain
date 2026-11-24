import http from 'node:http';
import { hash, sign, verify } from './crypto.mjs';
import { charge, CONTEXT, MODEL } from './ledger.mjs';
import { decodeAmount } from './amount.mjs';
import { readVerifiedState } from './node.mjs';
import { requestJson } from './http.mjs';
import { PROBE_DOMAIN } from './routing.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;
const REQUEST_FIELDS = ['chainId', 'expiresAt', 'maxInputTokens', 'maxOutputTokens', 'messagesHash',
  'nonce', 'payer', 'provider', 'type'].sort();

class ProviderError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function requireValue(condition, status, reason) {
  if (!condition) throw new ProviderError(status, reason);
}

function isCount(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

const quantId = /^(?:iq[1-4]_(?:xxs|xs|s|m|nl)|q[2-8]_(?:[01]|k(?:_[sml])?)|bf16|f16|fp16|fp8|fp4(?:-local)?)$/i;
// An empty suffix is the bare official name; null means another family/variant.
function qwenVariant(id) {
  if (typeof id!=='string') return null;
  const m=/^(?:(?:qwen|ista-daslab)\/)?qwen3\.8-flash-next(?:[-:](?:gsq-rco-)?([a-z0-9_\-]+))?$/i.exec(id);
  if (!m) return null;
  return m[1]===undefined ? '' : quantId.test(m[1]) ? m[1].toLowerCase() : null;
}
function selectModel(catalog,engine,requested) {
  const rows = Array.isArray(catalog?.data) ? catalog.data : [];
  const eligible = rows.filter(row=>{
    if (!row || typeof row.id!=='string' || row.alias_of || row.status?.value!=='loaded') return false;
    const outputs = row.architecture?.output_modalities;
    if (outputs!==undefined && (!Array.isArray(outputs)||!outputs.includes('text'))) return false;
    const aliases = engine==='strata' ? [...(Array.isArray(row.aliases)?row.aliases:[]),
      ...rows.filter(alias=>alias?.alias_of===row.id).map(alias=>alias.id)] : [];
    // A bare quant such as iq3_xxs can belong to several model families.
    // Upstream Strata advertises its precise family through a linked alias.
    const familyNames = aliases.filter(name=>typeof name==='string' && /qwen[0-9]|inkling|hy4[-_]/i.test(name));
    const family = qwenVariant(row.id)!==null ||
      (quantId.test(row.id) && familyNames.length>0 && familyNames.every(name=>{
        const variant=qwenVariant(name);
        return variant==='' || variant===row.id.toLowerCase();
      }));
    return family && (requested===undefined || row.id===requested || aliases.includes(requested));
  });
  requireValue(eligible.length>0,503,'No loaded Qwen3.8-Flash-Next model matches this Strata configuration');
  const profiles = eligible.map(row=>({modelId:row.id,
    capacity:row.context_length ?? row.max_model_len ?? row.max_context_length ?? row.limit?.context,
    outputLimit:row.limit?.output})).filter(p=>isCount(p.capacity,CONTEXT));
  requireValue(profiles.length>0,503,'Strata reports less than 262144 context tokens');
  requireValue(profiles.length===1,503,'Multiple eligible Strata models; specify --model-id');
  requireValue(profiles[0].outputLimit==null || isCount(profiles[0].outputLimit,1),503,'Invalid Strata output limit');
  return profiles[0];
}

function cacheType(value) {
  if (typeof value!=='string') return null;
  switch(value.toLowerCase()) {
    case 'int8': case 'i8': case 'q8': case 'q8_0': return 'Q8';
    case 'fp16': case 'f16': case 'float16': return 'F16';
    case 'bf16': case 'bfloat16': return 'BF16';
    case 'fp32': case 'f32': case 'float32': return 'F32';
    case 'q4': case 'q4_0': return 'Q4';
    default: return null;
  }
}

function runtimePrecision(metrics,model) {
  const info=metrics?.engine;
  let pair={k:null,v:null};
  const fail=reason=>{throw new ProviderError(503,reason,{code:'KV_CACHE_PRECISION',
    kvCache:pair,minimumKvBits:8,source:'/metrics.engine'});};
  if(info?.model!==model.modelId || info.max_context!==model.capacity) {
    fail('Runtime metrics do not match the loaded model and context');
  }
  // Upstream ReplicaPool.info covers only its first child; SplitEngine.info
  // covers only decode. Neither describes every path that may serve this request.
  if((info.replicas!=null && info.replicas!==1) ||
    (metrics.live?.replicas && (!Array.isArray(metrics.live.replicas) || metrics.live.replicas.length>1)) ||
    info.split_serve || metrics.live?.split_serve) {
    fail('Cannot verify KV cache precision across every replica or split stage');
  }
  // The native Qwen generator emits INFO kv=<active mode>. K8V4 is mixed
  // INT8 key and Q4 value, while int8 and fp16 apply to BOTH caches.
  const mode=typeof info.kv==='string' ? info.kv.toLowerCase() : '';
  if(mode==='k8v4') pair={k:'Q8',v:'Q4'};
  else if(mode==='k8v8') pair={k:'Q8',v:'Q8'};
  else pair={k:cacheType(mode),v:cacheType(mode)};
  if(!kvCacheAtLeastQ8(pair)) fail('Both runtime KV caches must report Q8 or higher precision');
  return {kvCache:pair,generation:info.gen ?? null};
}

function backendBase(strataUrl) {
  const url = new URL(strataUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireValue(url.protocol === 'https:' || (local && url.protocol === 'http:'), 400,
    'Strata must use loopback HTTP or HTTPS');
  requireValue(!url.username && !url.password && !url.search && !url.hash &&
    ['/', '/v1', '/v1/'].includes(url.pathname), 400, 'Expected a Strata origin or /v1 URL');
  return url.origin + '/v1';
}

async function readBody(stream) {
  let size = 0;
  const chunks = [];
  for await (const part of stream) {
    size += part.byteLength;
    requireValue(size <= MAX_BYTES, 413, 'JSON body is too large');
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProviderError(400, 'Invalid JSON body');
  }
}

function checkRequest({ request, signature, messages }, chainId, provider) {
  requireValue(request && typeof request === 'object' &&
    Object.keys(request).sort().join('|') === REQUEST_FIELDS.join('|'), 400, 'Invalid request fields');
  requireValue(request.type === 'inference-request' && request.chainId === chainId &&
    request.provider === provider && request.payer !== provider && typeof request.payer === 'string' &&
    /^[0-9a-f]{64}$/.test(request.payer) && typeof request.messagesHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.messagesHash),
    400, 'Wrong chain, payer or provider');
  const now = Date.now();
  requireValue(isCount(request.expiresAt) && request.expiresAt > now &&
    request.expiresAt <= now + MAX_REQUEST_AGE_MS, 400, 'Request expiry must be within ten minutes');
  requireValue(isCount(request.nonce, 1) && isCount(request.maxInputTokens, 1) &&
    isCount(request.maxOutputTokens, 1) && request.maxInputTokens + request.maxOutputTokens <= CONTEXT,
    400, 'Invalid nonce or token budget');
  requireValue(typeof signature === 'string' && verify(request.payer, request, signature), 403,
    'Invalid request signature');
  requireValue(Array.isArray(messages) && messages.length > 0 && messages.length <= 4096, 400,
    'Expected a nonempty text conversation');
  for (const [index, item] of messages.entries()) {
    requireValue(item && typeof item === 'object' && Object.keys(item).length === 2 &&
      (['user', 'assistant'].includes(item.role) || (index === 0 && item.role === 'system')) &&
      typeof item.content === 'string', 400, 'Expected text messages with an optional leading system message');
  }
  requireValue(messages.some(item => item.role === 'user') && request.messagesHash === hash(messages),
    400, 'Missing user message or mismatched messages hash');
}

export function createProviderServer({ wallet, chainId, ledgerUrl, strataUrl = 'http://127.0.0.1:8000/v1',
  engine = 'ryzenstrata', modelId, apiKey, timeoutMs = 60 * 60 * 1000,
  readState = readVerifiedState }) {
  const base = backendBase(strataUrl);
  requireValue(engine==='ryzenstrata' || engine==='strata',400,'Unknown Strata engine');
  const requested = modelId ?? (engine==='ryzenstrata' ? 'qwen3.8-flash-next-q2_0' : undefined);
  if (requested!==undefined) {
    requireValue(typeof requested==='string' && requested.length<=200 &&
      (qwenVariant(requested)!==null || (engine==='strata' && quantId.test(requested))),
    400,'Invalid Strata backend model ID');
  }
  requireValue(/^[0-9a-f]{64}$/.test(chainId) && isCount(timeoutMs, 1) &&
    timeoutMs <= 2147483647, 400, 'Invalid chain ID or timeout');
  const seen = new Map();
  let busy = false;
  let activeProfile;
  // Cache only the latest response so a dropped connection can be retried without retaining every chat.
  let previous;
  let clearPrevious;

  async function backend(path, body, deadline = 10_000, root = base) {
    const headers = {};
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    try {
      return await requestJson(root + path, { headers, body, timeoutMs: deadline, maxBytes: MAX_BYTES });
    } catch (err) {
      if (err.status) throw new ProviderError(502, 'Strata returned HTTP ' + err.status);
      throw new ProviderError(503, 'Could not reach the configured Strata backend');
    }
  }

  async function profile(deadline) {
    const [catalog,metrics]=await Promise.all([
      backend('/models',undefined,deadline),backend('/metrics',undefined,deadline,new URL(base).origin).catch(()=>{
        throw new ProviderError(503,'Strata runtime KV metrics are unavailable',{code:'KV_CACHE_PRECISION',
          kvCache:{k:null,v:null},minimumKvBits:8,source:'/metrics.engine'});
      })
    ]);
    const model=selectModel(catalog,engine,requested);
    return {...model,...runtimePrecision(metrics,model)};
  }

  // Coalesce simultaneous readiness checks and avoid a backend call for each RTT sample.
  // Inference independently checks the live profile immediately before generation.
  let probeProfile;
  let probeUntil = 0;
  async function probe(challenge) {
    requireValue(!busy, 429, 'Provider is handling another request');
    if (!probeProfile || Date.now() >= probeUntil) {
      probeUntil = Infinity;
      probeProfile = profile(800).finally(() => { probeUntil = Date.now() + 250; });
    }
    const {outputLimit,kvCache} = await probeProfile;
    requireValue(!busy, 429, 'Provider is handling another request');
    const payload = {
      domain:PROBE_DOMAIN, chainId, provider:wallet.address, challenge, available:true,
      model:MODEL, contextWindow:CONTEXT, kvCache, maxOutputTokens:Math.min(CONTEXT, outputLimit ?? CONTEXT)
    };
    return {payload, signature:sign(wallet.privateKey, payload)};
  }

  async function infer(body) {
    const { request, messages } = body;
    checkRequest(body, chainId, wallet.address);
    let state;
    try { state = await readState(ledgerUrl, chainId); }
    catch { throw new ProviderError(503, 'Could not verify pinned ledger'); }
    requireValue(state.chainId === chainId && state.providers.includes(wallet.address), 403,
      'Provider is not registered on this chain');
    const stage=state.networkStage;
    requireValue(request.nonce === (state.nonces[request.payer] ?? 0) + 1, 409, 'Payer nonce changed');
    requireValue(request.maxOutputTokens <= state.maxOutputTokens, 400, 'Output budget exceeds epoch limit');
    const reserve = charge({ inputTokens: request.maxInputTokens, cachedTokens: 0,
      outputTokens: request.maxOutputTokens });
    requireValue(decodeAmount(state.balances[request.payer] ?? 0) >= BigInt(reserve), 402, 'Insufficient balance for request budget');
    const requestHash = hash(request);
    const key = request.payer + ':' + request.nonce;
    const now = Date.now();
    for (const [id, until] of seen) if (until <= now) seen.delete(id);
    if (previous && previous.expiresAt <= now) previous = undefined;
    if (previous?.hash === requestHash) {
      requireValue(previous.stage===stage,409,'Network stage changed since the previous receipt');
      return previous.result;
    }
    requireValue(!seen.has(key), 409, 'Request nonce has already been used at this provider');
    requireValue(seen.size < 4096, 503, 'Provider replay window is full');
    const loaded=await profile();
    const { capacity, outputLimit, modelId, kvCache } = loaded;
    requireValue(!isCount(outputLimit, 1) || request.maxOutputTokens <= outputLimit,
      400, 'Output budget exceeds Strata output limit');
    if (request.maxInputTokens < capacity - request.maxOutputTokens) {
      // Both Strata engines expose their active tokenizer and template through this endpoint.
      const system = messages[0].role === 'system' ? messages[0].content : undefined;
      const estimate = await backend('/messages/count_tokens', {
        model: modelId, messages: system === undefined ? messages : messages.slice(1), system
      });
      requireValue(isCount(estimate?.input_tokens, 1), 502, 'Strata did not return a prompt count');
      requireValue(estimate.input_tokens <= request.maxInputTokens, 400, 'Prompt exceeds signed input budget');
    }
    requireValue(request.expiresAt > Date.now(), 400, 'Request expired before inference');
    activeProfile = loaded;
    let answer;
    try {
      answer = await backend('/chat/completions', {model:modelId,messages,
        max_tokens:request.maxOutputTokens,stream:false},timeoutMs);
    } finally {
      activeProfile = undefined;
    }
    const choice = answer?.choices?.[0];
    requireValue(answer?.model === modelId && choice?.message?.role === 'assistant' &&
      ['stop', 'length'].includes(choice.finish_reason), 502, 'Incomplete or unexpected Strata completion');
    const { content, reasoning_content: reasoning } = choice.message;
    requireValue((typeof content === 'string' || (content === null && typeof reasoning === 'string')) &&
      (reasoning == null || typeof reasoning === 'string'), 502, 'Invalid assistant content');
    const message = { role: 'assistant', content };
    if (typeof reasoning === 'string') message.reasoning_content = reasoning;
    const usage = answer.usage;
    const inputTokens = usage?.prompt_tokens;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
    const outputTokens = usage?.completion_tokens;
    requireValue(isCount(inputTokens, 1) && isCount(cachedTokens) && cachedTokens <= inputTokens &&
      isCount(outputTokens, 1) && inputTokens <= request.maxInputTokens &&
      outputTokens <= request.maxOutputTokens &&
      (usage.total_tokens === undefined || usage.total_tokens === inputTokens + outputTokens),
      502, 'Missing, inconsistent or out-of-budget Strata usage');
    const after=await profile();
    requireValue(after.modelId===modelId && after.capacity===capacity && after.generation===loaded.generation &&
      after.kvCache.k===kvCache.k && after.kvCache.v===kvCache.v,502,
    'Strata runtime model or KV cache changed during inference');
    let current;
    try {current=await readState(ledgerUrl,chainId);}
    catch {throw new ProviderError(503,'Could not recheck ledger before signing the receipt');}
    requireValue(current.chainId===chainId && current.networkStage===stage && current.providers.includes(wallet.address) &&
      request.nonce===(current.nonces[request.payer]??0)+1 && outputTokens<=current.maxOutputTokens,409,
    'Ledger rules or payer nonce changed during inference');
    const payload = { type: 'inference', chainId, from: request.payer, provider: wallet.address,
      nonce: request.nonce, model: MODEL, contextWindow: CONTEXT, requestHash, responseHash: hash(message),
      inputTokens, cachedTokens, outputTokens, ...(stage==='mainnet'?{kvCache}: {}) };
    const result = { message, payload, providerSignature: sign(wallet.privateKey, payload) };
    seen.set(key, request.expiresAt);
    previous = { hash: requestHash, result, expiresAt: request.expiresAt, stage };
    clearTimeout(clearPrevious);
    clearPrevious = setTimeout(() => { previous = undefined; }, Math.max(1, request.expiresAt - Date.now()));
    clearPrevious.unref();
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'GET' && req.url.startsWith('/v1/probe?')) {
        const match = /^\/v1\/probe\?challenge=([0-9a-f]{32})$/.exec(req.url);
        requireValue(match, 400, 'Expected a 16-byte hex challenge');
        return send(200, await probe(match[1]));
      }
      if (req.method === 'GET' && req.url === '/v1/info') {
        // The running request already passed the loaded-model and capacity checks.
        const current = activeProfile ?? await profile();
        return send(200, { provider: wallet.address, chainId, model: MODEL, contextWindow: CONTEXT,
          engine,backendModel:current.modelId, kvCache:current.kvCache, busy, inferenceActive:activeProfile!==undefined });
      }
      requireValue(req.method === 'POST' && req.url === '/v1/infer', 404, 'Route not found');
      requireValue((req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json',
        415, 'Expected application/json');
      requireValue(!busy, 429, 'Provider is handling another request');
      const body = await readBody(req);
      requireValue(body && typeof body === 'object', 400, 'Expected JSON object');
      requireValue(!busy, 429, 'Provider is handling another request');
      busy = true;
      try { send(200, await infer(body)); }
      finally { busy = false; }
    } catch (err) {
      send(err instanceof ProviderError ? err.status : 500,
        { error: err instanceof ProviderError ? err.message : 'Provider request failed',
          ...(err instanceof ProviderError ? err.details : {}) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 32;
  server.on('close', () => { clearTimeout(clearPrevious); previous = undefined; seen.clear(); });
  return server;
}
