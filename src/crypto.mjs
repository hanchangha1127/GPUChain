import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as edSign, verify as edVerify,
} from 'node:crypto';
import { canonical } from './canonical.mjs';

export { canonical };

// Ed25519 SubjectPublicKeyInfo header is fixed by RFC 8410.
const PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function loadPrivateKey(privateKey) {
  if (typeof privateKey !== 'string') throw new Error('Expected a PKCS8 wallet key');
  const key = createPrivateKey({key: Buffer.from(privateKey, 'base64'), type: 'pkcs8', format: 'der'});
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key');
  return key;
}

function publicAddress(publicKey) {
  return publicKey.export({type: 'spki', format: 'der'}).subarray(PUBLIC_PREFIX.length).toString('hex');
}

export function addressFromPrivateKey(privateKey) {
  return publicAddress(createPublicKey(loadPrivateKey(privateKey)));
}

export function generateWallet() {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  return {
    address: publicAddress(publicKey),
    privateKey: privateKey.export({type: 'pkcs8', format: 'der'}).toString('base64'),
  };
}

export function sign(privateKey, payload) {
  return edSign(null, Buffer.from(canonical(payload)), loadPrivateKey(privateKey)).toString('hex');
}

export function verify(address, payload, signature) {
  if (typeof address !== 'string' || !/^[0-9a-f]{64}$/.test(address) ||
      typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return false;
  const key = createPublicKey({
    format: 'der', type: 'spki', key: Buffer.concat([PUBLIC_PREFIX, Buffer.from(address, 'hex')]),
  });
  return edVerify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'hex'));
}
