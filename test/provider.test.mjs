import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { generateWallet, hash, sign, verify } from '../src/crypto.mjs';
import { CONTEXT, MODEL, charge } from '../src/ledger.mjs';
import { createProviderServer } from '../src/provider.mjs';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t) {
  const wallet = generateWallet();
  const payer = generateWallet();
  const chainId = hash('test genesis');
  const modelId = 'qwen3.8-flash-next-q2_0';
  const model = { id: modelId, context_length: CONTEXT, status: { value: 'loaded' } };
  const message = { role: 'assistant', content: '안녕하세요.' };
  const usage = { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 8 } };
  const messages = [{ role: 'user', content: '인사해 줘' }];
  let completions = 0;
  const backend = await listen(t, http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    let out;
    if (req.url === '/v1/models') out = { data: [model] };
    else if (req.url === '/v1/messages/count_tokens') out = { input_tokens: 15 };
    else if (req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.deepEqual(input, { model: modelId, messages, max_tokens: 8, stream: false });
      completions++;
      out = { model: modelId, choices: [{ finish_reason: 'stop', message }], usage };
    } else res.statusCode = 404;
    res.end(JSON.stringify(out ?? {}));
  }));
  const state = { chainId, providers: [wallet.address], nonces: {}, maxOutputTokens: 8192,
    balances: { [payer.address]: 1_000_000_000 } };
  const server = createProviderServer({ wallet, chainId, ledgerUrl: 'http://127.0.0.1:8088',
    strataUrl: backend + '/v1', modelId, apiKey: 'test-secret',
    readState: async (_url, pin) => { assert.equal(pin, chainId); return state; } });
  const url = await listen(t, server);
  const request = { type: 'inference-request', chainId, payer: payer.address, provider: wallet.address,
    nonce: 1, expiresAt: Date.now() + 120_000, messagesHash: hash(messages),
    maxInputTokens: 24, maxOutputTokens: 8 };
  async function submit(body = {}) {
    const res = await fetch(url + '/v1/infer', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ request, signature: sign(payer.privateKey, request), messages, ...body }) });
    return { status: res.status, data: await res.json() };
  }
  return { url, model, usage, message, request, submit, wallet, completions: () => completions, state };
}

test('loaded RYZENStrata profile, measured usage, receipt signature and retry', async t => {
  const f = await fixture(t);
  const profile = await (await fetch(f.url + '/v1/info')).json();
  assert.equal(profile.model, MODEL);
  assert.equal(profile.contextWindow, CONTEXT);
  const { status, data } = await f.submit();
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.payload.requestHash, hash(f.request));
  assert.equal(data.payload.responseHash, hash(f.message));
  assert.equal(charge(data.payload), 7 * 150 + 8 * 16 + 4 * 470);
  assert.equal(verify(f.wallet.address, data.payload, data.providerSignature), true);
  assert.deepEqual((await f.submit()).data, data);
  assert.equal(f.completions(), 1);
  f.request.expiresAt++;
  assert.equal((await f.submit()).status, 409);
  assert.equal(f.completions(), 1);
});

test('rejects modified authorization, messages, unfunded payer and stale nonce before generation', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit({ signature: '0'.repeat(128) })).status, 403);
  assert.equal((await f.submit({ messages: [{ role:'user', content:'different prompt' }] })).status, 400);
  f.state.nonces[f.request.payer] = 3;
  assert.equal((await f.submit()).status, 409);
  f.state.nonces = {};
  f.state.balances = {};
  assert.equal((await f.submit()).status, 402);
  assert.equal(f.completions(), 0);
});

test('enforces actual loaded model and context, signed prompt cap and current epoch output cap', async t => {
  const f = await fixture(t);
  f.model.status.value = 'unloaded';
  assert.equal((await fetch(f.url + '/v1/info')).status, 503);
  f.model.status.value = 'loaded';
  f.model.context_length = CONTEXT / 2;
  assert.equal((await f.submit()).status, 503);
  f.model.context_length = CONTEXT;
  f.request.maxInputTokens = 12;
  assert.equal((await f.submit()).status, 400);
  f.request.maxInputTokens = 24;
  f.state.maxOutputTokens = 7;
  assert.equal((await f.submit()).status, 400);
  assert.equal(f.completions(), 0);
});

test('refuses a receipt when Strata omits cache metrics', async t => {
  const f = await fixture(t);
  delete f.usage.prompt_tokens_details;
  const { status, data } = await f.submit();
  assert.equal(status, 502);
  assert.equal(data.providerSignature, undefined);
  assert.equal(f.completions(), 1);
});
