// The Worker bundle substitutes this portable implementation for node:crypto.
// Addresses, signatures, canonical JSON and digests use the native client's wire format.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonical } from '../../src/canonical.mjs';

const privatePrefix = hexToBytes('302e020100300506032b657004220420');

function messageBytes(value) {
  return utf8ToBytes(canonical(value));
}

function privateSeed(value) {
  // Only the RFC 8410 unencrypted PKCS#8 form emitted by GPUChain is provisioned.
  if (typeof value !== 'string' || value.length !== 64) throw Error('Invalid signing key');
  const der = atob(value);
  if (btoa(der) !== value || der.length !== 48 ||
      !privatePrefix.every((b, index) => der.charCodeAt(index) === b)) {
    throw Error('Invalid signing key');
  }
  return Uint8Array.from(der.slice(privatePrefix.length), ch => ch.charCodeAt(0));
}

export function hash(value) {
  return bytesToHex(sha256(messageBytes(value)));
}

export function addressFromPrivateKey(privateKey) {
  const seed = privateSeed(privateKey);
  try { return bytesToHex(ed25519.getPublicKey(seed)); }
  finally { seed.fill(0); }
}

export function sign(privateKey, payload) {
  const seed = privateSeed(privateKey);
  try { return bytesToHex(ed25519.sign(messageBytes(payload), seed)); }
  finally { seed.fill(0); }
}

export function verify(address, payload, signature) {
  if (typeof address !== 'string' || !/^[0-9a-f]{64}$/.test(address) ||
      typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return false;
  return ed25519.verify(hexToBytes(signature), messageBytes(payload), hexToBytes(address), {zip215:false});
}
