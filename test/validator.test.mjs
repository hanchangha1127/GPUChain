import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivation, activateCheckpoint, verifyConsensusAck } from '../src/consensus.mjs';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
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
