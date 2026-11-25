import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { addressFromPrivateKey, sign, verify } from './crypto.mjs';
import { readWalletDocument, windowsPowerShell, writeVerifiedDocument } from './private-file.mjs';

const FORMAT='gpuchain-windows-dpapi';

// Both operations run under the node owner's Windows identity. Only the fixed
// script enters the process command line. Key material travels over private pipes.
function dpapi(value,protect) {
  if (process.platform!=='win32') throw Error('This wallet requires its original Windows account. Restore a portable backup on this computer.');
  const operation=protect ? 'Protect' : 'Unprotect';
  const script=[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
    'try {',
    '$out=[Security.Cryptography.ProtectedData]::'+operation+'($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    'try { [Console]::Out.Write([Convert]::ToBase64String($out)) } finally { [Array]::Clear($out,0,$out.Length) }',
    '} finally { [Array]::Clear($inputBytes,0,$inputBytes.Length) }',
  ].join('\n');
  return new Promise((resolve,reject)=>{
    const failed=()=>reject(Error('Windows could not '+(protect?'protect':'open')+' the signing key for this account'));
    const child=execFile(windowsPowerShell,['-NoProfile','-NonInteractive','-Command',script],
      {encoding:'buffer',windowsHide:true,timeout:15_000,maxBuffer:8192},(err,stdout)=>{
        try {
          if (err) return failed();
          const result=stdout.toString('ascii');
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result)) return failed();
          resolve(result);
        } finally { stdout?.fill(0); }
      });
    child.stdin.on('error',failed);
    child.stdin.end(value,'ascii');
  });
}

function validated(address,privateKey) {
  if (typeof privateKey!=='string' || !/^[0-9a-f]{64}$/.test(address) ||
      addressFromPrivateKey(privateKey)!==address) throw Error('Wallet address/key mismatch');
  return {address,privateKey};
}

export async function decodeRuntimeWallet(doc) {
  if (!doc || typeof doc!=='object') throw Error('Invalid wallet document');
  if (doc.format===undefined) return validated(doc.address,doc.privateKey);
  if (doc.format!==FORMAT || doc.version!==1 || Object.keys(doc).length!==4 ||
      typeof doc.ciphertext!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(doc.ciphertext)) {
    throw Error('Unsupported or damaged operational wallet');
  }
  return validated(doc.address,await dpapi(doc.ciphertext,false));
}

async function writeVerifiedWallet(path,wallet,beforeReplace) {
  const valid=validated(wallet.address,wallet.privateKey);
  const doc=process.platform==='win32' ? {format:FORMAT,version:1,address:valid.address,
    ciphertext:await dpapi(valid.privateKey,true)} : valid;
  await writeVerifiedDocument(path,doc,async temp=>{
    const reopened=await decodeRuntimeWallet(await readWalletDocument(temp));
    const proof={domain:'gpuchain/runtime-wallet-roundtrip/v1',challenge:randomBytes(16).toString('hex')};
    if (reopened.address!==valid.address || !verify(valid.address,proof,sign(reopened.privateKey,proof))) {
      throw Error('Operational wallet signing check failed');
    }
  },beforeReplace);
}

export function writeRuntimeWallet(path,wallet) {
  return writeVerifiedWallet(path,wallet);
}

export async function readRuntimeWallet(path,{migrate=false,expectedAddress}={}) {
  const doc=await readWalletDocument(path);
  const wallet=await decodeRuntimeWallet(doc);
  if (expectedAddress!==undefined && expectedAddress!==wallet.address) throw Error('Wallet does not match participant identity');
  if (migrate && process.platform==='win32' && doc.format===undefined) {
    await writeVerifiedWallet(path,wallet,async dest=>{
      // Preserve externally selected link targets and refuse to replace an
      // identity that changed while Windows was protecting the temporary file.
      const stat=await lstat(dest);
      if (!stat.isFile() || stat.nlink!==1) throw Error('Migrate the signing key at its original unlinked file path');
      const current=await decodeRuntimeWallet(await readWalletDocument(dest));
      if (current.address!==wallet.address) throw Error('Wallet changed during migration');
    });
  }
  return wallet;
}
