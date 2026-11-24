export function isLoopbackEndpoint(value) {
  const host = new URL(value).hostname.replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

// Store only the origin; discovery and inference append the protocol's own paths.
export function normalizeProviderEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 ||
      !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error('Expected a provider origin without credentials, path, query or fragment');
  }
  const url = new URL(value);
  // Match the plaintext HTTP origins allowed by the inference transport.
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('Provider origin requires HTTPS or loopback HTTP');
  }
  return url.origin;
}
