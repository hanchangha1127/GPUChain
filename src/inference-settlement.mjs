import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, verify } from './crypto.mjs';
import { requestJson } from './http.mjs';
import { submitSignedTransaction } from './submit-transaction.mjs';
import { verifyOutcome } from './transaction-outcome.mjs';
import { validateWalletSpend } from './ledger.mjs';
import { formatCoins } from './amount.mjs';

function error(code,message) { return Object.assign(Error(message),{status:409,code}); }
function journal(directory,create) {
  if (!directory) return;
  const file=join(directory,'pending-inference.sqlite');
  if (!create && !existsSync(file)) return;
  mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, data TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS review (digest TEXT UNIQUE NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS last_transfer (id INTEGER PRIMARY KEY CHECK(id=1), nonce INTEGER NOT NULL, data TEXT NOT NULL)');
    return {
      read() { const row=db.prepare('SELECT data FROM pending WHERE id=1').get();return row && JSON.parse(row.data); },
      review(digest) {
        const row=digest ? db.prepare('SELECT data FROM review WHERE digest=?').get(digest) :
          db.prepare('SELECT data FROM review ORDER BY rowid DESC LIMIT 1').get();
        return row && JSON.parse(row.data);
      },
      lastTransfer() {
        const row=db.prepare('SELECT data FROM last_transfer WHERE id=1').get();
        return row && JSON.parse(row.data);
      },
      save(record,digest) {
        db.prepare('INSERT OR IGNORE INTO pending(id,digest,data) VALUES(1,?,?)').run(digest,JSON.stringify(record));
        if (db.prepare('SELECT digest FROM pending WHERE id=1').get().digest!==digest) {
          throw error('settlement_pending','Another signed wallet payment still needs settlement');
        }
      },
      finish(record,digest,status,receipt) {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (status==='unconfirmed') {
            db.prepare('INSERT OR IGNORE INTO review(digest,data) VALUES(?,?)').run(digest,JSON.stringify(record));
            db.prepare('DELETE FROM review WHERE rowid NOT IN (SELECT rowid FROM review ORDER BY rowid DESC LIMIT 16)').run();
          } else {
            db.prepare('DELETE FROM review WHERE digest=?').run(digest);
          }
          db.prepare('DELETE FROM pending WHERE id=1 AND digest=?').run(digest);
          if (record.tx.payload.type==='transfer') {
            const info=transferSummary(record.tx,status,receipt);
            db.prepare('INSERT INTO last_transfer(id,nonce,data) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,data=excluded.data WHERE excluded.nonce>=last_transfer.nonce')
              .run(info.nonce,JSON.stringify(info));
          }
          db.exec('COMMIT');
        } catch (err) {db.exec('ROLLBACK');throw err;}
      },
      close() { db.close(); }
    };
  } catch(err) { db.close(); throw err; }
}

function transferSummary(tx,status,receipt) {
  const {to,amount,nonce}=tx.payload;
  return {type:'transfer',status,to,coins:formatCoins(amount),nonce,txHash:hash(tx),...receipt};
}

export function walletPaymentStatus(directory) {
  if (!directory) return {};
  const file=join(directory,'pending-inference.sqlite');
  if (!existsSync(file)) return {};
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=150');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending'").get()) return {};
    const row=db.prepare('SELECT data FROM pending WHERE id=1').get();
    const tx=row && JSON.parse(row.data).tx;
    let lastTransfer;
    if (tx?.payload.type==='transfer') lastTransfer=transferSummary(tx,'pending');
    else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='last_transfer'").get()) {
      const last=db.prepare('SELECT data FROM last_transfer WHERE id=1').get();
      if (last) lastTransfer=JSON.parse(last.data);
    }
    const reviews=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review'").get() ?
      db.prepare('SELECT data FROM review ORDER BY rowid DESC LIMIT 16').all().map(row=>{
        const {tx}=JSON.parse(row.data);
        const {type,nonce,to,amount}=tx.payload;
        return {type,nonce,txHash:hash(tx),...(type==='transfer'?{to,coins:formatCoins(amount)}:{})};
      }) : [];
    return {pending:tx?.payload.type,lastTransfer,reviews};
  } finally { db.close(); }
}
export function hasPendingInference(directory) { return walletPaymentStatus(directory).pending==='inference'; }
export function unconfirmedTransfer(directory,to,amount) {
  return walletPaymentStatus(directory).reviews?.find(r=>r.type==='transfer' && r.to===to && r.coins===formatCoins(amount))?.txHash;
}

// Only an authenticated commitment to the full signed transaction can resolve
// a lost response as paid. Balances and spend nonces alone cannot identify it.
async function lookup(ledger,record,request) {
  const {tx,origin}=record;
  const digest=hash(tx);
  const origins=new Set([ledger.url,origin,...(ledger.checkpoint.authority?.payload.validators.map(v=>v.url)??[])]);
  for (const url of origins) {
    let proof;
    try { proof=await request(url+'/v1/transaction-outcomes/'+digest,{maxBytes:8192,timeoutMs:4000}); }
    catch { continue; }
    try { return verifyOutcome(proof,tx,ledger.checkpoint); }
    catch { /* Another certified origin may hold a valid proof. */ }
  }
}

async function reconcile(record,db,resolveLedger,request,lookupOnly=false) {
  const {tx,stage}=record, p=tx.payload, digest=hash(tx);
  let previousError;
  for (let attempt=0;attempt<=3;attempt++) {
    if (attempt) await delay(100*attempt);
    let ledger,readOnly=lookupOnly;
    try {
      try { ledger=await resolveLedger({readOnly}); }
      catch (err) {
        if (readOnly) throw err;
        readOnly=true;
        ledger=await resolveLedger({readOnly});
      }
    } catch (cause) { throw Object.assign(error('settlement_pending','Signed payment awaits a verified ledger for settlement'),{cause}); }
    if (ledger.state.chainId!==p.chainId || ledger.state.height<record.height) throw error('settlement_pending','Settlement ledger does not match the original network and minimum height');
    const nonce=ledger.state.nonces[p.from]??0;
    if (nonce>=p.nonce) {
      const receipt=await lookup(ledger,record,request);
      db?.finish(record,digest,receipt?'confirmed':'unconfirmed',receipt);
      if (receipt) return p.type==='transfer'?transferSummary(tx,'confirmed',receipt):receipt;
      throw error('settlement_unconfirmed','The spend nonce was consumed. Payment is unconfirmed; check the signed outcome later with recover-settlement --tx-hash '+digest);
    }
    if (readOnly) throw error('settlement_pending','The verified checkpoint does not cover this payment nonce yet');
    if (nonce+1!==p.nonce) throw error('settlement_pending','The ledger has not reached the original payment nonce');
    // With the nonce still unused, deterministic checks against the signed
    // head distinguish an inadmissible receipt from an unreachable writer.
    // A rejected receipt is never re-signed or submitted on a later epoch.
    try {
      if (ledger.state.networkStage!==stage) throw Error('Network stage changed');
      validateWalletSpend(ledger.state,tx);
    } catch (cause) {
      db?.finish(record,digest,'rejected');
      throw Object.assign(error('settlement_rejected','The verified ledger state rejects this signed payment: '+cause.message),{cause});
    }
    if (attempt===3) break;
    try {
      const receipt=await submitSignedTransaction(ledger,tx,request);
      db?.finish(record,digest,'confirmed',receipt);
      return p.type==='transfer'?transferSummary(tx,'confirmed',receipt):receipt;
    } catch (err) {
      // An unapplied, definite rejection is different from a lost response.
      // Retry the same bytes after a concurrent CAS or unavailable writer.
      if (err.status>=400 && err.status<500 && ![400,408,409,425,429].includes(err.status)) {
        throw Object.assign(error('settlement_pending','The ledger endpoint refused submission of the signed wallet payment'),{cause:err});
      }
      previousError=err;
    }
  }
  throw Object.assign(error('settlement_pending','Signed wallet payment is pending; run recover-settlement to reconcile it'),
    {cause:previousError});
}

function validSpend(tx,address) {
  const p=tx?.payload;
  return !!p && p.from===address && ['transfer','inference'].includes(p.type) && verify(address,p,tx.signature) &&
    (p.type==='transfer' || verify(p.provider,p,tx.providerSignature));
}

export async function settleWalletPayment(ledger,tx,{resolveLedger=async()=>ledger,directory,request=requestJson}={}) {
  const {payload:p}=tx;
  if (p?.chainId!==ledger.state.chainId || !validSpend(tx,p.from)) throw Error('Invalid signed wallet settlement');
  const record={tx,origin:ledger.url,height:ledger.state.height,stage:ledger.state.networkStage};
  const db=journal(directory,true);
  try {
    db?.save(record,hash(tx));
    return await reconcile(record,db,resolveLedger,request);
  } finally { db?.close(); }
}
export function settleInference(ledger,tx,options) {
  if (tx?.payload?.type!=='inference') throw Error('Expected signed inference settlement');
  return settleWalletPayment(ledger,tx,options);
}

export async function recoverWalletPayment(directory,walletAddress,resolveLedger,request=requestJson,{includeReview=false,digest,lookupOnly=false}={}) {
  if (digest!==undefined && !/^[a-f0-9]{64}$/.test(digest)) throw Error('Expected a 64-character transaction hash');
  const db=journal(directory,false);
  if (!db) return null;
  try {
    let record=db.read();
    if (digest && record && hash(record.tx)!==digest) record=null;
    if (!record && includeReview) {record=db.review(digest);lookupOnly=true;}
    if (!record) {
      const last=digest && db.lastTransfer();
      return last?.txHash===digest && last?.status==='confirmed' ? last : null;
    }
    if (!validSpend(record.tx,walletAddress)) throw Error('Pending payment does not match this wallet');
    return await reconcile(record,db,resolveLedger,request,lookupOnly);
  } finally { db.close(); }
}
export const recoverPendingInference=recoverWalletPayment;
