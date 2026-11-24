import {
  createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';
import { canonical } from './canonical.mjs';

// A D1 relay carries only one base64url envelope per direction. Check before
// allocating decoded buffers and before sending anything to the relay.
export const MAX_RELAY_BOX = Math.ceil(((8*1024*1024)+28)*4/3);
const HEX = /^[a-f0-9]{64}$/;
const DOMAIN = 'gpuchain/relay-box/x25519-hkdf-sha256-aes256gcm/v1';

export function makeRelayKeyPair() {
  const {privateKey,publicKey} = generateKeyPairSync('x25519');
  return {privateKey,publicKey:Buffer.from(publicKey.export({format:'jwk'}).x,'base64url').toString('hex')};
}

function aad(fields,direction) {
  const {chainId,payer,provider,jobId,requestHash,providerKey,clientKey} = fields;
  for (const value of [chainId,payer,provider,jobId,requestHash,providerKey,clientKey]) {
    if (typeof value !== 'string' || !HEX.test(value)) throw Error('Invalid relay encryption context');
  }
  const context={domain:DOMAIN,chainId,payer,provider,jobId,requestHash,providerKey,clientKey,direction};
  if (direction === 'frame' && Number.isSafeInteger(fields.index) && fields.index>0) context.index=fields.index;
  else if (direction !== 'request' && direction !== 'response') throw Error('Invalid relay direction');
  return Buffer.from(canonical(context));
}

function jobCipherKey(privateKey,peer,associated) {
  if (privateKey?.asymmetricKeyType !== 'x25519' || typeof peer !== 'string' || !HEX.test(peer)) {
    throw Error('Invalid relay encryption key');
  }
  const key = createPublicKey({format:'jwk',key:{kty:'OKP',crv:'X25519',x:Buffer.from(peer,'hex').toString('base64url')}});
  // Node/OpenSSL also rejects non-contributory X25519 public keys.
  const secret = diffieHellman({privateKey,publicKey:key});
  try {
    if (secret.every(octet => octet===0)) throw Error('Invalid relay shared secret');
    return Buffer.from(hkdfSync('sha256',secret,createHash('sha256').update(associated).digest(),
      Buffer.from(DOMAIN),32));
  } finally { secret.fill(0); }
}

export function sealRelayBox(privateKey,peer,fields,direction,value) {
  const associated = aad(fields,direction);
  const clear = Buffer.from(JSON.stringify(value));
  const length = Math.ceil((clear.byteLength+28)*4/3);
  try {
    if (length > MAX_RELAY_BOX) throw Error('Content exceeds the relay envelope limit');
    const key = jobCipherKey(privateKey,peer,associated);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
      cipher.setAAD(associated);
      return Buffer.concat([iv,cipher.update(clear),cipher.final(),cipher.getAuthTag()]).toString('base64url');
    } finally { key.fill(0); }
  } finally { clear.fill(0); }
}

export function openRelayBox(privateKey,peer,fields,direction,box) {
  if (typeof box !== 'string' || box.length < 40 || box.length > MAX_RELAY_BOX ||
      !/^[A-Za-z0-9_-]+$/.test(box)) throw Error('Invalid relay envelope');
  const bytes = Buffer.from(box,'base64url');
  if (bytes.toString('base64url') !== box) throw Error('Noncanonical relay envelope');
  const associated = aad(fields,direction), key = jobCipherKey(privateKey,peer,associated);
  try {
    const decipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12),{authTagLength:16});
    decipher.setAAD(associated);
    decipher.setAuthTag(bytes.subarray(-16));
    const clear = decipher.update(bytes.subarray(12,-16));
    try {
      decipher.final();
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(clear));
    } finally { clear.fill(0); }
  } finally { key.fill(0); }
}
