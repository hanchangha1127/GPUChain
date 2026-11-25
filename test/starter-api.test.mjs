import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createStarterRoute } from '../hosting/sites/starter.mjs';
import { GRANT_HEAD_BYTES, commitHostedTransaction } from '../hosting/sites/sale-holds.mjs';
import { generateWallet, hash, verify } from '../src/crypto.mjs';
import { DISTRIBUTION_RESERVE as reserve } from '../src/ledger.mjs';
import { STARTER_GRANT_AMOUNT as amount } from '../src/starter-grants.mjs';
import worker from '../hosting/sites/worker.mjs';

function fixture(t) {
  const sql=new DatabaseSync(':memory:');
  t.after(()=>sql.close());
  for (const file of ['0000_ledger_head','0001_sales','0002_sale_scan_liveness','0003_sale_quorum_escrow']) {
    sql.exec(readFileSync(new URL('../hosting/sites/drizzle/'+file+'.sql',import.meta.url),'utf8'));
  }
  const db={withSession(type){assert.equal(type,'first-primary');return db;},prepare(query){
    const stmt=sql.prepare(query);
    let args=[];
    return {bind(...params){args=params;return this;},first(){return stmt.get(...args);},
      run(){return {meta:{changes:stmt.run(...args).changes}};}};
  }};
  const signer=generateWallet(),a='a'.repeat(64),b='b'.repeat(64),unknown='c'.repeat(64);
  const state={chainId:reserve.chainId,networkStage:'mainnet',reserveClaim:reserve.claim,
    sequencer:signer.address,height:15,tip:hash('initial state'),balances:{[reserve.address]:amount*4,[a]:0},
    nonces:{[b]:1},providers:[],starterMandate:{version:1,active:true,cap:2*amount,spent:0},
    saleMandate:{active:true,cap:amount*4,spent:0,authority:'e'.repeat(64)}};
  const store=head=>sql.prepare('INSERT OR REPLACE INTO ledger_head(id,tip,checkpoint) VALUES(1,?,?)')
    .run(head.state.tip,JSON.stringify(head));
  store({state});
  const read=async()=>({head:JSON.parse(sql.prepare('SELECT checkpoint FROM ledger_head WHERE id=1').get().checkpoint)});
  let lostReply=false;
  const commit=async(live,db,tx)=>{
    const p=tx.payload,prior=live.head.state;
    assert.equal(p.type,'starter-grant');
    assert.equal(p.amount,amount);
    assert.equal(p.from,signer.address);
    assert.equal(p.nonce,(prior.nonces[signer.address]??0)+1);
    assert.ok(verify(signer.address,p,tx.signature));
    const next={...prior,tip:hash(tx),height:prior.height+1,nonces:{...prior.nonces,[signer.address]:p.nonce},
      starterMandate:{...prior.starterMandate,spent:prior.starterMandate.spent+amount},
      starterClaims:{...prior.starterClaims,[p.to]:prior.height+1},
      balances:{...prior.balances,[p.to]:(prior.balances[p.to]??0)+amount,[reserve.address]:prior.balances[reserve.address]-amount}};
    await commitHostedTransaction(db,prior,next,JSON.stringify({state:next}),p.type);
    if (lostReply) throw Error('Worker acknowledgement lost');
    return {head:{state:next}};
  };
  const env={DB:db,GPUCHAIN_SIGNER_PKCS8:signer.privateKey};
  const handle=createStarterRoute({read,commit});
  const get=address=>handle(new Request('https://store.invalid/v1/starter/status'+(address?'?address='+address:'')),env);
  const claim=(address,init={})=>handle(new Request('https://store.invalid/v1/starter/claim',{method:'POST',...init}),
    env,async()=>({address}));
  return {read,store,get,claim,sql,a,b,unknown,state,dropReply:()=>{lostReply=true;}};
}

test('starter status checks ledger existence including zero balances and historical nonces without signing',async t=>{
  const f=fixture(t);
  const status=await (await f.get()).json();
  assert.equal(status.remainingClaims,2);
  assert.equal(status.active,true);
  assert.equal((await (await f.get(f.a.toUpperCase())).json()).canClaim,true);
  assert.equal((await (await f.get(f.b)).json()).eligible,true);
  const unknown=await (await f.get(f.unknown)).json();
  assert.equal(unknown.reason,'wallet_not_recorded');
  assert.equal(unknown.canClaim,false);
  assert.equal((await f.get('not-an-address')).status,400);
  assert.equal((await f.claim(f.unknown)).status,404);
  assert.equal((await f.claim(reserve.address)).status,422);
  assert.equal((await f.claim(f.a,{headers:{Origin:'https://elsewhere.invalid'}})).status,403);
  assert.equal((await f.read()).head.state.height,15);
});

test('concurrent starter claims and a lost response settle once per existing wallet',async t=>{
  const f=fixture(t);
  const responses=await Promise.all([f.claim(f.a),f.claim(f.a)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  for(const r of responses) assert.equal((await r.json()).height,16);
  f.dropReply();
  const lost=await f.claim(f.b);
  assert.equal(lost.status,200);
  assert.equal((await lost.json()).height,17);
  const state=(await f.read()).head.state;
  assert.equal(state.balances[reserve.address],2*amount);
  assert.equal(state.balances[f.a],amount);
  assert.equal(state.balances[f.b],amount);
  const existing=await (await f.get(f.a)).json();
  assert.equal(existing.claimed,true);
  assert.equal(existing.remainingClaims,0);
  assert.equal((await f.claim(f.a)).status,200);
});

test('starter grant pauses for hosted checkpoint headroom and cannot use USDT reservations',async t=>{
  const f=fixture(t);
  f.store({state:f.state,padding:'x'.repeat(GRANT_HEAD_BYTES)});
  assert.equal((await f.claim(f.a)).status,507);
  f.store({state:f.state});
  f.sql.prepare(`INSERT INTO sale_orders(id,chain_id,payer,recipient,amount_micro,intent,client_key,created_ms,expires_ms,
    start_block,cursor_block,scan_after,state) VALUES('held',1,'payer','to',35000000,'{}','k',1,2,'1','1',0,'reserved')`).run();
  assert.equal((await (await f.get(f.a)).json()).reason,'reserve_unavailable');
  assert.equal((await f.claim(f.a)).status,409);
  assert.equal((await f.read()).head.state.balances[reserve.address],4*amount);
});

test('starter grants require a writable upgraded majority after handoff',async t=>{
  const f=fixture(t);
  f.store({state:f.state,authority:{payload:{validators:[]}}});
  assert.equal((await (await f.get(f.a)).json()).reason,'unavailable');
  assert.equal((await f.claim(f.a)).status,503);
  assert.equal((await f.read()).head.state.height,15);
});

test('worker refuses malformed, extra-field and oversized starter requests before ledger access',async()=>{
  const url='https://store.invalid/v1/starter/claim';
  const send=(raw,type='application/json')=>worker.fetch(new Request(url,{method:'POST',
    headers:{'content-type':type},body:raw}),{});
  assert.equal((await send('{}','text/plain')).status,415);
  assert.equal((await send('!')).status,400);
  assert.equal((await send(JSON.stringify({address:'a'.repeat(64),amount:101}))).status,400);
  assert.equal((await send(' '.repeat(513))).status,413);
  assert.equal((await worker.fetch(new Request(url),{})).status,405);
});
