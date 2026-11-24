#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { participantConfig } from '../src/participant-config.mjs';
import { publicGenesis, resolvePublicLedger } from '../src/public-network.mjs';
import { startValidator } from '../src/validator.mjs';
import { enrollAt } from '../src/validator-enroll.mjs';

export async function startParticipant() {
  const {dir,wallet,port,origin} = await participantConfig();
  return startValidator({
    dir, wallet, port, origin, genesis:publicGenesis,
    syncIntervalMs:origin ? 5000 : 30000,
    monitor:({instanceId}) => resolvePublicLedger({activation:true,excludeInstanceId:instanceId}),
    discover:origin ? ({instanceId,ledgerUrl}) => enrollAt(ledgerUrl,publicGenesis.hash,wallet,origin,instanceId) : undefined,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const node = await startParticipant();
    console.log(JSON.stringify({pid:process.pid,url:node.url,chainId:publicGenesis.hash}));
    const stop = () => node.close().catch(err=>{console.error(err.message);process.exitCode=1;});
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
  } catch (err) { console.error(err.message);process.exitCode=1; }
}
