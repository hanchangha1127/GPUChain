import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { createGenesis, CONTEXT, MODEL, replay } from '../src/ledger.mjs';
import { nextCheckpoint } from '../src/checkpoint.mjs';
import { sequencerOutcome } from '../src/transaction-outcome.mjs';
import { hasPendingInference, recoverPendingInference, settleInference } from '../src/inference-settlement.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'gpuchain-settlement-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const seq=generateWallet(), buyer=generateWallet(), provider=generateWallet();
  const genesis=createGenesis(seq,{allocations:{[buyer.address]:1_000_000_000,[seq.address]:20},providers:[provider.address]});
  let head={genesis,state:replay([genesis]),epochHashes:[],signature:null};
  const p={type:'inference',chainId:genesis.hash,from:buyer.address,nonce:1,provider:provider.address,
    model:MODEL,contextWindow:CONTEXT,inputTokens:10,outputTokens:5,cachedTokens:2,requestHash:hash('A'),responseHash:hash('B')};
  const tx={payload:p,signature:sign(buyer.privateKey,p),providerSignature:sign(provider.privateKey,p)};
  const ledger=()=>({state:head.state,checkpoint:head,url:'http://127.0.0.1:8787'});
  const commit=value=>{
    const {next,block}=nextCheckpoint(head,value,seq);head=next;return block;
  };
  const payload={type:'transfer',chainId:genesis.hash,from:seq.address,nonce:1,to:buyer.address,amount:1};
  const concurrent={payload,signature:sign(seq.privateKey,payload)};
  return {directory,ledger,commit,tx,concurrent};
}

test('inference settles the exact signed receipt after an unrelated CAS conflict',async t=>{
  const f=await fixture(t);
  let calls=0;
  const request=async(_,options)=>{
    assert.deepEqual(options.body,f.tx);
    if (++calls===1) {
      f.commit(f.concurrent);
      throw Object.assign(Error('Concurrent tip'),{status:409});
    }
    return {block:f.commit(options.body)};
  };
  const result=await settleInference(f.ledger(),f.tx,{...f,resolveLedger:f.ledger,request});
  assert.equal(calls,2);
  assert.equal(result.height,2);
  assert.equal(f.ledger().state.nonces[f.tx.payload.from],1);
});

test('a restarted client reconciles an applied payment after ACK loss and later ledger activity',async t=>{
  const f=await fixture(t), before=f.ledger();
  let reads=0, posts=0, proof;
  const resolveLedger=()=>{if (++reads>1) throw Error('network disconnected');return f.ledger();};
  const request=async(_,options)=>{
    ++posts;proof=sequencerOutcome(f.commit(options.body));
    throw Error('lost reply');
  };
  assert.equal(hasPendingInference(f.directory),false);
  await assert.rejects(settleInference(before,f.tx,{...f,resolveLedger,request}),{code:'settlement_pending'});
  assert.equal(hasPendingInference(f.directory),true);
  f.commit(f.concurrent);
  const lookup=async(url,options)=>{
    assert.ok(url.endsWith('/v1/transaction-outcomes/'+hash(f.tx)));
    assert.ok(!options.body);
    return proof;
  };
  assert.deepEqual(await recoverPendingInference(f.directory,f.tx.payload.from,f.ledger,lookup),
    {height:1,hash:proof.header.hash});
  assert.equal(await recoverPendingInference(f.directory,f.tx.payload.from,()=>assert.fail('Unneeded ledger access')),null);
  assert.equal(hasPendingInference(f.directory),false);
  assert.equal(posts,1);
  assert.equal(f.ledger().state.nonces[f.tx.payload.from],1);
});

test('a rejected receipt or an already-consumed nonce cannot trigger another inference payment',async t=>{
  const f=await fixture(t), before=f.ledger();
  const request=async()=>assert.fail('A changed epoch limit must stop before submission');
  const resolveLedger=()=>({...before,state:{...before.state,maxOutputTokens:1}});
  await assert.rejects(settleInference(before,f.tx,{directory:f.directory,resolveLedger,request}),{code:'settlement_rejected'});
  assert.equal(hasPendingInference(f.directory),false);

  f.commit(f.tx);
  let reads=0;
  const missing=async(url,{body})=>{
    assert.ok(url.endsWith(hash(f.tx)) && !body);
    reads++;
    throw Object.assign(Error('Outcome evicted'),{status:404});
  };
  await assert.rejects(settleInference(before,f.tx,{directory:f.directory,resolveLedger:f.ledger,request:missing}),
    {code:'settlement_unconfirmed'});
  assert.equal(reads,1);
  assert.equal(hasPendingInference(f.directory),false);
});
