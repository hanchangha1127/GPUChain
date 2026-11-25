import { hash } from './crypto.mjs';
import { verifyBlock } from './ledger.mjs';
import { verifyCompactVote, votePayload } from './consensus.mjs';

// A fixed number of recent commitments. These records contain no transaction
// body, payer/provider signatures, prompt, response or token counts.
export const OUTCOME_SLOTS=256;
export const outcomeRoute=/^\/v1\/transaction-outcomes\/([a-f0-9]{64})$/;

export function sequencerOutcome(block) {
  const {payload,...header}=block;
  return {txHash:hash(payload),header};
}

export function quorumOutcome(checkpoint) {
  const {consensus,authority}=checkpoint;
  return {txHash:consensus.txHash,vote:votePayload(checkpoint,authority,consensus.ballot),votes:consensus.votes};
}

export function verifyOutcome(outcome,tx,checkpoint) {
  const digest=hash(tx);
  if (tx.payload.chainId!==checkpoint.state.chainId || outcome?.txHash!==digest) throw Error('Wrong transaction outcome');
  let height,tip;
  if (outcome.header) {
    const block={...outcome.header,payload:tx};
    verifyBlock(block,checkpoint.state.sequencer);
    height=block.height; tip=block.hash;
    const activation=checkpoint.authority?.payload;
    if (activation && (height>activation.anchorHeight || (height===activation.anchorHeight && tip!==activation.anchorTip))) {
      throw Error('Sequencer outcome after retirement');
    }
  } else {
    verifyCompactVote(outcome.vote,outcome.votes,checkpoint.authority,digest);
    height=outcome.vote.height; tip=outcome.vote.tip;
  }
  if (height<1 || height>checkpoint.state.height || (height===checkpoint.state.height && tip!==checkpoint.state.tip) ||
      (checkpoint.state.nonces[tx.payload.from]??0)<tx.payload.nonce) throw Error('Outcome conflicts with verified head');
  return {height,hash:tip};
}
