import { authenticate, checkpointETag } from './checkpoint.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { PEER_LIMIT } from './peer-directory.mjs';

const MAX_BYTES=64*1024*1024;
const FULL_READ_INTERVAL=60*60*1000;

// Retain one authenticated envelope, even when multiple peers serve it. A
// private serialized copy prevents callers from mutating the reusable state.
export function createCheckpointReader({now=()=>performance.now()}={}) {
  let saved;
  return async function read(origin,chainId,timeoutMs=30_000,status) {
    if (typeof chainId!=='string' || !/^[0-9a-f]{64}$/.test(chainId)) throw Error('A pinned genesis hash is required');
    origin=normalizeProviderEndpoint(origin);
    const prior=saved;
    const lastRead=prior?.origins.get(origin);
    const reusable=prior?.chainId===chainId && lastRead!==undefined &&
      now()-lastRead<FULL_READ_INTERVAL &&
      (status?.height===undefined || status.height===prior.height) &&
      (status?.tip===undefined || status.tip===prior.tip);
    const signal=AbortSignal.timeout(timeoutMs);
    const get=tag=>fetch(origin+'/v1/checkpoint',{
      redirect:'error',signal,headers:tag?{'if-none-match':tag}:{}
    });
    let res=await get(reusable?prior.etag:undefined);
    if (res.status===304) {
      if (reusable && res.headers.get('etag')===prior.etag) return JSON.parse(prior.encoded);
      // Some intermediaries drop the validator. Never infer a checkpoint
      // from an unbound 304; demand a full response once.
      res=await get();
    }
    if (res.status!==200 || !res.body) {
      await res.body?.cancel();
      throw Error('Checkpoint endpoint returned HTTP '+res.status);
    }
    const chunks=[];
    let bytes=0;
    for await (const part of res.body) {
      bytes+=part.byteLength;
      if (bytes>MAX_BYTES) throw Error('Body size limit exceeded');
      chunks.push(part);
    }
    const encoded=Buffer.concat(chunks).toString('utf8');
    const head=authenticate(JSON.parse(encoded),chainId);
    const advertised=res.headers.get('etag');
    if (advertised && advertised===checkpointETag(head)) {
      const {height,tip}=head.state;
      // Do not evict a fresher snapshot when discovering a lagging peer.
      if (!saved || saved.chainId!==chainId || (saved.etag!==advertised && height>=saved.height)) {
        saved={chainId,height,tip,etag:advertised,encoded,origins:new Map()};
      }
      if (saved.etag===advertised && (saved.origins.has(origin) || saved.origins.size<PEER_LIMIT)) {
        saved.origins.set(origin,now());
      }
    } else {
      // A legacy endpoint or a proxy with its own tag remains usable via 200.
      if (saved?.chainId===chainId) saved.origins.delete(origin);
    }
    return head;
  };
}

export const fetchSignedCheckpoint=createCheckpointReader();
