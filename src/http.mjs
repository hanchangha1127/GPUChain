import http from 'node:http';
import https from 'node:https';

function transportFor(url) {
  if (url.username || url.password || url.hash) throw Error('Credentials and fragments are unsupported in URLs');
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return http;
  throw Error('Use HTTPS or loopback HTTP');
}

// Large local-model completions may run for more than five minutes before sending headers.
export async function requestJson(value, {method, headers, body, timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024} = {}) {
  const url = new URL(value);
  const transport = transportFor(url);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (data && data.length > maxBytes) throw Error('Request exceeds size limit');
  const requestHeaders = {...headers};
  if (data) {
    requestHeaders['content-type'] = 'application/json';
    requestHeaders['content-length'] = data.length;
  }
  const res = await new Promise((resolve,reject) => {
    const req = transport.request(url,{
      method:method || (data ? 'POST' : 'GET'), headers:requestHeaders, signal:AbortSignal.timeout(timeoutMs)
    },resolve);
    req.on('error',reject);
    req.end(data);
  });
  const chunks = [];
  let length = 0;
  for await (const chunk of res) {
    length += chunk.length;
    if (length > maxBytes) throw Error('Response exceeds size limit');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let reason = res.statusMessage;
    try {
      const error = JSON.parse(raw)?.error;
      if (typeof error === 'string') reason = error;
    } catch { /* Error bodies can be plain text. */ }
    throw Object.assign(Error(`HTTP ${res.statusCode}: ${reason}`),{status:res.statusCode});
  }
  return JSON.parse(raw);
}
