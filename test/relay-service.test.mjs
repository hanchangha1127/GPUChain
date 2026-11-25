import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  const finish=(box,extra={})=>envelope('complete',provider,{provider:provider.address,jobId,salt:salt(),...extra},box);
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

test('only a signed terminal failure releases its nonce; replays keep their original outcome',async t=>{
  const f=fixture(t),box=randomBytes(96).toString('base64url');
  await f.call('presence',f.advertise());
  const first=f.makeJob(box);
  assert.equal((await f.call('submit',first))[0],201);
  const competing=f.makeJob(box,{payer:f.stranger.address,jobId:hash('concurrent buyer')});
  f.state.balances[f.stranger.address]=1_000_000;
  competing.signature=sign(f.stranger.privateKey,competing.payload);
  const [busy,reason]=await f.call('submit',competing);
  assert.equal(busy,409);
  assert.equal(reason.code,'provider_not_admitted');
  assert.equal(reason.jobId,competing.payload.jobId);
  const replacement=f.makeJob(box,{jobId:hash('corrected')});
  assert.equal((await f.call('submit',replacement))[1].code,undefined);
  assert.equal((await f.call('poll',f.poll()))[1].failureReceipt,1);
  const failure=f.finish(box,{outcome:'failed'});
  assert.equal((await f.call('complete',{...failure,signature:sign(f.payer.privateKey,failure.payload)}))[0],403);
  assert.equal((await f.call('submit',replacement))[0],409);
  assert.equal((await f.call('complete',failure))[0],200);
  assert.equal((await f.call('complete',f.finish(box)))[0],409);
  assert.equal((await f.call('complete',failure))[0],200);
  assert.equal((await f.call('submit',first))[1].status,'done');
  assert.equal((await f.call('submit',replacement))[0],201);
  assert.equal((await f.call('result',f.read()))[1].reply.payload.outcome,'failed');
  await f.call('poll',f.poll());
  const replacementMeta={jobId:replacement.payload.jobId};
  assert.equal((await f.call('complete',f.finish(box,replacementMeta)))[0],200);
  assert.equal((await f.call('complete',f.finish(box,{...replacementMeta,outcome:'failed'})))[0],409);
  assert.equal((await f.call('submit',f.makeJob(box,{jobId:hash('third')})))[0],409);
});

test('upgrading an existing relay preserves the nonce protection of a legacy completed row',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuchain-relay-upgrade-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'relay.sqlite');
  const legacy=new DatabaseSync(file);
  try {
    for (const name of ['0004_relay_mailbox','0005_relay_stream']) {
      legacy.exec(await readFile(new URL('../hosting/sites/drizzle/'+name+'.sql',import.meta.url),'utf8'));
    }
    legacy.exec(`PRAGMA user_version=2;
      INSERT INTO relay_jobs(id,provider,payer,nonce,phase,expires_ms,submit_hash,bytes)
        VALUES('existing','p','buyer',1,'done',1234,'hash',0)`);
  } finally { legacy.close(); }
  for (let i=0;i<2;i++) {
    const db=openRelayDatabase(file);
    try {
      assert.equal(db.prepare('PRAGMA user_version').first().user_version,3);
      assert.equal(db.prepare("SELECT failed_no_receipt FROM relay_jobs WHERE id='existing'").first().failed_no_receipt,0);
      assert.throws(()=>db.prepare(`INSERT INTO relay_jobs(id,provider,payer,nonce,phase,expires_ms,submit_hash,bytes)
        VALUES('next','p','buyer',1,'queued',1235,'next hash',0)`).run(),/UNIQUE/);
    } finally { db.close(); }
  }
});
