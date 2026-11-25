import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAdvance } from '../src/checkpoint.mjs';
import { generateWallet, sign } from '../src/crypto.mjs';
import { applyQuorumTransaction, DISTRIBUTION_RESERVE as reserve, MAINNET,
  saleHoldCommitment, saleMandateEffect, verifySalePrice } from '../src/ledger.mjs';
import { SALE_MERCHANT, SALE_TOKENS, SALE_TERMS, SALE_PRICE_TERMS, saleNanoPerMicro } from '../src/sale-policy.mjs';
import { checkReadiness } from '../src/enrollment.mjs';

const distributor=generateWallet(),buyer=generateWallet().address;
const state={chainId:MAINNET.chainId,networkStage:'mainnet',networkId:MAINNET.networkId,
  sequencer:MAINNET.issuer,reserveClaim:reserve.claim,height:20,tip:'a'.repeat(64),
  balances:{[reserve.address]:reserve.amount},nonces:{[reserve.address]:2},
  totalWorkTokens:0,saleMandate:{active:true,version:1,cap:reserve.amount,spent:0,
    authority:distributor.address,terms:SALE_TERMS}};
const terms={type:'configure-sale-price',from:reserve.address,chainId:state.chainId,nonce:2,terms:SALE_PRICE_TERMS};
const certificate={payload:terms,signature:'0'.repeat(128)};
// Prior authenticated state for transition fixtures; invalid certificates are tested independently.
const priced={...state,salePrice:certificate};
const order={orderId:'wallet_order_000001',to:buyer,evmChainId:1};
const common=(s,type)=>({type,from:distributor.address,chainId:s.chainId,
  nonce:(s.nonces[distributor.address]??0)+1,mandateVersion:s.saleMandate.version});
function settle(s,{v3=false,micro='1',amount=Number(BigInt(micro)*saleNanoPerMicro(v3?SALE_PRICE_TERMS:SALE_TERMS))}={}) {
  const txHash='0x'+'d'.repeat(64);
  return {...common(s,'deliver-sale'),...order,amount,usdtMicros:micro,sequence:1,txHash,logIndex:'0',
    paymentId:'eip155:1:'+txHash+':0',payTo:SALE_MERCHANT,token:SALE_TOKENS[1],...(v3?{terms:SALE_PRICE_TERMS}:{})};
}
function apply(s,p) {
  return applyQuorumTransaction(s,{payload:p,signature:sign(distributor.privateKey,p)},'b'.repeat(64));
}
function reauthorize(s) {
  return {...s,...saleMandateEffect(s,{type:'authorize-sales',from:reserve.address,chainId:s.chainId,
    cap:s.saleMandate.cap,authority:distributor.address,terms:SALE_PRICE_TERMS})};
}

test('a rate configuration cannot enable a new spending tariff or reinterpret a legacy receipt',()=>{
  assert.equal(saleNanoPerMicro(SALE_TERMS),10_000n);
  assert.equal(saleNanoPerMicro(SALE_PRICE_TERMS),2_000n);
  assert.throws(()=>saleNanoPerMicro('unknown'),/Unknown/);
  assert.throws(()=>reauthorize(state),/Invalid USDT sale price/);
  assert.throws(()=>apply(priced,settle(priced,{v3:true})),/separately authorized/);
  const hold={...common(state,'hold-sale'),...order,amount:10_000};
  const legacyHeld=apply(state,hold), future={...legacyHeld,salePrice:certificate};
  const original=settle(future);
  assert.equal(apply(future,original).balances[buyer],10_000);
  assert.throws(()=>apply(future,{...original,amount:2000}),/amount/);
  const rotated=reauthorize(future);
  assert.equal(apply(rotated,settle(rotated)).balances[buyer],10_000);
  const otherOrder={...hold,...common(rotated,'hold-sale'),orderId:'another_order_000000'};
  assert.throws(()=>apply(rotated,otherOrder),/Legacy delivery/);
  assert.throws(()=>apply(rotated,{...settle(rotated),orderId:otherOrder.orderId}),/Legacy delivery/);
});

test('separately authorized v3 holds and payments bind their signed terms and exact token units',()=>{
  const active=reauthorize(priced);
  const hold={...common(active,'hold-sale'),...order,terms:SALE_PRICE_TERMS,amount:2000};
  const held=apply(active,hold);
  assert.notEqual(saleHoldCommitment(hold),saleHoldCommitment({...order,amount:2000}));
  assert.throws(()=>apply(held,settle(held)),/Legacy delivery/);
  assert.throws(()=>apply(held,settle(held,{v3:true,amount:10000})),/amount/);
  assert.equal(apply(held,settle(held,{v3:true})).balances[buyer],2000);
  assert.throws(()=>apply(active,{...hold,amount:2001}),/inventory/);
});

test('price checkpoints require a reserve signature and cannot discard a configured price',()=>{
  assert.doesNotThrow(()=>verifySalePrice(state));
  assert.throws(()=>verifySalePrice(priced),/signature/);
  const changed={...terms,from:distributor.address};
  assert.throws(()=>verifySalePrice({...state,salePrice:{payload:changed,signature:sign(distributor.privateKey,changed)}}),
    /configured sale price/);
  assert.throws(()=>verifyAdvance({state:priced,epochHashes:[]},{state:{...state,height:21},epochHashes:[]}),/price configuration/);
});

test('price-aware validator readiness is negotiated separately from the original escrow capability',async()=>{
  const w=generateWallet(),candidate={chainId:state.chainId,address:w.address,origin:'https://v.example',instanceId:'id'};
  const responder=price=>async url=>{
    const params=new URL(url).searchParams;
    const payload={domain:'gpuchain/validator-ready/v1',...candidate,challenge:params.get('challenge'),
      moneyCodec:'nanocoin-decimal-v1',saleEscrow:SALE_TERMS};
    if (price && params.get('salePrice')==='3') payload.salePrice=SALE_PRICE_TERMS;
    return Response.json({payload,signature:sign(w.privateKey,payload)});
  };
  await checkReadiness(candidate,responder(false),true);
  await assert.rejects(checkReadiness(candidate,responder(false),true,false,false,true),/readiness/);
  assert.equal((await checkReadiness(candidate,responder(true),true,false,false,true)).address,w.address);
});
