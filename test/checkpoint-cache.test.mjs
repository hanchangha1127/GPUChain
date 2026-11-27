import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkpointETag, checkpointHttp } from '../src/checkpoint.mjs';
import { createCheckpointReader } from '../src/checkpoint-fetch.mjs';
import { activateCheckpoint, createActivation } from '../src/consensus.mjs';
import { generateWallet } from '../src/crypto.mjs';
import { createGenesis, replay } from '../src/ledger.mjs';
import { resolvePublicLedger } from '../src/public-network.mjs';

function fixture() {
  const signer=generateWallet();
  const voters=Array.from({length:3},generateWallet);
  const genesis=createGenesis(signer,{allocations:{[signer.address]:10},providers:voters.map(w=>w.address)});
  const head={genesis,state:replay([genesis]),epochHashes:[],signature:null};
  const members=voters.map((w,i)=>({address:w.address,url:'https://validator'+i+'.example',instanceId:randomUUID()}));
  return {head,pivot:activateCheckpoint(head,createActivation(head,members,signer))};
}

async function peer(t,head) {
  const p={head,requests:[],mode:'normal'};
  const server=createServer((req,res)=>{
    if (req.url==='/v1/status') return res.end(JSON.stringify({chainId:p.head.genesis.hash,
      mode:'sequencer',height:p.head.state.height,tip:p.head.state.tip}));
    const condition=req.headers['if-none-match'];
    const reply=checkpointHttp(p.head,condition);
    if (p.mode==='wrong304' && condition) reply.headers.etag='"unrelated"';
    if (p.mode==='legacy') {
      delete reply.headers.etag;
      reply.status=200;
      reply.body=JSON.stringify(p.head);
    }
    p.requests.push({condition,status:reply.status});
    res.writeHead(reply.status,reply.headers).end(reply.body);
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  p.url='http://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return p;
}

test('conditional reads bind complete verified envelopes to each origin and periodically refresh in full',async t=>{
  const {head,pivot}=fixture();
  const a=await peer(t,head),b=await peer(t,head), chainId=head.genesis.hash;
  let now=0;
  const read=createCheckpointReader({now:()=>now});
  const result=await read(a.url,chainId);
  result.state.height=999;
  assert.deepEqual(await read(a.url,chainId),head);
  assert.deepEqual(a.requests.map(q=>q.status),[200,304]);
  assert.equal(a.requests[1].condition,checkpointETag(head));
  await read(b.url,chainId);
  assert.equal(b.requests[0].condition,undefined);

  a.mode='wrong304';
  await read(a.url,chainId);
  assert.deepEqual(a.requests.slice(-2).map(q=>q.status),[304,200]);
  assert.equal(a.requests.at(-1).condition,undefined);

  a.mode='normal';
  a.head=pivot;
  assert.equal(pivot.state.tip,head.state.tip);
  assert.deepEqual(await read(a.url,chainId),pivot);
  assert.equal(a.requests.at(-1).status,200);
  assert.notEqual(checkpointETag(head),checkpointETag(pivot));
  assert.deepEqual(await read(a.url,chainId),pivot);
  assert.equal(a.requests.at(-1).status,304);

  now+=3600_000;
  await read(a.url,chainId);
  assert.equal(a.requests.at(-1).condition,undefined);
  await assert.rejects(read(a.url,'a'.repeat(64)));
  assert.equal(a.requests.at(-1).condition,undefined);

  a.mode='legacy';
  await read(a.url,chainId);
  await read(a.url,chainId);
  assert.equal(a.requests.at(-1).condition,undefined);
  a.head={...pivot,authority:{...pivot.authority,signature:'0'.repeat(128)}};
  await assert.rejects(read(a.url,chainId));
});

test('repeated public discovery polls get 304 through the normal verifier path',async t=>{
  const {head}=fixture(), p=await peer(t,head);
  const cacheDir=await mkdtemp(join(tmpdir(),'gpuchain-revalidation-'));
  t.after(()=>rm(cacheDir,{recursive:true,force:true}));
  const chainId=head.genesis.hash;
  const options={chainId,cacheDir,seeds:'',refresh:null,directory:{chainId,endpoints:[p.url]}};
  assert.deepEqual((await resolvePublicLedger(options)).checkpoint,head);
  assert.deepEqual((await resolvePublicLedger(options)).checkpoint,head);
  assert.deepEqual(p.requests.map(q=>q.status),[200,304]);
});
