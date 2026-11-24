import { hash, sign, verify } from './crypto.mjs';
import { applyBlock, createBlock, replay } from './ledger.mjs';

const HEX = /^[0-9a-f]{64}$/;

function check(ok, reason) {
  if (!ok) throw Error(reason);
}

function checkpointProof(state, epochHashes) {
  return {domain:'gpuchain/checkpoint/v1', stateHash:hash(state), epochsHash:hash(epochHashes)};
}

export function authenticate(checkpoint, chainId) {
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

// Construct the signed candidate; the caller acknowledges it only after an atomic commit.
export function nextCheckpoint(head, tx, wallet) {
  const {genesis} = head;
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
  return {block, next};
}
