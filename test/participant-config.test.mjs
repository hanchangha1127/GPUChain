import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { participantConfig } from '../src/participant-config.mjs';
import { execFileSync } from 'node:child_process';
import { generateWallet, sign, verify } from '../src/crypto.mjs';
import { windowsPowerShell } from '../src/private-file.mjs';
import { readRuntimeWallet } from '../src/runtime-wallet.mjs';

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

test('Windows participant migrates a legacy key atomically and reopens a current-user wallet',
  {skip:process.platform!=='win32'},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gpuchain-dpapi-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'validator.wallet.json'),original=generateWallet(),legacy=JSON.stringify(original);
  await writeFile(path,legacy);
  await assert.rejects(readRuntimeWallet(path,{migrate:true,expectedAddress:'f'.repeat(64)}),/identity/);
  assert.equal(await readFile(path,'utf8'),legacy);
  const {wallet}=await participantConfig(dir,{});
  assert.equal(wallet.address,original.address);
  assert.ok(verify(original.address,{test:'migrate'},sign(wallet.privateKey,{test:'migrate'})));
  const raw=await readFile(path,'utf8'),stored=JSON.parse(raw);
  assert.deepEqual(Object.keys(stored).sort(),['address','ciphertext','format','version']);
  assert.equal(stored.format,'gpuchain-windows-dpapi');
  assert.ok(!raw.includes(original.privateKey));
  const checkAcl=[
    '$acl=[IO.File]::GetAccessControl($env:GPUCHAIN_ACL_TEST)',
    '$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])',
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    'if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid) {exit 1}',
  ].join('\n');
  execFileSync(windowsPowerShell,['-NoProfile','-NonInteractive','-Command',checkAcl],{
    windowsHide:true,env:{...process.env,GPUCHAIN_ACL_TEST:path}});
  assert.equal((await participantConfig(dir,{})).wallet.address,original.address);
  assert.equal(await readFile(path,'utf8'),raw);
  const damaged=Buffer.from(stored.ciphertext,'base64');
  damaged[damaged.length-1]^=1;
  await writeFile(path,JSON.stringify({...stored,ciphertext:damaged.toString('base64')}));
  await assert.rejects(participantConfig(dir,{}),/Windows could not open/);
  assert.equal(JSON.parse(await readFile(path,'utf8')).ciphertext,damaged.toString('base64'));
});
