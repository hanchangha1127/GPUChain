import { canonical, hash } from './crypto.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nameOk = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);
function need(ok,why) { if (!ok) throw Error(why); }
function keys(x,allowed,label) {
  need(object(x) && Object.keys(x).every(k=>allowed.includes(k)), 'Unsupported '+label+' fields');
}
function text(value) {
  if (typeof value === 'string') return value;
  need(Array.isArray(value),'Expected text content');
  return value.map(p=>{
    keys(p,['type','text'],'content part');
    need(p.type === 'text' && typeof p.text === 'string','Only text content parts are supported');
    return p.text;
  }).join('');
}
function callList(calls) {
  need(Array.isArray(calls) && calls.length>0 && calls.length<=128,'Invalid tool calls');
  const ids=new Set();
  return calls.map(c=>{
    keys(c,['id','type','function'],'tool call');
    need(typeof c.id==='string' && c.id.length>0 && c.id.length<=256 && !ids.has(c.id) &&
      c.type==='function','Invalid or duplicate function call ID');
    ids.add(c.id);
    keys(c.function,['name','arguments'],'function call');
    need(nameOk(c.function.name) && typeof c.function.arguments==='string','Invalid function call');
    need(object(JSON.parse(c.function.arguments)),'Expected a JSON object for function arguments');
    return {id:c.id,type:'function',function:{name:c.function.name,arguments:c.function.arguments}};
  });
}
function assistant(m) {
  keys(m,['role','content','tool_calls','reasoning_content','name'],'assistant message');
  const out={role:'assistant',content:m.content==null?null:text(m.content)};
  if (m.reasoning_content!=null) {
    need(typeof m.reasoning_content==='string','Invalid reasoning content');
    out.reasoning_content=m.reasoning_content;
  }
  if (m.tool_calls?.length) out.tool_calls=callList(m.tool_calls);
  else need(m.tool_calls==null || Array.isArray(m.tool_calls),'Invalid tool calls');
  need(out.content!==null || out.tool_calls || out.reasoning_content!==undefined,'Empty assistant message');
  return out;
}

export function normalizeChatMessages(messages) {
  need(Array.isArray(messages) && messages.length>0 && messages.length<=4096,'Expected a chat conversation');
  const pending = new Set();
  const normalized = messages.map(m=>{
    need(object(m),'Invalid message');
    // Legacy names are not template inputs on the supported Strata backends.
    if (m.name!==undefined) need(nameOk(m.name),'Invalid message name');
    if (m.role==='tool') {
      keys(m,['role','tool_call_id','content','name'],'tool result');
      need(pending.delete(m.tool_call_id),'Unknown or duplicate tool result ID');
      return {role:'tool',tool_call_id:m.tool_call_id,content:text(m.content)};
    }
    need(!pending.size,'Missing a tool result before the next turn');
    if (m.role==='assistant') {
      const out=assistant(m);
      for (const c of out.tool_calls ?? []) pending.add(c.id);
      return out;
    }
    keys(m,['role','content','name'],'message');
    need(['developer','system','user'].includes(m.role),'Unsupported message role');
    return {role:m.role==='developer'?'system':m.role,content:text(m.content)};
  });
  need(!pending.size && normalized.some(m=>m.role==='user'),'Incomplete conversation');
  return normalized;
}

function normalizeTools(tools) {
  need(Array.isArray(tools) && tools.length<=256,'Invalid function tools');
  const names = new Set();
  const normalized=tools.map(t=>{
    keys(t,['type','function'],'tool');
    const f=t.function;
    need(t.type==='function' && object(f) && nameOk(f.name) && !names.has(f.name),'Invalid or duplicate function tool');
    keys(f,['name','description','parameters','strict'],'function tool');
    need(f.strict===undefined || f.strict===false,'Strict schema generation is unsupported');
    need(f.description===undefined || typeof f.description==='string','Invalid function description');
    need(f.parameters===undefined || object(f.parameters),'Invalid function parameters');
    names.add(f.name);
    // Stable schema order keeps repeated OpenCode turns eligible for prefix-cache hits.
    return {type:'function',function:{name:f.name,description:f.description ?? '',
      parameters:JSON.parse(canonical(f.parameters ?? {type:'object',properties:{}}))}};
  });
  // Tool registries may enumerate the same functions in different orders between turns.
  return normalized.sort((a,b)=>a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0);
}

export function normalizeChatOptions(input) {
  keys(input,['tools','tool_choice','parallel_tool_calls','temperature','top_p','stop','seed','presence_penalty','frequency_penalty','stream'],'chat option');
  const out={};
  if (input.tools!==undefined) out.tools=normalizeTools(input.tools);
  const choice=input.tool_choice;
  if (choice!==undefined) {
    if (typeof choice==='string') need(['auto','none','required'].includes(choice),'Invalid tool choice');
    else {
      keys(choice,['type','function'],'tool choice');
      keys(choice.function,['name'],'tool choice function');
      need(choice.type==='function' && out.tools?.some(t=>t.function.name===choice.function.name),'Unknown tool choice');
    }
    if (choice==='required') need(out.tools?.length,'A required tool must be declared');
    out.tool_choice=choice;
  }
  for (const k of ['stream','parallel_tool_calls']) if (input[k]!==undefined) {
    need(typeof input[k]==='boolean','Invalid '+k);
    out[k]=input[k];
  }
  for (const [k,min,max] of [['temperature',0,2],['top_p',0,1],['presence_penalty',-2,2],['frequency_penalty',-2,2]]) {
    if (input[k]!==undefined) {
      need(Number.isFinite(input[k]) && input[k]>=min && input[k]<=max,'Invalid '+k);
      out[k]=input[k];
    }
  }
  if (input.seed!==undefined) {
    need(Number.isSafeInteger(input.seed) && input.seed>=1 && input.seed<=2147483647,'Seed must be a positive 32-bit integer');
    out.seed=input.seed;
  }
  if (input.stop!==undefined && input.stop!==null) {
    const stops=typeof input.stop==='string'?[input.stop]:input.stop;
    need(Array.isArray(stops) && stops.length<=4 && stops.every(s=>typeof s==='string' && s.length>0),'Invalid stop sequences');
    out.stop=input.stop;
  }
  return out;
}

export function validateChatReply(message,finishReason,options) {
  need(message?.role==='assistant' && ['stop','length','tool_calls'].includes(finishReason),'Invalid completion or finish reason');
  const out=assistant(message);
  const calls=out.tool_calls ?? [];
  if (finishReason==='tool_calls') need(calls.length,'Missing completed tool call');
  if (finishReason==='stop' && (options?.tool_choice==='required' || object(options?.tool_choice))) {
    need(calls.length,'Missing required tool call');
  }
  if (calls.length) {
    need(options?.tool_choice!=='none' && (options?.parallel_tool_calls!==false || calls.length===1),'Unexpected tool calls');
    for (const c of calls) {
      need(options?.tools?.some(t=>t.function.name===c.function.name),'Undeclared tool in reply');
      if (object(options.tool_choice)) need(options.tool_choice.function.name===c.function.name,'Unexpected tool choice');
    }
  }
  return out;
}
export const chatResponseHash = (message,finishReason) => hash(finishReason===undefined?message:{message,finishReason});

// Strata's count endpoint accepts Anthropic Messages. Use the same system text,
// tool schema and full tool history that its OpenAI chat adapter renders.
export function richCountBody(messages,options) {
  const converted=messages.map(m=>{
    if (m.role==='tool') return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]};
    if (m.role!=='assistant' || !(m.reasoning_content || m.tool_calls)) return m;
    const content=[];
    if (m.reasoning_content) content.push({type:'thinking',thinking:m.reasoning_content});
    if (m.content) content.push({type:'text',text:m.content});
    for (const c of m.tool_calls ?? []) content.push({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments)});
    return {role:'assistant',content};
  });
  const body={messages:converted};
  if (options.tool_choice!=='none' && options.tools?.length) {
    body.tools=options.tools.map(({function:f})=>({name:f.name,description:f.description,input_schema:f.parameters}));
  }
  return body;
}
