import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nextCheckpoint } from '../src/checkpoint.mjs';
import { activateCheckpoint, certify, consensusCandidate, createActivation, votePayload } from '../src/consensus.mjs';
import { generateWallet, sign } from '../src/crypto.mjs';
import { createGenesis, replay } from '../src/ledger.mjs';
import { resolvePublicLedger } from '../src/public-network.mjs';

function network() {
  const sequencer = generateWallet(), customer = generateWallet();
  const genesis = createGenesis(sequencer, {allocations:{[customer.address]:100}, providers:[]});
  const first = {genesis, state:replay([genesis],genesis.hash), epochHashes:[], signature:null};
  function pay(previous,amount) {
    const payload = {type:'transfer',chainId:genesis.hash,from:customer.address,
      to:sequencer.address, nonce:(previous.state.nonces[customer.address] ?? 0) + 1, amount};
    return nextCheckpoint(previous,{payload,signature:sign(customer.privateKey,payload)},sequencer).next;
  }
  return {first, chainId:genesis.hash, pay,sequencer,customer};
}

async function cache(t) {
  const dir = await mkdtemp(join(tmpdir(),'gpu-discovery-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  return dir;
}

async function peer(t, checkpoint, mode = 'sequencer') {
  const p = {checkpoint,mode};
  const server = createServer((req,res) => {
    assert.equal(req.method,'GET');
    const {state} = p.checkpoint;
    const reply = req.url === '/v1/checkpoint' ? p.checkpoint :
      {chainId:state.chainId, mode:p.mode, address:p.address,instanceId:p.instanceId,height:state.height, tip:state.tip};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(reply));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  p.url = 'http://127.0.0.1:' + server.address().port;
  p.close = async () => {
    if (server.listening) {
      const stopped = once(server,'close');
      server.close();
      server.closeAllConnections();
      await stopped;
    }
  };
  t.after(p.close);
  return p;
}

test('verifiers can serve authenticated reads but cannot supply their own upstream or confirm writes',async t=>{
  const {chainId,first} = network();
  const mirror = await peer(t,first,'verifier');
  mirror.instanceId = randomUUID();
  const opts = {chainId,cacheDir:await cache(t),seeds:'',refresh:null,directory:{chainId,endpoints:[mirror.url]}};
  assert.equal((await resolvePublicLedger(opts)).url,mirror.url);
  await assert.rejects(resolvePublicLedger({...opts,excludeInstanceId:mirror.instanceId}),/No reachable/);
  await assert.rejects(resolvePublicLedger({...opts,write:true}),/No reachable/);
});

test('a scheduled refresh learns a standby while Sites is healthy, then permits writes with Sites and GitHub offline', async t => {
  const {chainId,first,pay} = network();
  const hosted = await peer(t,first);
  const moved = await peer(t,first,'follower');
  const opts = {chainId,cacheDir:await cache(t),seeds:'',directory:{chainId,endpoints:[hosted.url]}};
  let calls = 0;
  const refresh = async () => {
    calls++;
    return {chainId,endpoints:calls === 1 ? [hosted.url] : [hosted.url,moved.url]};
  };
  assert.equal((await resolvePublicLedger({...opts,refresh,now:100})).url,hosted.url);
  assert.equal((await resolvePublicLedger({...opts,refresh,now:200})).url,hosted.url);
  assert.equal(calls,1);
  assert.equal((await resolvePublicLedger({...opts,refresh,now:86_400_100})).url,hosted.url);
  assert.equal(calls,2);
  hosted.mode = 'frozen';
  moved.mode = 'sequencer';
  moved.checkpoint = pay(first,7);
  await hosted.close();
  const reopened = await resolvePublicLedger({...opts,write:true,now:86_400_200,refresh:() => {
    calls++;
    throw Error('Offline');
  }});
  assert.equal(calls,2);
  assert.equal(reopened.url,moved.url);
  assert.equal(reopened.state.tip,moved.checkpoint.state.tip);
});

test('a newly frozen sole bootstrap triggers immediate directory refresh even during the refresh interval', async t => {
  const {chainId,first} = network();
  const hosted = await peer(t,first), successor = await peer(t,first);
  const opts = {chainId,cacheDir:await cache(t),seeds:'',directory:{chainId,endpoints:[hosted.url]}};
  let calls = 0;
  const refresh = () => ({chainId,endpoints:[++calls === 1 ? hosted.url : successor.url]});
  assert.equal((await resolvePublicLedger({...opts,refresh,now:100})).url,hosted.url);
  hosted.mode = 'frozen';
  assert.equal((await resolvePublicLedger({...opts,write:true,refresh,now:200})).url,successor.url);
  assert.equal(calls,2);
});

test('refuses stale writes behind a newer follower, rollback, equivocation, invalid signatures, and other genesis', async t => {
  const {chainId,first,pay} = network();
  const stale = await peer(t,first);
  const follower = await peer(t,pay(first,7),'follower');
  const opts = {chainId,cacheDir:await cache(t),seeds:stale.url,
    directory:{chainId,endpoints:[follower.url]},refresh:null};
  assert.equal((await resolvePublicLedger(opts)).url,follower.url);
  await assert.rejects(resolvePublicLedger({...opts,write:true}),/No reachable writable/);
  stale.checkpoint = pay(first,6);
  await assert.rejects(resolvePublicLedger(opts),/Conflicting signed checkpoints/);
  await follower.close();
  await assert.rejects(resolvePublicLedger(opts),/Conflicting signed checkpoints/);
  stale.checkpoint = first;
  await assert.rejects(resolvePublicLedger(opts),/last verified checkpoint/);
  stale.checkpoint = structuredClone(pay(first,7));
  stale.checkpoint.signature = '0'.repeat(128);
  await assert.rejects(resolvePublicLedger(opts),/No reachable/);
  stale.checkpoint = network().first;
  await assert.rejects(resolvePublicLedger(opts),/No reachable/);
  await assert.rejects(resolvePublicLedger({...opts,directory:{chainId:'untrusted',endpoints:[]}}),
    /Invalid testnet endpoint directory/);
});

test('signed activation bootstraps peers from retired Sites and other checkpoints cannot downgrade learned authority', async t => {
  const {chainId,first,sequencer,customer} = network();
  const keys = Array.from({length:3},generateWallet);
  const hosts = await Promise.all(keys.map(()=>peer(t,first,'standby')));
  const validators = keys.map((key,i)=>({address:key.address,url:hosts[i].url,instanceId:randomUUID()}));
  const old = await peer(t,first,'retired');
  const activation = createActivation(first,validators,sequencer);
  const pivot = activateCheckpoint(first,activation);
  old.checkpoint = pivot;
  const opts = {chainId,cacheDir:await cache(t),seeds:'',directory:{chainId,endpoints:[old.url]},refresh:null};
  assert.equal((await resolvePublicLedger({...opts,activation:true})).checkpoint.authority.signature,activation.signature);
  await assert.rejects(resolvePublicLedger({...opts,write:true}),/No reachable writable/);
  old.mode = 'sequencer';
  old.checkpoint = first;
  await assert.rejects(resolvePublicLedger({...opts,write:true}),/No reachable writable/);
  await old.close();

  const payload = {type:'transfer',chainId,nonce:1,from:customer.address,to:keys[0].address,amount:1};
  const {next} = consensusCandidate(pivot,{payload,signature:sign(customer.privateKey,payload)});
  const ballot = {round:1,proposer:keys[0].address};
  const votes = keys.slice(0,2).map(key=>({address:key.address,signature:sign(key.privateKey,votePayload(next,activation,ballot))}));
  const committed = certify(next,activation,ballot,votes);
  // A proxy may copy a certified checkpoint and claim it is writable.
  // No validator's certified origin/identity matches that proxy.
  const imposter = await peer(t,committed,'validator');
  imposter.address = validators[0].address;
  imposter.instanceId = validators[0].instanceId;
  await assert.rejects(resolvePublicLedger({...opts,seeds:imposter.url,write:true}),/No reachable writable/);
  for (const [i,h] of hosts.entries()) {
    h.mode = 'validator'; h.checkpoint = committed;
    h.address = validators[i].address; h.instanceId = validators[i].instanceId;
  }
  const selected = await resolvePublicLedger({...opts,write:true});
  assert.ok(validators.some(member=>member.url === selected.url));
  assert.equal(selected.state.balances[keys[0].address],1);
  const alternate = validators.map((v,i)=>i===0 ? {...v,address:generateWallet().address} : v);
  hosts[2].checkpoint = activateCheckpoint(first,createActivation(first,alternate,sequencer));
  await assert.rejects(resolvePublicLedger(opts),/Conflicting signed consensus authority/);
});

test('bundled and refreshed signed directory certificates pin cold clients before any committee is reachable',async t=>{
  const {chainId,first,sequencer} = network();
  const legacy = await peer(t,first);
  const peers = await Promise.all([...Array(3)].map(()=>peer(t,first,'standby')));
  const validators = peers.map(p => ({address:generateWallet().address,url:p.url,instanceId:randomUUID()}));
  const authority = createActivation(first,validators,sequencer);
  const directory = {chainId,endpoints:peers.map(p=>p.url),authority};
  const before = {chainId,endpoints:[legacy.url]};
  for (const bundled of [true,false]) {
    const opts = {chainId,seeds:legacy.url,cacheDir:await cache(t),write:true};
    await assert.rejects(resolvePublicLedger({...opts,directory:bundled ? directory : before,
      refresh:bundled ? null : async()=>directory}),/No reachable writable/);
    await assert.rejects(resolvePublicLedger({...opts,directory:before,refresh:null}),/No reachable writable/);
  }
  const forged = structuredClone(authority);
  forged.signature = '0'.repeat(128);
  await assert.rejects(resolvePublicLedger({chainId,seeds:legacy.url,directory:{...directory,authority:forged},
    cacheDir:await cache(t),refresh:null}),/Invalid validator activation certificate/);
});
