import { verifyAdvance } from './checkpoint.mjs';
import { verifyConsensusAck } from './consensus.mjs';
import { hash } from './crypto.mjs';
import { requestJson } from './http.mjs';
import { applyBlock, verifyBlock } from './ledger.mjs';

// Send exactly once and authenticate the acknowledgment against the pinned head.
export async function submitSignedTransaction(ledger,tx,request=requestJson) {
  const {url,state,checkpoint}=ledger;
  const reply=await request(url+'/v1/transactions',{body:tx,maxBytes:64*1024*1024});
  if (checkpoint.authority || reply.checkpoint?.authority) {
    verifyConsensusAck(reply,tx,checkpoint.genesis,checkpoint.authority);
    if (reply.block.height<=state.height) throw Error('Outdated consensus acknowledgement');
    verifyAdvance(checkpoint,reply.checkpoint);
    if (reply.block.height===state.height+1 && reply.block.previousHash!==state.tip) {
      throw Error('Receipt does not extend the last verified checkpoint');
    }
    return {height:reply.block.height,hash:reply.block.hash};
  }
  const {block}=reply;
  if (!block || hash(block.payload)!==hash(tx) || !Number.isSafeInteger(block.height) ||
      block.height<=state.height) throw Error('Ledger returned an unexpected transaction');
  if (block.height===state.height+1) applyBlock(state,block);
  else verifyBlock(block,state.sequencer);
  return {height:block.height,hash:block.hash};
}
