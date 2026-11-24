#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { addressFromPrivateKey, generateWallet, sign, verify, hash } from './crypto.mjs';
import { applyBlock, charge, CONTEXT, createGenesis, EPOCH_TOKENS, MODEL, replay, verifyBlock } from './ledger.mjs';
import { readVerifiedState, startNode } from './node.mjs';
import { createProviderServer } from './provider.mjs';
import { requestJson } from './http.mjs';
import { rankProviders } from './routing.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

const usage = `GPUChain
  wallet   --out FILE
  genesis  --wallet SEQUENCER_KEY --out FILE --allocation ADDRESS=COINS
           [--allocation ADDRESS=COINS ...] [--provider ADDRESS ...] [--max-output N]
  node     --genesis FILE --wallet SEQUENCER_KEY --dir DIR [--listen HOST] [--port 8787]
  follower --genesis FILE --upstream URL --dir DIR [--listen HOST] [--port 8788]
  provider --genesis FILE --wallet PROVIDER_KEY [--ledger URL] [--strata URL] [--model-id ID]
           [--listen HOST] [--port 8789]   (optional backend credential: STRATA_API_KEY)
  status | verify   --genesis FILE [--ledger URL]
  balance  --genesis FILE --address ADDRESS [--ledger URL]
  transfer --genesis FILE --wallet KEY --to ADDRESS --coins DECIMAL [--ledger URL]
  routes   --genesis FILE [--ledger URL] [--max-output N] [--wallet KEY]
  chat     --genesis FILE --wallet KEY [--provider-url URL --provider-address ADDRESS]
           (--text PROMPT | --text-file FILE) [--max-input N] [--max-output N] [--ledger URL]
  settings --genesis FILE --wallet SEQUENCER_KEY --max-output N [--ledger URL]
  add-provider --genesis FILE --wallet SEQUENCER_KEY --address ADDRESS [--url URL] [--ledger URL]
  set-provider-endpoint --genesis FILE --wallet SEQUENCER_KEY --address ADDRESS (--url URL | --withdraw) [--ledger URL]
Ledger defaults to http://127.0.0.1:8787. Strata defaults to http://127.0.0.1:8000/v1.`;

const flags = {
  wallet: ['out'],
  genesis: ['wallet','out','allocation','provider','max-output'],
  node: ['genesis','wallet','dir','listen','port'],
  follower: ['genesis','upstream','dir','listen','port','sync-ms'],
  provider: ['genesis','wallet','ledger','strata','model-id','listen','port'],
  status: ['genesis','ledger'], verify: ['genesis','ledger'],
  routes: ['genesis','ledger','max-output','wallet'],
  balance: ['genesis','ledger','address'],
  transfer: ['genesis','ledger','wallet','to','coins'],
  chat: ['genesis','ledger','wallet','provider-url','provider-address','text','text-file','max-input','max-output'],
  settings: ['genesis','ledger','wallet','max-output'],
  'add-provider': ['genesis','ledger','wallet','address','url'],
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

function nanocoins(value) {
  if (!/^\d{1,16}(?:\.\d{1,9})?$/.test(value)) throw Error('Use a positive coin amount with up to nine decimal places');
  const [left, right = ''] = value.split('.');
  const n = BigInt(left) * 1000000000n + BigInt(right.padEnd(9, '0'));
  if (n <= 0 || n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Coin amount out of range');
  return Number(n);
}

function coins(n) {
  const units = BigInt(n);
  const fraction = String(units % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return String(units / 1000000000n) + (fraction ? '.' + fraction : '');
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
async function submit(base, state, payload, wallet, providerSignature) {
  const tx = { payload, signature:sign(wallet.privateKey, payload) };
  if (providerSignature) tx.providerSignature = providerSignature;
  const { block } = await requestJson(base + '/v1/transactions', {body:tx});
  if (!block || hash(block.payload) !== hash(tx) || !Number.isSafeInteger(block.height) ||
      block.height <= state.height) throw Error('Ledger returned an unexpected transaction');
  if (block.height === state.height + 1) {
    applyBlock(state,block);
  } else {
    verifyBlock(block,state.sequencer);
  }
  return { height:block.height, hash:block.hash };
}

function nextNonce(state, from) {
  return (state.nonces[from] || 0) + 1;
}

async function chat(v, wallet, base, state) {
  if ((v['provider-url'] === undefined) !== (v['provider-address'] === undefined)) {
    throw Error('To pin a provider, supply both --provider-url and --provider-address');
  }
  if ((v.text !== undefined) === (v['text-file'] !== undefined)) throw Error('Supply one of --text and --text-file');
  const prompt = v.text ?? await readFile(v['text-file'],'utf8');
  if (!prompt.trim()) throw Error('Prompt is empty');
  const maxOutputTokens = uint(v['max-output'] ?? Math.min(512,state.maxOutputTokens), 'max-output', 1, state.maxOutputTokens);
  const maxInputTokens = uint(v['max-input'] ?? CONTEXT - maxOutputTokens, 'max-input', 1, CONTEXT - maxOutputTokens);
  const cap = charge({ inputTokens:maxInputTokens, cachedTokens:0, outputTokens:maxOutputTokens });
  if ((state.balances[wallet.address] || 0) < cap) throw Error('Insufficient balance for authorized token limits');
  let target;
  if (v['provider-address'] !== undefined) {
    target = {provider:address(v['provider-address']),url:endpoint(v['provider-url'])};
    if (!state.providers.includes(target.provider)) throw Error('Provider is absent from trusted chain');
  } else {
    const ranked = await rankProviders(state,{payer:wallet.address,ledgerUrl:base,maxOutputTokens});
    target = ranked[0];
    if (!target) throw Error('No available registered provider responded. Check advertised endpoints with routes.');
  }
  const {provider,url} = target;
  const messages = [{role:'user',content:prompt}];
  const request = {
    type:'inference-request', chainId:state.chainId, payer:wallet.address, provider,
    nonce:nextNonce(state,wallet.address), expiresAt:Date.now() + 300_000,
    messagesHash:hash(messages), maxOutputTokens, maxInputTokens
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
  if (hash(payload) !== hash(expected) || !verify(provider,expected,providerSignature)) throw Error('Invalid provider receipt');
  const settlement = await submit(base,state,expected,wallet,providerSignature);
  return { provider, providerUrl:url, latencyMs:target.latencyMs, message,
    usage:{inputTokens,cachedTokens,outputTokens}, coins:coins(charge(expected)), settlement };
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
      allocations[addr] = nanocoins(parts[1]);
    }
    const providers = (v.provider ?? []).map(address);
    const maxOutputTokens = uint(v['max-output'] ?? CONTEXT,'max-output',1,CONTEXT);
    const genesis = createGenesis(await walletFrom(v),{allocations,providers,maxOutputTokens});
    replay([genesis],genesis.hash);
    await writeNew(required(v,'out'),genesis);
    return print({chainId:genesis.hash});
  }
  const genesis = await readObject(required(v,'genesis'));
  replay([genesis],genesis.hash);
  const base = endpoint(v.ledger || 'http://127.0.0.1:8787');
  const listen = v.listen || '127.0.0.1';
  if (command === 'node' || command === 'follower') {
    const opts = command === 'node' ? {wallet:await walletFrom(v)} :
      {upstream:endpoint(required(v,'upstream')),syncIntervalMs:uint(v['sync-ms'] ?? 5000,'sync-ms',100,3600000)};
    const node = await startNode({dir:required(v,'dir'),genesis,...opts,listen,
      port:uint(v.port ?? (command === 'node' ? 8787 : 8788),'port',0,65535)});
    return serving(node.url,() => node.close());
  }
  if (command === 'provider') {
    const port = uint(v.port ?? 8789,'port',0,65535);
    const srv = await createProviderServer({
      wallet:await walletFrom(v), chainId:genesis.hash, ledgerUrl:base,
      strataUrl:endpoint(v.strata || 'http://127.0.0.1:8000/v1'),
      modelId:v['model-id'],apiKey:process.env.STRATA_API_KEY
    });
    srv.listen(port,listen);
    await once(srv,'listening');
    const host = listen.includes(':') ? '[' + listen + ']' : listen;
    return serving(`http://${host}:${srv.address().port}`,() => new Promise((resolve,reject) =>
      srv.close(err => err ? reject(err) : resolve())));
  }
  const state = await readVerifiedState(base,genesis.hash);
  if (command === 'routes') {
    const maxOutputTokens = uint(v['max-output'] ?? 1,'max-output',1,state.maxOutputTokens);
    const payer = v.wallet ? (await walletFrom(v)).address : undefined;
    return print({providers:await rankProviders(state,{payer,ledgerUrl:base,maxOutputTokens})});
  }
  if (command === 'verify') return print({verified:true,scope:'signed-checkpoint',chainId:state.chainId,height:state.height,tip:state.tip});
  if (command === 'status') {
    const {chainId,height,tip,epoch,epochTokens,totalWorkTokens,maxOutputTokens,pendingMaxOutputTokens,providers} = state;
    return print({chainId,height,tip,epoch,epochTokens,epochSizeTokens:EPOCH_TOKENS,totalWorkTokens,
      maxOutputTokens,pendingMaxOutputTokens,providers});
  }
  if (command === 'balance') {
    const addr = address(required(v,'address'));
    return print({address:addr,coins:coins(state.balances[addr] || 0),nonce:state.nonces[addr] || 0});
  }
  const wallet = await walletFrom(v);
  if (command === 'chat') return print(await chat(v,wallet,base,state));
  const common = {chainId:state.chainId,from:wallet.address,nonce:nextNonce(state,wallet.address)};
  let details;
  if (command === 'transfer') {
    details = {to:address(required(v,'to')),amount:nanocoins(required(v,'coins'))};
  } else if (command === 'add-provider') {
    details = {provider:address(required(v,'address'))};
    if (v.url !== undefined) details.endpoint = normalizeProviderEndpoint(v.url);
  } else if (command === 'set-provider-endpoint') {
    if (Boolean(v.withdraw) === (v.url !== undefined)) throw Error('Supply one of --url and --withdraw');
    details = {provider:address(required(v,'address')),endpoint:v.withdraw ? null : normalizeProviderEndpoint(v.url)};
  } else {
    details = {maxOutputTokens:uint(required(v,'max-output'),'max-output',1,CONTEXT)};
  }
  print(await submit(base,state,{type:command,...common,...details},wallet));
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
