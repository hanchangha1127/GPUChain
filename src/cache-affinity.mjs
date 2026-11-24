import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const maxEntries = 256;
const retentionMs = 24 * 60 * 60 * 1000;

// The API token keys the digest so a copied database cannot be used to look up
// guessed prompts. Rotating the token also rotates the local routing keys.
export function affinityDigest({token,payer,model,session,messages}) {
  const scope = session === undefined
    ? ['first-user', messages.find(message => message.role === 'user').content]
    : ['session', session];
  return createHmac('sha256',token).update(JSON.stringify([payer,model,...scope])).digest('hex');
}

export function openCacheAffinity(directory) {
  if (directory) mkdirSync(directory,{recursive:true,mode:0o700});
  const db = new DatabaseSync(directory ? join(directory,'inference-affinity.sqlite') : ':memory:');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS affinity (digest TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, updated INTEGER NOT NULL)');
    const find = db.prepare('SELECT provider FROM affinity WHERE digest = ? AND updated >= ?');
    const insert = db.prepare('INSERT OR REPLACE INTO affinity (digest,provider,updated) VALUES (?,?,?)');
    const prune = db.prepare('DELETE FROM affinity WHERE updated < ? OR rowid IN (SELECT rowid FROM affinity ORDER BY rowid DESC LIMIT -1 OFFSET ?)');
    return {
      preferred(digest) {
        return find.get(digest,Date.now()-retentionMs)?.provider;
      },
      remember(digest,provider) {
        if (typeof provider !== 'string' || !/^[0-9a-f]{64}$/.test(provider)) return;
        const now = Date.now();
        db.exec('BEGIN IMMEDIATE');
        try {
          insert.run(digest,provider,now);
          prune.run(now-retentionMs,maxEntries);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
