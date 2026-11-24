import { randomUUID } from 'node:crypto';
import { mkdir, open, link, readFile, rename, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { addressFromPrivateKey, generateWallet } from './crypto.mjs';
import { normalizeProviderEndpoint, isLoopbackEndpoint } from './provider-endpoint.mjs';

export function participantDir() {
  return resolve(process.env.GPUCHAIN_PARTICIPANT_DIR || join(homedir(),'.gpuchain','participant'));
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return undefined; throw err; }
}

// Atomically publish complete files. Losing a simultaneous first-run race reuses
// the winner's identity. Restarting never replaces or recreates a missing key.
async function publish(path, value, replace = false) {
  const temporary = path+'.'+randomUUID()+'.tmp';
  const file = await open(temporary,'wx',0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value,null,2)+'\n');
      await file.sync();
    } finally { await file.close(); }
    if (replace) await rename(temporary,path);
    else {
      try { await link(temporary,path); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
  } finally {
    await unlink(temporary).catch(err=>{if (err.code !== 'ENOENT') throw err;});
  }
}

export async function participantConfig(dir = participantDir(), env = process.env) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const settingsFile = join(dir,'participant.json');
  const previous = await readJson(settingsFile);
  if (previous !== undefined && (previous?.version !== 1 || typeof previous.walletFile !== 'string' ||
      !/^[a-f0-9]{64}$/.test(previous.address))) throw Error('Invalid saved participant configuration');
  const walletFile = resolve(env.GPUCHAIN_VALIDATOR_WALLET || previous?.walletFile || join(dir,'validator.wallet.json'));
  let wallet = await readJson(walletFile);
  if (wallet === undefined) {
    const db = await stat(join(dir,'validator.sqlite')).catch(err=>{
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (env.GPUCHAIN_VALIDATOR_WALLET || previous || db) throw Error('Restore the existing participant wallet: '+walletFile);
    await publish(walletFile,generateWallet());
    wallet = await readJson(walletFile);
  }
  if (wallet?.address !== addressFromPrivateKey(wallet?.privateKey) ||
    (previous && wallet.address !== previous.address)) throw Error('Wallet does not match participant identity');
  const value = env.GPUCHAIN_VALIDATOR_PORT ?? previous?.port ?? 8790;
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw Error('Invalid GPUCHAIN_VALIDATOR_PORT');
  }
  const originValue = env.GPUCHAIN_VALIDATOR_ORIGIN ?? previous?.origin;
  const origin = originValue ? normalizeProviderEndpoint(originValue) : undefined;
  if (origin && (!origin.startsWith('https://') || isLoopbackEndpoint(origin))) {
    throw Error('Set GPUCHAIN_VALIDATOR_ORIGIN to a public HTTPS origin for committee enrollment');
  }
  const config = {version:1,address:wallet.address,walletFile,port,origin:origin ?? null};
  if (JSON.stringify(previous) !== JSON.stringify(config)) {
    await publish(settingsFile,config,previous !== undefined);
    if (JSON.stringify(await readJson(settingsFile)) !== JSON.stringify(config)) {
      throw Error('Participant configuration changed concurrently; retry');
    }
  }
  return {dir,wallet,port,origin};
}
