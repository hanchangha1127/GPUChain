import { hash, sign, verify } from './crypto.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { charge, CONTEXT, MODEL, spendableBalance } from './ledger.mjs';
import { formatCoins } from './amount.mjs';
import { chatResponseHash, normalizeChatMessages, normalizeChatOptions, validateChatReply } from './chat-protocol.mjs';
import { inferenceRoutes } from './inference-routes.mjs';
import { probeProvider } from './routing.mjs';
import { relayInfer } from './relay-client.mjs';
import { requestJson } from './http.mjs';
import { streamAdapter, trackAssistantDeltas } from './inference-stream.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';
import { reasoningEffort, validateReasoningOptions } from './reasoning.mjs';
import { resolvePublicLedger } from './public-network.mjs';
import { submitSignedTransaction } from './submit-transaction.mjs';

function requireValue(ok, status, message) {
  if (!ok) throw Object.assign(Error(message),{status});
}

function bounded(value,label,min,max) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max,400,'Invalid ' + label);
  return value;
}

const warmRelayGraceMs=1500;

async function waitForWarmRelay(ledger,discovery,provider) {
  const deadline=AbortSignal.timeout(warmRelayGraceMs);
  const signal=discovery.signal ? AbortSignal.any([deadline,discovery.signal]) : deadline;
  try {
    do {
      await delay(250,undefined,{signal});
      const [target]=await inferenceRoutes(ledger,{...discovery,provider,signal});
      if (target) return target;
    } while (!signal.aborted);
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  discovery.signal?.throwIfAborted();
}

async function selectTarget(ledger, {wallet, transport='auto', providerAddress, providerUrl, preferredProvider, signal}, limits) {
  const {state} = ledger;
  requireValue(['auto','direct','relay'].includes(transport),400,'Transport must be auto, direct or relay');
  if (providerAddress !== undefined) {
    requireValue(typeof providerAddress==='string' && /^[a-f0-9]{64}$/.test(providerAddress),400,'Invalid provider address');
    requireValue(state.providers.includes(providerAddress),400,'Provider is absent from trusted chain');
    requireValue(providerAddress !== wallet.address,400,'Provider cannot pay itself');
  }
  if (providerUrl !== undefined) {
    requireValue(providerAddress && transport!=='relay',400,
      'A direct --provider-url requires --provider-address and a direct or automatic transport');
    const target = {provider:providerAddress,url:providerUrl,transport:'direct',latencyKind:'provider-rtt'};
    target.latencyMs = await probeProvider(target,state.chainId,limits.maxOutputTokens,limits.reasoning,limits.chatProtocol);
    return target;
  }
  if (state.providers.length===1 && state.providers[0]===wallet.address) {
    throw Object.assign(Error('This wallet is the only registered provider. Use a different funded requester wallet.'),{
      status:503,code:'self_provider_only'});
  }
  const discovery = {payer:wallet.address,transport,signal,...limits};
  if (!providerAddress && preferredProvider && preferredProvider!==wallet.address && state.providers.includes(preferredProvider)) {
    const [warm] = await inferenceRoutes(ledger,{...discovery,provider:preferredProvider});
    if (warm) return warm;
    // Some relays hide a provider while it is serving another request. A short
    // wait can reuse its resident prefix without resubmitting a paid job.
    if (transport==='relay') {
      const ready=await waitForWarmRelay(ledger,discovery,preferredProvider);
      if (ready) return ready;
    } else discovery.excludeProvider = preferredProvider;
  }
  const [target] = await inferenceRoutes(ledger,{...discovery,provider:providerAddress});
  signal?.throwIfAborted();
  if (!target && transport==='relay') {
    throw Object.assign(Error('No compatible encrypted GPUChain provider is ready for this wallet.'),{
      status:503,code:'no_encrypted_provider'});
  }
  requireValue(target,503,limits.chatProtocol
    ? 'No available chat-protocol provider for this payer and token budget'
    : 'No available registered provider responded. Check advertised endpoints with routes.');
  return target;
}

function validateReceipt(result, {request,state,chatOptions}) {
  const {message, payload, providerSignature, finishReason} = result;
  let replyHash;
  if (chatOptions !== undefined) {
    validateChatReply(message,finishReason,chatOptions);
    replyHash = chatResponseHash(message,finishReason);
  } else {
    requireValue(message?.role==='assistant' && (typeof message.content==='string' ||
      (message.content===null && typeof message.reasoning_content==='string')),502,'Invalid assistant message');
    replyHash = hash(message);
  }
  const inputTokens = bounded(payload?.inputTokens,'receipt inputTokens',0,request.maxInputTokens);
  const cachedTokens = bounded(payload.cachedTokens,'receipt cachedTokens',0,inputTokens);
  const outputTokens = bounded(payload.outputTokens,'receipt outputTokens',0,request.maxOutputTokens);
  const expected = {
    type:'inference',chainId:request.chainId,from:request.payer,provider:request.provider,nonce:request.nonce,
    model:MODEL,contextWindow:CONTEXT,requestHash:hash(request),responseHash:replyHash,inputTokens,cachedTokens,outputTokens
  };
  if (state.networkStage==='mainnet') {
    requireValue(kvCacheAtLeastQ8(payload.kvCache),502,'Receipt requires K and V at Q8 or above');
    expected.kvCache = payload.kvCache;
  }
  requireValue(hash(payload)===hash(expected) && verify(request.provider,expected,providerSignature),
    502,'Invalid provider receipt');
  return expected;
}

/** Select one eligible provider, bind its response to the request, and settle exactly once. */
export async function purchaseChat(options, {resolveLedger=()=>resolvePublicLedger({write:true}),ledger}={}) {
  const {wallet,signal,onDelta}=options;
  signal?.throwIfAborted();
  requireValue(onDelta===undefined || typeof onDelta==='function',400,'Invalid stream callback');
  const chatOptions=onDelta ? normalizeChatOptions({...options.chatOptions,stream:true})
    : options.chatOptions===undefined ? undefined : normalizeChatOptions(options.chatOptions);
  requireValue(!chatOptions?.stream || onDelta,400,'Streaming requires a delta callback');
  const messages=chatOptions===undefined ? structuredClone(options.messages) : normalizeChatMessages(options.messages);
  ledger ??= await resolveLedger();
  const {state}=ledger;
  const maxOutputTokens=bounded(options.maxOutputTokens ?? Math.min(512,state.maxOutputTokens),
    'max-output',1,state.maxOutputTokens);
  const maxInputTokens=bounded(options.maxInputTokens ?? CONTEXT-maxOutputTokens,'max-input',1,CONTEXT-maxOutputTokens);
  const reasoning={};
  if (options.reasoningEffort!==undefined) reasoning.reasoningEffort=reasoningEffort(options.reasoningEffort);
  if (options.reasoningBudgetTokens!==undefined) reasoning.reasoningBudgetTokens=options.reasoningBudgetTokens;
  validateReasoningOptions({...reasoning,maxOutputTokens});
  const cap=charge({inputTokens:maxInputTokens,cachedTokens:0,outputTokens:maxOutputTokens});
  requireValue(spendableBalance(state,wallet.address)>=BigInt(cap),402,
    'Insufficient balance for authorized token limits');
  const target=await selectTarget(ledger,options,{maxOutputTokens,reasoning:Object.keys(reasoning).length>0,
    chatProtocol:chatOptions!==undefined});
  const {provider,url}=target;
  const request={
    type:'inference-request',chainId:state.chainId,payer:wallet.address,provider,
    nonce:(state.nonces[wallet.address] ?? 0)+1,expiresAt:Date.now()+300_000,
    messagesHash:hash(messages),maxOutputTokens,maxInputTokens,...reasoning
  };
  if (chatOptions!==undefined) request.chatOptionsHash=hash(chatOptions);
  const signature=sign(wallet.privateKey,request);
  signal?.throwIfAborted();
  // After dispatch, complete metering/settlement even if the local HTTP client disconnects.
  const tracker=onDelta && target.transport==='direct' ? trackAssistantDeltas(onDelta) : undefined;
  const body={request,signature,messages,chatOptions};
  let result;
  if (target.transport==='relay') {
    result=await relayInfer({wallet,relayUrl:url,chainId:state.chainId,provider,offer:target.offer,
      ...body,onDelta});
  } else if (tracker) {
    result=await streamAdapter(url+'/v1/infer',body,tracker.push);
  } else {
    result=await requestJson(url+'/v1/infer',{body,timeoutMs:3_630_000});
  }
  const expected=validateReceipt(result,{request,state,chatOptions});
  tracker?.verify(result.message);
  const targetLedger=await resolveLedger();
  requireValue(targetLedger.state.chainId===state.chainId && targetLedger.state.networkStage===state.networkStage,
    409,'Ledger network changed during inference');
  requireValue((targetLedger.state.nonces[wallet.address] ?? 0)+1===request.nonce,409,
    'Wallet nonce changed during inference; receipt could not be settled');
  const tx={payload:expected,signature:sign(wallet.privateKey,expected),providerSignature:result.providerSignature};
  const settlement=await submitSignedTransaction(targetLedger,tx);
  const {inputTokens,cachedTokens,outputTokens}=expected;
  return {provider,providerUrl:url,transport:target.transport,latencyKind:target.latencyKind,
    latencyMs:target.latencyMs,reasoning,message:result.message,finishReason:result.finishReason,
    usage:{inputTokens,cachedTokens,outputTokens},coins:formatCoins(charge(expected)),settlement};
}
