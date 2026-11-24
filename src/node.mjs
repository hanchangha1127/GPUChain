import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addressFromPrivateKey, hash, sign, verify } from './crypto.mjs';
import { applyBlock, createBlock, EPOCH_TOKENS, replay } from './ledger.mjs';

const HEX = /^[0-9a-f]{64}$/;
const MAX_CHECKPOINT = 64 * 1024 * 1024;

function check(ok, reason) {
  if (!ok) throw Error(reason);
}

async function jsonBody(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    check(bytes <= limit, 'Body size limit exceeded');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function checkpointProof(state, epochHashes) {
  return {domain:'gpuchain/checkpoint/v1', stateHash:hash(state), epochsHash:hash(epochHashes)};
}

function authenticate(checkpoint, chainId) {
  const {genesis, state, epochHashes, signature} = checkpoint;
  const initial = replay([genesis], chainId);
  check(state.chainId === initial.chainId && state.sequencer === initial.sequencer,
    'Unexpected checkpoint identity');
  check(Array.isArray(epochHashes) && epochHashes.length === state.epoch &&
    epochHashes.every(value => typeof value === 'string' && HEX.test(value)), 'Invalid epoch hashes');
  if (state.height === 0) {
    check(signature === null && hash(initial) === hash(state), 'Invalid initial checkpoint');
  } else {
    check(Number.isSafeInteger(state.height) && state.height > 0 &&
      verify(initial.sequencer, checkpointProof(state, epochHashes), signature),
    'Invalid checkpoint signature');
  }
  return checkpoint;
}

function ledgerOrigin(endpoint) {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  check((url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'Use a ledger HTTPS origin, or HTTP on loopback');
  return url.origin;
}

async function readCheckpoint(url, chainId) {
  check(typeof chainId === 'string' && HEX.test(chainId), 'A pinned genesis hash is required');
  const res = await fetch(ledgerOrigin(url) + '/v1/checkpoint', {
    redirect:'error', signal:AbortSignal.timeout(30_000)
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw Error('Checkpoint endpoint returned HTTP ' + res.status);
  }
  return authenticate(await jsonBody(res.body, MAX_CHECKPOINT), chainId);
}

export async function readVerifiedState(url, genesisHash) {
  return (await readCheckpoint(url, genesisHash)).state;
}

// Store one current state and one 32-byte digest per completed billion-token epoch.
// SQLite commits the two changes atomically. No request or receipt enters the database.
function openStore(dir, genesis) {
  mkdirSync(dir, {recursive:true, mode:0o700});
  const db = new DatabaseSync(join(dir, 'ledger.sqlite'));
  try {
    db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS current_state (
        id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, signature TEXT
      );
      CREATE TABLE IF NOT EXISTS epoch (number INTEGER PRIMARY KEY, digest BLOB NOT NULL);
    `);
    const genesisState = replay([genesis], genesis.hash);
    db.prepare('INSERT OR IGNORE INTO current_state VALUES (1, ?, NULL)').run(JSON.stringify(genesisState));
    const read = db.prepare('SELECT state, signature FROM current_state WHERE id=1');
    const readEpochs = db.prepare('SELECT digest FROM epoch ORDER BY number');
    const update = db.prepare('UPDATE current_state SET state=?, signature=? WHERE id=1');
    const addEpoch = db.prepare('INSERT INTO epoch VALUES (?, ?)');
    function current() {
      const row = read.get();
      return {genesis, state:JSON.parse(row.state), signature:row.signature,
        epochHashes:readEpochs.all().map(row => Buffer.from(row.digest).toString('hex'))};
    }
    function save(prior, next) {
      db.exec('BEGIN IMMEDIATE');
      try {
        check(JSON.parse(read.get().state).tip === prior.state.tip, 'Ledger advanced concurrently; retry');
        for (let i = prior.epochHashes.length; i < next.epochHashes.length; i++) {
          addEpoch.run(i + 1, Buffer.from(next.epochHashes[i], 'hex'));
        }
        update.run(JSON.stringify(next.state), next.signature);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    // Take a consistent initial view even if another process writes this directory.
    db.exec('BEGIN');
    const checkpoint = authenticate(current(), genesis.hash);
    db.exec('COMMIT');
    return {db, save, checkpoint};
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function startNode({dir, genesis, wallet, listen = '127.0.0.1', port = 8787,
  upstream, syncIntervalMs = 5000}) {
  check(Boolean(wallet) !== Boolean(upstream), 'Specify a sequencer wallet or a follower upstream');
  if (wallet) check(wallet.address === genesis.payload.sequencer &&
    addressFromPrivateKey(wallet.privateKey) === wallet.address, 'Incorrect sequencer key');
  if (upstream) ledgerOrigin(upstream);
  const {db, save, checkpoint} = openStore(dir, genesis);
  let head = checkpoint;
  let syncing;
  let closed = false;
  let syncError = null;
  async function advanceFollower() {
    const next = await readCheckpoint(upstream, genesis.hash);
    check(next.state.height >= head.state.height && next.state.epoch >= head.state.epoch &&
      next.state.totalWorkTokens >= head.state.totalWorkTokens, 'Upstream checkpoint rollback');
    check(head.epochHashes.every((digest, i) => next.epochHashes[i] === digest),
      'Upstream conflicts with a finalized epoch');
    if (next.state.height === head.state.height) {
      check(hash(next) === hash(head), 'Conflicting checkpoint at the same height');
      return;
    }
    if (!closed) {
      save(head, next);
      head = next;
    }
  }
  async function sync() {
    if (!upstream || closed) return;
    if (!syncing) syncing = advanceFollower().then(() => { syncError = null; }).catch(err => {
      syncError = err.message;
      throw err;
    }).finally(() => { syncing = undefined; });
    return syncing;
  }
  function submit(tx) {
    const block = createBlock(head.state, tx, wallet);
    const state = applyBlock(head.state, block);
    let epochHashes = head.epochHashes;
    if (state.epoch > head.state.epoch) {
      const digest = hash({domain:'gpuchain/epoch/v1', previous:epochHashes.at(-1) ?? genesis.hash,
        epoch:state.epoch, tip:state.tip, stateHash:hash(state)});
      epochHashes = [...epochHashes, digest];
    }
    const next = {genesis, state, epochHashes,
      signature:sign(wallet.privateKey, checkpointProof(state, epochHashes))};
    save(head, next);
    head = next;
    return block;
  }
  const server = createServer(async (req, res) => {
    function send(code, value) {
      res.writeHead(code, {'content-type':'application/json', 'cache-control':'no-store'});
      res.end(JSON.stringify(value));
    }
    try {
      if (req.method === 'GET' && req.url === '/v1/checkpoint') return send(200, head);
      if (req.method === 'GET' && req.url === '/v1/status') {
        const {chainId, tip, height, providers, epoch, epochTokens, maxOutputTokens} = head.state;
        return send(200, {chainId, tip, height, providers, epoch, epochTokens, maxOutputTokens,
          epochTarget:EPOCH_TOKENS, mode:upstream ? 'follower' : 'sequencer', syncError});
      }
      if (req.method !== 'POST' || req.url !== '/v1/transactions') return send(404, {error:'Route not found'});
      if (!wallet) return send(403, {error:'Read-only follower'});
      if ((req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') {
        return send(415, {error:'Expected application/json'});
      }
      const tx = await jsonBody(req, 16384);
      return send(201, {block:submit(tx)});
    } catch (err) {
      send(400, {error:err.message});
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    if (upstream) await sync();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, listen, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    db.close();
    throw err;
  }
  const interval = upstream ? setInterval(() => { sync().catch(() => {}); }, syncIntervalMs) : undefined;
  const url = 'http://' + (listen.includes(':') ? '[' + listen + ']' : listen) + ':' + server.address().port;
  return {url, sync, async close() {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    await new Promise(resolve => server.close(resolve));
    await syncing?.catch(() => {});
    db.close();
  }};
}
