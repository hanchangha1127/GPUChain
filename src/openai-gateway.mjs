import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { affinityKeys, openCacheAffinity } from './cache-affinity.mjs';
import { normalizeChatMessages, normalizeChatOptions } from './chat-protocol.mjs';
import { purchaseChat } from './consumer-chat.mjs';
import { CONTEXT, MODEL } from './ledger.mjs';
import { reasoningEffort, validateReasoningOptions } from './reasoning.mjs';

const MAX_BODY = 8 * 1024 * 1024;
const MAX_PENDING = 4;
const commonHeaders = {
  'cache-control':'no-store',
  'x-content-type-options':'nosniff',
  'cross-origin-resource-policy':'same-origin',
};
const optionKeys = ['tools','tool_choice','parallel_tool_calls','temperature','top_p','stop','seed',
  'presence_penalty','frequency_penalty'];
const allowedFields = new Set(['model','messages','n','stream','stream_options','max_tokens','max_completion_tokens',
  'reasoning','reasoning_effort','reasoning_budget_tokens','user','store','response_format','prompt_cache_key',...optionKeys]);
const digest = value => createHash('sha256').update(value).digest();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class GatewayError extends Error {
  constructor(status,code,message,param=null) { super(message); Object.assign(this,{status,code,param}); }
}
function invalid(param,message) { throw new GatewayError(400,'invalid_request',message,param); }

function parseRequest(body,headers) {
  if (!record(body)) invalid(null,'Expected a JSON object');
  for (const field of Object.keys(body)) if (!allowedFields.has(field)) invalid(field,'Unsupported chat field: '+field);
  if (typeof body.model !== 'string' || body.model.toLowerCase() !== MODEL.toLowerCase()) {
    throw new GatewayError(404,'model_not_found','Choose '+MODEL,'model');
  }
  if (body.n !== undefined && body.n !== 1) invalid('n','Only one completion per request is supported');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream','Expected a boolean');
  const session = body.prompt_cache_key !== undefined ? body.prompt_cache_key :
    headers['x-gpuchain-session'] ?? headers['x-opencode-session'] ?? headers['x-opencode-session-id'];
  if (session !== undefined && (typeof session !== 'string' || !session.length || Buffer.byteLength(session)>512)) {
    invalid('prompt_cache_key','Expected a session or cache key of 1 to 512 UTF-8 bytes');
  }
  if (body.stream_options !== undefined && (!record(body.stream_options) ||
      Object.keys(body.stream_options).some(k=>k!=='include_usage') ||
      (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage!=='boolean'))) {
    invalid('stream_options','Expected an optional boolean include_usage');
  }
  if (body.store !== undefined && body.store !== false) invalid('store','This gateway does not store chat history');
  if (body.response_format !== undefined && (!record(body.response_format) ||
      Object.keys(body.response_format).length !== 1 || body.response_format.type !== 'text')) {
    invalid('response_format','Only text response format is supported');
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined &&
      body.max_tokens !== body.max_completion_tokens) invalid('max_tokens','Conflicting output token limits');
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens ?? 4096;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens >= CONTEXT) {
    invalid('max_tokens','Output token limit must be a positive integer within the model context');
  }
  if (body.reasoning !== undefined && (!record(body.reasoning) || Object.keys(body.reasoning).some(k=>k!=='effort'))) {
    invalid('reasoning','Use reasoning.effort');
  }
  if (body.reasoning_effort !== undefined && body.reasoning?.effort !== undefined &&
      body.reasoning_effort !== body.reasoning.effort) invalid('reasoning_effort','Conflicting reasoning levels');
  const rawEffort = body.reasoning_effort ?? body.reasoning?.effort;
  let reasoning = {};
  try {
    if (rawEffort !== undefined) reasoning.reasoningEffort = reasoningEffort(rawEffort);
    if (body.reasoning_budget_tokens !== undefined) reasoning.reasoningBudgetTokens = body.reasoning_budget_tokens;
    validateReasoningOptions({...reasoning,maxOutputTokens});
  } catch (err) { invalid('reasoning_effort',err.message); }
  let messages,chatOptions;
  try { messages=normalizeChatMessages(body.messages); } catch (err) { invalid('messages',err.message); }
  try {
    const options = Object.fromEntries(optionKeys.filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
    if (body.stream === true) options.stream=true;
    chatOptions=normalizeChatOptions(options);
  } catch (err) { invalid(null,err.message); }
  return {session,stream:body.stream===true, includeUsage:body.stream_options?.include_usage===true,
    purchase:{messages,chatOptions,maxOutputTokens,...reasoning}};
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/json') {
    throw new GatewayError(415,'invalid_content_type','Use application/json');
  }
  const tooLarge = () => new GatewayError(413,'request_too_large','Request exceeds 8 MiB');
  if (Number(req.headers['content-length']) > MAX_BODY) throw tooLarge();
  const chunks=[];
  let bytes=0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    bytes+=chunk.length;
    if (bytes>MAX_BODY) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); }
  catch { invalid(null,'Body must be valid UTF-8 JSON'); }
}

function asGatewayError(error) {
  if (error instanceof GatewayError) return error;
  if (error?.code==='self_provider_only') return new GatewayError(503,'self_provider_only',
    'This wallet is the only registered provider. Use a different funded requester wallet.');
  if (error?.code==='no_encrypted_provider') return new GatewayError(503,'no_encrypted_provider',
    'No compatible encrypted GPUChain provider is ready for this wallet.');
  const message = String(error?.message ?? '');
  if (/insufficient balance/i.test(message)) return new GatewayError(402,'insufficient_funds','Insufficient GPUChain balance for this request budget');
  if (/no (available|fresh|eligible|ready).*provider/i.test(message)) return new GatewayError(503,'no_provider','No compatible GPUChain provider is available for this wallet');
  if (/invalid max-output|out of range: max-output|exceeds epoch limit/i.test(message)) return new GatewayError(400,'invalid_request','Output limit exceeds the current network limit','max_tokens');
  if (/nonce/i.test(message)) return new GatewayError(409,'wallet_state_changed','Wallet state changed. Check the ledger before submitting another request');
  if (error?.status===429) return new GatewayError(429,'provider_busy','GPUChain provider is busy');
  if (error?.status===503 || /no reachable/i.test(message)) return new GatewayError(503,'network_unavailable','GPUChain network is unavailable');
  return new GatewayError(502,'inference_error','GPUChain inference or settlement could not be verified. Check wallet status before retrying');
}

function usageFor(result) {
  const {inputTokens,outputTokens,cachedTokens}=result.usage;
  return {prompt_tokens:inputTokens,completion_tokens:outputTokens,total_tokens:inputTokens+outputTokens,
    prompt_tokens_details:{cached_tokens:cachedTokens}};
}

// Backpressure is propagated into the provider's stream. A disconnected buyer
// has no socket to write to; settlement of an already dispatched job can continue.
function liveStream(res,meta,signal,sseHeaders) {
  let started=false;
  async function send(choices,usage) {
    if (signal.aborted || res.destroyed) return;
    sseHeaders();
    const frame={...meta,object:'chat.completion.chunk',choices,...(usage ? {usage} : {})};
    if (!res.write('data: '+JSON.stringify(frame)+'\n\n')) {
      try { await once(res,'drain',{signal}); }
      catch (err) { if (!signal.aborted && !res.destroyed) throw err; }
    }
  }
  async function start() {
    if (started) return;
    started=true;
    await send([{index:0,delta:{role:'assistant',content:''},finish_reason:null}]);
  }
  return {
    async delta(value) {
      await start();
      const delta={};
      for (const key of ['content','reasoning_content','tool_calls']) if (value[key] != null) delta[key]=value[key];
      if (Object.keys(delta).length) await send([{index:0,delta,finish_reason:null}]);
    },
    async finish(result,includeUsage) {
      await start();
      await send([{index:0,delta:{},finish_reason:result.finishReason}]);
      if (includeUsage) await send([],usageFor(result));
      if (!signal.aborted && !res.destroyed) res.end('data: [DONE]\n\n');
    }
  };
}

export async function startOpenAiGateway({wallet,token,port=8792,purchase=purchaseChat,heartbeatMs=10_000,affinityDir}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw Error('Invalid local inference API token');
  if (!Number.isInteger(port) || port<0 || port>65535) throw Error('Invalid local inference port');
  const tokenHash=digest(token);
  const created=Math.floor(Date.now()/1000);
  const controllers=new Set();
  let tail=Promise.resolve(),closing=false;
  let affinity;
  function useMemoryAffinity() {
    affinity?.close();
    affinity=openCacheAffinity();
    console.warn('GPUChain could not use the local inference affinity file. Routing preferences will be kept in memory.');
  }
  try { affinity=openCacheAffinity(affinityDir); }
  catch { useMemoryAffinity(); }

  const server=createServer(async (req,res)=>{
    const controller=new AbortController();
    const {signal}=controller;
    let heartbeat;
    res.on('close',()=>{if (!res.writableEnded) controller.abort();});
    function json(status,body,extra={}) {
      res.writeHead(status,{...commonHeaders,'content-type':'application/json; charset=utf-8',...extra});
      res.end(JSON.stringify(body));
    }
    function sseHeaders() {
      if (!res.headersSent) res.writeHead(200,{...commonHeaders,'content-type':'text/event-stream; charset=utf-8',
        'x-accel-buffering':'no'});
    }
    try {
      const host=req.headers.host,expectedPort=req.socket.localPort;
      if (![ '127.0.0.1:'+expectedPort,'localhost:'+expectedPort ].includes(host) ||
          (req.headers.origin!==undefined && req.headers.origin!=='http://'+host) ||
          (req.headers['sec-fetch-site']==='cross-site') ||
          Object.keys(req.headers).some(k=>k==='forwarded'||k.startsWith('x-forwarded-'))) {
        throw new GatewayError(403,'local_only','Use the local loopback endpoint');
      }
      const key=/^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!key || !timingSafeEqual(tokenHash,digest(key))) throw new GatewayError(401,'invalid_api_key','A local GPUChain inference API key is required');
      if (req.url==='/v1/models' && req.method==='GET') {
        return json(200,{object:'list',data:[{id:MODEL,object:'model',created,owned_by:'gpuchain'}]});
      }
      if (!['/v1/models','/v1/chat/completions'].includes(req.url)) throw new GatewayError(404,'not_found','Unknown API endpoint');
      if (req.url!=='/v1/chat/completions' || req.method!=='POST') throw new GatewayError(405,'method_not_allowed','Unsupported HTTP method');
      if (closing || controllers.size>=MAX_PENDING) throw new GatewayError(429,'gateway_busy','Local inference queue is full');
      controllers.add(controller);
      const input=parseRequest(await readBody(req),req.headers);
      const {candidates,anchors}=affinityKeys({token,payer:wallet.address,model:MODEL,session:input.session,
        messages:input.purchase.messages,chatOptions:input.purchase.chatOptions,reasoningEffort:input.purchase.reasoningEffort});
      const meta={id:'chatcmpl-'+randomUUID(),created:Math.floor(Date.now()/1000),model:MODEL};
      const stream=input.stream ? liveStream(res,meta,signal,sseHeaders) : null;
      if (input.stream) {
        heartbeat=setInterval(()=>{
          if (!signal.aborted && !res.destroyed && !res.writableNeedDrain) {
            sseHeaders();
            res.write(': waiting for GPUChain\n\n');
          }
        },heartbeatMs);
        heartbeat.unref();
      }
      // A wallet has one spend nonce at a time. Release its turn only after settlement.
      const operation=tail.then(async ()=>{
        signal.throwIfAborted();
        let preferredProvider;
        try { preferredProvider=affinity.preferred(candidates); }
        catch { useMemoryAffinity(); }
        const result=await purchase({wallet,...input.purchase,transport:'relay',preferredProvider,signal,...(stream ? {onDelta:stream.delta} : {})});
        try { affinity.remember(anchors,result.provider); }
        catch {
          useMemoryAffinity();
          affinity.remember(anchors,result.provider);
        }
        return result;
      });
      tail=operation.catch(()=>{});
      const result=await operation;
      if (signal.aborted || res.destroyed) return;
      clearInterval(heartbeat);
      if (stream) return await stream.finish(result,input.includeUsage);
      json(200,{...meta,object:'chat.completion',choices:[{index:0,message:result.message,
        finish_reason:result.finishReason}],usage:usageFor(result)});
    } catch (err) {
      if (signal.aborted || res.destroyed) return;
      const e=asGatewayError(err);
      const type=e.status===401 ? 'authentication_error' : e.status===429 ? 'rate_limit_error' :
        e.status<500 ? 'invalid_request_error' : 'server_error';
      const body={error:{message:e.message,type,code:e.code,param:e.param}};
      if (res.headersSent) res.end('data: '+JSON.stringify(body)+'\n\n');
      else json(e.status,body,{...(e.status===401 ? {'www-authenticate':'Bearer'} : {}),connection:'close'});
    } finally {
      clearInterval(heartbeat);
      controllers.delete(controller);
    }
  });
  server.maxConnections=32;
  server.headersTimeout=10_000;
  server.requestTimeout=30_000;
  server.listen(port,'127.0.0.1');
  try { await once(server,'listening'); }
  catch (error) { affinity.close(); throw error; }
  let stopped;
  return {url:'http://127.0.0.1:'+server.address().port+'/v1',close() {
    if (stopped) return stopped;
    closing=true;
    for (const controller of controllers) controller.abort();
    stopped=new Promise(resolve=>server.close(resolve)).then(()=>tail).finally(()=>affinity.close());
    server.closeAllConnections();
    return stopped;
  }};
}
