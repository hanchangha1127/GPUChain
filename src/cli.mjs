#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { addressFromPrivateKey, generateWallet, sign, verify, hash } from './crypto.mjs';
import { charge, CONTEXT, createGenesis, DISTRIBUTION_RESERVE, EPOCH_TOKENS, MAINNET, mainnetPromotionPayload, MODEL, replay } from './ledger.mjs';
import { decodeAmount, formatCoins, parseCoins } from './amount.mjs';
import { SALE_TERMS } from './sale-policy.mjs';
import { readCheckpoint, readVerifiedState, startNode } from './node.mjs';
import { createProviderServer } from './provider.mjs';
import { requestJson } from './http.mjs';
import { probeProvider, rankProviders } from './routing.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { publicGenesis, resolvePublicLedger } from './public-network.mjs';
import { submitSignedTransaction } from './submit-transaction.mjs';
import { startValidator } from './validator.mjs';
import { enrollAt } from './validator-enroll.mjs';
import { reasoningEffort, validateReasoningOptions } from './reasoning.mjs';

const usage = `GPUChain
  wallet   --out FILE
  genesis  --wallet SEQUENCER_KEY --out FILE --allocation ADDRESS=COINS
           [--allocation ADDRESS=COINS ...] [--provider ADDRESS ...] [--max-output N]
  node     --genesis PRIVATE_NETWORK_FILE --wallet SEQUENCER_KEY --dir DIR [--listen HOST] [--port 8787]
  validator --wallet AUTHORIZED_KEY --origin HTTPS_URL --dir DIR [--genesis FILE] [--ledger URL]
            [--listen HOST] [--port 8790]
  follower --dir DIR [--genesis FILE] [--upstream URL] [--listen HOST] [--port 8788]
  provider --wallet PROVIDER_KEY [--genesis FILE] [--ledger URL] [--engine ryzenstrata|strata] [--strata URL] [--model-id ID]
           [--listen HOST] [--port 8789]   (optional backend credential: STRATA_API_KEY)
  status | verify   [--genesis FILE] [--ledger URL]
  balance  [--genesis FILE] --address ADDRESS [--ledger URL]
  transfer [--genesis FILE] --wallet KEY --to ADDRESS --coins DECIMAL [--ledger URL]
  issue-reserve --wallet SEQUENCER_KEY [--ledger URL]  (one-time original public genesis distribution)
  promote-mainnet --wallet SEQUENCER_KEY [--ledger URL]
  authorize-sales --wallet RESERVE_KEY --authority SALE_ADDRESS --coins LIFETIME_CAP [--ledger URL]
  suspend-sales --wallet RESERVE_KEY [--ledger URL]
  routes   [--genesis FILE] [--ledger URL] [--max-output N] [--wallet KEY]
  chat     [--genesis FILE] --wallet KEY [--provider-url URL --provider-address ADDRESS]
           (--text PROMPT | --text-file FILE) [--max-input N] [--max-output N] [--ledger URL]
           [--reasoning-effort none|low|medium|high] [--reasoning-budget-tokens N]
  settings --genesis FILE --wallet SEQUENCER_KEY --max-output N [--ledger URL]
  add-provider --genesis FILE --wallet SEQUENCER_KEY --address ADDRESS [--url URL] [--ledger URL]
  add-validator --wallet SEQUENCER_KEY --address ADDRESS [--genesis FILE] [--ledger URL]
  set-provider-endpoint --genesis FILE --wallet SEQUENCER_KEY --address ADDRESS (--url URL | --withdraw) [--ledger URL]
Client commands default to the pinned public network and verify its signed operating stage.
Custom genesis files default to http://127.0.0.1:8787. Strata defaults to http://127.0.0.1:8000/v1.`;

const flags = {
  'authorize-sales':['wallet','authority','coins','ledger','genesis'],
  'suspend-sales':['wallet','ledger','genesis'],
  wallet: ['out'],
  genesis: ['wallet','out','allocation','provider','max-output'],
  node: ['genesis','wallet','dir','listen','port'],
  validator: ['genesis','ledger','wallet','origin','dir','listen','port'],
  follower: ['genesis','upstream','dir','listen','port','sync-ms'],
  provider: ['genesis','wallet','ledger','engine','strata','model-id','listen','port'],
  status: ['genesis','ledger'], verify: ['genesis','ledger'],
  routes: ['genesis','ledger','max-output','wallet'],
  balance: ['genesis','ledger','address'],
  transfer: ['genesis','ledger','wallet','to','coins'],
  'issue-reserve': ['genesis','ledger','wallet'],
  'promote-mainnet': ['genesis','ledger','wallet'],
  chat: ['genesis','ledger','wallet','provider-url','provider-address','text','text-file','max-input','max-output',
    'reasoning-effort','reasoning-budget-tokens'],
  settings: ['genesis','ledger','wallet','max-output'],
  'add-provider': ['genesis','ledger','wallet','address','url'],
  'add-validator': ['genesis','ledger','wallet','address'],
  'set-provider-endpoint': ['genesis','ledger','wallet','address','url','withdraw']
};

function required(values, name) {
  const value = values[name];
  if (value === undefined || value === '') throw Error('Missing --' + name);
  return value;
}

function uint(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value))) throw Error('Invalid ' + label);
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < min || num > max) throw Error('Out of range: ' + label);
  return num;
}

function address(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Expected a 64-character public address');
  return value;
}

function endpoint(value) {
  const u = new URL(value);
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) ||
      u.username || u.password || u.search || u.hash) {
    throw Error('Use an HTTPS URL or loopback HTTP URL without credentials, query or fragment');
  }
  return u.href.replace(/\/+$/, '');
}

async function readObject(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeNew(file, obj) {
  await writeFile(file, JSON.stringify(obj, null, 2) + '\n', { flag:'wx', mode:0o600 });
}

async function walletFrom(values) {
  const file = required(values, 'wallet');
  let w;
  if (file === '-') {
    if (process.stdin.isTTY) throw Error('Pipe the wallet JSON on standard input');
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 8192) throw Error('Wallet JSON exceeds 8 KiB');
      chunks.push(chunk);
    }
    w = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } else {
    w = await readObject(file);
  }
  if (address(w.address) !== addressFromPrivateKey(w.privateKey)) throw Error('Wallet key mismatch');
  return w;
}

// Check the transient sequencer acknowledgment without fetching pruned transaction history.
async function submit(ledger, payload, wallet, providerSignature) {
  const tx = { payload, signature:sign(wallet.privateKey, payload) };
  if (providerSignature) tx.providerSignature = providerSignature;
  return submitSignedTransaction(ledger,tx);
}

function nextNonce(state, from) {
  return (state.nonces[from] || 0) + 1;
}

async function chat(v, wallet, ledger, resolveSettlement) {
  const {url:base,state} = ledger;
  if ((v['provider-url'] === undefined) !== (v['provider-address'] === undefined)) {
    throw Error('To pin a provider, supply both --provider-url and --provider-address');
  }
  if ((v.text !== undefined) === (v['text-file'] !== undefined)) throw Error('Supply one of --text and --text-file');
  const prompt = v.text ?? await readFile(v['text-file'],'utf8');
  if (!prompt.trim()) throw Error('Prompt is empty');
  const maxOutputTokens = uint(v['max-output'] ?? Math.min(512,state.maxOutputTokens), 'max-output', 1, state.maxOutputTokens);
  const maxInputTokens = uint(v['max-input'] ?? CONTEXT - maxOutputTokens, 'max-input', 1, CONTEXT - maxOutputTokens);
  const reasoning = {};
  if (v['reasoning-effort'] !== undefined) reasoning.reasoningEffort = reasoningEffort(v['reasoning-effort']);
  if (v['reasoning-budget-tokens'] !== undefined) {
    reasoning.reasoningBudgetTokens = uint(v['reasoning-budget-tokens'],'reasoning-budget-tokens',0,maxOutputTokens);
  }
  validateReasoningOptions({...reasoning,maxOutputTokens});
  const needsReasoning = Object.keys(reasoning).length > 0;
  const cap = charge({ inputTokens:maxInputTokens, cachedTokens:0, outputTokens:maxOutputTokens });
  if (decodeAmount(state.balances[wallet.address] ?? 0) < BigInt(cap)) throw Error('Insufficient balance for authorized token limits');
  let target;
  if (v['provider-address'] !== undefined) {
    target = {provider:address(v['provider-address']),url:endpoint(v['provider-url'])};
    if (!state.providers.includes(target.provider)) throw Error('Provider is absent from trusted chain');
    target.latencyMs = await probeProvider(target,state.chainId,maxOutputTokens,needsReasoning);
  } else {
    const ranked = await rankProviders(state,{payer:wallet.address,ledgerUrl:base,maxOutputTokens,reasoning:needsReasoning});
    target = ranked[0];
    if (!target) throw Error('No available registered provider responded. Check advertised endpoints with routes.');
  }
  const {provider,url} = target;
  const messages = [{role:'user',content:prompt}];
  const request = {
    type:'inference-request', chainId:state.chainId, payer:wallet.address, provider,
    nonce:nextNonce(state,wallet.address), expiresAt:Date.now() + 300_000,
    messagesHash:hash(messages), maxOutputTokens, maxInputTokens,...reasoning
  };
  const { message, payload, providerSignature } = await requestJson(url + '/v1/infer',
    {body:{request, signature:sign(wallet.privateKey,request), messages}, timeoutMs:3_630_000});
  if (message?.role !== 'assistant' ||
      !(typeof message.content === 'string' || (message.content === null && typeof message.reasoning_content === 'string'))) {
    throw Error('Invalid assistant message');
  }
  const inputTokens = uint(payload?.inputTokens,'receipt inputTokens',0,maxInputTokens);
  const cachedTokens = uint(payload.cachedTokens,'receipt cachedTokens',0,inputTokens);
  const outputTokens = uint(payload.outputTokens,'receipt outputTokens',0,maxOutputTokens);
  const expected = {
    type:'inference', chainId:state.chainId, from:wallet.address, provider,
    nonce:request.nonce, model:MODEL, contextWindow:CONTEXT,
    requestHash:hash(request), responseHash:hash(message), inputTokens, cachedTokens, outputTokens
  };
  if (state.networkStage === 'mainnet') {
    if (!kvCacheAtLeastQ8(payload.kvCache)) throw Error('Receipt requires K and V at Q8 or above');
    expected.kvCache = payload.kvCache;
  }
  if (hash(payload) !== hash(expected) || !verify(provider,expected,providerSignature)) throw Error('Invalid provider receipt');
  const targetLedger = resolveSettlement ? await resolveSettlement() : ledger;
  if (nextNonce(targetLedger.state,wallet.address) !== request.nonce) {
    throw Error('Wallet nonce changed during inference; receipt could not be settled');
  }
  const settlement = await submit(targetLedger,expected,wallet,providerSignature);
  return { provider, providerUrl:url, latencyMs:target.latencyMs, reasoning, message,
    usage:{inputTokens,cachedTokens,outputTokens}, coins:formatCoins(charge(expected)), settlement };
}

function print(data) { process.stdout.write(JSON.stringify(data) + '\n'); }

function serving(url, close) {
  print({url});
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    close().catch(e => { console.error(e.message); process.exitCode = 1; });
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}

async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!command || ['--help','-h','help'].includes(command)) return console.log(usage);
  if (!Object.hasOwn(flags,command)) throw Error('Unknown command: ' + command);
  const options = Object.fromEntries(flags[command].map(name =>
    [name,{type:name === 'withdraw' ? 'boolean' : 'string',multiple:command === 'genesis' && ['provider','allocation'].includes(name)}]));
  const {values:v} = parseArgs({args,options});
  if (command === 'wallet') {
    const wallet = generateWallet();
    await writeNew(required(v,'out'),wallet);
    return print({address:wallet.address});
  }
  if (command === 'genesis') {
    const allocations = Object.create(null);
    for (const entry of required(v,'allocation')) {
      const parts = entry.split('=');
      if (parts.length !== 2) throw Error('Expected --allocation ADDRESS=COINS');
      const addr = address(parts[0]);
      if (Object.hasOwn(allocations,addr)) throw Error('Repeated allocation');
      const allocation = parseCoins(parts[1]);
      if (!Number.isSafeInteger(allocation)) throw Error('Genesis allocation exceeds the legacy safe-integer limit');
      allocations[addr] = allocation;
    }
    const providers = (v.provider ?? []).map(address);
    const maxOutputTokens = uint(v['max-output'] ?? CONTEXT,'max-output',1,CONTEXT);
    const genesis = createGenesis(await walletFrom(v),{allocations,providers,maxOutputTokens});
    replay([genesis],genesis.hash);
    await writeNew(required(v,'out'),genesis);
    return print({chainId:genesis.hash});
  }
  if (command === 'node') required(v,'genesis');
  const genesis = v.genesis ? await readObject(v.genesis) : publicGenesis;
  replay([genesis],genesis.hash);
  const publicNetwork = genesis.hash === publicGenesis.hash;
  if (command === 'issue-reserve' && genesis.hash !== DISTRIBUTION_RESERVE.chainId) {
    throw Error('Reserve issuance requires the official public testnet genesis');
  }
  const discover = publicNetwork && v.ledger === undefined;
  const fixed = v.ledger ? endpoint(v.ledger) : 'http://127.0.0.1:8787';
  const listen = v.listen || '127.0.0.1';
  if (command === 'validator') {
    const wallet = await walletFrom(v);
    const origin = normalizeProviderEndpoint(required(v,'origin'));
    const validator = await startValidator({dir:required(v,'dir'),genesis,wallet,origin,listen,
      port:uint(v.port ?? 8790,'port',0,65535),
      discover:async ({instanceId}) => {
        const selected = discover ? await resolvePublicLedger({activation:true}) :
          {checkpoint:await readCheckpoint(fixed,genesis.hash),url:fixed};
        if (selected.checkpoint.authority) return selected.checkpoint;
        return enrollAt(selected.url,genesis.hash,wallet,origin,instanceId);
      }
    });
    return serving(validator.url,() => validator.close());
  }
  if (command === 'node' || command === 'follower') {
    let opts;
    if (command === 'node') {
      if (publicNetwork) throw Error('Run validator to participate in public network consensus');
      opts = {wallet:await walletFrom(v)};
    } else {
      opts = publicNetwork && !v.upstream
        ? {resolveUpstreamCheckpoint:async () => (await resolvePublicLedger()).checkpoint}
        : {upstream:endpoint(required(v,'upstream'))};
      opts.syncIntervalMs = uint(v['sync-ms'] ?? 5000,'sync-ms',100,3600000);
    }
    const node = await startNode({dir:required(v,'dir'),genesis,...opts,listen,
      port:uint(v.port ?? (command === 'node' ? 8787 : 8788),'port',0,65535)});
    return serving(node.url,() => node.close());
  }
  if (command === 'provider') {
    const port = uint(v.port ?? 8789,'port',0,65535);
    const srv = await createProviderServer({
      wallet:await walletFrom(v), chainId:genesis.hash, ledgerUrl:fixed,
      readState:discover ? async () => (await resolvePublicLedger({write:true})).state : readVerifiedState,
      strataUrl:endpoint(v.strata || 'http://127.0.0.1:8000/v1'),
      engine:v.engine,modelId:v['model-id'],apiKey:process.env.STRATA_API_KEY
    });
    srv.listen(port,listen);
    await once(srv,'listening');
    const host = listen.includes(':') ? '[' + listen + ']' : listen;
    return serving(`http://${host}:${srv.address().port}`,() => new Promise((resolve,reject) =>
      srv.close(err => err ? reject(err) : resolve())));
  }
  const write = !['verify','status','routes','balance'].includes(command);
  const ledger = discover ? await resolvePublicLedger({write}) :
    {url:fixed,checkpoint:await readCheckpoint(fixed,genesis.hash)};
  const {url:base,checkpoint} = ledger;
  const state = ledger.state = checkpoint.state;
  if (command === 'routes') {
    const maxOutputTokens = uint(v['max-output'] ?? 1,'max-output',1,state.maxOutputTokens);
    const payer = v.wallet ? (await walletFrom(v)).address : undefined;
    return print({providers:await rankProviders(state,{payer,ledgerUrl:base,maxOutputTokens})});
  }
  if (command === 'verify') return print({verified:true,scope:checkpoint.authority ? 'validator-consensus' : 'signed-checkpoint',
    chainId:state.chainId,networkId:state.networkId,networkStage:state.networkStage ?? null,height:state.height,tip:state.tip});
  if (command === 'status') {
    const {chainId,height,tip,epoch,epochTokens,totalWorkTokens,maxOutputTokens,pendingMaxOutputTokens,providers} = state;
    return print({chainId,networkId:state.networkId,networkStage:state.networkStage ?? null,height,tip,epoch,epochTokens,epochSizeTokens:EPOCH_TOKENS,totalWorkTokens,
      maxOutputTokens,pendingMaxOutputTokens,providers,validatorAddresses:state.validatorAddresses ?? [],consensus:checkpoint.authority
        ? {mode:'validator',threshold:2,validators:checkpoint.authority.payload.validators}
        : {mode:'bootstrap'}});
  }
  if (command === 'balance') {
    const addr = address(required(v,'address'));
    return print({address:addr,coins:formatCoins(state.balances[addr] ?? 0),nonce:state.nonces[addr] || 0});
  }
  const wallet = await walletFrom(v);
  if (command==='promote-mainnet') {
    if (wallet.address!==MAINNET.issuer || genesis.hash!==MAINNET.chainId || checkpoint.authority) {
      throw Error('Promotion requires the original public chain and bootstrap signer before validator activation');
    }
    return print(await submit(ledger,mainnetPromotionPayload(state),wallet));
  }
  if (command === 'chat') return print(await chat(v,wallet,ledger,
    discover ? () => resolvePublicLedger({write:true}) : undefined));
  const common = {chainId:state.chainId,from:wallet.address,nonce:nextNonce(state,wallet.address)};
  let details;
  if (command === 'transfer') {
    details = {to:address(required(v,'to')),amount:parseCoins(required(v,'coins'))};
  } else if (command === 'authorize-sales' || command === 'suspend-sales') {
    if (state.chainId!==DISTRIBUTION_RESERVE.chainId || wallet.address!==DISTRIBUTION_RESERVE.address) {
      throw Error('The official reserve wallet is required to change the sale mandate');
    }
    details=command==='authorize-sales' ? {authority:address(required(v,'authority')),cap:parseCoins(required(v,'coins')),terms:SALE_TERMS} : {};
  } else if (command === 'issue-reserve') {
    if (wallet.address !== genesis.payload.sequencer) throw Error('The genesis sequencer wallet must authorize reserve issuance');
    if (state.reserveClaim) throw Error('Public testnet reserve already issued');
    const {address:to,amount,claim} = DISTRIBUTION_RESERVE;
    details = {to,amount,claim};
  } else if (command === 'add-provider') {
    details = {provider:address(required(v,'address'))};
    if (v.url !== undefined) details.endpoint = normalizeProviderEndpoint(v.url);
  } else if (command === 'add-validator') {
    details = {validator:address(required(v,'address'))};
  } else if (command === 'set-provider-endpoint') {
    if (Boolean(v.withdraw) === (v.url !== undefined)) throw Error('Supply one of --url and --withdraw');
    details = {provider:address(required(v,'address')),endpoint:v.withdraw ? null : normalizeProviderEndpoint(v.url)};
  } else {
    details = {maxOutputTokens:uint(required(v,'max-output'),'max-output',1,CONTEXT)};
  }
  print(await submit(ledger,{type:command,...common,...details},wallet));
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
