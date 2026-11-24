import { addressFromPrivateKey, hash } from '../../src/crypto.mjs';
import { authenticate, nextCheckpoint } from '../../src/checkpoint.mjs';
import { activateCheckpoint, createActivation } from '../../src/consensus.mjs';
import { checkEnrollment, checkReadiness, limitedJson, readCandidates, recordCandidate } from '../../src/enrollment.mjs';
import { DIRECTORY_URL, directoryOrigins } from '../../src/peer-directory.mjs';
import { EPOCH_TOKENS, replay } from '../../src/ledger.mjs';

const MAX_TX_BYTES = 16_384;
// Leave margin for SQLite row and index overhead under D1's 2 MB per-row limit.
const MAX_HEAD_BYTES = 1_900_000;
const noCache = {'cache-control':'no-store', 'x-content-type-options':'nosniff'};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return Response.json(value, {status, headers:noCache});
}

async function transactionBody(request) {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Expected application/json');
  if (Number(request.headers.get('content-length')) > MAX_TX_BYTES) {
    throw new HttpError(413, 'Transaction is too large');
  }
  if (!request.body) throw new HttpError(400, 'Missing transaction');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_TX_BYTES);
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (length + value.length > MAX_TX_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'Transaction is too large');
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0, length)));
  } catch {
    throw new HttpError(400, 'Invalid JSON transaction');
  }
}

function setup(env) {
  const genesis = JSON.parse(env.GPUCHAIN_GENESIS_JSON);
  const wallet = {privateKey:env.GPUCHAIN_SIGNER_PKCS8, address:genesis.payload.sequencer};
  if (addressFromPrivateKey(wallet.privateKey) !== wallet.address) throw Error('Signer mismatch');
  const state = replay([genesis], genesis.hash);
  return {wallet, initial:{genesis, state, epochHashes:[], signature:null}};
}

async function readHead(db, initial) {
  const select = db.prepare('SELECT tip, checkpoint FROM ledger_head WHERE id = 1');
  let row = await select.first();
  if (!row) {
    await db.prepare('INSERT OR IGNORE INTO ledger_head (id, tip, checkpoint) VALUES (1, ?, ?)')
      .bind(initial.state.tip, JSON.stringify(initial)).run();
    row = await select.first();
  }
  const head = authenticate(JSON.parse(row.checkpoint), initial.genesis.hash);
  // A non-hash tip permanently fences older revisions' compare-and-swap writes.
  const expected = head.authority ? 'retired:' + hash(head.authority) : head.state.tip;
  if (row.tip !== expected) throw Error('Invalid stored chain tip');
  return head;
}

function status(state, retired) {
  const {chainId, tip, height, providers, epoch, epochTokens, totalWorkTokens, maxOutputTokens} = state;
  return {mode:retired ? 'retired' : 'sequencer', chainId, tip, height, providers, epoch, epochTokens, totalWorkTokens,
    maxOutputTokens, epochTarget:EPOCH_TOKENS, syncError:null, inference:false};
}

function homepage(state, retired) {
  const body = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>GPUChain ledger</title>
<style>body{margin:4rem auto;padding:0 1.5rem;max-width:48rem;font:1rem/1.6 system-ui;color:#192b3a;background:#f5f9fc}
h1{font-size:2rem;margin:0}dl{background:white;padding:1.4rem;border:1px solid #bdcbd5;border-radius:.6rem}
dt{font-weight:650}dd{margin:0 0 .8rem;overflow-wrap:anywhere}a{color:#045a84}nav{display:flex;gap:1.3rem;flex-wrap:wrap}</style>
<main><h1>GPUChain ledger</h1><p>${retired ? 'Participating validators now settle transactions. This endpoint serves the certified transition checkpoint.' : 'This sequencer settles signed transfers and inference receipts.'}</p>
<dl><dt>Genesis hash</dt><dd><code>${state.chainId}</code></dd>
<dt>Accepted transactions</dt><dd>${state.height}</dd><dt>Registered providers</dt><dd>${state.providers.length}</dd>
<dt>Completed epochs</dt><dd>${state.epoch}</dd><dt>Eligible tokens in current epoch</dt>
<dd>${state.epochTokens} / 1,000,000,000</dd></dl>
<nav><a href="/v1/genesis">Genesis file</a><a href="/v1/checkpoint">Signed checkpoint</a>
<a href="/v1/status">Node status</a></nav></main></html>`;
  return new Response(body, {headers:{...noCache, 'content-type':'text/html; charset=utf-8',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"}});
}

async function enroll(head, intent, wallet, db, {fetchReady,allowLoopback,readDirectory}) {
  if (head.authority) return json({active:true,checkpoint:head});
  let member;
  try { member = checkEnrollment(intent,head.state,{allowLoopback}); }
  catch (err) { throw new HttpError(400,err.message); }
  let ready;
  try { ready = await checkReadiness(member,fetchReady); }
  catch { throw new HttpError(409,'Cannot verify validator readiness at the signed origin'); }
  let roster;
  try { roster = await recordCandidate(db,{payload:member,signature:intent.signature}); }
  catch (err) { throw new HttpError(409,err.message); }
  if (roster.candidates.length < 3) return json({active:false,checkpoint:head});

  const probes = await Promise.allSettled(roster.candidates.map(item=>item.payload)
    .filter(candidate => head.state.providers.includes(candidate.address))
    .map(candidate => candidate.address === ready.address ? ready : checkReadiness(candidate,fetchReady)));
  const reachable = probes.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (reachable.length < 3) return json({active:false,checkpoint:head});
  let published = [];
  try { published = directoryOrigins(await readDirectory(),head.state.chainId); }
  catch { /* Retry enrollment when clients can discover the committee. */ }
  const validators = reachable.filter(v => published.includes(v.url)).slice(0,3);
  if (validators.length < 3) return json({active:false,checkpoint:head,waitingFor:'published-validator-origins'});
  const authority = createActivation(head,validators,wallet);
  const checkpoint = activateCheckpoint(head,authority);
  const encoded = JSON.stringify(checkpoint);
  if (new TextEncoder().encode(encoded).length > MAX_HEAD_BYTES) {
    throw new HttpError(507,'Activated checkpoint exceeds the capacity of this hosted node');
  }
  const changed = await db.prepare(`UPDATE ledger_head SET tip=?,checkpoint=? WHERE id=1 AND tip=?
    AND EXISTS(SELECT 1 FROM ledger_head WHERE id=3 AND tip=?)`)
    .bind('retired:' + hash(authority),encoded,head.state.tip,roster.digest).run();
  if (changed.meta.changes !== 1) throw new HttpError(409,'Ledger or enrollment changed concurrently; retry');
  // Do not return signatures authorizing the committee before its durable fence commits.
  return json({active:true,checkpoint});
}

async function dispatch(request, env, options) {
  const path = new URL(request.url).pathname;
  const isWrite = request.method === 'POST' && ['/v1/transactions','/v1/consensus/enroll'].includes(path);
  const isRead = request.method === 'GET' &&
    ['/', '/v1/status', '/v1/genesis', '/v1/checkpoint','/v1/consensus/candidates'].includes(path);
  if (!isRead && !isWrite) throw new HttpError(404, 'Route not found');
  const tx = isWrite ? await transactionBody(request) : undefined;
  const {wallet, initial} = setup(env);
  // Reading the primary avoids routing decisions based on lagging replicas.
  const db = env.DB.withSession('first-primary');
  const head = await readHead(db, initial);
  if (isRead) {
    if (path === '/') return homepage(head.state,Boolean(head.authority));
    if (path === '/v1/checkpoint') return json(head);
    if (path === '/v1/genesis') return json(head.genesis);
    if (path === '/v1/consensus/candidates') {
      const {candidates} = await readCandidates(db);
      return json({chainId:head.state.chainId, candidates:candidates.filter(item => {
        try { checkEnrollment(item,head.state,options); return true; } catch { return false; }
      })});
    }
    return json(status(head.state,Boolean(head.authority)));
  }
  if (path === '/v1/consensus/enroll') return enroll(head,tx,wallet,db,options);
  if (head.authority) throw new HttpError(409,'This sequencer retired; submit to a certified validator');
  let candidate;
  try {
    candidate = nextCheckpoint(head, tx, wallet);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  const {next, block} = candidate;
  const checkpoint = JSON.stringify(next);
  if (new TextEncoder().encode(checkpoint).length > MAX_HEAD_BYTES) {
    throw new HttpError(507, 'Checkpoint exceeds the capacity of this hosted node');
  }
  const result = await db.prepare('UPDATE ledger_head SET tip = ?, checkpoint = ? WHERE id = 1 AND tip = ?')
    .bind(next.state.tip, checkpoint, head.state.tip).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'Ledger advanced concurrently; retry with current state');
  return json({block}, 201);
}

function publicDirectoryReader() {
  let freshUntil = 0;
  let cached = null;
  return async () => {
    if (Date.now() < freshUntil) return cached;
    freshUntil = Date.now()+30_000;
    try {
      const response = await fetch(DIRECTORY_URL,{
        redirect:'error',credentials:'omit',signal:AbortSignal.timeout(3000)
      });
      cached = await limitedJson(response,32*1024);
    } catch { cached = null; }
    return cached;
  };
}

export function createLedgerWorker({fetchReady = fetch, allowLoopback = false, readDirectory = publicDirectoryReader()} = {}) {
  return {async fetch(request, env) {
    try {
      return await dispatch(request, env, {fetchReady,allowLoopback,readDirectory});
    } catch (err) {
      if (err instanceof HttpError) return json({error:err.message}, err.status);
      // Storage and deployment errors can include internal binding or secret details.
      return json({error:'Hosted ledger storage or configuration is unavailable'}, 503);
    }
  }};
}

export default createLedgerWorker();
