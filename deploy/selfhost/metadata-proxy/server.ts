/** Loopback metadata facade. Never log a URI, error object, source or issued credential. */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { loopbackPeerUid } from './peer.ts';
import { METADATA_TOKEN_PATH, STORAGE_SCOPE_PREFIX, tokenSource } from './token.ts';

// Rust object_store sends this fixed compatibility audience on its metadata access-token GET.
// It never chooses the STS exchange audience, bucket or permission boundary.
export const NATIVE_TOKEN_QUERY =
  '?audience=https%3A%2F%2Fwww.googleapis.com%2Foauth2%2Fv4%2Ftoken';

export function metadataServer(
  secret: string,
  issue: ReturnType<typeof tokenSource>,
  allowedUid: number
) {
  if (!/^[0-9a-f]{64}$/.test(secret))
    throw new Error('metadata proxy secret must be 32 bytes of hex');
  const expected = Buffer.from(`/${secret}${METADATA_TOKEN_PATH}`);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Metadata-Flavor', 'Google');
    const raw = req.url ?? '';
    const actual = Buffer.from(
      raw.endsWith(NATIVE_TOKEN_QUERY) ? raw.slice(0, -NATIVE_TOKEN_QUERY.length) : raw
    );
    if (
      req.method !== 'GET' ||
      req.headers['metadata-flavor'] !== 'Google' ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(404).end();
      return;
    }
    const peer = loopbackPeerUid({
      clientAddress: req.socket.remoteAddress ?? '',
      clientPort: req.socket.remotePort ?? 0,
      serverAddress: req.socket.localAddress ?? '',
      serverPort: req.socket.localPort ?? 0,
    });
    if (peer !== allowedUid) {
      res.writeHead(403).end();
      return;
    }
    try {
      const value = await issue();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    } catch {
      res.writeHead(503).end('Scoped token unavailable');
    }
  });
}

function positive(name: string, fallback: number): number {
  const n = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid ${name}`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = positive('GCE_METADATA_PROXY_PORT', 7180);
    if (port < 1024 || port > 65535) throw new Error('invalid proxy port');
    const issue = tokenSource({
      bucket: process.env.GCE_METADATA_PROXY_BUCKET ?? '',
      scope: process.env.GCE_METADATA_PROXY_SCOPES || `${STORAGE_SCOPE_PREFIX}read_write`,
      timeoutMs: positive('GCE_METADATA_PROXY_TIMEOUT_MS', 5000),
      maxResponseBytes: positive('GCE_METADATA_PROXY_MAX_RESPONSE_BYTES', 65536),
    });
    const server = metadataServer(
      process.env.GCE_METADATA_PROXY_SECRET ?? '',
      issue,
      positive('GCE_METADATA_PROXY_ALLOWED_UID', 7103)
    );
    server.requestTimeout = positive('GCE_METADATA_PROXY_REQUEST_TIMEOUT_MS', 15000);
    server.headersTimeout = server.requestTimeout;
    server.on('error', () => {
      console.error('metadata proxy listener failed');
      process.exit(1);
    });
    server.listen(port, '127.0.0.1');
  } catch {
    console.error('metadata proxy configuration invalid');
    process.exit(1);
  }
}
