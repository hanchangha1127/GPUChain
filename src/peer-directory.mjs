import { normalizeProviderEndpoint } from './provider-endpoint.mjs';

export const DIRECTORY_URL = 'https://raw.githubusercontent.com/hanchangha1127/GPUChain/main/networks/testnet-endpoints.json';
export const PEER_LIMIT = 16;

export function directoryOrigins(directory, chainId) {
  if (directory?.chainId !== chainId || !Array.isArray(directory.endpoints) ||
      directory.endpoints.length > PEER_LIMIT) throw Error('Invalid testnet endpoint directory');
  return directory.endpoints.map(normalizeProviderEndpoint);
}
