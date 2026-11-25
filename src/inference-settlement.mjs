import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, verify } from './crypto.mjs';
import { requestJson } from './http.mjs';
import { submitSignedTransaction } from './submit-transaction.mjs';
import { verifyOutcome } from './transaction-outcome.mjs';
import { validateInferenceSpend } from './ledger.mjs';

function error(code,message) { return Object.assign(Error(message),{status:409,code}); }
function journal(directory,create) {
  if (!directory) return;
  const file=join(directory,'pending-inference.sqlite');
  if (!create && !existsSync(file)) return;
  mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, data TEXT NOT NULL)');
    return {
      read() { const row=db.prepare('SELECT data FROM pending WHERE id=1').get();return row && JSON.parse(row.data); },
      save(record,digest) {
        db.prepare('INSERT OR IGNORE INTO pending(id,digest,data) VALUES(1,?,?)').run(digest,JSON.stringify(record));
        if (db.prepare('SELECT digest FROM pending WHERE id=1').get().digest!==digest) {
          throw error('settlement_pending','Another signed inference receipt still needs settlement');
        }
      },
      clear(digest) { db.prepare('DELETE FROM pending WHERE id=1 AND digest=?').run(digest); },
      close() { db.close(); }
    };
  } catch(err) { db.close(); throw err; }
}

export function hasPendingInference(directory) {
  if (!directory) return false;
  const file=join(directory,'pending-inference.sqlite');
  if (!existsSync(file)) return false;
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending'").get()) return false;
    return !!db.prepare('SELECT 1 FROM pending WHERE id=1').get();
  } finally { db.close(); }
}

// Only an authenticated commitment to the full signed transaction can resolve
// a lost response as paid. Balances and spend nonces alone cannot identify it.
async function lookup(ledger,record,request) {
  const {tx,origin}=record;
  const digest=hash(tx);
  const origins=new Set([ledger.url,origin,...(ledger.checkpoint.authority?.payload.validators.map(v=>v.url)??[])]);
  let unavailable=false;
  for (const url of origins) {
    let proof;
    try { proof=await request(url+'/v1/transaction-outcomes/'+digest,{maxBytes:8192,timeoutMs:4000}); }
    catch (err) { if (err.status!==404) unavailable=true; continue; }
    try { return verifyOutcome(proof,tx,ledger.checkpoint); }
    catch { unavailable=true; } // Allow another certified origin to return a valid proof.
  }
  if (unavailable) throw error('settlement_pending','Could not verify the earlier signed inference payment; try again when the ledger is reachable');
}

async function reconcile(record,db,resolveLedger,request) {
  const {tx,stage}=record, p=tx.payload, digest=hash(tx);
  let previousError;
  for (let attempt=0;attempt<=3;attempt++) {
    if (attempt) await delay(100*attempt);
    let ledger;
    try { ledger=await resolveLedger(); }
    catch (cause) { throw Object.assign(error('settlement_pending','Signed inference receipt awaits a verified ledger for settlement'),{cause}); }
    if (ledger.state.chainId!==p.chainId || ledger.state.height<record.height) throw error('settlement_pending','Settlement ledger does not match the original network and minimum height');
    const nonce=ledger.state.nonces[p.from]??0;
    if (nonce>=p.nonce) {
      const receipt=await lookup(ledger,record,request);
      db?.clear(digest);
      if (receipt) return receipt;
      throw error('settlement_unconfirmed','The spend nonce was consumed. No matching signed outcome is available; payment is unconfirmed. Check wallet activity before starting another inference.');
    }
    if (nonce+1!==p.nonce) throw error('settlement_pending','The ledger has not reached the original payment nonce');
    // With the nonce still unused, deterministic checks against the signed
    // head distinguish an inadmissible receipt from an unreachable writer.
    // A rejected receipt is never re-signed or submitted on a later epoch.
    try {
      if (ledger.state.networkStage!==stage) throw Error('Network stage changed');
      validateInferenceSpend(ledger.state,tx);
    } catch (cause) {
      db?.clear(digest);
      throw Object.assign(error('settlement_rejected','The verified ledger state rejects this inference receipt: '+cause.message),{cause});
    }
    if (attempt===3) break;
    try {
      const receipt=await submitSignedTransaction(ledger,tx,request);
      db?.clear(digest);
      return receipt;
    } catch (err) {
      // An unapplied, definite rejection is different from a lost response.
      // Retry the same bytes after a concurrent CAS or unavailable writer.
      if (err.status>=400 && err.status<500 && ![400,408,409,425,429].includes(err.status)) {
        throw Object.assign(error('settlement_pending','The ledger endpoint refused submission of the signed inference payment'),{cause:err});
      }
      previousError=err;
    }
  }
  throw Object.assign(error('settlement_pending','Signed inference payment is pending; retry its settlement before starting another inference'),
    {cause:previousError});
}

export async function settleInference(ledger,tx,{resolveLedger=async()=>ledger,directory,request=requestJson}={}) {
  const {payload:p}=tx;
  if (p?.type!=='inference' || p.chainId!==ledger.state.chainId || !verify(p.from,p,tx.signature) ||
      !verify(p.provider,p,tx.providerSignature)) throw Error('Invalid signed inference settlement');
  const record={tx,origin:ledger.url,height:ledger.state.height,stage:ledger.state.networkStage};
  const db=journal(directory,true);
  try {
    db?.save(record,hash(tx));
    return await reconcile(record,db,resolveLedger,request);
  } finally { db?.close(); }
}

export async function recoverPendingInference(directory,walletAddress,resolveLedger,request=requestJson) {
  const db=journal(directory,false);
  if (!db) return null;
  try {
    const record=db.read();
    if (!record) return null;
    const {tx}=record,p=tx?.payload;
    if (p?.type!=='inference' || p.from!==walletAddress || !verify(p.from,p,tx.signature) ||
        !verify(p.provider,p,tx.providerSignature)) throw Error('Pending inference receipt does not match this wallet');
    return await reconcile(record,db,resolveLedger,request);
  } finally { db.close(); }
}
