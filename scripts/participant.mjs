#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { requestJson } from '../src/http.mjs';
import { participantDir } from '../src/participant-config.mjs';
import { protectFile } from '../src/private-file.mjs';

const directory = participantDir();
const descriptor = join(directory,'process.json');
const lockFile = join(directory,'process-lock.sqlite');
const script = fileURLToPath(import.meta.url);
const startupLimit = 60_000;

// The OS releases the SQLite lock on exit, even after a hard crash.
function tryLock() {
  const db = new DatabaseSync(lockFile);
  try {
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (err) {
    db.close();
    if (err.errcode === 5) return null;
    throw err;
  }
}

function active() {
  if (!existsSync(lockFile)) return false;
  const lock = tryLock();
  if (!lock) return true;
  lock.close();
  return false;
}

function mac(key,fields) {
  return createHmac('sha256',key).update(JSON.stringify(fields)).digest('hex');
}

function equalMac(actual,expected) {
  return typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}

// Authenticate both ends. A stale port or a recycled PID cannot operate on
// another service. The file's secret never travels in a URL or request.
async function control(op) {
  const {port,key} = JSON.parse(readFileSync(descriptor,'utf8'));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(key)) {
    throw Error('Invalid participant process descriptor');
  }
  const nonce = randomBytes(16).toString('hex');
  const issued=String(Date.now());
  const proof=op==='unlock' ? ['request',op,nonce,issued] : ['request',op,nonce];
  const reply = await requestJson('http://127.0.0.1:'+port+'/'+op,{
    method:'POST',headers:{'x-gpuchain-nonce':nonce,'x-gpuchain-auth':mac(key,proof),'x-gpuchain-time':issued},
    timeoutMs:op === 'stop' ? startupLimit : 5000,maxBytes:32768
  });
  if (!equalMac(reply.auth,mac(key,['response',op,nonce,reply.state]))) {
    throw Error('Participant process identity could not be verified');
  }
  return reply.state;
}

function announce(message) {
  if (process.connected) process.send(message, () => {
    if (process.connected) process.disconnect();
  });
}

async function daemon() {
  const lock = tryLock();
  if (!lock) return announce({busy:true});
  const key = randomBytes(32).toString('hex');
  const temp = descriptor+'.'+randomBytes(8).toString('hex')+'.tmp';
  let node, starting, closing, published = false;
  const unlockNonces=new Map();
  async function state() {
    if (!node) return {running:true,starting:true,pid:process.pid};
    const s = await requestJson(node.url+'/v1/status',{timeoutMs:4000});
    if (!s.chainId || !s.address || !s.instanceId) throw Error('Local validator identity unavailable');
    // Return local status only. The complete provider registry may be large.
    const {providers,...summary} = s;
    return {...summary,running:true,url:node.url,guiUrl:node.guiUrl,openAiUrl:node.openAiUrl,
      openAiError:node.openAiError,pid:process.pid};
  }

  const server = createServer(async (req,res) => {
    const op = req.url?.slice(1);
    const nonce = req.headers['x-gpuchain-nonce'];
    const issued=req.headers['x-gpuchain-time'];
    const proof=op==='unlock' ? ['request',op,nonce,issued] : ['request',op,nonce];
    if (req.method !== 'POST' || !['status','stop','unlock','opencode'].includes(op) || typeof nonce !== 'string' ||
        !/^[a-f0-9]{32}$/.test(nonce) || !equalMac(req.headers['x-gpuchain-auth'],mac(key,proof))) {
      res.writeHead(403); res.end(); return;
    }
    try {
      let result;
      if (op==='unlock') {
        const now=Date.now();
        for (const [n,until] of unlockNonces) if(until<=now) unlockNonces.delete(n);
        if (!/^[0-9]{13}$/.test(issued) || Math.abs(now-Number(issued))>=10_000 ||
          unlockNonces.has(nonce) || unlockNonces.size>=32 || req.headers.origin || req.headers.forwarded ||
          Object.keys(req.headers).some(k=>k.startsWith('x-forwarded-'))) {
          res.writeHead(403); res.end(); return;
        }
        unlockNonces.set(nonce,now+21_000);
        if (!node || closing || !node.issueUnlock) { res.writeHead(503);res.end('Wallet unavailable');return; }
        result={...node.issueUnlock(),guiUrl:node.guiUrl};
      } else if (op==='opencode') {
        if (!node || closing || req.headers.origin || req.headers.forwarded ||
            Object.keys(req.headers).some(k=>k.startsWith('x-forwarded-'))) {
          res.writeHead(403); res.end(); return;
        }
        try { result={openAiUrl:await node.enableOpenAi()}; }
        catch { result={openAiUrl:null,error:node.openAiError ?? 'Missing local inference token'}; }
      } else result = op === 'stop' ? await stop() : await state();
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','connection':'close'});
      res.end(JSON.stringify({state:result,auth:mac(key,['response',op,nonce,result])}));
    } catch {
      res.writeHead(503); res.end('Participant control unavailable');
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.maxConnections = 16;

  function stop() {
    if (closing) return closing;
    closing = (async () => {
      server.close();
      try {
        await starting?.catch(()=>{});
        await node?.close();
      } finally {
        try {
          if (published) rmSync(descriptor,{force:true});
          rmSync(temp,{force:true});
        } finally { lock.close(); }
      }
      return {running:false};
    })();
    return closing;
  }

  try {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    writeFileSync(temp,'',{flag:'wx',mode:0o600});
    await protectFile(temp);
    writeFileSync(temp,JSON.stringify({pid:process.pid,port:server.address().port,key}));
    renameSync(temp,descriptor);
    published = true;
    process.once('SIGINT',()=>stop().catch(()=>{process.exitCode=1;}));
    process.once('SIGTERM',()=>stop().catch(()=>{process.exitCode=1;}));
    const {startParticipant} = await import('./participate.mjs');
    if (closing) return announce({error:'Participant stopped during startup'});
    starting = startParticipant();
    node = await starting;
    if (closing) return announce({error:'Participant stopped during startup'});
    announce({state:await state()});
  } catch (err) {
    await stop();
    announce({error:err.message});
  }
}

async function launch() {
  const child = spawn(process.execPath,[script,'--daemon'],{
    detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']
  });
  child.unref();
  try {
    return await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(Error('Participant startup timed out; use status to inspect it')),startupLimit);
      function finish(fn,value) { clearTimeout(timer); fn(value); }
      child.once('message',reply=>finish(resolve,reply));
      child.once('error',err=>finish(reject,err));
      child.once('exit',code=>finish(reject,Error('Participant exited during startup ('+code+')')));
    });
  } finally {
    if (child.connected) child.disconnect();
  }
}

async function manage(op) {
  if (op==='opencode') {
    if (!active()) throw Error('Start the participant to enable its local inference gateway');
    const state=await control(op);
    if (!state.openAiUrl) throw Error(state.error ?? 'Local inference unavailable');
    return state;
  }
  if (op==='unlock') {
    if (!active()) throw Error('Start the managed GPUChain wallet before unlocking');
    return control('unlock');
  }
  if (op === 'start') mkdirSync(directory,{recursive:true,mode:0o700});
  const deadline = Date.now()+startupLimit;
  do {
    if (!active()) {
      if (op !== 'start') return {running:false};
      const reply = await launch();
      if (reply.error) throw Error(reply.error);
      if (reply.state) return reply.state;
    } else {
      try {
        const state = await control(op === 'stop' ? 'stop' : 'status');
        if (op !== 'start' || !state.starting) return state;
      } catch (err) {
        // Another invocation can own the lock briefly before publishing its
        // control port, or be closing it while a new command is issued.
        if (op === 'status' && Date.now()+250 >= deadline) throw err;
      }
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw Error('Could not confirm participant state before timeout');
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw Error('Usage: node scripts/participant.mjs start|status|stop|unlock|opencode');
  const command = args[0] ?? 'start';
  if (command === '--daemon' && process.send) await daemon();
  else if (['start','status','stop','unlock','opencode'].includes(command)) console.log(JSON.stringify(await manage(command)));
  else throw Error('Usage: node scripts/participant.mjs start|status|stop|unlock|opencode');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
