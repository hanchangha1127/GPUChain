#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { participantConfig } from '../src/participant-config.mjs';
import { publicGenesis, resolvePublicLedger } from '../src/public-network.mjs';
import { startValidator } from '../src/validator.mjs';
import { enrollAt } from '../src/validator-enroll.mjs';
import { startWalletUi } from '../src/wallet-ui.mjs';
import { createWalletSender } from '../src/wallet-send.mjs';

export async function startParticipant() {
  const {dir,wallet,port,origin} = await participantConfig();
  const guiPort = process.env.GPUCHAIN_WALLET_PORT ?? '8791';
  if (!/^\d+$/.test(guiPort) || Number(guiPort) > 65535) throw Error('Invalid GPUCHAIN_WALLET_PORT');
  const node = await startValidator({
    dir, wallet, port, origin, genesis:publicGenesis,
    syncIntervalMs:origin ? 5000 : 30000,
    monitor:({instanceId}) => resolvePublicLedger({activation:true,excludeInstanceId:instanceId}),
    discover:origin ? ({instanceId,ledgerUrl}) => enrollAt(ledgerUrl,publicGenesis.hash,wallet,origin,instanceId) : undefined,
  });
  let gui;
  const sender=createWalletSender({wallet});
  try {
    const options = {getSnapshot:node.snapshot,port:Number(guiPort),providerUrl:process.env.GPUCHAIN_LOCAL_PROVIDER_URL,sender};
    try { gui = await startWalletUi(options); }
    catch (err) {
      if (err.code !== 'EADDRINUSE' || process.env.GPUCHAIN_WALLET_PORT !== undefined) throw err;
      gui = await startWalletUi({...options,port:0});
    }
  } catch (err) {
    await node.close();
    throw err;
  }
  return {url:node.url,guiUrl:gui.url,issueUnlock:sender.issueCode,async close() {
    try { await gui.close(); } finally { await node.close(); }
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const node = await startParticipant();
    console.log(JSON.stringify({pid:process.pid,url:node.url,guiUrl:node.guiUrl,chainId:publicGenesis.hash}));
    const stop = () => node.close().catch(err=>{console.error(err.message);process.exitCode=1;});
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
  } catch (err) { console.error(err.message);process.exitCode=1; }
}
