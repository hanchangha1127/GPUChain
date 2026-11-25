import { hash } from './crypto.mjs';
import { requestJsonResponse } from './http.mjs';
import { createDeltaAccumulator, readSse } from './strata-stream.mjs';

// Both transports expose the same OpenAI deltas. Accumulate exactly what the
// client saw, so only a matching signed final message can authorize payment.
export function trackAssistantDeltas(onDelta) {
  const assistant = createDeltaAccumulator();
  return {
    async push(delta) {
      assistant.push(delta);
      await onDelta(delta);
    },
    verify(message) {
      if (hash(assistant.message()) !== hash(message)) throw Error('Stream differs from signed assistant message');
    }
  };
}

export async function streamAdapter(url, body, onDelta, options = {}) {
  const res = await requestJsonResponse(url, {timeoutMs:3_630_000, ...options, body,
    headers:{...options.headers, accept:'text/event-stream'}});
  if (res.headers['content-type']?.split(';',1)[0].trim().toLowerCase() !== 'text/event-stream') {
    res.destroy();
    throw Error('Provider did not return an event stream');
  }
  let receipt;
  try {
    for await (const {event,data} of readSse(res)) {
      if (receipt) throw Error('Unexpected data after provider receipt');
      const value = JSON.parse(data);
      if (event === 'delta') await onDelta(value);
      else if (event === 'receipt' && value && typeof value === 'object') receipt = value;
      else if (event === 'error') throw Object.assign(
        Error('Provider stream failed: ' + String(value?.error ?? 'Protocol error').slice(0,240)),
        {adapterRejected:true});
      else throw Error('Unknown provider stream event');
    }
    if (!receipt) throw Error('Provider stream ended before the receipt');
    return receipt;
  } finally {
    res.destroy();
  }
}
