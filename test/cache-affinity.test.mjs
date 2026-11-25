import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affinityKeys, CACHE_AFFINITY_TTL_MS, openCacheAffinity } from '../src/cache-affinity.mjs';

const provider='c'.repeat(64);
const base={token:'private-test-token',payer:'a'.repeat(64),model:'test-model',
  messages:[{role:'user',content:'An unpublished test conversation'}]};

const scope=options=>affinityKeys({...base,...options});

test('affinity scopes distinguish models, payers, token rotations and explicit sessions',()=>{
  const [key]=scope().candidates;
  assert.match(key,/^[0-9a-f]{64}$/);
  for (const other of [{payer:'b'.repeat(64)},{token:'new-token'},{model:'other'},
      {session:base.messages[0].content},{reasoningEffort:'low'},
      {messages:[{role:'system',content:'Other system instruction'},...base.messages]},
      {chatOptions:{tools:[{type:'function',function:{name:'other'}}]}}]) {
    assert.ok(!scope(other).candidates.includes(key));
  }
  const longer=scope({messages:[...base.messages,{role:'user',content:'new'}]});
  assert.equal(longer.candidates.at(-1),key);
  assert.equal(longer.anchors[0],key);
  assert.notEqual(longer.candidates[0],key);
  assert.deepEqual(scope({session:'stable'}),scope({session:'stable',messages:[{role:'user',content:'Compacted history'}]}));
});

test('persistent affinity survives restart, evicts old entries and stores no prompt text or credentials',t=>{
  const dir=mkdtempSync(join(tmpdir(),'gpuchain-affinity-'));
  let affinity=openCacheAffinity(dir);
  t.after(()=>{affinity?.close(); rmSync(dir,{recursive:true,force:true});});
  const conversation=scope(), session='sensitive-test-session-id';
  const named=scope({session});
  affinity.remember(conversation.anchors,provider);
  affinity.remember(named.anchors,provider);
  affinity.close();
  affinity=openCacheAffinity(dir);
  assert.equal(affinity.preferred(conversation.candidates),provider);
  assert.equal(affinity.preferred(named.candidates),provider);
  for (const name of readdirSync(dir)) {
    const bytes=readFileSync(join(dir,name));
    for (const sensitive of [base.messages[0].content,base.token,session]) assert.equal(bytes.includes(sensitive),false);
  }
  for (let i=0;i<255;i++) affinity.remember(scope({session:String(i)}).anchors,provider);
  assert.equal(affinity.preferred(conversation.candidates),undefined);
  assert.equal(affinity.preferred(named.candidates),provider);
});

test('longest retained prefix wins over a newer shorter prefix and expires after 60 minutes',t=>{
  let clock=Date.UTC(2026,0,1);
  const affinity=openCacheAffinity(undefined,{now:()=>clock});
  t.after(()=>affinity.close());
  const supply='d'.repeat(64);
  const assistant={role:'assistant',content:'Starting answer'};
  const question=content=>({role:'user',content});
  const branch=[...base.messages,assistant,question('First branch')];
  const original=scope({messages:branch});
  affinity.remember(original.anchors,provider);
  clock+=10;
  const alternate=scope({messages:[...base.messages,assistant,question('Second branch')]});
  affinity.remember(alternate.anchors,supply);
  const followup=scope({messages:[...branch,assistant,question('Follow-up')]});
  clock+=CACHE_AFFINITY_TTL_MS-11;
  assert.equal(CACHE_AFFINITY_TTL_MS,60*60*1000);
  assert.equal(affinity.preferred(followup.candidates),provider);
  clock++;
  assert.equal(affinity.preferred(followup.candidates),supply);
  clock+=10;
  assert.equal(affinity.preferred(followup.candidates),undefined);
});
