import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addressFromPrivateKey, hash } from './crypto.mjs';
import { EPOCH_TOKENS, replay } from './ledger.mjs';
import { bundledMainnetAnchor } from './public-network.mjs';

import { authenticate, checkpointHttp, nextCheckpoint, verifyAdvance } from './checkpoint.mjs';
import { fetchSignedCheckpoint } from './checkpoint-fetch.mjs';
import { outcomeRoute, sequencerOutcome } from './transaction-outcome.mjs';
import { openOutcomes } from './local-outcomes.mjs';

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

function ledgerOrigin(endpoint) {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  check((url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'Use a ledger HTTPS origin, or HTTP on loopback');
  return url.origin;
}

export async function readCheckpoint(url, chainId) {
  const checkpoint=await fetchSignedCheckpoint(ledgerOrigin(url),chainId);
  const launch=bundledMainnetAnchor(chainId);
  if (launch) verifyAdvance(launch,checkpoint);
  return checkpoint;
}

export async function readVerifiedState(url, genesisHash) {
  return (await readCheckpoint(url, genesisHash)).state;
}

// Store one current state and one 32-byte digest per completed billion-token epoch.
// A bounded window of inference block commitments is atomic with state and epoch
// updates. The original transaction and both parties' signatures stay off disk.
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
    if (!db.prepare("PRAGMA table_info(current_state)").all().some(column => column.name === 'certificates')) {
      db.exec('ALTER TABLE current_state ADD COLUMN certificates TEXT');
    }
    db.prepare('INSERT OR IGNORE INTO current_state(id,state,signature) VALUES (1, ?, NULL)').run(JSON.stringify(genesisState));
    const read = db.prepare('SELECT state, signature, certificates FROM current_state WHERE id=1');
    const readEpochs = db.prepare('SELECT digest FROM epoch ORDER BY number');
    const update = db.prepare('UPDATE current_state SET state=?, signature=?, certificates=? WHERE id=1');
    const addEpoch = db.prepare('INSERT INTO epoch VALUES (?, ?)');
    function current() {
      const row = read.get();
      return {genesis, ...JSON.parse(row.certificates ?? '{}'), state:JSON.parse(row.state), signature:row.signature,
        epochHashes:readEpochs.all().map(row => Buffer.from(row.digest).toString('hex'))};
    }
    const outcomes=openOutcomes(db);
    function save(prior, next, proof) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = read.get();
        const previousCertificates = JSON.parse(row.certificates ?? '{}');
        check(JSON.parse(row.state).tip === prior.state.tip &&
          hash(previousCertificates.authority ?? null) === hash(prior.authority ?? null),
        'Ledger advanced concurrently; retry');
        for (let i = prior.epochHashes.length; i < next.epochHashes.length; i++) {
          addEpoch.run(i + 1, Buffer.from(next.epochHashes[i], 'hex'));
        }
        update.run(JSON.stringify(next.state), next.signature, next.authority
          ? JSON.stringify({authority:next.authority,consensus:next.consensus}) : null);
        if (proof) outcomes.save(next.state.height,proof);
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
    return {db, save, checkpoint, outcomes};
  } catch (err) {
    db.close();
    throw err;
  }
}

export async function startNode({dir, genesis, wallet, listen = '127.0.0.1', port = 8787,
  upstream, resolveUpstreamCheckpoint, syncIntervalMs = 5000}) {
  const follower = Boolean(upstream || resolveUpstreamCheckpoint);
  check(Boolean(wallet) !== follower && !(upstream && resolveUpstreamCheckpoint),
    'Specify a sequencer wallet or one follower upstream');
  if (wallet) check(wallet.address === genesis.payload.sequencer &&
    addressFromPrivateKey(wallet.privateKey) === wallet.address, 'Incorrect sequencer key');
  if (upstream) ledgerOrigin(upstream);
  const {db, save, checkpoint, outcomes} = openStore(dir, genesis);
  let head = checkpoint;
  let syncing;
  let closed = false;
  let syncError = null;
  async function advanceFollower() {
    const next = resolveUpstreamCheckpoint ? authenticate(await resolveUpstreamCheckpoint(), genesis.hash)
      : await readCheckpoint(upstream, genesis.hash);
    verifyAdvance(head, next);
    if (next.state.tip === head.state.tip && Boolean(next.authority) === Boolean(head.authority)) return;
    if (!closed) {
      save(head, next);
      head = next;
    }
  }
  async function sync() {
    if (!follower || closed) return;
    if (!syncing) syncing = advanceFollower().then(() => { syncError = null; }).catch(err => {
      syncError = err.message;
      throw err;
    }).finally(() => { syncing = undefined; });
    return syncing;
  }
  function submit(tx) {
    const {block, next} = nextCheckpoint(head, tx, wallet);
    save(head, next,['inference','transfer'].includes(tx.payload.type)?sequencerOutcome(block):undefined);
    head = next;
    return block;
  }
  const server = createServer(async (req, res) => {
    function send(code, value) {
      res.writeHead(code, {'content-type':'application/json', 'cache-control':'no-store'});
      res.end(JSON.stringify(value));
    }
    try {
      if (req.method === 'GET' && req.url === '/v1/genesis') return send(200, genesis);
      if (req.method === 'GET' && req.url === '/v1/checkpoint') {
        const reply=checkpointHttp(head,req.headers['if-none-match']);
        res.writeHead(reply.status,reply.headers);
        return res.end(reply.body);
      }
      if (req.method==='GET' && outcomeRoute.test(req.url)) {
        const proof=outcomes.find(outcomeRoute.exec(req.url)[1]);
        return proof?send(200,proof):send(404,{error:'Transaction outcome unavailable'});
      }
      if (req.method === 'GET' && req.url === '/v1/status') {
        const {chainId, tip, height, providers, epoch, epochTokens, maxOutputTokens} = head.state;
        return send(200, {chainId, tip, height, providers, epoch, epochTokens, maxOutputTokens,
          epochTarget:EPOCH_TOKENS, mode:follower ? 'follower' : 'sequencer', syncError});
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
    if (follower) await sync();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, listen, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    db.close();
    throw err;
  }
  const interval = follower ? setInterval(() => { sync().catch(() => {}); }, syncIntervalMs) : undefined;
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
