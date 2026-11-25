import { randomUUID } from 'node:crypto';
import { hash, sign, verify } from './crypto.mjs';
import { decodeAmount, encodeAmount } from './amount.mjs';
import { DISTRIBUTION_RESERVE } from './reserve-policy.mjs';
import { LEGACY_STARTER_GRANT_AMOUNT, MAX_STARTER_WALLETS, STARTER_AUTHORIZATION_V2, STARTER_GRANT_AMOUNT,
  activeStarterMandate, legacyStarterThrough, remainingStarterClaims, starterAddressEligible, starterClaimHeight, starterGrantAmount } from './starter-grants.mjs';
export { DISTRIBUTION_RESERVE } from './reserve-policy.mjs';
import { SALE_MERCHANT, SALE_TOKENS, SALE_NANO_PER_MICRO, SALE_TERMS } from './sale-policy.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';

export const MODEL = 'Qwen3.8-Flash-Next';
export const CONTEXT = 262_144;
export const EPOCH_TOKENS = 1_000_000_000;
export const NANOCOINS = 1_000_000_000;
export const RATES = Object.freeze({input: 150, output: 470, cached: 16});
const PROTOCOL = 'gpuchain/1';
const HEX64 = /^[0-9a-f]{64}$/;
const RESERVE_ISSUER = '0000b0bb4901e3e6fcdc6ce7c7422bede26068d8ae9e04c5f4aa04e221a33f5e';
export const MAINNET = Object.freeze({chainId:DISTRIBUTION_RESERVE.chainId, issuer:RESERVE_ISSUER,
  fromNetworkId:'gpuchain-sites-testnet-1',networkId:'gpuchain-mainnet-1',networkStage:'mainnet',
  validatorProtocol:'gpuchain/mainnet-ed25519-kv-q8/v1'});

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

export function heldSaleAmount(state) {
  return Object.values(state.saleHolds ?? {}).reduce((sum,hold)=>sum+decodeAmount(hold.amount),0n);
}

export function spendableBalance(state,address) {
  const total=decodeAmount(state.balances[address] ?? 0);
  return address===DISTRIBUTION_RESERVE.address ? total-heldSaleAmount(state) : total;
}

function pay(state, from, to, amount) {
  hex64(to, 'recipient');
  requireValue(from !== to, 'Sender and recipient must be different');
  const n = decodeAmount(amount, 'transfer amount');
  requireValue(n > 0n, 'Invalid transfer amount');
  const balance = decodeAmount(state.balances[from] ?? 0);
  requireValue(balance >= n, 'Insufficient balance');
  if (from===DISTRIBUTION_RESERVE.address) {
    requireValue(spendableBalance(state,from)>=n,'Outstanding paid-order reservations constrain the reserve balance');
  }
  return {...state.balances, [from]: encodeAmount(balance - n),
    [to]: encodeAmount(decodeAmount(state.balances[to] ?? 0) + n, 'recipient balance')};
}

function requireGrantNetwork(state) {
  requireValue(state.chainId===MAINNET.chainId && state.sequencer===MAINNET.issuer &&
    state.networkId===MAINNET.networkId && state.networkStage==='mainnet' && state.reserveClaim===DISTRIBUTION_RESERVE.claim,
  'Starter grants require the issued public mainnet reserve');
}

function validateGrantCap(value,spent,unit) {
  const cap=decodeAmount(value,'starter grant cap');
  const ceiling=unit===STARTER_GRANT_AMOUNT ? BigInt(MAX_STARTER_WALLETS)*BigInt(unit) : decodeAmount(DISTRIBUTION_RESERVE.amount);
  requireValue(cap>0n && cap<=ceiling &&
    cap%BigInt(unit)===0n && cap>=decodeAmount(spent),'Invalid lifetime starter grant cap');
}

// Retain the signed owner permission so a pruned observer can verify its lifetime budget.
export function starterMandateEffect(state,tx) {
  requireGrantNetwork(state);
  const p=tx.payload,old=activeStarterMandate(state);
  requireValue(p.chainId===state.chainId && p.from===DISTRIBUTION_RESERVE.address,
    'Only the distribution reserve may authorize starter grants');
  integer(p.nonce,'starter mandate version',1);
  requireValue(p.nonce>(old?.version ?? 0),'Starter grant mandate version must advance');
  if (p.type==='suspend-starter-grants') {
    requireValue(old?.active,'No active starter grant mandate');
    const key=state.starterMandateV2 ? 'starterMandateV2' : 'starterMandate';
    return {[key]:{...old,active:false,version:p.nonce,suspension:structuredClone(tx)}};
  }
  const upgraded=p.type===STARTER_AUTHORIZATION_V2;
  requireValue(upgraded || p.type==='authorize-starter-grants','Invalid starter grant mandate');
  if (upgraded) {
    requireValue(!state.starterMandate?.active,'Suspend the legacy starter mandate before upgrading');
    requireValue(p.legacyThrough===legacyStarterThrough(state),'Incorrect starter cutover height');
  } else {
    requireValue(!state.starterMandateV2,'Starter grant downgrade');
  }
  const spent=old?.spent ?? 0;
  validateGrantCap(p.cap,spent,upgraded ? STARTER_GRANT_AMOUNT : LEGACY_STARTER_GRANT_AMOUNT);
  return {[upgraded?'starterMandateV2':'starterMandate']:{active:true,cap:p.cap,spent,version:p.nonce,authorization:structuredClone(tx)}};
}

export function starterGrantEffect(state,p) {
  requireGrantNetwork(state);
  const m=activeStarterMandate(state);
  requireValue(m?.active===true && p.type==='starter-grant' && p.from===MAINNET.issuer &&
    p.chainId===state.chainId && p.mandateVersion===m.version,'Starter grant authorization missing or changed');
  const unit=starterGrantAmount(state);
  requireValue(p.amount===unit,'Incorrect amount for the authorized starter grant');
  requireValue(starterAddressEligible(state,p.to),'Expected an existing eligible GPUChain wallet');
  requireValue(starterClaimHeight(state,p.to)===null,'Wallet already received its starter grant');
  requireValue(remainingStarterClaims(state)>0,'Starter grant budget exhausted');
  const spent=decodeAmount(m.spent)+BigInt(unit);
  const mandateKey=state.starterMandateV2 ? 'starterMandateV2' : 'starterMandate';
  const claimsKey=state.starterMandateV2 ? 'starterClaimsV2' : 'starterClaims';
  return {
    balances:pay(state,DISTRIBUTION_RESERVE.address,p.to,unit),
    [mandateKey]:{...m,spent:encodeAmount(spent)},
    [claimsKey]:{...state[claimsKey],[p.to]:integer(state.height+1,'starter grant height',1)}
  };
}

export function verifyStarterState(state) {
  const legacy=Object.hasOwn(state,'starterMandate') || Object.hasOwn(state,'starterClaims');
  const modern=Object.hasOwn(state,'starterMandateV2') || Object.hasOwn(state,'starterClaimsV2');
  if (!legacy && !modern) return;
  requireGrantNetwork(state);
  const heights=new Set();
  if (legacy) verifyStarterEra(state,false,heights);
  if (modern) verifyStarterEra(state,true,heights);
}

function verifyStarterEra(state,upgraded,heights) {
  const m=upgraded ? state.starterMandateV2 : state.starterMandate;
  fields(m,['version','active','spent','cap','authorization',...(m?.active===false?['suspension']:[])]);
  requireValue(typeof m.active==='boolean','Invalid starter mandate status');
  const unit=upgraded ? STARTER_GRANT_AMOUNT : LEGACY_STARTER_GRANT_AMOUNT;
  validateGrantCap(m.cap,m.spent,unit);
  function verifyPermission(tx,type,extra) {
    fields(tx,['payload','signature']);
    const p=tx.payload;
    fields(p,['type','from','chainId','nonce',...extra]);
    requireValue(p.type===type && p.from===DISTRIBUTION_RESERVE.address && p.chainId===state.chainId &&
      integer(p.nonce,'starter permission nonce',1)<=(state.nonces[p.from] ?? 0),'Invalid starter permission');
    signature(p.from,p,tx.signature,'starter permission');
    return p;
  }
  const authorization=upgraded ? verifyPermission(m.authorization,STARTER_AUTHORIZATION_V2,['cap','legacyThrough'])
    : verifyPermission(m.authorization,'authorize-starter-grants',['cap']);
  const cutoff=upgraded ? integer(authorization.legacyThrough,'starter cutover',0,state.height-1) : 0;
  if (upgraded) {
    requireValue(!state.starterMandate?.active && authorization.nonce>(state.starterMandate?.version ?? 0) &&
      cutoff===legacyStarterThrough(state),'Invalid starter cutover or legacy mandate');
  }
  const latest=m.active?authorization:verifyPermission(m.suspension,'suspend-starter-grants',[]);
  requireValue(m.cap===authorization.cap && m.version===latest.nonce &&
    (m.active || latest.nonce>authorization.nonce),'Starter mandate differs from reserve permission');
  const key=upgraded ? 'starterClaimsV2' : 'starterClaims';
  const claims=Object.hasOwn(state,key) ? state[key] : {};
  requireValue(record(claims),'Invalid starter claim registry');
  let spent=upgraded ? decodeAmount(state.starterMandate?.spent ?? 0) : 0n;
  for (const [address,height] of Object.entries(claims)) {
    requireValue(starterAddressEligible(state,address) && Number.isSafeInteger(height) &&
      height>state.mainnetPromotion.payload.anchorHeight && height>cutoff && height<=state.height &&
      (!upgraded || !Object.hasOwn(state.starterClaims ?? {},address)) &&
      !heights.has(height),'Invalid starter claim record');
    heights.add(height);
    spent+=BigInt(unit);
  }
  if (upgraded) requireValue(heights.size<=MAX_STARTER_WALLETS,'Invalid starter wallet count');
  requireValue(spent===decodeAmount(m.spent),'Starter claim count differs from lifetime spend');
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

/** A reserve owner's signature authorizes or revokes a narrowly scoped settlement signer. */
export function saleMandateEffect(state,p) {
  const r=DISTRIBUTION_RESERVE, old=state.saleMandate;
  requireValue(state.chainId===r.chainId && p.chainId===r.chainId && state.reserveClaim===r.claim &&
    p.from===r.address,'Sale authorization requires the issued public reserve wallet');
  const version=integer((old?.version ?? 0)+1,'sale mandate version',1);
  if (p.type==='suspend-sales') {
    requireValue(old?.active,'No active sale mandate');
    return {saleMandate:{...old,version,active:false}};
  }
  requireValue(p.type==='authorize-sales','Invalid sale mandate');
  requireValue(p.terms===SALE_TERMS,'Invalid USDT sale price');
  hex64(p.authority,'sale authority');
  requireValue(p.authority!==r.address && p.authority!==state.sequencer,'Expected a separate sale authority');
  const cap=decodeAmount(p.cap,'sale cap'), spent=old?.spent ?? 0;
  requireValue(cap>0n && cap<=decodeAmount(r.amount) && cap>=decodeAmount(spent)+heldSaleAmount(state),'Invalid cumulative sale cap');
  return {saleMandate:{version,authority:p.authority,cap:p.cap,spent,active:true,terms:SALE_TERMS}};
}

const validSaleOrderId=id=>typeof id==='string' && /^[A-Za-z0-9_-]{16,128}$/.test(id);
export function saleHoldCommitment(p) {
  return hash({domain:'gpuchain/sale-hold/v1',chainId:DISTRIBUTION_RESERVE.chainId,terms:SALE_TERMS,
    orderId:p.orderId,to:p.to,amount:p.amount,evmChainId:p.evmChainId});
}

function findHold(state,id) {
  return Object.hasOwn(state.saleHolds ?? {},id) ? state.saleHolds[id] : undefined;
}

/** A unique order lock retains only a fixed commitment and exact amount. */
export function saleHoldEffect(state,p) {
  const m=state.saleMandate,r=DISTRIBUTION_RESERVE;
  requireValue(state.chainId===r.chainId && p.chainId===r.chainId && state.reserveClaim===r.claim &&
    m?.terms===SALE_TERMS && p.from===m.authority && p.mandateVersion===m.version,
  'Holds require the current reserve mandate');
  requireValue(validSaleOrderId(p.orderId),'Invalid sale order ID');
  const existing=findHold(state,p.orderId);
  if (p.type==='release-sale') {
    requireValue(existing && existing.commitment===p.commitment,'Unknown or mismatched sale hold');
    const saleHolds={...state.saleHolds};
    delete saleHolds[p.orderId];
    return saleHolds;
  }
  requireValue(p.type==='hold-sale' && m.active===true && !existing,'New sale hold unavailable');
  requireValue((p.evmChainId===1 || p.evmChainId===56) && p.to!==r.address,'Invalid sale hold terms');
  hex64(p.to,'sale hold recipient');
  requireValue(Object.keys(state.saleHolds ?? {}).length<256,'Too many outstanding sale holds');
  const amount=decodeAmount(p.amount,'sale hold amount'), total=heldSaleAmount(state)+amount;
  requireValue(amount>0n && amount%SALE_NANO_PER_MICRO===0n &&
    total<=decodeAmount(state.balances[r.address] ?? 0) &&
    total+decodeAmount(m.spent)<=decodeAmount(m.cap),'Insufficient unreserved inventory or allowance');
  return {...state.saleHolds,[p.orderId]:{amount:p.amount,commitment:saleHoldCommitment(p)}};
}

/** Deterministic reserve debit after the enclosing transition verifies the delegated signature/nonce. */
export function saleDeliveryEffect(state,p,quorum=false) {
  const r=DISTRIBUTION_RESERVE, mandate=state.saleMandate;
  const hold=findHold(state,p.orderId);
  requireValue(state.chainId===r.chainId && p.chainId===r.chainId && state.reserveClaim===r.claim &&
    p.type==='deliver-sale' && mandate?.terms===SALE_TERMS && (mandate.active || hold) &&
    p.from===mandate.authority && p.mandateVersion===mandate.version,
  'Sales require the current reserve-authorized settlement signer');
  const sequence=integer(p.sequence,'sale sequence',1);
  requireValue(sequence===(state.lastSale?.sequence ?? 0)+1,'Unexpected sale sequence');
  requireValue((p.evmChainId===1 || p.evmChainId===56) && typeof p.txHash==='string' &&
    /^0x[0-9a-f]{64}$/.test(p.txHash) && typeof p.logIndex==='string' &&
    /^(?:0|[1-9][0-9]{0,9})$/.test(p.logIndex),'Invalid payment event');
  requireValue(p.payTo===SALE_MERCHANT && p.token===SALE_TOKENS[p.evmChainId] &&
    validSaleOrderId(p.orderId),'Invalid USDT sale terms');
  requireValue(p.paymentId==='eip155:'+p.evmChainId+':'+p.txHash+':'+p.logIndex &&
    p.paymentId!==state.lastSale?.paymentId,'Invalid or repeated sale payment ID');
  requireValue(typeof p.usdtMicros==='string' && /^[1-9][0-9]{0,18}$/.test(p.usdtMicros) &&
    BigInt(p.usdtMicros)*SALE_NANO_PER_MICRO===decodeAmount(p.amount) && decodeAmount(p.amount)<=decodeAmount(r.amount),
  'Sale amount must equal ten coins per USDT');
  if (quorum) requireValue(hold?.commitment===saleHoldCommitment(p) && hold.amount===p.amount,
    'Quorum delivery requires the matching confirmed sale hold');
  const debitState={...state};
  if (hold) {
    requireValue(hold.commitment===saleHoldCommitment(p),'Sale hold terms differ');
    debitState.saleHolds={...state.saleHolds};
    delete debitState.saleHolds[p.orderId];
  }
  const spent=decodeAmount(mandate.spent)+decodeAmount(p.amount);
  requireValue(spent+heldSaleAmount(debitState)<=decodeAmount(mandate.cap),'Sale allowance exceeded');
  return {...(hold?{saleHolds:debitState.saleHolds}:{}),balances:pay(debitState,r.address,p.to,p.amount),saleMandate:{...mandate,spent:encodeAmount(spent)},
    lastSale:{sequence,paymentId:p.paymentId,recipient:p.to,amount:p.amount}};
}

/** The bootstrap signer authorizes the exact current state as the production launch boundary. */
export function mainnetPromotionPayload(state) {
  const m=state.saleMandate;
  requireValue(state.chainId===MAINNET.chainId && state.sequencer===MAINNET.issuer &&
    state.networkId===MAINNET.fromNetworkId && !Object.hasOwn(state,'mainnetPromotion') &&
    !Object.hasOwn(state,'networkStage'),'Expected the unpromoted original public network');
  requireValue(state.reserveClaim===DISTRIBUTION_RESERVE.claim &&
    decodeAmount(state.supply)===decodeAmount(DISTRIBUTION_RESERVE.amount)+BigInt(NANOCOINS),
  'Issue the designated distribution reserve before mainnet promotion');
  requireValue(m?.active===true && m.terms===SALE_TERMS && m.cap===DISTRIBUTION_RESERVE.amount &&
    Number.isSafeInteger(m.version) && m.version>=1 && typeof m.authority==='string' && HEX64.test(m.authority) &&
    m.authority!==MAINNET.issuer && m.authority!==DISTRIBUTION_RESERVE.address &&
    decodeAmount(m.spent)<=decodeAmount(m.cap),'Mainnet launch requires the authorized 10:1 sale mandate');
  integer(state.height,'pre-promotion height',1);
  hex64(state.tip,'pre-promotion tip');
  return {type:'promote-mainnet', chainId:MAINNET.chainId,from:MAINNET.issuer,
    nonce:integer((state.nonces[MAINNET.issuer] ?? 0)+1,'promotion nonce',1),
    fromNetworkId:MAINNET.fromNetworkId, networkId:MAINNET.networkId, networkStage:MAINNET.networkStage,
    anchorHeight:state.height,anchorTip:state.tip,anchorStateHash:hash(state)};
}

/** Called only after transition checks the signed transaction and account nonce. */
export function mainnetPromotionEffect(state,tx) {
  const expected=mainnetPromotionPayload(state);
  requireValue(hash(tx.payload)===hash(expected),'Mainnet promotion does not match the official network and current tip');
  return {networkId:MAINNET.networkId,networkStage:MAINNET.networkStage,mainnetPromotion:structuredClone(tx)};
}

/** Verify the persistent promotion certificate of a pruned ledger snapshot. */
export function verifyNetworkStage(state,initial) {
  if (!Object.hasOwn(state,'networkStage') && !Object.hasOwn(state,'mainnetPromotion')) {
    requireValue(state.networkId===initial.networkId,'Network identity requires an authenticated promotion');
    return;
  }
  const tx=state.mainnetPromotion;
  requireValue(state.chainId===MAINNET.chainId && initial.networkId===MAINNET.fromNetworkId &&
    initial.sequencer===MAINNET.issuer && state.networkId===MAINNET.networkId &&
    state.networkStage===MAINNET.networkStage,'Invalid mainnet identity');
  fields(tx,['payload','signature']);
  const p=tx.payload;
  fields(p,['type','chainId','from','nonce','fromNetworkId','networkId','networkStage','anchorHeight','anchorTip','anchorStateHash']);
  integer(p.anchorHeight,'promotion anchor height',1);
  integer(p.nonce,'promotion nonce',1);
  hex64(p.anchorTip,'promotion anchor tip');
  hex64(p.anchorStateHash,'promotion anchor state hash');
  requireValue(p.type==='promote-mainnet' && p.chainId===MAINNET.chainId && p.from===MAINNET.issuer &&
    p.fromNetworkId===MAINNET.fromNetworkId && p.networkId===MAINNET.networkId && p.networkStage===MAINNET.networkStage &&
    state.height>p.anchorHeight && state.nonces?.[MAINNET.issuer]>=p.nonce &&
    state.reserveClaim===DISTRIBUTION_RESERVE.claim &&
    decodeAmount(state.supply)===decodeAmount(DISTRIBUTION_RESERVE.amount)+BigInt(NANOCOINS),
  'Invalid mainnet promotion certificate');
  signature(MAINNET.issuer,p,tx.signature,'mainnet promotion');
}

const BASE = ['type', 'from', 'chainId', 'nonce'];
export function canValidate(state, address) {
  return address !== state.sequencer &&
    (state.providers.includes(address) || (state.validatorAddresses ?? []).includes(address));
}

const EXTRA = Object.freeze({
  transfer: ['to', 'amount'],
  'issue-reserve': ['to', 'amount', 'claim'],
  'promote-mainnet':['fromNetworkId','networkId','networkStage','anchorHeight','anchorTip','anchorStateHash'],
  'deliver-sale': ['to','amount','sequence','paymentId','usdtMicros','evmChainId','txHash','logIndex',
    'mandateVersion','orderId','payTo','token'],
  'authorize-sales':['authority','cap','terms'],
  'suspend-sales':[],
  'authorize-starter-grants':['cap'],
  [STARTER_AUTHORIZATION_V2]:['cap','legacyThrough'],
  'suspend-starter-grants':[],
  'starter-grant':['to','amount','mandateVersion'],
  'hold-sale':['orderId','to','amount','evmChainId','mandateVersion'],
  'release-sale':['orderId','commitment','mandateVersion'],
  'add-provider': ['provider'],
  'add-validator': ['validator'],
  'set-provider-endpoint': ['provider', 'endpoint'],
  inference: ['provider', 'model', 'contextWindow', 'requestHash', 'responseHash', 'inputTokens', 'cachedTokens', 'outputTokens'],
  settings: ['maxOutputTokens'],
});

function transition(state, tx, quorum=false) {
  const p = tx?.payload;
  requireValue(record(p) && typeof p.type === 'string' && Object.hasOwn(EXTRA, p.type), 'Unknown transaction type');
  const expected = [...BASE, ...EXTRA[p.type]];
  if (p.type === 'add-provider' && Object.hasOwn(p, 'endpoint')) expected.push('endpoint');
  if (p.type==='inference' && (state.networkStage===MAINNET.networkStage || Object.hasOwn(p,'kvCache'))) expected.push('kvCache');
  fields(p, expected);
  fields(tx, p.type === 'inference' ? ['payload', 'signature', 'providerSignature'] : ['payload', 'signature']);
  requireValue(p.chainId === state.chainId, 'Invalid chainId');
  hex64(p.from, 'sender');
  integer(p.nonce, 'nonce', 1);
  requireValue(p.nonce === (state.nonces[p.from] ?? 0) + 1, 'Unexpected nonce');
  signature(p.from, p, tx.signature, 'sender');
  if (p.from===state.saleMandate?.authority) {
    requireValue(['deliver-sale','hold-sale','release-sale'].includes(p.type),'Dedicated sale signer may only settle sales');
  }
  const next = {...state, nonces: {...state.nonces, [p.from]: p.nonce}};
  if (p.type === 'transfer') {
    next.balances = pay(state, p.from, p.to, p.amount);
  } else if (p.type === 'issue-reserve') {
    Object.assign(next,distributionReserveEffect(state,p));
  } else if (p.type==='promote-mainnet') {
    requireValue(!quorum,'Mainnet promotion must be finalized by the original bootstrap signer');
    Object.assign(next,mainnetPromotionEffect(state,tx));
  } else if (p.type === 'deliver-sale') {
    Object.assign(next,saleDeliveryEffect(state,p,quorum));
    if (next.saleHolds && !Object.keys(next.saleHolds).length) delete next.saleHolds;
  } else if (p.type==='hold-sale' || p.type==='release-sale') {
    requireValue(quorum,'On-chain order holds are used after validator activation');
    next.saleHolds=saleHoldEffect(state,p);
    if (!Object.keys(next.saleHolds).length) delete next.saleHolds;
  } else if (p.type === 'authorize-sales' || p.type === 'suspend-sales') {
    Object.assign(next,saleMandateEffect(state,p));
  } else if (p.type==='authorize-starter-grants' || p.type===STARTER_AUTHORIZATION_V2 || p.type==='suspend-starter-grants') {
    Object.assign(next,starterMandateEffect(state,tx));
  } else if (p.type==='starter-grant') {
    Object.assign(next,starterGrantEffect(state,p));
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
    if (Object.hasOwn(p,'kvCache')) {
      fields(p.kvCache,['k','v']);
      requireValue(kvCacheAtLeastQ8(p.kvCache),'KV cache precision must be at least Q8 for both K and V');
    }
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
  return immutable({...transition(state, tx,true),height:integer(state.height+1,'height'),tip});
}

/** Sign a valid next block without mutating state. */
export function createBlock(state, tx, wallet) {
  requireValue(wallet.address === state.sequencer, 'Wrong sequencer wallet');
  transition(state, tx);
  return signedBlock(integer(state.height + 1, 'height'), state.tip, tx, wallet);
}

// Used by the buyer to distinguish a rejected receipt from a failed HTTP
// acknowledgement against an authenticated head. Applies no persistent write.
export function validateInferenceSpend(state,tx) {
  requireValue(tx?.payload?.type==='inference','Expected a signed inference receipt');
  transition(state,tx);
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
