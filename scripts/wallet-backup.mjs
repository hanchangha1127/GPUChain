#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { participantDir } from '../src/participant-config.mjs';
import { backupWallet, restoreWallet, verifyBackup } from '../src/wallet-backup.mjs';

const help=`GPUChain wallet backup
  backup  [--wallet SOURCE] [--out NEW_BACKUP]
  verify  --in BACKUP [--address EXPECTED_PUBLIC_ADDRESS]
  restore --in BACKUP --out NEW_WALLET [--address EXPECTED_PUBLIC_ADDRESS]
Passwords are entered privately in a local terminal. Keep a separate copy of the encrypted backup.`;

async function hidden(prompt) {
  if(!process.stdin.isTTY || !process.stdout.isTTY) throw Error('비밀번호는 로컬 대화형 터미널에서 입력하세요.');
  process.stdout.write(prompt);
  const mute=new Writable({write(_chunk,_encoding,done){done();}});
  const rl=createInterface({input:process.stdin,output:mute,terminal:true,historySize:0});
  try {
    return await new Promise((resolveValue,reject)=>{
      rl.once('SIGINT',()=>reject(Error('입력이 취소됐습니다.')));
      rl.once('close',()=>reject(Error('비밀번호 입력이 끝나지 않았습니다.')));
      rl.question('',resolveValue);
    });
  } finally {rl.close();mute.end();process.stdout.write('\n');}
}
async function existingWalletFile() {
  if(process.env.GPUCHAIN_VALIDATOR_WALLET)return resolve(process.env.GPUCHAIN_VALIDATOR_WALLET);
  const dir=participantDir();
  try {
    const info=JSON.parse(await readFile(join(dir,'participant.json'),'utf8'));
    if(typeof info.walletFile!=='string' || !info.walletFile)throw Error('Invalid participant wallet location');
    return resolve(info.walletFile);
  } catch(err) {
    if(err.code!=='ENOENT')throw err;
    return join(dir,'validator.wallet.json');
  }
}
async function main() {
  const [command='backup',...args]=process.argv.slice(2);
  if(['help','--help','-h'].includes(command))return console.log(help);
  const flags={backup:['wallet','out'],verify:['in','address'],restore:['in','out','address']};
  if(!Object.hasOwn(flags,command))throw Error(help);
  const {values:v}=parseArgs({args,options:Object.fromEntries(flags[command].map(name=>[name,{type:'string'}]))});
  if(v.address && !/^[a-f0-9]{64}$/.test(v.address))throw Error('공개 주소는 소문자 16진수 64자리여야 합니다.');
  if(command!=='backup' && !v.in)throw Error('--in BACKUP 파일이 필요합니다.');
  if(command==='restore' && !v.out)throw Error('--out NEW_WALLET 파일이 필요합니다.');
  if(command==='backup') {
    const source=v.wallet?resolve(v.wallet):await existingWalletFile();
    const folder=join(homedir(),'.gpuchain','backups');
    const out=v.out?resolve(v.out):join(folder,'gpuchain-'+new Date().toISOString().replace(/[:.]/g,'-')+'.keystore.json');
    console.log('원본 지갑',source,'\n암호화 백업 위치',out);
    console.log('백업 파일과 비밀번호를 각각 보관하세요. 이 지갑의 기존 주소를 복구하는 데 둘 다 필요합니다.');
    const first=await hidden('새 백업 비밀번호 (화면에 표시되지 않음): ');
    if(!first)throw Error('빈 비밀번호로 백업할 수 없습니다.');
    const second=await hidden('새 백업 비밀번호 확인: ');
    if(first.normalize('NFC')!==second.normalize('NFC'))throw Error('두 비밀번호가 다릅니다.');
    if(!v.out)await mkdir(folder,{recursive:true,mode:0o700});
    console.log(JSON.stringify(await backupWallet(source,out,first),null,2));
  } else {
    const pass=await hidden('백업 비밀번호 (화면에 표시되지 않음): ');
    const result=command==='verify'?await verifyBackup(v.in,pass,v.address):await restoreWallet(v.in,v.out,pass,v.address);
    console.log(JSON.stringify(result,null,2));
  }
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
