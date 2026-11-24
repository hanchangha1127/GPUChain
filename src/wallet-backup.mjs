import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonical, addressFromPrivateKey, sign, verify } from './crypto.mjs';

const derive=promisify(scrypt),exec=promisify(execFile);
const prefix=Buffer.from('302e020100300506032b657004220420','hex');
const LIMIT=4096;

function must(test,reason) {if(!test)throw Error(reason);}
function fields(obj,names) {
  must(obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).length===names.length &&
    names.every(name=>Object.hasOwn(obj,name)),'Invalid wallet document fields');
}
export function parseWalletDocument(text) {
  must(typeof text==='string' && Buffer.byteLength(text)<=LIMIT,'Wallet document exceeds 4 KiB');
  let obj;
  try {obj=JSON.parse(text);} catch {throw Error('Invalid wallet document JSON');}
  // JSON.parse normally discards duplicate names. Reject them in each object,
  // including equivalent escaped key spellings, before interpreting any fields.
  const stack=[];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
    const word=token[0];
    if(word==='{')stack.push(new Set());
    else if(word==='}')stack.pop();
    else if(/^\s*:/.test(text.slice(token.index+word.length))) {
      const key=JSON.parse(word),seen=stack.at(-1);
      must(seen && !seen.has(key),'Duplicate wallet document field');
      seen.add(key);
    }
  }
  return obj;
}
async function readDoc(file) {
  const fd=await open(file,'r');
  const data=Buffer.alloc(LIMIT+1);
  try {
    const info=await fd.stat();
    must(info.isFile() && info.size<=LIMIT,'Expected a wallet file of at most 4 KiB');
    let used=0;
    while(used<data.length) {
      const {bytesRead}=await fd.read(data,used,data.length-used,null);
      if(!bytesRead)break;
      used+=bytesRead;
    }
    must(used<=LIMIT,'Wallet document exceeds 4 KiB');
    return parseWalletDocument(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,used)));
  } finally { data.fill(0);await fd.close(); }
}
function checkWallet(w) {
  fields(w,['address','privateKey']);
  must(typeof w.privateKey==='string' && w.privateKey.length===64 && /^[0-9a-f]{64}$/.test(w.address),'Invalid wallet');
  const der=Buffer.from(w.privateKey,'base64');
  try {
    must(der.toString('base64')===w.privateKey && der.length===prefix.length+32 &&
      der.subarray(0,prefix.length).equals(prefix) && addressFromPrivateKey(w.privateKey)===w.address,'Wallet address/key mismatch');
    return Buffer.from(der.subarray(prefix.length));
  } finally {der.fill(0);}
}
function bytes(value,length) {
  must(typeof value==='string' && /^[A-Za-z0-9_-]+$/.test(value),'Invalid backup encoding');
  const result=Buffer.from(value,'base64url');
  must(result.length===length && result.toString('base64url')===value,'Invalid backup field length or encoding');
  return result;
}
function slot(value) {
  fields(value,['nonce','ciphertext','tag']);
  return {nonce:bytes(value.nonce,12),ciphertext:bytes(value.ciphertext,32),tag:bytes(value.tag,16)};
}
function seal(key,plaintext,associated) {
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce,{authTagLength:16});
  cipher.setAAD(Buffer.from(canonical(associated),'utf8'));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return {nonce:nonce.toString('base64url'),ciphertext:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
}
function unseal(key,s,associated) {
  const d=createDecipheriv('aes-256-gcm',key,s.nonce,{authTagLength:16});
  d.setAAD(Buffer.from(canonical(associated),'utf8')); d.setAuthTag(s.tag);
  const pending=d.update(s.ciphertext);
  try {return Buffer.concat([pending,d.final()]);}
  catch {throw Error('Invalid password or damaged wallet backup');}
  finally {pending.fill(0);}
}
async function kek(password,salt) {
  must(typeof password==='string' && password.length>0,'A nonempty file password is required');
  const buf=Buffer.from(password.normalize('NFC'),'utf8');
  try {return await derive(buf,salt,32,{N:131072,r:8,p:1,maxmem:192*1024*1024});}
  finally {buf.fill(0);}
}
export async function encryptWallet(w,password) {
  const seed=checkWallet(w),dek=randomBytes(32),salt=randomBytes(16);
  const header={format:'gpuchain-keystore',version:1,keyType:'Ed25519',address:w.address,origin:'imported-ed25519',path:null};
  const kdf={name:'scrypt',N:131072,r:8,p:1,salt:salt.toString('base64url')};
  let wrapping;
  try {
    wrapping=await kek(password,salt);
    const signingKey=seal(dek,seed,['gpuchain/signing-key/v1',header]);
    const wrappedKey=seal(wrapping,dek,['gpuchain/wrapped-key/v1',header,kdf,signingKey]);
    return {header,kdf,wrappedKey,signingKey};
  } finally {seed.fill(0);dek.fill(0);wrapping?.fill(0);}
}
async function unlock(doc,password,expectedAddress) {
  fields(doc,['header','kdf','wrappedKey','signingKey']);
  const {header,kdf}=doc;
  fields(header,['format','version','keyType','address','origin','path']);
  must(header.format==='gpuchain-keystore' && header.version===1 && header.keyType==='Ed25519' &&
    header.origin==='imported-ed25519' && header.path===null && /^[0-9a-f]{64}$/.test(header.address),'Unsupported wallet backup');
  must(expectedAddress===undefined || expectedAddress===header.address,'Unexpected backup address');
  fields(kdf,['name','N','r','p','salt']);
  must(kdf.name==='scrypt' && kdf.N===131072 && kdf.r===8 && kdf.p===1,'Unsupported backup KDF profile');
  const salt=bytes(kdf.salt,16),wrapped=slot(doc.wrappedKey),signing=slot(doc.signingKey);
  const wrapping=await kek(password,salt);
  let dek,seed,der;
  try {
    dek=unseal(wrapping,wrapped,['gpuchain/wrapped-key/v1',header,kdf,doc.signingKey]);
    seed=unseal(dek,signing,['gpuchain/signing-key/v1',header]);
    der=Buffer.concat([prefix,seed]);
    const privateKey=der.toString('base64');
    must(addressFromPrivateKey(privateKey)===header.address,'Restored signing key does not match its address');
    const challenge={domain:'gpuchain/offline-backup-test/v1',nonce:randomBytes(16).toString('hex')};
    must(verify(header.address,challenge,sign(privateKey,challenge)),'Restored key failed its signing self-test');
    return {address:header.address,privateKey};
  } finally {wrapping.fill(0);dek?.fill(0);seed?.fill(0);der?.fill(0);}
}

// Publish a synced, verified file with an exclusive hard link. A concurrent
// operation or an existing destination cannot replace a previous good copy.
async function writeNewVerified(path,value,verifyPath) {
  const dest=resolve(path),temp=dest+'.'+randomUUID()+'.tmp';
  const handle=await open(temp,'wx',0o600);
  try {
    try {
      if(process.platform==='win32') {
        const {stdout}=await exec('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true});
        const sid=stdout.match(/\bS-1-[0-9]+(?:-[0-9]+)+\b/i)?.[0];
        must(sid,'Unable to identify the Windows user for file protection');
        await exec('icacls.exe',[temp,'/inheritance:r','/grant:r','*'+sid+':(F)'],{windowsHide:true});
      }
      await handle.writeFile(JSON.stringify(value,null,2)+'\n');
      await handle.sync();
    } finally {await handle.close();}
    await verifyPath(temp);
    await link(temp,dest);
  } finally {await unlink(temp);}
}
export async function backupWallet(source,out,password) {
  const wallet=await readDoc(source);
  const backup=await encryptWallet(wallet,password);
  await writeNewVerified(out,backup,async path=>{await unlock(await readDoc(path),password,wallet.address);});
  return {address:wallet.address,backup:resolve(out),verified:true};
}
export async function verifyBackup(source,password,expectedAddress) {
  const {address}=await unlock(await readDoc(source),password,expectedAddress);
  return {address,verified:true};
}
export async function restoreWallet(source,out,password,expectedAddress) {
  const wallet=await unlock(await readDoc(source),password,expectedAddress);
  await writeNewVerified(out,wallet,async path=>{
    const restored=await readDoc(path);
    checkWallet(restored).fill(0);
    must(restored.address===wallet.address,'Restored file has the wrong address');
  });
  return {address:wallet.address,restored:resolve(out),verified:true};
}
