import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, sign, verify } from './crypto.mjs';
import { CONTEXT, MODEL } from './ledger.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';
import { validateReasoningOptions } from './reasoning.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { PROBE_DOMAIN } from './routing.mjs';
import { requestJson } from './http.mjs';
import { MAX_RELAY_BOX, makeRelayKeyPair, openRelayBox, sealRelayBox } from './relay-crypto.mjs';

const HEX = /^[0-9a-f]{64}$/;
const MAX_WIRE = MAX_RELAY_BOX + 16_384;
const base = (url) => normalizeProviderEndpoint(url) + '/v1/relay';
const domain = op => 'gpuchain/relay-'+op+'/v1';
const salt = () => randomBytes(16).toString('hex');
const randomId = () => randomBytes(32).toString('hex');
const count = (n,min,max) => Number.isSafeInteger(n) && n >= min && n <= max;
const need = (ok,message) => { if (!ok) throw Error(message); };
const envelope = (wallet,payload) => ({payload,signature:sign(wallet.privateKey,payload)});
const signedNow = (wallet,op,meta) => envelope(wallet,{domain:domain(op),...meta,issuedAt:Date.now(),salt:salt()});

function validProfile(p,maxOutput,reasoning) {
  return p?.model === MODEL && p.contextWindow === CONTEXT && kvCacheAtLeastQ8(p.kvCache) &&
    count(p.maxOutputTokens,maxOutput,CONTEXT) && (!reasoning || p.reasoningOptions === 1);
}

function validOffer(offer,chainId,maxOutput,reasoning) {
  const p = offer?.payload, now = Date.now();
  return p?.domain === domain('presence') && p.chainId===chainId && HEX.test(p.publicKey) &&
    p.available===true && count(p.issuedAt,now-60_000,now+10_000) &&
    count(p.expiresAt,now+1,p.issuedAt+60_000) && validProfile(p,maxOutput,reasoning) &&
    verify(p.provider,p,offer.signature);
}

/** The observed RTT ends at the relay. It is not a full provider latency measurement. */
export async function listRelayOffers(relayUrl,chainId,{signal,maxOutputTokens=1,reasoning=false}={}) {
  const url=normalizeProviderEndpoint(relayUrl);
  const start=performance.now();
  const list=await requestJson(base(url)+'/providers',{timeoutMs:4000,maxBytes:1024*1024,signal});
  const latencyMs=performance.now()-start;
  need(list?.chainId===chainId && Array.isArray(list.providers),'Wrong relay network or directory');
  return list.providers.filter(o=>validOffer(o,chainId,maxOutputTokens,reasoning)).map(offer=>({
    provider:offer.payload.provider,url,transport:'relay',offer,latencyMs,latencyKind:'relay-rtt'
  }));
}

export async function getRelayOffer(relayUrl,chainId,provider,options) {
  const entry=(await listRelayOffers(relayUrl,chainId,options)).find(row=>row.provider===provider);
  need(entry,'No fresh signed offer from this relay provider');
  return entry;
}

function checkReceipt(result,request,messages) {
  const {message,payload,providerSignature}=result ?? {};
  need(message?.role==='assistant' && (typeof message.content==='string' ||
    (message.content===null && typeof message.reasoning_content==='string')),'Invalid relay response');
  need(payload?.type==='inference' && payload.chainId===request.chainId && payload.from===request.payer &&
    payload.provider===request.provider && payload.nonce===request.nonce && payload.requestHash===hash(request) &&
    payload.responseHash===hash(message) && request.messagesHash===hash(messages) &&
    payload.model===MODEL && payload.contextWindow===CONTEXT &&
    count(payload.inputTokens,1,request.maxInputTokens) && count(payload.cachedTokens,0,payload.inputTokens) &&
    count(payload.outputTokens,1,request.maxOutputTokens) && (payload.kvCache===undefined || kvCacheAtLeastQ8(payload.kvCache)) &&
    verify(request.provider,payload,providerSignature),'Invalid relay inference receipt');
  return result;
}

function transient(error) {
  return !error.status || error.status===429 || error.status>=500;
}

/** Encrypt and submit one exact job; a relay is never given a plaintext request or reply. */
export async function relayInfer({wallet,relayUrl,chainId,provider,offer,request,signature,messages,
  signal,pollMs=1000,resultTimeoutMs=3_630_000}) {
  validateReasoningOptions(request);
  need(request?.payer===wallet.address && request.provider===provider && request.chainId===chainId &&
    verify(wallet.address,request,signature) && hash(messages)===request.messagesHash,'Invalid relay request signature or messages');
  const reasoning=request.reasoningEffort!==undefined || request.reasoningBudgetTokens!==undefined;
  const options={maxOutputTokens:request.maxOutputTokens,reasoning,signal};
  if (!validOffer(offer,chainId,request.maxOutputTokens,reasoning) || offer.payload.provider!==provider) {
    ({offer}=await getRelayOffer(relayUrl,chainId,provider,options));
  }
  const pair=makeRelayKeyPair(), blind=randomId();
  const authorization={domain:domain('submit'),chainId,payer:wallet.address,provider,jobId:randomId(),
    providerKey:offer.payload.publicKey,clientKey:pair.publicKey,requestHash:hash({request,blind}),
    nonce:request.nonce,maxInputTokens:request.maxInputTokens,maxOutputTokens:request.maxOutputTokens,
    issuedAt:Date.now(),expiresAt:request.expiresAt};
  for (const key of ['reasoningEffort','reasoningBudgetTokens']) {
    if (request[key]!==undefined) authorization[key]=request[key];
  }
  const box=sealRelayBox(pair.privateKey,authorization.providerKey,authorization,'request',{request,signature,messages,blind});
  authorization.boxHash=hash(box);
  const submit={...envelope(wallet,authorization),box};
  const relay=base(relayUrl);
  const post=(op,body,timeoutMs=15_000)=>requestJson(relay+'/'+op,{body,maxBytes:MAX_WIRE,timeoutMs,signal});
  let accepted;
  try { accepted=await post('submit',submit); }
  catch (err) {
    if (!transient(err) || signal?.aborted) throw err;
    // Retry the identical ID, authorization and ciphertext only if the outcome is unknown.
    accepted=await post('submit',submit);
  }
  need(accepted.jobId===authorization.jobId,'Relay accepted a different job');
  const due=performance.now()+resultTimeoutMs;
  while (performance.now()<due) {
    signal?.throwIfAborted();
    let reply;
    try {
      reply=await post('result',signedNow(wallet,'result',{chainId,payer:wallet.address,jobId:authorization.jobId}));
    } catch (err) {
      if (!transient(err) || signal?.aborted) throw err;
    }
    if (reply) {
      need(reply.jobId===authorization.jobId,'Unexpected relay job ID');
      if (reply.status==='done') {
        const proof=reply.reply, meta=proof?.payload;
        need(meta?.domain===domain('complete') && meta.jobId===authorization.jobId && meta.chainId===chainId &&
          meta.provider===provider && meta.boxHash===hash(proof.box) && verify(provider,meta,proof.signature),
        'Invalid signed relay completion');
        const data=openRelayBox(pair.privateKey,authorization.providerKey,authorization,'response',proof.box);
        if (data.error) throw Error('Provider could not complete the relay request: '+String(data.error.code).slice(0,80));
        return checkReceipt(data.result,request,messages);
      }
      need(reply.status==='queued'||reply.status==='running','Relay job expired or unavailable');
    }
    await delay(Math.min(pollMs,Math.max(1,due-performance.now())),undefined,{signal});
  }
  throw Error('Timed out waiting for the relay job; no inference receipt was accepted');
}

/** Pump the fixed local adapter. At most one encrypted job is processed at a time. */
export function startProviderRelay({wallet,chainId,relayUrl,adapterUrl,readState,
  pollMs=5000,presenceMs=25_000,inferenceTimeoutMs=3_610_000}) {
  const adapter=normalizeProviderEndpoint(adapterUrl);
  need(new URL(adapter).hostname==='127.0.0.1' || new URL(adapter).hostname==='[::1]','Expected numeric loopback adapter');
  const relay=base(relayUrl), pair=makeRelayKeyPair(), controller=new AbortController(), signal=controller.signal;
  const completed=new Map();
  let state='starting',lastContactAt=null,error=null,lastOffer,nextPresence=0,pending,closing;
  const options=(timeoutMs,maxBytes)=>({timeoutMs,maxBytes,signal});
  async function post(op,body,maxBytes=16_384) {
    const result=await requestJson(relay+'/'+op,{body,...options(12_000,maxBytes)});
    lastContactAt=new Date().toISOString();
    return result;
  }
  function presence(profile,available) {
    const now=Date.now();
    const p={domain:domain('presence'),chainId,provider:wallet.address,publicKey:pair.publicKey,
      model:MODEL,contextWindow:CONTEXT,kvCache:profile.kvCache,maxOutputTokens:profile.maxOutputTokens,
      available,issuedAt:now,expiresAt:now+60_000};
    if (profile.reasoningOptions===1) p.reasoningOptions=1;
    return envelope(wallet,p);
  }
  async function probe() {
    const challenge=salt();
    const proof=await requestJson(adapter+'/v1/probe?challenge='+challenge,options(3000,8192));
    const p=proof?.payload;
    need(p?.domain===PROBE_DOMAIN && p.provider===wallet.address && p.chainId===chainId &&
      p.challenge===challenge && p.available===true && validProfile(p,1,false) &&
      verify(wallet.address,p,proof.signature),'Local adapter is not ready');
    if (readState) {
      const observed=await readState(relayUrl,chainId);
      need(observed?.chainId===chainId && observed.providers.includes(wallet.address),'Provider is not registered');
    }
    return p;
  }
  async function processJob(job) {
    const p=job?.payload;
    need(p?.domain===domain('submit') && p.chainId===chainId && p.provider===wallet.address && p.providerKey===pair.publicKey &&
      HEX.test(p.jobId) && HEX.test(p.clientKey) && p.payer!==wallet.address && p.boxHash===hash(job.box) &&
      verify(p.payer,p,job.signature),'Invalid buyer relay authorization');
    need(!completed.has(p.jobId),'Relay offered an already completed job');
    let out;
    try {
      const now=Date.now();
      need(count(p.issuedAt,now-600_000,now+10_000) && count(p.expiresAt,now+1,p.issuedAt+600_000),
        'Expired relay job');
      const {request,signature,messages,blind}=openRelayBox(pair.privateKey,p.clientKey,p,'request',job.box);
      need(request?.type==='inference-request' && HEX.test(blind) && p.requestHash===hash({request,blind}) &&
        request.chainId===chainId && request.payer===p.payer && request.provider===wallet.address &&
        request.nonce===p.nonce && request.maxInputTokens===p.maxInputTokens && request.maxOutputTokens===p.maxOutputTokens &&
        request.reasoningEffort===p.reasoningEffort && request.reasoningBudgetTokens===p.reasoningBudgetTokens &&
        request.expiresAt===p.expiresAt && request.messagesHash===hash(messages) && verify(p.payer,request,signature),
      'Invalid decrypted request');
      validateReasoningOptions(request);
      const result=await requestJson(adapter+'/v1/infer',{body:{request,signature,messages},
        ...options(inferenceTimeoutMs,8*1024*1024)});
      out={result:checkReceipt(result,request,messages)};
    } catch (err) {
      if (signal.aborted) throw err;
      // The relay and logs never receive private engine errors, prompts or responses.
      out={error:{code:err.status ? 'ADAPTER_HTTP_'+err.status : 'INVALID_REQUEST_OR_RESPONSE'}};
    }
    let box;
    try { box=sealRelayBox(pair.privateKey,p.clientKey,p,'response',out); }
    catch { box=sealRelayBox(pair.privateKey,p.clientKey,p,'response',{error:{code:'REPLY_EXCEEDS_RELAY_LIMIT'}}); }
    pending={jobId:p.jobId,box,expiresAt:p.expiresAt};
  }
  async function cycle() {
    if (pending) {
      const p={domain:domain('complete'),chainId,provider:wallet.address,jobId:pending.jobId,
        boxHash:hash(pending.box),issuedAt:Date.now(),salt:salt()};
      try { await post('complete',{...envelope(wallet,p),box:pending.box}); }
      catch (err) {
        if (transient(err) || signal.aborted) throw err;
        if (![404,410].includes(err.status)) throw err;
      }
      completed.set(pending.jobId,pending.expiresAt);
      pending=undefined;
      nextPresence=0;
    }
    const now=Date.now();
    for (const [id,expires] of completed) if (expires<=now) completed.delete(id);
    if (now>=nextPresence) {
      let profile;
      try { profile=await probe(); }
      catch (err) {
        if (lastOffer && !signal.aborted) {
          try { await post('presence',presence(lastOffer,false)); } catch { /* Prior offer expires. */ }
          lastOffer=undefined;
        }
        state='offline';
        throw err;
      }
      await post('presence',presence(profile,true));
      lastOffer=profile;
      nextPresence=Date.now()+presenceMs;
    }
    state='ready';error=null;
    const {job}=await post('poll',signedNow(wallet,'poll',{chainId,provider:wallet.address}),MAX_WIRE);
    if (!job) return;
    state='busy';
    await processJob(job);
  }
  const pumping=(async()=>{
    while (!signal.aborted) {
      try { await cycle(); }
      catch (err) {
        if (signal.aborted) break;
        if (state!=='offline') state='error';
        error=err.status ? 'Relay or local adapter returned HTTP '+err.status : 'Relay connection or authentication failed';
        try { await delay(pollMs,undefined,{signal}); } catch { break; }
        continue;
      }
      if (pending) continue;
      try { await delay(pollMs,undefined,{signal}); } catch { break; }
    }
  })();
  return {status:()=>({state,lastContactAt,error}),close() {
    if (!closing) closing=(async()=>{
      controller.abort();
      await pumping;
      if (lastOffer) {
        try { await requestJson(relay+'/presence',{body:presence(lastOffer,false),timeoutMs:2000,maxBytes:4096}); }
        catch { /* Offline announcement is best effort; live lease is bounded. */ }
      }
      state='stopped';error=null;
    })();
    return closing;
  }};
}
