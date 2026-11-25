import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { authenticate, nextCheckpoint, verifyAdvance } from '../src/checkpoint.mjs';
import { createGenesis, replay } from '../src/ledger.mjs';
import { quorumOutcome, verifyOutcome } from '../src/transaction-outcome.mjs';
import { activateCheckpoint, certify, consensusCandidate, createActivation, verifyConsensusAck, votePayload } from '../src/consensus.mjs';

function fixture() {
  const seq = generateWallet(), payer = generateWallet(), keys = Array.from({length:3},generateWallet);
  const validators = keys.map((w,i)=>({address:w.address,url:'https://peer'+i+'.example',instanceId:randomUUID()}));
  const genesis = createGenesis(seq,{allocations:{[payer.address]:100},providers:[]});
  const initial = {genesis,state:replay([genesis]),signature:null,epochHashes:[]};
  function transfer(nonce) {
    const payload = {type:'transfer',chainId:genesis.hash,from:payer.address,to:keys[0].address,nonce,amount:4};
    return {payload,signature:sign(payer.privateKey,payload)};
  }
  const head = nextCheckpoint(initial,transfer(1),seq).next;
  const activation = createActivation(head,validators,seq);
  const anchor = activateCheckpoint(head,activation);
  return {genesis,seq,keys,head,validators,activation,anchor,transfer};
}

test('majority certificate authenticates a deterministic transfer and preserves the paid preactivation balance', () => {
  const {genesis,seq,keys,head,activation,anchor,transfer} = fixture();
  assert.equal(authenticate(anchor,genesis.hash),anchor);
  assert.equal(verifyAdvance(head,anchor),anchor);
  assert.throws(()=>verifyAdvance(anchor,head),/downgrade/);
  assert.throws(()=>nextCheckpoint(anchor,transfer(2),seq),/validator/);
  const tx = transfer(2);
  const {block,next} = consensusCandidate(anchor,tx);
  const ballot = {round:1,proposer:keys[0].address};
  const votes = keys.map(w => ({address:w.address, signature:sign(w.privateKey,votePayload(next,activation,ballot))}));
  const checkpoint = certify(next,activation,ballot,votes.slice(0,2));
  assert.equal(checkpoint.state.balances[keys[0].address],8);
  assert.equal(checkpoint.state.nonces[tx.payload.from],2);
  assert.equal(verifyConsensusAck({block,checkpoint},tx,genesis,activation),true);
  const outcome=quorumOutcome(checkpoint);
  assert.deepEqual(verifyOutcome(outcome,tx,checkpoint),{height:2,hash:checkpoint.state.tip});
  assert.throws(()=>verifyOutcome({...outcome,votes:[votes[0],votes[0]]},tx,checkpoint),/vote/);
  assert.throws(()=>verifyOutcome(outcome,transfer(3),checkpoint),/Wrong transaction/);
  const other = certify(next,activation,ballot,votes.slice(1));
  assert.equal(verifyAdvance(checkpoint,other),other);
  assert.ok(!JSON.stringify(checkpoint).includes(tx.signature));
  assert.throws(()=>certify(next,activation,ballot,votes.slice(0,1)),/Two validator/);
  assert.throws(()=>certify(next,activation,ballot,[votes[0],votes[0]]),/duplicate/);
  assert.throws(()=>certify(next,activation,{...ballot,round:2},votes),/quorum vote/);
  assert.throws(()=>verifyConsensusAck({block,checkpoint},transfer(3),genesis),/Receipt/);
  assert.throws(()=>authenticate({...checkpoint,state:{...checkpoint.state,epochTokens:5}},genesis.hash),/quorum vote/);
  assert.throws(()=>verifyAdvance(checkpoint,head),/rollback/);
});

test('activation requires one exact legacy anchor and three independently named validator keys and origins', () => {
  const {seq,head,validators,activation,transfer} = fixture();
  assert.throws(()=>createActivation(head,[validators[0],validators[0],validators[2]],seq),/Duplicate/);
  assert.throws(()=>createActivation(head,validators.slice(0,2),seq),/exactly three/);
  assert.throws(()=>createActivation(head,validators,generateWallet()),/genesis signer/);
  assert.throws(()=>activateCheckpoint(nextCheckpoint(head,transfer(2),seq).next,activation),/does not authorize/);
  const altered = structuredClone(activation);
  altered.payload.anchorHash = hash('other');
  assert.throws(()=>activateCheckpoint(head,altered),/certificate/);
});
