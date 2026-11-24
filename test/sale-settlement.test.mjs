import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import genesis from '../networks/sites-testnet.json' with {type:'json'};
import { generateWallet, sign } from '../src/crypto.mjs';
import { checkReadiness } from '../src/enrollment.mjs';
import { createBlock, applyBlock, applyQuorumTransaction, replay, distributionReserveEffect, saleMandateEffect, saleDeliveryEffect, heldSaleAmount, spendableBalance,
  DISTRIBUTION_RESERVE as r } from '../src/ledger.mjs';
import { SALE_MERCHANT, SALE_TOKENS, SALE_TERMS, SALE_NANO_PER_MICRO } from '../src/sale-policy.mjs';
import { deliverVerifiedOrder, updateVerifiedHold } from '../hosting/sites/sale-settlement.mjs';

function network() {
  const distributor=generateWallet(), sequencer=generateWallet(), buyer=generateWallet();
  let state=replay([genesis],genesis.hash);
  state={...state,...distributionReserveEffect(state,{type:'issue-reserve',chainId:genesis.hash,from:state.sequencer,
    to:r.address,amount:r.amount,claim:r.claim})};
  const authorize={type:'authorize-sales',chainId:genesis.hash,from:r.address,authority:distributor.address,cap:r.amount,terms:SALE_TERMS};
  // Disposable block signer for local transition tests. Live heads always authenticate to the real pinned genesis.
  state={...state,...saleMandateEffect(state,authorize),sequencer:sequencer.address};
  function commit(tx) { state=applyBlock(state,createBlock(state,tx,sequencer)); return {head:{state}}; }
  function quorumCommit(tx) {
    state=applyQuorumTransaction(state,tx,'f'.repeat(64));
    return {head:{state,authority:{}}};
  }
  function order(i,chain=1,micro='1250000') {
    const txHash='0x'+i.toString(16).padStart(64,'0'), logIndex='3';
    return {orderId:'order_'+String(i).padStart(16,'0'),paymentId:'eip155:'+chain+':'+txHash+':'+logIndex,
      to:buyer.address,amountNano:String(BigInt(micro)*SALE_NANO_PER_MICRO),usdtMicros:micro,evmChainId:chain,
      txHash,logIndex,token:SALE_TOKENS[chain],payTo:SALE_MERCHANT};
  }
  return {distributor,sequencer,buyer,authorize,order,commit,quorumCommit,read:()=>({head:{state}})};
}

function store(t) {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE sale_delivery(sequence INTEGER PRIMARY KEY,payment_id TEXT UNIQUE NOT NULL,
    order_id TEXT UNIQUE NOT NULL,intent TEXT,confirmation TEXT);
    CREATE UNIQUE INDEX sale_single_pending ON sale_delivery((1)) WHERE confirmation IS NULL;`);
  t.after(()=>sqlite.close());
  return {sqlite,prepare(sql) {
    const stmt=sqlite.prepare(sql);
    let values=[];
    return {bind(...args){values=args;return this;},
      async first(){return stmt.get(...values) ?? null;},
      async run(){return {meta:{changes:stmt.run(...values).changes}};}};
  }};
}

test('a paid delivery debits the reserve with zero fees; duplicates or changed terms cannot be paid again',async t=>{
  const n=network(), db=store(t), order=n.order(1);
  const present=()=>n.read().head.state;
  const before=present().balances[r.address];
  const opts={read:n.read,commit:(_live,tx)=>n.commit(tx)};
  const outcome=await deliverVerifiedOrder(db,order,n.distributor,opts);
  assert.equal(outcome.sequence,1);
  assert.equal(present().balances[n.buyer.address],12_500_000_000);
  assert.equal(BigInt(present().balances[r.address]),BigInt(before)-12_500_000_000n);
  assert.equal(present().saleMandate.spent,12_500_000_000);
  assert.equal(present().supply,'1000000000001000000000');
  assert.equal(present().nonces[r.address],undefined);
  assert.equal(present().nonces[n.distributor.address],1);
  assert.deepEqual(await deliverVerifiedOrder(db,order,n.distributor,opts),outcome);
  await assert.rejects(deliverVerifiedOrder(db,{...order,to:generateWallet().address},n.distributor,opts),/changed/);
  await assert.rejects(deliverVerifiedOrder(db,{...order,orderId:'another_order_00001'},n.distributor,opts),/assigned/);
  const wrong=n.order(2);
  for (const change of [{token:SALE_TOKENS[56]},{payTo:'0x'+'a'.repeat(40)},{amountNano:'1250000001'},
    {paymentId:'eip155:56:'+wrong.txHash+':3'}]) {
    await assert.rejects(deliverVerifiedOrder(db,{...wrong,...change},n.distributor,opts));
  }
  assert.equal(present().height,1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sale_delivery').get().n,1);
});

test('after a lost ledger reply a different order recovers the first receipt before claiming the next slot',async t=>{
  const db=store(t),n=network(), first=n.order(1),second=n.order(2,56,'1');
  await assert.rejects(deliverVerifiedOrder(db,first,n.distributor,{read:n.read,commit:(_v,tx)=>{
    n.commit(tx);throw Error('Connection dropped after commit');
  }}),/dropped/);
  assert.ok(db.sqlite.prepare('SELECT intent FROM sale_delivery').get().intent);
  const opts={read:n.read,commit:(_v,tx)=>n.commit(tx)};
  assert.equal((await deliverVerifiedOrder(db,second,n.distributor,opts)).sequence,2);
  const a=await deliverVerifiedOrder(db,first,n.distributor,opts);
  assert.equal(a.sequence,1);
  assert.equal(n.read().head.state.height,2);
  assert.equal(n.read().head.state.balances[n.buyer.address],12_500_010_000);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sale_delivery WHERE intent IS NOT NULL').get().n,0);
});

test('reserve controls cumulative authorization, suspension and rotation; sale signer cannot transfer other funds',async t=>{
  const n=network(), db=store(t), state=n.read().head.state, other=generateWallet();
  assert.throws(()=>saleMandateEffect(state,{...n.authorize,from:other.address}),/reserve wallet/);
  assert.throws(()=>saleMandateEffect(state,{...n.authorize,cap:'1000000000000000000001'}),/cap/);
  assert.throws(()=>saleMandateEffect(state,{...n.authorize,authority:r.address}),/separate/);
  const transfer={type:'transfer',from:n.distributor.address,to:other.address,chainId:r.chainId,nonce:1,amount:1};
  assert.throws(()=>createBlock(state,{payload:transfer,signature:sign(n.distributor.privateKey,transfer)},n.sequencer),/only settle/);
  let paid;
  await deliverVerifiedOrder(db,n.order(1),n.distributor,{read:n.read,commit:(_v,tx)=>{paid=tx.payload;return n.commit(tx);}});
  const after=n.read().head.state;
  const suspended={...after,...saleMandateEffect(after,{type:'suspend-sales',chainId:r.chainId,from:r.address})};
  assert.equal(suspended.saleMandate.version,2);
  assert.throws(()=>saleDeliveryEffect(suspended,paid),/current/);
  const rotated={...suspended,...saleMandateEffect(suspended,{...n.authorize,authority:other.address,cap:12_500_000_000})};
  assert.equal(rotated.saleMandate.spent,12_500_000_000);
  assert.equal(rotated.saleMandate.version,3);
  assert.throws(()=>saleDeliveryEffect(rotated,{...paid,sequence:2}),/current/);
  assert.throws(()=>saleDeliveryEffect(rotated,{...paid,from:other.address,mandateVersion:3,sequence:2,
    txHash:'0x'+'a'.repeat(64),paymentId:'eip155:1:0x'+'a'.repeat(64)+':3'}),/allowance/);
});

test('reserve-issued chains require the large-amount capability in the signed validator challenge',async()=>{
  const wallet=generateWallet(), candidate={chainId:r.chainId,address:wallet.address,origin:'https://vote.example',
    instanceId:'00112233-4455-4677-8899-aabbccddeeff'};
  const respond=capability=>async url=>{
    const challenge=new URL(url).searchParams.get('challenge');
    const payload={domain:'gpuchain/validator-ready/v1',...candidate,challenge};
    if (capability) {payload.moneyCodec='nanocoin-decimal-v1';payload.saleEscrow=SALE_TERMS;}
    return Response.json({payload,signature:sign(wallet.privateKey,payload)});
  };
  await checkReadiness(candidate,respond(false));
  await assert.rejects(checkReadiness(candidate,respond(false),true),/did not prove readiness/);
  const accepted=await checkReadiness(candidate,respond(true),true);
  assert.equal(accepted.address,wallet.address);
});

test('quorum orders lock exactly the promised units, recover a missed acquisition reply, and consume a bound hold only once',async t=>{
  const n=network(), db=store(t),o=n.order(7,56,'2500000'), other=n.order(8,1,'1');
  db.sqlite.exec('CREATE TABLE sale_orders(id TEXT PRIMARY KEY,state TEXT,recipient TEXT,chain_id INTEGER,amount_micro INTEGER)');
  const insert=db.sqlite.prepare("INSERT INTO sale_orders VALUES(?,'holding',?,?,?)");
  for (const x of [o,other]) insert.run(x.orderId,x.to,x.evmChainId,BigInt(x.usdtMicros));
  const read=()=>({head:{...n.read().head,authority:{}},url:'https://fixture.invalid',quorumEscrowSupported:true});
  const ops={read,commit:(_v,tx)=>n.quorumCommit(tx)};
  await assert.rejects(deliverVerifiedOrder(db,o,n.distributor,ops),/matching confirmed sale hold/);
  await assert.rejects(updateVerifiedHold(db,o,n.distributor,true,{...ops,commit:(live,tx)=>{
    ops.commit(live,tx);throw Error('Lost hold reply');
  }}),/Lost hold reply/);
  const held=await updateVerifiedHold(db,o,n.distributor,true,ops);
  assert.equal(held.held,true);
  assert.equal(n.read().head.state.height,1);
  const state=n.read().head.state;
  assert.equal(heldSaleAmount(state),25_000_000_000n);
  assert.equal(spendableBalance(state,r.address),BigInt(r.amount)-25_000_000_000n);
  assert.throws(()=>saleMandateEffect(state,{...n.authorize,cap:24_999_999_999}),/cap/);
  const bad={...o,to:generateWallet().address};
  await assert.rejects(deliverVerifiedOrder(db,bad,n.distributor,ops),/matching confirmed sale hold/);
  await assert.rejects(updateVerifiedHold(db,o,n.distributor,false,ops),/order phase/);
  await updateVerifiedHold(db,other,n.distributor,true,ops);
  const receipt=await deliverVerifiedOrder(db,o,n.distributor,ops);
  assert.equal(receipt.sequence,1);
  assert.equal(n.read().head.state.balances[o.to],25_000_000_000);
  assert.equal(heldSaleAmount(n.read().head.state),10_000n);
  assert.deepEqual(await deliverVerifiedOrder(db,o,n.distributor,ops),receipt);
  db.sqlite.prepare("UPDATE sale_orders SET state='releasing' WHERE id=?").run(other.orderId);
  const done=await updateVerifiedHold(db,other,n.distributor,false,ops);
  assert.equal(done.held,false);
  assert.equal(n.read().head.state.saleHolds,undefined);
  assert.deepEqual(await updateVerifiedHold(db,other,n.distributor,false,ops),done);
  await assert.rejects(updateVerifiedHold(db,other,n.distributor,true,ops),/order phase/);
});
