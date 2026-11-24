import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { participantConfig } from '../src/participant-config.mjs';
import { generateWallet } from '../src/crypto.mjs';

test('concurrent participant setup reuses one identity; an existing installation refuses missing or swapped keys',async t=>{
  const dir = await mkdtemp(join(tmpdir(),'gpuchain-identity-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const [a,b] = await Promise.all([participantConfig(dir,{}),participantConfig(dir,{})]);
  assert.equal(a.wallet.address,b.wallet.address);
  assert.equal(a.port,8790);
  assert.equal(a.origin,undefined);
  await participantConfig(dir,{GPUCHAIN_VALIDATOR_ORIGIN:'https://voter.example/',GPUCHAIN_VALIDATOR_PORT:'9991'});
  const reopened = await participantConfig(dir,{});
  assert.equal(reopened.origin,'https://voter.example');
  assert.equal(reopened.port,9991);
  await assert.rejects(participantConfig(dir,{GPUCHAIN_VALIDATOR_ORIGIN:'http://localhost:1234'}),/public HTTPS/);
  const {walletFile} = JSON.parse(await readFile(join(dir,'participant.json'),'utf8'));
  await unlink(walletFile);
  await assert.rejects(participantConfig(dir,{}),/Restore/);
  await writeFile(walletFile,JSON.stringify(generateWallet()));
  await assert.rejects(participantConfig(dir,{}),/identity/);
});
