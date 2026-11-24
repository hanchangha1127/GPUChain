import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generateWallet } from '../src/crypto.mjs';
import { MODEL } from '../src/ledger.mjs';
import { startOpenAiGateway } from '../src/openai-gateway.mjs';

const token='test-inference-key-for-loopback-only-123456';
const auth={authorization:'Bearer '+token,'content-type':'application/json'};
const baseChat={model:MODEL,messages:[{role:'user',content:'hello'}]};
const tool={type:'function',function:{name:'weather',description:'Look up the weather',
  parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}};
const call={id:'call_1',type:'function',function:{name:'weather',arguments:'{"city":"Seoul"}'}};
const usage={inputTokens:17,outputTokens:5,cachedTokens:3};
const answer={message:{role:'assistant',content:'fine'},finishReason:'stop',usage};
async function fixture(t,purchase,heartbeatMs=5000) {
  const gateway=await startOpenAiGateway({wallet:generateWallet(),token,port:0,purchase,heartbeatMs});
  t.after(()=>gateway.close());
  return {url:gateway.url,chat:(body=baseChat,options={})=>fetch(gateway.url+'/chat/completions',{
    method:'POST',headers:auth,body:JSON.stringify(body),...options})};
}
function headerTest(url,headers,method='GET') {
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{headers,method},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
}

test('local consumer API authenticates model discovery and refuses cross-origin or forwarded access',async t=>{
  let calls=0;
  const {url,chat}=await fixture(t,async()=>{calls++;return answer;});
  assert.equal((await fetch(url+'/models')).status,401);
  assert.equal((await headerTest(url+'/models',{...auth,host:'external.example'})),403);
  assert.equal((await headerTest(url+'/models',{...auth,origin:'http://untrusted.example'})),403);
  assert.equal((await headerTest(url+'/models',{...auth,'x-forwarded-host':'https://proxy.example'})),403);
  assert.equal((await headerTest(url+'/models',{...auth,'sec-fetch-site':'cross-site'})),403);
  const models=await (await fetch(url+'/models',{headers:auth})).json();
  assert.deepEqual(models.data.map(m=>m.id),[MODEL]);
  assert.equal((await fetch(url+'/responses',{headers:auth})).status,404);
  assert.equal((await fetch(url+'/chat/completions',{headers:auth})).status,405);
  assert.equal((await chat({...baseChat,model:'other'})).status,404);
  assert.equal((await chat({...baseChat,n:2})).status,400);
  assert.equal((await chat({...baseChat,prompt_cache_key:''})).status,400);
  assert.equal((await chat({...baseChat,prompt_cache_key:42})).status,400);
  assert.equal((await chat({...baseChat,reasoning_effort:'none',reasoning_budget_tokens:3})).status,400);
  assert.equal((await chat({...baseChat,max_tokens:100,max_completion_tokens:99})).status,400);
  assert.equal((await chat({...baseChat,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:'}}]}]})).status,400);
  assert.equal((await chat(baseChat,{headers:{...auth,'content-type':'text/plain'}})).status,415);
  assert.equal(calls,0);
});

test('nonstream chat forwards tool history, usage and reasoning; payment errors use OpenAI JSON',async t=>{
  let last,fail=false;
  const {chat}=await fixture(t,async input=>{
    last=input;
    if (fail) throw Error('Insufficient balance for authorized token limits');
    return {...answer,message:{role:'assistant',content:'맑음',reasoning_content:'확인됨'}};
  });
  const messages=[{role:'system',content:'Use tools'},...baseChat.messages,
    {role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'sunny'}];
  const res=await chat({...baseChat,model:MODEL.toLowerCase(),messages,tools:[tool],tool_choice:'auto',
    temperature:0.1,reasoning_effort:'medium',max_completion_tokens:64});
  assert.equal(res.status,200);
  const out=await res.json();
  assert.equal(out.object,'chat.completion');
  assert.equal(out.model,MODEL);
  assert.equal(out.choices[0].message.reasoning_content,'확인됨');
  assert.equal(out.choices[0].finish_reason,'stop');
  assert.equal(out.usage.prompt_tokens_details.cached_tokens,3);
  assert.equal(out.usage.total_tokens,22);
  assert.equal(last.messages.at(-1).tool_call_id,call.id);
  assert.equal(last.chatOptions.tools[0].function.name,'weather');
  assert.equal(last.maxOutputTokens,64);
  assert.equal(last.reasoningEffort,'medium');
  fail=true;
  const bad=await chat();
  assert.equal(bad.status,402);
  assert.equal((await bad.json()).error.code,'insufficient_funds');
});

test('SSE exposes a genuine first delta before settlement and finishes a tool call with final-only usage', {timeout:8000}, async t=>{
  const finish=Promise.withResolvers();
  const {chat}=await fixture(t,async input=>{
    assert.equal(input.chatOptions.stream,true);
    await input.onDelta({role:'assistant',reasoning_content:'thinking'});
    await finish.promise;
    await input.onDelta({tool_calls:[{index:0,id:call.id,type:'function',function:{name:'weather',arguments:''}}]});
    await input.onDelta({tool_calls:[{index:0,function:{arguments:call.function.arguments}}]});
    return {message:{role:'assistant',content:null,tool_calls:[call]},finishReason:'tool_calls',usage};
  });
  let before='';
  const response=await chat({...baseChat,tools:[tool],stream:true,stream_options:{include_usage:true}});
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  try {
    assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
    while (!before.includes('thinking')) {
      const part=await reader.read(); assert.equal(part.done,false);before+=decoder.decode(part.value,{stream:true});
    }
    assert.doesNotMatch(before,/\[DONE\]|"total_tokens"|"finish_reason":"tool_calls"/);
  } finally {finish.resolve();}
  let text=before;
  for (;;) {const part=await reader.read(); if(part.done)break; text+=decoder.decode(part.value,{stream:true});}
  const data=text.split(/\r?\n/).filter(line=>line.startsWith('data: ')).map(line=>line.slice(6));
  assert.equal(data.pop(),'[DONE]');
  const frames=data.map(v=>JSON.parse(v));
  assert.ok(frames.every(f=>f.id===frames[0].id && f.object==='chat.completion.chunk'));
  assert.deepEqual(frames.flatMap(f=>f.choices[0]?.delta.tool_calls||[]).map(d=>d.function.arguments),['',call.function.arguments]);
  assert.equal(frames.at(-2).choices[0].finish_reason,'tool_calls');
  assert.deepEqual(frames.at(-1).choices,[]);
  assert.equal(frames.at(-1).usage.total_tokens,22);
  assert.equal(frames.at(-1).usage.prompt_tokens_details.cached_tokens,3);
});

test('an interrupted receipt yields an SSE error with no successful finish or DONE',async t=>{
  const {chat}=await fixture(t,async input=>{
    await input.onDelta({content:'unsettled'});
    throw Error('Invalid provider receipt');
  });
  const text=await (await chat({...baseChat,stream:true})).text();
  assert.match(text,/unsettled/);
  assert.match(text,/"code":"inference_error"/);
  assert.doesNotMatch(text,/\[DONE\]|"finish_reason":"stop"|"usage":/);
});

test('gateway serializes concurrent purchases and does not dispatch a disconnected queued request',async t=>{
  const first=Promise.withResolvers(), release=Promise.withResolvers();
  const order=[];
  const {chat}=await fixture(t,async ({messages})=>{
    const prompt=messages[0].content;
    order.push(prompt);
    if (prompt==='hello') { first.resolve();await release.promise; }
    return answer;
  });
  const p1=chat();
  await first.promise;
  const controller=new AbortController();
  const p2=chat({...baseChat,messages:[{role:'user',content:'cancel me'}]},{signal:controller.signal});
  await delay(40);
  controller.abort();
  await assert.rejects(p2);
  const p3=chat({...baseChat,messages:[{role:'user',content:'after'}]});
  try { await delay(40);assert.deepEqual(order,['hello']); }
  finally { release.resolve(); }
  assert.equal((await p1).status,200);
  assert.equal((await p3).status,200);
  assert.deepEqual(order,['hello','after']);
});

test('gateway prefers the settled provider across tool turns, learns failover and reports only metered cache hits',async t=>{
  const a='a'.repeat(64), b='b'.repeat(64);
  const preferred=[];
  let provider=a, paid=true;
  const {chat}=await fixture(t,async input=>{
    preferred.push(input.preferredProvider);
    if (!paid) throw Error('Invalid provider receipt');
    return {...answer,provider,usage:{...usage,cachedTokens:0}};
  });
  assert.equal((await chat()).status,200);
  const followup={...baseChat,tools:[tool],temperature:0.8,messages:[
    {role:'system',content:'Updated turn context'},...baseChat.messages,
    {role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'sunny'},
    {role:'user',content:'What about tomorrow?'}]};
  provider=b;
  paid=false;
  assert.equal((await chat(followup)).status,502);
  paid=true;
  const miss=await (await chat(followup)).json();
  assert.equal(miss.usage.prompt_tokens_details.cached_tokens,0);
  assert.equal((await chat(followup)).status,200);
  assert.equal((await chat({...baseChat,messages:[{role:'user',content:'Different conversation'}]})).status,200);
  assert.deepEqual(preferred,[undefined,a,a,b,undefined]);
});

test('explicit cache key or stable session header preserves routing through a rewritten first turn',async t=>{
  const a='a'.repeat(64);
  const preferred=[];
  const {chat}=await fixture(t,async input=>{preferred.push(input.preferredProvider);return {...answer,provider:a};});
  const reset={...baseChat,messages:[{role:'user',content:'Compacted history'}]};
  const header={'x-opencode-session':'session-a'};
  const request=(body,headers)=>chat(body,{headers:{...auth,...headers}});
  assert.equal((await request(baseChat,header)).status,200);
  assert.equal((await request(reset,header)).status,200);
  assert.equal((await request({...reset,prompt_cache_key:'session-b'},header)).status,200);
  assert.equal((await request({...baseChat,prompt_cache_key:'session-b'},{})).status,200);
  assert.deepEqual(preferred,[undefined,a,undefined,a]);
});
