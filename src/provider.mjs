import http from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { hash, sign, verify } from './crypto.mjs';
import { charge, CONTEXT, MODEL } from './ledger.mjs';
import { decodeAmount } from './amount.mjs';
import { readVerifiedState } from './node.mjs';
import { requestJson, requestJsonResponse } from './http.mjs';
import { normalizeChatOptions, normalizeChatMessages, richCountBody, validateChatReply, chatResponseHash } from './chat-protocol.mjs';
import { readStrataCompletion } from './strata-stream.mjs';
import { PROBE_DOMAIN } from './routing.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';
import { REASONING_EFFORTS, validateReasoningOptions, backendReasoning } from './reasoning.mjs';

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

function checkRequest({ request, signature, messages, chatOptions }, chainId, provider) {
  const fields = [...REQUEST_FIELDS,...['reasoningEffort','reasoningBudgetTokens','chatOptionsHash'].filter(k=>request && Object.hasOwn(request,k))].sort();
  requireValue(request && typeof request === 'object' &&
    Object.keys(request).sort().join('|') === fields.join('|'), 400, 'Invalid request fields');
  try { validateReasoningOptions(request); } catch (err) { throw new ProviderError(400,err.message); }
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
  if (request.chatOptionsHash !== undefined || chatOptions !== undefined) {
    requireValue(typeof request.chatOptionsHash === 'string' && chatOptions && request.chatOptionsHash === hash(chatOptions) &&
      Array.isArray(messages) && request.messagesHash === hash(messages), 400,'Invalid signed chat options or messages');
    try { return {messages:normalizeChatMessages(messages),chatOptions:normalizeChatOptions(chatOptions)}; }
    catch { throw new ProviderError(400,'Invalid chat options or messages'); }
  }
  requireValue(Array.isArray(messages) && messages.length > 0 && messages.length <= 4096, 400,
    'Expected a nonempty text conversation');
  for (const [index, item] of messages.entries()) {
    requireValue(item && typeof item === 'object' && Object.keys(item).length === 2 &&
      (['user', 'assistant'].includes(item.role) || (index === 0 && item.role === 'system')) &&
      typeof item.content === 'string', 400, 'Expected text messages with an optional leading system message');
  }
  requireValue(messages.some(item => item.role === 'user') && request.messagesHash === hash(messages),
    400, 'Missing user message or mismatched messages hash');
  return {messages};
}

export function createStrataBackend({strataUrl = 'http://127.0.0.1:8000/v1', engine = 'ryzenstrata', modelId, apiKey} = {}) {
  const base = backendBase(strataUrl);
  const origin = new URL(base).origin;
  const auth = apiKey ? {authorization:'Bearer '+apiKey} : {};
  requireValue(engine==='ryzenstrata' || engine==='strata',400,'Unknown Strata engine');
  const requested = modelId ?? (engine==='ryzenstrata' ? 'qwen3.8-flash-next-q2_0' : undefined);
  if (requested!==undefined) {
    requireValue(typeof requested==='string' && requested.length<=200 &&
      (qwenVariant(requested)!==null || (engine==='strata' && quantId.test(requested))),
    400,'Invalid Strata backend model ID');
  }

  async function backend(path, body, deadline = 10_000, root = base) {
    try {
      return await requestJson(root + path, { headers:auth, body, timeoutMs: deadline, maxBytes: MAX_BYTES });
    } catch (err) {
      if (err.status) throw new ProviderError(502, 'Strata returned HTTP ' + err.status);
      throw new ProviderError(503, 'Could not reach the configured Strata backend');
    }
  }

  async function checkRequestMonitor(deadline = 10_000) {
    let response;
    try {
      // The monitor page is a capability check. Never fetch its request records.
      response=await fetch(origin+'/api-monitor',{headers:auth,redirect:'error',signal:AbortSignal.timeout(deadline)});
    } catch { throw new ProviderError(503,'Could not check the Strata request monitor'); }
    await response.body?.cancel().catch(()=>{});
    if (![404,405,501].includes(response.status)) {
      throw new ProviderError(503,'Disable the Strata API request monitor to offer GPUChain inference',
        {code:'REQUEST_MONITOR_UNSAFE'});
    }
  }

  async function profile(deadline) {
    const [catalog,metrics]=await Promise.all([
      backend('/models',undefined,deadline),backend('/metrics',undefined,deadline,origin).catch(()=>{
        throw new ProviderError(503,'Strata runtime KV metrics are unavailable',{code:'KV_CACHE_PRECISION',
          kvCache:{k:null,v:null},minimumKvBits:8,source:'/metrics.engine'});
      }),checkRequestMonitor(deadline)
    ]);
    const model=selectModel(catalog,engine,requested);
    return {...model,...runtimePrecision(metrics,model),engine};
  }
  async function stream(body,deadline,signal,onDelta) {
    let response;
    try {
      response=await requestJsonResponse(base+'/chat/completions', {body,signal,timeoutMs:deadline,maxBytes:MAX_BYTES,
        headers:{accept:'text/event-stream',...auth}});
      return await readStrataCompletion(response,body.model,onDelta);
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      throw new ProviderError(502, err.status ? 'Strata returned HTTP '+err.status : 'Invalid or interrupted Strata event stream');
    } finally { response?.destroy(); }
  }
  return {profile,backend,stream};
}

export function createProviderServer({ wallet, chainId, ledgerUrl, strataUrl, engine, modelId, apiKey,
  timeoutMs = 60 * 60 * 1000, readState = readVerifiedState, getBackend }) {
  requireValue(/^[0-9a-f]{64}$/.test(chainId) && isCount(timeoutMs, 1) &&
    timeoutMs <= 2147483647, 400, 'Invalid chain ID or timeout');
  const fixed = getBackend ? undefined : createStrataBackend({strataUrl,engine,modelId,apiKey});
  function selected() {
    const adapter = getBackend ? getBackend() : fixed;
    requireValue(adapter,503,'Waiting for an eligible local Strata backend');
    return adapter;
  }
  const seen = new Map();
  let busy = false;
  let activeProfile;
  // Keep only one encrypted retry receipt, with a key scoped to this process.
  const retryKey = randomBytes(32);
  let previous;
  let clearPrevious;
  function erasePrevious() {
    clearTimeout(clearPrevious);
    previous?.ciphertext.fill(0);
    previous=undefined;
  }
  function saveRetry(requestHash,result,expiresAt,stage) {
    const iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',retryKey,iv);
    cipher.setAAD(Buffer.from(requestHash,'hex'));
    const plaintext=Buffer.from(JSON.stringify(result));
    try {
      const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      erasePrevious();
      previous={hash:requestHash,ciphertext,iv,tag:cipher.getAuthTag(),expiresAt,stage};
      clearPrevious=setTimeout(erasePrevious,Math.max(1,expiresAt-Date.now()));
      clearPrevious.unref();
    } finally { plaintext.fill(0); }
  }
  function retryResult(entry) {
    const {hash:requestHash,ciphertext,iv,tag}=entry;
    const decipher=createDecipheriv('aes-256-gcm',retryKey,iv);
    decipher.setAAD(Buffer.from(requestHash,'hex'));
    decipher.setAuthTag(tag);
    // GCM releases most bytes from update(), but they are usable only after final() authenticates.
    const plaintext=decipher.update(ciphertext);
    try { decipher.final(); return JSON.parse(plaintext.toString('utf8')); }
    finally { plaintext.fill(0); }
  }

  // Coalesce simultaneous readiness checks and avoid a backend call for each RTT sample.
  // Inference independently checks the live profile immediately before generation.
  let probeProfile;
  let probeUntil = 0;
  let probedBackend;
  async function probe(challenge) {
    requireValue(!busy, 429, 'Provider is handling another request');
    const adapter = selected();
    if (!probeProfile || adapter !== probedBackend || Date.now() >= probeUntil) {
      probedBackend = adapter;
      probeUntil = Infinity;
      probeProfile = adapter.profile(800).finally(() => { if (probedBackend === adapter) probeUntil = Date.now() + 250; });
    }
    const {outputLimit,kvCache} = await probeProfile;
    requireValue(selected()===adapter,503,'Strata selection changed during probe');
    requireValue(!busy, 429, 'Provider is handling another request');
    const payload = {
      domain:PROBE_DOMAIN, chainId, provider:wallet.address, challenge, available:true,
      model:MODEL, contextWindow:CONTEXT, kvCache, reasoningOptions:1, chatProtocol:1, maxOutputTokens:Math.min(CONTEXT, outputLimit ?? CONTEXT)
    };
    return {payload, signature:sign(wallet.privateKey, payload)};
  }

  async function infer(body,signal,onDelta,startEvents) {
    const { request } = body;
    const { messages,chatOptions } = checkRequest(body, chainId, wallet.address);
    requireValue(Boolean(onDelta) === (chatOptions?.stream === true),400,'Streaming requires signed stream=true and Accept: text/event-stream');
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
    if (previous && previous.expiresAt <= now) erasePrevious();
    if (previous?.hash === requestHash) {
      requireValue(previous.stage===stage,409,'Network stage changed since the previous receipt');
      const result=retryResult(previous);
      if (onDelta) {
        const {tool_calls,...delta}=result.message;
        if (tool_calls) delta.tool_calls=tool_calls.map((call,index)=>({index,...call}));
        await onDelta(delta);
      }
      return result;
    }
    requireValue(!seen.has(key), 409, 'Request nonce has already been used at this provider');
    requireValue(seen.size < 4096, 503, 'Provider replay window is full');
    // Pin the complete request, including final metering checks, to the same backend.
    const {profile,backend,stream}=selected();
    const loaded=await profile();
    const { capacity, outputLimit, modelId, kvCache } = loaded;
    requireValue(!isCount(outputLimit, 1) || request.maxOutputTokens <= outputLimit,
      400, 'Output budget exceeds Strata output limit');
    if (request.maxInputTokens < capacity - request.maxOutputTokens) {
      // Both Strata engines expose their active tokenizer and template through this endpoint.
      const system = messages[0].role === 'system' ? messages[0].content : undefined;
      const countBody = chatOptions ? richCountBody(messages,chatOptions) :
        {messages:system === undefined ? messages : messages.slice(1), system};
      const estimate = await backend('/messages/count_tokens', {model:modelId,...countBody,...backendReasoning(request,true)});
      requireValue(isCount(estimate?.input_tokens, 1), 502, 'Strata did not return a prompt count');
      requireValue(estimate.input_tokens <= request.maxInputTokens, 400, 'Prompt exceeds signed input budget');
    }
    requireValue(request.expiresAt > Date.now(), 400, 'Request expired before inference');
    activeProfile = loaded;
    let answer;
    try {
      signal.throwIfAborted();
      const nativeBody = {model:modelId,messages,max_tokens:request.maxOutputTokens,stream:false,
        ...chatOptions,...backendReasoning(request)};
      if (onDelta) {
        requireValue(typeof stream === 'function',503,'Selected backend does not support streaming');
        startEvents();
        nativeBody.stream_options={include_usage:true};
        answer = await stream(nativeBody,timeoutMs,signal,onDelta);
      } else answer = await backend('/chat/completions',nativeBody,timeoutMs);
    } finally {
      activeProfile = undefined;
    }
    const choice = answer?.choices?.[0];
    requireValue(answer?.model === modelId && choice?.message?.role === 'assistant',502,'Incomplete or unexpected Strata completion');
    let message;
    if (chatOptions) {
      try { message=validateChatReply(choice.message,choice.finish_reason,chatOptions); }
      catch { throw new ProviderError(502,'Invalid Strata assistant message or finish reason'); }
    } else {
      requireValue(['stop','length'].includes(choice.finish_reason),502,'Incomplete or unexpected Strata completion');
      const { content, reasoning_content: reasoning } = choice.message;
      requireValue((typeof content === 'string' || (content === null && typeof reasoning === 'string')) &&
        (reasoning == null || typeof reasoning === 'string'), 502, 'Invalid assistant content');
      message = {role:'assistant',content};
      if (typeof reasoning === 'string') message.reasoning_content=reasoning;
    }
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
    signal.throwIfAborted();
    const finishReason=chatOptions ? choice.finish_reason : undefined;
    const payload = { type: 'inference', chainId, from: request.payer, provider: wallet.address,
      nonce: request.nonce, model: MODEL, contextWindow: CONTEXT, requestHash, responseHash: chatResponseHash(message,finishReason),
      inputTokens, cachedTokens, outputTokens, ...(stage==='mainnet'?{kvCache}: {}) };
    const result = { message, ...(chatOptions ? {finishReason} : {}), payload, providerSignature: sign(wallet.privateKey, payload) };
    seen.set(key, request.expiresAt);
    saveRetry(requestHash,result,request.expiresAt,stage);
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const cancel = new AbortController();
    res.once('close',()=>{ if (!res.writableFinished) cancel.abort(); });
    let heartbeat;
    function startEvents() {
      cancel.signal.throwIfAborted();
      if (!res.headersSent) {
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});
        res.flushHeaders();
        heartbeat = setInterval(()=>{ if (!res.destroyed && !res.writableNeedDrain) res.write(': keep-alive\n\n'); },15000);
        heartbeat.unref();
      }
    }
    async function sendEvent(event,data) {
      startEvents();
      if (!res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n')) {
        await once(res,'drain',{signal:cancel.signal});
      }
    }
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
        const current = activeProfile ?? await selected().profile();
        return send(200, { provider: wallet.address, chainId, model: MODEL, contextWindow: CONTEXT,
          engine:current.engine,backendModel:current.modelId, kvCache:current.kvCache,
          reasoningEfforts:REASONING_EFFORTS, reasoningBudget:true, chatProtocol:1, busy, inferenceActive:activeProfile!==undefined });
      }
      requireValue(req.method === 'POST' && req.url === '/v1/infer', 404, 'Route not found');
      requireValue((req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json',
        415, 'Expected application/json');
      requireValue(!busy, 429, 'Provider is handling another request');
      const body = await readBody(req);
      requireValue(body && typeof body === 'object', 400, 'Expected JSON object');
      requireValue(!busy, 429, 'Provider is handling another request');
      busy = true;
      const streaming = (req.headers.accept ?? '').split(',').some(type=>type.split(';')[0].trim() === 'text/event-stream');
      try {
        const result = await infer(body,cancel.signal,streaming ? delta=>sendEvent('delta',delta) : undefined,startEvents);
        if (streaming) { await sendEvent('receipt',result); res.end(); }
        else send(200,result);
      }
      finally { busy = false; }
    } catch (err) {
      if (res.destroyed || cancel.signal.aborted) return;
      const error = {error:err instanceof ProviderError ? err.message : 'Provider request failed',
        ...(err instanceof ProviderError ? err.details : {})};
      if (res.headersSent) res.end('event: error\ndata: '+JSON.stringify(error)+'\n\n');
      else send(err instanceof ProviderError ? err.status : 500,error);
    } finally { clearInterval(heartbeat); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 32;
  server.on('close', () => { erasePrevious(); retryKey.fill(0); seen.clear(); });
  return server;
}
