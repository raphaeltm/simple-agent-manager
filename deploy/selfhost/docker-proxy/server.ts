/**
 * The Docker socket proxy celld uses on a self-hosted box (guided credential login).
 *
 * celld connects to SAM_DOCKER_PROXY_LISTEN (a unix socket in a volume only celld and this proxy
 * mount) instead of the Docker socket. Every request is decided by `policy.ts`; an allowed one is
 * forwarded to the real daemon with a body rebuilt from the checked fields, and everything else
 * is answered 403 here and never reaches the daemon. The container runs with no network, no
 * capabilities and a read-only root, so the only things it can talk to are those two sockets.
 *
 * Run with Node's type stripping: `node server.ts`.
 */
import { chmodSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  countCelldContainers,
  DEFAULT_MAX_SANDBOX_AGE_SECONDS,
  inspectContainer,
  logEvent,
  reapingNode,
  reapOverageSandboxes,
  reapStaleSandboxes,
  RESPONSE_FILTERS,
  UPSTREAM,
} from './engine.ts';
import { decide, type Decision, isRecord, parsePolicy, type ProxyPolicy } from './policy.ts';

const LISTEN = process.env.SAM_DOCKER_PROXY_LISTEN ?? '/run/sam-docker-proxy/docker.sock';
const POLICY_PATH = process.env.SAM_DOCKER_PROXY_POLICY ?? '/etc/sam/docker-proxy/policy.json';
const SOCKET_MODE = Number.parseInt(process.env.SAM_DOCKER_PROXY_SOCKET_MODE ?? '660', 8);
const MAX_BODY_BYTES = Number.parseInt(process.env.SAM_DOCKER_PROXY_MAX_BODY_BYTES ?? '262144', 10);
/** Exec ids this proxy created, oldest first; bounded so a long-lived proxy does not grow. */
/**
 * Most celld containers (sandboxes plus fence runs) that may exist at once. The Worker caps
 * concurrent sign-ins (MAX_CONCURRENT_SETUP_SESSIONS, default 2), but a compromised celld is on
 * the far side of that cap; this one holds even then. Each sandbox may commit the instance type's
 * memory, so the default bounds sign-in memory at 4 GiB with the basic type.
 */
const MAX_CELLD_CONTAINERS = Number.parseInt(
  process.env.SAM_DOCKER_PROXY_MAX_CONTAINERS ?? '4',
  10
);
const MAX_TRACKED_EXECS = Number.parseInt(process.env.SAM_DOCKER_PROXY_MAX_EXECS ?? '4096', 10);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
]);

let cachedPolicy: { mtimeMs: number; size: number; policy: ProxyPolicy } | null = null;
let policyUnavailableLogged = false;

/** The current policy, re-read when the deploy rewrites the file. Null fails every request. */
function currentPolicy(): ProxyPolicy | null {
  try {
    const stat = statSync(POLICY_PATH);
    if (cachedPolicy && cachedPolicy.mtimeMs === stat.mtimeMs && cachedPolicy.size === stat.size) {
      return cachedPolicy.policy;
    }
    const policy = parsePolicy(readFileSync(POLICY_PATH, 'utf8'));
    cachedPolicy = { mtimeMs: stat.mtimeMs, size: stat.size, policy };
    logEvent('policy_loaded', { runtime: policy.runtime, images: policy.sandboxImages.length });
    return policy;
  } catch (error) {
    // Once per transition, not per request (the healthcheck asks every few seconds).
    if (cachedPolicy || !policyUnavailableLogged) {
      logEvent('policy_unavailable', { path: POLICY_PATH, error: String(error).slice(0, 300) });
    }
    policyUnavailableLogged = true;
    cachedPolicy = null;
    return null;
  }
}

const execs = new Set<string>();

function recordExec(id: string): void {
  execs.add(id);
  while (execs.size > MAX_TRACKED_EXECS) {
    const oldest = execs.values().next().value;
    if (oldest === undefined) break;
    execs.delete(oldest);
  }
}

async function decideRequest(
  method: string,
  url: string,
  raw: Buffer,
  upgrade: boolean
): Promise<Decision> {
  const policy = currentPolicy();
  if (!policy) {
    // Liveness only: compose starts the proxy before the first deploy writes the policy.
    const path = url.split('?')[0];
    if ((method === 'GET' || method === 'HEAD') && path === '/_ping' && raw.length === 0) {
      return {
        allow: true,
        method,
        route: 'ping',
        target: '/_ping',
        body: null,
        upgrade: false,
        recordsExec: false,
      };
    }
    return {
      allow: false,
      status: 503,
      reason: 'the proxy has no valid policy (run pnpm selfhost:deploy)',
    };
  }
  let body: unknown;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return { allow: false, status: 400, reason: 'request body is not JSON' };
    }
  }
  return decide(
    { method, url, body, upgrade },
    { policy, inspectContainer, ownsExec: (id) => execs.has(id) }
  );
}

function refusalBody(decision: Extract<Decision, { allow: false }>): string {
  // A 404 reads exactly like the daemon's, so it says nothing about what else runs on the box.
  if (decision.status === 404) return JSON.stringify({ message: decision.reason });
  return JSON.stringify({ message: `sam-docker-proxy refused: ${decision.reason}` });
}

function logDecision(method: string, url: string, decision: Decision): void {
  if (decision.allow) {
    // Reads are frequent (celld polls inspect); log the calls that change something.
    if (decision.method !== 'GET' && decision.method !== 'HEAD') {
      logEvent('allowed', { method: decision.method, route: decision.route });
    }
  } else {
    logEvent('refused', {
      method: method.slice(0, 16),
      path: (url.split('?')[0] ?? '').slice(0, 200),
      status: decision.status,
      reason: (decision.detail ?? decision.reason).slice(0, 300),
    });
  }
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function upstreamOptions(decision: Extract<Decision, { allow: true }>, upgrade: boolean) {
  const headers: Record<string, string | number> = { Host: 'docker' };
  if (decision.body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(decision.body);
  }
  if (upgrade) {
    headers.Connection = 'Upgrade';
    headers.Upgrade = 'tcp';
  }
  return { socketPath: UPSTREAM, method: decision.method, path: decision.target, headers };
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Creates run one at a time, from the count to the daemon's answer, so parallel creates cannot all
 * see room under MAX_CELLD_CONTAINERS. Resolves to the release function for this turn.
 */
let createTail: Promise<void> = Promise.resolve();
function takeCreateTurn(): Promise<() => void> {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const turn = createTail.then(() => release);
  createTail = createTail.then(() => done);
  return turn;
}

/** Null when the create may go ahead; otherwise the refusal. Fails closed if the count fails. */
async function createCapRefusal(): Promise<Extract<Decision, { allow: false }> | null> {
  const live = await countCelldContainers().catch(() => null);
  if (live === null) {
    return { allow: false, status: 503, reason: 'create: cannot count celld containers' };
  }
  if (live >= MAX_CELLD_CONTAINERS) {
    return {
      allow: false,
      status: 429,
      reason: `create: celld already has ${live} containers (limit ${MAX_CELLD_CONTAINERS})`,
    };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const raw = await readBody(req);
  let decision: Decision =
    raw === null
      ? { allow: false, status: 413, reason: 'request body is too large' }
      : await decideRequest(method, url, raw, false);
  let releaseCreate: (() => void) | null = null;
  if (decision.allow && decision.route.startsWith('containers.create.')) {
    releaseCreate = await takeCreateTurn();
    const refusal = await createCapRefusal();
    if (refusal) {
      releaseCreate();
      releaseCreate = null;
      decision = refusal;
    }
  }
  const finishCreate = () => {
    releaseCreate?.();
    releaseCreate = null;
  };
  logDecision(method, url, decision);
  if (!decision.allow) {
    res.writeHead(decision.status, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(refusalBody(decision));
    return;
  }
  const node = decision.route === 'containers.list' ? reapingNode(url) : null;
  const policy = node ? currentPolicy() : null;
  if (node && policy) {
    reapStaleSandboxes(node, policy).catch((error: unknown) =>
      logEvent('reap_failed', { error: String(error).slice(0, 300) })
    );
  }
  const upstream = httpRequest(upstreamOptions(decision, false), (reply) => {
    const filter = Object.hasOwn(RESPONSE_FILTERS, decision.route)
      ? RESPONSE_FILTERS[decision.route]
      : undefined;
    if (decision.recordsExec || filter) {
      const chunks: Buffer[] = [];
      reply.on('data', (chunk: Buffer) => chunks.push(chunk));
      reply.on('end', () => {
        let text = Buffer.concat(chunks);
        const status = reply.statusCode ?? 502;
        if (status >= 200 && status < 300) {
          try {
            const answer: unknown = JSON.parse(text.toString('utf8'));
            if (decision.recordsExec && status === 201) {
              const id = isRecord(answer) ? answer.Id : undefined;
              if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) recordExec(id);
            }
            if (filter) text = Buffer.from(JSON.stringify(filter(answer)));
          } catch {
            // An unparseable success answer records nothing and is not passed on unfiltered.
            if (filter) text = Buffer.from('{}');
          }
        }
        const headers = forwardHeaders(reply.headers);
        headers['content-length'] = String(text.length);
        res.writeHead(status, headers);
        res.end(text);
      });
      return;
    }
    // The daemon has answered the create: the container now counts (or never will).
    reply.on('end', finishCreate);
    reply.on('close', finishCreate);
    res.writeHead(reply.statusCode ?? 502, forwardHeaders(reply.headers));
    reply.pipe(res);
  });
  upstream.on('error', (error) => {
    finishCreate();
    logEvent('upstream_error', { route: decision.route, error: String(error) });
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'sam-docker-proxy: the container engine did not answer' }));
  });
  // A long-polled wait whose caller went away must not hold the daemon connection.
  res.on('close', () => {
    finishCreate();
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.end(decision.body ?? undefined);
}

/** The request body of an upgrade request: whatever arrived with the head, then the socket. */
function readUpgradeBody(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<{ body: Buffer; rest: Buffer } | null> {
  const length = Number(req.headers['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let buffered = head;
    const done = (): boolean => {
      if (buffered.length < length) return false;
      socket.off('data', onData);
      socket.pause();
      resolve({ body: buffered.subarray(0, length), rest: buffered.subarray(length) });
      return true;
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_BODY_BYTES + 65536) {
        socket.off('data', onData);
        resolve(null);
        return;
      }
      done();
    };
    if (!done()) socket.on('data', onData);
  });
}

function rawResponse(socket: Duplex, status: number, reason: string, body: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  // Node removes its own error listener before 'upgrade'; without one a client that hangs up
  // mid-request (EPIPE) would crash the proxy.
  socket.on('error', () => socket.destroy());
  const method = req.method ?? 'POST';
  const url = req.url ?? '/';
  const read = await readUpgradeBody(req, socket, head);
  const decision: Decision = read
    ? await decideRequest(method, url, read.body, true)
    : { allow: false, status: 413, reason: 'request body is too large' };
  logDecision(method, url, decision);
  if (!decision.allow) {
    rawResponse(socket, decision.status, 'Refused', refusalBody(decision));
    return;
  }
  const upstream = httpRequest(upstreamOptions(decision, true));
  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 101 UPGRADED`];
    for (let i = 0; i < reply.rawHeaders.length; i += 2) {
      lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (read && read.rest.length > 0) upstreamSocket.write(read.rest);
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
    // stdin EOF is a half-close from celld; it reaches the daemon the same way.
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    socket.resume();
  });
  upstream.on('response', (reply) => {
    const chunks: Buffer[] = [];
    reply.on('data', (chunk: Buffer) => chunks.push(chunk));
    reply.on('end', () =>
      rawResponse(
        socket,
        reply.statusCode ?? 502,
        reply.statusMessage ?? 'Error',
        Buffer.concat(chunks).toString('utf8')
      )
    );
  });
  upstream.on('error', (error) => {
    logEvent('upstream_error', { route: decision.route, error: String(error) });
    rawResponse(
      socket,
      502,
      'Bad Gateway',
      JSON.stringify({ message: 'sam-docker-proxy: the container engine did not answer' })
    );
  });
  upstream.end(decision.body ?? undefined);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    logEvent('handler_error', { error: String(error) });
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'sam-docker-proxy: internal error' }));
  });
});
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  handleUpgrade(req, socket, head).catch((error: unknown) => {
    logEvent('handler_error', { error: String(error) });
    socket.destroy();
  });
});
server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});
// A container wait is a long poll; the daemon, not this proxy, decides when it ends.
server.requestTimeout = 0;
server.timeout = 0;

try {
  unlinkSync(LISTEN);
} catch {
  // No stale socket from a previous run.
}
const MAX_SANDBOX_AGE_SECONDS = Number.parseInt(
  process.env.SAM_DOCKER_PROXY_MAX_SANDBOX_AGE_SECONDS ?? String(DEFAULT_MAX_SANDBOX_AGE_SECONDS),
  10
);
const SWEEP_INTERVAL_MS = Number.parseInt(
  process.env.SAM_DOCKER_PROXY_SWEEP_INTERVAL_MS ?? '60000',
  10
);

server.listen(LISTEN, () => {
  chmodSync(LISTEN, SOCKET_MODE);
  logEvent('listening', { socket: LISTEN, upstream: UPSTREAM, policy: POLICY_PATH });
  currentPolicy();
  setInterval(() => {
    const policy = currentPolicy();
    if (!policy) return;
    reapOverageSandboxes(policy, MAX_SANDBOX_AGE_SECONDS).catch((error: unknown) =>
      logEvent('reap_failed', { error: String(error).slice(0, 300) })
    );
  }, SWEEP_INTERVAL_MS).unref();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    process.exit(0);
  });
}
