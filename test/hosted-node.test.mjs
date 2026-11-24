import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { createGenesis, verifyBlock, MODEL, CONTEXT } from '../src/ledger.mjs';
import { readVerifiedState } from '../src/node.mjs';
import worker from '../hosting/sites/worker.mjs';

// Exercise the D1 statements against SQLite. Separate asynchronous calls permit
// competing Worker requests to read the same tip before a conditional update.
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE ledger_head (id INTEGER PRIMARY KEY, tip TEXT NOT NULL, checkpoint TEXT NOT NULL)');
  const db = {
    withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) ?? null; },
        async run() { return {meta:{changes:statement.run(...args).changes}}; }
      };
    }
  };
  const seq = generateWallet(), payer = generateWallet(), provider = generateWallet();
  const genesis = createGenesis(seq, {allocations:{[payer.address]:1_000_000_000}, providers:[provider.address]});
  const env = {DB:db, GPUCHAIN_GENESIS_JSON:JSON.stringify(genesis), GPUCHAIN_SIGNER_PKCS8:seq.privateKey};
  const request = (path, init) => worker.fetch(new Request('https://test.invalid' + path, init), env);
  const submit = payload => request('/v1/transactions', {method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify(payload)});
  return {sqlite, seq, payer, provider, genesis, env, request, submit};
}

test('hosted sequencer settles once under concurrent submissions and serves a native-client checkpoint', async t => {
  const {sqlite, payer, provider, genesis, request, submit} = fixture(t);
  assert.deepEqual(await (await request('/v1/genesis')).json(), genesis);
  const payload = {type:'inference', chainId:genesis.hash, from:payer.address, provider:provider.address, nonce:1,
    model:MODEL, contextWindow:CONTEXT, requestHash:hash('request'), responseHash:hash('content'),
    inputTokens:64, cachedTokens:32, outputTokens:10};
  const tx = {payload, signature:sign(payer.privateKey, payload), providerSignature:sign(provider.privateKey, payload)};
  const results = await Promise.all([submit(tx), submit(tx)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const accepted = await results.find(r => r.status === 201).json();
  assert.ok(verifyBlock(accepted.block, genesis.payload.sequencer));
  assert.equal((await submit(tx)).status, 400);
  const checkpointText = sqlite.prepare('SELECT checkpoint FROM ledger_head').get().checkpoint;
  for (const transient of [tx.signature, tx.providerSignature, payload.requestHash, payload.responseHash]) {
    assert.ok(!checkpointText.includes(transient));
  }
  const server = createServer(async (req, res) => {
    const reply = await request(req.url);
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(await reply.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const state = await readVerifiedState('http://127.0.0.1:' + server.address().port, genesis.hash);
  assert.equal(state.height, 1);
  assert.equal(state.balances[provider.address], 10012);
  assert.equal(state.epochTokens, 42);
  assert.equal((await (await request('/v1/status')).json()).inference, false);
  assert.match(await (await request('/')).text(), /GPUChain ledger/);
});

test('hosted sequencer rejects a bad signer, wrong network, invalid writes and corrupted persisted state', async t => {
  const {sqlite, env, payer, genesis, request, submit} = fixture(t);
  assert.equal((await request('/v1/infer', {method:'POST'})).status, 404);
  assert.equal((await request('/v1/transactions', {method:'POST', body:'{}'})).status, 415);
  assert.equal((await request('/v1/transactions', {method:'POST', body:'x'.repeat(16_385),
    headers:{'content-type':'application/json'}})).status, 413);
  assert.equal((await submit({})).status, 400);
  const initiator = env.GPUCHAIN_SIGNER_PKCS8;
  env.GPUCHAIN_SIGNER_PKCS8 = payer.privateKey;
  assert.equal((await request('/v1/checkpoint')).status, 503);
  env.GPUCHAIN_SIGNER_PKCS8 = initiator;
  const checkpoint = await (await request('/v1/checkpoint')).json();
  assert.equal(checkpoint.genesis.hash, genesis.hash);
  const different = generateWallet();
  env.GPUCHAIN_SIGNER_PKCS8 = different.privateKey;
  env.GPUCHAIN_GENESIS_JSON = JSON.stringify(createGenesis(different, {allocations:{}, providers:[]}));
  assert.equal((await request('/v1/status')).status, 503);
  env.GPUCHAIN_SIGNER_PKCS8 = initiator;
  env.GPUCHAIN_GENESIS_JSON = JSON.stringify(genesis);
  checkpoint.state.height = 8;
  sqlite.prepare('UPDATE ledger_head SET checkpoint=?').run(JSON.stringify(checkpoint));
  assert.equal((await request('/v1/checkpoint')).status, 503);
});
