import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import publicGenesis from '../networks/sites-testnet.json' with {type:'json'};
import bundledDirectory from '../networks/testnet-endpoints.json' with {type:'json'};
import { authenticate, verifyAdvance } from './checkpoint.mjs';
import { verifyActivation } from './consensus.mjs';
import { hash } from './crypto.mjs';
import { requestJson } from './http.mjs';
import { fetchSignedCheckpoint } from './checkpoint-fetch.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { directoryOrigins, DIRECTORY_URL, PEER_LIMIT } from './peer-directory.mjs';

export { publicGenesis };
export const publicGenesisPath = fileURLToPath(new URL('../networks/sites-testnet.json', import.meta.url));
const PROBE_TIMEOUT = 3500;
const REFRESH_INTERVAL = 24*60*60*1000;
const RETRY_INTERVAL = 5*60*1000;

export function bundledMainnetAnchor(chainId) {
  if (chainId!==publicGenesis.hash) return null;
  let bytes;
  try { bytes=readFileSync(new URL('../networks/mainnet-anchor.json',import.meta.url),'utf8'); }
  catch (err) { if (err.code==='ENOENT') return null; throw err; }
  const anchor=authenticate(JSON.parse(bytes),chainId);
  if (anchor.state.networkStage!=='mainnet' || anchor.authority ||
      anchor.state.height!==anchor.state.mainnetPromotion.payload.anchorHeight+1) {
    throw Error('Invalid bundled mainnet launch checkpoint');
  }
  return anchor;
}

function openCache(dir) {
  mkdirSync(dir, {recursive:true, mode:0o700});
  const db = new DatabaseSync(join(dir, 'discovery.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=4000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS networks (
        chain TEXT PRIMARY KEY, mark TEXT NOT NULL, peers TEXT NOT NULL, next_refresh INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS authorities (chain TEXT PRIMARY KEY, certificate TEXT NOT NULL)`);
    if (!db.prepare('PRAGMA table_info(networks)').all().some(field => field.name === 'next_refresh')) {
      db.exec('ALTER TABLE networks ADD COLUMN next_refresh INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('COMMIT');
    const select = db.prepare('SELECT mark, peers, next_refresh FROM networks WHERE chain=?');
    const save = db.prepare(`INSERT INTO networks (chain,mark,peers) VALUES (?, ?, ?)
      ON CONFLICT(chain) DO UPDATE SET mark=excluded.mark, peers=excluded.peers`);
    const schedule = db.prepare('UPDATE networks SET next_refresh=max(next_refresh, ?) WHERE chain=?');
    const getCertificate = db.prepare('SELECT certificate FROM authorities WHERE chain=?');
    const rememberCertificate = db.prepare('INSERT OR IGNORE INTO authorities VALUES (?,?)');
    function authority(chain) {
      const row = getCertificate.get(chain);
      return row ? JSON.parse(row.certificate) : null;
    }
    function get(chain) {
      const row = select.get(chain);
      return row ? {mark:JSON.parse(row.mark), peers:JSON.parse(row.peers), nextRefresh:row.next_refresh} :
        {mark:null, peers:[], nextRefresh:0};
    }
    return {db,get,schedule,authority, pin(chain,certificate) {
      rememberCertificate.run(chain,JSON.stringify(certificate));
      if (hash(authority(chain)) !== hash(certificate)) throw Error('Conflicting signed consensus authority');
    }, update(chain, observed, origins) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = get(chain);
        if (previous.mark) checkHistory([...observed, previous.mark]);
        const best = observed.at(-1);
        const mark = previous.mark && (previous.mark.height > best.height ||
          (previous.mark.height === best.height && previous.mark.authority && !best.authority)) ? previous.mark : best;
        const peers = [...new Set([...(mark.members ?? []),...origins,...previous.peers])].slice(0, PEER_LIMIT);
        if (JSON.stringify(mark) !== JSON.stringify(previous.mark) ||
            JSON.stringify(peers) !== JSON.stringify(previous.peers)) {
          save.run(chain, JSON.stringify(mark), JSON.stringify(peers));
        }
        db.exec('COMMIT');
        return mark;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }};
  } catch (err) {
    db.close();
    throw err;
  }
}

function checkpointMark(head) {
  const {state,epochHashes,authority} = head;
  const mark = {height:state.height, tip:state.tip, stateHash:hash(state),
    totalWorkTokens:state.totalWorkTokens, epochHashes,networkStage:state.networkStage ?? null};
  if (state.mainnetPromotion) {
    const {anchorHeight,anchorTip,anchorStateHash}=state.mainnetPromotion.payload;
    Object.assign(mark,{promotion:hash(state.mainnetPromotion),promotionHeight:anchorHeight,
      promotionTip:anchorTip,promotionStateHash:anchorStateHash});
  }
  return authority ? {...mark,authority:hash(authority),anchorHeight:authority.payload.anchorHeight,
    anchorTip:authority.payload.anchorTip,anchorHash:authority.payload.anchorHash,
    members:authority.payload.validators.map(v=>v.url)} : {...mark,checkpointHash:hash(head)};
}

function checkHistory(marks) {
  marks.sort((a,b) => a.height-b.height || Number(Boolean(a.authority))-Number(Boolean(b.authority)));
  const launch=marks.find(m=>m.promotion);
  if (launch) {
    for (const m of marks) {
      if (m.promotion ? m.promotion!==launch.promotion : (m.networkStage===null &&
          (m.height>launch.promotionHeight || (m.height===launch.promotionHeight &&
          (m.tip!==launch.promotionTip || m.stateHash!==launch.promotionStateHash))))) {
        throw Error('Conflicting signed mainnet promotion or predecessor');
      }
    }
  }
  const committee = marks.find(m=>m.authority);
  if (committee) {
    for (const m of marks) {
      if (m.authority ? m.authority !== committee.authority :
        (m.height > committee.anchorHeight || (m.height === committee.anchorHeight &&
          (m.tip !== committee.anchorTip || (m.checkpointHash && m.checkpointHash !== committee.anchorHash))))) {
        throw Error('Conflicting signed consensus authority or activation anchor');
      }
    }
  }
  for (let i=1;i<marks.length;i++) {
    const older = marks[i-1], newer = marks[i];
    if (older.height === newer.height && (older.tip !== newer.tip || older.stateHash !== newer.stateHash ||
        older.epochHashes.length !== newer.epochHashes.length)) {
      throw Error('Conflicting signed checkpoints at height ' + older.height);
    }
    if (older.totalWorkTokens > newer.totalWorkTokens ||
        !older.epochHashes.every((digest,index) => newer.epochHashes[index] === digest)) {
      throw Error('Conflicting signed epoch history');
    }
  }
}

async function probeStatus(url, chainId, timeoutMs) {
  const status = await requestJson(url + '/v1/status', {timeoutMs, maxBytes:1024*1024});
  if (status.chainId !== chainId) throw Error('Status belongs to a different chain');
  return {url,mode:status.mode,address:status.address,instanceId:status.instanceId,height:status.height,tip:status.tip};
}

// All discovery requests are reads. A transaction is signed and submitted by the caller
// to one selected endpoint. The role from /status is only a routing hint.
export async function resolvePublicLedger({
  write = false, activation = false, excludeInstanceId, chainId = publicGenesis.hash, directory = bundledDirectory,
  cacheDir = process.env.GPUCHAIN_STATE_DIR || join(homedir(), '.gpuchain'),
  seeds = process.env.GPUCHAIN_LEDGER_URLS || '',
  refresh = () => requestJson(DIRECTORY_URL, {timeoutMs:PROBE_TIMEOUT, maxBytes:32*1024}),
  now = Date.now()
} = {}) {
  const explicit = seeds.split(',').map(s => s.trim()).filter(Boolean);
  if (explicit.length > PEER_LIMIT) throw Error('Too many GPUCHAIN_LEDGER_URLS entries');
  const configured = [...explicit.map(normalizeProviderEndpoint), ...directoryOrigins(directory, chainId)];
  const launchAnchor=bundledMainnetAnchor(chainId);
  const cache = openCache(cacheDir);
  const checked = new Set(), observed = [];
  const pendingPins = [];
  if (Object.hasOwn(directory,'authority')) pendingPins.push(directory.authority);
  function verifyPins(genesis) {
    for (const certificate of pendingPins) {
      verifyActivation(certificate,genesis);
      cache.pin(chainId,certificate);
    }
    pendingPins.length = 0;
  }
  let latest = null;
  async function inspect(origins) {
    if (latest || chainId === publicGenesis.hash) verifyPins(latest?.genesis ?? publicGenesis);
    const known = cache.authority(chainId);
    const roster = known?.payload.validators.map(v=>v.url) ?? [];
    const fresh = [...new Set([...roster,...origins])].filter(url => !checked.has(url));
    const deadline = performance.now() + 12_000;
    const timeLeft = () => Math.max(0,Math.min(PROBE_TIMEOUT,Math.floor(deadline-performance.now())));
    while (fresh.length && timeLeft()) {
      const batch = fresh.splice(0,8);
      batch.forEach(url => checked.add(url));
      const results = await Promise.allSettled(batch.map(url => probeStatus(url,chainId,timeLeft() || 1)));
      // Probe small status documents concurrently. Stream at most one full checkpoint
      // response at a time and retain only the highest checkpoint for the caller.
      for (const result of results) {
        if (result.status === 'rejected' || !timeLeft()) continue;
        const {url} = result.value;
        if (excludeInstanceId && result.value.instanceId === excludeInstanceId) continue;
        let checkpoint;
        try {
          checkpoint = await fetchSignedCheckpoint(url,chainId,timeLeft() || 1,result.value);
          if (launchAnchor) verifyAdvance(launchAnchor,checkpoint);
        } catch { continue; }
        verifyPins(checkpoint.genesis);
        if (checkpoint.authority) cache.pin(chainId,checkpoint.authority);
        const mark = checkpointMark(checkpoint);
        observed.push({...result.value,mark});
        if (!latest || mark.height > latest.state.height ||
            (mark.height === latest.state.height && checkpoint.authority && !latest.authority)) latest = checkpoint;
        for (const origin of mark.members ?? []) {
          if (!checked.has(origin) && !fresh.includes(origin)) fresh.push(origin);
        }
      }
    }
    if (!latest) return;
    const pin = cache.authority(chainId);
    if (pin) {
      const {anchorHeight,anchorHash} = pin.payload;
      if (observed.some(({mark})=>mark.authority ? mark.authority !== hash(pin) :
        mark.height > anchorHeight || (mark.height === anchorHeight && mark.checkpointHash !== anchorHash))) {
        throw Error('Conflicting signed consensus authority or activation anchor');
      }
    }
    const marks = observed.map(r => r.mark);
    checkHistory(marks);
    const watermark = cache.update(chainId,marks,observed.map(r => r.url));
    if (watermark.height !== latest.state.height || Boolean(watermark.authority) !== Boolean(latest.authority)) return;
    if (pin && (!latest.authority || hash(pin) !== hash(latest.authority))) return;
    const current = observed.filter(r => r.mark.height === latest.state.height && r.mark.authority === watermark.authority);
    const writer = watermark.authority ? current.find(r => r.mode === 'validator' &&
      latest.authority.payload.validators.some(member => member.url === r.url && member.address === r.address &&
        member.instanceId === r.instanceId)) :
      current.find(r => r.mode === 'sequencer');
    const match = writer ?? (!write && current.find(r => r.mode === 'follower' || r.mode === 'verifier')) ??
      (!write && activation && current.find(r => r.mode === 'retired' && r.mark.authority));
    if (match) return {url:match.url, mode:match.mode, state:latest.state, checkpoint:latest};
  }
  try {
    if (launchAnchor) cache.update(chainId,[checkpointMark(launchAnchor)],[]);
    const previous = cache.get(chainId);
    let match = await inspect([...configured,...previous.peers]);
    // Learn independent peers while the original host is still healthy. A missing
    // eligible writer or a stale cache always triggers immediate directory refresh.
    if (refresh && (!match || now >= previous.nextRefresh)) {
      let updated = null;
      try {
        const record = await refresh();
        updated = directoryOrigins(record,chainId);
        if (Object.hasOwn(record,'authority')) pendingPins.push(record.authority);
      } catch { /* Offline directory. */ }
      // Another process may have observed a newer tip during the directory request.
      match = await inspect(updated ?? []);
      cache.schedule.run(now + (updated ? REFRESH_INTERVAL : RETRY_INTERVAL),chainId);
    }
    if (match) return match;
    throw Error('No reachable ' + (write ? 'writable ' : '') +
      'ledger at or above the last verified checkpoint for this network. Set GPUCHAIN_LEDGER_URLS to a current same-chain endpoint.');
  } finally {
    cache.db.close();
  }
}
