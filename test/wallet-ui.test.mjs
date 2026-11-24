import test from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import { once } from 'node:events';
import { generateWallet } from '../src/crypto.mjs';
import { createGenesis, replay, MODEL, CONTEXT } from '../src/ledger.mjs';
import { startWalletUi } from '../src/wallet-ui.mjs';

function fixture() {
  const owner = generateWallet(), provider = generateWallet(), sequencer = generateWallet();
  const genesis = createGenesis(sequencer,{allocations:{[owner.address]:101},providers:[provider.address]});
  const state = replay([genesis],genesis.hash);
  const status = {address:owner.address,chainId:genesis.hash,mode:'verifier',verified:true,voting:false,
    height:state.height,tip:state.tip,lastVerifiedAt:new Date().toISOString(),instanceId:'example',
    ledgerUrl:'https://ledger.example.org',enrollmentStatus:'needs-public-origin',privateKey:owner.privateKey};
  return {owner,provider,genesis,status,checkpoint:{genesis,state,epochHashes:[],signature:null}};
}

async function fakeProvider(t,handle) {
  const s = createServer(handle);
  s.listen(0,'127.0.0.1');
  await once(s,'listening');
  t.after(()=>new Promise(resolve=>s.close(resolve)));
  return 'http://127.0.0.1:'+s.address().port;
}

function read(url,{path='/api/overview',method='GET',headers}={}) {
  return new Promise((resolve,reject)=>{
    const req = http.request(url+path,{method,headers},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',s=>{body+=s;});
      res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
    });
    req.on('error',reject);
    req.end();
  });
}

test('wallet overview uses local verified balances, provider identity and actual inference activity',async t=>{
  const data = fixture();
  let polls=0;
  const providerUrl = await fakeProvider(t,(req,res)=>{
    assert.equal(req.url,'/v1/info');
    assert.equal(req.method,'GET');
    polls++;
    res.end(JSON.stringify({chainId:data.genesis.hash,provider:data.provider.address,model:MODEL,contextWindow:CONTEXT,
      busy:true,inferenceActive:false,privateKey:data.provider.privateKey}));
  });
  const s = await startWalletUi({getSnapshot:()=>data,port:0,providerUrl});
  t.after(s.close);
  const first = await read(s.url);
  assert.equal(first.status,200);
  const result=JSON.parse(first.body);
  assert.deepEqual(result.wallet,{address:data.owner.address,balanceNanocoins:101,nonce:0});
  assert.deepEqual(result.inference,{adapter:'online',nodeRunsInference:false,providerAddress:data.provider.address,
    walletRegistered:false,sameWallet:false,providerRegistered:true,model:MODEL,contextWindow:CONTEXT,
    busy:true,inferenceActive:false});
  assert.equal(result.network.consensus,'bootstrap');
  assert.equal(result.network.epochTarget,1_000_000_000);
  assert.equal(result.network.registeredProviders,1);
  assert.equal(first.body.includes(data.owner.privateKey),false);
  assert.equal(first.body.includes(data.provider.privateKey),false);
  assert.equal(first.body.includes(data.genesis.payload.sequencer),false);
  assert.equal(first.body.includes('privateKey'),false);
  const second=await read(s.url);
  assert.equal(second.status,200);
  assert.equal(polls,1);
  assert.equal(first.headers['access-control-allow-origin'],undefined);
  assert.equal(first.headers['cache-control'],'no-store');
  assert.match(first.headers['content-security-policy'],/frame-ancestors 'none'/);
});

test('wallet UI rejects cross-origin, forwarded and mutating requests and serves only listed assets',async t=>{
  const data=fixture();
  let accessed=0;
  const s=await startWalletUi({getSnapshot:()=>{accessed++;return data;},port:0});
  t.after(s.close);
  for (const headers of [{host:'evil.example'},{origin:'https://evil.example'},
    {'sec-fetch-site':'cross-site'},{'x-forwarded-for':'192.0.2.44'}]) {
    assert.equal((await read(s.url,{headers})).status,403);
  }
  assert.equal((await read(s.url,{method:'POST'})).status,405);
  for (const path of ['/validator.wallet.json','/v1/checkpoint','/api/transactions']) {
    assert.equal((await read(s.url,{path})).status,404);
  }
  for (const path of ['/','/style.css','/app.js','/amount.mjs']) assert.equal((await read(s.url,{path})).status,200);
  assert.equal(accessed,0);
  await assert.rejects(startWalletUi({getSnapshot:()=>data,port:0,providerUrl:'https://example.org'}),/loopback/);
  await assert.rejects(startWalletUi({getSnapshot:()=>data,port:0,providerUrl:'http://secret@127.0.0.1'}),/loopback/);
});

test('wallet preserves every nanocoin above the safe integer range and rejects imprecise numbers',async t=>{
  const data=fixture();
  let balance='1000000000000000000000';
  const getSnapshot=()=>({status:data.status,checkpoint:{
    ...data.checkpoint,state:{...data.checkpoint.state,balances:{[data.owner.address]:balance}}
  }});
  const s=await startWalletUi({getSnapshot,port:0}); t.after(s.close);
  for (const amount of ['1000000000000000000000','999999999999999999999',101]) {
    balance=amount;
    const result=await read(s.url);
    assert.equal(result.status,200);
    assert.equal(JSON.parse(result.body).wallet.balanceNanocoins,amount);
  }
  balance=1e21;
  assert.equal((await read(s.url)).status,503);
});

test('unknown local state or unrelated adapters cannot appear as zero balance or active mining',async t=>{
  const data=fixture();
  let snapshot={status:{...data.status,verified:false,mode:'standby',tip:undefined,height:undefined},checkpoint:null};
  const providerUrl=await fakeProvider(t,(_req,res)=>res.end(JSON.stringify({
    chainId:'f'.repeat(64),provider:data.owner.address,model:MODEL,contextWindow:CONTEXT,busy:true,inferenceActive:true,
  })));
  const s=await startWalletUi({getSnapshot:()=>snapshot,port:0,providerUrl}); t.after(s.close);
  const got=JSON.parse((await read(s.url)).body);
  assert.equal(got.inference.adapter,'different-chain');
  assert.equal(got.inference.inferenceActive,null);
  assert.equal(got.inference.walletRegistered,null);
  assert.equal(got.wallet.balanceNanocoins,null);
  assert.equal(got.wallet.nonce,null);
  assert.equal(got.network.height,null);
  snapshot={status:data.status,checkpoint:null};
  assert.equal((await read(s.url)).status,503);
  snapshot={...data,status:{...data.status,syncError:'upstream lost',ledgerUrl:'https://user:credential@bad.example/'}};
  const cached=JSON.parse((await read(s.url)).body);
  assert.equal(cached.wallet.balanceNanocoins,101);
  assert.equal(cached.node.verified,true);
  assert.ok(cached.node.syncError);
  assert.equal(cached.node.ledgerUrl,null);
});

test('local provider activity remains unknown for older, incompatible and unready adapters',async t=>{
  const data=fixture();
  const profile={provider:data.owner.address,chainId:data.genesis.hash,model:MODEL,contextWindow:CONTEXT};
  for (const [status,info,adapter,activity] of [
    [200,profile,'online',null],
    [200,{...profile,busy:true,inferenceActive:true},'online',true],
    [200,{...profile,model:'another model',inferenceActive:true},'incompatible',null],
    [503,{error:'model loading'},'not-ready',null],
  ]) {
    const providerUrl=await fakeProvider(t,(_req,res)=>{
      res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(info));
    });
    const s=await startWalletUi({port:0,getSnapshot:()=>data,providerUrl}); t.after(s.close);
    const {inference}=JSON.parse((await read(s.url)).body);
    assert.equal(inference.adapter,adapter);
    assert.equal(inference.inferenceActive,activity);
    if (adapter === 'online') {
      assert.equal(inference.sameWallet,true);
      assert.equal(inference.providerRegistered,false);
    }
  }
});
