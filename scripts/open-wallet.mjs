#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--print-url')) {
    throw Error('Usage: node scripts/open-wallet.mjs [--print-url]');
  }
  const manager = fileURLToPath(new URL('./participant.mjs',import.meta.url));
  const {stdout} = await promisify(execFile)(process.execPath,[manager,'start'],{windowsHide:true});
  const state = JSON.parse(stdout);
  if (!state.running || !state.guiUrl) {
    throw Error('This participant has no wallet GUI. Run npm stop and npm start from the updated checkout, then npm run gui.');
  }
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(state.guiUrl);
  if (!match || Number(match[1]) > 65535) throw Error('Expected a loopback wallet GUI address');
  const url = 'http://127.0.0.1:'+match[1]+'/';
  console.log(url);
  if (args[0] === '--print-url') return;

  const system32 = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows','System32') : undefined;
  const command = system32 ? join(system32,'rundll32.exe')
    : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const parameters = system32 ? [join(system32,'url.dll')+',FileProtocolHandler',url] : [url];
  const browser = spawn(command,parameters,{detached:true,stdio:'ignore',windowsHide:true});
  await once(browser,'spawn');
  browser.unref();
}

main(process.argv.slice(2)).catch(err=>{console.error(err.message);process.exitCode=1;});
