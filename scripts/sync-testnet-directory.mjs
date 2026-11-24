import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import genesis from '../networks/sites-testnet.json' with {type:'json'};
import { authenticate } from '../src/checkpoint.mjs';
import { checkEnrollment } from '../src/enrollment.mjs';
import { verifyActivation } from '../src/consensus.mjs';
import { normalizeProviderEndpoint } from '../src/provider-endpoint.mjs';
import { requestJson } from '../src/http.mjs';

const originalHost = 'https://gpuchain-ledger-hch.authentictarragon2.chatgpt.site';
const directoryFile = fileURLToPath(new URL('../networks/testnet-endpoints.json',import.meta.url));

// Run by the public repository before activation. GitHub can publish contact
// information, but only the chain's signer can authorize the validator roster.
export async function nextDirectory(previous, {bootstrap = originalHost, pin = genesis,
  get = requestJson, now = Date.now(), allowLoopback = false} = {}) {
  if (previous.chainId !== pin.hash || !Array.isArray(previous.endpoints)) throw Error('Wrong network directory');
  function finalDirectory(authority) {
    const {validators} = verifyActivation(authority,pin);
    return {chainId:pin.hash,endpoints:validators.map(v=>v.url),authority};
  }
  if (previous.authority) return finalDirectory(previous.authority);
  const origins = [...new Set([bootstrap,...previous.endpoints])].map(normalizeProviderEndpoint);
  let intents;
  let found = false;
  for (const origin of origins) {
    try {
      const cp = authenticate(await get(origin+'/v1/checkpoint',{timeoutMs:4500,maxBytes:4*1024*1024}),pin.hash);
      if (cp.authority) return finalDirectory(cp.authority);
      if (origin !== bootstrap) continue;
      const feed = await get(origin+'/v1/consensus/candidates',{timeoutMs:4500,maxBytes:65536});
      if (feed?.chainId !== pin.hash || !Array.isArray(feed.candidates) || feed.candidates.length > 12) {
        throw Error('Invalid candidate feed');
      }
      intents = [];
      for (const candidate of feed.candidates) {
        try { intents.push(checkEnrollment(candidate,cp.state,{now,allowLoopback}).origin); }
        catch { /* An expired or invalid opt-in is ineligible for publication. */ }
      }
      found = true;
    } catch { /* An enrolled validator can supply the certificate if Sites has retired. */ }
  }
  if (!found) throw Error('No verified bootstrap feed or activated validator was reachable');
  const seeds = [bootstrap,...new Set(intents.sort())];
  for (const old of origins) if (seeds.length < 16 && !seeds.includes(old)) seeds.push(old);
  return {chainId:pin.hash,endpoints:[...new Set(seeds)]};
}

async function main() {
  const old = JSON.parse(await readFile(directoryFile,'utf8'));
  const updated = await nextDirectory(old);
  if (JSON.stringify(updated) === JSON.stringify(old)) return;
  const temp = directoryFile+'.tmp';
  await writeFile(temp,JSON.stringify(updated,null,2)+'\n');
  await rename(temp,directoryFile);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
