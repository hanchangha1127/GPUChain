import assert from 'node:assert/strict';
import test from 'node:test';
import { addressFromPrivateKey, generateWallet, hash, sign, verify } from '../src/crypto.mjs';
import { isLoopbackEndpoint, normalizeProviderEndpoint } from '../src/provider-endpoint.mjs';
import {
  CONTEXT, EPOCH_TOKENS, MODEL, applyBlock, charge, createBlock, createGenesis, replay, verifyBlock,
} from '../src/ledger.mjs';

function network() {
  const sequencer = generateWallet();
  const buyer = generateWallet();
  const provider = generateWallet();
  const genesis = createGenesis(sequencer, {
    allocations: {[buyer.address]: 1_000_000_000_000}, providers: [provider.address], networkId: 'test',
  });
  const state = replay([genesis], genesis.hash);
  return {sequencer, buyer, provider, genesis, state};
}

function receipt(net, state, overrides = {}) {
  const payload = {
    type: 'inference', chainId: state.chainId, from: net.buyer.address, provider: net.provider.address,
    nonce: (state.nonces[net.buyer.address] ?? 0) + 1,
    model: MODEL, contextWindow: CONTEXT, requestHash: hash('input'), responseHash: hash('output'),
    inputTokens: 1000, cachedTokens: 200, outputTokens: 100, ...overrides,
  };
  return {
    payload, signature: sign(net.buyer.privateKey, payload),
    providerSignature: sign(net.provider.privateKey, payload),
  };
}

function signed(wallet, payload) {
  return {payload, signature: sign(wallet.privateKey, payload)};
}

test('canonical signature encoding survives object key reordering and JSON transport', () => {
  const wallet = generateWallet();
  const original = {x: [1, {b: 2, a: '안녕'}], a: false};
  const reordered = {a: false, x: [1, {a: '안녕', b: 2}]};
  const signature = sign(wallet.privateKey, original);
  assert.equal(addressFromPrivateKey(wallet.privateKey), wallet.address);
  assert.equal(hash(original), hash(reordered));
  assert.ok(verify(wallet.address, reordered, signature));
  assert.equal(verify(wallet.address, {...reordered, a: true}, signature), false);
  assert.equal(verify(generateWallet().address, original, signature), false);
});

test('genesis validates signature, pinned identity and total-safe allocation', () => {
  const net = network();
  assert.throws(() => replay([net.genesis], hash('other')), /trusted genesis/);
  assert.throws(() => createGenesis(net.sequencer, {
    providers: [], allocations: {[net.provider.address]: Number.MAX_SAFE_INTEGER, [net.buyer.address]: 1},
  }), /total supply/);
  assert.throws(() => createGenesis({...net.buyer, address: net.sequencer.address},
    {providers: [], allocations: {}}), /wallet signature/);
  const changed = structuredClone(net.genesis);
  changed.payload.allocations[net.buyer.address]++;
  assert.throws(() => replay([changed]), /hash/);
});

test('usage is paid in nanocoins with cached input counted only once', () => {
  const net = network();
  const tx = receipt(net, net.state);
  assert.equal(charge(tx.payload), 170_200);
  const block = createBlock(net.state, tx, net.sequencer);
  const next = applyBlock(net.state, block);
  assert.equal(verifyBlock(block, net.sequencer.address), true);
  assert.throws(() => verifyBlock(block, net.buyer.address), /block signature/);
  assert.equal(next.balances[net.provider.address], 170_200);
  assert.equal(next.balances[net.buyer.address], 1_000_000_000_000 - 170_200);
  assert.equal(next.epochTokens, 900);
  assert.equal(next.totalWorkTokens, 900);
  assert.equal(next.nonces[net.buyer.address], 1);
  assert.equal(net.state.epochTokens, 0);
  assert.deepEqual(replay(JSON.parse(JSON.stringify([net.genesis, block])), net.genesis.hash), next);
  tx.payload.outputTokens++;
  assert.equal(block.payload.payload.outputTokens, 100);
  assert.throws(() => createBlock(next, block.payload, net.sequencer), /nonce/);
  assert.throws(() => applyBlock(next, block), /linkage/);
});

test('both signatures, approved provider, profile and metering bounds are consensus rules', () => {
  const net = network();
  for (const overrides of [
    {chainId: hash('another network')}, {provider: net.buyer.address}, {nonce: 2}, {nonce: -1},
    {model: 'other'}, {contextWindow: 4096}, {inputTokens: CONTEXT, outputTokens: 1},
    {inputTokens: 12, cachedTokens: 13}, {outputTokens: 0.5}, {cachedTokens: -1},
    {requestHash: 'invalid'}, {newField: true},
  ]) {
    assert.throws(() => createBlock(net.state, receipt(net, net.state, overrides), net.sequencer));
  }
  const tx = receipt(net, net.state);
  const bad = {...tx, providerSignature: tx.signature};
  assert.throws(() => createBlock(net.state, bad, net.sequencer), /provider signature/);
  assert.throws(() => createBlock(net.state, {...tx, signature: tx.providerSignature}, net.sequencer), /sender signature/);
  // Even a correctly signed sequencer block cannot make an invalid receipt valid.
  const header = {height: 1, previousHash: net.state.tip, payload: bad};
  const body = {...header, signature: sign(net.sequencer.privateKey, header)};
  assert.throws(() => applyBlock(net.state, {...body, hash: hash(body)}), /provider signature/);
});

test('transfers conserve supply and require a sequential signed spend', () => {
  const net = network();
  const payload = {type: 'transfer', chainId: net.state.chainId, from: net.buyer.address,
    to: net.provider.address, amount: 7, nonce: 1};
  const tx = signed(net.buyer, payload);
  const block = createBlock(net.state, tx, net.sequencer);
  assert.throws(() => createBlock(net.state, tx, net.buyer), /Wrong sequencer/);
  const next = applyBlock(net.state, block);
  assert.equal(next.balances[net.provider.address], 7);
  assert.equal(Object.values(next.balances).reduce((a, b) => a + b, 0), next.supply);
  assert.equal(next.totalWorkTokens, 0);
  assert.throws(() => createBlock(net.state, signed(net.buyer, {...payload, amount: 1_000_000_000_001}),
    net.sequencer), /Insufficient/);
  assert.throws(() => createBlock(net.state, signed(net.buyer, {...payload, to: net.buyer.address}),
    net.sequencer), /different/);
  assert.throws(() => createBlock(net.state, signed(net.buyer, {...payload, amount: 0}),
    net.sequencer), /transfer amount/);
});

test('cached input earns credit with zero boundary progress for an all-cache request', () => {
  const net = network();
  const tx = receipt(net, net.state, {inputTokens: 42, cachedTokens: 42, outputTokens: 0});
  const next = applyBlock(net.state, createBlock(net.state, tx, net.sequencer));
  assert.equal(next.epochTokens, 0);
  assert.equal(next.balances[net.provider.address], 42 * 16);
});

test('sequencer publishes and withdraws a compact provider directory on an existing chain', () => {
  const {state: initial, sequencer, provider, buyer} = network();
  let state = initial;
  function submit(type, fields, signer = sequencer) {
    const p = {type, from: signer.address, nonce: (state.nonces[signer.address] ?? 0) + 1,
      chainId: state.chainId, ...fields};
    state = applyBlock(state, createBlock(state, signed(signer, p), sequencer));
  }
  assert.ok(!Object.hasOwn(state, 'providerEndpoints'));
  const added = generateWallet().address;
  const publish = {provider: added, endpoint: 'https://provider.example'};
  assert.throws(() => submit('set-provider-endpoint', publish), /Unregistered/);
  assert.throws(() => submit('add-provider', publish, buyer), /sequencer/);
  submit('add-provider', publish);
  assert.deepEqual(state.providerEndpoints, {[added]: publish.endpoint});
  const update = {provider: provider.address, endpoint: 'https://second.example'};
  assert.throws(() => submit('set-provider-endpoint', update, provider), /sequencer/);
  submit('set-provider-endpoint', update);
  assert.deepEqual(state.providerEndpoints, {[added]: publish.endpoint, [provider.address]: update.endpoint});
  assert.throws(() => submit('set-provider-endpoint', {...update, endpoint: update.endpoint + '/'}), /canonical/);
  submit('set-provider-endpoint', {...update, endpoint: 'http://127.0.0.1:8789'});
  submit('set-provider-endpoint', {...publish, endpoint: null});
  assert.deepEqual(state.providerEndpoints, {[provider.address]: 'http://127.0.0.1:8789'});
  submit('set-provider-endpoint', {...update, endpoint: null});
  assert.ok(!Object.hasOwn(state, 'providerEndpoints'));
  assert.ok(state.providers.includes(provider.address) && state.providers.includes(added));
  assert.deepEqual(state.balances, initial.balances);
  assert.equal(state.totalWorkTokens, initial.totalWorkTokens);
});

test('provider directory accepts normalized HTTPS origins and loopback HTTP', () => {
  assert.equal(normalizeProviderEndpoint('https://Provider.Example:443/'), 'https://provider.example');
  assert.equal(normalizeProviderEndpoint('http://[::1]:8789'), 'http://[::1]:8789');
  for (const host of ['127.7.3.1','api.localhost.','[::ffff:127.0.0.1]']) {
    assert.equal(isLoopbackEndpoint('https://' + host), true);
  }
  for (const bad of ['http://gpu.example', 'https://user@gpu.example', 'https://gpu.example?',
    'https://gpu.example#', 'https://gpu.example/?q=x', 'https://gpu.example/abc/..',
    'file://localhost', null]) assert.throws(() => normalizeProviderEndpoint(bad));
});

test('one-billion-token boundary carries excess and activates scheduled settings for the next request', () => {
  const net = network();
  const settings = {type: 'settings', chainId: net.state.chainId, from: net.sequencer.address,
    nonce: 1, maxOutputTokens: 1};
  let state = applyBlock(net.state, createBlock(net.state, signed(net.sequencer, settings), net.sequencer));
  assert.equal(state.maxOutputTokens, CONTEXT);
  const submit = counts => {
    const tx = receipt(net, state, counts);
    state = applyBlock(state, createBlock(state, tx, net.sequencer));
  };
  // Fill to 250,000 tokens below the boundary.
  assert.equal(EPOCH_TOKENS, 1_000_000_000);
  for (let i = 0; i < 3999; i++) submit({inputTokens: 251_200, cachedTokens: 1_400, outputTokens: 200});
  assert.equal(state.epochTokens, EPOCH_TOKENS - 250_000);
  submit({inputTokens: 251_200, cachedTokens: 1_400, outputTokens: 201});
  assert.equal(state.epoch, 1);
  assert.equal(state.epochTokens, 1);
  assert.equal(state.totalWorkTokens, EPOCH_TOKENS + 1);
  assert.equal(state.maxOutputTokens, 1);
  assert.equal(state.pendingMaxOutputTokens, null);
  assert.throws(() => submit({outputTokens: 2}), /Epoch output limit/);
  submit({outputTokens: 1});
  assert.equal(state.epochTokens, 802);
});
