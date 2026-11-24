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

async function fixture(t, onGenerate, config = {}) {
  const wallet = generateWallet();
  const payer = generateWallet();
  const chainId = hash('test genesis');
  const modelId = config.loadedId ?? 'qwen3.8-flash-next-q2_0';
  const model = { id: modelId, context_length: CONTEXT, status: { value: 'loaded' } };
  const catalog = [model];
  const metrics = {engine:{model:modelId,max_context:CONTEXT,gen:1,kv:'int8'},live:{}};
  const message = { role: 'assistant', content: '안녕하세요.' };
  const usage = { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 8 } };
  const messages = [{ role: 'user', content: '인사해 줘' }];
  let completions = 0;
  const backend = await listen(t, http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    let out;
    if (req.url === '/v1/models') out = { data: catalog };
    else if(req.url === '/metrics') out=metrics;
    else if (req.url === '/v1/messages/count_tokens') out = { input_tokens: 15 };
    else if (req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.deepEqual(input, { model: modelId, messages, max_tokens: 8, stream: false });
      completions++;
      if (onGenerate) await onGenerate();
      out = { model: modelId, choices: [{ finish_reason: 'stop', message }], usage };
    } else res.statusCode = 404;
    res.end(JSON.stringify(out ?? {}));
  }));
  const state = { chainId, providers: [wallet.address], nonces: {}, maxOutputTokens: 8192,
    balances: { [payer.address]: 1_000_000_000 } };
  const server = createProviderServer({ wallet, chainId, ledgerUrl: 'http://127.0.0.1:8088',
    strataUrl: backend + '/v1', modelId:config.requestedId, engine:config.engine, apiKey: 'test-secret',
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
  return { url, model, catalog, metrics, usage, message, request, submit, wallet, completions: () => completions, state };
}

test('loaded RYZENStrata profile, measured usage, receipt signature and retry', async t => {
  const f = await fixture(t);
  const profile = await (await fetch(f.url + '/v1/info')).json();
  assert.equal(profile.model, MODEL);
  assert.equal(profile.engine, 'ryzenstrata');
  assert.deepEqual(profile.kvCache,{k:'Q8',v:'Q8'});
  assert.equal(profile.contextWindow, CONTEXT);
  const { status, data } = await f.submit();
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.payload.requestHash, hash(f.request));
  assert.ok(!Object.hasOwn(data.payload,'kvCache'));
  assert.equal(data.payload.responseHash, hash(f.message));
  assert.equal(charge(data.payload), 7 * 150 + 8 * 16 + 4 * 470);
  assert.equal(verify(f.wallet.address, data.payload, data.providerSignature), true);
  assert.deepEqual((await f.submit()).data, data);
  assert.equal(f.completions(), 1);
  f.request.expiresAt++;
  assert.equal((await f.submit()).status, 409);
  assert.equal(f.completions(), 1);
});

test('upstream Strata discovers the exact loaded base model from its linked quant alias and bills measured cache usage',async t=>{
  const f=await fixture(t,undefined,{engine:'strata',loadedId:'iq3_xxs'});
  const family='qwen3.8-flash-next-iq3_xxs';
  f.catalog.push({...f.model,id:family,alias_of:'iq3_xxs'},
    {...f.model,id:'qwen3.8-flash-next-coder-iq3_s'}, {...f.model,id:'inkling-2-mini'},
    {...f.model,id:'qwen3.8-flash-next',status:{value:'unloaded'}});
  const info=await (await fetch(f.url+'/v1/info')).json();
  assert.equal(info.engine,'strata');assert.equal(info.backendModel,'iq3_xxs');
  assert.equal(info.contextWindow,CONTEXT);
  const result=await f.submit();assert.equal(result.status,200);
  assert.equal(result.data.payload.cachedTokens,8);
  assert.equal(verify(f.wallet.address,result.data.payload,result.data.providerSignature),true);
  f.request.nonce=2;f.state.nonces[f.request.payer]=1;delete f.usage.prompt_tokens_details;
  assert.equal((await f.submit()).status,502);
});

test('upstream rejects unknown, ambiguous, distill, coder and draft models and accepts an explicitly pinned quant',async t=>{
  const f=await fixture(t,undefined,{engine:'strata',loadedId:'iq3_xxs'});
  const info=()=>fetch(f.url+'/v1/info');
  assert.equal((await info()).status,503);
  for(const id of ['Qwen3.8-Flash-Next-DFlash2','Qwen3.8-Flash-Next-Distill','qwen3.8-flash-next-coder-iq3_s','qwen3.6-35b-a3b']) {
    f.model.id=id;assert.equal((await info()).status,503);
  }
  f.model.id='iq3_xxs';f.model.aliases=['qwen3.8-flash-next-iq3_xxs','qwen3.6-35b-a3b'];
  assert.equal((await info()).status,503);
  f.model.aliases=['qwen3.8-flash-next-q2_0'];
  assert.equal((await info()).status,503);
  f.model.id='qwen3.8-flash-next';f.model.aliases=[];
  f.catalog.push({...f.model,id:'Qwen/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S'});
  assert.equal((await info()).status,503);
  f.model.context_length=32768;
  f.metrics.engine.model='Qwen/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S';
  assert.equal((await (await info()).json()).backendModel,'Qwen/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S');
  const selected=await fixture(t,undefined,{engine:'strata',loadedId:'qwen3.8-flash-next-iq2_xs',requestedId:'qwen3.8-flash-next-iq2_xs'});
  selected.catalog.push({...selected.model,id:'qwen3.8-flash-next'});
  assert.equal((await (await fetch(selected.url+'/v1/info')).json()).backendModel,selected.model.id);
});

test('Q8 floor applies independently to K and V using same-engine runtime metrics for both adapters',async t=>{
  for(const engine of ['strata','ryzenstrata']) {
    const f=await fixture(t,undefined,{engine,loadedId:'qwen3.8-flash-next-q2_0'});
    const profile=()=>fetch(f.url+'/v1/info');
    for(const kv of [undefined,'auto','q4_0','k8v4','mystery']){
      f.metrics.engine.kv=kv;
      const res=await profile();assert.equal(res.status,503);
      const diagnostic=await res.json();assert.equal(diagnostic.code,'KV_CACHE_PRECISION');
      if(kv==='k8v4')assert.deepEqual(diagnostic.kvCache,{k:'Q8',v:'Q4'});
      assert.equal((await f.submit()).status,503);
    }
    f.metrics.engine.kv='fp16';f.metrics.engine.model='other-model';
    assert.equal((await profile()).status,503);
    f.metrics.engine.model=f.model.id;f.metrics.engine.replicas=2;
    assert.equal((await profile()).status,503);
    delete f.metrics.engine.replicas;f.metrics.engine.split_serve=true;
    assert.equal((await profile()).status,503);
    delete f.metrics.engine.split_serve;
    const challenge='f'.repeat(32);
    const probed=await (await fetch(f.url+'/v1/probe?challenge='+challenge)).json();
    assert.deepEqual(probed.payload.kvCache,{k:'F16',v:'F16'});
    assert.ok(verify(f.wallet.address,probed.payload,probed.signature));
    assert.equal(f.completions(),0);
    f.state.networkStage='mainnet';
    const {status,data}=await f.submit();assert.equal(status,200);
    assert.deepEqual(data.payload.kvCache,{k:'F16',v:'F16'});
  }
});

test('a cache change or engine restart during generation cannot produce a signed receipt',async t=>{
  for(const change of [f=>{f.metrics.engine.gen++;},f=>{f.metrics.engine.kv='q4_0';},
    f=>{f.state.networkStage='mainnet';}]) {
    const f=await fixture(t,()=>change(f));
    const reply=await f.submit();assert.ok(reply.status>=400);
    assert.equal(reply.data.providerSignature,undefined);
    assert.equal(f.completions(),1);
  }
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

test('local status reports active inference only while the backend completion is outstanding', {timeout:5000}, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t,async () => { started.resolve(); await release.promise; });
  const info = async () => (await fetch(f.url+'/v1/info')).json();
  assert.equal((await info()).inferenceActive,false);
  const pending = f.submit();
  try {
    await started.promise;
    const running = await info();
    assert.equal(running.busy,true);
    assert.equal(running.inferenceActive,true);
  } finally { release.resolve(); }
  assert.equal((await pending).status,200);
  const idle = await info();
  assert.equal(idle.inferenceActive,false);
  assert.equal(idle.busy,false);
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
