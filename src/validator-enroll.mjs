import { authenticate } from './checkpoint.mjs';
import { signEnrollment } from './enrollment.mjs';
import { requestJson } from './http.mjs';
import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

// Validators repeat this on startup and periodically until they durably adopt a certified roster.
export async function enrollAt(ledgerUrl, chainId, wallet, origin, instanceId) {
  const base = normalizeProviderEndpoint(ledgerUrl);
  const result = await requestJson(base + '/v1/consensus/enroll', {
    body:signEnrollment(chainId,wallet,origin,instanceId),timeoutMs:12_000,maxBytes:4*1024*1024
  });
  const checkpoint = authenticate(result.checkpoint,chainId);
  if (Boolean(checkpoint.authority) !== result.active) throw Error('Unexpected enrollment response');
  return checkpoint.authority ? checkpoint : null;
}
