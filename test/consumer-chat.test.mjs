import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { purchaseChat } from '../src/consumer-chat.mjs';
import { generateWallet, hash, sign, verify } from '../src/crypto.mjs';
import { createGenesis, createBlock, replay, applyBlock, CONTEXT, MODEL } from '../src/ledger.mjs';
import { makeRelayKeyPair, openRelayBox } from '../src/relay-crypto.mjs';

async function listen(t, handler) {
  const server=createServer(async (req,res)=>{
    try { await handler(req,res); }
    catch (err) { res.writeHead(500); res.end(JSON.stringify({error:err.message})); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return 'http://127.0.0.1:'+server.address().port;
}

async function body(req) {
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}

const event = (name,value) => 'event: '+name+'\ndata: '+JSON.stringify(value)+'\n\n';
const tool = {type:'function',function:{name:'read_text',parameters:{type:'object'}}};
const message = {role:'assistant',content:null,reasoning_content:'read first',tool_calls:[
  {id:'call-1',type:'function',function:{name:'read_text',arguments:'{"path":"a"}'}}
]};

async function fixture(t) {
  const sequencer=generateWallet(),payer=generateWallet();
  const providers=[generateWallet(),generateWallet()].map(wallet=>({
    wallet,ready:true,calls:0,probes:0,cached:0,mode:'ok'
  }));
  const genesis=createGenesis(sequencer,{allocations:{[payer.address]:100_000_000},
    providers:providers.map(p=>p.wallet.address)});
  let state=replay([genesis],genesis.hash);
  const endpoints={};
  for (const p of providers) {
    endpoints[p.wallet.address]=await listen(t,async (req,res)=>{
      const path=new URL(req.url,'http://localhost');
      if (path.pathname==='/v1/probe') {
        p.probes++;
        const payload={domain:'gpuchain/provider-probe/v1',provider:p.wallet.address,chainId:genesis.hash,
          challenge:path.searchParams.get('challenge'),available:p.ready,model:MODEL,contextWindow:CONTEXT,
          kvCache:{k:'Q8',v:'Q8'},reasoningOptions:1,chatProtocol:1,maxOutputTokens:128};
        return res.end(JSON.stringify({payload,signature:sign(p.wallet.privateKey,payload)}));
      }
      assert.equal(path.pathname,'/v1/infer');
      const {request,signature,messages,chatOptions}=await body(req);
      assert.ok(verify(payer.address,request,signature));
      assert.equal(request.chatOptionsHash,hash(chatOptions));
      assert.equal(request.messagesHash,hash(messages));
      assert.ok(chatOptions.stream);
      p.calls++;
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(event('delta',{role:'assistant',reasoning_content:p.mode==='tamper-reasoning'?'wrong':'read first'}));
      await p.gate;
      res.write(event('delta',{tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'read_',arguments:'{"path":'}}]}));
      res.write(event('delta',{tool_calls:[{index:0,function:{name:'text',arguments:p.mode==='tamper-tool'?'"b"}':'"a"}'}}]}));
      if (p.mode==='truncated') return res.end();
      const finishReason='tool_calls';
      const payload={type:'inference',chainId:genesis.hash,from:payer.address,provider:p.wallet.address,nonce:request.nonce,
        model:MODEL,contextWindow:CONTEXT,requestHash:hash(request),responseHash:hash({message,finishReason}),
        inputTokens:30,cachedTokens:p.cached,outputTokens:8};
      res.end(event('receipt',{message,finishReason:p.mode==='tamper-finish'?'stop':finishReason,
        payload,providerSignature:sign(p.wallet.privateKey,payload)}));
    });
  }
  const url=await listen(t,async (req,res)=>{
    assert.equal(req.url,'/v1/transactions');
    const tx=await body(req);
    const block=createBlock(state,tx,sequencer);
    state=applyBlock(state,block);
    res.end(JSON.stringify({block}));
  });
  const resolveLedger=async()=>({url,state:{...state,providerEndpoints:endpoints},checkpoint:{genesis}});
  const buy=(options={})=>purchaseChat({wallet:payer,maxInputTokens:128,maxOutputTokens:16,
    transport:'direct',chatOptions:{tools:[tool]},messages:[{role:'user',content:'Read a'}],onDelta:async()=>{},
    ...options},{resolveLedger});
  return {buy,providers,state:()=>state};
}

test('delivers direct deltas before receipt, prefers the warm provider, and settles measured cache reads',async t=>{
  const {buy,providers:[warm,other],state}=await fixture(t);
  const gate=Promise.withResolvers();
  t.after(()=>gate.resolve());
  warm.gate=gate.promise;
  warm.cached=24;
  const first=Promise.withResolvers();
  const observed=[];
  const done=buy({preferredProvider:warm.wallet.address,onDelta:delta=>{
    observed.push(delta);
    first.resolve();
  }});
  await Promise.race([first.promise,done]);
  assert.equal(observed[0].reasoning_content,'read first');
  assert.equal(state().height,0);
  gate.resolve();
  const result=await done;
  assert.equal(result.provider,warm.wallet.address);
  assert.equal(result.finishReason,'tool_calls');
  assert.deepEqual(result.message,message);
  assert.equal(observed.length,3);
  assert.equal(result.usage.cachedTokens,24);
  assert.equal(state().totalWorkTokens,30-24+8);
  assert.equal(state().balances[warm.wallet.address],6*150+24*16+8*470);
  assert.equal(other.probes,0);

  warm.ready=false;
  const next=await buy({preferredProvider:warm.wallet.address});
  assert.equal(next.provider,other.wallet.address);
  assert.equal(next.usage.cachedTokens,0);
  assert.equal(state().height,2);
  assert.equal(warm.calls,1);
  assert.equal(other.calls,1);
});

test('partial output, mismatched reasoning or tool arguments, and an unsigned finish reason never settle or replay',async t=>{
  const {buy,providers:[warm,other],state}=await fixture(t);
  for (const [mode,expected] of [['truncated',/ended before the receipt/],['tamper-reasoning',/differs from signed/],
    ['tamper-tool',/differs from signed/],['tamper-finish',/Invalid provider receipt/]]) {
    warm.mode=mode;
    const observed=[];
    await assert.rejects(buy({preferredProvider:warm.wallet.address,onDelta:d=>observed.push(d)}),expected);
    assert.equal(observed.length,3);
    assert.equal(state().height,0);
  }
  assert.equal(warm.calls,4);
  assert.equal(other.calls,0);
});

test('encrypted discovery briefly waits for the previous provider before sending a follow-up',async t=>{
  const payer=generateWallet(), warm=generateWallet(), cold=generateWallet();
  const keys=makeRelayKeyPair();
  const chainId=hash('warm provider discovery'), prompt='private follow-up marker';
  const state={chainId,providers:[warm.address,cold.address],
    nonces:{},balances:{[payer.address]:100_000_000},maxOutputTokens:128};
  let reads=0, submit;
  const offer=(wallet,publicKey)=>{
    const issuedAt=Date.now();
    const payload={domain:'gpuchain/relay-presence/v1',chainId,provider:wallet.address,publicKey,
      model:MODEL,contextWindow:CONTEXT,kvCache:{k:'Q8',v:'Q8'},chatProtocol:1,
      available:true,maxOutputTokens:128,issuedAt,expiresAt:issuedAt+60_000};
    return {payload,signature:sign(wallet.privateKey,payload)};
  };
  const coldKey=makeRelayKeyPair().publicKey;
  const url=await listen(t,async (req,res)=>{
    if (req.url==='/v1/relay/providers') {
      const providers=[offer(cold,coldKey)];
      if (++reads>1) providers.push(offer(warm,keys.publicKey));
      return res.end(JSON.stringify({chainId,providers}));
    }
    assert.equal(req.url,'/v1/relay/submit');
    submit=await body(req);
    res.writeHead(409);
    res.end(JSON.stringify({error:'Fixture stops after dispatch verification'}));
  });
  const resolveLedger=async()=>({url,state});
  await assert.rejects(purchaseChat({wallet:payer,transport:'relay',preferredProvider:warm.address,
    messages:[{role:'user',content:prompt}],chatOptions:{},maxInputTokens:128,maxOutputTokens:16},
  {resolveLedger}),/Fixture stops after dispatch verification/);
  assert.equal(reads,2);
  assert.equal(submit.payload.provider,warm.address);
  assert.notEqual(submit.payload.requestHash,hash(prompt));
  assert.doesNotMatch(JSON.stringify(submit),/private follow-up marker/);
  const clear=openRelayBox(keys.privateKey,submit.payload.clientKey,submit.payload,'request',submit.box);
  assert.equal(clear.messages[0].content,prompt);
});
