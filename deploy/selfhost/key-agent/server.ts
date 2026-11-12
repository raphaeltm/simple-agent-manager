/**
 * Box-local key agent. Holds the key provider (and its credential, if any), opens sealed
 * bundles, and hands the secrets to the API Worker on celld. Nothing else talks to it.
 *
 * Channel (who may ask):
 * - Listens on 127.0.0.1 only (host network; containers in their own network namespace cannot
 *   reach it).
 * - The client socket must belong to an allowed uid (celld's, 7101), checked in /proc/net/tcp
 *   (peer.ts). Root and every other local user are refused, whatever the firewall says.
 * - The request shape is fixed: `POST /v1/secrets`, `content-type: application/json`, and the
 *   header `x-sam-key-agent: 1`. No URL a user or admin can configure in SAM produces that
 *   request, so the Worker cannot be steered into fetching it for someone (SSRF).
 *
 * Cache: an opened bundle stays in memory for SAM_KEY_AGENT_CACHE_SECONDS. After that the next
 * request opens it again. If the key service is merely unreachable the stale copy is served (an
 * outage does not take SAM down); if it refuses (`denied`) the copy is dropped, so revoking the
 * box's access stops new Worker isolates within that window.
 *
 * Run with Node's type stripping: `node server.ts`.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { BUNDLE_ID, openBundle, parseBundle, type Secrets } from './bundle.ts';
import { loopbackPeerUid } from './peer.ts';
import { type KeyProvider, KeyProviderError } from './provider.ts';
import { createKeyProvider } from './providers.ts';

export const DEFAULT_KEY_AGENT_PORT = 7190;
export const DEFAULT_CACHE_SECONDS = 300;
const MAX_REQUEST_BYTES = 1024;

export interface AgentOptions {
  provider: KeyProvider;
  bundleDir: string;
  allowedUids: ReadonlySet<number>;
  cacheMs: number;
  /** Peer lookup; tests replace it, production reads /proc/net/tcp. */
  peerUid?: (request: IncomingMessage) => number | null;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

function defaultPeerUid(request: IncomingMessage): number | null {
  const socket = request.socket;
  if (!socket.remoteAddress || !socket.remotePort || !socket.localAddress || !socket.localPort) {
    return null;
  }
  return loopbackPeerUid({
    clientAddress: socket.remoteAddress,
    clientPort: socket.remotePort,
    serverAddress: socket.localAddress,
    serverPort: socket.localPort,
  });
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createKeyAgent(options: AgentOptions): Server {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const peerUid = options.peerUid ?? defaultPeerUid;
  const cache = new Map<string, { secrets: Secrets; openedAt: number }>();
  const opening = new Map<string, Promise<Secrets>>();

  async function open(bundleId: string): Promise<Secrets> {
    const cached = cache.get(bundleId);
    if (cached && now() - cached.openedAt < options.cacheMs) return cached.secrets;
    const pending = opening.get(bundleId);
    if (pending) return await pending;
    const attempt = (async () => {
      let text: string;
      try {
        text = readFileSync(join(options.bundleDir, `${bundleId}.json`), 'utf8');
      } catch {
        throw new KeyProviderError('config', 'bundle_not_found');
      }
      const started = now();
      try {
        const secrets = await openBundle(parseBundle(text), options.provider);
        cache.set(bundleId, { secrets, openedAt: now() });
        log({
          event: 'key_agent.bundle_opened',
          bundleId,
          provider: options.provider.name,
          ms: now() - started,
        });
        return secrets;
      } catch (error) {
        if (cached && error instanceof KeyProviderError && error.kind === 'unavailable') {
          log({ event: 'key_agent.serving_stale', bundleId, reason: error.message });
          return cached.secrets;
        }
        cache.delete(bundleId);
        throw error;
      }
    })();
    opening.set(bundleId, attempt);
    try {
      return await attempt;
    } finally {
      opening.delete(bundleId);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === '/healthz') {
      reply(response, 200, { ok: true });
      return;
    }
    if (url !== '/v1/secrets') {
      reply(response, 404, { error: 'not_found' });
      return;
    }
    const uid = peerUid(request);
    if (uid === null || !options.allowedUids.has(uid)) {
      log({ event: 'key_agent.peer_refused', uid, action: 'rejected' });
      reply(response, 403, { error: 'peer_refused' });
      return;
    }
    if (
      request.method !== 'POST' ||
      request.headers['x-sam-key-agent'] !== '1' ||
      !(request.headers['content-type'] ?? '').startsWith('application/json')
    ) {
      reply(response, 400, { error: 'bad_request' });
      return;
    }
    const body = await readBody(request);
    let bundleId: unknown;
    try {
      const parsed: unknown = body === null ? undefined : (JSON.parse(body) as unknown);
      bundleId =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).bundleId
          : undefined;
    } catch {
      bundleId = undefined;
    }
    if (typeof bundleId !== 'string' || !BUNDLE_ID.test(bundleId)) {
      reply(response, 400, { error: 'bad_request' });
      return;
    }
    try {
      const secrets = await open(bundleId);
      reply(response, 200, { bundleId, secrets });
    } catch (error) {
      const kind = error instanceof KeyProviderError ? error.kind : 'unavailable';
      const code =
        error instanceof KeyProviderError && error.message === 'bundle_not_found'
          ? 'bundle_not_found'
          : `key_service_${kind}`;
      log({
        event: 'key_agent.open_failed',
        bundleId,
        code,
        reason: error instanceof Error ? error.message : String(error),
      });
      reply(response, code === 'bundle_not_found' ? 404 : 503, { error: code });
    }
  }

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 500, { error: 'internal' });
      else response.destroy();
    });
  });
}

function parseUids(raw: string | undefined): Set<number> {
  const uids = (raw ?? '7101')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((uid) => Number.isInteger(uid) && uid > 0);
  if (uids.length === 0) throw new Error('SAM_KEY_AGENT_ALLOWED_UIDS names no uid');
  return new Set(uids);
}

function main(): void {
  const env = process.env;
  const port = Number(env.SAM_KEY_AGENT_PORT ?? DEFAULT_KEY_AGENT_PORT);
  const cacheSeconds = Number(env.SAM_KEY_AGENT_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  const server = createKeyAgent({
    provider: createKeyProvider(env),
    bundleDir: env.SAM_KEY_AGENT_BUNDLE_DIR ?? '/etc/sam/key-agent/bundles',
    allowedUids: parseUids(env.SAM_KEY_AGENT_ALLOWED_UIDS),
    cacheMs: Math.max(0, cacheSeconds) * 1000,
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({ event: 'key_agent.listening', port, provider: env.SAM_KEY_PROVIDER })
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
