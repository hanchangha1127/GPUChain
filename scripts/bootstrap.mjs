#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generateWallet, sign } from '../src/crypto.mjs';
import { readRuntimeWallet, writeRuntimeWallet } from '../src/runtime-wallet.mjs';
import { createGenesis, NANOCOINS, replay } from '../src/ledger.mjs';
import { readVerifiedState, startNode } from '../src/node.mjs';
import { createProviderServer } from '../src/provider.mjs';
import { isLoopbackEndpoint } from '../src/provider-endpoint.mjs';
import { requestJson } from '../src/http.mjs';

const DEFAULT_STRATA = 'http://127.0.0.1:8000/v1';
const DEFAULT_MODEL = 'qwen3.8-flash-next-q2_0';
const roles = ['sequencer', 'user', 'provider'];

async function readJson(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return undefined; throw err; }
  try { return JSON.parse(raw); }
  catch { throw Error('Invalid JSON in ' + path); }
}

// Only the bootstrap marker can be replaced. Existing wallets are never overwritten.
async function writeJson(path, value, replace = false) {
  const temp = path + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally { await file.close(); }
    if (replace) await rename(temp, path);
    else await link(temp, path);
  } finally {
    await unlink(temp).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}

function lockDirectory(dir) {
  // OS-backed lock releases on process exit, including an interrupted first run.
  const lock = new DatabaseSync(join(dir, '.bootstrap-lock.sqlite'));
  try { lock.exec('BEGIN EXCLUSIVE'); }
  catch (err) {
    lock.close();
    if (err.errcode === 5) throw Error('Another GPUChain bootstrap is running in ' + dir);
    throw err;
  }
  return lock;
}

async function existingDatabase(path) {
  let file;
  try { file = await stat(path); }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  if (!file.isFile() || !file.size) throw Error('Existing ledger database is empty or invalid: ' + path);
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const rows = db.prepare('SELECT count(*) AS n FROM current_state WHERE id=1').get();
    if (rows.n !== 1) throw Error('Current checkpoint is missing');
    db.prepare('SELECT number, digest FROM epoch LIMIT 1').get();
  } finally { db.close(); }
  return true;
}

async function identity(dir) {
  const ledgerDir = join(dir, 'ledger');
  const marker = await readJson(join(dir, '.bootstrap.json'));
  let genesis = await readJson(join(dir, 'genesis.json'));
  if (genesis !== undefined) replay([genesis], genesis.hash);
  const hasDB = await existingDatabase(join(ledgerDir, 'ledger.sqlite'));
  if (marker !== undefined && (!marker || marker.chainId !== genesis?.hash || !hasDB)) {
    throw Error('Restore the matching genesis and ledger database for this initialized directory');
  }
  if (hasDB && !genesis) throw Error('Restore the genesis file matching the existing ledger database');
  const wallets = {};
  for (const role of roles) {
    const wallet = await readRuntimeWallet(join(dir,role+'.json')).catch(err=>{
      if (err.code!=='ENOENT') throw err;
    });
    if (wallet === undefined) {
      if (genesis) throw Error('Restore the missing ' + role + ' wallet for the existing genesis');
    } else {
      wallets[role] = wallet;
    }
  }
  for (const role of roles) {
    if (!wallets[role]) {
      wallets[role] = generateWallet();
      await writeRuntimeWallet(join(dir, role + '.json'), wallets[role]);
    }
  }
  const {sequencer, provider, user} = wallets;
  if (new Set(roles.map(role => wallets[role].address)).size !== roles.length) {
    throw Error('Local roles must have distinct wallets');
  }
  if (genesis) {
    if (genesis.payload.sequencer !== sequencer.address || !genesis.payload.providers.includes(provider.address) ||
        !Object.hasOwn(genesis.payload.allocations, user.address)) {
      throw Error('Existing wallets do not match the local genesis');
    }
  } else {
    genesis = createGenesis(sequencer, {allocations: {[user.address]: NANOCOINS}, providers: [provider.address]});
    await writeJson(join(dir, 'genesis.json'), genesis);
  }
  return {genesis, sequencer, provider, user, ledgerDir, marker};
}

function portNumber(value, name) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) {
    throw Error('Invalid ' + name + ' (expected 0–65535)');
  }
  return Number(value);
}

/** Start a loopback network and return public service details and an idempotent shutdown function. */
export async function startLocal({dir = '.local', nodePort = 8787, providerPort = 8789,
  strataUrl = DEFAULT_STRATA, engine = 'ryzenstrata', modelId} = {}) {
  if (!['strata','ryzenstrata'].includes(engine)) throw Error('Expected --engine strata or ryzenstrata');
  modelId ??= engine === 'ryzenstrata' ? DEFAULT_MODEL : undefined;
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('GPUChain requires Node.js 24 or newer');
  dir = resolve(dir);
  nodePort = portNumber(nodePort, '--node-port');
  providerPort = portNumber(providerPort, '--provider-port');
  await mkdir(dir, {recursive: true, mode: 0o700});
  const lock = lockDirectory(dir);
  let node, server, closing;
  async function release() {
    try {
      if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
    } finally {
      try { await node?.close(); }
      finally { lock.close(); }
    }
  }
  const close = () => closing ??= release();
  try {
    const {genesis, sequencer, provider, user, ledgerDir, marker} = await identity(dir);
    node = await startNode({dir: ledgerDir, genesis, wallet: sequencer, port: nodePort});
    const state = await readVerifiedState(node.url, genesis.hash);
    const markerPath = join(dir, '.bootstrap.json');
    if (!marker) await writeJson(markerPath, {chainId: state.chainId});
    server = createProviderServer({wallet: provider, chainId: state.chainId, ledgerUrl: node.url,
      strataUrl, engine, modelId, apiKey: process.env.STRATA_API_KEY});
    server.listen(providerPort, '127.0.0.1');
    await once(server, 'listening');
    const providerUrl = 'http://127.0.0.1:' + server.address().port;
    const previous = state.providerEndpoints?.[provider.address];
    // A missing listing after initialization means the operator withdrew the endpoint.
    const manageLocal = previous ? isLoopbackEndpoint(previous) : !marker?.discoveryInitialized;
    if (manageLocal && previous !== providerUrl) {
      const payload = {type: 'set-provider-endpoint', chainId: state.chainId, from: sequencer.address,
        nonce: (state.nonces[sequencer.address] ?? 0) + 1, provider: provider.address, endpoint: providerUrl};
      await requestJson(node.url + '/v1/transactions', {
        body: {payload, signature: sign(sequencer.privateKey, payload)}
      });
    }
    if (!marker?.discoveryInitialized) {
      await writeJson(markerPath, {chainId: state.chainId, discoveryInitialized: true}, true);
    }
    let providerReady = false;
    let providerDetail;
    try {
      const info = await requestJson(providerUrl + '/v1/info', {timeoutMs: 12_000});
      if (info.provider !== provider.address || info.chainId !== state.chainId ||
          info.engine !== engine || !info.backendModel || (modelId && info.backendModel !== modelId)) {
        throw Error('Unexpected provider profile');
      }
      providerReady = true;
      providerDetail = info.backendModel+' loaded with a 256K context window.';
    } catch (err) {
      providerDetail = err.message + '. Start '+engine+' with ' + (modelId ?? 'Qwen3.8-Flash-Next') +
        ' at 262144 context tokens; check --strata, --model-id and STRATA_API_KEY, then retry GET ' +
        providerUrl + '/v1/info.';
    }
    return {info: {dir, chainId: state.chainId, ledgerUrl: node.url, providerUrl,
      sequencerAddress: sequencer.address, userAddress: user.address, providerAddress: provider.address,
      ledgerReady: true, providerReady, providerDetail}, close};
  } catch (err) {
    await close();
    throw err;
  }
}

async function main() {
  const {values} = parseArgs({options: {
    dir: {type:'string'}, 'node-port': {type:'string'}, 'provider-port': {type:'string'},
    strata: {type:'string'}, engine:{type:'string'}, 'model-id': {type:'string'}, help: {type:'boolean', short:'h'},
  }});
  if (values.help) {
    console.log('node scripts/bootstrap.mjs [--dir .local] [--node-port 8787] [--provider-port 8789]' +
      ' [--engine ryzenstrata|strata] [--strata ' + DEFAULT_STRATA + '] [--model-id ID]');
    return;
  }
  const app = await startLocal({dir: values.dir, nodePort: values['node-port'],
    providerPort: values['provider-port'], strataUrl: values.strata, engine:values.engine, modelId: values['model-id']});
  const stop = () => app.close().catch(err => { console.error(err.message); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(JSON.stringify(app.info));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
