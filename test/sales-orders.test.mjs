import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSalesRoute } from '../hosting/sites/sales.mjs';
import { MERCHANT } from '../hosting/sites/usdt.mjs';
import { commitHostedTransaction, prepareSalesRetirement, retirementGuard } from '../hosting/sites/sale-holds.mjs';
import { DISTRIBUTION_RESERVE as reserve } from '../src/ledger.mjs';

const migration=readFileSync(new URL('../hosting/sites/drizzle/0001_sales.sql',import.meta.url),'utf8');
const scannerMigration=readFileSync(new URL('../hosting/sites/drizzle/0002_sale_scan_liveness.sql',import.meta.url),'utf8');
const escrowMigration=readFileSync(new URL('../hosting/sites/drizzle/0003_sale_quorum_escrow.sql',import.meta.url),'utf8');
const path='/v1/sales/';
const txHash='0x'+'4'.repeat(64);
const secret='unit-test-sweep-secret-never-deployed';

function fixture(t) {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(migration);sqlite.exec(scannerMigration);sqlite.exec(escrowMigration);t.after(()=>sqlite.close());
  sqlite.exec("CREATE TABLE ledger_head (id INTEGER PRIMARY KEY,tip TEXT,checkpoint TEXT); INSERT INTO ledger_head VALUES(1,'initial','{}')");
  sqlite.prepare("INSERT INTO sale_scan_state VALUES(1, CAST(strftime('%s','now') AS INTEGER)*1000)").run();
  const db={withSession(){return this;},prepare(query){
    const stmt=sqlite.prepare(query);let args=[];
    return {bind(...values){args=values;return this;},
      async first(){return stmt.get(...args) ?? null;},async run(){return {meta:{changes:stmt.run(...args).changes}};}};
  }};
  const env={DB:db,USDT_SWEEP_TOKEN:secret,USDT_ETH_START_BLOCK:'100',USDT_ETH_RPC_URLS:'["https://a.example","https://b.example"]'};
  const f={sqlite,db,env,healthy:true,enabled:true,inventoryNano:'1000000',deliveries:0,scan:'empty',failSettle:false,
    sequence:0,lastPaymentId:null,retired:false};
  function proof(order) {
    return {chainId:1,txHash,eventId:'eip155:1:'+txHash+':0',payer:order.payer,to:order.gpuAddress,
      amountMicro:order.amountMicro,blockNumber:'103',blockHash:'0x'+'b'.repeat(64),blockTimestamp:String(Math.floor(order.createdAt/1000)),
      merchant:MERCHANT,logIndex:'0'};
  }
  const dependencies={verifyQuote:async q=>{assert.equal(q.signature,'fixture');},
    inventory:async()=>({inventoryNano:f.inventoryNano,enabled:f.enabled,networkStage:f.stage ?? 'mainnet',saleSequence:f.sequence,
      ledgerSalePaymentId:f.lastPaymentId,bootstrapTip:f.retired?null:sqlite.prepare('SELECT tip FROM ledger_head WHERE id=1').get().tip,
      mandateRemainingNano:f.inventoryNano,quorumEscrowSupported:f.quorum,quorumFence:f.quorum?'retired:authority':null,
      freeOnChainNano:f.inventoryNano}),
    acquireHold:async(_env,_db,o)=>{f.acquired=o;return {held:!!f.grant};},
    releaseHold:async(_env,_db,o)=>{f.released=o;return {held:!f.allowRelease};},
    health:async()=>{if(!f.healthy)throw Error('offline');if(f.pause)await f.pause();
      return {blockNumber:'101',blockTimestamp:String(Math.floor(Date.now()/1000))};},
    checkPayment:async order=>f.scan==='late'?{...proof(order),blockTimestamp:String(Math.floor(order.expiresAt/1000)+100)}:proof(order),
    findPayment:async order=>{
      if(f.scan==='error')throw Error('RPC unavailable');
      return {matches:f.scan==='paid'?[proof(order)]:[],nextBlock:'111',complete:f.scan==='expire',
        finalizedThroughTimestamp:String(Math.floor(order.expiresAt/1000)+1)};
    },
    settle:async(_env,_db,order)=>{
      if(f.failSettle)throw Error(typeof f.failSettle==='string'?f.failSettle:'simulated restart');
      assert.equal(order.paymentId,'eip155:1:'+txHash+':0');
      assert.equal(order.amountNano,(BigInt(order.usdtMicros)*10000n).toString());
      f.deliveries++;
      return {sequence:1,tip:'d'.repeat(64),height:8};
    }
  };
  let route=createSalesRoute({...dependencies,acceptNewOrders:true});
  f.pauseSales=()=>{route=createSalesRoute(dependencies);};
  f.call=async(name,body,auth)=>{
    const headers={'content-type':'application/json'};if(auth)headers.authorization='Bearer '+auth;
    const req=new Request('https://shop.example'+path+name,{method:body===undefined?'GET':'POST',
      headers,body:body===undefined?undefined:JSON.stringify(body)});
    const res=await route(req,env,path+name);return {code:res.status,value:await res.json()};
  };
  f.quote=(who='1',amountMicro='60')=>({chainId:1,payer:'0x'+who.repeat(40),gpuAddress:who.repeat(64),
    amountMicro,requestId:who.repeat(32),issuedAt:Date.now()-1000,signature:'fixture'});
  f.due=()=>sqlite.exec('UPDATE sale_orders SET scan_after=0');
  return f;
}

test('paused checkout refuses new quotes on both chains and still reconciles earlier payments once',async t=>{
  const f=fixture(t),order=(await f.call('quote',f.quote())).value;
  f.pauseSales();
  const status=(await f.call('status')).value;
  assert.equal(status.paused,true);
  assert.equal(status.merchant,null);
  for(const chainId of [1,56]) {
    assert.deepEqual(status.networks[chainId],{accepting:false,paymentReady:false,reason:'sales-paused'});
    const result=await f.call('quote',{...f.quote('2'),chainId});
    assert.equal(result.code,503);
    assert.equal(result.value.code,'sales_paused');
  }
  const reserved=(await f.call('orders/'+order.id)).value;
  assert.equal(reserved.status,'reserved');
  for (const field of ['payTo','token','usdtUnits']) assert.equal(reserved[field],null);
  f.scan='paid';f.due();
  assert.equal((await f.call('tick',{},secret)).code,200);
  assert.equal((await f.call('orders/'+order.id)).value.status,'delivered');
  assert.equal(f.deliveries,1);
});

test('quoting is fail-closed, idempotent, and atomic against concurrent inventory claims',async t=>{
  const f=fixture(t);
  const a=f.quote(),b=f.quote('2');
  f.healthy=false;
  assert.equal((await f.call('quote',a)).code,503);
  f.healthy=true;
  const results=await Promise.all([f.call('quote',a),f.call('quote',b)]);
  assert.deepEqual(results.map(x=>x.code).sort(),[201,409]);
  const winner=results[0].code===201?a:b;
  const created=results.find(r=>r.code===201).value;
  assert.equal(created.startBlock,'102');assert.equal(created.usdtUnits,'60');assert.equal(created.status,'reserved');
  assert.equal((await f.call('quote',winner)).value.id,created.id);
  assert.equal((await f.call('quote',{...winner,amountMicro:'1'})).code,409);
  assert.equal((await f.call('status')).value.inventoryNano,'400000');
  assert.equal((await f.call('tick',{},'other')).code,403);
  assert.equal((await f.call('quote',{...f.quote('3','1'),issuedAt:Date.now()-180000})).code,400);
  assert.equal((await f.call('quote',{...f.quote('3','1'),chainId:56})).code,503);
  assert.equal((await f.call('quote',{...f.quote('3','1'),gpuAddress:'95da9783a4ab7c8115ce1f4e599b2ab7f688779976d6221ea456d183429c7aae'})).code,400);
});

test('fresh orders require a recently successful scheduled sweep, while existing orders can still reconcile',async t=>{
  const f=fixture(t),first=await f.call('quote',f.quote());
  assert.equal(first.code,201);
  f.sqlite.exec('UPDATE sale_scan_state SET last_tick_ms=0');
  const down=(await f.call('status')).value;
  assert.equal(down.scanner.online,false);assert.equal(down.accepting,false);
  assert.equal((await f.call('quote',f.quote('2','1'))).code,503);
  f.scan='paid';
  assert.equal((await f.call('orders/'+first.value.id)).value.status,'delivered');
  assert.equal((await f.call('tick',{},secret)).code,200);
  assert.equal((await f.call('status')).value.scanner.online,true);
});

test('only a signed mainnet stage admits new purchases; a registered payment can still be recovered',async t=>{
  const f=fixture(t), existing=(await f.call('quote',f.quote())).value;
  f.stage='testnet';
  const status=(await f.call('status')).value;
  assert.equal(status.networkStage,'testnet');assert.equal(status.accepting,false);
  assert.equal(status.networks['1'].reason,'mainnet-pending');
  assert.equal((await f.call('quote',f.quote('2','1'))).code,503);
  f.scan='paid';assert.equal((await f.call('orders/'+existing.id)).value.status,'delivered');
});

test('a signed quote is paid by an unattended scanner; delivery survives retry and consumes each transfer once',async t=>{
  const f=fixture(t);const {value:order}=await f.call('quote',f.quote('2','3'));
  f.scan='paid';f.failSettle=true;
  assert.equal((await f.call('tick',{},secret)).code,503);
  assert.equal(f.sqlite.prepare('SELECT state FROM sale_orders').get().state,'paid');
  f.due();f.failSettle=false;
  assert.equal((await f.call('tick',{},secret)).code,200);
  const finished=(await f.call('orders/'+order.id)).value;
  assert.equal(finished.status,'delivered');assert.equal(finished.ledgerHeight,8);assert.equal(finished.txHash,txHash);
  assert.equal((await f.call('claim',{orderId:order.id,txHash})).value.status,'delivered');
  assert.equal(f.deliveries,1);
  assert.equal((await f.call('status')).value.inventoryNano,'970000'); // stale inventory must debit already delivered sales
  const q=f.quote('2','3');q.requestId='a'.repeat(32);
  const second=(await f.call('quote',q)).value;
  assert.equal((await f.call('claim',{orderId:second.id,txHash})).code,409);
  assert.equal(f.deliveries,1);
});

test('an expired time alone cannot release stock; late proof remains visible for merchant reconciliation',async t=>{
  const f=fixture(t);
  const {value:order}=await f.call('quote',f.quote());
  f.sqlite.exec('UPDATE sale_orders SET expires_ms=expires_ms-3600000, created_ms=created_ms-3600000');
  f.scan='error';assert.equal((await f.call('tick',{},secret)).code,503);
  assert.equal((await f.call('status')).value.inventoryNano,'400000');
  f.due();f.scan='expire';
  assert.equal((await f.call('tick',{},secret)).code,200);
  assert.equal((await f.call('orders/'+order.id)).value.status,'expired');
  assert.equal((await f.call('status')).value.inventoryNano,'1000000');
  f.scan='late';
  const late=(await f.call('claim',{orderId:order.id,txHash})).value;
  assert.equal(late.status,'review');assert.equal(late.latePaymentHash,txHash);assert.equal(f.deliveries,0);
});

function source() {
  return {chainId:reserve.chainId,reserveClaim:reserve.claim,balances:{[reserve.address]:1000000},
    saleMandate:{active:true,authority:'delegate',cap:1000000,spent:0},tip:'initial'};
}

test('the ledger checks held inventory and mandate headroom at commit; unreserved nanocoins remain spendable',async t=>{
  const f=fixture(t),state=source();
  const quote=(await f.call('quote',f.quote('1','60'))).value;
  assert.equal((await f.call('status')).value.reservedNano,'600000');
  const transfer=(balance,tip='next')=>({...state,tip,balances:{[reserve.address]:balance}});
  await assert.rejects(commitHostedTransaction(f.db,state,transfer(599999),'{}','transfer'),/reserved/);
  await assert.rejects(commitHostedTransaction(f.db,state,{...state,tip:'next',saleMandate:{...state.saleMandate,cap:599999}},
    '{}','authorize-sales'),/reserved/);
  await assert.rejects(commitHostedTransaction(f.db,state,{...state,tip:'next',saleMandate:{...state.saleMandate,authority:'other'}},
    '{}','authorize-sales'),/reserved/);
  await assert.rejects(commitHostedTransaction(f.db,state,{...state,tip:'next',saleMandate:{...state.saleMandate,active:false}},
    '{}','suspend-sales'),/reserved/);
  const next=transfer(600000);
  await commitHostedTransaction(f.db,state,next,'{}','transfer');
  // The ledger settled an order, then the Worker crashed before the sales-order acknowledgement.
  // Its quantity must not be held a second time against the reduced on-chain balance.
  const event='eip155:1:'+txHash+':0';
  f.sqlite.prepare("UPDATE sale_orders SET state='paid',event_id=? WHERE id=?").run(event,quote.id);
  f.sqlite.prepare("INSERT INTO sale_delivery(sequence,payment_id,order_id,intent) VALUES(1,?,?,'{}')").run(event,quote.id);
  f.sequence=1;f.lastPaymentId=event;
  assert.equal((await f.call('status')).value.reservedNano,'0');
  f.lastPaymentId='another-payment';
  assert.equal((await f.call('status')).value.reservedNano,'600000');
});

test('a competing wallet spend vitiates an in-flight quote before the reservation can be published',async t=>{
  const f=fixture(t),state=source(),entered=Promise.withResolvers(),resume=Promise.withResolvers();
  f.pause=async()=>{entered.resolve();await resume.promise;};
  const attempt=f.call('quote',f.quote());
  await entered.promise;
  const after={...state,tip:'spent',balances:{[reserve.address]:10000}};
  await commitHostedTransaction(f.db,state,after,'{}','transfer');
  f.inventoryNano='10000';resume.resolve();
  assert.equal((await attempt).code,409);
  assert.equal((await f.call('status')).value.openOrders,0);
  assert.equal((await f.call('quote',f.quote('2','1'))).code,201);
});

test('retirement drains existing orders and atomically prevents new reservations; legacy orders can still settle',async t=>{
  const f=fixture(t),s=source(),o=(await f.call('quote',f.quote())).value;
  assert.equal(await prepareSalesRetirement(f.db,s),false);
  assert.equal((await f.call('status')).value.intakeMode,'draining');
  assert.equal((await f.call('quote',f.quote('2','2'))).code,503);
  assert.equal(f.sqlite.prepare('UPDATE ledger_head SET tip=? WHERE id=1'+retirementGuard(s)).run('retired').changes,0);
  f.scan='paid';assert.equal((await f.call('orders/'+o.id)).value.status,'delivered');
  assert.equal(await prepareSalesRetirement(f.db,s),true);
  assert.equal(f.sqlite.prepare('UPDATE ledger_head SET tip=? WHERE id=1'+retirementGuard(s)).run('retired').changes,1);
  f.retired=true;
  assert.equal((await f.call('status')).value.intakeMode,'retired');
  assert.equal((await f.call('quote',f.quote('2','2'))).code,503);
});

test('quorum checkout exposes payment only after an authenticated hold, and frees a finalized empty order after certified release',async t=>{
  const f=fixture(t);
  f.retired=true;f.quorum=true;f.sqlite.exec("UPDATE ledger_head SET tip='retired:authority' WHERE id=1");
  const status=(await f.call('status')).value;
  assert.equal(status.intakeMode,'validator');assert.equal(status.coinsPerUsdt,10);assert.equal(status.priceUsdt,'0.1');
  const q=f.quote(),pending=(await f.call('quote',q)).value;
  assert.equal(pending.status,'holding');assert.equal(pending.payTo,null);
  assert.equal(pending.amountNano,'600000');assert.equal(f.acquired.amountNano,'600000');
  assert.equal((await f.call('quote',q)).value.id,pending.id);
  f.grant=true;f.due();
  const funded=(await f.call('orders/'+pending.id)).value;
  assert.equal(funded.status,'reserved');assert.equal(funded.payTo,MERCHANT);
  f.due();f.scan='expire';
  assert.equal((await f.call('orders/'+pending.id)).value.status,'releasing');
  f.due();
  assert.equal((await f.call('tick',{},secret)).code,503);
  assert.equal((await f.call('status')).value.reservedNano,'600000');
  f.allowRelease=true;f.due();
  assert.equal((await f.call('tick',{},secret)).code,200);
  assert.equal(f.released.orderId,pending.id);
  assert.equal((await f.call('orders/'+pending.id)).value.status,'expired');
  assert.equal((await f.call('status')).value.reservedNano,'0');
});

test('a verified payment with a temporary reserve shortage remains visible and settles on a later tick',async t=>{
  const f=fixture(t),o=(await f.call('quote',f.quote('2','3'))).value;
  f.scan='paid';f.failSettle='Insufficient balance';
  const pending=(await f.call('orders/'+o.id)).value;
  assert.equal(pending.status,'paid');assert.equal(pending.txHash,txHash);assert.match(pending.reviewReason,/replenish/);
  f.failSettle=false;f.due();assert.equal((await f.call('tick',{},secret)).code,200);
  const paid=(await f.call('orders/'+o.id)).value;
  assert.equal(paid.status,'delivered');assert.equal(paid.reviewReason,null);assert.equal(f.deliveries,1);
});
