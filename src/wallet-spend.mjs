import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hasPendingInference, recoverPendingInference } from './inference-settlement.mjs';

// All checkouts run by this OS user coordinate the same wallet and chain.
// The OS releases the SQLite writer lock when a process dies. The small
// status file is advisory: it is meaningful only while the lock is held.
export function walletSpendCoordinator(chainId,address,{root=join(homedir(),'.gpuchain','spends')}={}) {
  if (![chainId,address].every(value=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value))) {
    throw Error('Invalid spend coordinator identity');
  }
  const directory=join(root,chainId,address);
  const lockPath=join(directory,'spend.sqlite');
  const activityPath=join(directory,'activity');

  function tryAcquire() {
    const db=new DatabaseSync(lockPath);
    try {
      db.exec('BEGIN IMMEDIATE');
      return db;
    } catch (error) {
      db.close();
      if (error.errcode===5) return null;
      throw error;
    }
  }
  function activity() {
    if (!existsSync(lockPath)) return null;
    const lock=tryAcquire();
    if (lock) {
      lock.close();
      return hasPendingInference(directory) ? 'inference' : null;
    }
    try { return readFileSync(activityPath,'utf8')==='inference' ? 'inference' : 'transaction'; }
    catch { return 'transaction'; }
  }
  async function run(kind,resolveLedger,fn,{signal,waitMs=3_700_000}={}) {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const deadline=Date.now()+waitMs;
    let lock;
    while (!lock) {
      signal?.throwIfAborted();
      lock=tryAcquire();
      if (lock) break;
      if (Date.now()>=deadline) throw Object.assign(Error('Another wallet operation is still pending'),{
        status:409,code:'WALLET_BUSY'});
      await delay(150,undefined,{signal});
    }
    try {
      writeFileSync(activityPath,kind,{mode:0o600});
      const recovered=await recoverPendingInference(directory,address,resolveLedger);
      if (kind==='recovery') return recovered;
      if (kind==='inference' && recovered) throw Object.assign(
        Error('The previous inference payment was confirmed at height '+recovered.height+'. Submit a new request to continue.'),
        {status:409,code:'previous_inference_recovered'});
      signal?.throwIfAborted();
      return await fn(directory);
    } finally {
      try { unlinkSync(activityPath); } catch { /* The OS lock is authoritative. */ }
      lock.close();
    }
  }
  return {directory,activity,run};
}
