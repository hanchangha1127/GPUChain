import { decodeAmount, encodeAmount } from '../../src/amount.mjs';
import { authenticate, nextCheckpoint, verifyAdvance } from '../../src/checkpoint.mjs';
import { verifyConsensusAck } from '../../src/consensus.mjs';
import { addressFromPrivateKey, hash, sign, verify } from '../../src/crypto.mjs';
import { checkReadiness, limitedJson } from '../../src/enrollment.mjs';
import { DISTRIBUTION_RESERVE, heldSaleAmount, saleDeliveryEffect, saleHoldCommitment, saleHoldEffect } from '../../src/ledger.mjs';
import { SALE_PRICE_TERMS, SALE_TERMS, saleNanoPerMicro } from '../../src/sale-policy.mjs';
import { HOSTED_HEAD_BYTES as MAX_HEAD } from './sale-holds.mjs';

const reserve = DISTRIBUTION_RESERVE;
const need = (ok,status,message) => { if (!ok) throw Object.assign(Error(message),{status}); };

function signer(env) {
  const privateKey=env.GPUCHAIN_SALES_SIGNER_PKCS8;
  need(typeof privateKey==='string' && privateKey.length>0,503,'Sale signing is unavailable');
  return {address:addressFromPrivateKey(privateKey),privateKey};
}

async function remote(url,path,body) {
  const result=await fetch(url+path,{
    method:body===undefined?'GET':'POST',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(12_000),
    headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)
  });
  return limitedJson(result,MAX_HEAD+64*1024);
}

/** Read the authoritative signed head, including after the Sites bootstrap retires. */
export async function readHostedLedger(db,{starterGrants=false}={}) {
  const row=await db.prepare('SELECT tip,checkpoint FROM ledger_head WHERE id=1').first();
  need(row,503,'Bootstrap checkpoint unavailable');
  const initial=authenticate(JSON.parse(row.checkpoint),reserve.chainId);
  if (!initial.authority) {
    need(row.tip===initial.state.tip,503,'Bootstrap tip mismatch');
    return {head:initial};
  }
  need(row.tip==='retired:'+hash(initial.authority),503,'Invalid retired checkpoint');
  const results=await Promise.allSettled(initial.authority.payload.validators.map(async member=>{
    const s=await remote(member.url,'/v1/status');
    need(s.mode==='validator' && s.chainId===reserve.chainId && s.instanceId===member.instanceId &&
      s.address===member.address,503,'Validator identity mismatch');
    const head=authenticate(await remote(member.url,'/v1/checkpoint'),reserve.chainId);
    verifyAdvance(initial,head);
    let capable=true;
    try {await checkReadiness({chainId:reserve.chainId,address:member.address,origin:member.url,instanceId:member.instanceId},
      fetch,true,starterGrants,starterGrants,Boolean(head.state.salePrice));}
    catch {capable=false;}
    return {head,url:member.url,capable};
  }));
  const peers=results.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>a.head.state.height-b.head.state.height);
  need(peers.length>=2,503,'No available validator majority for sales');
  for (let i=1;i<peers.length;i++) verifyAdvance(peers[i-1].head,peers[i].head);
  const newest=peers.at(-1), capable=peers.filter(p=>p.capable);
  const writer=capable.find(p=>p.head.state.tip===newest.head.state.tip);
  return {...(writer ?? newest),quorumEscrowSupported:capable.length>=2 && Boolean(writer)};
}

function capacity(state,owner) {
  const m=state.saleMandate;
  const available=decodeAmount(state.balances[reserve.address] ?? 0);
  const permitted=state.chainId===reserve.chainId && state.reserveClaim===reserve.claim &&
    m?.active===true && m.terms===SALE_PRICE_TERMS &&
    state.salePrice?.payload?.terms===SALE_PRICE_TERMS && owner.address===m.authority;
  const left=permitted ? decodeAmount(m.cap)-decodeAmount(m.spent) : 0n;
  const inventory=available<left ? available : left;
  need(inventory>=0n,503,'Invalid sale allowance');
  const held=heldSaleAmount(state), free=inventory>held ? inventory-held : 0n;
  return {inventoryNano:inventory.toString(),heldOnChainNano:held.toString(),freeOnChainNano:free.toString(),enabled:permitted && inventory>0n,
    mandateRemainingNano:left.toString(),saleSequence:state.lastSale?.sequence ?? 0,ledgerHeight:state.height};
}

function fingerprint(order) {
  const {orderId,paymentId,to,evmChainId,txHash,logIndex,usdtMicros,amountNano,token,payTo}=order;
  return hash({orderId,paymentId,to,evmChainId,txHash,logIndex,usdtMicros,amountNano,token,payTo,
    ...wireTerms(order)});
}

// The original signature, order fingerprint and ledger transaction omitted
// terms. Include the marker only for a new explicitly priced order.
function wireTerms(order) {
  if (!Object.hasOwn(order,'terms')) return {};
  need(order.terms===SALE_PRICE_TERMS,409,'Unsupported order price terms');
  return {terms:order.terms};
}

function proposedTx(order,state,owner,quorum) {
  need(typeof order.amountNano==='string' && /^[1-9][0-9]{0,21}$/.test(order.amountNano),409,'Invalid order amount');
  const {orderId,paymentId,to,evmChainId,txHash,logIndex,usdtMicros,token,payTo}=order;
  const payload={type:'deliver-sale',chainId:reserve.chainId,from:owner.address,to,orderId,paymentId,evmChainId,
    txHash,logIndex,usdtMicros,token,payTo,amount:encodeAmount(BigInt(order.amountNano)),
    nonce:(state.nonces[owner.address] ?? 0)+1,sequence:(state.lastSale?.sequence ?? 0)+1,
    mandateVersion:state.saleMandate.version,...wireTerms(order)};
  saleDeliveryEffect(state,payload,quorum);
  return {payload,signature:sign(owner.privateKey,payload)};
}

function asOrder(payload) {
  const {orderId,paymentId,to,evmChainId,txHash,logIndex,usdtMicros,token,payTo}=payload;
  return {orderId,paymentId,to,evmChainId,txHash,logIndex,usdtMicros,token,payTo,amountNano:String(payload.amount),
    ...wireTerms(payload)};
}

function journal(db) {
  const query='SELECT sequence,payment_id,order_id,intent,confirmation FROM sale_delivery';
  return {
    completed:()=>db.prepare(query+' WHERE confirmation IS NOT NULL ORDER BY sequence DESC LIMIT 1').first(),
    pending:()=>db.prepare(query+' WHERE confirmation IS NULL LIMIT 1').first(),
    lookup:o=>db.prepare(query+' WHERE order_id=? OR payment_id=? LIMIT 1').bind(o.orderId,o.paymentId).first(),
    async insert(tx) {
      const p=tx.payload;
      const result=await db.prepare('INSERT OR IGNORE INTO sale_delivery(sequence,payment_id,order_id,intent) VALUES(?,?,?,?)')
        .bind(p.sequence,p.paymentId,p.orderId,JSON.stringify(tx)).run();
      need(result.meta.changes===1,409,'Sale slot changed; retry');
    },
    async update(row,tx) {
      const encoded=JSON.stringify(tx);
      const result=await db.prepare('UPDATE sale_delivery SET intent=? WHERE sequence=? AND intent=? AND confirmation IS NULL')
        .bind(encoded,row.sequence,row.intent).run();
      need(result.meta.changes===1,409,'Sale intent changed; retry');
      return {...row,intent:encoded};
    },
    async confirm(row,receipt) {
      const result=await db.prepare('UPDATE sale_delivery SET intent=NULL,confirmation=? WHERE sequence=? AND payment_id=? AND confirmation IS NULL')
        .bind(JSON.stringify(receipt),row.sequence,row.payment_id).run();
      if (result.meta.changes===1) return receipt;
      const latest=await db.prepare(query+' WHERE sequence=?').bind(row.sequence).first();
      need(latest?.confirmation && latest.payment_id===row.payment_id,409,'Conflicting sale confirmation');
      return JSON.parse(latest.confirmation);
    }
  };
}

function checkWatermark(completed,state) {
  const latest=state.lastSale;
  need((completed?.sequence ?? 0)===(latest?.sequence ?? 0) &&
    (!completed || completed.payment_id===latest.paymentId),503,'Sale journal needs reconciliation');
}

function receiptFor(row,state) {
  const p=JSON.parse(row.intent).payload, marker=state.lastSale;
  if (!marker || marker.sequence!==row.sequence || marker.paymentId!==row.payment_id ||
      marker.recipient!==p.to || marker.amount!==p.amount) return null;
  return {sequence:row.sequence,tip:state.tip,height:state.height,orderFingerprint:fingerprint(asOrder(p))};
}

/** The order passed here must come from server-side EVM verification and a unique reserved order. */
export async function deliverVerifiedOrder(db,order,owner,{read,commit}) {
  const log=journal(db);
  async function advance(row) {
    let live=await read();
    const saved=JSON.parse(row.intent);
    need(saved?.payload?.type==='deliver-sale' && saved.payload.sequence===row.sequence &&
      saved.payload.orderId===row.order_id && saved.payload.paymentId===row.payment_id &&
      verify(saved.payload.from,saved.payload,saved.signature),503,'Invalid signed sale intent');
    let receipt=receiptFor(row,live.head.state);
    if (!receipt) {
      checkWatermark(await log.completed(),live.head.state);
      let tx=saved;
      if (tx.payload.from!==owner.address) {
        // The fresh independently verified order is required to re-sign an old
        // key's pending intent after an explicit authority rotation.
        need(fingerprint(asOrder(tx.payload))===fingerprint(order),409,'Verify the previously reserved order after key rotation');
      }
      const revised=proposedTx(asOrder(tx.payload),live.head.state,owner,Boolean(live.head.authority));
      if (hash(tx)!==hash(revised)) {
        // Another spend may have advanced the key nonce, or the reserve owner
        // may have rotated the mandate while an order was in flight.
        need(tx.payload.sequence===revised.payload.sequence,409,'Unexpected settlement sequence');
        row=await log.update(row,revised);
        tx=revised;
      }
      live=await commit(live,tx,row);
      receipt=receiptFor(row,live.head.state);
      need(receipt,503,'Ledger has not confirmed the sale');
    }
    return log.confirm(row,receipt);
  }
  const digest=fingerprint(order);
  let existing=await log.lookup(order);
  if (existing) {
    need(existing.order_id===order.orderId && existing.payment_id===order.paymentId,409,'Order or payment already assigned');
    const receipt=existing.confirmation ? JSON.parse(existing.confirmation) : null;
    need((receipt?.orderFingerprint ?? fingerprint(asOrder(JSON.parse(existing.intent).payload)))===digest,
      409,'Verified order details changed');
    if (receipt) return receipt;
    return advance(existing);
  }
  const pending=await log.pending();
  if (pending) await advance(pending); // Finish a paid order even after caller/Worker loss.
  const live=await read();
  checkWatermark(await log.completed(),live.head.state);
  const tx=proposedTx(order,live.head.state,owner,Boolean(live.head.authority));
  await log.insert(tx);
  existing=await log.lookup(order);
  need(existing?.intent,409,'Settlement was concurrently handled; retry');
  return advance(existing);
}

export async function readSaleInventory(env,db) {
  const {head,quorumEscrowSupported=false}=await readHostedLedger(db), state=head.state;
  const fence={bootstrapTip:head.authority?null:state.tip,ledgerSalePaymentId:state.lastSale?.paymentId ?? null,
    networkStage:state.networkStage === 'mainnet'?'mainnet':'testnet',priceTerms:state.salePrice?.payload?.terms};
  fence.quorumFence=head.authority?'retired:'+hash(head.authority):null;
  fence.quorumEscrowSupported=quorumEscrowSupported;
  if (!env.GPUCHAIN_SALES_SIGNER_PKCS8) {
    return {...fence,enabled:false,inventoryNano:'0',mandateRemainingNano:'0',
      saleSequence:state.lastSale?.sequence ?? 0,ledgerHeight:state.height};
  }
  const log=journal(db), pending=await log.pending();
  if (!pending || !receiptFor(pending,state)) checkWatermark(await log.completed(),state);
  return {...capacity(state,signer(env)),...fence};
}

export async function quorumCommit(live,tx) {
  need(live.url && live.quorumEscrowSupported,503,'No escrow-capable validator majority');
  const reply=await remote(live.url,'/v1/transactions',tx);
  verifyConsensusAck(reply,tx,live.head.genesis,live.head.authority);
  verifyAdvance(live.head,reply.checkpoint);
  return {head:reply.checkpoint,url:live.url,quorumEscrowSupported:true};
}

// Read the order phase *after* the certified head. If a concurrent scanner has
// released or consumed the hold, a stale signer either sees its terminal phase
// or its transaction has an already-spent nonce. A lost reply is recovered by
// re-reading the signed hold commitment, rather than unconditionally repeating it.
export async function updateVerifiedHold(db,order,owner,acquire,{read,commit}) {
  const live=await read(),state=live.head.state;
  const report=(s,held,commitment)=>({held,commitment,height:s.height,tip:s.tip});
  if (!live.head.authority) return {...report(state,false,null),bootstrap:true};
  need(live.quorumEscrowSupported,503,'A majority with active sale escrow is required');
  const row=await db.prepare('SELECT state,recipient,chain_id,intent,CAST(amount_micro AS TEXT) AS micro FROM sale_orders WHERE id=?')
    .bind(order.orderId).first();
  const persisted=row && wireTerms(JSON.parse(row.intent));
  need(row && row.state===(acquire?'holding':'releasing') && row.recipient===order.to &&
    row.chain_id===order.evmChainId && persisted.terms===order.terms &&
    String(BigInt(row.micro)*saleNanoPerMicro(persisted.terms ?? SALE_TERMS))===order.amountNano,
  409,'Sale order phase or bound terms changed');
  const fields={orderId:order.orderId,to:order.to,amount:encodeAmount(BigInt(order.amountNano)),evmChainId:order.evmChainId,
    ...persisted};
  const commitment=saleHoldCommitment(fields);
  const held=Object.hasOwn(state.saleHolds ?? {},order.orderId) ? state.saleHolds[order.orderId] : null;
  if (held) need(held.commitment===commitment && held.amount===fields.amount,409,'Conflicting on-chain sale hold');
  if (Boolean(held)===acquire) return report(state,acquire,commitment);
  const p={type:acquire?'hold-sale':'release-sale',chainId:reserve.chainId,from:owner.address,
    nonce:(state.nonces[owner.address] ?? 0)+1,mandateVersion:state.saleMandate?.version,
    ...(acquire ? fields : {orderId:order.orderId,commitment})};
  saleHoldEffect(state,p);
  const next=await commit(live,{payload:p,signature:sign(owner.privateKey,p)});
  const after=next.head.state;
  need(acquire ? after.saleHolds?.[order.orderId]?.commitment===commitment :
    !Object.hasOwn(after.saleHolds ?? {},order.orderId),503,'Sale hold confirmation pending');
  return report(after,acquire,commitment);
}

export function ensureSaleHold(env,db,order) {
  return updateVerifiedHold(db,order,signer(env),true,{read:()=>readHostedLedger(db),commit:quorumCommit});
}

export function releaseSaleHold(env,db,order) {
  return updateVerifiedHold(db,order,signer(env),false,{read:()=>readHostedLedger(db),commit:quorumCommit});
}

export function settleOrder(env,db,order) {
  return deliverVerifiedOrder(db,order,signer(env),{read:()=>readHostedLedger(db),async commit(live,tx,row) {
    if (live.url) return quorumCommit(live,tx);
    const sequencingKey=env.GPUCHAIN_SIGNER_PKCS8;
    const sequencingWallet={privateKey:sequencingKey,address:addressFromPrivateKey(sequencingKey)};
    const {next}=nextCheckpoint(live.head,tx,sequencingWallet);
    const encoded=JSON.stringify(next);
    need(new TextEncoder().encode(encoded).length<=MAX_HEAD,507,'Hosted checkpoint is full');
    const changed=await db.prepare(`UPDATE ledger_head SET tip=?,checkpoint=? WHERE id=1 AND tip=?
      AND EXISTS(SELECT 1 FROM sale_delivery WHERE sequence=? AND intent=? AND confirmation IS NULL)`)
      .bind(next.state.tip,encoded,live.head.state.tip,row.sequence,row.intent).run();
    need(changed.meta.changes===1,409,'Ledger or sale intent changed; retry');
    return {head:next};
  }});
}
