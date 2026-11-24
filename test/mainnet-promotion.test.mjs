import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import genesis from '../networks/sites-testnet.json' with {type:'json'};
import { authenticate, verifyAdvance } from '../src/checkpoint.mjs';
import { checkpointProof } from '../src/checkpoint-base.mjs';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { checkReadiness } from '../src/enrollment.mjs';
import {
  applyBlock, applyQuorumTransaction, CONTEXT, createBlock, createGenesis, DISTRIBUTION_RESERVE as reserve,
  distributionReserveEffect, MAINNET, mainnetPromotionEffect, mainnetPromotionPayload, MODEL, replay,
  saleMandateEffect, verifyNetworkStage,
} from '../src/ledger.mjs';
import { SALE_TERMS } from '../src/sale-policy.mjs';

const envelope=(wallet,payload)=>({payload,signature:sign(wallet.privateKey,payload)});

function predecessor() {
  const base=replay([genesis],genesis.hash);
  const issued={...base,...distributionReserveEffect(base,{type:'issue-reserve',chainId:genesis.hash,
    from:base.sequencer,to:reserve.address,claim:reserve.claim,amount:reserve.amount})};
  return {...issued,...saleMandateEffect(issued,{type:'authorize-sales',chainId:genesis.hash,from:reserve.address,
    authority:generateWallet().address,cap:reserve.amount,terms:SALE_TERMS}),height:2,tip:'a'.repeat(64),
    nonces:{[base.sequencer]:1,[reserve.address]:1}};
}

test('mainnet proposal binds one exact incumbent state and preserves the complete issued ledger',()=>{
  const state=predecessor(), p=mainnetPromotionPayload(state), fake=envelope(generateWallet(),p);
  assert.equal(p.anchorStateHash,hash(state));
  assert.equal(p.anchorHeight,state.height);
  assert.equal(p.anchorTip,state.tip);
  assert.equal(p.nonce,2);
  assert.equal(p.from,genesis.payload.sequencer);
  assert.equal(p.chainId,genesis.hash);
  assert.equal(p.networkId,MAINNET.networkId);
  // The pure state patch used only after signature checks by the transition.
  // No production key is used to simulate a valid issuer signature.
  const patch=mainnetPromotionEffect(state,fake);
  assert.deepEqual(Object.keys(patch).sort(),['mainnetPromotion','networkId','networkStage']);
  const next={...state,...patch,height:3,nonces:{...state.nonces,[p.from]:p.nonce}};
  for (const k of ['balances','supply','chainId','providers','saleMandate','epochHashes','reserveClaim','totalWorkTokens']) {
    assert.deepEqual(next[k],state[k]);
  }
  assert.throws(()=>verifyNetworkStage(next,replay([genesis])),/signature/);
  assert.throws(()=>mainnetPromotionPayload(next),/unpromoted/);
  assert.throws(()=>mainnetPromotionEffect({...state,tip:'b'.repeat(64)},fake),/current tip/);
  assert.throws(()=>mainnetPromotionEffect({...state,supply:0},fake),/distribution reserve/);
  assert.throws(()=>mainnetPromotionEffect({...state,saleMandate:{...state.saleMandate,active:false}},fake),/mandate/);
  assert.throws(()=>mainnetPromotionEffect(state,{...fake,payload:{...p,networkId:'another'}}),/official network/);
  const outsider=generateWallet(), spoof={...p,from:outsider.address,nonce:1};
  assert.throws(()=>applyQuorumTransaction(state,envelope(outsider,spoof),'0'.repeat(64)),/original bootstrap/);
  assert.throws(()=>applyQuorumTransaction(state,fake,'0'.repeat(64)),/sender signature/);
});

test('a signed private network cannot impersonate the production phase; persisted observers refuse downgrade',()=>{
  const w=generateWallet(), g=createGenesis(w,{allocations:{},providers:[]});
  const copy={...replay([g]),height:1,tip:'f'.repeat(64),networkId:MAINNET.networkId};
  const cp=state=>({genesis:g,state,epochHashes:[],signature:sign(w.privateKey,checkpointProof(state,[]))});
  assert.throws(()=>authenticate(cp(copy),g.hash),/authenticated promotion/);
  assert.throws(()=>authenticate(cp({...copy,networkStage:'mainnet'}),g.hash),/Invalid mainnet identity/);
  const p=predecessor(), promoted={...p,...mainnetPromotionEffect(p,envelope(w,mainnetPromotionPayload(p))),height:3};
  const older={state:p,epochHashes:[]}, newer={state:promoted,epochHashes:[]};
  assert.equal(verifyAdvance(older,newer),newer);
  assert.throws(()=>verifyAdvance({...older,state:{...p,tip:'b'.repeat(64)}},newer),/promotion anchor/);
  assert.throws(()=>verifyAdvance(newer,{...older,state:{...p,height:4}}),/promotion downgrade/);
});

test('historical receipts stay valid; mainnet requires canonical signed K and V precisions of at least Q8',()=>{
  const seq=generateWallet(),payer=generateWallet(),provider=generateWallet();
  const g=createGenesis(seq,{providers:[provider.address],allocations:{[payer.address]:1_000_000}});
  const legacy=replay([g]), production={...legacy,networkStage:'mainnet'};
  const p={type:'inference',chainId:g.hash,from:payer.address,nonce:1,provider:provider.address,model:MODEL,
    contextWindow:CONTEXT,inputTokens:1,outputTokens:1,cachedTokens:0,requestHash:'a'.repeat(64),responseHash:'b'.repeat(64)};
  const tx=payload=>({...envelope(payer,payload),providerSignature:sign(provider.privateKey,payload)});
  assert.equal(applyBlock(legacy,createBlock(legacy,tx(p),seq)).height,1);
  assert.throws(()=>createBlock(production,tx(p),seq),/kvCache/);
  for (const kvCache of [{k:'Q8',v:'Q4'},{k:'Q4',v:'F32'},{k:'q8',v:'Q8'},{k:'Q8',v:'Q8',extra:true}]) {
    assert.throws(()=>createBlock(production,tx({...p,kvCache}),seq),/precision|fields/);
  }
  const high={...p,kvCache:{k:'Q8',v:'BF16'}};
  assert.equal(applyBlock(production,createBlock(production,tx(high),seq)).balances[provider.address],620);
  assert.throws(()=>createBlock(production,{...tx(high),payload:{...high,kvCache:{k:'F32',v:'F32'}}},seq),/signature/);
});

const launchFile=new URL('../networks/mainnet-anchor.json',import.meta.url);
test('production validator admission requires the mainnet Q8 receipt protocol in its fresh signed response',async()=>{
  const wallet=generateWallet(), candidate={chainId:genesis.hash,address:wallet.address,origin:'https://node.example',
    instanceId:'00112233-4455-4677-8899-aabbccddeeff'};
  function responder(mainnet) {
    return async raw=>{
      const url=new URL(raw);
      assert.equal(url.searchParams.get('stage'),'mainnet');
      assert.equal(url.searchParams.get('money'),'exact');
      const payload={domain:'gpuchain/validator-ready/v1',...candidate,challenge:url.searchParams.get('challenge'),
        moneyCodec:'nanocoin-decimal-v1',saleEscrow:SALE_TERMS};
      if(mainnet) payload.validatorProtocol=MAINNET.validatorProtocol;
      return Response.json(envelope(wallet,payload));
    };
  }
  await assert.rejects(checkReadiness(candidate,responder(false),true,true),/did not prove readiness/);
  assert.equal((await checkReadiness(candidate,responder(true),true,true)).address,wallet.address);
});

test('the published mainnet launch checkpoint authenticates to the original genesis', {skip:!existsSync(launchFile)},()=>{
  const launch=authenticate(JSON.parse(readFileSync(launchFile,'utf8')),genesis.hash);
  assert.equal(launch.state.networkStage,'mainnet');
  assert.equal(launch.state.networkId,MAINNET.networkId);
  assert.equal(launch.state.height,launch.state.mainnetPromotion.payload.anchorHeight+1);
  assert.equal(launch.state.supply,'1000000000001000000000');
  assert.equal(launch.state.saleMandate.terms,SALE_TERMS);
});
