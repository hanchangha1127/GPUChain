import { hash, sign, verify } from './crypto.mjs';
import { SALE_PRICE_TERMS, SALE_TERMS } from './sale-policy.mjs';
import { STARTER_GRANT_PROTOCOL } from './starter-grants.mjs';
import { canValidate, MAINNET } from './ledger.mjs';
import { isLoopbackEndpoint, normalizeProviderEndpoint } from './provider-endpoint.mjs';

const MAX_AGE_MS = 120_000;
const MAX_CANDIDATES = 12;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function signEnrollment(chainId, wallet, origin, instanceId, issuedAt = Date.now()) {
  const payload = {domain:'gpuchain/validator-enroll/v1', chainId, address:wallet.address,
    origin:normalizeProviderEndpoint(origin), instanceId, issuedAt};
  return {payload, signature:sign(wallet.privateKey,payload)};
}

function publicOrigin(value) {
  if (normalizeProviderEndpoint(value) !== value || !value.startsWith('https://') ||
      isLoopbackEndpoint(value)) throw Error('A canonical public HTTPS validator origin is required');
  const name = new URL(value).hostname;
  // Public testnet nodes use DNS names so their TLS service can move machines.
  if (!name.includes('.') || !/^[a-z0-9.-]+$/.test(name) || /^[0-9.]+$/.test(name) ||
      /\.(?:internal|local|localhost|lan)\.?$/.test(name)) {
    throw Error('A public DNS name is required for enrollment');
  }
}

export function checkEnrollment(intent, state, {now = Date.now(), allowLoopback = false} = {}) {
  const p = intent?.payload;
  if (!p || !INSTANCE_ID.test(p.instanceId) || p.chainId !== state.chainId || p.address === state.sequencer ||
      !canValidate(state,p.address) ||
      !Number.isSafeInteger(p.issuedAt) || p.issuedAt <= now-MAX_AGE_MS || p.issuedAt > now+10_000) {
    throw Error('Expected a fresh enrollment from an authorized validator wallet');
  }
  const expected = {domain:'gpuchain/validator-enroll/v1',chainId:state.chainId,
    address:p.address,origin:p.origin,instanceId:p.instanceId,issuedAt:p.issuedAt};
  if (hash(expected) !== hash(p) || !verify(p.address,p,intent.signature)) {
    throw Error('Invalid enrollment signature');
  }
  if (allowLoopback && isLoopbackEndpoint(p.origin)) {
    if (normalizeProviderEndpoint(p.origin) !== p.origin) throw Error('Expected canonical validator origin');
  } else publicOrigin(p.origin);
  return p;
}

// D1 slot 3 holds only recent opt-ins. Slot 1 holds the independently signed ledger.
// Each update replaces the slot, including expired entries, within a strict size bound.
export async function readCandidates(db) {
  const row = await db.prepare('SELECT tip,checkpoint FROM ledger_head WHERE id=3').first();
  if (!row) return {digest:hash([]),candidates:[]};
  const candidates = JSON.parse(row.checkpoint);
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES || hash(candidates) !== row.tip) {
    throw Error('Enrollment storage mismatch');
  }
  return {digest:row.tip,candidates};
}

export async function recordCandidate(db, intent, now = Date.now()) {
  const candidate = intent.payload;
  const empty = '[]';
  await db.prepare('INSERT OR IGNORE INTO ledger_head (id,tip,checkpoint) VALUES(3,?,?)')
    .bind(hash([]),empty).run();
  const previous = await readCandidates(db);
  const candidates = previous.candidates.filter(({payload}) => payload.issuedAt > now-MAX_AGE_MS);
  const index = candidates.findIndex(({payload}) => payload.address === candidate.address);
  if (candidates.some(({payload}) => payload.address !== candidate.address &&
      (payload.origin === candidate.origin || payload.instanceId === candidate.instanceId))) {
    throw Error('Validator origins and database identities must be distinct');
  }
  const previousIntent = candidates[index]?.payload;
  if (previousIntent && (candidate.instanceId !== previousIntent.instanceId || candidate.issuedAt < previousIntent.issuedAt ||
      (candidate.issuedAt === previousIntent.issuedAt && candidate.origin !== previousIntent.origin))) {
    throw Error('A newer enrollment already exists');
  }
  if (index < 0 && candidates.length >= MAX_CANDIDATES) throw Error('Enrollment window is full');
  const entry = {payload:candidate,signature:intent.signature};
  if (index < 0) candidates.push(entry);
  else candidates[index] = entry;
  const digest = hash(candidates);
  if (digest !== previous.digest) {
    const changed = await db.prepare('UPDATE ledger_head SET tip=?, checkpoint=? WHERE id=3 AND tip=?')
      .bind(digest,JSON.stringify(candidates),previous.digest).run();
    if (changed.meta.changes !== 1) throw Error('Enrollment changed concurrently; retry');
  }
  return {candidates,digest};
}

export async function limitedJson(response,byteLimit) {
  if (!response.ok || !response.body) throw Error('Endpoint did not return a successful response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > byteLimit) { await reader.cancel(); throw Error('Oversized response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk,offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

export async function checkReadiness(candidate, fetchReady = fetch, exactMoney = false, mainnet = false, starterGrants = false, salePrice = false) {
  const challenge = globalThis.crypto.randomUUID().replaceAll('-','');
  const response = await fetchReady(candidate.origin + '/v1/consensus/ready?challenge=' + challenge +
    (exactMoney?'&money=exact':'') + (mainnet?'&stage=mainnet':'') + (starterGrants?'&starter=2':'') +
    (salePrice?'&salePrice=3':''),
    {redirect:'manual',signal:AbortSignal.timeout(3000)});
  const {payload,signature} = await limitedJson(response,4096);
  const expected = {domain:'gpuchain/validator-ready/v1',chainId:candidate.chainId,
    address:candidate.address,origin:candidate.origin,instanceId:candidate.instanceId,challenge};
  if (exactMoney) {
    expected.moneyCodec='nanocoin-decimal-v1';
    expected.saleEscrow=SALE_TERMS;
  }
  if (mainnet) expected.validatorProtocol=MAINNET.validatorProtocol;
  if (starterGrants) expected.starterGrants=STARTER_GRANT_PROTOCOL;
  if (salePrice) expected.salePrice=SALE_PRICE_TERMS;
  if (hash(expected) !== hash(payload) || !verify(candidate.address,expected,signature)) {
    throw Error('Validator did not prove readiness at its announced origin');
  }
  return {address:candidate.address,url:candidate.origin,instanceId:candidate.instanceId};
}
