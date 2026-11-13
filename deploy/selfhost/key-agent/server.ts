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
 * box's access stops new Worker isolates within that window. A key service that hangs rather than
 * refuses would hold the request for the whole key-service timeout (5 s), longer than the Worker
 * waits for this agent (SAM_KEY_AGENT_TIMEOUT_MS, 3 s), so with a stale copy in hand a request
 * waits at most SAM_KEY_AGENT_STALE_WAIT_MS for the refresh and then gets the stale copy while the
 * refresh carries on; its result still updates or drops the cache.
 *
 * Run with Node's type stripping: `node server.ts`.
 */
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { BUNDLE_ID, openBundle, parseBundle, type Secrets } from './bundle.ts';
import { loopbackPeerUid } from './peer.ts';
import { type KeyProvider, KeyProviderError } from './provider.ts';
import { createKeyProvider, LEGACY_KEY_PROVIDER } from './providers.ts';

export const DEFAULT_KEY_AGENT_PORT = 7190;
export const DEFAULT_CACHE_SECONDS = 300;
/**
 * How long a request with a stale copy in hand waits for a slow refresh. Must stay well below the
 * Worker's wait for this agent (DEFAULT_KEY_AGENT_TIMEOUT_MS, 3000 ms in
 * apps/api/src/selfhost/runtime-secrets.ts), or a hung key service fails every fresh isolate.
 */
export const DEFAULT_STALE_WAIT_MS = 1000;
const MAX_REQUEST_BYTES = 1024;
/** The bundle entry holding the agent's Ed25519 signing key (PKCS#8 DER, base64); never served. */
export const SIGNING_KEY_NAME = 'SAM_KEY_AGENT_SIGNING_KEY';
/** A platform key sealed in the bundle that the Worker gets as a var, never from the agent. */
const INSTALLATION_ID_NAME = 'SAM_INSTALLATION_ID';
export const SIGNATURE_HEADER = 'x-sam-key-agent-signature';
const NONCE = /^[0-9a-f]{32}$/;
const STALE = Symbol('stale');

interface Opened {
  installationId: string;
  secrets: Secrets;
  signingKey: KeyObject;
}

/**
 * Splits the signing key off the secrets; a bundle without one is refused (fail closed).
 *
 * The bundle also holds the platform key SAM_INSTALLATION_ID (the deploy reads it back from the
 * bundle once platform-keys.json is gone). It reaches the Worker as a deploy var, not a secret,
 * and the Worker refuses any answer that names it (runtime-secrets.ts PROTECTED_NAMES), so it is
 * never part of the answer.
 */
function toOpened(installationId: string, all: Secrets): Opened {
  const {
    [SIGNING_KEY_NAME]: der,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose (see above)
    [INSTALLATION_ID_NAME]: _installationIdVar,
    ...secrets
  } = all;
  if (!der) throw new KeyProviderError('invalid', 'bundle has no agent signing key');
  let signingKey: KeyObject;
  try {
    signingKey = createPrivateKey({
      key: Buffer.from(der, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw new KeyProviderError('invalid', 'bundle agent signing key is malformed');
  }
  if (signingKey.asymmetricKeyType !== 'ed25519') {
    throw new KeyProviderError('invalid', 'bundle agent signing key is not Ed25519');
  }
  return { installationId, secrets, signingKey };
}

export interface AgentOptions {
  provider: KeyProvider;
  /**
   * During `pnpm selfhost:secrets switch`: the provider the box used before, so the Worker version
   * still running keeps getting its (old) bundle until the new version is deployed. Chosen by the
   * bundle header, never tried as a fallback.
   */
  previousProvider?: KeyProvider;
  bundleDir: string;
  allowedUids: ReadonlySet<number>;
  cacheMs: number;
  /** Wait for a refresh before serving the stale copy (DEFAULT_STALE_WAIT_MS when unset). */
  staleWaitMs?: number;
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
  const cache = new Map<string, { opened: Opened; openedAt: number }>();
  const opening = new Map<string, Promise<Opened>>();

  const staleWaitMs = options.staleWaitMs ?? DEFAULT_STALE_WAIT_MS;

  async function open(bundleId: string): Promise<Opened> {
    const cached = cache.get(bundleId);
    if (cached && now() - cached.openedAt < options.cacheMs) return cached.opened;
    const attempt = opening.get(bundleId) ?? refresh(bundleId);
    if (!cached) return await attempt;
    // A stale copy is in hand: do not let a hung key service outlast the Worker's wait.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<typeof STALE>((done) => {
      timer = setTimeout(() => done(STALE), staleWaitMs);
    });
    try {
      const first = await Promise.race([attempt, slow]);
      if (first !== STALE) return first;
      log({
        event: 'key_agent.serving_stale',
        bundleId,
        reason: `key service slower than ${staleWaitMs} ms; the refresh continues`,
      });
      return cached.opened;
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(bundleId: string): Promise<Opened> {
    const cached = cache.get(bundleId);
    const attempt = (async () => {
      let text: string;
      try {
        text = readFileSync(join(options.bundleDir, `${bundleId}.json`), 'utf8');
      } catch {
        throw new KeyProviderError('config', 'bundle_not_found');
      }
      const started = now();
      try {
        const bundle = parseBundle(text);
        const previous = options.previousProvider;
        const provider =
          previous && bundle.provider === previous.name && bundle.keyRef === previous.keyRef
            ? previous
            : options.provider;
        const opened = toOpened(bundle.installationId, await openBundle(bundle, provider));
        cache.set(bundleId, { opened, openedAt: now() });
        log({
          event: 'key_agent.bundle_opened',
          bundleId,
          provider: provider.name,
          ms: now() - started,
        });
        return opened;
      } catch (error) {
        if (cached && error instanceof KeyProviderError && error.kind === 'unavailable') {
          log({ event: 'key_agent.serving_stale', bundleId, reason: error.message });
          return cached.opened;
        }
        cache.delete(bundleId);
        throw error;
      }
    })();
    opening.set(bundleId, attempt);
    // A request that served the stale copy no longer awaits this; its failure is logged above.
    attempt.then(
      () => opening.delete(bundleId),
      () => opening.delete(bundleId)
    );
    return attempt;
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
    let fields: Record<string, unknown> = {};
    try {
      const parsed: unknown = body === null ? undefined : (JSON.parse(body) as unknown);
      if (typeof parsed === 'object' && parsed !== null) fields = parsed as Record<string, unknown>;
    } catch {
      fields = {};
    }
    const { bundleId, nonce, installationId } = fields;
    if (
      typeof bundleId !== 'string' ||
      !BUNDLE_ID.test(bundleId) ||
      typeof nonce !== 'string' ||
      !NONCE.test(nonce) ||
      typeof installationId !== 'string'
    ) {
      reply(response, 400, { error: 'bad_request' });
      return;
    }
    try {
      const opened = await open(bundleId);
      // A bundle from another install (same key service, copied file) is not this Worker's.
      if (opened.installationId !== installationId) {
        log({ event: 'key_agent.installation_mismatch', bundleId, action: 'rejected' });
        reply(response, 409, { error: 'installation_mismatch' });
        return;
      }
      // Signed over the exact body, which carries the caller's nonce: a process that took this
      // port while the agent was down cannot produce it without opening the bundle itself.
      const text = JSON.stringify({ bundleId, nonce, secrets: opened.secrets });
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
        [SIGNATURE_HEADER]: sign(null, Buffer.from(text, 'utf8'), opened.signingKey).toString(
          'base64'
        ),
      });
      response.end(text);
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

/**
 * Started as root (docker-compose.yml: no SAM_KEY_AGENT_UID), the agent becomes the owner of its
 * state directory before it reads anything or opens a socket: the bundles and the key file are
 * that user's mode-0600 files. The container holds only CAP_SETUID and CAP_SETGID for this, and
 * both are gone once the uid is no longer 0. A root-owned directory leaves it root, without any
 * other capability.
 */
export function dropToOwnerOf(dir: string): { uid: number; gid: number } | null {
  if (process.getuid?.() !== 0 || !process.setuid || !process.setgid || !process.setgroups) {
    return null;
  }
  const { uid, gid } = statSync(dir);
  if (uid === 0) return null;
  process.setgroups([gid]);
  process.setgid(gid);
  process.setuid(uid);
  if (process.getuid() !== uid || process.getgid?.() !== gid) {
    throw new Error(`could not become ${uid}:${gid}`);
  }
  return { uid, gid };
}

/** A box with sealing off (`legacy-plaintext`): healthy for compose, no secrets for anyone. */
export function createLegacyAgent(): Server {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      reply(response, 200, { ok: true, sealed: false });
      return;
    }
    reply(response, 503, { error: 'sealed_secrets_off' });
  });
}

/** Name of the file `selfhost:secrets switch` writes while it moves the box to another provider. */
export const PREVIOUS_PROVIDER_ENV = 'previous.env';

/** The previous provider's settings (`NAME=value` lines), if a switch is in progress. */
export function previousProvider(stateDir: string): KeyProvider | undefined {
  let text: string;
  try {
    text = readFileSync(join(stateDir, PREVIOUS_PROVIDER_ENV), 'utf8');
  } catch {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1]) env[match[1]] = match[2] ?? '';
  }
  return createKeyProvider(env);
}

function positiveInt(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return raw?.trim() && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function main(): void {
  const env = process.env;
  const dropped = dropToOwnerOf(env.SAM_KEY_AGENT_STATE_DIR ?? '/etc/sam/key-agent');
  if (dropped) console.log(JSON.stringify({ event: 'key_agent.dropped_root', ...dropped }));
  const port = Number(env.SAM_KEY_AGENT_PORT ?? DEFAULT_KEY_AGENT_PORT);
  if (env.SAM_KEY_PROVIDER?.trim() === LEGACY_KEY_PROVIDER) {
    createLegacyAgent().listen(port, '127.0.0.1', () => {
      console.log(JSON.stringify({ event: 'key_agent.legacy_plaintext', port }));
    });
    return;
  }
  const cacheSeconds = Number(env.SAM_KEY_AGENT_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  const server = createKeyAgent({
    provider: createKeyProvider(env),
    previousProvider: previousProvider(env.SAM_KEY_AGENT_STATE_DIR ?? '/etc/sam/key-agent'),
    bundleDir: env.SAM_KEY_AGENT_BUNDLE_DIR ?? '/etc/sam/key-agent/bundles',
    allowedUids: parseUids(env.SAM_KEY_AGENT_ALLOWED_UIDS),
    cacheMs: Math.max(0, cacheSeconds) * 1000,
    staleWaitMs: positiveInt(env.SAM_KEY_AGENT_STALE_WAIT_MS) ?? DEFAULT_STALE_WAIT_MS,
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({ event: 'key_agent.listening', port, provider: env.SAM_KEY_PROVIDER })
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
