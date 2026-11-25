import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAmount, encodeAmount, parseCoins } from '../src/amount.mjs';
import { generateWallet, sign } from '../src/crypto.mjs';
import { verifyAdvance } from '../src/checkpoint.mjs';
import { checkReadiness } from '../src/enrollment.mjs';
import { applyQuorumTransaction, DISTRIBUTION_RESERVE as reserve, MAINNET, starterGrantEffect,
  starterMandateEffect, verifyStarterState } from '../src/ledger.mjs';
import { knownStarterWallet, LEGACY_STARTER_GRANT_AMOUNT, LEGACY_STARTER_GRANT_PROTOCOL, MAX_STARTER_WALLETS,
  STARTER_AUTHORIZATION_V2, STARTER_GRANT_AMOUNT, STARTER_GRANT_PROTOCOL, starterClaimHeight,
  legacyStarterThrough, remainingStarterClaims, starterClaimAmount, starterGrantAmount } from '../src/starter-grants.mjs';

// Exercise deterministic effects at the public chain ID without accessing any operational signing key.
const buyer=generateWallet().address, other=generateWallet().address;
const seq=MAINNET.issuer;
const state={chainId:MAINNET.chainId,sequencer:seq,networkId:MAINNET.networkId,networkStage:'mainnet',
  reserveClaim:reserve.claim,supply:reserve.amount,totalWorkTokens:0,height:12,tip:'7'.repeat(64),
  balances:{[reserve.address]:reserve.amount,[buyer]:0},providers:[other],nonces:{},
  saleMandate:{active:true,terms:'paid terms'},mainnetPromotion:{payload:{anchorHeight:7}}};
const authorization=(nonce=1,coins='100000000')=>({payload:{from:reserve.address,type:'authorize-starter-grants',
  chainId:state.chainId,nonce,cap:parseCoins(coins)},signature:'0'.repeat(128)});
const suspension=nonce=>({payload:{from:reserve.address,type:'suspend-starter-grants',chainId:state.chainId,nonce},
  signature:'0'.repeat(128)});
const open={...state,...starterMandateEffect(state,authorization())};
const grant=(to=buyer,version=1)=>({type:'starter-grant',chainId:state.chainId,nonce:1,from:seq,
  to,mandateVersion:version,amount:LEGACY_STARTER_GRANT_AMOUNT});

test('100 coins debit existing reserve once, with unchanged paid mandate and supply',()=>{
  const next={...open,...starterGrantEffect(open,grant()),height:13};
  assert.equal(next.balances[buyer],100_000_000_000);
  assert.equal(next.balances[reserve.address],encodeAmount(decodeAmount(reserve.amount)-BigInt(LEGACY_STARTER_GRANT_AMOUNT)));
  assert.equal(next.starterMandate.spent,LEGACY_STARTER_GRANT_AMOUNT);
  assert.equal(starterClaimHeight(next,buyer),13);
  assert.equal(next.supply,open.supply);
  assert.equal(next.saleMandate,open.saleMandate);
  assert.equal(next.totalWorkTokens,0);
  assert.equal(starterClaimHeight(open,buyer),null);
  assert.throws(()=>starterGrantEffect(next,grant()),/already received/);
  assert.throws(()=>starterGrantEffect(open,grant(generateWallet().address)),/existing eligible/);
  assert.throws(()=>starterGrantEffect(open,grant(reserve.address)),/existing eligible/);
  assert.throws(()=>starterGrantEffect(open,{...grant(),amount:STARTER_GRANT_AMOUNT}),/Incorrect amount/);
  assert.throws(()=>starterGrantEffect(open,{...grant(),from:buyer}),/authorization/);
  assert.throws(()=>starterGrantEffect({...open,networkStage:'testnet'},grant()),/mainnet/);
  assert.ok(knownStarterWallet(open,buyer)); // An existing zero-balance entry counts.
  assert.ok(knownStarterWallet(open,other)); // An already registered provider counts.
});

test('suspension and budget changes retain recipients and lifetime spend; outstanding sales stay funded',()=>{
  const initial={...state,...starterMandateEffect(state,authorization(1,'100'))};
  const awarded={...initial,...starterGrantEffect(initial,grant()),height:13};
  assert.throws(()=>starterGrantEffect(awarded,grant(other)),/exhausted/);
  const stopped={...awarded,...starterMandateEffect(awarded,suspension(2))};
  assert.throws(()=>starterGrantEffect(stopped,grant(other,2)),/authorization/);
  const resumed={...stopped,...starterMandateEffect(stopped,authorization(3,'200'))};
  assert.throws(()=>starterGrantEffect(resumed,grant(buyer,3)),/already received/);
  assert.throws(()=>starterGrantEffect(resumed,grant(other,1)),/authorization/);
  assert.equal(starterGrantEffect(resumed,grant(other,3)).starterMandate.spent,2*LEGACY_STARTER_GRANT_AMOUNT);
  assert.throws(()=>starterMandateEffect(resumed,authorization(4,'99')),/lifetime/);
  const tooLittle={...resumed,balances:{...resumed.balances,[reserve.address]:LEGACY_STARTER_GRANT_AMOUNT},
    saleHolds:{reserved:{amount:1,commitment:'1'.repeat(64)}}};
  assert.throws(()=>starterGrantEffect(tooLittle,grant(other,3)),/reservations/);
  assert.throws(()=>starterGrantEffect(resumed,{...grant(other,3),chainId:'0'.repeat(64)}),/authorization/);
  assert.throws(()=>starterMandateEffect(resumed,{...authorization(4),payload:{...authorization(4).payload,from:seq}}),/distribution reserve/);
});

test('certified transitions reject forged issuer signatures and unsupported fields; snapshots prevent rollback',()=>{
  const w=generateWallet(),p=grant();
  assert.throws(()=>applyQuorumTransaction(open,{payload:p,signature:sign(w.privateKey,p)},'0'.repeat(64)),/sender signature/);
  const hiddenProof={...p,proof:'x'};
  assert.throws(()=>applyQuorumTransaction(open,{payload:hiddenProof,signature:sign(w.privateKey,hiddenProof)},'0'.repeat(64)),/fields/);
  assert.throws(()=>verifyStarterState({...open,nonces:{[reserve.address]:1}}),/permission signature/);
  const prior={state:{...open,...starterGrantEffect(open,p),height:13},epochHashes:[]};
  const next={state:{...prior.state,height:14},epochHashes:[]};
  assert.equal(verifyAdvance(prior,next),next);
  assert.throws(()=>verifyAdvance(prior,{...next,state:{...next.state,starterClaims:{}}}),/history rollback/);
  assert.throws(()=>verifyAdvance(prior,{...next,state:{...next.state,
    starterClaims:{...next.state.starterClaims,[other]:12}}}),/history rollback/);
  assert.throws(()=>verifyAdvance(prior,{...next,state:{...next.state,starterMandate:undefined}}),/history rollback/);
  assert.throws(()=>verifyAdvance(prior,{...next,state:{...next.state,starterMandate:{...next.state.starterMandate,cap:1}}}),/permission/);
});

test('a starter-grant network requires an explicit signed validator capability for handover',async()=>{
  const wallet=generateWallet(), candidate={chainId:state.chainId,address:wallet.address,
    origin:'https://voter.example',instanceId:'00112233-4455-4677-8899-aabbccddeeff'};
  const responder=supported=>async url=>{
    const u=new URL(url);
    assert.equal(u.searchParams.get('starter'),'2');
    const payload={domain:'gpuchain/validator-ready/v1',...candidate,challenge:u.searchParams.get('challenge')};
    payload.starterGrants=supported ? STARTER_GRANT_PROTOCOL : LEGACY_STARTER_GRANT_PROTOCOL;
    return Response.json({payload,signature:sign(wallet.privateKey,payload)});
  };
  await assert.rejects(checkReadiness(candidate,responder(false),false,false,true),/readiness/);
  assert.equal((await checkReadiness(candidate,responder(true),false,false,true)).address,wallet.address);
});

test('signed v2 denomination preserves v1 receipts, cumulative spending and the recipient ceiling across renewals',()=>{
  const upgrade=(nonce,legacyThrough,coins='1000000000')=>({payload:{...authorization(nonce,coins).payload,
    type:STARTER_AUTHORIZATION_V2,legacyThrough},signature:'0'.repeat(128)});
  const award=(s,address)=>{
    const p={...grant(address,s.starterMandate.version),amount:starterGrantAmount(s)};
    return {...s,...starterGrantEffect(s,p),height:s.height+1};
  };
  const legacy=award(award(open,buyer),other);
  assert.equal(legacyStarterThrough(legacy),14);
  assert.throws(()=>starterMandateEffect(legacy,upgrade(2,0)),/cutover/);
  const current={...legacy,...starterMandateEffect(legacy,upgrade(2,14)),height:15};
  assert.equal(starterGrantAmount(current),1_000_000_000_000);
  assert.equal(current.starterMandate.cap,'1000000000000000000');
  assert.equal(remainingStarterClaims(current),MAX_STARTER_WALLETS-2);
  assert.equal(starterClaimAmount(current,buyer),100_000_000_000);
  assert.equal(starterClaimAmount(current,seq),null);
  assert.throws(()=>award(current,buyer),/already received/);
  assert.throws(()=>starterGrantEffect(current,grant(seq,2)),/Incorrect amount/);
  const next=award(current,seq);
  assert.equal(next.starterMandate.spent,1_200_000_000_000);
  assert.equal(starterClaimAmount(next,seq),1_000_000_000_000);
  const stopped={...next,...starterMandateEffect(next,suspension(3)),height:17};
  assert.equal(remainingStarterClaims(stopped),0);
  assert.throws(()=>starterMandateEffect(stopped,authorization(4)),/downgrade/);
  assert.throws(()=>starterMandateEffect(stopped,upgrade(4,next.height)),/cutover/);
  assert.throws(()=>starterMandateEffect(stopped,upgrade(4,14,'1000')),/lifetime/);
  assert.throws(()=>starterMandateEffect(stopped,upgrade(4,14,'1000001000')),/lifetime/);
  const renewed={...stopped,...starterMandateEffect(stopped,upgrade(4,14,'5000')),height:18};
  assert.equal(remainingStarterClaims(renewed),3);
  assert.equal(starterClaimAmount(renewed,other),LEGACY_STARTER_GRANT_AMOUNT);
  assert.equal(starterClaimAmount(renewed,seq),STARTER_GRANT_AMOUNT);
  assert.throws(()=>award(renewed,seq),/already received/);
  assert.equal(renewed.supply,open.supply);
  assert.equal(verifyAdvance({state:legacy,epochHashes:[]},{state:renewed,epochHashes:[]}).state,renewed);
  const tampered={...renewed,starterMandate:{...renewed.starterMandate,authorization:upgrade(4,0,'5000')}};
  assert.throws(()=>verifyAdvance({state:legacy,epochHashes:[]},{state:tampered,epochHashes:[]}),/cutover/);
  assert.throws(()=>verifyAdvance({state:current,epochHashes:[]},{state:tampered,epochHashes:[]}),/cutover/);
});
