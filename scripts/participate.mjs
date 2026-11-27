#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { participantConfig } from '../src/participant-config.mjs';
import { publicGenesis, resolvePublicLedger } from '../src/public-network.mjs';
import { startValidator } from '../src/validator.mjs';
import { enrollAt } from '../src/validator-enroll.mjs';
import { startWalletUi } from '../src/wallet-ui.mjs';
import { createWalletSender } from '../src/wallet-send.mjs';
import { startAutoProvider } from '../src/auto-provider.mjs';
import { manageProviderRelays } from '../src/participant-relay.mjs';
import { startOpenAiGateway } from '../src/openai-gateway.mjs';
import { purchaseChat } from '../src/consumer-chat.mjs';
import { walletSpendCoordinator } from '../src/wallet-spend.mjs';
import { inspectInferenceRoutes } from '../src/inference-routes.mjs';

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
  let gui, auto, relays, gateway, enabling, gatewayError;
  const spends=walletSpendCoordinator(publicGenesis.hash,wallet.address);
  const resolveLedger=({readOnly=false}={})=>resolvePublicLedger({write:!readOnly,activation:readOnly});
  const tokenFile=join(dir,'opencode.token');
  async function enableOpenAi() {
    if (gateway) return gateway.url;
    enabling ??= (async () => {
      const token=(await readFile(tokenFile,'utf8')).trim();
      if (!/^[0-9a-f]{64}$/.test(token)) throw Error('Invalid local inference token');
      const port=process.env.GPUCHAIN_OPENAI_PORT ?? '8792';
      if (!/^\d+$/.test(port)) throw Error('Invalid GPUCHAIN_OPENAI_PORT');
      gateway=await startOpenAiGateway({wallet,token,port:Number(port),affinityDir:dir,
        purchase:input=>spends.run('inference',resolveLedger,
          directory=>purchaseChat(input,{resolveLedger,settlementDirectory:directory}),{signal:input.signal})});
      gatewayError=undefined;
      return gateway.url;
    })();
    try { return await enabling; }
    catch (err) { if (err.code!=='ENOENT') gatewayError=err.message; throw err; }
    finally { enabling=undefined; }
  }
  const sender=createWalletSender({wallet,spends,resolveLedger});
  try {
    if (process.env.GPUCHAIN_AUTO_PROVIDER !== '0' && !process.env.GPUCHAIN_LOCAL_PROVIDER_URL) {
      const backend = process.env.GPUCHAIN_STRATA_URL;
      auto = await startAutoProvider({wallet,chainId:publicGenesis.hash,
        backendUrls:backend ? [backend] : undefined,engine:process.env.GPUCHAIN_STRATA_ENGINE,
        apiKey:process.env.STRATA_API_KEY,
        readState:async()=> (await resolvePublicLedger({write:true})).state});
    }
    relays = manageProviderRelays({wallet,chainId:publicGenesis.hash,adapter:auto,node,
      enabled:!!auto && process.env.GPUCHAIN_INFERENCE_RELAY !== '0'});
    const options = {getSnapshot:()=>({...node.snapshot(),relay:relays.status(),spendActivity:spends.activity()}),port:Number(guiPort),
      providerUrl:process.env.GPUCHAIN_LOCAL_PROVIDER_URL,sender,
      localEngineStatus:()=>auto?.engineStatus ?? (process.env.GPUCHAIN_LOCAL_PROVIDER_URL?'external_adapter':'disabled'),
      diagnoseRoutes:async()=>{
        const ledger=await resolveLedger();
        if (ledger.state.maxOutputTokens<4096) return {code:'output_limit_exceeded',maxOutputTokens:ledger.state.maxOutputTokens};
        return (await inspectInferenceRoutes(ledger,{payer:wallet.address,transport:'relay',chatProtocol:true,
          maxOutputTokens:4096})).diagnostic;
      }};
    try { gui = await startWalletUi(options); }
    catch (err) {
      if (err.code !== 'EADDRINUSE' || process.env.GPUCHAIN_WALLET_PORT !== undefined) throw err;
      gui = await startWalletUi({...options,port:0});
    }
    // A missing token leaves inference disabled. An unavailable inference port
    // is reported independently of checkpoint verification.
    await enableOpenAi().catch(()=>{});
  } catch (err) {
    await relays?.close();
    try { await auto?.close(); } finally { await node.close(); }
    throw err;
  }
  return {url:node.url,guiUrl:gui.url,relayStatus:()=>relays.status(),issueUnlock:sender.issueCode,enableOpenAi,
    get openAiUrl() { return gateway?.url ?? null; },
    get openAiError() { return gatewayError; }, async close() {
    const relayDrain=relays.close(); // Fence new relay admissions before waiting for local purchases.
    try {
      await enabling?.catch(()=>{});
      await gateway?.close();
    } finally {
      try { await relayDrain; } finally {
        try { await gui.close(); } finally {
          try { await auto?.close(); } finally { await node.close(); }
        }
      }
    }
    return relayDrain;
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
