import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const windowsPowerShell=join(process.env.SystemRoot ?? 'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const run=promisify(execFile);
const LIMIT=4096;
function must(ok,message) { if (!ok) throw Error(message); }

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
export async function readWalletDocument(file) {
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
export async function protectFile(path,copyAccessFrom) {
  if (process.platform!=='win32') {
    return chmod(path,copyAccessFrom ? (await lstat(copyAccessFrom)).mode & 0o777 : 0o600);
  }
  // POSIX modes do not restrict Windows ACLs. Publish an owner-only file
  // even when the participant directory itself has an inherited group ACL.
  const script=[
    "$ErrorActionPreference='Stop'",
    '$acl=New-Object Security.AccessControl.FileSecurity',
    'if ($env:GPUCHAIN_COPY_ACCESS_FROM) {',
    '$access=[Security.AccessControl.AccessControlSections]::Access',
    '$source=[IO.File]::GetAccessControl($env:GPUCHAIN_COPY_ACCESS_FROM,$access)',
    '$acl.SetSecurityDescriptorSddlForm($source.GetSecurityDescriptorSddlForm($access),$access)',
    '} else {',
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl.SetAccessRuleProtection($true,$false)',
    '$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","Allow"))',
    '}',
    '[IO.File]::SetAccessControl($env:GPUCHAIN_PRIVATE_FILE,$acl)',
  ].join('\n');
  await run(windowsPowerShell,['-NoProfile','-NonInteractive','-Command',script],{
    windowsHide:true,env:{...process.env,GPUCHAIN_PRIVATE_FILE:path,GPUCHAIN_COPY_ACCESS_FROM:copyAccessFrom ?? ''}});
}

// Publish a synced, verified file with an exclusive hard link. A concurrent
// operation or an existing destination cannot replace a previous good copy.
export async function writeVerifiedDocument(path,value,verifyPath,beforeReplace) {
  const dest=resolve(path),temp=dest+'.'+randomUUID()+'.tmp';
  const handle=await open(temp,'wx',0o600);
  try {
    try {
      await protectFile(temp);
      await handle.writeFile(JSON.stringify(value,null,2)+'\n');
      await handle.sync();
    } finally {await handle.close();}
    await verifyPath(temp);
    if (beforeReplace) {
      await beforeReplace(dest);
      await rename(temp,dest);
    } else await link(temp,dest);
  } finally {await unlink(temp).catch(err=>{if (err.code!=='ENOENT') throw err;});}
}
