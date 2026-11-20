/**
 * Box-local key agent. Holds the key provider (and its credential, if any), opens sealed
 * bundles, and hands the secrets to the API Worker on celld. Nothing else talks to it.
 *
 * Channel (who may ask):
 * - Listens on 127.0.0.1 only (host network; containers in their own network namespace cannot
 *   reach it).
 * - It speaks a framed protocol over raw TCP, not HTTP. Every request starts with
 *   KEY_AGENT_PREAMBLE, whose first byte is NUL, then a 4-byte big-endian length and a JSON
 *   body; every answer is a 4-byte length and a JSON envelope. Any HTTP request starts with a
 *   method token, so it is refused at the first byte: no `fetch` the Worker can be steered into
 *   (any URL, headers, body, redirect or DNS answer) can ask for secrets (finding F9). The Worker
 *   connects with `cloudflare:sockets` (apps/api/src/selfhost/runtime-secrets.ts).
 * - A secrets request's client socket must belong to an allowed uid (celld's), checked in
 *   /proc/net/tcp (peer.ts). Root and every other local user are refused, whatever the firewall
 *   says. A `ping` (the compose healthcheck, the deploy's readiness check) answers anyone and
 *   carries no secret.
 *
 * Cache: an opened bundle stays in memory for SAM_KEY_AGENT_CACHE_SECONDS. After that the next
 * request opens it again. If the key service is merely unreachable the stale copy is served (an
 * outage does not take SAM down), for at most SAM_KEY_AGENT_MAX_STALE_SECONDS after it was
 * opened; if it refuses (`denied`) the copy is dropped, so revoking the box's access stops new
 * Worker isolates within that window and running ones at their next refresh
 * (SAM_RUNTIME_SECRETS_TTL_MS in runtime-secrets.ts). A key service that hangs rather than
 * refuses would hold the request for the whole key-service timeout (5 s), longer than the Worker
 * waits for this agent (SAM_KEY_AGENT_TIMEOUT_MS, 3 s), so with a stale copy in hand a request
 * waits at most SAM_KEY_AGENT_STALE_WAIT_MS for the refresh and then gets the stale copy while the
 * refresh carries on; its result still updates or drops the cache.
 *
 * It runs as the owner of `.state` (SAM_KEY_AGENT_UID, docker-compose.yml) from the start: no
 * root, no capabilities (finding F10).
 *
 * Run with Node's type stripping: `node server.ts`.
 */
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { BUNDLE_ID, openBundle, parseBundle, type Secrets } from './bundle.ts';
import { type BundleStore, openBundleStore } from './bundle-store.ts';
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
/** A connection that has not sent a whole request within this is closed (a stuck client). */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
/** Connections open at once; more are refused (a local flood, security review L-3). */
export const DEFAULT_MAX_CONNECTIONS = 64;
/**
 * Longest the agent serves a copy it could not refresh because the key service is unreachable
 * (SAM_KEY_AGENT_MAX_STALE_SECONDS). Past it the agent fails closed: an outage that long is not
 * one SAM should ride out on keys nobody can revoke.
 */
export const DEFAULT_MAX_STALE_MS = 6 * 3600_000;
/**
 * First bytes of every request (runtime-secrets.ts has the same constant;
 * apps/api/tests/unit/selfhost-sealed-secrets-contract.test.ts pins both). NUL first: no HTTP
 * request line can start with it.
 */
export const KEY_AGENT_PREAMBLE = Buffer.from('\u0000SAMKA2\n', 'utf8');
const MAX_REQUEST_BYTES = 1024;
/** The bundle entry holding the agent's Ed25519 signing key (PKCS#8 DER, base64); never served. */
export const SIGNING_KEY_NAME = 'SAM_KEY_AGENT_SIGNING_KEY';
/** A platform key sealed in the bundle that the Worker gets as a var, never from the agent. */
const INSTALLATION_ID_NAME = 'SAM_INSTALLATION_ID';
const NONCE = /^[0-9a-f]{32}$/;
const STALE = Symbol('stale');

interface Opened {
  installationId: string;
  secrets: Secrets;
  signingKey: KeyObject;
  /** When this copy was opened; set by refresh(). */
  openedAt?: number;
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
  /** Where the sealed bundles live (bundle-store.ts). */
  bundles: BundleStore;
  allowedUids: ReadonlySet<number>;
  cacheMs: number;
  /** Wait for a refresh before serving the stale copy (DEFAULT_STALE_WAIT_MS when unset). */
  staleWaitMs?: number;
  /** Close a connection that sent no whole request in time (DEFAULT_CONNECTION_TIMEOUT_MS). */
  connectionTimeoutMs?: number;
  /** Serve an unrefreshable copy at most this long after it was opened (DEFAULT_MAX_STALE_MS). */
  maxStaleMs?: number;
  /** Connections open at once (DEFAULT_MAX_CONNECTIONS). */
  maxConnections?: number;
  /** Peer lookup; tests replace it, production reads /proc/net/tcp. */
  peerUid?: (socket: Socket) => number | null;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

function defaultPeerUid(socket: Socket): number | null {
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

/** One answer frame: a 4-byte big-endian length, then the JSON envelope. Then the socket ends. */
function answer(socket: Socket, envelope: Record<string, unknown>): void {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  socket.end(Buffer.concat([length, json]));
}

type Request =
  { op: 'ping' } | { op: 'secrets'; bundleId: string; nonce: string; installationId: string };

/**
 * Reads one request frame. Resolves null (and the caller closes the socket without answering)
 * when the first bytes are not the preamble, the declared length is over the cap, the socket
 * closes early, or the body is not a well-formed request.
 */
function readRequest(socket: Socket, timeoutMs: number): Promise<Request | null> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    const finish = (value: Request | null): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      resolve(value);
    };
    const onEnd = (): void => finish(null);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const seen = Math.min(buffered.length, KEY_AGENT_PREAMBLE.length);
      // Refused at the first byte that differs: an HTTP request never gets past byte 0.
      if (!buffered.subarray(0, seen).equals(KEY_AGENT_PREAMBLE.subarray(0, seen))) {
        finish(null);
        return;
      }
      const head = KEY_AGENT_PREAMBLE.length + 4;
      if (buffered.length < head) return;
      const length = buffered.readUInt32BE(KEY_AGENT_PREAMBLE.length);
      if (length > MAX_REQUEST_BYTES) {
        finish(null);
        return;
      }
      if (buffered.length < head + length) return;
      finish(parseRequest(buffered.subarray(head, head + length).toString('utf8')));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
  });
}

function parseRequest(text: string): Request | null {
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (fields.op === 'ping') return { op: 'ping' };
  const { op, bundleId, nonce, installationId } = fields;
  if (
    op !== 'secrets' ||
    typeof bundleId !== 'string' ||
    !BUNDLE_ID.test(bundleId) ||
    typeof nonce !== 'string' ||
    !NONCE.test(nonce) ||
    typeof installationId !== 'string'
  ) {
    return null;
  }
  return { op, bundleId, nonce, installationId };
}

export function createKeyAgent(options: AgentOptions): Server {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const peerUid = options.peerUid ?? defaultPeerUid;
  const cache = new Map<string, { opened: Opened; openedAt: number }>();
  const opening = new Map<string, Promise<Opened>>();

  const staleWaitMs = options.staleWaitMs ?? DEFAULT_STALE_WAIT_MS;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  /** A copy's age; a clock that moved backwards counts as expired, never as fresh. */
  const ageOf = (openedAt: number): number => {
    const age = now() - openedAt;
    return age < 0 ? Number.POSITIVE_INFINITY : age;
  };
  /** Whether a copy opened at `openedAt` may still stand in for a refresh that failed. */
  const mayServeStale = (openedAt: number): boolean => ageOf(openedAt) < maxStaleMs;

  async function open(bundleId: string): Promise<Opened> {
    const cached = cache.get(bundleId);
    // A cache window above the stale bound is capped by it: revocation reaches a cached copy too.
    if (cached && ageOf(cached.openedAt) < Math.min(options.cacheMs, maxStaleMs)) {
      return cached.opened;
    }
    const attempt = opening.get(bundleId) ?? refresh(bundleId);
    if (!cached || !mayServeStale(cached.openedAt)) return await attempt;
    // A stale copy is in hand: do not let a hung key service outlast the Worker's wait.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<typeof STALE>((done) => {
      timer = setTimeout(() => done(STALE), staleWaitMs);
    });
    try {
      const first = await Promise.race([attempt, slow]);
      if (first !== STALE) return first;
      // The wait itself can carry the copy past the stale bound: then keep waiting for the
      // refresh instead (its own timeout settles it) rather than serving an over-age copy.
      if (!mayServeStale(cached.openedAt)) return await attempt;
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
      const text = await options.bundles.read(bundleId);
      if (text === null) throw new KeyProviderError('config', 'bundle_not_found');
      const started = now();
      try {
        const bundle = parseBundle(text);
        const previous = options.previousProvider;
        const provider =
          previous && bundle.provider === previous.name && bundle.keyRef === previous.keyRef
            ? previous
            : options.provider;
        const opened = toOpened(bundle.installationId, await openBundle(bundle, provider));
        opened.openedAt = now();
        cache.set(bundleId, { opened, openedAt: opened.openedAt });
        log({
          event: 'key_agent.bundle_opened',
          bundleId,
          provider: provider.name,
          ms: now() - started,
        });
        return opened;
      } catch (error) {
        if (
          cached &&
          mayServeStale(cached.openedAt) &&
          error instanceof KeyProviderError &&
          error.kind === 'unavailable'
        ) {
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

  async function serveSecrets(
    socket: Socket,
    request: Extract<Request, { op: 'secrets' }>
  ): Promise<void> {
    const { bundleId, nonce, installationId } = request;
    const uid = peerUid(socket);
    if (uid === null || !options.allowedUids.has(uid)) {
      log({ event: 'key_agent.peer_refused', uid, action: 'rejected' });
      answer(socket, { status: 403, error: 'peer_refused' });
      return;
    }
    try {
      const opened = await open(bundleId);
      // A bundle from another install (same key service, copied file) is not this Worker's.
      if (opened.installationId !== installationId) {
        log({ event: 'key_agent.installation_mismatch', bundleId, action: 'rejected' });
        answer(socket, { status: 409, error: 'installation_mismatch' });
        return;
      }
      // Signed over the exact body, which carries the caller's nonce: a process that took this
      // port while the agent was down cannot produce it without opening the bundle itself.
      // ageMs: how old this copy is, so a Worker's stale window counts from when it was opened
      // (a stale copy served during a key-service outage is not fresh to the Worker).
      const ageMs = Math.max(0, now() - (opened.openedAt ?? now()));
      const body = JSON.stringify({ bundleId, nonce, ageMs, secrets: opened.secrets });
      answer(socket, {
        status: 200,
        body,
        signature: sign(null, Buffer.from(body, 'utf8'), opened.signingKey).toString('base64'),
      });
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
      answer(socket, { status: code === 'bundle_not_found' ? 404 : 503, error: code });
    }
  }

  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    readRequest(socket, connectionTimeoutMs)
      .then(async (request) => {
        if (!request) {
          socket.destroy();
          return;
        }
        if (request.op === 'ping') {
          answer(socket, { status: 200, ok: true, sealed: true });
          return;
        }
        await serveSecrets(socket, request);
      })
      .catch(() => {
        if (!socket.destroyed) answer(socket, { status: 500, error: 'internal' });
      });
  });
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  return server;
}

function parseUids(raw: string | undefined): Set<number> {
  const uids = (raw ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((uid) => Number.isInteger(uid) && uid > 0);
  if (uids.length === 0) throw new Error('SAM_KEY_AGENT_ALLOWED_UIDS names no uid');
  return new Set(uids);
}

/**
 * Refuses to start as root, or as a user that cannot read the state directory: the compose
 * service runs as SAM_KEY_AGENT_UID (the owner of `.state`), and a missing or wrong uid must fail
 * loudly here rather than as an unexplained 503 in the Worker.
 */
export function assertRunsAsStateOwner(dir: string, uid = process.getuid?.()): void {
  if (uid === 0) {
    throw new Error(
      'the key agent must not run as root: set SAM_KEY_AGENT_UID in .env to the uid that owns ' +
        'the state directory (`id -u`; pnpm selfhost:deploy --init prints it)'
    );
  }
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(
      `uid ${uid} cannot read ${dir}: set SAM_KEY_AGENT_UID in .env to the uid ` +
        'that owns the state directory (`id -u`; pnpm selfhost:deploy --init prints it)'
    );
  }
}

/** A box with sealing off (`legacy-plaintext`): healthy for compose, no secrets for anyone. */
export function createLegacyAgent(connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS): Server {
  return createServer((socket) => {
    socket.on('error', () => socket.destroy());
    void readRequest(socket, connectionTimeoutMs).then((request) => {
      if (!request) socket.destroy();
      else if (request.op === 'ping') answer(socket, { status: 200, ok: true, sealed: false });
      else answer(socket, { status: 503, error: 'sealed_secrets_off' });
    });
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
  const stateDir = env.SAM_KEY_AGENT_STATE_DIR ?? '/etc/sam/key-agent';
  const port = Number(env.SAM_KEY_AGENT_PORT ?? DEFAULT_KEY_AGENT_PORT);
  const connectionTimeoutMs =
    positiveInt(env.SAM_KEY_AGENT_CONNECTION_TIMEOUT_MS) ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (env.SAM_KEY_PROVIDER?.trim() === LEGACY_KEY_PROVIDER) {
    createLegacyAgent(connectionTimeoutMs).listen(port, '127.0.0.1', () => {
      console.log(JSON.stringify({ event: 'key_agent.legacy_plaintext', port }));
    });
    return;
  }
  assertRunsAsStateOwner(stateDir);
  const cacheSeconds = Number(env.SAM_KEY_AGENT_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS);
  const server = createKeyAgent({
    provider: createKeyProvider(env),
    previousProvider: previousProvider(stateDir),
    bundles: openBundleStore({ dir: env.SAM_KEY_AGENT_BUNDLE_DIR ?? `${stateDir}/bundles` }),
    allowedUids: parseUids(env.SAM_KEY_AGENT_ALLOWED_UIDS),
    cacheMs: Math.max(0, cacheSeconds) * 1000,
    staleWaitMs: positiveInt(env.SAM_KEY_AGENT_STALE_WAIT_MS) ?? DEFAULT_STALE_WAIT_MS,
    connectionTimeoutMs,
    maxStaleMs:
      (positiveInt(env.SAM_KEY_AGENT_MAX_STALE_SECONDS) ?? DEFAULT_MAX_STALE_MS / 1000) * 1000,
    maxConnections: positiveInt(env.SAM_KEY_AGENT_MAX_CONNECTIONS) ?? DEFAULT_MAX_CONNECTIONS,
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      JSON.stringify({ event: 'key_agent.listening', port, provider: env.SAM_KEY_PROVIDER })
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
