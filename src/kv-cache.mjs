// Wire values describe the active KV cache. Model weight quantization is independent.
const allowed = new Set(['Q8','F16','BF16','F32']);

export function kvCacheAtLeastQ8(pair) {
  return Boolean(pair && typeof pair === 'object' && !Array.isArray(pair) &&
    Object.keys(pair).length===2 && Object.hasOwn(pair,'k') && Object.hasOwn(pair,'v') &&
    allowed.has(pair.k) && allowed.has(pair.v));
}
