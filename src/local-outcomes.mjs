import { OUTCOME_SLOTS } from './transaction-outcome.mjs';

export function openOutcomes(db) {
  db.exec('CREATE TABLE IF NOT EXISTS recent_outcome (slot INTEGER PRIMARY KEY, tx_hash TEXT UNIQUE NOT NULL, proof TEXT NOT NULL)');
  const put=db.prepare('INSERT OR REPLACE INTO recent_outcome(slot,tx_hash,proof) VALUES(?,?,?)');
  const get=db.prepare('SELECT proof FROM recent_outcome WHERE tx_hash=?');
  return {
    save(height,proof) { put.run(height%OUTCOME_SLOTS,proof.txHash,JSON.stringify(proof)); },
    find(digest) { const row=get.get(digest); return row && JSON.parse(row.proof); }
  };
}
