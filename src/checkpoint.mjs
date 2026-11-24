import { hash, sign } from './crypto.mjs';
import { applyBlock, createBlock } from './ledger.mjs';
import { authenticateLegacy, checkpointProof, updatedEpochHashes } from './checkpoint-base.mjs';
import { verifyConsensusCheckpoint } from './consensus.mjs';

export function authenticate(checkpoint, chainId) {
  if (Object.hasOwn(checkpoint,'authority') || Object.hasOwn(checkpoint,'consensus')) {
    return verifyConsensusCheckpoint(checkpoint,chainId);
  }
  return authenticateLegacy(checkpoint,chainId);
}

// Both checkpoints must already have been authenticated. Two majorities may certify
// one value with different ballots or vote subsets without creating a fork.
export function verifyAdvance(prior,next) {
  const old = prior.state, state = next.state;
  if (old.chainId !== state.chainId || state.height < old.height ||
      state.totalWorkTokens < old.totalWorkTokens ||
      !prior.epochHashes.every((digest,i) => digest === next.epochHashes[i])) throw Error('Upstream checkpoint rollback or epoch conflict');
  if (prior.authority && (!next.authority || hash(next.authority) !== hash(prior.authority))) {
    throw Error('Consensus authority downgrade or conflict');
  }
  if (!prior.authority && next.authority) {
    const {anchorHeight,anchorHash} = next.authority.payload;
    if (old.height > anchorHeight || (old.height === anchorHeight && hash(prior) !== anchorHash)) {
      throw Error('Legacy checkpoint conflicts with consensus activation');
    }
  }
  if (old.height === state.height && (hash(old) !== hash(state) || prior.epochHashes.length !== next.epochHashes.length)) {
    throw Error('Conflicting checkpoint at the same height');
  }
  return next;
}

export function nextCheckpoint(head, tx, wallet) {
  if (head.authority) throw Error('The activated network requires validator votes');
  const {genesis} = head;
  const block = createBlock(head.state, tx, wallet);
  const state = applyBlock(head.state, block);
  const epochHashes = updatedEpochHashes(head,state);
  const next = {genesis, state, epochHashes,signature:sign(wallet.privateKey, checkpointProof(state, epochHashes))};
  return {block, next};
}
