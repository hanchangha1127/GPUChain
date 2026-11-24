import { hash } from '../../src/crypto.mjs';
import { DISTRIBUTION_RESERVE } from '../../src/ledger.mjs';
import { SALE_NANO_PER_MICRO, SALE_COINS_PER_USDT } from '../../src/sale-policy.mjs';
import * as usdt from './usdt.mjs';
import * as settlement from './sale-settlement.mjs';
import { heldMicroSql, holdArgs, intakeFence, isDraining, openOrders as DUE } from './sale-holds.mjs';

const MAX_ORDER_MICRO = 1_000_000n*1_000_000_000n/SALE_NANO_PER_MICRO; // One million coins per signed quote.
const TTL = 30 * 60_000;
const HOUR = 60 * 60_000;
const MAX_OPEN = 256;
const LEASE = 25_000;
const SCANNER_TTL = 45 * 60_000;
const paymentShortfall = 'Payment confirmed; merchant must replenish the reserve or restore its sale authorization';
const orderFields = `id,chain_id,payer,recipient,CAST(amount_micro AS TEXT) AS micro,intent,created_ms,expires_ms,
  start_block,cursor_block,scan_after,state,quorum_hold,payment,tx_hash,event_id,review,late_hash,delivery_sequence,ledger_height,ledger_tip`;

function demand(ok,status,message) {
  if (!ok) throw Object.assign(Error(message),{status});
}
function response(value,status=200) {
  return Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
function equalSecretHeader(actual,expected) {
  if (actual.length>1024) return false;
  const a=hash(actual),b=hash(expected);
  let difference=0;
  for (let i=0;i<a.length;i++) difference|=a.charCodeAt(i)^b.charCodeAt(i);
  return difference===0;
}
async function input(request) {
  demand(request.headers.get('content-type')?.split(';')[0].toLowerCase().trim()==='application/json',415,'Expected JSON');
  demand(request.body,400,'Missing request body');
  const reader=request.body.getReader(),bytes=new Uint8Array(8192);
  let n=0;
  try {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      if (n+part.value.length>bytes.length) {await reader.cancel();demand(false,413,'Request is too large');}
      bytes.set(part.value,n); n+=part.value.length;
    }
  } finally { reader.releaseLock(); }
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n)));}
  catch {throw Object.assign(Error('Invalid JSON'),{status:400});}
}
function networkOptions(env,chain) {
  const prefix = chain===1?'USDT_ETH':chain===56?'USDT_BSC':null;
  if (!prefix) return null;
  try {
    const rpcUrls=JSON.parse(env[prefix+'_RPC_URLS']);
    const minBlock=env[prefix+'_START_BLOCK'];
    if (!Array.isArray(rpcUrls) || rpcUrls.length!==2 || !/^[1-9][0-9]{0,18}$/.test(minBlock ?? '')) return null;
    return {rpcUrls,minBlock};
  } catch {return null;}
}
const getOrder=(db,id)=>db.prepare('SELECT '+orderFields+' FROM sale_orders WHERE id=?').bind(id).first();
async function scannerStatus(env,db,now) {
  const row=await db.prepare('SELECT last_tick_ms FROM sale_scan_state WHERE id=1').first();
  const lastTickAt=row?.last_tick_ms ?? null;
  return {lastTickAt,online:typeof env.USDT_SWEEP_TOKEN==='string' && env.USDT_SWEEP_TOKEN.length>=32 &&
    Number.isSafeInteger(lastTickAt) && lastTickAt<=now && lastTickAt>now-SCANNER_TTL};
}
function publicOrder(row) {
  const net=usdt.NETWORKS[row.chain_id];
  return {id:row.id,orderId:row.id,status:row.review && !['paid','delivered'].includes(row.state)?'review':row.state,
    chainId:row.chain_id,payer:row.payer,gpuAddress:row.recipient,amountMicro:row.micro,
    amountNano:(BigInt(row.micro)*SALE_NANO_PER_MICRO).toString(),coinsPerUsdt:SALE_COINS_PER_USDT,
    payTo:row.state==='holding'?null:usdt.MERCHANT,token:row.state==='holding'?null:net.token,
    usdtUnits:row.state==='holding'?null:(BigInt(row.micro)*10n**BigInt(net.decimals-6)).toString(),
    createdAt:row.created_ms,expiresAt:row.expires_ms,startBlock:row.start_block,txHash:row.tx_hash,
    ledgerTip:row.ledger_tip,ledgerHeight:row.ledger_height,reviewReason:row.review,latePaymentHash:row.late_hash};
}
function evidence(row) {
  return {...JSON.parse(row.intent),orderId:row.id,startBlock:row.start_block,createdAt:row.created_ms,expiresAt:row.expires_ms};
}
async function stock(env,db,inventory) {
  const info=await inventory(env,db);
  const balance=BigInt(info.inventoryNano), remaining=BigInt(info.mandateRemainingNano);
  const micro=info.enabled?(balance<remaining?balance:remaining)/SALE_NANO_PER_MICRO:0n;
  const args=holdArgs(info.saleSequence,info.ledgerSalePaymentId);
  const {used,reserved,paid}=await db.prepare(`SELECT CAST(${heldMicroSql} AS TEXT) AS used,
    (SELECT COUNT(*) FROM sale_orders WHERE state IN ('holding','reserved','releasing')) AS reserved,
    (SELECT COUNT(*) FROM sale_orders WHERE state='paid') AS paid`).bind(...args).first();
  const held=BigInt(used),free=micro-held;
  const draining=!!info.bootstrapTip && await isDraining(db);
  const quorum=!!info.quorumEscrowSupported && typeof info.quorumFence==='string' && info.quorumFence.startsWith('retired:');
  const chainFree=quorum ? BigInt(info.freeOnChainNano ?? 0)/SALE_NANO_PER_MICRO : micro;
  return {enabled:info.enabled,networkStage:info.networkStage==='mainnet'?'mainnet':'testnet',
    admitting:(!!info.bootstrapTip && !draining) || quorum,draining,micro,held,reserved,paid,quorum,
    free:free<=0n?0n:(free<chainFree?free:chainFree),holdArgs:args,tipFence:info.bootstrapTip || info.quorumFence};
}
const escrowOrder=row=>({orderId:row.id,to:row.recipient,evmChainId:row.chain_id,
  amountNano:(BigInt(row.micro)*SALE_NANO_PER_MICRO).toString()});

// All release decisions need a complete, independently agreed finalized scan.
// Worker clocks alone cannot determine that an expired quote went unpaid.
async function retainPayment(db,row,payment) {
  demand(payment.chainId===row.chain_id && payment.payer===row.payer && payment.to===row.recipient &&
    payment.amountMicro===row.micro && payment.merchant===usdt.MERCHANT &&
    BigInt(payment.blockNumber)>=BigInt(row.start_block),409,'Finalized transfer differs from this order');
  const timestamp=BigInt(payment.blockTimestamp);
  demand(timestamp>=BigInt(Math.floor(row.created_ms/1000)),409,'Transfer predates the order');
  if (timestamp>BigInt(Math.floor(row.expires_ms/1000))) {
    // Keep the in-window scan eligible. This late transfer could belong to a later quote.
    await db.prepare(`UPDATE sale_orders SET review=?,late_hash=? WHERE id=? AND state IN ('reserved','expired')
      AND late_hash IS NULL`).bind('Payment after quote expiry; contact the merchant with the order ID and transaction hash',
        payment.txHash,row.id).run();
    return;
  }
  const exists=await db.prepare('SELECT id FROM sale_orders WHERE chain_id=? AND tx_hash=?')
    .bind(row.chain_id,payment.txHash).first();
  demand(!exists || exists.id===row.id,409,'Transfer already belongs to another order');
  const set=await db.prepare(`UPDATE OR IGNORE sale_orders SET state='paid',payment=?,tx_hash=?,event_id=?,
    scan_after=0,review=NULL WHERE id=? AND state='reserved'`)
    .bind(JSON.stringify(payment),payment.txHash,payment.eventId,row.id).run();
  if (!set.meta.changes) {
    const current=await getOrder(db,row.id);
    if (current.state==='expired') {
      await db.prepare("UPDATE sale_orders SET review=?,late_hash=? WHERE id=? AND state='expired'")
        .bind('Finalized payment reported after a previous negative scan; merchant reconciliation required',payment.txHash,row.id).run();
    } else demand(current.event_id===payment.eventId,409,'Transfer or order already assigned');
  }
}
async function deliver(env,db,row,settle) {
  const pay=JSON.parse(row.payment);
  let result;
  try {
    result=await settle(env,db,{...escrowOrder(row),paymentId:row.event_id,usdtMicros:row.micro,
      txHash:row.tx_hash,logIndex:pay.logIndex,payTo:pay.merchant,token:usdt.NETWORKS[row.chain_id].token});
  } catch(err) {
    if (/insufficient balance|allowance exceeded|mandate unavailable|sold out/i.test(err.message)) {
      await db.prepare("UPDATE sale_orders SET review=? WHERE id=? AND state='paid' AND review IS NULL")
        .bind(paymentShortfall,row.id).run();
    }
    throw err;
  }
  demand(Number.isSafeInteger(result?.sequence) && result.sequence>0 && Number.isSafeInteger(result.height) &&
    result.height>0 && /^[a-f0-9]{64}$/.test(result.tip),503,'Delivery confirmation pending');
  await db.prepare(`UPDATE sale_orders SET state='delivered',delivery_sequence=?,ledger_height=?,ledger_tip=?,
    review=CASE WHEN review=? THEN NULL ELSE review END WHERE id=? AND state='paid' AND event_id=?`)
    .bind(result.sequence,result.height,result.tip,paymentShortfall,row.id,row.event_id).run();
}

export function createSalesRoute({verifyQuote=usdt.verifyQuoteSignature,health=usdt.checkRpcHealth,
  checkPayment=usdt.checkPayment,findPayment=usdt.findQuotePayment,inventory=settlement.readSaleInventory,
  settle=settlement.settleOrder,acquireHold=settlement.ensureSaleHold,releaseHold=settlement.releaseSaleHold}={}) {
  // Only readiness metadata is cached. A quote always performs fresh network checks.
  const checks=new Map();
  async function ready(chain,options,now,force=false) {
    if (!options) return null;
    const previous=checks.get(chain);
    if (!force && previous && previous.until>now) return previous.block;
    // Cross-request caches contain completed data only. Worker I/O promises
    // belong to the request that created them.
    let block=null;
    try {
      block=await health(chain,options);
      const ts=BigInt(block.blockTimestamp)*1000n;
      if (BigInt(options.minBlock)>BigInt(block.blockNumber)+1n ||
        ts>BigInt(now+60_000) || ts<BigInt(now-45*60_000)) block=null;
    } catch { block=null; }
    checks.set(chain,{until:now+8000,block});
    return block;
  }
  async function processRow(env,db,row,now,txHash) {
    if (!row || (row.state==='delivered' && (!txHash || row.tx_hash===txHash)) || (row.state==='expired' && !txHash)) return;
    const lease=await db.prepare(`UPDATE sale_orders SET scan_after=? WHERE id=? AND scan_after<=? AND state=?`)
      .bind(now+LEASE,row.id,now,row.state).run();
    if (!lease.meta.changes) return;
    if (row.state==='holding') {
      const confirmed=await acquireHold(env,db,escrowOrder(row));
      demand(confirmed?.held===true,503,'Certified inventory hold pending');
      await db.prepare("UPDATE sale_orders SET state='reserved',scan_after=0 WHERE id=? AND state='holding' AND quorum_hold=1")
        .bind(row.id).run();
      return;
    }
    if (row.state==='releasing') {
      const confirmed=await releaseHold(env,db,escrowOrder(row));
      demand(confirmed?.held===false,503,'Certified release pending');
      await db.prepare("UPDATE sale_orders SET state='expired',scan_after=0 WHERE id=? AND state='releasing' AND quorum_hold=1")
        .bind(row.id).run();
      return;
    }
    if (row.state!=='paid') {
      const options=networkOptions(env,row.chain_id);
      demand(options,503,'Payment verification unavailable');
      const order=evidence(row);
      if (txHash) {
        const paid=await checkPayment({...order,txHash},{...options,minBlock:row.start_block});
        if (row.state==='delivered') {
          const other=await db.prepare('SELECT id FROM sale_orders WHERE chain_id=? AND tx_hash=?').bind(row.chain_id,txHash).first();
          if (!other) await db.prepare(`UPDATE sale_orders SET review=?,late_hash=? WHERE id=? AND late_hash IS NULL`)
            .bind('Additional transfer reported for a delivered order; merchant reconciliation required',txHash,row.id).run();
          return;
        }
        await retainPayment(db,row,paid);
      } else {
        const scan=await findPayment(order,{...options,minBlock:row.start_block,fromBlock:row.cursor_block});
        if (scan.matches.length) {
          await retainPayment(db,row,scan.matches[0]);
          if (scan.matches.length>1) await db.prepare(`UPDATE sale_orders SET review=?,late_hash=?
            WHERE id=? AND late_hash IS NULL`).bind('Multiple transfers for one order; merchant reconciliation required',
              scan.matches[1].txHash,row.id).run();
        }
        else if (scan.complete && BigInt(scan.finalizedThroughTimestamp)>BigInt(Math.floor(row.expires_ms/1000))) {
          await db.prepare("UPDATE sale_orders SET state=?,scan_after=0 WHERE id=? AND state='reserved' AND cursor_block=?")
            .bind(row.quorum_hold?'releasing':'expired',row.id,row.cursor_block).run();
        } else {
          demand(BigInt(scan.nextBlock)>=BigInt(row.cursor_block),503,'Invalid finalized scan cursor');
          await db.prepare("UPDATE sale_orders SET cursor_block=?,scan_after=? WHERE id=? AND state='reserved' AND cursor_block=?")
            .bind(scan.nextBlock,scan.hasMoreFinalized?now:now+LEASE,row.id,row.cursor_block).run();
        }
      }
      row=await getOrder(db,row.id);
    }
    if (row.state==='paid') await deliver(env,db,row,settle);
  }
  async function route(request,env,path) {
    const headers=request.headers;
    const origin=headers.get('origin');
    demand(!origin || origin===new URL(request.url).origin,403,'Unexpected origin');
    const db=env.DB.withSession('first-primary');
    const {now}=await db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS now").first();
    if (request.method === 'POST' && path === '/v1/sales/diagnostics') {
      const secret = env.USDT_SWEEP_TOKEN;
      demand(typeof secret === 'string' && secret.length >= 32 &&
        equalSecretHeader(headers.get('authorization') || '', 'Bearer '+secret),403,'Unauthorized diagnostics');
      const chains = {};
      for (const id of [1,56]) {
        const options = networkOptions(env,id);
        if (!options) {chains[id]={configured:false};continue;}
        const endpoints = [];
        for (const url of options.rpcUrls) {
          const facts = {};
          for (const [method,params] of [
            ['eth_chainId',[]], ['eth_getBlockByNumber',['finalized',false]],
            ['eth_call',[{to:usdt.NETWORKS[id].token,data:'0x313ce567'},'latest']],
          ]) {
            try {
              const r=await fetch(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
                headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
              const item={http:r.status};
              if (r.ok) {
                const j=await r.json();
                if (j.error) item.rpcCode=j.error.code;
                else if (method==='eth_getBlockByNumber') {
                  item.height=j.result?.number;item.time=j.result?.timestamp;
                } else item.value=String(j.result).slice(0,70);
              } else await r.body?.cancel();
              facts[method]=item;
            } catch (err) {facts[method]={failure:err.name};}
          }
          endpoints.push(facts);
        }
        let agreement;
        try {agreement=await health(id,options);}
        catch (err) {agreement={failure:err.message};}
        chains[id]={configured:true,endpoints,agreement};
      }
      return response({now,chains});
    }
    if (request.method==='GET' && path==='/v1/sales/status') {
      const [supply,scanner]=await Promise.all([stock(env,db,inventory),scannerStatus(env,db,now)]);
      const networks={};
      await Promise.all([1,56].map(async id=>{
        const configured=networkOptions(env,id);
        const paymentReady=supply.enabled && !!await ready(id,configured,now);
        const reason=supply.networkStage!=='mainnet'?'mainnet-pending':!supply.enabled?'reserve-offline':
          !supply.admitting?'ledger-transition':!configured?'rpc-unconfigured':!paymentReady?'rpc-unhealthy':
          !scanner.online?'scanner-offline':supply.free<=0n?'inventory-reserved':null;
        networks[id]={accepting:reason===null,paymentReady,reason};
      }));
      return response({accepting:Object.values(networks).some(v=>v.accepting),inventoryNano:(supply.free*SALE_NANO_PER_MICRO).toString(),
        saleCapacityNano:(supply.micro*SALE_NANO_PER_MICRO).toString(),reservedNano:(supply.held*SALE_NANO_PER_MICRO).toString(),
        openOrders:supply.reserved,paidPending:supply.paid,
        intakeMode:supply.draining?'draining':supply.quorum?'validator':supply.tipFence && !supply.tipFence.startsWith('retired:')?'bootstrap':'retired',
        networks,scanner,networkStage:supply.networkStage,priceUsdt:'0.1',coinsPerUsdt:SALE_COINS_PER_USDT,maxOrderMicro:MAX_ORDER_MICRO.toString(),merchant:usdt.MERCHANT});
    }
    if (request.method==='POST' && path==='/v1/sales/quote') {
      const q=await input(request);
      await verifyQuote(q);
      demand(q && /^[1-9][0-9]{0,18}$/.test(q.amountMicro) && BigInt(q.amountMicro)<=MAX_ORDER_MICRO,400,'Amount exceeds order limit');
      demand(q.gpuAddress!==DISTRIBUTION_RESERVE.address,400,'Choose a buyer wallet for delivery');
      const intent={chainId:q.chainId,payer:q.payer,gpuAddress:q.gpuAddress,amountMicro:q.amountMicro,
        requestId:q.requestId,issuedAt:q.issuedAt,signature:q.signature};
      const id=hash({domain:'gpuchain/usdt-order/v1',payer:q.payer,chainId:q.chainId,requestId:q.requestId});
      const saved=await getOrder(db,id);
      if (saved) {
        const old=JSON.parse(saved.intent);
        demand(old.gpuAddress===q.gpuAddress && old.amountMicro===q.amountMicro && old.issuedAt===q.issuedAt,409,'Request ID already used');
        return response(publicOrder(saved));
      }
      demand(Number.isSafeInteger(q.issuedAt) && q.issuedAt>=now-120000 && q.issuedAt<=now+10000,400,'Quote signature expired');
      demand((await scannerStatus(env,db,now)).online,503,'Automatic payment monitor unavailable');
      const options=networkOptions(env,q.chainId),supply=await stock(env,db,inventory);
      demand(supply.networkStage==='mainnet' && supply.enabled && supply.admitting && options,503,'Sales temporarily unavailable');
      demand(supply.free>=BigInt(q.amountMicro),409,'Insufficient available inventory');
      const block=await ready(q.chainId,options,now,true);
      demand(block,503,'Independent payment networks unavailable');
      const nextBlock=BigInt(block.blockNumber)+1n, floor=BigInt(options.minBlock);
      const start=(nextBlock>floor?nextBlock:floor).toString();
      const expires=Math.min(now,q.issuedAt)+TTL;
      const ip=headers.get('cf-connecting-ip') || q.payer;
      const clientKey=hash({day:Math.floor(now/86400000),ip});
      // SQLite sums exact integer microUSDT. Numeric parameters travel as decimal
      // strings so D1's JS binding cannot round a reserve above MAX_SAFE_INTEGER.
      const inserted=await db.prepare(`INSERT OR IGNORE INTO sale_orders
        (id,chain_id,payer,recipient,amount_micro,intent,client_key,created_ms,expires_ms,start_block,cursor_block,scan_after,state,quorum_hold)
        SELECT ?,?,?,?,CAST(? AS INTEGER),?,?,?,?,?,?,0,?,?
        WHERE ${intakeFence} AND CAST(? AS INTEGER)-${heldMicroSql}>=CAST(? AS INTEGER)
          AND (SELECT count(*) FROM sale_orders WHERE ${DUE})<?
          AND NOT EXISTS(SELECT 1 FROM sale_orders WHERE chain_id=? AND payer=? AND ${DUE})
          AND (SELECT count(*) FROM sale_orders WHERE chain_id=? AND payer=? AND created_ms>?)<6
          AND (SELECT count(*) FROM sale_orders WHERE client_key=? AND created_ms>?)<24`)
        .bind(id,q.chainId,q.payer,q.gpuAddress,q.amountMicro,JSON.stringify(intent),clientKey,now,expires,start,start,
          supply.quorum?'holding':'reserved',supply.quorum?1:0,supply.tipFence,supply.quorum?1:0,
          supply.micro.toString(),...supply.holdArgs,q.amountMicro,MAX_OPEN,q.chainId,q.payer,q.chainId,q.payer,now-HOUR,
          clientKey,now-HOUR).run();
      const out=await getOrder(db,id);
      demand(out,409,'Reservation unavailable: existing open order, rate limit or insufficient inventory');
      demand(out.recipient===q.gpuAddress && out.micro===q.amountMicro && JSON.parse(out.intent).issuedAt===q.issuedAt,409,'Request ID already used');
      if (out.state==='holding') {
        try {await processRow(env,db,out,now);} catch { /* Paid checkout waits for certified collateral. */ }
        return response(publicOrder(await getOrder(db,id)),inserted.meta.changes?201:200);
      }
      return response(publicOrder(out),inserted.meta.changes?201:200);
    }
    const lookup=path.match(/^\/v1\/sales\/orders\/([0-9a-f]{64})$/);
    if ((request.method==='GET' && lookup) || (request.method==='POST' && path==='/v1/sales/claim')) {
      const hint=lookup?null:await input(request);
      demand(lookup || (/^[0-9a-f]{64}$/.test(hint?.orderId) && /^0x[0-9a-f]{64}$/.test(hint?.txHash)),400,'Invalid payment reference');
      const id=lookup?lookup[1]:hint.orderId;
      const row=await getOrder(db,id); demand(row,404,'Order not found');
      let pending=false;
      try {await processRow(env,db,row,now,hint?.txHash);}
      catch (err) {
        if (hint && (err.status===400 || err.status===409)) throw err;
        pending=true;
      }
      return response({...publicOrder(await getOrder(db,id)),verificationPending:pending});
    }
    if (request.method==='POST' && path==='/v1/sales/tick') {
      const secret=env.USDT_SWEEP_TOKEN;
      const auth=headers.get('authorization') || '';
      demand(typeof secret==='string' && secret.length>=32 &&
        equalSecretHeader(auth,'Bearer '+secret),403,'Unauthorized scanner');
      const due=await db.prepare(`SELECT ${orderFields} FROM sale_orders WHERE ${DUE} AND scan_after<=?
        ORDER BY scan_after,id LIMIT 1`).bind(now).first();
      if (due) await processRow(env,db,due,now);
      await db.prepare(`INSERT INTO sale_scan_state(id,last_tick_ms) VALUES(1,?)
        ON CONFLICT(id) DO UPDATE SET last_tick_ms=max(last_tick_ms,excluded.last_tick_ms)`).bind(now).run();
      const another=await db.prepare(`SELECT 1 AS due FROM sale_orders WHERE ${DUE} AND scan_after<=? LIMIT 1`).bind(now).first();
      return response({processed:due?1:0,more:!!another});
    }
    return response({error:'Sale route not found'},404);
  }
  return async (request,env,path=new URL(request.url).pathname)=>{
    try {return await route(request,env,path);}
    catch (err) {
      const code=[400,403,404,409,413,415,422,429,503].includes(err.status)?err.status:503;
      return response({error:code===503?'Sale verification or settlement temporarily unavailable':err.message},code);
    }
  };
}

export const salesRoute=createSalesRoute();
