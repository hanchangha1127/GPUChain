const MAX_BYTES = 8 * 1024 * 1024;
const fail = message => { throw Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Share framing across the native Strata and signed GPUChain event streams.
export async function* readSse(stream) {
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let buffer = '', event = 'message', data = [], eventLength = 0, bytes = 0;
  for await (const part of stream) {
    bytes += typeof part === 'string' ? Buffer.byteLength(part) : part.byteLength;
    if (bytes > 64 * MAX_BYTES) fail('Event stream exceeds the wire limit');
    buffer += typeof part === 'string' ? part : decoder.decode(part,{stream:true});
    let begin = 0, end;
    while ((end = buffer.indexOf('\n',begin)) >= 0) {
      let line = buffer.slice(begin,end);
      begin = end + 1;
      if (line.endsWith('\r')) line = line.slice(0,-1);
      eventLength += line.length;
      if (eventLength > MAX_BYTES * 2) fail('SSE event exceeds the size limit');
      if (!line) {
        if (data.length) yield {event,data:data.join('\n')};
        event = 'message'; data = []; eventLength = 0;
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0,colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value || 'message';
      if (field === 'data') data.push(value);
    }
    buffer = buffer.slice(begin);
    if (eventLength + buffer.length > MAX_BYTES * 2) fail('SSE event exceeds the size limit');
  }
  buffer += decoder.decode();
  if (buffer || data.length) fail('Event stream ended inside a frame');
}

// Use identical assembly before signing and when checking deltas against the receipt.
export function createDeltaAccumulator() {
  let content = '', reasoning = '', hasReasoning = false, size = 0;
  const calls = [];
  const append = (old,fragment) => {
    if (typeof fragment !== 'string') fail('Invalid text in assistant delta');
    size += Buffer.byteLength(fragment);
    if (size > MAX_BYTES) fail('Assistant response exceeds the size limit');
    return old + fragment;
  };
  function push(delta) {
    if (!object(delta) || Object.keys(delta).some(k=>!['role','content','reasoning_content','tool_calls'].includes(k)) ||
        (delta.role !== undefined && delta.role !== 'assistant')) fail('Invalid assistant delta');
    if (delta.content != null) content = append(content,delta.content);
    if (delta.reasoning_content != null) {
      hasReasoning = true;
      reasoning = append(reasoning,delta.reasoning_content);
    }
    if (delta.tool_calls == null) return;
    if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 128) fail('Invalid streamed tool calls');
    for (const part of delta.tool_calls) {
      if (!object(part) || !Number.isInteger(part.index) || part.index < 0 || part.index > calls.length ||
          part.index >= 128 || (part.type !== undefined && part.type !== 'function') ||
          (part.function !== undefined && !object(part.function)) ||
          Object.keys(part).some(k=>!['index','id','type','function'].includes(k)) ||
          Object.keys(part.function ?? {}).some(k=>!['name','arguments'].includes(k))) fail('Invalid streamed tool call');
      const call = calls[part.index] ??= {id:'',type:'function',function:{name:'',arguments:''}};
      if (part.id !== undefined) call.id = append(call.id,part.id);
      if (part.function?.name !== undefined) call.function.name = append(call.function.name,part.function.name);
      if (part.function?.arguments !== undefined) call.function.arguments = append(call.function.arguments,part.function.arguments);
    }
  }
  function message() {
    return {role:'assistant',content:content || (calls.length ? null : ''),
      ...(hasReasoning ? {reasoning_content:reasoning} : {}), ...(calls.length ? {tool_calls:calls} : {})};
  }
  return {push,message};
}

export async function readStrataCompletion(response, modelId, onDelta) {
  if (response.headers['content-type']?.split(';')[0].trim() !== 'text/event-stream') {
    response.destroy();
    fail('Strata did not return an event stream');
  }
  const assembled = createDeltaAccumulator();
  let finish, usage, done = false;
  for await (const {event,data} of readSse(response)) {
    if (done || event !== 'message') fail('Unexpected Strata event');
    if (data === '[DONE]') { done = true; continue; }
    const chunk = JSON.parse(data);
    if (chunk?.model !== modelId || !Array.isArray(chunk.choices) || chunk.choices.length > 1 ||
        chunk.error) fail('Unexpected Strata stream chunk');
    const choice = chunk.choices[0];
    if (choice) {
      if (finish || choice.index !== 0 || !object(choice.delta)) fail('Invalid Strata choice sequence');
      assembled.push(choice.delta);
      if (Object.keys(choice.delta).length) await onDelta(choice.delta);
      if (choice.finish_reason != null) {
        if (!['stop','length','tool_calls'].includes(choice.finish_reason)) fail('Unexpected Strata finish reason');
        finish = choice.finish_reason;
      }
    }
    if (chunk.usage != null) {
      if (!finish || usage) fail('Unexpected Strata usage sequence');
      usage = chunk.usage;
    }
  }
  if (!done || !finish || !usage) fail('Incomplete Strata event stream');
  return {model:modelId,choices:[{finish_reason:finish,message:assembled.message()}],usage};
}
