#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CONTEXT, MODEL } from '../src/ledger.mjs';
import { protectFile } from '../src/private-file.mjs';
import { participantDir } from '../src/participant-config.mjs';
import { REASONING_EFFORTS } from '../src/reasoning.mjs';

const run=promisify(execFile);
const manager=fileURLToPath(new URL('participant.mjs',import.meta.url));
const modelKey=MODEL.toLowerCase();
const missing=error=>{if(error.code!=='ENOENT') throw error;};

async function manage(command) {
  const {stdout}=await run(process.execPath,[manager,command],{windowsHide:true,timeout:75_000});
  return JSON.parse(stdout.trim());
}

async function ensureToken(path) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  if (!await lstat(path).catch(missing)) {
    const tmp=path+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,'',{flag:'wx',mode:0o600});
    try {
      await protectFile(tmp);
      await writeFile(tmp,randomBytes(32).toString('hex'));
      try { await link(tmp,path); } catch (error) { if(error.code!=='EEXIST') throw error; }
    } finally { await unlink(tmp); }
  }
  if (!(await lstat(path)).isFile()) throw Error('Expected a regular local opencode.token file');
  await protectFile(path);
  const token=(await readFile(path,'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw Error('Invalid existing opencode.token file');
  return token;
}

async function defaultConfig() {
  const directory=join(process.env.XDG_CONFIG_HOME || join(homedir(),'.config'),'opencode');
  const json=join(directory,'opencode.json');
  const jsonc=json+'c';
  return await lstat(jsonc).catch(missing) ? jsonc : json;
}

const isObject=value=>value && typeof value==='object' && !Array.isArray(value);
function parseConfig(raw,path) {
  let config;
  try { config=JSON.parse(raw?.replace(/^\uFEFF/,'') ?? '{}'); }
  catch {
    throw Error('Cannot update '+path+' as plain JSON. For JSONC, generate a separate provider file with --config NEW_FILE.json and copy its providers.gpuchain entry into your config, keeping your comments.');
  }
  if (!isObject(config) || (config.providers!==undefined && !isObject(config.providers))) throw Error('Invalid OpenCode providers configuration');
  if ('provider' in config && !('providers' in config)) throw Error('This configuration uses OpenCode v1. Migrate to OpenCode 2.x before running setup.');
  return config;
}

function providerConfig(baseURL,tokenPath,previous={}) {
  const output=4096;
  const existing=previous.models?.[modelKey]?.variants ?? [];
  if (!Array.isArray(existing)) throw Error('Expected OpenCode 2.x model variants as an array');
  const variants=REASONING_EFFORTS.map(id=>{
    const old=existing.find(variant=>variant.id===id);
    return {...old,id,body:{...old?.body,reasoning_effort:id}};
  });
  variants.push(...existing.filter(variant=>!REASONING_EFFORTS.includes(variant.id)));
  return {...previous,name:previous.name ?? 'GPUChain',package:'@opencode/ai/providers/openai-compatible',
    settings:{...previous.settings,baseURL,apiKey:'{file:'+tokenPath.replaceAll('\\','/')+'}'},
    models:{...previous.models,[modelKey]:{
      ...previous.models?.[modelKey],modelID:MODEL,name:MODEL+' (GPUChain)',type:'chat',
      capabilities:{tools:true,input:['text'],output:['text'],reasoning:{supported:true,effort:['low','medium','high'],toggle:true}},
      compatibility:{reasoningField:'reasoning_content',maxTokensField:'max_tokens',supportsPromptCacheKey:true,streamUsage:true},
      limit:{context:CONTEXT,input:CONTEXT-output,output},variants,
    }}};
}

export async function setupOpenCode({directory=participantDir(),configFile,control=manage}={}) {
  const path=resolve(configFile ?? await defaultConfig());
  const existing=await lstat(path).catch(missing);
  if (existing && !existing.isFile()) throw Error('Expected a regular OpenCode config file: '+path);
  const raw=await readFile(path,'utf8').catch(missing);
  const config=parseConfig(raw,path);
  const tokenPath=resolve(directory,'opencode.token');
  const token=await ensureToken(tokenPath);
  let {openAiUrl}=await control('start');
  if (!openAiUrl) {
    try { ({openAiUrl}=await control('opencode')); }
    catch { throw Error('Could not enable inference on the running participant. Run npm stop, then npm run opencode:setup from this checkout.'); }
  }
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/.test(openAiUrl)) throw Error('Participant did not report a local OpenAI gateway. Run npm stop, then npm run opencode:setup.');
  const response=await fetch(openAiUrl+'/models',{redirect:'error',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
  if (!response.ok || !(await response.json()).data?.some(model=>model.id===MODEL)) throw Error('Could not authenticate the local GPUChain model endpoint');
  config.providers??={};
  config.providers.gpuchain=providerConfig(openAiUrl,tokenPath,config.providers.gpuchain);
  if (!raw || JSON.stringify(parseConfig(raw,path))!==JSON.stringify(config)) {
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const tmp=path+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,'',{flag:'wx',mode:0o600});
    try {
      // Existing config files can contain credentials for unrelated providers.
      // Preserve their access rules before putting any values in the new file.
      await protectFile(tmp,existing ? path : undefined);
      await writeFile(tmp,JSON.stringify(config,null,2)+'\n');
      if (raw===undefined) await link(tmp,path);
      else {
        if (raw!==await readFile(path,'utf8')) throw Error('OpenCode config changed during setup. Run setup again.');
        await rename(tmp,path);
      }
    } finally { await unlink(tmp).catch(missing); }
  }
  return {model:'gpuchain/'+modelKey,baseURL:openAiUrl,config:path};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values}=parseArgs({options:{config:{type:'string'}}});
    const setup=await setupOpenCode({configFile:values.config});
    console.log('Configured '+setup.model+' in '+setup.config+'\nOpenCode base URL: '+setup.baseURL+
      '\nReopen OpenCode and select '+setup.model+' in /models.');
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
