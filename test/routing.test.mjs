import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { CONTEXT, MODEL } from '../src/ledger.mjs';
import { createProviderServer } from '../src/provider.mjs';
import { rankProviders } from '../src/routing.mjs';

const chainId = hash('discovery test genesis');
const ledgerUrl = 'http://127.0.0.1:8787';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('RTT probes rank ready 256K providers and check capacity without running inference', async t => {
  const calls = [];
  const modelId = 'qwen3.8-flash-next-q2_0';
  const backend = await listen(t, http.createServer((req, res) => {
    calls.push(req.url);
    res.end(JSON.stringify({data:[{id:modelId, context_length:CONTEXT, status:{value:'loaded'},
      limit:{output:8192}}]}));
  }));
  const fast = generateWallet();
  const slow = generateWallet();
  const offline = generateWallet();
  const options = {chainId, ledgerUrl, strataUrl:backend, modelId};
  const fastUrl = await listen(t, createProviderServer({...options, wallet:fast}));
  const second = await listen(t, createProviderServer({...options, wallet:slow}));
  let probes = 0;
  const delayed = await listen(t, http.createServer(async (req, res) => {
    probes++;
    await sleep(70);
    const upstream = await fetch(second + req.url);
    res.writeHead(upstream.status);
    res.end(await upstream.text());
  }));
  const deadServer = http.createServer();
  await new Promise(resolve => deadServer.listen(0, '127.0.0.1', resolve));
  const offlineUrl = 'http://127.0.0.1:' + deadServer.address().port;
  await new Promise(resolve => deadServer.close(resolve));
  const state = {chainId, providers:[offline.address, slow.address, fast.address],
    providerEndpoints:{[fast.address]:fastUrl, [slow.address]:delayed, [offline.address]:offlineUrl}};
  const ranked = await rankProviders(state, {ledgerUrl, maxOutputTokens:256});
  assert.deepEqual(ranked.map(entry => entry.provider), [fast.address, slow.address]);
  assert.equal(ranked[0].url, fastUrl);
  assert.ok(ranked[1].latencyMs >= 60);
  assert.equal(probes, 3);
  assert.deepEqual(await rankProviders(state, {ledgerUrl, maxOutputTokens:8193}), []);
  assert.ok(calls.length > 0 && calls.every(path => path === '/v1/models'));
});

test('probes reject stale challenges, wrong keys and chains, busy or incompatible responses', async t => {
  const wallet = generateWallet();
  const outsider = generateWallet();
  let alter;
  let captured;
  const url = await listen(t, http.createServer((req, res) => {
    const challenge = new URL(req.url, ledgerUrl).searchParams.get('challenge');
    const payload = {domain:'gpuchain/provider-probe/v1', provider:wallet.address, chainId, challenge,
      available:true, model:MODEL, contextWindow:CONTEXT, maxOutputTokens:2048};
    const answer = alter(payload);
    res.end(JSON.stringify(answer));
  }));
  const state = {chainId, providers:[wallet.address], providerEndpoints:{[wallet.address]:url}};
  const signed = (payload, signer = wallet) => ({payload, signature:sign(signer.privateKey, payload)});
  for (const fields of [
    {challenge:'0'.repeat(32)}, {available:false}, {chainId:hash('another genesis')},
    {model:'other model'}, {contextWindow:65536}, {maxOutputTokens:5}, {domain:'other-protocol'}
  ]) {
    alter = payload => signed({...payload,...fields});
    assert.deepEqual(await rankProviders(state, {ledgerUrl,maxOutputTokens:32}), []);
  }
  alter = payload => signed(payload, outsider);
  assert.deepEqual(await rankProviders(state, {ledgerUrl}), []);
  alter = payload => captured ??= signed(payload);
  assert.deepEqual(await rankProviders(state, {ledgerUrl}), []);
});

test('skip the caller, unlisted endpoints, remote-ledger loopback, and old address-only providers', async t => {
  const wallet = generateWallet();
  const other = generateWallet();
  let requests = 0;
  const url = await listen(t, http.createServer((_req, res) => { requests++; res.end('{}'); }));
  const state = {chainId, providers:[wallet.address], providerEndpoints:{[wallet.address]:url, [other.address]:url}};
  assert.deepEqual(await rankProviders(state, {payer:wallet.address, ledgerUrl}), []);
  assert.deepEqual(await rankProviders(state, {ledgerUrl:'https://ledger.example'}), []);
  assert.deepEqual(await rankProviders({chainId, providers:[wallet.address]}, {ledgerUrl}), []);
  assert.equal(requests, 0);
});
