import { hash, verify } from './crypto.mjs';
import { charge, CONTEXT, MODEL } from './ledger.mjs';
import { decodeAmount } from './amount.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';
import { validateReasoningOptions } from './reasoning.mjs';

// One AES-GCM box carries up to 8 MiB of JSON, a 12-byte IV and a 16-byte tag.
const BOX_LIMIT = Math.ceil(((8*1024*1024)+28)*4/3);
const CHUNK = 512*1024;
const TTL = 60_000;
const RUN = 3_660_000;
const DONE = 300_000;
const FRAME_LIMIT = 128 * 1024;
const WINDOW = 24;
const hex = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const smallHex = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const integer = v => Number.isSafeInteger(v);
const response = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function demand(ok,status,reason) { if (!ok) throw Object.assign(Error(reason),{status}); }

const extra = {
  presence:['provider','publicKey','model','contextWindow','kvCache','maxOutputTokens','available','expiresAt'],
  submit:['payer','provider','jobId','providerKey','clientKey','requestHash','boxHash','nonce','maxInputTokens','maxOutputTokens','expiresAt'],
  poll:['provider','salt'], complete:['provider','jobId','boxHash','salt'], result:['payer','jobId','salt'],
  frame:['provider','jobId','index','boxHash','salt']
};

function fields(obj,names) {
  return obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).length===names.length &&
    names.every(name=>Object.hasOwn(obj,name));
}

async function input(request,limit) {
  demand(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='application/json',415,'Expected JSON');
  demand(request.body && Number(request.headers.get('content-length')??0)<=limit,413,'Relay envelope is too large');
  const reader=request.body.getReader(), decoder=new TextDecoder('utf-8',{fatal:true});
  const pieces=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.length;
      if(size>limit){await reader.cancel();demand(false,413,'Relay envelope is too large');}
      pieces.push(decoder.decode(value,{stream:true}));
    }
    pieces.push(decoder.decode());
    return JSON.parse(pieces.join(''));
  } catch(err) {
    if(err.status) throw err;
    demand(false,400,'Invalid relay JSON');
  } finally {reader.releaseLock();}
}

function authenticate(op,body,state,now) {
  const boxed=op==='submit' || op==='complete' || op==='frame';
  demand(fields(body,boxed?['payload','signature','box']:['payload','signature']),400,'Invalid relay envelope');
  const p=body.payload;
  const names=['domain','chainId','issuedAt',...extra[op]];
  if(op==='complete' && Object.hasOwn(p??{},'outcome')) {
    demand(p.outcome==='failed',400,'Invalid completion outcome');
    names.push('outcome');
  }
  if(op==='presence' && Object.hasOwn(p??{},'reasoningOptions')) names.push('reasoningOptions');
  if(['presence','submit'].includes(op) && Object.hasOwn(p??{},'chatProtocol')) {
    demand(p.chatProtocol===1,400,'Unsupported chat protocol'); names.push('chatProtocol');
  }
  if(op==='submit' && Object.hasOwn(p??{},'stream')) {
    demand(p.stream===true && p.chatProtocol===1,400,'Invalid streaming request'); names.push('stream');
  }
  if(op==='result' && Object.hasOwn(p??{},'after')) {
    demand(integer(p.after) && p.after>=0,400,'Invalid frame cursor'); names.push('after');
  }
  if(op==='submit') for(const name of ['reasoningEffort','reasoningBudgetTokens']) if(Object.hasOwn(p??{},name)) names.push(name);
  demand(fields(p,names) && p.domain==='gpuchain/relay-'+op+'/v1' && p.chainId===state.chainId &&
    integer(p.issuedAt) && p.issuedAt>now-TTL && p.issuedAt<=now+10_000,400,'Invalid or stale relay payload');
  demand(!Object.hasOwn(p,'jobId') || hex(p.jobId),400,'Invalid job ID');
  demand(!Object.hasOwn(p,'salt') || smallHex(p.salt),400,'Invalid freshness salt');
  const signer = ['submit','result'].includes(op) ? p.payer : p.provider;
  demand(hex(signer) && verify(signer,p,body.signature),403,'Invalid relay signature');
  if (!['submit','result'].includes(op)) demand(state.providers.includes(p.provider),403,'Unregistered provider');
  if(boxed){
    const box=body.box;
    demand(typeof box==='string' && box.length>=38 && box.length<=BOX_LIMIT && box.length%4!==1 &&
      /^[A-Za-z0-9_-]+$/.test(box) && hex(p.boxHash) && hash(box)===p.boxHash,400,'Invalid encrypted box');
  }
  return p;
}

export async function purgeExpiredRelay(db,now=Date.now()) {
  // Foreign-key cascade removes all ciphertext chunks with their expired job.
  await db.batch([
    db.prepare('DELETE FROM relay_jobs WHERE expires_ms<=?').bind(now),
    db.prepare('DELETE FROM relay_presence WHERE expires_ms<=?').bind(now)
  ]);
}

async function presence(db,b,p,now) {
  demand(hex(p.publicKey) && p.model===MODEL && p.contextWindow===CONTEXT && kvCacheAtLeastQ8(p.kvCache) &&
    integer(p.maxOutputTokens) && p.maxOutputTokens>0 && p.maxOutputTokens<=CONTEXT &&
    typeof p.available==='boolean' && integer(p.expiresAt) && p.expiresAt>now && p.expiresAt<=p.issuedAt+TTL &&
    (p.reasoningOptions===undefined || p.reasoningOptions===1),400,'Invalid provider capabilities');
  const signed=JSON.stringify(b);
  const [result]=await db.batch([db.prepare(`INSERT INTO relay_presence(provider,live_key,available,issued_ms,expires_ms,advert)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM relay_presence WHERE provider=?) OR
      (SELECT COUNT(*) FROM relay_presence WHERE expires_ms>?)<256
    ON CONFLICT(provider) DO UPDATE SET live_key=excluded.live_key,available=excluded.available,
      issued_ms=excluded.issued_ms,expires_ms=excluded.expires_ms,advert=excluded.advert
    WHERE excluded.issued_ms>relay_presence.issued_ms OR relay_presence.advert=excluded.advert`)
    .bind(p.provider,p.publicKey,Number(p.available),p.issuedAt,p.expiresAt,signed,p.provider,now),
    // A restarted provider cannot decrypt jobs sealed to its previous ephemeral key.
    db.prepare(`DELETE FROM relay_jobs WHERE provider=? AND phase<>'done'
      AND json_extract(request_meta,'$.payload.providerKey')<>?
      AND EXISTS(SELECT 1 FROM relay_presence WHERE provider=? AND advert=?)`)
      .bind(p.provider,p.publicKey,p.provider,signed)]);
  demand(result.meta.changes===1,409,'Stale availability or relay full');
  return response({ok:true});
}

function parts(db,id,direction,box,field,digest) {
  const values=[];
  for(let i=0;i*CHUNK<box.length;i++) {
    values.push(db.prepare(`INSERT OR IGNORE INTO relay_chunks(job_id,direction,part,data)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM relay_jobs WHERE id=? AND ${field}=?
        AND ${direction===0 ? "phase<>'done'" : "phase='done'"})`)
      .bind(id,direction,i,box.slice(i*CHUNK,(i+1)*CHUNK),id,digest));
  }
  return values;
}

async function loadBox(db,id,direction,size,digest) {
  demand(integer(size) && size>0 && size<=BOX_LIMIT,503,'Invalid mailbox size');
  const rows=[];
  for(let i=0;i*CHUNK<size;i++) {
    const row=await db.prepare('SELECT data FROM relay_chunks WHERE job_id=? AND direction=? AND part=?')
      .bind(id,direction,i).first();
    demand(row && typeof row.data==='string',409,'Job has expired or changed');
    rows.push(row.data);
  }
  const box=rows.join('');
  demand(box.length===size && hash(box)===digest,503,'Mailbox integrity check failed');
  return box;
}

async function submit(db,b,p,state,now) {
  demand(state.providers.includes(p.provider) && p.payer!==p.provider && hex(p.providerKey) &&
    hex(p.clientKey) && hex(p.requestHash) && integer(p.nonce) && p.nonce>0 &&
    integer(p.maxInputTokens) && p.maxInputTokens>0 && integer(p.maxOutputTokens) && p.maxOutputTokens>0 &&
    p.maxOutputTokens<=state.maxOutputTokens && p.maxInputTokens+p.maxOutputTokens<=CONTEXT &&
    integer(p.expiresAt) && p.expiresAt>now && p.expiresAt<=p.issuedAt+600_000,400,'Invalid inference budget or route');
  try {validateReasoningOptions(p);}
  catch {demand(false,400,'Invalid reasoning options');}
  demand((state.nonces[p.payer]??0)+1===p.nonce,409,'Stale requester nonce');
  const cap=charge({inputTokens:p.maxInputTokens,cachedTokens:0,outputTokens:p.maxOutputTokens});
  demand(decodeAmount(state.balances[p.payer]??0)>=BigInt(cap),402,'Insufficient balance for inference budget');
  const digest=hash(p);
  const old=await db.prepare('SELECT submit_hash,phase FROM relay_jobs WHERE id=? AND expires_ms>?').bind(p.jobId,now).first();
  if(old){demand(old.submit_hash===digest,409,'Job ID already used');return response({jobId:p.jobId,status:old.phase});}
  const presence=await db.prepare('SELECT advert FROM relay_presence WHERE provider=? AND available=1 AND expires_ms>? AND live_key=?')
    .bind(p.provider,now,p.providerKey).first();
  const unavailable=()=>response({error:'Provider unavailable before admission',code:'provider_not_admitted',jobId:p.jobId},409);
  if (!presence) return unavailable();
  const offer=JSON.parse(presence.advert).payload;
  if (!(offer.maxOutputTokens>=p.maxOutputTokens &&
    (p.chatProtocol===undefined || offer.chatProtocol===1) &&
    (!(p.reasoningEffort!==undefined || p.reasoningBudgetTokens!==undefined) || offer.reasoningOptions===1))) return unavailable();
  const meta=JSON.stringify({payload:p,signature:b.signature});
  const [saved]=await db.batch([db.prepare(`INSERT OR IGNORE INTO relay_jobs
    (id,provider,payer,nonce,phase,expires_ms,submit_hash,request_meta,bytes)
    SELECT ?,?,?,?,'queued',?,?,?,? WHERE EXISTS
    (SELECT 1 FROM relay_presence WHERE provider=? AND advert=? AND available=1 AND expires_ms>?)
    AND (SELECT COUNT(*) FROM relay_jobs)<64
    AND (SELECT COALESCE(SUM(CASE WHEN phase='done' THEN bytes ELSE ? END),0) FROM relay_jobs)+?<=67108864`)
    .bind(p.jobId,p.provider,p.payer,p.nonce,p.expiresAt,digest,meta,b.box.length,p.provider,presence.advert,now,BOX_LIMIT,BOX_LIMIT),
  ...parts(db,p.jobId,0,b.box,'submit_hash',digest)]);
  if(!saved.meta.changes){
    const concurrent=await db.prepare('SELECT submit_hash,phase FROM relay_jobs WHERE id=?').bind(p.jobId).first();
    if (!concurrent) {
      const owner=await db.prepare('SELECT id FROM relay_jobs WHERE payer=? AND nonce=? AND failed_no_receipt=0')
        .bind(p.payer,p.nonce).first();
      if (!owner) {
        const busy=await db.prepare("SELECT id FROM relay_jobs WHERE provider=? AND phase<>'done'").bind(p.provider).first();
        const current=await db.prepare('SELECT advert FROM relay_presence WHERE provider=? AND available=1 AND expires_ms>?')
          .bind(p.provider,now).first();
        if (busy || current?.advert!==presence.advert) return unavailable();
      }
    }
    demand(concurrent?.submit_hash===digest,409,'Provider, requester or relay is busy');
    return response({jobId:p.jobId,status:concurrent.phase});
  }
  return response({jobId:p.jobId,status:'queued'},201);
}

async function poll(db,p,now) {
  const row=await db.prepare("SELECT id,request_meta,bytes,phase FROM relay_jobs WHERE provider=? AND phase<>'done' AND expires_ms>?")
    .bind(p.provider,now).first();
  if(!row) return response({job:null});
  if(row.phase==='queued'){
    await db.prepare("UPDATE relay_jobs SET phase='running',expires_ms=? WHERE id=? AND phase='queued' AND expires_ms>?")
      .bind(now+RUN,row.id,now).run();
  }
  const job=JSON.parse(row.request_meta);
  job.box=await loadBox(db,row.id,0,row.bytes,job.payload.boxHash);
  return response({job,failureReceipt:1});
}

async function complete(db,b,p,now) {
  const failed=Number(p.outcome==='failed');
  const row=await db.prepare('SELECT phase,result_hash,failed_no_receipt FROM relay_jobs WHERE provider=? AND id=? AND expires_ms>?')
    .bind(p.provider,p.jobId,now).first();
  demand(row,404,'Job unavailable');
  if(row.phase==='done'){demand(row.result_hash===p.boxHash && row.failed_no_receipt===failed,409,'Different result already published');return response({jobId:p.jobId,status:'done'});}
  const [write]=await db.batch([db.prepare(`UPDATE relay_jobs SET phase='done',expires_ms=?,request_meta=NULL,
    reply_meta=?,result_hash=?,bytes=?,failed_no_receipt=? WHERE id=? AND provider=? AND phase='running' AND expires_ms>?`)
    .bind(now+DONE,JSON.stringify({payload:p,signature:b.signature}),p.boxHash,b.box.length,failed,p.jobId,p.provider,now),
    db.prepare(`DELETE FROM relay_chunks WHERE job_id=? AND direction=0
      AND EXISTS (SELECT 1 FROM relay_jobs WHERE id=? AND result_hash=?)`).bind(p.jobId,p.jobId,p.boxHash),
    ...parts(db,p.jobId,1,b.box,'result_hash',p.boxHash)]);
  if(!write.meta.changes){
    const existing=await db.prepare('SELECT result_hash,failed_no_receipt FROM relay_jobs WHERE id=?').bind(p.jobId).first();
    demand(existing?.result_hash===p.boxHash && existing.failed_no_receipt===failed,409,'Job expired or not claimed');
  }
  return response({jobId:p.jobId,status:'done'});
}

// direction=2 holds only unread, individually authenticated live stream fragments.
// The persisted cursor makes retries safe if either HTTP acknowledgement is lost.
async function appendFrame(db,b,p,now) {
  demand(integer(p.index) && p.index>=1 && p.index<=1_000_000 && b.box.length<=FRAME_LIMIT,400,'Invalid frame');
  const encoded=JSON.stringify(b);
  const [,changed]=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO relay_chunks(job_id,direction,part,data)
      SELECT id,2,?,? FROM relay_jobs WHERE id=? AND provider=? AND phase='running' AND expires_ms>?
      AND json_extract(request_meta,'$.payload.stream')=1 AND stream_tail=? AND stream_tail-stream_ack<?`)
      .bind(p.index,encoded,p.jobId,p.provider,now,p.index-1,WINDOW),
    db.prepare(`UPDATE relay_jobs SET stream_tail=? WHERE id=? AND provider=? AND stream_tail=?
      AND EXISTS(SELECT 1 FROM relay_chunks WHERE job_id=? AND direction=2 AND part=? AND data=?)`)
      .bind(p.index,p.jobId,p.provider,p.index-1,p.jobId,p.index,encoded)
  ]);
  if(!changed.meta.changes) {
    const row=await db.prepare('SELECT stream_tail,stream_ack,phase FROM relay_jobs WHERE id=? AND provider=? AND expires_ms>?')
      .bind(p.jobId,p.provider,now).first();
    demand(row,404,'Unknown job');
    if (row.stream_ack<p.index) {
      const existing=await db.prepare('SELECT data FROM relay_chunks WHERE job_id=? AND direction=2 AND part=?').bind(p.jobId,p.index).first();
      if (!existing && row.stream_tail===p.index-1 && row.stream_tail-row.stream_ack>=WINDOW) demand(false,429,'Reader has not acknowledged earlier frames');
      demand(existing && JSON.parse(existing.data).payload.boxHash===p.boxHash,409,'Unexpected stream sequence');
    }
  }
  return response({index:p.index});
}

async function readFrames(db,id,after,row) {
  demand(after>=row.stream_ack && after<=row.stream_tail,409,'Invalid or expired stream cursor');
  if(after>row.stream_ack) {
    await db.batch([
      db.prepare('UPDATE relay_jobs SET stream_ack=max(stream_ack,?) WHERE id=? AND stream_tail>=?').bind(after,id,after),
      db.prepare('DELETE FROM relay_chunks WHERE job_id=? AND direction=2 AND part<=?').bind(id,after)
    ]);
  }
  const page=await db.prepare('SELECT data FROM relay_chunks WHERE job_id=? AND direction=2 AND part>? AND part<=? ORDER BY part LIMIT 8')
    .bind(id,after,row.stream_tail).all();
  return page.results.map(r=>JSON.parse(r.data));
}

export async function relayRoute(request,db,state,{now=Date.now()}={}) {
  const op=new URL(request.url).pathname.slice('/v1/relay/'.length);
  try {
    if(op==='providers' && request.method==='GET') {
      const listed=await db.prepare(`SELECT provider,advert FROM relay_presence r
        WHERE available=1 AND expires_ms>? AND NOT EXISTS
        (SELECT 1 FROM relay_jobs j WHERE j.provider=r.provider AND j.phase<>'done' AND j.expires_ms>?)
        ORDER BY provider LIMIT 256`).bind(now,now).all();
      const allowed=new Set(state.providers);
      return response({chainId:state.chainId,providers:listed.results.filter(r=>allowed.has(r.provider)).map(r=>JSON.parse(r.advert))});
    }
    demand(request.method==='POST' && Object.hasOwn(extra,op),404,'Relay route not found');
    const b=await input(request,['submit','complete'].includes(op)?BOX_LIMIT+16384:op==='frame'?FRAME_LIMIT+4096:8192);
    const p=authenticate(op,b,state,now);
    if(op==='presence') return await presence(db,b,p,now);
    if(op==='submit') {await purgeExpiredRelay(db,now);return await submit(db,b,p,state,now);}
    if(op==='poll') return await poll(db,p,now);
    if(op==='frame') return await appendFrame(db,b,p,now);
    if(op==='complete') return await complete(db,b,p,now);
    const row=await db.prepare('SELECT phase,result_hash,bytes,reply_meta,stream_ack,stream_tail FROM relay_jobs WHERE id=? AND payer=? AND expires_ms>?')
      .bind(p.jobId,p.payer,now).first();
    demand(row,404,'Job unavailable');
    const result={jobId:p.jobId,status:row.phase};
    if(p.after!==undefined) {
      result.frames=await readFrames(db,p.jobId,p.after,row);
      result.tail=row.stream_tail;
      if(p.after+result.frames.length<row.stream_tail) return response({...result,status:'running'});
    }
    if(row.phase==='done'){
      result.reply=JSON.parse(row.reply_meta);
      result.reply.box=await loadBox(db,p.jobId,1,row.bytes,row.result_hash);
    }
    return response(result);
  } catch(err) {
    return response({error:err.status ? err.message : 'Relay storage or message unavailable'},err.status??503);
  }
}
