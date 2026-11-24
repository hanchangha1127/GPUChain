import { randomUUID } from 'node:crypto';
import { hash, sign, verify } from './crypto.mjs';
import { decodeAmount, encodeAmount, RESERVE_NANOCOINS } from './amount.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

export const MODEL = 'Qwen3.8-Flash-Next';
export const CONTEXT = 262_144;
export const EPOCH_TOKENS = 1_000_000_000;
export const NANOCOINS = 1_000_000_000;
export const RATES = Object.freeze({input: 150, output: 470, cached: 16});
export const DISTRIBUTION_RESERVE = Object.freeze({
  chainId:'a05901c9ffd6ba582e9d3951c0ac84927543b48b8be8a9fb43c3c5c7d49e8460',
  address:'95da9783a4ab7c8115ce1f4e599b2ab7f688779976d6221ea456d183429c7aae',
  amount:RESERVE_NANOCOINS,
  claim:'gpuchain:public-testnet:distribution-reserve:v1',
});
const PROTOCOL = 'gpuchain/1';
const HEX64 = /^[0-9a-f]{64}$/;
const RESERVE_ISSUER = '0000b0bb4901e3e6fcdc6ce7c7422bede26068d8ae9e04c5f4aa04e221a33f5e';

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

function record(value) {
  return value && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fields(value, names) {
  requireValue(record(value) && Object.keys(value).length === names.length &&
    names.every(name => Object.hasOwn(value, name)), 'Invalid fields: expected ' + names.join(', '));
}

function hex64(value, label) {
  requireValue(typeof value === 'string' && HEX64.test(value), 'Invalid ' + label);
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, 'Invalid ' + label);
  return value;
}

function signature(address, payload, signed, label) {
  requireValue(verify(address, payload, signed), 'Invalid ' + label + ' signature');
}

function immutable(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const child of Object.values(obj)) immutable(child);
    Object.freeze(obj);
  }
  return obj;
}

export function charge({inputTokens, cachedTokens, outputTokens}) {
  integer(inputTokens, 'inputTokens', 0, CONTEXT);
  integer(cachedTokens, 'cachedTokens', 0, inputTokens);
  integer(outputTokens, 'outputTokens', 0, CONTEXT - inputTokens);
  return (inputTokens - cachedTokens) * RATES.input + cachedTokens * RATES.cached + outputTokens * RATES.output;
}

function signedBlock(height, previousHash, payload, wallet) {
  const header = {height, previousHash, payload: structuredClone(payload)};
  const body = {...header, signature: sign(wallet.privateKey, header)};
  signature(wallet.address, header, body.signature, 'wallet');
  return immutable({...body, hash: hash(body)});
}

function checkBlock(block, height, previousHash, signer) {
  fields(block, ['height', 'previousHash', 'payload', 'signature', 'hash']);
  requireValue(block.height === height && block.previousHash === previousHash, 'Invalid block linkage');
  const header = {height, previousHash, payload: block.payload};
  requireValue(block.hash === hash({...header, signature: block.signature}), 'Invalid block hash');
  signature(signer, header, block.signature, 'block');
}

/** Authenticate a standalone acknowledgement. Use applyBlock to also verify state continuity. */
export function verifyBlock(block, sequencerAddress) {
  integer(block.height, 'block height');
  if (block.height === 0) requireValue(block.previousHash === null, 'Invalid genesis link');
  else hex64(block.previousHash, 'previous block hash');
  checkBlock(block, block.height, block.previousHash, sequencerAddress);
  return true;
}

function validateGenesis(payload) {
  fields(payload, ['protocol', 'networkId', 'sequencer', 'allocations', 'providers', 'maxOutputTokens']);
  requireValue(payload.protocol === PROTOCOL, 'Unknown protocol');
  requireValue(typeof payload.networkId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(payload.networkId),
    'Invalid networkId');
  hex64(payload.sequencer, 'sequencer address');
  integer(payload.maxOutputTokens, 'maxOutputTokens', 1, CONTEXT);
  requireValue(Array.isArray(payload.providers) && new Set(payload.providers).size === payload.providers.length,
    'Invalid or duplicate providers');
  for (const provider of payload.providers) hex64(provider, 'provider address');
  requireValue(record(payload.allocations), 'Invalid genesis allocations');
  let supply = 0;
  for (const [address, amount] of Object.entries(payload.allocations)) {
    hex64(address, 'allocation address');
    supply = integer(supply + integer(amount, 'allocation'), 'total supply');
  }
  return supply;
}

export function createGenesis(wallet, {allocations, providers, maxOutputTokens = CONTEXT, networkId = randomUUID()}) {
  const payload = {protocol: PROTOCOL, networkId, sequencer: wallet.address, allocations, providers, maxOutputTokens};
  validateGenesis(payload);
  return signedBlock(0, null, payload, wallet);
}

function genesisState(block, trustedGenesisHash) {
  if (trustedGenesisHash !== undefined) {
    hex64(trustedGenesisHash, 'trusted genesis hash');
    requireValue(block.hash === trustedGenesisHash, 'Genesis hash does not match trusted genesis');
  }
  const p = block.payload;
  const supply = validateGenesis(p);
  checkBlock(block, 0, null, p.sequencer);
  return immutable({
    chainId: block.hash, tip: block.hash, height: 0, networkId: p.networkId, sequencer: p.sequencer,
    providers: [...p.providers], balances: {...p.allocations}, supply, nonces: {}, totalWorkTokens: 0,
    epoch: 0, epochTokens: 0, maxOutputTokens: p.maxOutputTokens, pendingMaxOutputTokens: null,
  });
}

function pay(state, from, to, amount) {
  hex64(to, 'recipient');
  requireValue(from !== to, 'Sender and recipient must be different');
  const n = decodeAmount(amount, 'transfer amount');
  requireValue(n > 0n, 'Invalid transfer amount');
  const balance = decodeAmount(state.balances[from] ?? 0);
  requireValue(balance >= n, 'Insufficient balance');
  return {...state.balances, [from]: encodeAmount(balance - n),
    [to]: encodeAmount(decodeAmount(state.balances[to] ?? 0) + n, 'recipient balance')};
}

/** Compute the fixed reserve effect. The enclosing transition checks the signed nonce and sender. */
export function distributionReserveEffect(state, payload) {
  const r = DISTRIBUTION_RESERVE;
  requireValue(state.chainId === r.chainId && payload.chainId === r.chainId,
    'Reserve issuance requires the original public testnet');
  requireValue(payload.type === 'issue-reserve' && payload.from === RESERVE_ISSUER && payload.from === state.sequencer,
    'Only the genesis sequencer can issue the reserve');
  requireValue(payload.claim === r.claim && payload.to === r.address && payload.amount === r.amount,
    'Invalid distribution reserve terms');
  requireValue(!Object.hasOwn(state,'reserveClaim'), 'Distribution reserve already issued');
  requireValue(state.supply === NANOCOINS, 'Unexpected pre-issuance testnet supply');
  const units = decodeAmount(r.amount);
  return {
    reserveClaim:r.claim, supply:encodeAmount(decodeAmount(state.supply) + units),
    balances:{...state.balances,[r.address]:encodeAmount(decodeAmount(state.balances[r.address] ?? 0) + units)},
  };
}

const BASE = ['type', 'from', 'chainId', 'nonce'];
export function canValidate(state, address) {
  return address !== state.sequencer &&
    (state.providers.includes(address) || (state.validatorAddresses ?? []).includes(address));
}

const EXTRA = Object.freeze({
  transfer: ['to', 'amount'],
  'issue-reserve': ['to', 'amount', 'claim'],
  'add-provider': ['provider'],
  'add-validator': ['validator'],
  'set-provider-endpoint': ['provider', 'endpoint'],
  inference: ['provider', 'model', 'contextWindow', 'requestHash', 'responseHash', 'inputTokens', 'cachedTokens', 'outputTokens'],
  settings: ['maxOutputTokens'],
});

function transition(state, tx) {
  const p = tx?.payload;
  requireValue(record(p) && typeof p.type === 'string' && Object.hasOwn(EXTRA, p.type), 'Unknown transaction type');
  const expected = [...BASE, ...EXTRA[p.type]];
  if (p.type === 'add-provider' && Object.hasOwn(p, 'endpoint')) expected.push('endpoint');
  fields(p, expected);
  fields(tx, p.type === 'inference' ? ['payload', 'signature', 'providerSignature'] : ['payload', 'signature']);
  requireValue(p.chainId === state.chainId, 'Invalid chainId');
  hex64(p.from, 'sender');
  integer(p.nonce, 'nonce', 1);
  requireValue(p.nonce === (state.nonces[p.from] ?? 0) + 1, 'Unexpected nonce');
  signature(p.from, p, tx.signature, 'sender');
  const next = {...state, nonces: {...state.nonces, [p.from]: p.nonce}};
  if (p.type === 'transfer') {
    next.balances = pay(state, p.from, p.to, p.amount);
  } else if (p.type === 'issue-reserve') {
    Object.assign(next,distributionReserveEffect(state,p));
  } else if (p.type === 'add-validator') {
    requireValue(p.from === state.sequencer, 'Only the sequencer can authorize a validator');
    hex64(p.validator, 'validator address');
    requireValue(p.validator !== state.sequencer, 'Bootstrap signer cannot be a validator');
    requireValue(!canValidate(state,p.validator), 'Validator already authorized');
    next.validatorAddresses = [...(state.validatorAddresses ?? []),p.validator];
  } else if (p.type === 'add-provider' || p.type === 'set-provider-endpoint') {
    requireValue(p.from === state.sequencer, 'Only the sequencer can register a provider or set its endpoint');
    hex64(p.provider, 'provider address');
    if (p.type === 'add-provider') {
      requireValue(!state.providers.includes(p.provider), 'Provider already registered');
      next.providers = [...state.providers, p.provider];
    } else {
      requireValue(state.providers.includes(p.provider), 'Unregistered provider');
    }
    if (p.endpoint === null && p.type === 'set-provider-endpoint') {
      const endpoints = {...state.providerEndpoints};
      delete endpoints[p.provider];
      if (Object.keys(endpoints).length) next.providerEndpoints = endpoints;
      else delete next.providerEndpoints;
    } else if (Object.hasOwn(p, 'endpoint')) {
      requireValue(normalizeProviderEndpoint(p.endpoint) === p.endpoint, 'Expected a canonical provider origin');
      next.providerEndpoints = {...state.providerEndpoints, [p.provider]: p.endpoint};
    }
  } else if (p.type === 'settings') {
    requireValue(p.from === state.sequencer, 'Only the sequencer can schedule settings');
    next.pendingMaxOutputTokens = integer(p.maxOutputTokens, 'maxOutputTokens', 1, CONTEXT);
  } else {
    requireValue(state.providers.includes(p.provider), 'Unregistered provider');
    requireValue(p.model === MODEL && p.contextWindow === CONTEXT, 'Unsupported model or context window');
    hex64(p.requestHash, 'request hash');
    hex64(p.responseHash, 'response hash');
    const amount = charge(p);
    requireValue(amount > 0 && p.inputTokens > 0, 'Empty inference usage');
    requireValue(p.outputTokens <= state.maxOutputTokens, 'Epoch output limit exceeded');
    signature(p.provider, p, tx.providerSignature, 'provider');
    next.balances = pay(state, p.from, p.provider, amount);
    const work = p.inputTokens - p.cachedTokens + p.outputTokens;
    next.totalWorkTokens = integer(state.totalWorkTokens + work, 'total work tokens');
    next.epochTokens = state.epochTokens + work;
    // One receipt fits within 256K, so at most one boundary can be crossed.
    // Settle the crossing receipt under its original settings, then carry the excess.
    if (next.epochTokens >= EPOCH_TOKENS) {
      next.epoch += 1;
      next.epochTokens -= EPOCH_TOKENS;
      next.maxOutputTokens = state.pendingMaxOutputTokens ?? state.maxOutputTokens;
      next.pendingMaxOutputTokens = null;
    }
  }
  return next;
}

/** Apply the same signed transaction rules to a quorum-selected block. */
export function applyQuorumTransaction(state, tx, tip) {
  hex64(tip, 'quorum block hash');
  requireValue(tx?.payload?.type !== 'issue-reserve', 'Reserve issuance is closed after activation');
  requireValue(tx?.payload?.type !== 'add-validator', 'The voting committee is fixed after activation');
  return immutable({...transition(state, tx),height:integer(state.height+1,'height'),tip});
}

/** Sign a valid next block without mutating state. */
export function createBlock(state, tx, wallet) {
  requireValue(wallet.address === state.sequencer, 'Wrong sequencer wallet');
  transition(state, tx);
  return signedBlock(integer(state.height + 1, 'height'), state.tip, tx, wallet);
}

export function applyBlock(state, block) {
  checkBlock(block, integer(state.height + 1, 'height'), state.tip, state.sequencer);
  return immutable({...transition(state, block.payload), height: block.height, tip: block.hash});
}

export function replay(blocks, trustedGenesisHash) {
  requireValue(Array.isArray(blocks) && blocks.length > 0, 'A genesis block is required');
  let state = genesisState(blocks[0], trustedGenesisHash);
  for (let index = 1; index < blocks.length; index++) state = applyBlock(state, blocks[index]);
  return state;
}
