import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { generateWallet, hash, sign } from '../src/crypto.mjs';
import { createGenesis, MODEL, CONTEXT } from '../src/ledger.mjs';
import { requestJson } from '../src/http.mjs';
import { resolvePublicLedger } from '../src/public-network.mjs';
import { readCheckpoint, startNode } from '../src/node.mjs';
import { verifyConsensusAck } from '../src/consensus.mjs';
import { createLedgerWorker } from '../hosting/sites/worker.mjs';
import { nextDirectory } from '../scripts/sync-testnet-directory.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs',import.meta.url));

test('a fresh client settles on independent peers after automatic opt-in, seed publication and loss of Sites', {timeout:30_000}, async t => {
  const root = await mkdtemp(join(tmpdir(),'gpuchain-community-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ledger_head(id INTEGER PRIMARY KEY,tip TEXT NOT NULL,checkpoint TEXT NOT NULL)');
  const sql = {withSession() { return this; },prepare(query) {
    const stmt = db.prepare(query);
    let args = [];
    return {bind(...values) {args=values;return this;},
      async first() {return stmt.get(...args) ?? null;},async run() {return {meta:{changes:stmt.run(...args).changes}};}};
  }};
  const operator = generateWallet(), buyer = generateWallet();
  const voters = Array.from({length:3},generateWallet);
  const genesis = createGenesis(operator,{allocations:{[buyer.address]:1_000_000_000},providers:voters.map(v=>v.address)});
  const env = {DB:sql,GPUCHAIN_GENESIS_JSON:JSON.stringify(genesis),GPUCHAIN_SIGNER_PKCS8:operator.privateKey};
  let directory = {chainId:genesis.hash,endpoints:[]};
  const worker = createLedgerWorker({allowLoopback:true,readDirectory:async()=>directory});
  const issuer = createServer(async (req,res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const reply = await worker.fetch(new Request('http://bootstrap.invalid'+req.url,{
        method:req.method,headers:req.headers,body:chunks.length ? Buffer.concat(chunks) : undefined
      }),env);
      res.writeHead(reply.status,Object.fromEntries(reply.headers));
      res.end(await reply.text());
    } catch { res.writeHead(500);res.end(); }
  });
  const nodes = [], replicas = [];
  t.after(async () => {
    await Promise.all([...nodes,...replicas].map(n=>n?.close()));
    if (issuer.listening) await new Promise(r=>issuer.close(r));
    db.close();
    await rm(root,{recursive:true,force:true});
  });
  issuer.listen(0,'127.0.0.1');
  await once(issuer,'listening');
  const bootstrap = 'http://127.0.0.1:'+issuer.address().port;
  directory.endpoints.push(bootstrap);
  const first = {type:'transfer',chainId:genesis.hash,from:buyer.address,to:voters[0].address,nonce:1,amount:101};
  await requestJson(bootstrap+'/v1/transactions',{body:{payload:first,signature:sign(buyer.privateKey,first)}});
  const genesisFile = join(root,'genesis.json'), userFile = join(root,'buyer.json');
  await writeFile(genesisFile,JSON.stringify(genesis));
  await writeFile(userFile,JSON.stringify(buyer),{mode:0o600});
  for (const [i,wallet] of voters.entries()) {
    const walletFile = join(root,'validator-'+i+'.json');
    await writeFile(walletFile,JSON.stringify(wallet),{mode:0o600});
    const reservation = createServer();
    reservation.listen(0,'127.0.0.1');
    await once(reservation,'listening');
    const port = reservation.address().port;
    await new Promise(r=>reservation.close(r));
    const url = 'http://127.0.0.1:'+port;
    const proc = spawn(process.execPath,[cli,'validator','--dir',join(root,'voter'+i),'--wallet',walletFile,
      '--genesis',genesisFile,'--origin',url,'--port',String(port),'--ledger',bootstrap],
    {stdio:['ignore','pipe','pipe'],windowsHide:true});
    let error = '';
    proc.stderr.on('data',chunk=>{error+=chunk;});
    const exited = once(proc,'exit');
    nodes.push({url,async close() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
    }});
    const lines = createInterface({input:proc.stdout});
    const [line] = await Promise.race([once(lines,'line'),exited.then(()=>{throw Error('Validator exited: '+error);})]);
    assert.equal(JSON.parse(line).url,url);
    lines.close();
  }
  assert.equal((await requestJson(bootstrap+'/v1/status')).mode,'sequencer');
  // Exercise the very same discovery publication code that GitHub Actions uses.
  directory = await nextDirectory(directory,{bootstrap,pin:genesis,allowLoopback:true});
  for (const node of nodes) assert.ok(directory.endpoints.includes(node.url));
  for (let attempt=0;attempt<80;attempt++) {
    const states = await Promise.all(nodes.map(n=>requestJson(n.url+'/v1/status')));
    if (states.every(s=>s.mode === 'validator')) break;
    await delay(125);
  }
  assert.equal((await requestJson(bootstrap+'/v1/status')).mode,'retired');
  const anchor = await readCheckpoint(bootstrap,genesis.hash);
  assert.equal(anchor.state.height,1);
  assert.equal(anchor.state.balances[voters[0].address],101);
  await assert.rejects(requestJson(bootstrap+'/v1/transactions',{body:{}}),/409/);
  await new Promise(r=>issuer.close(r));
  await nodes[0].close();
  nodes[0] = null;
  const discover = () => resolvePublicLedger({chainId:genesis.hash,directory,cacheDir:join(root,'fresh-client'),
    seeds:'',write:true,refresh:null});
  const chosen = await discover();
  assert.equal(chosen.mode,'validator');
  const replicaDir = join(root,'reader');
  const replica = await startNode({dir:replicaDir,genesis,port:0,syncIntervalMs:60_000,
    resolveUpstreamCheckpoint:async()=>(await discover()).checkpoint});
  replicas.push(replica);
  const {stdout} = await exec(process.execPath,[cli,'transfer','--genesis',genesisFile,'--ledger',chosen.url,
    '--wallet',userFile,'--to',voters[1].address,'--coins','0.000000003'],{windowsHide:true});
  assert.equal(JSON.parse(stdout).height,2);

  const usage = {type:'inference',chainId:genesis.hash,from:buyer.address,provider:voters[1].address,nonce:3,
    model:MODEL,contextWindow:CONTEXT,requestHash:hash('prompt'),responseHash:hash('answer'),
    inputTokens:64,cachedTokens:32,outputTokens:10};
  const tx = {payload:usage,signature:sign(buyer.privateKey,usage),providerSignature:sign(voters[1].privateKey,usage)};
  const ack = await requestJson(chosen.url+'/v1/transactions',{body:tx});
  assert.ok(verifyConsensusAck(ack,tx,genesis,anchor.authority));
  assert.equal(ack.checkpoint.state.balances[voters[1].address],10_015);
  assert.equal(ack.checkpoint.state.epochTokens,42);
  await replica.sync();
  await replica.close();
  const reopened = await startNode({dir:replicaDir,genesis,port:0,upstream:chosen.url});
  replicas.push(reopened);
  const persisted = await readCheckpoint(reopened.url,genesis.hash);
  assert.equal(persisted.state.tip,ack.block.hash);
  assert.equal(persisted.state.nonces[buyer.address],3);
});
