import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateWallet, sign, verify } from '../src/crypto.mjs';
import { readRuntimeWallet, writeRuntimeWallet } from '../src/runtime-wallet.mjs';
import { backupWallet, encryptWallet, parseWalletDocument, restoreWallet, verifyBackup } from '../src/wallet-backup.mjs';

test('portable imported wallet backup reopens on disk, restores exactly its original key and cannot overwrite',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuchain-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'src.json'),backup=join(dir,'portable.json'),restored=join(dir,'restored.json');
  const w=generateWallet(),password=randomBytes(24).toString('hex')+' 가나다';
  await writeRuntimeWallet(source,w);
  assert.equal((await backupWallet(source,backup,password)).address,w.address);
  const raw=await readFile(backup,'utf8'),doc=JSON.parse(raw);
  assert.ok(!raw.includes(w.privateKey));assert.equal(doc.header.origin,'imported-ed25519');assert.equal(doc.header.path,null);
  assert.deepEqual(await verifyBackup(backup,password.normalize('NFD'),w.address),{address:w.address,verified:true});
  await assert.rejects(verifyBackup(backup,'other password'),/Invalid password or damaged/);
  await assert.rejects(verifyBackup(backup,password,'f'.repeat(64)),/Unexpected backup address/);
  await restoreWallet(backup,restored,password,w.address);
  const r=await readRuntimeWallet(restored);
  assert.deepEqual(r,w);
  assert.ok(verify(w.address,{test:'restore'},sign(r.privateKey,{test:'restore'})));
  await assert.rejects(restoreWallet(backup,restored,password),/EEXIST/);
  assert.deepEqual(await readRuntimeWallet(restored),w);
  if (process.platform==='win32') assert.equal((await readFile(restored,'utf8')).includes(w.privateKey),false);
  await assert.rejects(backupWallet(source,backup,password),/EEXIST/);
  assert.equal(await readFile(backup,'utf8'),raw);
});

test('tampered headers, slots, KDF profiles and duplicate names fail closed',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuchain-backup-tamper-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'bad.json'),w=generateWallet(),pass='temporary-fixture';
  const a=await encryptWallet(w,pass),b=await encryptWallet(w,pass);
  assert.notEqual(a.kdf.salt,b.kdf.salt);assert.notEqual(a.signingKey.ciphertext,b.signingKey.ciphertext);
  for(const [change,pattern] of [
    [d=>{d.header.address='f'.repeat(64);},/Invalid password or damaged/],
    [d=>{d.signingKey=b.signingKey;},/Invalid password or damaged/],
    [d=>{d.kdf.N=2**24;},/KDF profile/],
    [d=>{d.signingKey.tag+='=';},/encoding/],
    [d=>{d.header.unexpected=true;},/fields/],
  ]) {
    const doc=structuredClone(a);change(doc);await writeFile(file,JSON.stringify(doc));
    await assert.rejects(verifyBackup(file,pass),pattern);
  }
  assert.throws(()=>parseWalletDocument('{"a":1,"\\u0061":2}'),/Duplicate/);
  assert.throws(()=>parseWalletDocument('"'+'x'.repeat(4096)+'"'),/4 KiB/);
  await assert.rejects(encryptWallet({...w,address:'0'.repeat(64)},pass),/mismatch/);
});
