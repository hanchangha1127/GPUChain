import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { inspectInferenceRoutes } from '../src/inference-routes.mjs';
import { CONTEXT, MODEL } from '../src/ledger.mjs';
import { makeRelayKeyPair } from '../src/relay-crypto.mjs';

const chainId=hash('route diagnostics fixture');

async function directory(t) {
  const fixture={status:200,body:{chainId,providers:[]},requests:[]};
  const server=createServer((req,res)=>{
    fixture.requests.push([req.method,req.url]);
    res.writeHead(fixture.status,{'content-type':'application/json'});
    res.end(JSON.stringify(fixture.body));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return Object.assign(fixture,{url:'http://127.0.0.1:'+server.address().port});
}

function offer(wallet,fields={},signer=wallet) {
  const now=Date.now();
  const payload={domain:'gpuchain/relay-presence/v1',chainId,provider:wallet.address,
    publicKey:makeRelayKeyPair().publicKey,model:MODEL,contextWindow:CONTEXT,kvCache:{k:'Q8',v:'Q8'},
    maxOutputTokens:4096,reasoningOptions:1,chatProtocol:1,available:true,issuedAt:now,expiresAt:now+60_000,...fields};
  return {payload,signature:sign(signer.privateKey,payload)};
}

test('a requester can distinguish an empty registry, its own provider and an excluded provider without querying a relay',async t=>{
  const relay=await directory(t);
  const payer=generateWallet().address, provider=generateWallet().address;
  const ledger={url:relay.url,state:{chainId,providers:[]}};
  for (const [providers,options,code] of [
    [[],{},'no_registered_provider'],[[payer],{},'self_provider_only'],
    [[payer,provider],{excludeProvider:provider},'no_eligible_provider'],
  ]) {
    ledger.state.providers=providers;
    const result=await inspectInferenceRoutes(ledger,{payer,transport:'relay',...options});
    assert.deepEqual(result,{routes:[],diagnostic:{code,eligible:0,registered:providers.length,relaysReached:0,relaysChecked:0}});
  }
  const direct=await inspectInferenceRoutes(ledger,{payer,transport:'direct'});
  assert.deepEqual(direct,{routes:[],diagnostic:{code:'no_direct_provider',eligible:1,registered:2,relaysReached:0,relaysChecked:0}});
  assert.deepEqual(relay.requests,[]);
});

test('relay diagnostics distinguish missing offers from authenticated providers with incompatible options',async t=>{
  const relay=await directory(t);
  const provider=generateWallet(),payer=generateWallet(),unregistered=generateWallet();
  const ledger={url:relay.url,state:{chainId,providers:[provider.address,payer.address]}};
  const inspect=()=>inspectInferenceRoutes(ledger,{payer:payer.address,transport:'relay',reasoning:true,chatProtocol:true,maxOutputTokens:4096});
  relay.body.providers=[offer(unregistered),offer(payer),offer(provider,{maxOutputTokens:1},unregistered),
    offer(provider,{issuedAt:Date.now()-100_000,expiresAt:Date.now()-40_000}),
    offer(provider,{chainId:hash('foreign chain')})];
  const invalid=await inspect();
  assert.deepEqual(invalid,{routes:[],diagnostic:{code:'no_encrypted_provider',registered:2,eligible:1,relaysChecked:1,relaysReached:1}});
  for (const mismatch of [{maxOutputTokens:4095},{chatProtocol:0},{reasoningOptions:0}]) {
    relay.body.providers=[offer(provider,mismatch)];
    const result=await inspect();
    assert.equal(result.diagnostic.code,'provider_capability_mismatch');
    assert.deepEqual(result.routes,[]);
  }
  relay.body.providers.push(offer(provider));
  const ready=await inspect();
  assert.equal(ready.diagnostic.code,'ready');
  assert.deepEqual(ready.routes.map(r=>[r.provider,r.transport,r.latencyKind]),[[provider.address,'relay','relay-rtt']]);
  assert.deepEqual(relay.requests,Array(5).fill(['GET','/v1/relay/providers']));
});

test('a partial relay outage stays distinguishable from an empty or unreachable directory',async t=>{
  const first=await directory(t), second=await directory(t);
  const provider=generateWallet(), payer=generateWallet();
  const state={chainId,providers:[provider.address]};
  const validators=[first,second,second].map(({url})=>({url}));
  const ledger={url:first.url,checkpoint:{state,authority:{payload:{validators}}}};
  const inspect=()=>inspectInferenceRoutes(ledger,{payer:payer.address,transport:'relay'});
  const expected={eligible:1,registered:1,relaysChecked:2};
  assert.deepEqual((await inspect()).diagnostic,{...expected,relaysReached:2,code:'no_encrypted_provider'});
  second.status=503;
  assert.deepEqual((await inspect()).diagnostic,{...expected,relaysReached:1,code:'relay_partial'});
  first.body.chainId=hash('wrong directory');
  assert.deepEqual((await inspect()).diagnostic,{...expected,relaysReached:0,code:'relay_unreachable'});
  first.body={chainId,providers:[offer(provider)]};
  assert.deepEqual((await inspect()).diagnostic,{...expected,relaysReached:1,code:'ready'});
});
