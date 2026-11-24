import { randomBytes, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { verify } from './crypto.mjs';
import { requestJson } from './http.mjs';
import { CONTEXT, MODEL } from './ledger.mjs';
import { isLoopbackEndpoint, normalizeProviderEndpoint } from './provider-endpoint.mjs';
import { kvCacheAtLeastQ8 } from './kv-cache.mjs';

export const PROBE_DOMAIN = 'gpuchain/provider-probe/v1';
const CONCURRENCY = 8;
const TIMEOUT_MS = 900;
const BUDGET_MS = 3000;
const MAX_CANDIDATES = 64;

export async function probeProvider(candidate, chainId, minOutput, reasoning = false, chatProtocol = false) {
  const challenge = randomBytes(16).toString('hex');
  const started = performance.now();
  const {payload, signature} = await requestJson(candidate.url + '/v1/probe?challenge=' + challenge,
    {timeoutMs:TIMEOUT_MS, maxBytes:4096});
  const elapsed = performance.now() - started;
  if (payload?.domain !== PROBE_DOMAIN || payload.challenge !== challenge || payload.chainId !== chainId ||
      payload.provider !== candidate.provider || payload.model !== MODEL || payload.contextWindow !== CONTEXT ||
      !kvCacheAtLeastQ8(payload.kvCache) ||
      (reasoning && payload.reasoningOptions !== 1) ||
      (chatProtocol && payload.chatProtocol !== 1) ||
      payload.available !== true || !Number.isSafeInteger(payload.maxOutputTokens) ||
      payload.maxOutputTokens < minOutput || payload.maxOutputTokens > CONTEXT ||
      !verify(candidate.provider, payload, signature)) {
    throw Error('Invalid or unavailable provider');
  }
  return elapsed;
}

/** Rank ready providers from a verified ledger snapshot using only public challenge responses. */
export async function rankProviders(state, {payer, ledgerUrl, maxOutputTokens = 1, reasoning = false, chatProtocol = false, eligible} = {}) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
      maxOutputTokens > Math.min(CONTEXT, state.maxOutputTokens ?? CONTEXT)) return [];
  const allowLocal = ledgerUrl && isLoopbackEndpoint(ledgerUrl);
  const candidates = [];
  for (const provider of state.providers) {
    const endpoint = state.providerEndpoints?.[provider];
    if (provider === payer || !endpoint || (eligible && !eligible.has(provider))) continue;
    let url;
    try { url = normalizeProviderEndpoint(endpoint); } catch { continue; }
    if (allowLocal || !isLoopbackEndpoint(url)) candidates.push({provider, url, samples:[]});
  }
  // Every registered candidate has the same chance of being checked on a large network.
  const count = Math.min(MAX_CANDIDATES, candidates.length);
  for (let i = 0; i < count; i++) {
    const j = randomInt(i, candidates.length);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  candidates.length = count;
  const deadline = performance.now() + BUDGET_MS;
  let ready = candidates;
  for (let round = 0; round < 3 && ready.length; round++) {
    let next = 0;
    async function worker() {
      while (next < ready.length && performance.now() + TIMEOUT_MS <= deadline) {
        const candidate = ready[next++];
        try {
          candidate.samples.push(await probeProvider(candidate, state.chainId, maxOutputTokens, reasoning,chatProtocol));
        } catch {
          // An unreachable, busy or ineligible node loses its earlier measurements.
          candidate.samples.length = 0;
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(CONCURRENCY, ready.length)}, worker));
    ready = ready.filter(candidate => candidate.samples.length);
  }
  return ready.map(({provider, url, samples}) => {
    samples.sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const latencyMs = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
    return {provider, url, latencyMs};
  }).sort((a, b) => a.latencyMs - b.latencyMs || a.provider.localeCompare(b.provider));
}
