import { hash, verify } from './crypto.mjs';
import { replay, verifyNetworkStage } from './ledger.mjs';

export const hexHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function checkpointProof(state, epochHashes) {
  return {domain:'gpuchain/checkpoint/v1', stateHash:hash(state), epochsHash:hash(epochHashes)};
}

export function verifySnapshotIdentity({genesis,state,epochHashes}, chainId) {
  const initial = replay([genesis],chainId);
  if (state.chainId !== initial.chainId || state.sequencer !== initial.sequencer ||
      !Array.isArray(epochHashes) || epochHashes.length !== state.epoch || !epochHashes.every(hexHash)) {
    throw Error('Unexpected checkpoint identity or epoch hashes');
  }
  verifyNetworkStage(state,initial);
  return initial;
}

export function authenticateLegacy(checkpoint, chainId) {
  if (Object.keys(checkpoint).length !== 4 ||
      !['genesis','state','epochHashes','signature'].every(key => Object.hasOwn(checkpoint,key))) {
    throw Error('Invalid legacy checkpoint fields');
  }
  const {state,epochHashes,signature} = checkpoint;
  const initial = verifySnapshotIdentity(checkpoint,chainId);
  if (state.height === 0) {
    if (signature !== null || hash(initial) !== hash(state)) throw Error('Invalid initial checkpoint');
  } else if (!Number.isSafeInteger(state.height) || state.height < 1 ||
      !verify(initial.sequencer, checkpointProof(state,epochHashes),signature)) {
    throw Error('Invalid checkpoint signature');
  }
  return checkpoint;
}

export function updatedEpochHashes(head, state) {
  if (state.epoch === head.state.epoch) return head.epochHashes;
  const previous = head.epochHashes.at(-1) ?? head.genesis.hash;
  return [...head.epochHashes,hash({domain:'gpuchain/epoch/v1',previous,
    epoch:state.epoch,tip:state.tip,stateHash:hash(state)})];
}
