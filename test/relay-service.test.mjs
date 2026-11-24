import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openRelayDatabase } from '../src/local-relay.mjs';
import { purgeExpiredRelay, relayRoute } from '../src/relay-service.mjs';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { MODEL, CONTEXT } from '../src/ledger.mjs';

function fixture(t) {
  const db=openRelayDatabase(':memory:');
  t.after(()=>db.close());
  const payer=generateWallet(), provider=generateWallet(), stranger=generateWallet();
  const state={chainId:hash('fixture'),providers:[provider.address],nonces:{},maxOutputTokens:1024,
    balances:{[payer.address]:1_000_000}};
  let now=Date.now();
  const key=hash('ephemeral-provider-key'),jobId=hash('job');
  const salt=()=>randomBytes(16).toString('hex');
  function envelope(op,wallet,fields,box) {
    const payload={domain:'gpuchain/relay-'+op+'/v1',chainId:state.chainId,issuedAt:now,...fields};
    if(box!==undefined) payload.boxHash=hash(box);
    return {payload,signature:sign(wallet.privateKey,payload),...(box===undefined?{}:{box})};
  }
  const advertise=(overrides={})=>envelope('presence',provider,{provider:provider.address,publicKey:key,model:MODEL,
    contextWindow:CONTEXT,kvCache:{k:'Q8',v:'Q8'},maxOutputTokens:1024,available:true,expiresAt:now+45_000,...overrides});
  const makeJob=(box,overrides={})=>envelope('submit',payer,{payer:payer.address,provider:provider.address,jobId,
    providerKey:key,clientKey:hash('client key'),requestHash:hash('blinded request'),nonce:1,
    maxInputTokens:100,maxOutputTokens:10,expiresAt:now+40_000,...overrides},box);
  async function call(op,obj) {
    const request=new Request('http://relay.test/v1/relay/'+op,obj===undefined ? {} :
      {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)});
    const reply=await relayRoute(request,db,state,{now});
    return [reply.status,await reply.json()];
  }
  const read=(wallet=payer)=>envelope('result',wallet,{payer:wallet.address,jobId,salt:salt()});
  const poll=()=>envelope('poll',provider,{provider:provider.address,salt:salt()});
  const finish=box=>envelope('complete',provider,{provider:provider.address,jobId,salt:salt()},box);
  return {db,payer,provider,stranger,state,advertise,makeJob,call,read,poll,finish,key,
    advance:n=>now+=n,time:()=>now};
}

test('signed, chunked relay is idempotent, private to its two signers and purges even completed ciphertext',async t=>{
  const f=fixture(t);
  const advert=f.advertise();
  assert.equal((await f.call('presence',advert))[0],200);
  assert.deepEqual((await f.call('providers'))[1].providers,[advert]);
  const ciphertext=randomBytes(720_000).toString('base64url'), job=f.makeJob(ciphertext);
  const crossing=await Promise.all([f.call('submit',job),f.call('submit',job)]);
  assert.ok(crossing.every(([status])=>status===200 || status===201),JSON.stringify(crossing).slice(0,250));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_jobs').first().n,1);
  assert.ok(f.db.prepare('SELECT count(*) AS n, max(length(data)) AS b FROM relay_chunks').first().b<=512*1024);
  assert.equal((await f.call('providers'))[1].providers.length,0);
  const second=f.makeJob(ciphertext,{jobId:hash('other')});
  assert.equal((await f.call('submit',second))[0],409);
  const [polled,work]=await f.call('poll',f.poll());
  assert.equal(polled,200);
  assert.deepEqual(work.job,job);
  assert.deepEqual((await f.call('poll',f.poll()))[1].job,job);
  assert.equal((await f.call('result',f.read(f.stranger)))[0],404);
  const completed=f.finish(randomBytes(790_000).toString('base64url'));
  assert.equal((await f.call('complete',completed))[0],200);
  assert.equal((await f.call('complete',completed))[0],200);
  assert.equal((await f.call('complete',f.finish(randomBytes(32).toString('base64url'))))[0],409);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM relay_chunks WHERE direction=0').first().n,0);
  assert.deepEqual((await f.call('result',f.read()))[1].reply,completed);
  f.advance(301_000);
  assert.equal((await f.call('result',f.read()))[0],404);
  await purgeExpiredRelay(f.db,f.time());
  for(const table of ['relay_presence','relay_jobs','relay_chunks']) {
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM '+table).first().n,0);
  }
});

test('relay enforces capability, balance, signature, nonce, expiry and provider key changes',async t=>{
  const f=fixture(t),box=randomBytes(96).toString('base64url');
  assert.equal((await f.call('presence',f.advertise({kvCache:{k:'Q8',v:'Q4'}})))[0],400);
  const presence=f.advertise(); presence.signature=sign(f.stranger.privateKey,presence.payload);
  assert.equal((await f.call('presence',presence))[0],403);
  assert.equal((await f.call('presence',f.advertise()))[0],200);
  const tampered=f.makeJob(box);tampered.box=randomBytes(96).toString('base64url');
  assert.equal((await f.call('submit',tampered))[0],400);
  assert.equal((await f.call('submit',f.makeJob(box,{reasoningEffort:'high'})))[0],409);
  assert.equal((await f.call('submit',f.makeJob(box,{nonce:2})))[0],409);
  assert.equal((await f.call('submit',f.makeJob(box,{maxInputTokens:CONTEXT})))[0],400);
  f.state.balances[f.payer.address]=0;
  assert.equal((await f.call('submit',f.makeJob(box)))[0],402);
  f.state.balances[f.payer.address]=1_000_000;
  assert.equal((await f.call('submit',f.makeJob(box)))[0],201);
  const old=f.advertise();
  f.advance(10);
  const otherKey=hash('after restart');
  assert.equal((await f.call('presence',f.advertise({publicKey:otherKey,reasoningOptions:1})))[0],200);
  assert.equal((await f.call('presence',old))[0],409);
  assert.deepEqual((await f.call('poll',f.poll()))[1],{job:null});
  assert.equal((await f.call('submit',f.makeJob(box)))[0],409);
  assert.equal((await f.call('submit',f.makeJob(box,{providerKey:otherKey,reasoningEffort:'high'})))[0],201);
  f.advance(61_000);
  assert.equal((await f.call('result',f.read()))[0],404);
  assert.deepEqual((await f.call('providers'))[1].providers,[]);
});
