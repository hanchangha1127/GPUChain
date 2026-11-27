import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { createGenesis, verifyBlock, MODEL, CONTEXT } from '../src/ledger.mjs';
import { readVerifiedState } from '../src/node.mjs';
import worker, { createLedgerWorker } from '../hosting/sites/worker.mjs';
import { authenticate } from '../src/checkpoint.mjs';
import { verifyOutcome } from '../src/transaction-outcome.mjs';
import { signEnrollment } from '../src/enrollment.mjs';

// Exercise the D1 statements against SQLite. Separate asynchronous calls permit
// competing Worker requests to read the same tip before a conditional update.
function fixture(t, extraProviders = [], handler = worker) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE ledger_head (id INTEGER PRIMARY KEY, tip TEXT NOT NULL, checkpoint TEXT NOT NULL)');
  const db = {
    withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    batch(statements) {
      sqlite.exec('BEGIN');
      try { const rows=statements.map(s=>s.run()); sqlite.exec('COMMIT'); return rows; }
      catch(error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) ?? null; },
        run() { return {meta:{changes:statement.run(...args).changes}}; }
      };
    }
  };
  const seq = generateWallet(), payer = generateWallet(), provider = generateWallet();
  const genesis = createGenesis(seq, {allocations:{[payer.address]:1_000_000_000}, providers:[provider.address,...extraProviders]});
  const env = {DB:db, GPUCHAIN_GENESIS_JSON:JSON.stringify(genesis), GPUCHAIN_SIGNER_PKCS8:seq.privateKey};
  const request = (path, init) => handler.fetch(new Request('https://test.invalid' + path, init), env);
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
  const outcome=await (await request('/v1/transaction-outcomes/'+hash(tx))).json();
  assert.deepEqual(verifyOutcome(outcome,tx,JSON.parse(checkpointText)),{height:1,hash:accepted.block.hash});
  assert.equal((await request('/v1/transaction-outcomes/'+hash('missing'))).status,404);
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
  const fresh=await request('/v1/checkpoint');
  const etag=fresh.headers.get('etag');
  assert.ok(etag);
  const same=await request('/v1/checkpoint',{headers:{'if-none-match':etag}});
  assert.equal(same.status,304);
  assert.equal(same.headers.get('etag'),etag);
  assert.equal(await same.text(),'');
  assert.equal(state.height, 1);
  assert.equal(state.balances[provider.address], 10012);
  assert.equal(state.epochTokens, 42);
  assert.equal((await (await request('/v1/status')).json()).inference, false);
  assert.match(await (await request('/ledger')).text(), /GPUChain ledger/);
  assert.match(await (await request('/')).text(), /USDT/);
});

test('hosted enrollment requires three live approved owners and commits one final pivot against the exact tip', {timeout:10_000}, async t => {
  const members = Array.from({length:4}, () => generateWallet());
  const urls = members.map((_,i) => 'https://validator'+i+'.example.org');
  const ids = members.map(() => globalThis.crypto.randomUUID());
  const unreachable = new Set();
  const calls = new Set();
  let wrongKey = false;
  let holdMember;
  let published = [];
  const handler = createLedgerWorker({readDirectory:async () => ({chainId:genesis.hash,endpoints:published}),async fetchReady(raw) {
    const url = new URL(raw);
    assert.equal(url.pathname,'/v1/consensus/ready');
    const i = urls.indexOf(url.origin), challenge = url.searchParams.get('challenge');
    assert.match(challenge,/^[a-f0-9]{32}$/);
    assert.equal(calls.has(challenge),false);
    calls.add(challenge);
    if (i < 0 || unreachable.has(i)) return new Response('',{status:503});
    if (holdMember?.i === i) {
      const barrier = holdMember;
      holdMember = null;
      barrier.started.resolve();
      await barrier.release.promise;
    }
    const payload = {domain:'gpuchain/validator-ready/v1',chainId:genesis.hash,address:members[i].address,
      origin:urls[i],instanceId:ids[i],challenge};
    return Response.json({payload,signature:sign(members[wrongKey ? (i+1)%members.length : i].privateKey,payload)});
  }});
  const {genesis,request,seq,payer,sqlite,submit} = fixture(t,members.slice(1).map(m=>m.address),handler);
  const intent = (i,at) => signEnrollment(genesis.hash,members[i],urls[i],ids[i],at);
  const propose = body => request('/v1/consensus/enroll',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await propose(signEnrollment(genesis.hash,payer,urls[0],ids[0]))).status,400);
  assert.equal((await propose(intent(0))).status,400);
  const permission = {type:'add-validator',chainId:genesis.hash,from:seq.address,nonce:1,validator:members[0].address};
  const self = {...permission,from:members[0].address};
  assert.equal((await submit({payload:self,signature:sign(members[0].privateKey,self)})).status,400);
  assert.equal((await submit({payload:permission,signature:sign(seq.privateKey,permission)})).status,201);
  const permissions = (await (await request('/v1/checkpoint')).json()).state;
  assert.deepEqual(permissions.validatorAddresses,[members[0].address]);
  assert.ok(!permissions.providers.includes(members[0].address));
  assert.equal((await (await request('/v1/status')).json()).eligibleValidatorCount,5);
  assert.equal((await propose(signEnrollment(genesis.hash,members[0],'https://localhost',ids[0]))).status,400);
  assert.equal((await propose(intent(0,Date.now()-180_000))).status,400);
  const altered = intent(0);
  altered.payload.origin = urls[1];
  assert.equal((await propose(altered)).status,400);
  assert.equal(calls.size,0);

  wrongKey = true;
  assert.equal((await propose(intent(0))).status,409);
  wrongKey = false;
  assert.equal((await propose(signEnrollment(genesis.hash,members[0],urls[0],ids[1]))).status,409);
  assert.equal((await (await propose(intent(0))).json()).active,false);
  assert.equal((await (await propose(intent(1))).json()).active,false);
  unreachable.add(0);
  assert.equal((await (await propose(intent(2))).json()).active,false);
  unreachable.delete(0);
  const availability = await (await request('/v1/consensus/candidates')).json();
  assert.equal(availability.chainId,genesis.hash);
  assert.equal(availability.candidates.length,3);
  assert.equal(availability.candidates[0].signature.length,128);
  assert.equal((await (await propose(intent(2))).json()).waitingFor,'published-validator-origins');
  published = urls;

  // The hosted ledger advances while readiness is being checked. That stale pivot must never escape.
  const pause = {i:2,started:Promise.withResolvers(),release:Promise.withResolvers()};
  holdMember = pause;
  const staleAttempt = propose(intent(2));
  await pause.started.promise;
  const payload = {type:'transfer',chainId:genesis.hash,from:payer.address,to:seq.address,amount:2,nonce:1};
  const transfer={payload,signature:sign(payer.privateKey,payload)};
  const committed=await (await submit(transfer)).json();
  pause.release.resolve();
  assert.equal((await staleAttempt).status,409);
  const last = await (await request('/v1/checkpoint')).json();
  assert.equal(last.state.height,2);
  assert.equal(last.authority,undefined);
  const attempts = await Promise.all([propose(intent(2)),propose(intent(3))]);
  assert.ok(attempts.some(r=>r.ok));
  const after = await (await request('/v1/checkpoint')).json();
  authenticate(after,genesis.hash);
  assert.deepEqual(after.state,last.state);
  assert.equal(after.authority.payload.anchorHash,hash(last));
  assert.equal(after.authority.payload.validators.length,3);
  assert.ok(after.authority.payload.validators.some(member=>member.address === members[0].address));
  for (const r of attempts.filter(r=>r.ok)) {
    const reply = await r.json();
    if (reply.active) assert.deepEqual(reply.checkpoint,after);
  }
  assert.equal((await (await request('/v1/status')).json()).mode,'retired');
  const transferProof=await (await request('/v1/transaction-outcomes/'+hash(transfer))).json();
  assert.deepEqual(verifyOutcome(transferProof,transfer,after),{height:2,hash:committed.block.hash});
  assert.deepEqual((await (await propose(intent(1))).json()).checkpoint,after);
  assert.equal((await submit({payload,signature:sign(payer.privateKey,payload)})).status,409);
  const legacyCAS = sqlite.prepare('UPDATE ledger_head SET tip=? WHERE id=1 AND tip=?').run('wrong',last.state.tip);
  assert.equal(legacyCAS.changes,0);
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
