import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createActivation, activateCheckpoint, verifyConsensusAck } from '../src/consensus.mjs';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { nextCheckpoint } from '../src/checkpoint.mjs';
import { createGenesis, replay } from '../src/ledger.mjs';
import { startValidator } from '../src/validator.mjs';
import { requestJson } from '../src/http.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'gpuchain-paxos-'));
  const seq = generateWallet(), buyer = generateWallet(), other = generateWallet();
  const wallets = Array.from({length:3},generateWallet);
  const genesis = createGenesis(seq,{allocations:{[buyer.address]:100,[other.address]:100},
    providers:wallets.map(w=>w.address)});
  const legacy = {genesis,state:replay([genesis],genesis.hash),epochHashes:[],signature:null};
  const nodes = [],urls = [];
  let anchor;
  async function start(i) {
    const node = await startValidator({genesis,wallet:wallets[i],dir:join(root,String(i)),
      port:urls[i]?Number(new URL(urls[i]).port):0,syncIntervalMs:60_000,peerTimeoutMs:150,
      discover:async () => anchor});
    nodes[i] = node;
    urls[i] = node.url;
  }
  async function stop(i) { await nodes[i].close(); nodes[i]=null; }
  t.after(async () => {
    await Promise.all(nodes.map(node => node?.close()));
    await rm(root,{recursive:true,force:true});
  });
  for (let i=0;i<3;i++) await start(i);
  assert.equal((await requestJson(urls[0]+'/v1/status')).mode,'standby');
  assert.equal((await requestJson(urls[0]+'/v1/consensus/ready?challenge='+'1'.repeat(32))).payload.address,
    wallets[0].address);
  const validators = await Promise.all(wallets.map(async (w,i)=>({address:w.address,url:urls[i],
    instanceId:(await requestJson(urls[i]+'/v1/status')).instanceId})));
  const authority = createActivation(legacy,validators,seq);
  anchor = activateCheckpoint(legacy,authority);
  await nodes[0].sync();
  anchor = undefined; // Bootstrap has permanently gone offline.
  await nodes[0].sync(); // Peers obtain the certified anchor even after the issuer disappears.
  assert.equal((await requestJson(urls[1]+'/v1/status')).mode,'validator');
  const call = (i,path,body) => requestJson(urls[i]+'/v1/'+path,{body,timeoutMs:8000});
  const transfer = (from,to,nonce,amount) => {
    const payload = {type:'transfer',from:from.address,to:to.address,chainId:genesis.hash,nonce,amount};
    return {payload,signature:sign(from.privateKey,payload)};
  };
  return {genesis,authority,root,nodes,urls,wallets,buyer,other,start,stop,call,transfer,legacy};
}

test('independent validators continue without the bootstrap, recover lagging peers and stop below a majority',async t=>{
  const f = await fixture(t);
  const initial = f.transfer(f.buyer,f.wallets[0],1,23);
  await f.stop(0);
  const ack = await f.call(1,'transactions',initial);
  assert.ok(verifyConsensusAck(ack,initial,f.genesis,f.authority));
  assert.equal(ack.checkpoint.state.balances[f.buyer.address],77);
  await f.start(0);
  assert.equal((await f.call(0,'checkpoint')).state.tip,ack.block.hash);
  await f.stop(1); await f.stop(2);
  const follow = f.transfer(f.buyer,f.wallets[1],2,3);
  await assert.rejects(f.call(0,'transactions',follow),/503/);
  assert.equal((await f.call(0,'checkpoint')).state.height,1);
  await f.start(1);
  const ack2 = await f.call(0,'transactions',follow);
  assert.equal(ack2.checkpoint.state.balances[f.buyer.address],74);
  await f.start(2);
  assert.equal((await f.call(2,'checkpoint')).state.tip,ack2.block.hash);
  await assert.rejects(f.call(2,'transactions',follow),/nonce/i);
  await f.stop(0);
  const bytes = await readFile(join(f.root,'0','validator.sqlite'));
  assert.ok(!bytes.includes(Buffer.from(follow.signature)));
  await assert.rejects(startValidator({dir:join(f.root,'replacement-empty'),wallet:f.wallets[0],
    genesis:f.genesis,origin:f.urls[0],port:0,checkpoint:ack2.checkpoint}),/durable voting database/);
});

test('durable promises and prior acceptance survive proposer loss and force the original Paxos value',async t=>{
  const f = await fixture(t);
  const tx = f.transfer(f.buyer,f.wallets[0],1,7);
  const ballot = {round:67,proposer:f.wallets[0].address};
  const s = {chainId:f.genesis.hash,authorityHash:hash(f.authority),height:1,previousHash:f.genesis.hash,ballot};
  function message(phase, extra={}) {
    const payload = {domain:'gpuchain/paxos-'+phase+'/v1',...s,...extra};
    return {address:ballot.proposer,payload,signature:sign(f.wallets[0].privateKey,payload)};
  }
  const promises = await Promise.all([0,1].map(async i=>(await f.call(i,'consensus/prepare',message('prepare'))).proof));
  const accept = message('accept',{tx,promises});
  await Promise.all([0,1].map(i=>f.call(i,'consensus/accept',accept)));
  await f.stop(0); await f.stop(1); // the proposer never assembled or broadcast a checkpoint.
  await f.start(1);
  const second = f.transfer(f.other,f.wallets[2],1,4);
  const receipt = await f.call(2,'transactions',second);
  assert.ok(verifyConsensusAck(receipt,second,f.genesis,f.authority));
  assert.equal(receipt.checkpoint.state.height,2);
  assert.equal(receipt.checkpoint.state.balances[f.buyer.address],93);
  assert.equal(receipt.checkpoint.state.balances[f.other.address],96);
});

test('concurrent proposers cannot commit conflicting spends for a nonce',async t=>{
  const f = await fixture(t);
  const requests = [f.transfer(f.buyer,f.wallets[0],1,20),f.transfer(f.buyer,f.wallets[1],1,21)];
  await Promise.allSettled(requests.map((r,i)=>f.call(i,'transactions',r)));
  await Promise.all(f.nodes.map(n=>n.sync()));
  const heads = await Promise.all([0,1,2].map(i=>f.call(i,'checkpoint')));
  assert.ok(heads.every(h=>h.state.height === 1 && h.state.tip === heads[0].state.tip));
  assert.ok([79,80].includes(heads[0].state.balances[f.buyer.address]));
});

test('a default verifier keeps checking, rejects invalid and older snapshots and resumes with its durable head',async t=>{
  const dir = await mkdtemp(join(tmpdir(),'gpuchain-verifier-'));
  const seq=generateWallet(), wallet=generateWallet(), other=generateWallet();
  const genesis=createGenesis(seq,{allocations:{[wallet.address]:100},providers:[]});
  const initial={genesis,state:replay([genesis]),epochHashes:[],signature:null};
  const payload={type:'transfer',chainId:genesis.hash,from:wallet.address,to:other.address,nonce:1,amount:5};
  const next=nextCheckpoint(initial,{payload,signature:sign(wallet.privateKey,payload)},seq).next;
  let remote, node, enrollmentAttempts=0;
  const options={dir,genesis,wallet,port:0,syncIntervalMs:30,
    monitor:async()=>{
      if (!remote) throw Error('Test network offline');
      return {url:'https://test-ledger.example',checkpoint:remote};
    }, discover:async()=>{enrollmentAttempts++;}};
  t.after(async()=>{ await node?.close(); await rm(dir,{recursive:true,force:true}); });
  node=await startValidator(options);
  const status=()=>requestJson(node.url+'/v1/status');
  let report=await status();
  assert.equal(report.mode,'standby');
  assert.equal(report.verified,false);
  assert.match(report.syncError,/offline/);
  const id=report.instanceId;
  remote=initial;
  for (let retry=0;retry<100 && !(await status()).verified;retry++) await delay(15);
  report=await status();
  assert.equal(report.mode,'verifier');
  assert.equal(report.voting,false);
  assert.equal(report.ledgerUrl,'https://test-ledger.example');
  assert.ok(Number.isFinite(Date.parse(report.lastVerifiedAt)));
  assert.equal(report.enrollmentStatus,'needs-public-origin');
  remote=next;
  await node.sync();
  assert.equal((await status()).height,1);
  remote=structuredClone(next); remote.state.balances[wallet.address]=9000;
  await assert.rejects(node.sync(),/signature/i);
  assert.equal((await requestJson(node.url+'/v1/checkpoint')).state.balances[wallet.address],95);
  remote=initial;
  await assert.rejects(node.sync(),/rollback/i);
  remote=undefined;
  await node.close();
  node=await startValidator(options);
  report=await status();
  assert.equal(report.instanceId,id);
  assert.equal(report.tip,next.state.tip);
  assert.match(report.syncError,/offline/);
  assert.equal(enrollmentAttempts,0);
  for (const path of ['transactions','consensus/prepare','consensus/accept']) {
    await assert.rejects(requestJson(node.url+'/v1/'+path,{body:{}}),/503/);
  }
});

test('a verifying node enters voting only for its certified address, origin and durable database',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuchain-identity-'));
  const seq=generateWallet(), wallet=generateWallet();
  const genesis=createGenesis(seq,{allocations:{},providers:[wallet.address]});
  const legacy={genesis,state:replay([genesis]),epochHashes:[],signature:null};
  let checkpoint=legacy, enrollments=0;
  const nodes=[];
  t.after(async()=>{ await Promise.all(nodes.map(n=>n.close())); await rm(dir,{recursive:true,force:true}); });
  const origin='https://validator.example.org';
  const options={genesis,wallet,port:0,origin,syncIntervalMs:60_000,monitor:async()=>checkpoint,
    discover:async ({checkpoint:observed})=>{
      enrollments++;
      assert.equal(observed.state.tip,genesis.hash);
      throw Error('Temporary enrollment failure');
    }};
  const participant=await startValidator({...options,dir:join(dir,'participant')}); nodes.push(participant);
  let status=await requestJson(participant.url+'/v1/status');
  assert.equal(status.verified,true);
  assert.equal(status.voting,false);
  assert.equal(status.enrollmentStatus,'candidate');
  assert.equal(status.syncError,null);
  assert.match(status.enrollmentError,/enrollment failure/);
  const others=[1,2].map(i=>({address:generateWallet().address,instanceId:randomUUID(),url:'https://v'+i+'.example'}));
  checkpoint=activateCheckpoint(legacy,createActivation(legacy,
    [{address:wallet.address,url:origin,instanceId:status.instanceId},...others],seq));
  await participant.sync();
  status=await requestJson(participant.url+'/v1/status');
  assert.equal(status.mode,'validator');
  assert.equal(status.voting,true);
  assert.equal(status.enrollmentStatus,'voting');
  const fresh=await startValidator({...options,dir:join(dir,'fresh')}); nodes.push(fresh);
  status=await requestJson(fresh.url+'/v1/status');
  assert.equal(status.mode,'verifier');
  assert.equal(status.verified,true);
  assert.equal(status.voting,false);
  assert.equal(status.enrollmentStatus,'identity-mismatch');
  const outsider=await startValidator({...options,wallet:generateWallet(),dir:join(dir,'outsider')}); nodes.push(outsider);
  assert.equal((await requestJson(outsider.url+'/v1/status')).enrollmentStatus,'committee-fixed');
  for (const node of [outsider,fresh]) {
    await assert.rejects(requestJson(node.url+'/v1/consensus/accept',{body:{}}),/503/);
    assert.deepEqual(await requestJson(node.url+'/v1/checkpoint'),checkpoint);
  }
  assert.equal(enrollments,1);
});
