import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generateWallet, hash, sign, verify } from '../src/crypto.mjs';
import { startAutoProvider } from '../src/auto-provider.mjs';

async function listen(server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return 'http://127.0.0.1:'+server.address().port;
}

async function backend(t,{token,id='qwen3.8-flash-next-q2_0',alias,generate}={}) {
  const f = {loaded:true,precision:'int8',completions:0,paths:[]};
  const server=createServer(async(req,res)=>{
    f.paths.push(req.url);
    const send=(status,body)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));
    if (token && req.headers.authorization!=='Bearer '+token) return send(401,{});
    if (req.url==='/health') return send(200,{status:'ok',service:'strata',loaded:f.loaded,model:id});
    if (req.url==='/v1/models') return send(200,{data:[{id,context_length:262144,status:{value:'loaded'}},
      ...(alias ? [{id:alias,alias_of:id}] : [])]});
    if (req.url==='/metrics') return send(200,{engine:{model:id,max_context:262144,kv:f.precision,gen:1},live:{}});
    if (req.url==='/v1/messages/count_tokens') return send(200,{input_tokens:12});
    if (req.url==='/v1/chat/completions') {
      f.completions++;
      if (generate) await generate();
      return send(200,{model:id,choices:[{finish_reason:'stop',message:{role:'assistant',content:'ok'}}],
        usage:{prompt_tokens:12,prompt_tokens_details:{cached_tokens:2},completion_tokens:1,total_tokens:13}});
    }
    return send(404,{});
  });
  f.url=await listen(server);
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();}));
  return f;
}

function identity() {
  const wallet=generateWallet(),payer=generateWallet(),chainId=hash('automatic-provider-fixture');
  const readState=async()=>({chainId,networkStage:'mainnet',providers:[wallet.address],nonces:{},
    maxOutputTokens:1024,balances:{[payer.address]:1000000}});
  return {wallet,payer,chainId,readState};
}

async function waitUntil(predicate) {
  for (let i=0;i<150;i++) {
    if (predicate()) return;
    await delay(20);
  }
  throw Error('Expected attachment was not observed');
}

test('automatically follows a late Strata launch, checks backend preference, KV eligibility and fallback',async t=>{
  const a=await backend(t,{token:'fixture'}),b=await backend(t,{token:'fixture',id:'iq3_xxs',alias:'qwen3.8-flash-next-iq3_xxs'});
  a.loaded=b.loaded=false;
  const p=await startAutoProvider({...identity(),backendUrls:[a.url,b.url],apiKey:'fixture',listenPort:0,intervalMs:50});
  t.after(()=>p.close());
  assert.equal(p.url,null);
  a.loaded=b.loaded=true;
  await waitUntil(()=>p.backendUrl===a.url);
  const address=p.url;
  let info=await (await fetch(address+'/v1/info')).json();
  assert.equal(info.engine,'ryzenstrata');
  assert.deepEqual(info.kvCache,{k:'Q8',v:'Q8'});
  a.precision='k8v4';
  await waitUntil(()=>p.backendUrl===b.url);
  assert.equal(p.url,address);
  info=await (await fetch(address+'/v1/info')).json();
  assert.equal(info.engine,'strata');
  assert.equal(info.backendModel,'iq3_xxs');
  b.loaded=false;
  await waitUntil(()=>p.backendUrl===null);
  assert.equal((await fetch(address+'/v1/info')).status,503);
  a.precision='fp16';
  await waitUntil(()=>p.backendUrl===a.url);
  assert.deepEqual((await (await fetch(address+'/v1/info')).json()).kvCache,{k:'F16',v:'F16'});
  assert.equal(a.completions+b.completions,0);
});

test('automatic binding does not displace a manually running adapter and can later claim the free port',async t=>{
  const a=await backend(t);
  const manual=createServer((_req,res)=>res.end('existing listener'));
  const manualUrl=await listen(manual);
  const p=await startAutoProvider({...identity(),backendUrls:[a.url],listenPort:manual.address().port,intervalMs:60_000});
  t.after(()=>p.close());
  try {
    assert.equal(p.url,null);
    assert.equal(await (await fetch(manualUrl)).text(),'existing listener');
  } finally {
    await new Promise(resolve=>{manual.close(resolve);manual.closeIdleConnections();});
  }
  await Promise.all([p.refresh(),p.refresh(),p.refresh()]);
  assert.equal(p.url,manualUrl);
  assert.equal((await fetch(manualUrl+'/v1/info')).status,200);
  await p.close();
  await assert.rejects(fetch(manualUrl+'/v1/info'));
});

test('a backend switch does not redirect an in-flight prompt or discard replay protection', {timeout:6000}, async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const a=await backend(t,{generate:async()=>{entered.resolve();await release.promise;}});
  const b=await backend(t);
  const keys=identity();
  const p=await startAutoProvider({...keys,backendUrls:[a.url,b.url],listenPort:0,intervalMs:60_000});
  t.after(()=>p.close());
  const {wallet,payer,chainId}=keys;
  const messages=[{role:'user',content:'Hello!'}];
  const request={type:'inference-request',chainId,payer:payer.address,provider:wallet.address,nonce:1,
    expiresAt:Date.now()+60_000,messagesHash:hash(messages),maxInputTokens:50,maxOutputTokens:10};
  const post=()=>fetch(p.url+'/v1/infer',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({request,signature:sign(payer.privateKey,request),messages})});
  const first=post();
  try {
    await entered.promise;
    a.loaded=false;
    await p.refresh();
    assert.equal(p.backendUrl,b.url);
    assert.equal((await (await fetch(p.url+'/v1/info')).json()).inferenceActive,true);
  } finally {release.resolve();}
  const result=await (await first).json();
  assert.ok(verify(wallet.address,result.payload,result.providerSignature));
  assert.deepEqual(await (await post()).json(),result);
  assert.equal(a.completions,1);
  assert.equal(b.completions,0);
});

test('closing the managed adapter drains a running inference before returning', {timeout:6000}, async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await backend(t,{generate:async()=>{entered.resolve();await release.promise;}});
  const keys=identity();
  const p=await startAutoProvider({...keys,backendUrls:[f.url],listenPort:0,intervalMs:60_000});
  t.after(()=>p.close());
  const messages=[{role:'user',content:'Hello!'}];
  const request={type:'inference-request',chainId:keys.chainId,payer:keys.payer.address,provider:keys.wallet.address,
    nonce:1,expiresAt:Date.now()+60_000,messagesHash:hash(messages),maxInputTokens:50,maxOutputTokens:10};
  const result=fetch(p.url+'/v1/infer',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({request,signature:sign(keys.payer.privateKey,request),messages})});
  await entered.promise;
  let closed=false;
  const closing=p.close().then(()=>{closed=true;});
  try {
    await delay(15);
    assert.equal(closed,false);
  } finally {release.resolve();}
  const reply=await result;
  assert.equal(reply.status,200);
  await reply.json();
  await closing;
  assert.equal(p.url,null);
});

test('automatic backend lookup stays on loopback',async()=>{
  await assert.rejects(startAutoProvider({...identity(),backendUrls:['https://example.org']}),/loopback/);
  await assert.rejects(startAutoProvider({...identity(),backendUrls:['http://user@localhost:8080']}),/loopback/);
});
