import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs',import.meta.url));

test('CLI settles a Strata completion, transfers credits, verifies a follower and rejects a modified response', {timeout:60_000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'gpuchain-e2e-'));
  const children = [];
  const servers = [];
  const model = 'qwen3.8-flash-next-q2_0';
  let requests = 0;
  const run = async (...args) => {
    const {stdout} = await exec(process.execPath,[cli,...args],{cwd:dir,windowsHide:true,timeout:10_000});
    return JSON.parse(stdout);
  };
  async function startProcess(...args) {
    const child = spawn(process.execPath,[cli,...args],{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe']});
    children.push(child);
    let error = '';
    child.stderr.on('data',chunk => { error += chunk; });
    const lines = createInterface({input:child.stdout});
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('Server startup timed out: ' + error)),8_000);
      lines.once('line',line => {
        clearTimeout(timer);
        try { resolve(JSON.parse(line).url); } catch (e) { reject(e); }
      });
      child.once('error',e => { clearTimeout(timer); reject(e); });
      child.once('exit',() => { clearTimeout(timer); reject(Error('Server exited: ' + error)); });
    });
  }
  async function serve(handler) {
    const server = createServer(async (req,res) => {
      try {
        let body = '';
        for await (const part of req) body += part;
        const obj = await handler(req.url,body ? JSON.parse(body) : undefined);
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify(obj));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({error:e.message}));
      }
    });
    servers.push(server);
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  try {
    const {address:seq} = await run('wallet','--out','seq.json');
    const {address:user} = await run('wallet','--out','user.json');
    const {address:provider} = await run('wallet','--out','provider.json');
    await assert.rejects(run('wallet','--out','seq.json'),/EEXIST/);
    const {chainId} = await run('genesis','--out','genesis.json','--wallet','seq.json',
      '--allocation',user+'=1');
    const gen = ['--genesis','genesis.json'];
    const ledger = await startProcess('node',...gen,'--dir','node','--wallet','seq.json','--port','0');
    const common = [...gen,'--ledger',ledger];
    const register = ['add-provider',...common,'--address',provider,'--wallet'];
    await assert.rejects(run(...register,'user.json'),/Only the sequencer/);
    await run(...register,'seq.json');
    await assert.rejects(run(...register,'seq.json'),/already registered/);
    const strata = await serve((path,body) => {
      if (path === '/v1/models') return {data:[{id:model,status:{value:'loaded'},context_length:262144}]};
      if (path === '/v1/messages/count_tokens') return {input_tokens:64};
      assert.equal(path,'/v1/chat/completions');
      assert.equal(body.messages[0].content,'hello');
      assert.equal(body.model,model);
      requests++;
      return {model, choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'answer'}}],
        usage:{prompt_tokens:64,completion_tokens:10,total_tokens:74,prompt_tokens_details:{cached_tokens:32}}};
    });
    const worker = await startProcess('provider',...common,'--wallet','provider.json','--strata',strata+'/v1','--port','0');
    const chat = ['chat',...common,'--wallet','user.json','--provider-address',provider,'--text','hello',
      '--max-input','80','--max-output','12','--provider-url'];
    const result = await run(...chat,worker);
    assert.equal(result.message.content,'answer');
    assert.equal(result.coins,'0.000010012');
    assert.equal(result.settlement.height,2);
    assert.equal(requests,1);
    const getBalance = async addr => (await run('balance',...common,'--address',addr)).coins;
    assert.equal(await getBalance(provider),'0.000010012');
    assert.equal(await getBalance(user),'0.999989988');
    const status = await run('status',...common);
    assert.equal(status.epochTokens,42);
    assert.equal(status.chainId,chainId);
    await run('transfer',...common,'--wallet','user.json','--to',seq,'--coins','0.1');
    assert.equal(await getBalance(seq),'0.1');
    await run('settings',...common,'--wallet','seq.json','--max-output','8192');
    const primary = await run('verify',...common);
    assert.equal(primary.height,4);
    const follower = await startProcess('follower',...gen,'--upstream',ledger,'--dir','follower','--port','0','--sync-ms','100');
    let replica;
    for (let i=0;i<20;i++) {
      replica = await run('verify',...gen,'--ledger',follower);
      if (replica.tip === primary.tip) break;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.deepEqual(replica,primary);

    // An intermediary alters the assistant answer after the real provider signed its receipt.
    const alteringProxy = await serve(async (path,body) => {
      const res = await fetch(worker + path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      assert.ok(res.ok);
      const reply = await res.json();
      reply.message.content = 'different answer';
      return reply;
    });
    await assert.rejects(run(...chat,alteringProxy),/Invalid provider receipt/);
    assert.deepEqual(await run('verify',...common),primary);
    assert.equal(requests,2);

    await t.test('automatic chat pays the lowest-latency ready provider and switches when it goes offline', async () => {
      const {address:buyer} = await run('wallet','--out','routing-buyer.json');
      await run('transfer',...common,'--wallet','seq.json','--to',buyer,'--coins','0.01');
      const {address:slow} = await run('wallet','--out','slow.json');
      const slowWorker = await startProcess('provider',...common,'--wallet','slow.json',
        '--strata',strata+'/v1','--port','0');
      const calls = {fast:0, slow:0};
      let fastOnline = true;
      async function gateway(name, workerUrl, delay) {
        return serve(async (path, body) => {
          if (name === 'fast' && !fastOnline) throw Error('Provider offline');
          if (path.startsWith('/v1/probe?')) {
            assert.equal(body,undefined);
            if (delay) await new Promise(resolve => setTimeout(resolve,delay));
          } else {
            assert.equal(path,'/v1/infer');
            calls[name]++;
          }
          const options = body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {};
          const response = await fetch(workerUrl + path,options);
          assert.ok(response.ok);
          return response.json();
        });
      }
      const fastUrl = await gateway('fast',worker,0);
      const slowUrl = await gateway('slow',slowWorker,120);
      const edit = ['set-provider-endpoint',...common,'--wallet','seq.json'];
      await run('add-provider',...common,'--wallet','seq.json','--address',slow,'--url',slowUrl);
      await run(...edit,'--address',provider,'--url',fastUrl);
      const ranking = await run('routes',...common);
      assert.deepEqual(ranking.providers.map(p => p.provider),[provider,slow]);
      assert.ok(ranking.providers[0].latencyMs < ranking.providers[1].latencyMs);
      assert.deepEqual(calls,{fast:0,slow:0});
      const automatic = ['chat',...common,'--wallet','routing-buyer.json','--text','hello',
        '--max-input','80','--max-output','12'];
      const first = await run(...automatic);
      assert.equal(first.provider,provider);
      assert.equal(first.providerUrl,fastUrl);
      assert.deepEqual(calls,{fast:1,slow:0});
      assert.equal(await getBalance(provider),'0.000020024');
      assert.equal(await getBalance(slow),'0');
      fastOnline = false;
      const second = await run(...automatic);
      assert.equal(second.provider,slow);
      assert.equal(second.providerUrl,slowUrl);
      assert.deepEqual(calls,{fast:1,slow:1});
      assert.equal(await getBalance(slow),'0.000010012');
      assert.equal(await getBalance(buyer),'0.009979976');
      await run(...edit,'--address',slow,'--withdraw');
      assert.deepEqual((await run('routes',...common)).providers,[]);
      await assert.rejects(run(...automatic));
      assert.deepEqual(calls,{fast:1,slow:1});
    });
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child,'exit');
      child.kill();
      await done;
    }));
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
