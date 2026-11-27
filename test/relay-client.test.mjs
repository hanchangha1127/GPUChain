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
      const reply=await handler(req,Buffer.concat(chunks).toString(),res);
      if (res.writableEnded) return;
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
  db.exec(await readFile(new URL('../hosting/sites/drizzle/0005_relay_stream.sql',import.meta.url),'utf8'));
  db.exec(await readFile(new URL('../hosting/sites/drizzle/0006_relay_failure.sql',import.meta.url),'utf8'));
  const adapter=sqliteAdapter(db);
  const provider=generateWallet(),payer=generateWallet();
  const chainId=hash('relay network');
  const state={providers:[provider.address],chainId,nonces:{},balances:{[payer.address]:1_000_000_000},maxOutputTokens:1024};
  const profile={provider:provider.address,model:MODEL,contextWindow:CONTEXT,kvCache:{k:'Q8',v:'Q8'},
    maxOutputTokens:1024,reasoningOptions:1};
  const messages=[{role:'user',content:'RELAY_PRIVATE_PROMPT_'+'😀'.repeat(220000)}];
  const message={role:'assistant',content:'RELAY_PRIVATE_ANSWER',reasoning_content:'RELAY_PRIVATE_REASONING'};
  const observed=[], local=[];
  let completeAttempts=0, tamperResult=false, omitReasoning=false, rejectInference=false;
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
    if (rejectInference) return Response.json({error:'Backend unavailable'},{status:503});
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
    tamperResult=false;
    state.nonces[payer.address]=2;
    rejectInference=true;
    await assert.rejects(()=>buy(3),/ADAPTER_HTTP_503/);
    rejectInference=false;
    assert.deepEqual((await buy(3)).message,message);
    assert.equal(local.length,4);
    await assert.rejects(()=>getRelayOffer(relayUrl,chainId,generateWallet().address),/No fresh/);
  } finally {
    await pump.close();
    assert.equal(pump.status().state,'stopped');
    db.close();
  }
});

test('encrypted live relay sends deltas before receipt, retries identical frames, rejects truncation and tampering', {timeout:15_000},async t=>{
  const db=new DatabaseSync(':memory:');
  for (const name of ['0004_relay_mailbox','0005_relay_stream','0006_relay_failure']) {
    db.exec(await readFile(new URL('../hosting/sites/drizzle/'+name+'.sql',import.meta.url),'utf8'));
  }
  const adapter=sqliteAdapter(db);
  const provider=generateWallet(), payer=generateWallet(), chainId=hash('live relay fixture');
  const state={providers:[provider.address],chainId,nonces:{},balances:{[payer.address]:1_000_000_000},maxOutputTokens:1024};
  const profile={provider:provider.address,model:MODEL,contextWindow:CONTEXT,kvCache:{k:'Q8',v:'Q8'},
    maxOutputTokens:1024,reasoningOptions:1,chatProtocol:1};
  const chatOptions={stream:true,tools:[{type:'function',function:{name:'edit_file',parameters:{type:'object'}}}]};
  const messages=[{role:'user',content:'secret request marker'}];
  const args=JSON.stringify({data:'🙂'.repeat(32000)});
  const message={role:'assistant',content:null,reasoning_content:'secret thought marker',
    tool_calls:[{id:'task',type:'function',function:{name:'edit_file',arguments:args}}]};
  let mode='clean',retry,first,generated=0;
  const relayUrl=await httpServer(t,async(req,raw)=>{
    const routed=await relayRoute(new Request('https://relay.invalid'+req.url,
      {method:req.method,headers:req.headers,body:raw||undefined}),adapter,state);
    const reply=await routed.json();
    assert.doesNotMatch(raw, /secret (request|thought) marker|edit_file|🙂/);
    assert.doesNotMatch(JSON.stringify(reply), /secret (request|thought) marker|edit_file|🙂/);
    if (req.url.endsWith('/frame') && mode==='clean' && JSON.parse(raw).payload.index===1) {
      if (!first) {first=raw; return Response.json({error:'lost frame acknowledgement'},{status:503});}
      retry=raw;
    }
    if (req.url.endsWith('/result') && reply.frames?.length && mode==='tamper') {
      reply.frames[0].box+='x';
    }
    if (req.url.endsWith('/result') && mode==='truncate' && reply.frames) {
      // Model an untrusted relay that hides all frames, then supplies the genuine signed completion.
      reply.frames=[];
      reply.tail=0;
    }
    return Response.json(reply,{status:routed.status});
  });
  const gate=Promise.withResolvers();
  const localUrl=await httpServer(t,async(req,raw,res)=>{
    if (req.url.startsWith('/v1/probe?')) {
      const challenge=new URL(req.url,'http://local').searchParams.get('challenge');
      const payload={domain:PROBE_DOMAIN,challenge,chainId,...profile,available:true};
      return Response.json({payload,signature:sign(provider.privateKey,payload)});
    }
    generated++;
    const input=JSON.parse(raw);
    assert.equal(req.headers.accept,'text/event-stream');
    assert.deepEqual(input.chatOptions,chatOptions);
    const finishReason='tool_calls';
    const payload={type:'inference',chainId,from:payer.address,provider:provider.address,nonce:input.request.nonce,
      model:MODEL,contextWindow:CONTEXT,requestHash:hash(input.request),responseHash:hash({message,finishReason}),
      inputTokens:18,cachedTokens:6,outputTokens:9,kvCache:profile.kvCache};
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(kind,value)=>res.write('event: '+kind+'\ndata: '+JSON.stringify(value)+'\n\n');
    send('delta',{reasoning_content:message.reasoning_content});
    if (mode==='clean') await gate.promise;
    send('delta',{tool_calls:[{index:0,...message.tool_calls[0]}]});
    send('receipt',{message,finishReason,payload,providerSignature:sign(provider.privateKey,payload)});
    res.end();
  });
  const pump=startProviderRelay({wallet:provider,chainId,relayUrl,adapterUrl:localUrl,pollMs:15,presenceMs:1500});
  try {
    let offer;
    for(let i=0;i<100 && !offer;i++){
      [offer]=await listRelayOffers(relayUrl,chainId,{chatProtocol:true});
      if(!offer)await delay(15);
    }
    assert.ok(offer);
    const observed=[];
    async function buy(nonce) {
      state.nonces[payer.address]=nonce-1;
      const request={type:'inference-request',chainId,provider:provider.address,payer:payer.address,nonce,
        expiresAt:Date.now()+120000,messagesHash:hash(messages),chatOptionsHash:hash(chatOptions),maxInputTokens:100,maxOutputTokens:30};
      return relayInfer({wallet:payer,chainId,provider:provider.address,relayUrl,offer:offer.offer,request,chatOptions,
        signature:sign(payer.privateKey,request),messages,pollMs:12,resultTimeoutMs:2500,onDelta:delta=>{
          observed.push(delta);
          if(delta.reasoning_content) gate.resolve();
        }});
    }
    assert.deepEqual((await buy(1)).message,message);
    assert.equal(observed.length,2);
    assert.equal(observed[1].tool_calls[0].function.arguments,args);
    assert.equal(first,retry);
    assert.equal(typeof retry,'string');
    mode='truncate';
    await assert.rejects(()=>buy(2),/Incomplete signed relay stream/);
    mode='tamper';
    await assert.rejects(()=>buy(3),/Invalid signed relay stream frame/);
    assert.equal(generated,3);
    assert.equal(observed.length,2);
  } finally {gate.resolve();await pump.close();db.close();}
});

for (const stopAt of ['queued','generating','completion ACK']) {
  test('provider shutdown finishes the accepted stream when stopped during '+stopAt,{timeout:12_000},async t=>{
    const db=new DatabaseSync(':memory:');
    for (const name of ['0004_relay_mailbox','0005_relay_stream','0006_relay_failure']) {
      db.exec(await readFile(new URL('../hosting/sites/drizzle/'+name+'.sql',import.meta.url),'utf8'));
    }
    const provider=generateWallet(), payer=generateWallet(), other=generateWallet(), adapter=sqliteAdapter(db);
    const chainId=hash('drain '+stopAt),profile={provider:provider.address,model:MODEL,contextWindow:CONTEXT,
      kvCache:{k:'Q8',v:'Q8'},maxOutputTokens:128,chatProtocol:1};
    const state={providers:[provider.address],chainId,nonces:{},
      balances:{[payer.address]:1_000_000_000,[other.address]:1_000_000_000},maxOutputTokens:128};
    const target=Promise.withResolvers(), release=Promise.withResolvers(), withdrawn=Promise.withResolvers();
    const admitted=Promise.withResolvers(), completeBoxes=[];
    let haltedEmptyPoll=false, runs=0, onlineAfterWithdrawal=0, offline=false;
    const relayUrl=await httpServer(t,async(req,raw)=>{
      const response=await relayRoute(new Request('https://relay.invalid'+req.url,
        {method:req.method,headers:req.headers,body:raw||undefined}),adapter,state);
      const reply=await response.json();
      if (req.url.endsWith('/submit') && response.status===201) admitted.resolve();
      if (req.url.endsWith('/presence') && response.ok) {
        if (JSON.parse(raw).payload.available===false) {offline=true;withdrawn.resolve();}
        else if (offline) onlineAfterWithdrawal++;
      }
      if (stopAt==='queued' && req.url.endsWith('/poll') && !reply.job && !haltedEmptyPoll) {
        haltedEmptyPoll=true;
        target.resolve();
        await release.promise; // In-flight poll saw an empty inbox before a subsequent submission.
      }
      if (req.url.endsWith('/complete') && response.ok) {
        completeBoxes.push(JSON.parse(raw).box);
        if (stopAt==='completion ACK' && completeBoxes.length===1) {
          target.resolve();
          await release.promise;
          return Response.json({error:'Lost completion acknowledgement'},{status:503});
        }
      }
      return Response.json(reply,{status:response.status});
    });
    const messages=[{role:'user',content:'hello'}],chatOptions={stream:true};
    const message={role:'assistant',content:'ok'},finishReason='stop';
    const localUrl=await httpServer(t,async(req,raw,res)=>{
      if (req.url.startsWith('/v1/probe?')) {
        const challenge=new URL(req.url,'http://local').searchParams.get('challenge');
        const payload={domain:PROBE_DOMAIN,challenge,chainId,...profile,available:true};
        return Response.json({payload,signature:sign(provider.privateKey,payload)});
      }
      const {request}=JSON.parse(raw);
      runs++;
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('event: delta\ndata: '+JSON.stringify({content:'o'})+'\n\n');
      if (stopAt==='generating') {target.resolve();await release.promise;}
      res.write('event: delta\ndata: '+JSON.stringify({content:'k'})+'\n\n');
      const payload={type:'inference',chainId,from:payer.address,provider:provider.address,nonce:request.nonce,
        model:MODEL,contextWindow:CONTEXT,requestHash:hash(request),responseHash:hash({message,finishReason}),
        inputTokens:11,cachedTokens:3,outputTokens:1,kvCache:profile.kvCache};
      res.end('event: receipt\ndata: '+JSON.stringify({message,finishReason,payload,
        providerSignature:sign(provider.privateKey,payload)})+'\n\n');
    });
    const pump=startProviderRelay({wallet:provider,chainId,relayUrl,adapterUrl:localUrl,pollMs:15,presenceMs:1500});
    try {
      let offer;
      for(let i=0;i<100 && !offer;i++){
        [offer]=await listRelayOffers(relayUrl,chainId);
        if(!offer)await delay(15);
      }
      assert.ok(offer);
      const deltas=[];
      function buy(wallet) {
        const request={type:'inference-request',chainId,provider:provider.address,payer:wallet.address,nonce:1,
          expiresAt:Date.now()+120000,messagesHash:hash(messages),chatOptionsHash:hash(chatOptions),maxInputTokens:32,maxOutputTokens:16};
        return relayInfer({wallet,relayUrl,chainId,provider:provider.address,offer:offer.offer,request,
          signature:sign(wallet.privateKey,request),messages,chatOptions,onDelta:async d=>deltas.push(d.content),pollMs:15});
      }
      if (stopAt==='queued') await target.promise;
      const response=buy(payer);
      await Promise.all([target.promise,admitted.promise]);
      const stopped=pump.close();
      assert.equal(pump.close(),stopped);
      await withdrawn.promise;
      assert.equal(pump.status().state,'draining');
      assert.deepEqual(await listRelayOffers(relayUrl,chainId),[]);
      await assert.rejects(buy(other),{status:429}); // Even an unexpired cached offer cannot enter.
      release.resolve();
      const [result,drain]=await Promise.all([response,stopped]);
      assert.equal(drain.confirmed,true);
      assert.deepEqual(result.message,message);
      assert.deepEqual(deltas,['o','k']);
      assert.equal(runs,1);
      assert.equal(completeBoxes.length,stopAt==='completion ACK'?2:1);
      assert.equal(new Set(completeBoxes).size,1);
      assert.equal(onlineAfterWithdrawal,0);
      assert.equal(pump.status().state,'stopped');
    } finally {release.resolve();await pump.close();db.close();}
  });
}
