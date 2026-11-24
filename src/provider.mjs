import http from 'node:http';
import { hash, sign, verify } from './crypto.mjs';
import { charge, CONTEXT, MODEL } from './ledger.mjs';
import { readVerifiedState } from './node.mjs';
import { requestJson } from './http.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;
const REQUEST_FIELDS = ['chainId', 'expiresAt', 'maxInputTokens', 'maxOutputTokens', 'messagesHash',
  'nonce', 'payer', 'provider', 'type'].sort();

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, status, reason) {
  if (!condition) throw new ProviderError(status, reason);
}

function isCount(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function backendBase(strataUrl) {
  const url = new URL(strataUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireValue(url.protocol === 'https:' || (local && url.protocol === 'http:'), 400,
    'Strata must use loopback HTTP or HTTPS');
  requireValue(!url.username && !url.password && !url.search && !url.hash &&
    ['/', '/v1', '/v1/'].includes(url.pathname), 400, 'Expected a Strata origin or /v1 URL');
  return url.origin + '/v1';
}

async function readBody(stream) {
  let size = 0;
  const chunks = [];
  for await (const part of stream) {
    size += part.byteLength;
    requireValue(size <= MAX_BYTES, 413, 'JSON body is too large');
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProviderError(400, 'Invalid JSON body');
  }
}

function checkRequest({ request, signature, messages }, chainId, provider) {
  requireValue(request && typeof request === 'object' &&
    Object.keys(request).sort().join('|') === REQUEST_FIELDS.join('|'), 400, 'Invalid request fields');
  requireValue(request.type === 'inference-request' && request.chainId === chainId &&
    request.provider === provider && request.payer !== provider && typeof request.payer === 'string' &&
    /^[0-9a-f]{64}$/.test(request.payer) && typeof request.messagesHash === 'string' &&
    /^[0-9a-f]{64}$/.test(request.messagesHash),
    400, 'Wrong chain, payer or provider');
  const now = Date.now();
  requireValue(isCount(request.expiresAt) && request.expiresAt > now &&
    request.expiresAt <= now + MAX_REQUEST_AGE_MS, 400, 'Request expiry must be within ten minutes');
  requireValue(isCount(request.nonce, 1) && isCount(request.maxInputTokens, 1) &&
    isCount(request.maxOutputTokens, 1) && request.maxInputTokens + request.maxOutputTokens <= CONTEXT,
    400, 'Invalid nonce or token budget');
  requireValue(typeof signature === 'string' && verify(request.payer, request, signature), 403,
    'Invalid request signature');
  requireValue(Array.isArray(messages) && messages.length > 0 && messages.length <= 4096, 400,
    'Expected a nonempty text conversation');
  for (const [index, item] of messages.entries()) {
    requireValue(item && typeof item === 'object' && Object.keys(item).length === 2 &&
      (['user', 'assistant'].includes(item.role) || (index === 0 && item.role === 'system')) &&
      typeof item.content === 'string', 400, 'Expected text messages with an optional leading system message');
  }
  requireValue(messages.some(item => item.role === 'user') && request.messagesHash === hash(messages),
    400, 'Missing user message or mismatched messages hash');
}

export function createProviderServer({ wallet, chainId, ledgerUrl, strataUrl = 'http://127.0.0.1:8000/v1',
  modelId = 'qwen3.8-flash-next-q2_0', apiKey, timeoutMs = 60 * 60 * 1000,
  readState = readVerifiedState }) {
  const base = backendBase(strataUrl);
  requireValue(/^(?:qwen\/)?qwen3\.8-flash-next(?:$|[-:_][a-z0-9._-]+$)/i.test(modelId),
    400, 'Backend model ID must identify Qwen3.8-Flash-Next');
  requireValue(/^[0-9a-f]{64}$/.test(chainId) && isCount(timeoutMs, 1) &&
    timeoutMs <= 2147483647, 400, 'Invalid chain ID or timeout');
  const seen = new Map();
  let busy = false;
  // Cache only the latest response so a dropped connection can be retried without retaining every chat.
  let previous;
  let clearPrevious;

  async function backend(path, body, deadline = 10_000) {
    const headers = {};
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    try {
      return await requestJson(base + path, { headers, body, timeoutMs: deadline, maxBytes: MAX_BYTES });
    } catch (err) {
      if (err.status) throw new ProviderError(502, 'Strata returned HTTP ' + err.status);
      throw new ProviderError(503, 'Could not reach the configured Strata backend');
    }
  }

  async function profile() {
    const models = await backend('/models');
    const model = models?.data?.find(item => item.id === modelId && !item.alias_of);
    requireValue(model?.status?.value === 'loaded', 503, 'Configured Strata model is not loaded');
    const capacity = model.context_length ?? model.max_model_len ?? model.limit?.context;
    requireValue(isCount(capacity, CONTEXT), 503, 'Strata reports less than 262144 context tokens');
    return { capacity, outputLimit: model.limit?.output };
  }

  async function infer(body) {
    const { request, messages } = body;
    checkRequest(body, chainId, wallet.address);
    let state;
    try { state = await readState(ledgerUrl, chainId); }
    catch { throw new ProviderError(503, 'Could not verify pinned ledger'); }
    requireValue(state.chainId === chainId && state.providers.includes(wallet.address), 403,
      'Provider is not registered on this chain');
    requireValue(request.nonce === (state.nonces[request.payer] ?? 0) + 1, 409, 'Payer nonce changed');
    requireValue(request.maxOutputTokens <= state.maxOutputTokens, 400, 'Output budget exceeds epoch limit');
    const reserve = charge({ inputTokens: request.maxInputTokens, cachedTokens: 0,
      outputTokens: request.maxOutputTokens });
    requireValue((state.balances[request.payer] ?? 0) >= reserve, 402, 'Insufficient balance for request budget');
    const requestHash = hash(request);
    const key = request.payer + ':' + request.nonce;
    const now = Date.now();
    for (const [id, until] of seen) if (until <= now) seen.delete(id);
    if (previous && previous.expiresAt <= now) previous = undefined;
    if (previous?.hash === requestHash) return previous.result;
    requireValue(!seen.has(key), 409, 'Request nonce has already been used at this provider');
    requireValue(seen.size < 4096, 503, 'Provider replay window is full');
    const { capacity, outputLimit } = await profile();
    requireValue(!isCount(outputLimit, 1) || request.maxOutputTokens <= outputLimit,
      400, 'Output budget exceeds Strata output limit');
    if (request.maxInputTokens < capacity - request.maxOutputTokens) {
      // RYZENStrata exposes its template/tokenizer through the Anthropic counting endpoint.
      const system = messages[0].role === 'system' ? messages[0].content : undefined;
      const estimate = await backend('/messages/count_tokens', {
        model: modelId, messages: system === undefined ? messages : messages.slice(1), system
      });
      requireValue(isCount(estimate?.input_tokens, 1), 502, 'Strata did not return a prompt count');
      requireValue(estimate.input_tokens <= request.maxInputTokens, 400, 'Prompt exceeds signed input budget');
    }
    requireValue(request.expiresAt > Date.now(), 400, 'Request expired before inference');
    const answer = await backend('/chat/completions', { model: modelId, messages,
      max_tokens: request.maxOutputTokens, stream: false }, timeoutMs);
    const choice = answer?.choices?.[0];
    requireValue(answer?.model === modelId && choice?.message?.role === 'assistant' &&
      ['stop', 'length'].includes(choice.finish_reason), 502, 'Incomplete or unexpected Strata completion');
    const { content, reasoning_content: reasoning } = choice.message;
    requireValue((typeof content === 'string' || (content === null && typeof reasoning === 'string')) &&
      (reasoning == null || typeof reasoning === 'string'), 502, 'Invalid assistant content');
    const message = { role: 'assistant', content };
    if (typeof reasoning === 'string') message.reasoning_content = reasoning;
    const usage = answer.usage;
    const inputTokens = usage?.prompt_tokens;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
    const outputTokens = usage?.completion_tokens;
    requireValue(isCount(inputTokens, 1) && isCount(cachedTokens) && cachedTokens <= inputTokens &&
      isCount(outputTokens, 1) && inputTokens <= request.maxInputTokens &&
      outputTokens <= request.maxOutputTokens &&
      (usage.total_tokens === undefined || usage.total_tokens === inputTokens + outputTokens),
      502, 'Missing, inconsistent or out-of-budget Strata usage');
    const payload = { type: 'inference', chainId, from: request.payer, provider: wallet.address,
      nonce: request.nonce, model: MODEL, contextWindow: CONTEXT, requestHash, responseHash: hash(message),
      inputTokens, cachedTokens, outputTokens };
    const result = { message, payload, providerSignature: sign(wallet.privateKey, payload) };
    seen.set(key, request.expiresAt);
    previous = { hash: requestHash, result, expiresAt: request.expiresAt };
    clearTimeout(clearPrevious);
    clearPrevious = setTimeout(() => { previous = undefined; }, Math.max(1, request.expiresAt - Date.now()));
    clearPrevious.unref();
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'GET' && req.url === '/v1/info') {
        await profile();
        return send(200, { provider: wallet.address, chainId, model: MODEL, contextWindow: CONTEXT,
          backendModel: modelId });
      }
      requireValue(req.method === 'POST' && req.url === '/v1/infer', 404, 'Route not found');
      requireValue((req.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json',
        415, 'Expected application/json');
      requireValue(!busy, 429, 'Provider is handling another request');
      const body = await readBody(req);
      requireValue(body && typeof body === 'object', 400, 'Expected JSON object');
      requireValue(!busy, 429, 'Provider is handling another request');
      busy = true;
      try { send(200, await infer(body)); }
      finally { busy = false; }
    } catch (err) {
      send(err instanceof ProviderError ? err.status : 500,
        { error: err instanceof ProviderError ? err.message : 'Provider request failed' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 32;
  server.on('close', () => { clearTimeout(clearPrevious); previous = undefined; seen.clear(); });
  return server;
}
