import { createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from './canonical.mjs';

const maxEntries = 256;
const maxRecentPrefixes = 64;
export const CACHE_AFFINITY_TTL_MS = 60 * 60 * 1000;

// The API token keys the digest so a copied database cannot be used to look up
// guessed prompts. Rotating the token also rotates the local routing keys.
export function affinityKeys({token,payer,model,session,messages,chatOptions,reasoningEffort}) {
  if (session !== undefined) {
    const key=createHmac('sha256',token).update(JSON.stringify([payer,model,'session',session])).digest('hex');
    return {candidates:[key],anchors:[key]};
  }
  // Strata can put tools and reasoning instructions before the first message.
  // Only compare inferred prefixes when these parts of the prompt also agree.
  const tools=chatOptions?.tool_choice==='none' ? [] : chatOptions?.tools ?? [];
  const scope=createHmac('sha256',token)
    .update(canonical([payer,model,'conversation-prefix/v1',reasoningEffort ?? null,tools])).digest();
  const prefix=createHash('sha256');
  const candidates=[];
  let opening;
  for (const [index,message] of messages.entries()) {
    prefix.update(canonical(message)).update('\n');
    const firstUser=!opening && message.role==='user';
    if (!firstUser && (opening===undefined || index<messages.length-maxRecentPrefixes)) continue;
    const key=createHmac('sha256',scope).update(prefix.copy().digest()).digest('hex');
    if (firstUser) opening=key;
    candidates.push(key);
  }
  candidates.reverse();
  // Keep the fully settled request and a common opening for shorter matches.
  const anchors=opening===candidates[0] ? [opening] : [opening,candidates[0]];
  return {candidates,anchors};
}

export function openCacheAffinity(directory,{now=Date.now}={}) {
  if (directory) mkdirSync(directory,{recursive:true,mode:0o700});
  const db = new DatabaseSync(directory ? join(directory,'inference-affinity.sqlite') : ':memory:');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS affinity (digest TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, updated INTEGER NOT NULL)');
    const find = db.prepare(`SELECT affinity.provider FROM json_each(?) AS candidates
      JOIN affinity ON digest = candidates.value WHERE updated > ? ORDER BY candidates.key LIMIT 1`);
    const insert = db.prepare('INSERT OR REPLACE INTO affinity (digest,provider,updated) VALUES (?,?,?)');
    const expire = db.prepare('DELETE FROM affinity WHERE updated <= ?');
    const prune = db.prepare('DELETE FROM affinity WHERE rowid IN (SELECT rowid FROM affinity ORDER BY rowid DESC LIMIT -1 OFFSET ?)');
    expire.run(now()-CACHE_AFFINITY_TTL_MS);
    const timer=setInterval(()=>{
      try { expire.run(now()-CACHE_AFFINITY_TTL_MS); } catch { /* Expired entries are also filtered at lookup. */ }
    },60_000);
    timer.unref();
    return {
      preferred(candidates) {
        return find.get(JSON.stringify(candidates),now()-CACHE_AFFINITY_TTL_MS)?.provider;
      },
      remember(anchors,provider) {
        if (typeof provider !== 'string' || !/^[0-9a-f]{64}$/.test(provider)) return;
        const at=now();
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const key of anchors) insert.run(key,provider,at);
          expire.run(at-CACHE_AFFINITY_TTL_MS);
          prune.run(maxEntries);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      close() { clearInterval(timer); db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
