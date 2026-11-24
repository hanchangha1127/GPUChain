import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, sign, generateWallet } from '../src/crypto.mjs';
import { CONTEXT, MODEL } from '../src/ledger.mjs';
import { relayRoute } from '../src/relay-service.mjs';
import { listRelayOffers, getRelayOffer, relayInfer, startProviderRelay } from '../src/relay-client.mjs';
import { makeRelayKeyPair, openRelayBox, sealRelayBox } from '../src/relay-crypto.mjs';
import { PROBE_DOMAIN } from '../src/routing.mjs';

test('relay ECDH binds the two identities, job and direction; corruption and the wrong key cannot decrypt',()=>{
  const a=makeRelayKeyPair(), b=makeRelayKeyPair(), spy=makeRelayKeyPair();
  const f={chainId:hash('chain'),payer:hash('alice'),provider:hash('bob'),jobId:hash('job'),
    requestHash:hash('blind proof'),providerKey:b.publicKey,clientKey:a.publicKey};
  const original={messages:[{role:'user',content:'비공개 요청'}]};
  const box=sealRelayBox(a.privateKey,b.publicKey,f,'request',original);
  assert.deepEqual(openRelayBox(b.privateKey,a.publicKey,f,'request',box),original);
  for (const attempt of [
    ()=>openRelayBox(spy.privateKey,a.publicKey,f,'request',box),
    ()=>openRelayBox(b.privateKey,a.publicKey,f,'response',box),
    ()=>openRelayBox(b.privateKey,a.publicKey,{...f,jobId:hash('different')},'request',box),
    ()=>openRelayBox(b.privateKey,a.publicKey,f,'request',(box[0]==='A'?'B':'A')+box.slice(1)),
    ()=>sealRelayBox(a.privateKey,'0'.repeat(64),f,'request',original),
  ]) assert.throws(attempt);
});

function sqliteAdapter(sqlite) {
  const adapter = {prepare(sql) {
    const stmt=sqlite.prepare(sql);
    let args=[];
    return {bind(...values){args=values;return this;},run(){return {meta:{changes:stmt.run(...args).changes}};},
      all(){return {results:stmt.all(...args)};},first(){return stmt.get(...args) ?? null;}};
  },async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results=statements.map(stmt=>stmt.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (err) {sqlite.exec('ROLLBACK');throw err;}
  }};
  return adapter;
}

async function httpServer(t,handler) {
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[];
      for await (const chunk of req) chunks.push(chunk);
      const reply=await handler(req,Buffer.concat(chunks).toString());
      res.writeHead(reply.status,{'content-type':'application/json'});
      res.end(await reply.text());
    } catch (err) {res.writeHead(500);res.end(JSON.stringify({error:err.message}));}
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return 'http://127.0.0.1:'+server.address().port;
}

test('buyer and provider use real signed relay mailbox, chunk large prompts, and keep plaintext private', {timeout:12_000}, async t=>{
  const db=new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../hosting/sites/drizzle/0004_relay_mailbox.sql',import.meta.url),'utf8'));
  const adapter=sqliteAdapter(db);
  const provider=generateWallet(),payer=generateWallet();
  const chainId=hash('relay network');
  const state={providers:[provider.address],chainId,nonces:{},balances:{[payer.address]:1_000_000_000},maxOutputTokens:1024};
  const profile={provider:provider.address,model:MODEL,contextWindow:CONTEXT,kvCache:{k:'Q8',v:'Q8'},
    maxOutputTokens:1024,reasoningOptions:1};
  const messages=[{role:'user',content:'RELAY_PRIVATE_PROMPT_'+'😀'.repeat(220000)}];
  const message={role:'assistant',content:'RELAY_PRIVATE_ANSWER',reasoning_content:'RELAY_PRIVATE_REASONING'};
  const observed=[], local=[];
  let completeAttempts=0, tamperResult=false, omitReasoning=false;
  const relayUrl=await httpServer(t,async(req,body)=>{
    observed.push(body);
    const routed=await relayRoute(new Request('https://relay.invalid'+req.url,
      {method:req.method,headers:req.headers,body:body||undefined}),adapter,state);
    const text=await routed.text();
    observed.push(text);
    if (req.url.endsWith('/complete') && ++completeAttempts===1) {
      return Response.json({error:'Transient failure'},{status:503});
    }
    if (req.url.endsWith('/result') && tamperResult && JSON.parse(text).status==='done') {
      const item=JSON.parse(text);item.reply.box+='A';return Response.json(item);
    }
    if (req.url.endsWith('/providers') && omitReasoning) {
      const item=JSON.parse(text);for(const offer of item.providers) delete offer.payload.reasoningOptions;
      return Response.json(item);
    }
    return new Response(text,{status:routed.status});
  });
  const localUrl=await httpServer(t,(req,body)=>{
    if (req.url.startsWith('/v1/probe?')) {
      const challenge=new URL(req.url,'http://local').searchParams.get('challenge');
      const payload={domain:PROBE_DOMAIN,challenge,chainId,...profile,available:true};
      return Response.json({payload,signature:sign(provider.privateKey,payload)});
    }
    assert.equal(req.url,'/v1/infer');
    const input=JSON.parse(body);local.push(input);
    const payload={type:'inference',chainId,from:payer.address,provider:provider.address,
      nonce:input.request.nonce,model:MODEL,contextWindow:CONTEXT,requestHash:hash(input.request),
      responseHash:hash(message),inputTokens:18,cachedTokens:6,outputTokens:9,kvCache:profile.kvCache};
    return Response.json({message,payload,providerSignature:sign(provider.privateKey,payload)});
  });
  const pump=startProviderRelay({wallet:provider,chainId,relayUrl,adapterUrl:localUrl,pollMs:40,
    presenceMs:3000,readState:async()=>state});
  try {
    let offer;
    for(let i=0;i<100 && !offer;i++){
      [offer]=await listRelayOffers(relayUrl,chainId,{reasoning:true});
      if(!offer)await delay(20);
    }
    assert.equal(offer.provider,provider.address);
    omitReasoning=true;
    assert.deepEqual(await listRelayOffers(relayUrl,chainId,{reasoning:true}),[]);
    omitReasoning=false;
    async function buy(nonce) {
      const request={type:'inference-request',chainId,provider:provider.address,payer:payer.address,
        nonce,expiresAt:Date.now()+120000,messagesHash:hash(messages),maxInputTokens:100,maxOutputTokens:30,
        reasoningEffort:'medium',reasoningBudgetTokens:16};
      return relayInfer({wallet:payer,chainId,provider:provider.address,relayUrl,offer:offer.offer,request,
        signature:sign(payer.privateKey,request),messages,pollMs:30,resultTimeoutMs:7000});
    }
    assert.deepEqual((await buy(1)).message,message);
    for (let i=0;i<100 && completeAttempts<2;i++) await delay(25);
    assert.equal(local.length,1);
    assert.deepEqual(local[0].messages,messages);
    assert.equal(local[0].request.reasoningBudgetTokens,16);
    assert.ok(completeAttempts>=2);
    assert.ok(!observed.some(raw=>/RELAY_PRIVATE_|reasoning_content/.test(raw)));
    state.nonces[payer.address]=1;
    tamperResult=true;
    await assert.rejects(()=>buy(2), /Invalid signed relay completion/);
    assert.equal(local.length,2);
    await assert.rejects(()=>getRelayOffer(relayUrl,chainId,generateWallet().address),/No fresh/);
  } finally {
    await pump.close();
    assert.equal(pump.status().state,'stopped');
    db.close();
  }
});
