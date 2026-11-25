import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocal } from '../scripts/bootstrap.mjs';
import { generateWallet, sign } from '../src/crypto.mjs';
import { readRuntimeWallet } from '../src/runtime-wallet.mjs';
import { NANOCOINS } from '../src/ledger.mjs';
import { readVerifiedState } from '../src/node.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gpuchain-bootstrap-test-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return dir;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

function stopServer(server) {
  return new Promise(resolve => server.close(resolve));
}

test('bootstrap completes partially initialized wallets, verifies live model, and resumes a funded ledger', async t => {
  const dir = await directory(t);
  const user = generateWallet();
  await writeFile(join(dir, 'user.json'), JSON.stringify(user));
  const modelId = 'qwen3.8-flash-next-iq3_xxs';
  const backend = createServer((req, res) => {
    if (req.url === '/metrics') return res.end(JSON.stringify({engine:{model:modelId,max_context:262144,kv:'int8',gen:1},live:{}}));
    if (req.url !== '/v1/models') return res.writeHead(404).end();
    res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({data:[
      {id:modelId, status:{value:'loaded'}, context_length:262_144}
    ]}));
  });
  const strataUrl = await listen(backend);
  const config = {dir, modelId, strataUrl, nodePort:0, providerPort:0};
  let app;
  try {
    app = await startLocal(config);
    const first = app.info;
    assert.ok(first.ledgerReady && first.providerReady);
    assert.equal(first.userAddress, user.address);
    assert.ok(!JSON.stringify(first).includes(user.privateKey));
    const discovered = await readVerifiedState(first.ledgerUrl, first.chainId);
    assert.equal(discovered.providerEndpoints[first.providerAddress], first.providerUrl);
    await assert.rejects(() => startLocal(config), /Another GPUChain bootstrap/);
    const p = {type:'transfer', from:user.address, to:first.providerAddress, nonce:1,
      chainId:first.chainId, amount:42};
    const res = await fetch(first.ledgerUrl + '/v1/transactions', {method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({payload:p, signature:sign(user.privateKey, p)})});
    assert.equal(res.status, 201);
    const files = ['sequencer.json', 'provider.json', 'user.json', 'genesis.json'];
    const contents = () => Promise.all(files.map(file => readFile(join(dir,file),'utf8')));
    const originals = await contents();
    await app.close();
    await app.close();
    app = await startLocal(config);
    assert.equal(app.info.chainId, first.chainId);
    assert.deepEqual(await contents(), originals);
    const state = await readVerifiedState(app.info.ledgerUrl, first.chainId);
    assert.equal(state.providerEndpoints[first.providerAddress], app.info.providerUrl);
    assert.equal(state.balances[user.address], NANOCOINS - 42);
    assert.equal(state.balances[first.providerAddress], 42);
  } finally {
    await app?.close();
    await stopServer(backend);
  }
});

test('bootstrap endpoint registration is idempotent and preserves operator changes', async t => {
  const dir = await directory(t);
  const offline = createServer((_req, res) => res.writeHead(503).end());
  const strataUrl = await listen(offline);
  let app;
  try {
    const config = {dir, strataUrl, nodePort: 0, providerPort: 0};
    app = await startLocal(config);
    const {providerAddress, providerUrl, chainId} = app.info;
    config.providerPort = Number(new URL(providerUrl).port);
    const wallet = await readRuntimeWallet(join(dir, 'sequencer.json'));
    const read = () => readVerifiedState(app.info.ledgerUrl, chainId);
    let state = await read();
    const height = state.height;
    await app.close();
    app = await startLocal(config);
    assert.equal((await read()).height, height);
    for (const endpoint of ['https://registered.example', null]) {
      const payload = {type:'set-provider-endpoint', chainId, from:wallet.address,
        nonce:state.nonces[wallet.address] + 1, provider:providerAddress, endpoint};
      const res = await fetch(app.info.ledgerUrl + '/v1/transactions', {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({payload, signature:sign(wallet.privateKey, payload)})
      });
      assert.equal(res.status, 201);
      await res.json();
      await app.close();
      app = await startLocal(config);
      state = await read();
      assert.equal(state.providerEndpoints?.[providerAddress] ?? null, endpoint);
      assert.equal(state.nonces[wallet.address], payload.nonce);
    }
  } finally {
    await app?.close();
    await stopServer(offline);
  }
});

test('offline Strata gives actionable readiness and initialization rejects missing or swapped files', async t => {
  const dir = await directory(t);
  const offline = createServer();
  const strataUrl = await listen(offline);
  await stopServer(offline);
  const config = {dir, strataUrl, nodePort:0, providerPort:0};
  const app = await startLocal(config);
  try {
    assert.equal(app.info.ledgerReady, true);
    assert.equal(app.info.providerReady, false);
    assert.match(app.info.providerDetail, /262144.*\/v1\/info/);
  } finally { await app.close(); }
  const user = join(dir, 'user.json');
  await rename(user, user + '.bak');
  await assert.rejects(() => startLocal(config), /Restore the missing user wallet/);
  await writeFile(user, JSON.stringify(generateWallet()));
  await assert.rejects(() => startLocal(config), /do not match/);
  await rm(user);
  await rename(user + '.bak', user);
  const db = join(dir, 'ledger', 'ledger.sqlite');
  await rename(db, db + '.bak');
  await assert.rejects(() => startLocal(config), /Restore the matching genesis and ledger/);
  await assert.rejects(() => readFile(db), {code:'ENOENT'});
  await rename(db + '.bak', db);
  const genesis = join(dir, 'genesis.json');
  await rename(genesis, genesis + '.bak');
  await assert.rejects(() => startLocal(config), /Restore the matching genesis and ledger/);
  await assert.rejects(() => readFile(genesis), {code:'ENOENT'});
});

test('provider port collision releases the ledger listener and initialization lock for a retry', async t => {
  const dir = await directory(t);
  const occupied = createServer((_req, res) => res.writeHead(503).end());
  const strataUrl = await listen(occupied);
  const providerPort = occupied.address().port;
  const reserve = createServer();
  await listen(reserve);
  const nodePort = reserve.address().port;
  await stopServer(reserve);
  let app;
  try {
    await assert.rejects(() => startLocal({dir, nodePort, providerPort, strataUrl}), {code:'EADDRINUSE'});
    app = await startLocal({dir, nodePort, providerPort:0, strataUrl});
    assert.equal(app.info.ledgerUrl, 'http://127.0.0.1:' + nodePort);
  } finally {
    await app?.close();
    await stopServer(occupied);
  }
});
