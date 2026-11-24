import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { generateWallet, hash, sign, verify } from '../src/crypto.mjs';
import { normalizeChatOptions, chatResponseHash, validateChatReply } from '../src/chat-protocol.mjs';
import { CONTEXT, charge } from '../src/ledger.mjs';
import { createProviderServer } from '../src/provider.mjs';
import { readSse, readStrataCompletion } from '../src/strata-stream.mjs';
import { streamAdapter, trackAssistantDeltas } from '../src/inference-stream.mjs';

const modelId='qwen3.8-flash-next-q2_0';
const event = data => 'data: '+JSON.stringify(data)+'\n\n';
const choice = (delta,finish_reason=null) => event({model:modelId,choices:[{index:0,delta,finish_reason}]});
const usage = {prompt_tokens:34,prompt_tokens_details:{cached_tokens:31},completion_tokens:4,total_tokens:38};
const profile={modelId,capacity:CONTEXT,outputLimit:512,kvCache:{k:'Q8',v:'Q8'},generation:1};
const options=normalizeChatOptions({stream:true,tools:[{type:'function',function:{name:'read_label',
  parameters:{type:'object',properties:{card:{type:'string'}}}}}]});
const messages=[{role:'system',content:'Answer briefly'},{role:'user',content:'Read the card'},
  {role:'assistant',content:null,tool_calls:[{id:'prev',type:'function',function:{name:'read_label',arguments:'{"card":"B"}'}}]},
  {role:'tool',tool_call_id:'prev',content:'Blue'},{role:'user',content:'Read card A'}];

function nativeSse(frames) {
  return Object.assign(Readable.from(frames),{headers:{'content-type':'text/event-stream'}});
}

test('SSE parser preserves fragmented UTF-8, CRLF, comments and multiline data', async()=>{
  const bytes=Buffer.from(': ping\r\n\r\nevent: delta\r\ndata: 한\r\ndata: 字\r\n\r\n');
  const records=[];
  for await (const frame of readSse(Readable.from(Array.from(bytes,b=>Buffer.from([b]))))) records.push(frame);
  assert.deepEqual(records,[{event:'delta',data:'한\n字'}]);
});

test('native streams require a clean completion with the expected model and usage',async()=>{
  const final=choice({},'stop'), metered=event({model:modelId,choices:[],usage}), end='data: [DONE]\n\n';
  for (const frames of [[final,metered],[final,end],[metered,final,end],[final,final,metered,end],
    [final,metered,end,choice({content:'extra'})],[final,metered,'data: [DONE]'],
    [event({model:'wrong',choices:[],usage}),end]]) {
    await assert.rejects(readStrataCompletion(nativeSse(frames),modelId,()=>{}));
  }
});

test('equivalent tool catalogs serialize to one native prefix and a required call must be present',()=>{
  const blue={type:'function',function:{name:'blue',parameters:{properties:{b:{type:'number'},a:{type:'string'}},type:'object'}}};
  const red={type:'function',function:{name:'red'}};
  const reordered={type:'function',function:{name:'blue',parameters:{type:'object',properties:{a:{type:'string'},b:{type:'number'}}}}};
  assert.equal(JSON.stringify(normalizeChatOptions({tools:[red,blue]})),JSON.stringify(normalizeChatOptions({tools:[reordered,red]})));
  assert.throws(()=>validateChatReply({role:'assistant',content:'done'},'stop',{tool_choice:'required'}),/required/);
});

test('live signed adapter sends deltas before release, meters cache reads and replays the exact tool reply',{timeout:5000},async t=>{
  const provider=generateWallet(),payer=generateWallet(),chainId=hash('adapter stream fixture');
  const request={type:'inference-request',payer:payer.address,provider:provider.address,chainId,nonce:1,
    expiresAt:Date.now()+60000,maxInputTokens:128,maxOutputTokens:32,messagesHash:hash(messages),chatOptionsHash:hash(options)};
  const finish=Promise.withResolvers(), received=Promise.withResolvers();
  t.after(()=>finish.resolve());
  let nativeCalls=0;
  let truncated=false;
  const connector={
    profile:async()=>profile,
    async backend(path,body) {
      assert.equal(path,'/messages/count_tokens');
      assert.equal(body.messages[3].content[0].type,'tool_result');
      assert.equal(body.tools[0].input_schema.properties.card.type,'string');
      return {input_tokens:34};
    },
    async stream(body,timeout,signal,onDelta) {
      nativeCalls++;
      assert.equal(body.stream,true);
      assert.deepEqual(body.stream_options,{include_usage:true});
      assert.deepEqual(body.messages,messages);
      assert.deepEqual(body.tools,options.tools);
      assert.equal(signal.aborted,false);
      async function* frames() {
        yield choice({role:'assistant',content:''});
        yield choice({tool_calls:[{index:0,id:'next',type:'function',function:{name:'read_label',arguments:'{"card":'}}]});
        await finish.promise;
        if (truncated) return;
        yield choice({tool_calls:[{index:0,function:{arguments:'"A"}'}}]});
        yield choice({},'tool_calls');
        yield event({model:modelId,choices:[],usage});
        yield 'data: [DONE]\n\n';
      }
      return readStrataCompletion(nativeSse(frames()),modelId,onDelta);
    }
  };
  const state={chainId,providers:[provider.address],networkStage:'mainnet',nonces:{},maxOutputTokens:512,
    balances:{[payer.address]:1_000_000_000}};
  const adapter=createProviderServer({wallet:provider,chainId,getBackend:()=>connector,readState:async()=>state});
  adapter.listen(0,'127.0.0.1'); await once(adapter,'listening');
  t.after(()=>{adapter.closeAllConnections();adapter.close();});
  const url='http://127.0.0.1:'+adapter.address().port+'/v1/infer';
  const body=()=>({request,signature:sign(payer.privateKey,request),messages,chatOptions:options});
  await assert.rejects(streamAdapter(url,{...body(),chatOptions:{...options,temperature:1}},()=>{}),/HTTP 400/);
  assert.equal(nativeCalls,0);
  const tracker=trackAssistantDeltas(d=>{ if (d.tool_calls?.length) received.resolve(); });
  const pending=streamAdapter(url,body(),tracker.push);
  try { await Promise.race([received.promise,pending.then(()=>assert.fail('Receipt arrived before live tool delta'))]); }
  finally { finish.resolve(); }
  const result=await pending;
  tracker.verify(result.message);
  assert.equal(result.message.tool_calls[0].function.arguments,'{"card":"A"}');
  assert.equal(result.finishReason,'tool_calls');
  assert.equal(result.payload.responseHash,chatResponseHash(result.message,'tool_calls'));
  assert.equal(result.payload.cachedTokens,31);
  assert.equal(charge(result.payload),3*150+31*16+4*470);
  assert.ok(verify(provider.address,result.payload,result.providerSignature));
  const replay=trackAssistantDeltas(()=>{});
  assert.deepEqual(await streamAdapter(url,body(),replay.push),result);
  replay.verify(result.message);
  assert.equal(nativeCalls,1);
  state.nonces[payer.address]=1;
  request.nonce=2;
  truncated=true;
  await assert.rejects(streamAdapter(url,body(),()=>{}),/stream failed/);
});
