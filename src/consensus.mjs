import { hash, sign, verify } from './crypto.mjs';
import { applyQuorumTransaction, replay } from './ledger.mjs';
import { authenticateLegacy, hexHash, updatedEpochHashes, verifySnapshotIdentity } from './checkpoint-base.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

const ACTIVATION = 'gpuchain/activation/v1';
const VOTE = 'gpuchain/commit-vote/v1';
const BLOCK = 'gpuchain/quorum-block/v1';
const INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function check(ok,message) { if (!ok) throw Error(message); }
function fields(obj,keys) {
  return obj && typeof obj === 'object' && Object.keys(obj).length === keys.length &&
    keys.every(key => Object.hasOwn(obj,key));
}

function members(validators,sequencer) {
  check(Array.isArray(validators) && validators.length === 3,'Expected exactly three validators');
  for (const member of validators) {
    check(fields(member,['address','url','instanceId']) && hexHash(member.address) && member.address !== sequencer &&
      typeof member.instanceId === 'string' && INSTANCE.test(member.instanceId) &&
      normalizeProviderEndpoint(member.url) === member.url,'Invalid validator identity or origin');
  }
  check(new Set(validators.map(v=>v.instanceId)).size === 3 && new Set(validators.map(v=>v.address)).size === 3 &&
    new Set(validators.map(v=>v.url)).size === 3,'Duplicate validator address or origin');
  return [...validators].sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

export function createActivation(legacy, validators, wallet) {
  check(!Object.hasOwn(legacy,'authority') && !Object.hasOwn(legacy,'consensus'),'Already activated');
  authenticateLegacy(legacy,legacy.genesis.hash);
  check(wallet.address === legacy.state.sequencer,'Only the genesis signer can activate consensus');
  const payload = {domain:ACTIVATION,chainId:legacy.state.chainId,anchorHash:hash(legacy),
    anchorHeight:legacy.state.height,anchorTip:legacy.state.tip,validators:members(validators,wallet.address)};
  const activation = {payload,signature:sign(wallet.privateKey,payload)};
  verifyActivation(activation,legacy.genesis);
  return activation;
}

export function verifyActivation(activation,genesis) {
  const initial = replay([genesis],genesis.hash);
  const p = activation?.payload;
  check(fields(activation,['payload','signature']) &&
    fields(p,['domain','chainId','anchorHash','anchorHeight','anchorTip','validators']) &&
    p.domain === ACTIVATION && p.chainId === initial.chainId && hexHash(p.anchorHash) &&
    Number.isSafeInteger(p.anchorHeight) && p.anchorHeight >= 0 && hexHash(p.anchorTip) &&
    hash(members(p.validators,initial.sequencer)) === hash(p.validators) &&
    verify(initial.sequencer,p,activation.signature),'Invalid validator activation certificate');
  return p;
}

export function activateCheckpoint(legacy, activation) {
  check(!Object.hasOwn(legacy,'authority') && !Object.hasOwn(legacy,'consensus'),'Expected a legacy checkpoint');
  const p = verifyActivation(activation,legacy.genesis);
  authenticateLegacy(legacy,p.chainId);
  check(p.anchorHash === hash(legacy) && p.anchorTip === legacy.state.tip &&
    p.anchorHeight === legacy.state.height,'Activation does not authorize this checkpoint');
  return {...legacy,authority:activation,consensus:null};
}

function blockTip(chainId,authorityHash,height,previousHash,txHash) {
  return hash({domain:BLOCK,chainId,authorityHash,height,previousHash,txHash});
}

export function consensusCandidate(head,tx,activation = head.authority) {
  check(head.authority && hash(activation) === hash(head.authority),'Wrong consensus authority');
  verifyConsensusCheckpoint(head,head.genesis.hash);
  const previousHash = head.state.tip, height = head.state.height + 1, txHash = hash(tx);
  const tip = blockTip(head.state.chainId,hash(activation),height,previousHash,txHash);
  const state = applyQuorumTransaction(head.state,tx,tip);
  return {
    block:{height,previousHash,payload:tx,hash:tip},
    next:{genesis:head.genesis,state,epochHashes:updatedEpochHashes(head,state),authority:activation,
      signature:null,consensus:{previousHash,txHash}}
  };
}

export function votePayload(next,activation,ballot) {
  const {state,consensus,epochHashes} = next;
  const {previousHash,txHash} = consensus;
  check(fields(ballot,['round','proposer']) && Number.isSafeInteger(ballot.round) && ballot.round > 0 &&
    activation.payload.validators.some(member=>member.address === ballot.proposer),'Invalid consensus ballot');
  const authorityHash = hash(activation);
  check(state.chainId === activation.payload.chainId && Number.isSafeInteger(state.height) &&
    state.height > activation.payload.anchorHeight && hexHash(previousHash) && hexHash(txHash) &&
    (state.height !== activation.payload.anchorHeight+1 || previousHash === activation.payload.anchorTip) &&
    state.tip === blockTip(state.chainId,authorityHash,state.height,previousHash,txHash),
    'Invalid consensus block commitment');
  return {domain:VOTE,chainId:state.chainId,authorityHash,ballot,height:state.height,previousHash,
    txHash,tip:state.tip,stateHash:hash(state),epochsHash:hash(epochHashes)};
}

export function verifyConsensusCheckpoint(head,chainId) {
  check(fields(head,['genesis','state','epochHashes','signature','authority','consensus']),
    'Invalid certified checkpoint fields');
  verifySnapshotIdentity(head,chainId);
  const p = verifyActivation(head.authority,head.genesis);
  if (head.state.mainnetPromotion && head.state.mainnetPromotion.payload.anchorHeight >= p.anchorHeight) {
    throw Error('Mainnet promotion must precede validator activation');
  }
  if (head.consensus === null) {
    const {authority,consensus,...legacy} = head;
    activateCheckpoint(legacy,authority);
    return head;
  }
  const proof = head.consensus;
  check(head.signature === null && fields(proof,['previousHash','txHash','ballot','votes']),
    'Invalid quorum checkpoint');
  const payload = votePayload(head,head.authority,proof.ballot);
  check(Array.isArray(proof.votes) && proof.votes.length >= 2 && proof.votes.length <= 3,
    'Two validator votes are required');
  const voters = new Set();
  for (const vote of proof.votes) {
    check(fields(vote,['address','signature']) && !voters.has(vote.address) &&
      p.validators.some(member=>member.address === vote.address) &&
      verify(vote.address,payload,vote.signature),'Invalid or duplicate quorum vote');
    voters.add(vote.address);
  }
  return head;
}

export function certify(next,activation,ballot,votes) {
  check(hash(activation) === hash(next.authority),'Wrong validator authority');
  const head = {...next,consensus:{...next.consensus,ballot,votes}};
  return verifyConsensusCheckpoint(head,next.genesis.hash);
}

export function verifyConsensusAck(response,expectedTx,genesis,expectedAuthority) {
  const chainId = typeof genesis === 'string' ? genesis : genesis.hash;
  const {block,checkpoint} = response;
  verifyConsensusCheckpoint(checkpoint,chainId);
  if (expectedAuthority) check(hash(expectedAuthority) === hash(checkpoint.authority),'Unexpected receipt authority');
  check(checkpoint.consensus && hash(expectedTx) === checkpoint.consensus.txHash &&
    fields(block,['height','previousHash','payload','hash']) && hash(block.payload) === hash(expectedTx) &&
    block.previousHash === checkpoint.consensus.previousHash && block.height === checkpoint.state.height &&
    block.hash === checkpoint.state.tip,'Receipt does not commit the submitted transaction');
  return true;
}
