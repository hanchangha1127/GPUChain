import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(),'gpuchain-process-'));
  const scripts = join(root,'scripts');
  const data = join(root,'data');
  await mkdir(scripts);
  await mkdir(join(root,'src'));
  const entry = join(scripts,'participant.mjs');
  await cp(new URL('../scripts/participant.mjs',import.meta.url),entry);
  await cp(new URL('../src/http.mjs',import.meta.url),join(root,'src/http.mjs'));
  await cp(new URL('../src/private-file.mjs',import.meta.url),join(root,'src/private-file.mjs'));
  await writeFile(join(root,'src/participant-config.mjs'),
    'export const participantDir = () => process.env.GPUCHAIN_PARTICIPANT_DIR;');
  await writeFile(join(scripts,'participate.mjs'),`
    import {createServer} from 'node:http';
    import {once} from 'node:events';
    export async function startParticipant() {
      const s=createServer((_req,res)=>{
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({chainId:'test-chain',address:'test-address',instanceId:'test-db',verified:true,mode:'verifier'}));
      });
      s.listen(0,'127.0.0.1');
      await once(s,'listening');
      let openAiUrl=null;
      return {url:'http://127.0.0.1:'+s.address().port,issueUnlock:()=>({code:'0123456789',expiresAt:Date.now()+120000}),
        get openAiUrl(){ return openAiUrl; },enableOpenAi:async()=>openAiUrl='http://127.0.0.1:8792/v1',
        close:()=>new Promise(r=>s.close(r))};
    }
  `);
  async function run(...args) {
    const {stdout} = await exec(process.execPath,[entry,...args],{
      cwd:root,env:{...process.env,GPUCHAIN_PARTICIPANT_DIR:data},timeout:12_000,windowsHide:true
    });
    return JSON.parse(stdout);
  }
  t.after(async()=>{
    try { await run('stop'); }
    finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });
  return {run,data};
}

test('background command outlives the launcher, serializes concurrent starts and shuts down only its own node',async t=>{
  const {run,data} = await setup(t);
  assert.deepEqual(await run('status'),{running:false});
  const [a,b,c] = await Promise.all([run(),run('start'),run('start')]);
  assert.deepEqual([a.pid,b.pid],[c.pid,c.pid]);
  const status = await run('status');
  assert.equal(status.pid,a.pid);
  assert.equal(status.verified,true);
  assert.equal(status.mode,'verifier');
  const privateDescriptor = JSON.parse(await readFile(join(data,'process.json'),'utf8'));
  assert.ok(!JSON.stringify(status).includes(privateDescriptor.key));
  const denied = await fetch('http://127.0.0.1:'+privateDescriptor.port+'/stop',{method:'POST'});
  assert.equal(denied.status,403);
  const deniedUnlock = await fetch('http://127.0.0.1:'+privateDescriptor.port+'/unlock',{method:'POST'});
  assert.equal(deniedUnlock.status,403);
  assert.equal((await fetch('http://127.0.0.1:'+privateDescriptor.port+'/opencode',{method:'POST'})).status,403);
  assert.equal(status.openAiUrl,null);
  const gateway=await run('opencode');
  assert.equal(gateway.openAiUrl,'http://127.0.0.1:8792/v1');
  assert.equal((await run('status')).openAiUrl,gateway.openAiUrl);
  const pairing=await run('unlock');
  assert.match(pairing.code,/^[0-9]{10}$/);
  assert.ok(!JSON.stringify(await run('status')).includes(pairing.code));
  assert.equal((await run('status')).running,true);
  assert.deepEqual(await run('stop'),{running:false});
  assert.equal((await run('status')).running,false);
  await assert.rejects(fetch(a.url+'/v1/status'));
  // A stale marker can name an unrelated PID. No stop path signals that PID.
  await writeFile(join(data,'process.json'),JSON.stringify({...privateDescriptor,pid:process.pid}));
  assert.deepEqual(await run('stop'),{running:false});
  const restarted = await run('start');
  assert.equal(restarted.running,true);
  assert.equal(restarted.instanceId,a.instanceId);
  assert.notEqual(restarted.pid,process.pid);
});

test('abrupt loss releases the lifetime lock and a fresh start replaces stale control state',async t=>{
  const {run,data} = await setup(t);
  const node = await run('start');
  const before = JSON.parse(await readFile(join(data,'process.json'),'utf8'));
  assert.equal(before.pid,node.pid);
  // Only the daemon spawned by this test uses this isolated directory.
  process.kill(node.pid,'SIGKILL');
  for (let i=0;i<20 && (await run('status')).running;i++) await delay(50);
  assert.deepEqual(await run('status'),{running:false});
  const next = await run('start');
  assert.equal(next.running,true);
  const after = JSON.parse(await readFile(join(data,'process.json'),'utf8'));
  assert.notEqual(before.key,after.key);
});
