import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { CONTEXT, MODEL, createGenesis } from '../src/ledger.mjs';
import { readVerifiedState, startNode } from '../src/node.mjs';
import { verifyOutcome } from '../src/transaction-outcome.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gpuchain-snapshot-test-'));
  const open = new Set();
  t.after(async () => {
    try {
      for (const node of open) await node.close();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
  const sequencer = generateWallet();
  const customer = generateWallet();
  const provider = generateWallet();
  const genesis = createGenesis(sequencer, {allocations: {[customer.address]: 1_000_000_000},
    providers: [provider.address]});
  const dir = join(root, 'authority');
  async function launch(options = {}) {
    const node = await startNode({dir, genesis, wallet: sequencer, port: 0, ...options});
    open.add(node);
    return node;
  }
  async function stop(node) {
    await node.close();
    open.delete(node);
  }
  function transfer(nonce, amount = 7) {
    const payload = {type: 'transfer', from: customer.address, to: provider.address,
      chainId: genesis.hash, nonce, amount};
    return {payload, signature: sign(customer.privateKey, payload)};
  }
  return {root, dir, sequencer, customer, provider, genesis, launch, stop, transfer};
}

async function submit(url, tx) {
  const response = await fetch(url + '/v1/transactions', {
    method: 'POST', body: JSON.stringify(tx), headers: {'Content-Type': 'application/json'},
  });
  const body = await response.json();
  return {status: response.status, body};
}

async function checkpoint(url) {
  const response = await fetch(url + '/v1/checkpoint');
  assert.equal(response.status, 200);
  return response.json();
}

test('concurrent duplicate and restarted replay settle only once; disk stores no receipt or transaction signatures', async t => {
  const net = await fixture(t);
  const node = await net.launch();
  const tx = net.transfer(1);
  const duplicates = await Promise.all([submit(node.url, tx), submit(node.url, tx)]);
  assert.equal(duplicates.filter(result => result.status === 201).length, 1);
  assert.equal(duplicates.filter(result => result.status >= 400).length, 1);
  const afterTransfer = await readVerifiedState(node.url, net.genesis.hash);
  assert.equal(afterTransfer.balances[net.provider.address], 7);
  assert.equal(afterTransfer.height, 1);

  const payload = {type: 'inference', chainId: net.genesis.hash, from: net.customer.address,
    provider: net.provider.address, nonce: 2, model: MODEL, contextWindow: CONTEXT,
    requestHash: hash('private request canary'), responseHash: hash('private response canary'),
    inputTokens: 1000, cachedTokens: 200, outputTokens: 100};
  const receipt = {payload, signature: sign(net.customer.privateKey, payload),
    providerSignature: sign(net.provider.privateKey, payload)};
  assert.equal((await submit(node.url, receipt)).status, 201);
  const expected = await readVerifiedState(node.url, net.genesis.hash);
  assert.equal(expected.epochTokens, 900);
  assert.equal(expected.balances[net.provider.address], 170_207);
  const snapshot = await checkpoint(node.url);
  const sensitive = [payload.requestHash, payload.responseHash, receipt.signature, receipt.providerSignature, tx.signature];
  for (const value of sensitive) assert.ok(!JSON.stringify(snapshot).includes(value));
  await net.stop(node);

  const files = await readdir(net.dir, {withFileTypes: true});
  assert.ok(files.some(entry => entry.name === 'ledger.sqlite'));
  for (const entry of files.filter(entry => entry.isFile())) {
    const contents = await readFile(join(net.dir, entry.name));
    for (const value of sensitive) {
      assert.ok(!contents.includes(Buffer.from(value)), 'Transaction data stored in ' + entry.name);
      assert.ok(!contents.includes(Buffer.from(value, 'hex')), 'Binary transaction data stored in ' + entry.name);
    }
  }
  const restarted = await net.launch();
  const outcome=await (await fetch(restarted.url+'/v1/transaction-outcomes/'+hash(receipt))).json();
  assert.deepEqual(verifyOutcome(outcome,receipt,snapshot),{height:2,hash:expected.tip});
  assert.deepEqual(await readVerifiedState(restarted.url, net.genesis.hash), expected);
  assert.ok((await submit(restarted.url, receipt)).status >= 400);
  assert.ok((await submit(restarted.url, tx)).status >= 400);
  assert.deepEqual(await readVerifiedState(restarted.url, net.genesis.hash), expected);
});

test('followers reject tampered checkpoints, rollbacks, and conflicting signed tips at the same height', async t => {
  const net = await fixture(t);
  const authority = await net.launch();
  const old = await checkpoint(authority.url);
  let serving = old;
  const proxy = createServer((req, res) => {
    if (req.url !== '/v1/checkpoint') return res.writeHead(404).end();
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(serving));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const upstream = 'http://127.0.0.1:' + proxy.address().port;
  const follower = await net.launch({dir: join(net.root, 'follower'), wallet: undefined,
    upstream, syncIntervalMs: 60_000});
  assert.equal((await submit(authority.url, net.transfer(1))).status, 201);
  const current = await checkpoint(authority.url);
  serving = current;
  await follower.sync();
  const verified = await readVerifiedState(follower.url, net.genesis.hash);
  assert.deepEqual(verified, current.state);
  assert.equal(verified.balances[net.provider.address], 7);
  serving = structuredClone(current);
  serving.state.balances[net.provider.address] += 1;
  await assert.rejects(() => readVerifiedState(upstream, net.genesis.hash));
  await assert.rejects(() => follower.sync());
  serving = old;
  await assert.rejects(() => follower.sync());
  assert.deepEqual(await readVerifiedState(follower.url, net.genesis.hash), verified);

  const fork = await net.launch({dir: join(net.root, 'fork')});
  assert.equal((await submit(fork.url, net.transfer(1, 8))).status, 201);
  serving = await checkpoint(fork.url);
  assert.equal(serving.state.height, verified.height);
  assert.notEqual(serving.state.tip, verified.tip);
  await assert.rejects(() => follower.sync());
  assert.deepEqual(await readVerifiedState(follower.url, net.genesis.hash), verified);
  await assert.rejects(() => readVerifiedState(upstream, hash('another genesis')));
});

async function diskBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.isFile()) total += (await stat(join(dir, entry.name))).size;
  }
  return total;
}

test('fixed-wallet database stays compact across one hundred additional transfers', async t => {
  const net = await fixture(t);
  const first = await net.launch();
  assert.equal((await submit(first.url, net.transfer(1))).status, 201);
  await net.stop(first);
  const baseline = await diskBytes(net.dir);
  const node = await net.launch();
  for (let nonce = 2; nonce <= 101; nonce++) {
    assert.equal((await submit(node.url, net.transfer(nonce))).status, 201);
  }
  const state = await readVerifiedState(node.url, net.genesis.hash);
  assert.equal(state.balances[net.provider.address], 707);
  assert.equal(state.height, 101);
  await net.stop(node);
  const final = await diskBytes(net.dir);
  t.diagnostic('Closed directory bytes: 1 transfer = ' + baseline + ', 101 transfers = ' + final);
  // Permit SQLite a few additional pages, while catching linear block/receipt storage.
  assert.ok(final <= baseline + 16_384, 'Unexpected fixed-wallet storage growth');
});
