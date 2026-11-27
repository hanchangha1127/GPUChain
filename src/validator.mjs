import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticate, checkpointHttp, verifyAdvance } from './checkpoint.mjs';
import { fetchSignedCheckpoint } from './checkpoint-fetch.mjs';
import { certify, consensusCandidate, votePayload } from './consensus.mjs';
import { addressFromPrivateKey, hash, sign, verify } from './crypto.mjs';
import { requestJson } from './http.mjs';
import { canValidate, EPOCH_TOKENS, MAINNET, replay } from './ledger.mjs';
import { isLoopbackEndpoint, normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { SALE_PRICE_TERMS, SALE_TERMS } from './sale-policy.mjs';
import { LEGACY_STARTER_GRANT_PROTOCOL, STARTER_GRANT_PROTOCOL } from './starter-grants.mjs';
import { localRelay } from './local-relay.mjs';
import { outcomeRoute, quorumOutcome } from './transaction-outcome.mjs';
import { openOutcomes } from './local-outcomes.mjs';

const MAX_CHECKPOINT = 64 * 1024 * 1024;
const MAX_TX = 16_384;
const HEX = /^[0-9a-f]{64}$/;
const phaseDomain = phase => 'gpuchain/paxos-' + phase + '/v1';

class ProtocolError extends Error {
  constructor(status,message) { super(message); this.status = status; }
}

function need(ok, status, message) {
  if (!ok) throw new ProtocolError(status,message);
}

function checkBallot(ballot) {
  need(Number.isSafeInteger(ballot?.round) && ballot.round > 0 &&
    typeof ballot.proposer === 'string' && HEX.test(ballot.proposer),400,'Invalid ballot');
}

function compare(a,b) {
  if (!b) return 1;
  if (a.round !== b.round) return a.round < b.round ? -1 : 1;
  return a.proposer === b.proposer ? 0 : a.proposer < b.proposer ? -1 : 1;
}

const encode = value => JSON.stringify(value);
const decode = value => value === null ? null : JSON.parse(value);

async function body(req,limit) {
  need(req.headers['content-type']?.split(';')[0].trim() === 'application/json',415,'Expected application/json');
  need(Number(req.headers['content-length'] ?? 0) <= limit,413,'Body too large');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    need(length <= limit,413,'Body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProtocolError(400,'Malformed JSON'); }
}

// An exclusive process lock protects the acceptor identity. Each promise and vote
// is durable before replying. A chosen checkpoint atomically replaces slot data.
function open(dir,genesis,wallet) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  const lock = new DatabaseSync(join(dir,'validator-lock.sqlite'));
  let db;
  try {
    lock.exec('BEGIN EXCLUSIVE');
    db = new DatabaseSync(join(dir,'validator.sqlite'));
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS voter(
        id INTEGER PRIMARY KEY CHECK(id=1), chain_id TEXT NOT NULL, address TEXT NOT NULL, instance TEXT NOT NULL,
        clock INTEGER NOT NULL DEFAULT 0, head TEXT, promised TEXT, accepted TEXT
      );
    `);
    db.prepare('INSERT OR IGNORE INTO voter(id,chain_id,address,instance) VALUES(1,?,?,?)')
      .run(genesis.hash,wallet.address,randomUUID());
    const row = db.prepare('SELECT chain_id,address,instance,head FROM voter WHERE id=1').get();
    need(row.chain_id === genesis.hash && row.address === wallet.address,409,'Wrong validator wallet or genesis for database');
    const outcomes=openOutcomes(db);
    return {
      checkpoint:decode(row.head),
      findOutcome:outcomes.find,
      instanceId:row.instance,
      slot() {
        const s = db.prepare('SELECT promised, accepted FROM voter WHERE id=1').get();
        return {promised:decode(s.promised),accepted:decode(s.accepted)};
      },
      nextBallot() {
        const {clock} = db.prepare('UPDATE voter SET clock=clock+1 WHERE id=1 RETURNING clock').get();
        const ballot = {round:clock,proposer:wallet.address};
        checkBallot(ballot);
        return ballot;
      },
      observe(round) { db.prepare('UPDATE voter SET clock=max(clock,?) WHERE id=1').run(round); },
      promise(ballot) {
        db.prepare('UPDATE voter SET promised=?,clock=max(clock,?) WHERE id=1').run(encode(ballot),ballot.round);
      },
      accept(ballot,tx) {
        db.prepare('UPDATE voter SET promised=?,accepted=?,clock=max(clock,?) WHERE id=1')
          .run(encode(ballot),encode({ballot,tx}),ballot.round);
      },
      commit(checkpoint) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE voter SET head=?,promised=NULL,accepted=NULL WHERE id=1').run(encode(checkpoint));
          if (checkpoint.consensus) outcomes.save(checkpoint.state.height,quorumOutcome(checkpoint));
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK'); throw error; }
      },
      close() { try { db.close(); } finally { lock.close(); } }
    };
  } catch (err) {
    db?.close();
    lock.close();
    throw err;
  }
}

export async function startValidator({dir,genesis,wallet,origin,port=8790,listen='127.0.0.1',
  checkpoint,discover,monitor,syncIntervalMs=5000,peerTimeoutMs=2000}) {
  replay([genesis],genesis.hash);
  need(addressFromPrivateKey(wallet.privateKey) === wallet.address,400,'Validator wallet does not match address');
  const publicOrigin = origin && normalizeProviderEndpoint(origin);
  const store = open(dir,genesis,wallet);
  const relay = localRelay(dir);
  let head, members = [], keys = new Set(), authorityHash;
  let busy = false, closed = false, syncing, timer, url, lastSyncError = null;
  let voting = false, lastVerifiedAt = null, ledgerUrl = null, enrollmentError = null;
  let advertised = publicOrigin;
  const quorum = () => Math.floor(members.length / 2) + 1;
  const signed = payload => ({address:wallet.address,payload,signature:sign(wallet.privateKey,payload)});
  const session = () => ({chainId:genesis.hash,authorityHash,height:head.state.height+1,previousHash:head.state.tip});

  function enrollmentStatus() {
    if (voting) return 'voting';
    if (!head) return 'waiting-for-checkpoint';
    if (head.authority) {
      return members.some(v => v.address === wallet.address) ? 'identity-mismatch' : 'committee-fixed';
    }
    if (!publicOrigin || isLoopbackEndpoint(publicOrigin)) return 'needs-public-origin';
    if (!canValidate(head.state,wallet.address)) return 'needs-registration';
    return 'candidate';
  }

  function install(candidate, persisted=false) {
    authenticate(candidate,genesis.hash);
    const validators = candidate.authority?.payload.validators ?? [];
    const member = validators.some(v => v.address === wallet.address && v.url === advertised &&
      v.instanceId === store.instanceId);
    need(monitor || member,403,'Wallet, origin or durable voting database does not match the activated roster');
    if (head) {
      verifyAdvance(head,candidate);
      // Preserve promises and votes for the next slot when refreshing the same certified state.
      if (head.state.tip === candidate.state.tip && Boolean(head.authority) === Boolean(candidate.authority)) {
        lastVerifiedAt = new Date().toISOString();
        return false;
      }
    }
    if (!persisted) store.commit(candidate);
    head = candidate;
    members = validators;
    keys = new Set(members.map(v => v.address));
    authorityHash = candidate.authority && hash(candidate.authority);
    voting = member;
    lastVerifiedAt = new Date().toISOString();
    if (head.authority) enrollmentError = null;
    return true;
  }

  async function callPeers(task) {
    const all = await Promise.allSettled(members.map(task));
    return all.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  }

  async function syncNow() {
    if (closed) return;
    if (!voting) {
      const local = {origin:advertised,url,address:wallet.address,instanceId:store.instanceId};
      if (monitor) {
        const observed = await monitor(local);
        if (closed) return;
        install(observed?.checkpoint ?? observed);
        ledgerUrl = observed.url ?? null;
        if (enrollmentStatus() !== 'candidate' || !discover) {
          enrollmentError = null;
          return;
        }
      }
      try {
        const initial = await discover?.({...local,checkpoint:head,ledgerUrl});
        if (initial && !closed) install(initial);
        enrollmentError = null;
      } catch (err) {
        enrollmentError = err.message;
        if (!monitor) throw err;
      }
    } else {
      const responses = await callPeers(async peer => {
        if (peer.address === wallet.address || closed) return false;
        const info = await requestJson(peer.url+'/v1/status',{timeoutMs:peerTimeoutMs,maxBytes:MAX_CHECKPOINT});
        if (info.chainId !== genesis.hash) return false;
        // The bootstrap may disappear just after issuing the activation. A
        // single holder can relay its authenticated snapshot to the other
        // enrolled validators, including members returning after a restart.
        if (info.mode === 'standby' || info.mode === 'verifier' || info.height < head.state.height) {
          await requestJson(peer.url+'/v1/consensus/commit',
            {body:head,timeoutMs:peerTimeoutMs,maxBytes:MAX_CHECKPOINT});
          return true;
        }
        if (info.height === head.state.height) return info.tip === head.state.tip;
        const remote = await fetchSignedCheckpoint(peer.url,genesis.hash,peerTimeoutMs,info);
        if (!closed) install(remote);
        return true;
      });
      need(closed || responses.some(Boolean),503,'No other certified validator confirmed sync');
    }
  }
  function sync() {
    if (!syncing) syncing = syncNow().then(() => { lastSyncError = null; }).catch(err => {
      lastSyncError = err.message;
      throw err;
    }).finally(() => { syncing = undefined; });
    return syncing;
  }

  function matchesSession(message,s) {
    return message.chainId === s.chainId && message.authorityHash === s.authorityHash &&
      message.height === s.height && message.previousHash === s.previousHash;
  }

  function responseProof(reply,domain,s,ballot,address) {
    const p = reply?.payload;
    return reply?.address === address && keys.has(address) && p?.domain === domain &&
      matchesSession(p,s) && hash(p.ballot) === hash(ballot) && verify(address,p,reply.signature);
  }

  function highest(promises,s,ballot) {
    const seen = new Set();
    let selected = null;
    need(Array.isArray(promises) && promises.length >= quorum() && promises.length <= members.length,
      400,'Insufficient promises');
    for (const proof of promises) {
      need(!seen.has(proof.address) && responseProof(proof,phaseDomain('promise'),s,ballot,proof.address),
        400,'Invalid promise');
      seen.add(proof.address);
      const a = proof.payload.accepted;
      if (a === null) continue;
      checkBallot(a.ballot);
      need(keys.has(a.ballot.proposer) && compare(a.ballot,ballot) <= 0 && HEX.test(a.txHash),400,'Invalid prior vote');
      const rank = compare(a.ballot,selected?.ballot);
      if (rank === 0) need(selected.txHash === a.txHash,409,'Conflicting votes at the same ballot');
      if (rank > 0) selected = a;
    }
    return selected?.txHash;
  }

  function phase(method,envelope) {
    need(voting,503,'This node is not an active voting member');
    const s = session();
    const p = envelope?.payload, ballot = p?.ballot;
    checkBallot(ballot);
    need(p.domain === phaseDomain(method) && matchesSession(p,s),409,'Wrong consensus slot');
    need(keys.has(ballot.proposer) && envelope.address === ballot.proposer &&
      verify(envelope.address,p,envelope.signature),403,'Invalid proposer signature');
    const {promised,accepted} = store.slot();
    if (promised && compare(ballot,promised) < 0) {
      return {nack:signed({domain:phaseDomain('nack'),...s,ballot,promised})};
    }
    if (method === 'prepare') {
      store.promise(ballot);
      const prior = accepted && {ballot:accepted.ballot,txHash:hash(accepted.tx)};
      return {proof:signed({domain:phaseDomain('promise'),...s,ballot,accepted:prior}),tx:accepted?.tx};
    }
    const txHash = hash(p.tx);
    const locked = highest(p.promises,s,ballot);
    need(!locked || txHash === locked,409,'Must preserve highest accepted value');
    if (accepted && compare(accepted.ballot,ballot) === 0) {
      need(hash(accepted.tx) === txHash,409,'Conflicting value for ballot');
    }
    need(Buffer.byteLength(encode(p.tx)) <= MAX_TX,413,'Transaction exceeds size limit');
    const {next} = consensusCandidate(head,p.tx);
    store.accept(ballot,p.tx);
    return {vote:{address:wallet.address,signature:sign(wallet.privateKey,votePayload(next,head.authority,ballot))}};
  }

  async function round(method,request,s,ballot) {
    return callPeers(async peer => {
      const reply = peer.address === wallet.address ? phase(method,request)
        : await requestJson(peer.url+'/v1/consensus/'+method,{body:request,timeoutMs:peerTimeoutMs,maxBytes:128*1024});
      if (reply.nack) {
        if (responseProof(reply.nack,phaseDomain('nack'),s,ballot,peer.address)) {
          const seen = reply.nack.payload.promised;
          checkBallot(seen);
          store.observe(seen.round);
        }
        throw Error('Ballot superseded');
      }
      return {peer,reply};
    });
  }

  async function propose(tx) {
    need(voting,503,'This node is not an active voting member');
    need(!busy,429,'Validator is proposing another transaction');
    busy = true;
    try {
      const requested = hash(tx);
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) {
          await delay(randomInt(30,100)*(1+attempt));
          await sync();
        }
        const previous = head;
        // Do not promise a slot to invalid client work.
        consensusCandidate(previous,tx);
        const s = session(), ballot = store.nextBallot();
        const prepare = signed({domain:phaseDomain('prepare'),...s,ballot});
        const responses = await round('prepare',prepare,s,ballot);
        const valid = responses.filter(({reply,peer}) =>
          responseProof(reply.proof,phaseDomain('promise'),s,ballot,peer.address) &&
          (!reply.proof.payload.accepted || (reply.tx && hash(reply.tx) === reply.proof.payload.accepted.txHash)));
        if (valid.length < quorum() || head !== previous) continue;
        const promises = valid.map(({reply}) => reply.proof);
        const locked = highest(promises,s,ballot);
        const value = locked ? valid.find(({reply}) => reply.proof.payload.accepted?.txHash === locked).reply.tx : tx;
        const {block,next} = consensusCandidate(previous,value);
        const accept = signed({domain:phaseDomain('accept'),...s,ballot,tx:value,promises});
        const replies = await round('accept',accept,s,ballot);
        const vote = votePayload(next,head.authority,ballot);
        const votes = replies.flatMap(({reply,peer}) => reply.vote?.address === peer.address &&
          verify(peer.address,vote,reply.vote.signature) ? [reply.vote] : []);
        if (votes.length < quorum()) continue;
        const chosen = certify(next,previous.authority,ballot,votes);
        install(chosen);
        await callPeers(async peer => {
          if (peer.address === wallet.address) return;
          await requestJson(peer.url+'/v1/consensus/commit',
            {body:chosen,timeoutMs:peerTimeoutMs,maxBytes:MAX_CHECKPOINT});
        });
        if (hash(value) === requested) return {block,checkpoint:chosen};
      }
      throw new ProtocolError(503,'No available majority for this transaction; check the current state before retrying');
    } finally { busy = false; }
  }

  function status() {
    const mode = voting ? 'validator' : head ? 'verifier' : 'standby';
    return {chainId:genesis.hash,mode,address:wallet.address,instanceId:store.instanceId,
      voting,verified:Boolean(head),lastVerifiedAt,ledgerUrl,enrollmentStatus:enrollmentStatus(),enrollmentError,
      height:head?.state.height,tip:head?.state.tip,epoch:head?.state.epoch,
      epochTokens:head?.state.epochTokens,totalWorkTokens:head?.state.totalWorkTokens,
      providers:head?.state.providers,epochTarget:EPOCH_TOKENS,maxOutputTokens:head?.state.maxOutputTokens,
      syncError:lastSyncError};
  }

  const server = createServer(async (req,res) => {
    const send = (status,result) => {
      res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
      res.end(encode(result));
    };
    try {
      const target = new URL(req.url,'http://localhost');
      const path = target.pathname;
      if (path.startsWith('/v1/relay/')) {
        need(head && voting,503,'Only an active validator can host the relay');
        return await relay.serve(req,res,head.state);
      }
      if (req.method === 'GET' && path === '/v1/consensus/ready') {
        const challenge = target.searchParams.get('challenge');
        need(/^[a-f0-9]{32}$/.test(challenge ?? ''),400,'Invalid readiness challenge');
        const payload = {domain:'gpuchain/validator-ready/v1',chainId:genesis.hash,
          address:wallet.address,origin:advertised,challenge,instanceId:store.instanceId};
        if (target.searchParams.get('money')==='exact') {
          payload.moneyCodec='nanocoin-decimal-v1';
          payload.saleEscrow=SALE_TERMS;
        }
        if (target.searchParams.get('stage')==='mainnet') payload.validatorProtocol=MAINNET.validatorProtocol;
        const starter=target.searchParams.get('starter');
        if (starter==='1') payload.starterGrants=LEGACY_STARTER_GRANT_PROTOCOL;
        if (starter==='2') payload.starterGrants=STARTER_GRANT_PROTOCOL;
        if (target.searchParams.get('salePrice')==='3') payload.salePrice=SALE_PRICE_TERMS;
        return send(200,{payload,signature:sign(wallet.privateKey,payload)});
      }
      if (req.method === 'GET' && path === '/v1/genesis') return send(200,genesis);
      if (req.method === 'GET' && path === '/v1/status') return send(200,status());
      if (req.method==='GET' && outcomeRoute.test(path)) {
        const proof=store.findOutcome(outcomeRoute.exec(path)[1]);
        return proof?send(200,proof):send(404,{error:'Transaction outcome unavailable'});
      }
      if (req.method === 'POST' && path === '/v1/consensus/commit') {
        const incoming = await body(req,MAX_CHECKPOINT);
        need(incoming?.authority,400,'Commit requires a validator-certified checkpoint');
        install(incoming);
        return send(200,{height:head.state.height,tip:head.state.tip});
      }
      need(head,503,'Waiting for validator activation');
      if (req.method === 'GET' && path === '/v1/checkpoint') {
        const reply=checkpointHttp(head,req.headers['if-none-match']);
        res.writeHead(reply.status,reply.headers);
        return res.end(reply.body);
      }
      need(req.method === 'POST',404,'Route not found');
      if (path === '/v1/transactions') return send(201,await propose(await body(req,MAX_TX)));
      const match = /^\/v1\/consensus\/(prepare|accept)$/.exec(path);
      need(match,404,'Route not found');
      return send(200,phase(match[1],await body(req,128*1024)));
    } catch (err) { send(err.status ?? 400,{error:err.message}); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  try {
    await new Promise((resolve,reject) => {
      server.once('error',reject);
      server.listen(port,listen,() => { server.off('error',reject); resolve(); });
    });
    url = 'http://'+(listen.includes(':')?'['+listen+']':listen)+':'+server.address().port;
    advertised ??= normalizeProviderEndpoint(url);
    if (store.checkpoint) install(store.checkpoint,true);
    if (checkpoint) install(checkpoint);
    await sync().catch(() => {});
    timer = setInterval(() => { sync().catch(() => {}); },syncIntervalMs);
  } catch (err) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    relay.close();
    store.close();
    throw err;
  }
  return {url,sync,snapshot:()=>({status:status(),checkpoint:head ?? null}),async close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    await syncing?.catch(() => {});
    relay.close();
    store.close();
  }};
}
