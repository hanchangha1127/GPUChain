import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupOpenCode } from '../scripts/setup-opencode.mjs';
import { generateWallet } from '../src/crypto.mjs';
import { MODEL } from '../src/ledger.mjs';
import { startOpenAiGateway } from '../src/openai-gateway.mjs';
import { backendReasoning } from '../src/reasoning.mjs';

async function tempDir(t) {
  const directory=await mkdtemp(join(tmpdir(),'gpuchain-opencode-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}

test('one-command OpenCode setup authenticates the local model and merges a file reference without running inference',async t=>{
  const directory=await tempDir(t);
  const configFile=join(directory,'opencode.json');
  const tokenPath=join(directory,'opencode.token');
  const original={model:'existing/model',providers:{existing:{name:'Existing'}}};
  await writeFile(configFile,JSON.stringify(original));
  let gateway,calls=0;
  t.after(()=>gateway?.close());
  const ops=[];
  async function control(op) {
    ops.push(op);
    if (op==='start' && !gateway) return {running:true};
    gateway??=await startOpenAiGateway({wallet:generateWallet(),token:await readFile(tokenPath,'utf8'),
      port:0,purchase:()=>{calls++;throw Error('Unexpected purchase');}});
    return {running:true,openAiUrl:gateway.url};
  }
  const result=await setupOpenCode({directory,configFile,control});
  const token=await readFile(tokenPath,'utf8');
  assert.match(token,/^[a-f0-9]{64}$/);
  if (process.platform!=='win32') assert.equal((await stat(tokenPath)).mode & 0o777,0o600);
  else {
    const verifyAcl=[
      '$acl=[IO.File]::GetAccessControl($env:GPUCHAIN_TEST_ACL_FILE)',
      '$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])',
      '$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      'if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $owner) { exit 1 }',
    ].join('\n');
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',verifyAcl],{
      windowsHide:true,env:{...process.env,GPUCHAIN_TEST_ACL_FILE:tokenPath}});
  }
  const raw=await readFile(configFile,'utf8'), config=JSON.parse(raw);
  assert.equal(raw.includes(token),false);
  assert.equal(JSON.stringify(result).includes(token),false);
  assert.equal(config.model,original.model);
  assert.deepEqual(config.providers.existing,original.providers.existing);
  const provider=config.providers.gpuchain;
  assert.equal(provider.settings.baseURL,gateway.url);
  assert.equal(provider.settings.apiKey,'{file:'+tokenPath.replaceAll('\\','/')+'}');
  assert.equal(provider.models[MODEL.toLowerCase()].compatibility.streamUsage,true);
  assert.equal(provider.models[MODEL.toLowerCase()].compatibility.supportsPromptCacheKey,true);
  assert.equal(provider.models[MODEL.toLowerCase()].modelID,MODEL);
  assert.deepEqual(ops,['start','opencode']);
  await setupOpenCode({directory,configFile,control});
  assert.deepEqual(ops,['start','opencode','start']);
  assert.equal(await readFile(tokenPath,'utf8'),token);
  assert.equal(await readFile(configFile,'utf8'),raw);
  assert.equal(calls,0);
});

test('JSONC and legacy schemas retain their original bytes and never enable a gateway on parse failure',async t=>{
  const directory=await tempDir(t);
  const configFile=join(directory,'opencode.jsonc');
  const control=()=>assert.fail('Unexpected participant startup');
  for (const [original,pattern] of [['{ // keep my comment\n"model":"other/m",}',/JSONC/],
      ['{"provider":{"other":{}}}',/OpenCode v1/]]) {
    await writeFile(configFile,original);
    await assert.rejects(setupOpenCode({directory,configFile,control}),pattern);
    assert.equal(await readFile(configFile,'utf8'),original);
    await assert.rejects(stat(join(directory,'opencode.token')),{code:'ENOENT'});
  }
});

test('all four installed OpenCode variants and a custom budget map to the engine request',async t=>{
  const directory=await tempDir(t),configFile=join(directory,'opencode.json');
  const custom={id:'high-512',body:{reasoning_effort:'high',reasoning_budget_tokens:512}};
  const modelKey=MODEL.toLowerCase();
  await writeFile(configFile,JSON.stringify({providers:{gpuchain:{models:{[modelKey]:{variants:[custom]}}}}}));
  const passed=[];
  let gateway,token;
  t.after(()=>gateway?.close());
  await setupOpenCode({directory,configFile,control:async()=>{
    token=await readFile(join(directory,'opencode.token'),'utf8');
    gateway=await startOpenAiGateway({wallet:generateWallet(),token,port:0,purchase:async input=>{
      passed.push(backendReasoning(input));
      return {message:{role:'assistant',content:'ok'},finishReason:'stop',
        usage:{inputTokens:1,cachedTokens:0,outputTokens:1}};
    }});
    return {openAiUrl:gateway.url};
  }});
  const model=JSON.parse(await readFile(configFile,'utf8')).providers.gpuchain.models[modelKey];
  assert.deepEqual(model.variants.map(v=>v.id),['none','low','medium','high','high-512']);
  for (const variant of model.variants) {
    const response=await fetch(gateway.url+'/chat/completions',{method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({model:model.modelID,messages:[{role:'user',content:'fixture'}],max_tokens:model.limit.output,...variant.body})});
    assert.equal(response.status,200);
    await response.arrayBuffer();
  }
  assert.deepEqual(passed,[...['none','low','medium','high'].map(reasoning_effort=>({reasoning_effort})),custom.body]);
});
