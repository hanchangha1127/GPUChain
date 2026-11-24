import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affinityDigest, openCacheAffinity } from '../src/cache-affinity.mjs';

const provider='c'.repeat(64);
const base={token:'private-test-token',payer:'a'.repeat(64),model:'test-model',
  messages:[{role:'user',content:'An unpublished test conversation'}]};

test('affinity digests distinguish models, payers, token rotations and explicit sessions',()=>{
  const key=affinityDigest(base);
  assert.match(key,/^[0-9a-f]{64}$/);
  for (const other of [{payer:'b'.repeat(64)},{token:'new-token'},{model:'other'},
      {session:base.messages[0].content}]) {
    assert.notEqual(affinityDigest({...base,...other}),key);
  }
  assert.equal(affinityDigest({...base,messages:[...base.messages,{role:'user',content:'new'}]}),key);
});

test('persistent affinity survives restart, evicts old entries and stores no prompt text or credentials',t=>{
  const dir=mkdtempSync(join(tmpdir(),'gpuchain-affinity-'));
  let affinity=openCacheAffinity(dir);
  t.after(()=>{affinity?.close(); rmSync(dir,{recursive:true,force:true});});
  const key=affinityDigest(base), session='sensitive-test-session-id';
  const sessionKey=affinityDigest({...base,session});
  affinity.remember(key,provider);
  affinity.remember(sessionKey,provider);
  affinity.close();
  affinity=openCacheAffinity(dir);
  assert.equal(affinity.preferred(key),provider);
  assert.equal(affinity.preferred(sessionKey),provider);
  for (const name of readdirSync(dir)) {
    const bytes=readFileSync(join(dir,name));
    for (const sensitive of [base.messages[0].content,base.token,session]) assert.equal(bytes.includes(sensitive),false);
  }
  for (let i=0;i<255;i++) affinity.remember(affinityDigest({...base,session:String(i)}),provider);
  assert.equal(affinity.preferred(key),undefined);
  assert.equal(affinity.preferred(sessionKey),provider);
});
