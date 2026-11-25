import { decodeAmount } from '../../src/amount.mjs';
import { DISTRIBUTION_RESERVE as reserve } from '../../src/ledger.mjs';
import { SALE_NANO_PER_MICRO } from '../../src/sale-policy.mjs';
import { OUTCOME_SLOTS } from '../../src/transaction-outcome.mjs';

// ledger_head also holds singleton operational rows (1–4). This disjoint
// bounded range contains compact proofs tied to the same atomic head write.
export const OUTCOME_ROW_BASE=10000;
export const HOSTED_HEAD_BYTES=1_900_000;
// New awards yield capacity to paid deliveries (up to 256 open orders) and
// the three-validator activation certificate, including its public origins.
export const GRANT_HEAD_BYTES=HOSTED_HEAD_BYTES-64*1024;

export const openOrders = "state IN ('holding','reserved','paid','releasing')";
const clockMs = "(CAST(strftime('%s','now') AS INTEGER)*1000)";
const drainRow = "id=4 AND tip='usdt-sales-drain/v1' AND CAST(checkpoint AS INTEGER)>"+clockMs;
export const intakeFence = `EXISTS(SELECT 1 FROM ledger_head WHERE id=1 AND tip=?)
  AND (?=1 OR NOT EXISTS(SELECT 1 FROM ledger_head WHERE ${drainRow}))`;

// Express liabilities in microUSDT. This fits SQLite int64 even at the full
// trillion-coin supply. A paid order may already be debited but still be
// awaiting its D1 acknowledgement after an interrupted request.
export const heldMicroSql = `COALESCE((SELECT SUM(o.amount_micro) FROM sale_orders o
  WHERE o.state IN ('holding','reserved','releasing') OR (o.state='paid' AND NOT EXISTS(
    SELECT 1 FROM sale_delivery d WHERE d.order_id=o.id AND d.payment_id=o.event_id AND
      ((d.confirmation IS NOT NULL AND d.sequence<=?) OR (d.sequence=? AND d.payment_id=?))
  )) OR (o.state='delivered' AND o.delivery_sequence>?)),0)`;
export const holdArgs = (sequence,paymentId)=>[sequence,sequence,paymentId ?? '',sequence];

export function issuedPublicReserve(state) {
  return state.chainId===reserve.chainId && state.reserveClaim===reserve.claim;
}
export async function isDraining(db) {
  return !!await db.prepare('SELECT 1 AS draining FROM ledger_head WHERE '+drainRow).first();
}
export async function prepareSalesRetirement(db,state) {
  if(!issuedPublicReserve(state)) return true;
  // Writers exist only on the D1 bootstrap until the final CAS. Renew the gate
  // only when the complete ready, published cohort is actively requesting activation.
  await db.prepare(`INSERT INTO ledger_head(id,tip,checkpoint) VALUES(4,'usdt-sales-drain/v1',CAST(${clockMs}+120000 AS TEXT))
    ON CONFLICT(id) DO UPDATE SET tip=excluded.tip, checkpoint=excluded.checkpoint`).run();
  return !await db.prepare(`SELECT 1 AS pending FROM sale_orders WHERE ${openOrders} LIMIT 1`).first();
}
export function retirementGuard(state) {
  return issuedPublicReserve(state)?` AND NOT EXISTS(SELECT 1 FROM sale_orders WHERE ${openOrders})`:'';
}
export function writerBudgetGuard(state,next,type) {
  if(!issuedPublicReserve(state))return null;
  const after=decodeAmount(next.balances[reserve.address] ?? 0);
  if(type!=='authorize-sales' && type!=='suspend-sales' && after>=decodeAmount(state.balances[reserve.address] ?? 0))return null;
  const mandate=next.saleMandate;
  const authorityChanged=state.saleMandate?.active && state.saleMandate.authority!==mandate?.authority;
  const allowance=mandate?.active && !authorityChanged ? decodeAmount(mandate.cap)-decodeAmount(mandate.spent) : 0n;
  const ceiling=(after<allowance?after:allowance)/SALE_NANO_PER_MICRO;
  return {sql:` AND CAST(? AS INTEGER)>=${heldMicroSql}`,
    args:[ceiling.toString(),...holdArgs(next.lastSale?.sequence ?? 0,next.lastSale?.paymentId)]};
}

export async function commitHostedTransaction(db,prior,next,encoded,type,proof) {
  if(type==='starter-grant' && new TextEncoder().encode(encoded).byteLength>GRANT_HEAD_BYTES) {
    throw Object.assign(Error('Hosted starter grants paused to preserve payment and handoff capacity'),{status:507});
  }
  const guard=writerBudgetGuard(prior,next,type);
  const update=db.prepare('UPDATE ledger_head SET tip=?,checkpoint=? WHERE id=1 AND tip=?'+(guard?.sql ?? ''))
    .bind(next.tip,encoded,prior.tip,...(guard?.args ?? []));
  const result=proof ? (await db.batch([update,db.prepare(
    'INSERT OR REPLACE INTO ledger_head(id,tip,checkpoint) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ledger_head WHERE id=1 AND tip=?)')
    .bind(OUTCOME_ROW_BASE+next.height%OUTCOME_SLOTS,proof.txHash,JSON.stringify(proof),next.tip)]))[0] : await update.run();
  if(result.meta.changes!==1)throw Object.assign(Error(guard?'Ledger moved or this spend would consume reserved orders':
    'Ledger advanced concurrently; retry with current state'),{status:409});
}
