import assert from 'node:assert/strict';
import test from 'node:test';
import genesis from '../networks/sites-testnet.json' with {type:'json'};
import { decodeAmount, encodeAmount, formatCoins, isAmount, parseCoins } from '../src/amount.mjs';
import { generateWallet, sign } from '../src/crypto.mjs';
import {
  applyBlock, applyQuorumTransaction, CONTEXT, createBlock, createGenesis, DISTRIBUTION_RESERVE,
  distributionReserveEffect, MODEL, replay,
} from '../src/ledger.mjs';

test('nanocoin wire encoding stays exact and canonical around the safe integer limit', () => {
  const safe = BigInt(Number.MAX_SAFE_INTEGER);
  assert.equal(encodeAmount(safe), Number.MAX_SAFE_INTEGER);
  assert.equal(encodeAmount(safe+1n), '9007199254740992');
  for (const n of [0n,1n,safe-1n,safe,safe+1n,10n**21n-1n,10n**21n,10n**21n+1n]) {
    const wire = encodeAmount(n);
    assert.equal(decodeAmount(wire),n);
    assert.ok(isAmount(wire));
    if (n>0n) assert.equal(parseCoins(formatCoins(wire)),wire);
  }
  assert.equal(parseCoins('1000000000000.000000001'),'1000000000000000000001');
  for (const bad of [1e21,Number.MAX_SAFE_INTEGER+1,-1,'0','42','09007199254740992',' 9007199254740992',
    '9.007199254740992e15','-9007199254740992',1000n,'1'.repeat(1024),null]) {
    assert.equal(isAmount(bad),false);
    assert.throws(()=>decodeAmount(bad));
  }
  for (const bad of ['0','-0.1','10e6','1.0000000001','1'.repeat(26)]) assert.throws(()=>parseCoins(bad));
  assert.equal(formatCoins(0),'0');
});

test('the public reserve has one fixed beneficiary, issuer, chain, claim and quantity', () => {
  const state = replay([genesis],genesis.hash), r = DISTRIBUTION_RESERVE;
  const treasury = Object.keys(genesis.payload.allocations)[0];
  const p = {type:'issue-reserve',chainId:state.chainId,from:state.sequencer,nonce:1,to:r.address,amount:r.amount,claim:r.claim};
  const next = {...state,...distributionReserveEffect(state,p)};
  assert.equal(next.supply,'1000000000001000000000');
  assert.equal(next.balances[r.address],'1000000000000000000000');
  assert.equal(next.balances[treasury],1_000_000_000);
  assert.equal(next.reserveClaim,r.claim);
  assert.equal(state.reserveClaim,undefined);
  assert.equal(state.supply,1_000_000_000);
  assert.throws(()=>distributionReserveEffect(next,{...p,nonce:2}),/already issued/);
  assert.throws(()=>distributionReserveEffect({...state,supply:0},p),/pre-issuance/);
  for (const change of [{chainId:'0'.repeat(64)},{from:treasury},{to:treasury},{amount:1e21},{claim:'different'}]) {
    assert.throws(()=>distributionReserveEffect(state,{...p,...change}));
  }
  const other = generateWallet();
  const fakeGenesis = createGenesis(other,{networkId:state.networkId,allocations:{[treasury]:1_000_000_000},providers:[]});
  const foreign = replay([fakeGenesis],fakeGenesis.hash);
  const spoof = {...p,from:other.address,chainId:foreign.chainId};
  assert.throws(()=>createBlock(foreign,{payload:spoof,signature:sign(other.privateKey,spoof)},other),/original public testnet/);
  assert.throws(()=>applyQuorumTransaction(state,{payload:p},'0'.repeat(64)),/closed after activation/);
});

test('large transfers and inference settle to a single nanocoin and switch back to numeric wire below the threshold', () => {
  const sequencer=generateWallet(), buyer=generateWallet(), provider=generateWallet();
  const anchor=createGenesis(sequencer,{allocations:{},providers:[provider.address]});
  const initial=replay([anchor],anchor.hash);
  // Exercise monetary transitions on a funded in-memory state with disposable keys.
  const supply=DISTRIBUTION_RESERVE.amount;
  let state={...initial,supply,balances:{[buyer.address]:supply}};
  function settle(from,payload,attestation) {
    const tx={payload,signature:sign(from.privateKey,payload),...attestation};
    state=applyBlock(state,createBlock(state,tx,sequencer));
    assert.equal(Object.values(state.balances).reduce((sum,v)=>sum+decodeAmount(v),0n),decodeAmount(supply));
  }
  const transfer={type:'transfer',from:buyer.address,to:provider.address,chainId:state.chainId,nonce:1,
    amount:encodeAmount(decodeAmount(supply)-10_013n)};
  settle(buyer,transfer);
  assert.equal(state.balances[buyer.address],10_013);
  const inference={type:'inference',from:buyer.address,provider:provider.address,chainId:state.chainId,nonce:2,
    model:MODEL,contextWindow:CONTEXT,requestHash:'0'.repeat(64),responseHash:'1'.repeat(64),
    inputTokens:64,cachedTokens:32,outputTokens:10};
  settle(buyer,inference,{providerSignature:sign(provider.privateKey,inference)});
  assert.equal(state.balances[buyer.address],1);
  assert.equal(state.balances[provider.address],'999999999999999999999');
  const over={...transfer,nonce:3,amount:2};
  assert.throws(()=>createBlock(state,{payload:over,signature:sign(buyer.privateKey,over)},sequencer),/Insufficient/);
  settle(buyer,{...transfer,nonce:3,amount:1});
  assert.equal(state.balances[buyer.address],0);
  assert.equal(state.balances[provider.address],supply);
  settle(provider,{...transfer,from:provider.address,to:buyer.address,amount:supply});
  assert.equal(state.balances[provider.address],0);
  assert.equal(state.balances[buyer.address],supply);
});
