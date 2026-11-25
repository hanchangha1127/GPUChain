import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { walletSpendCoordinator } from '../src/wallet-spend.mjs';

const chain='1'.repeat(64);
const address='2'.repeat(64);
const noPendingRead=async()=>assert.fail('A wallet without pending settlement should not fetch the ledger');

test('a second process waits for inference before spending and a crashed holder releases the wallet', {timeout:15_000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'gpuchain-spend-'));
  const moduleUrl=new URL('../src/wallet-spend.mjs',import.meta.url).href;
  const source=`
    import {walletSpendCoordinator} from ${JSON.stringify(moduleUrl)};
    const spends=walletSpendCoordinator(process.argv[1],process.argv[2],{root:process.argv[3]});
    await spends.run('inference',()=>{throw Error('unexpected lookup')},async()=>{
      process.stdout.write('locked');
      process.stdin.resume();
      await new Promise(resolve=>process.stdin.once('end',resolve));
    });`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,chain,address,root],
    {stdio:['pipe','pipe','inherit'],windowsHide:true});
  const exited=once(child,'exit');
  t.after(async()=>{
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await exited;
    await rm(root,{recursive:true,force:true,maxRetries:3});
  });
  await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw Error('Lock holder exited before signalling');})]);
  const buyer=walletSpendCoordinator(chain,address,{root});
  assert.equal(buyer.activity(),'inference');
  await assert.rejects(buyer.run('transaction',noPendingRead,()=>assert.fail(),{waitMs:0}),{code:'WALLET_BUSY'});
  const another=walletSpendCoordinator(chain,'3'.repeat(64),{root});
  await another.run('transaction',noPendingRead,()=>assert.equal(another.activity(),'transaction'));
  const next=buyer.run('transaction',noPendingRead,()=>assert.equal(buyer.activity(),'transaction'));
  child.kill();
  await exited;
  await next;
  assert.equal(buyer.activity(),null);
});
