import { hash, sign } from './crypto.mjs';
import { applyBlock, createBlock } from './ledger.mjs';
import { authenticateLegacy, checkpointProof, updatedEpochHashes } from './checkpoint-base.mjs';
import { verifyConsensusCheckpoint } from './consensus.mjs';

// Weak because JSON key order and wire compression can vary. The digest
// commits to the complete semantic envelope, including the committee and votes.
export function checkpointETag(head) {
  return 'W/"gpuchain-' + hash(head) + '"';
}

export function checkpointHttp(head,condition) {
  const etag=checkpointETag(head);
  const headers={'content-type':'application/json','cache-control':'private, no-cache',
    'x-content-type-options':'nosniff',etag};
  const match=typeof condition==='string' && condition.split(',').some(value=>{
    const tag=value.trim();
    return tag==='*' || tag===etag || tag===etag.slice(2);
  });
  return {status:match?304:200,headers,body:match?null:JSON.stringify(head)};
}

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
  if (old.salePrice && (!state.salePrice || hash(old.salePrice)!==hash(state.salePrice))) {
    throw Error('Sale price configuration rollback or conflict');
  }
  if (old.starterMandateV2 && hash(old.starterMandate ?? null)!==hash(state.starterMandate ?? null)) {
    throw Error('Legacy starter history changed after cutover');
  }
  for (const [permission,registry] of [['starterMandate','starterClaims'],['starterMandateV2','starterClaimsV2']]) {
    const before=old[permission],after=state[permission];
    if ((before && (!after || after.version<before.version)) ||
      Object.entries(old[registry] ?? {}).some(([address,height])=>state[registry]?.[address]!==height) ||
      Object.entries(state[registry] ?? {}).some(([address,height])=>
        height<=old.height && old[registry]?.[address]!==height)) {
      throw Error('Starter mandate or claim history rollback');
    }
    if (before && after.version===before.version &&
      (after.active!==before.active || after.cap!==before.cap ||
       after.authorization?.payload.legacyThrough!==before.authorization?.payload.legacyThrough)) {
      throw Error('Conflicting starter grant permission');
    }
  }
  if (old.mainnetPromotion) {
    if (!state.mainnetPromotion || hash(state.mainnetPromotion)!==hash(old.mainnetPromotion)) {
      throw Error('Mainnet promotion downgrade or conflict');
    }
  } else if (state.mainnetPromotion) {
    const p=state.mainnetPromotion.payload;
    if (old.height>p.anchorHeight || (old.height===p.anchorHeight && (old.tip!==p.anchorTip || hash(old)!==p.anchorStateHash))) {
      throw Error('Checkpoint conflicts with the mainnet promotion anchor');
    }
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
