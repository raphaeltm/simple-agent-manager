/**
 * Live: the box's real Caddyfile and sam.d fragments (deploy/selfhost/caddy/), run by the
 * pinned Caddy release in Docker with host networking, in front of stub upstreams that record
 * what reaches them:
 *
 * - celld stub: answers the forward_auth subrequest as the test scenario says, and 200 for
 *   anything else (so a request that should never leave Caddy is visible when it does);
 * - node stub: a node agent behind a lease port that accepts WebSocket upgrades.
 *
 * Checked: the public 404 for /api/self-host/gateway on every host and under path tricks (and for
 * the key-rotation control path, /__sam-selfhost/), the
 * stripping of client X-SAM-* headers before forward_auth and before the node, and the 101
 * Set-Cookie rule for port-preview sockets.
 *
 * Image: the runtime stage of deploy/selfhost/caddy/Dockerfile (same Caddy release and digest;
 * the shipped image only adds a DNS-provider module, which internal TLS does not load).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { posix } from 'node:path';
import type { Duplex } from 'node:stream';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { caddyRuntimeImage, freePort, REPO_ROOT, waitFor } from './harness';

const DOMAIN = 'sam.test';
const SECRET = randomBytes(32).toString('hex');
const WORKSPACE = '01krrtliveaaaaaaaaaaaaaaaa';
const WS_HOST = `ws-${WORKSPACE}.${DOMAIN}`;
const PORT_HOST = `ws-${WORKSPACE}--3000.${DOMAIN}`;
const CADDY_DIR = `${REPO_ROOT}/deploy/selfhost/caddy`;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

type Decision = { status: number; headers?: OutgoingHttpHeaders };

const celldSeen: Seen[] = [];
const nodeSeen: Seen[] = [];
let decide: (req: IncomingMessage) => Decision = () => ({ status: 401 });
let nodeUpgradeHeaders: Record<string, string> = {};
let celld: Server;
let node: Server;
let ports: { https: number; http: number; celld: number; frps: number; node: number };
let container = '';

const record = (req: IncomingMessage): Seen => ({
  method: req.method ?? '',
  url: req.url ?? '',
  headers: req.headers,
});

function acceptKey(key: string | string[] | undefined): string {
  return createHash('sha1')
    .update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

beforeAll(async () => {
  ports = {
    https: await freePort(),
    http: await freePort(),
    celld: await freePort(),
    frps: await freePort(),
    node: await freePort(),
  };
  celld = createServer((req, res) => {
    celldSeen.push(record(req));
    if (req.url?.startsWith('/api/self-host/gateway/node-websocket')) {
      const { status, headers } = decide(req);
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.end('celld');
  });
  node = createServer((req, res) => {
    nodeSeen.push(record(req));
    res.setHeader('Set-Cookie', 'node_cookie=1');
    res.end('node');
  });
  node.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    nodeSeen.push(record(req));
    const extra = Object.entries(nodeUpgradeHeaders)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n${extra}\r\n`
    );
    socket.end();
  });
  await new Promise<void>((done) => celld.listen(ports.celld, '127.0.0.1', done));
  await new Promise<void>((done) => node.listen(ports.node, '127.0.0.1', done));

  container = `sam-live-caddy-${randomBytes(4).toString('hex')}`;
  const env = {
    SAM_DOMAIN: DOMAIN,
    SAM_TLS_MODE: 'internal',
    HTTP_PORT: String(ports.http),
    HTTPS_PORT: String(ports.https),
    CELLD_PORT: String(ports.celld),
    FRPS_BIND_PORT: String(ports.frps),
    REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
  };
  execFileSync('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '--network',
    'host',
    '-v',
    `${CADDY_DIR}:/etc/caddy:ro`,
    ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    caddyRuntimeImage(),
    'caddy',
    'run',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ]);
  const logs = () => {
    try {
      return execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      return String(err);
    }
  };
  await waitFor(
    'Caddy to serve TLS',
    async () => {
      try {
        return (await send('app', '/')).status === 200;
      } catch {
        return false;
      }
    },
    120_000,
    logs
  );
});

afterAll(async () => {
  if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  await new Promise<void>((done) => (celld ? celld.close(() => done()) : done()));
  await new Promise<void>((done) => (node ? node.close(() => done()) : done()));
});

beforeEach(() => {
  celldSeen.length = 0;
  nodeSeen.length = 0;
  nodeUpgradeHeaders = {};
  decide = () => ({ status: 401 });
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
}

/** One HTTPS request through Caddy with an exact raw path (Node does not normalize it). */
function send(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  upgrade = false
): Promise<Reply> {
  const fullHost = host.includes('.') ? host : `${host}.${DOMAIN}`;
  return new Promise((done, fail) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port: ports.https,
      servername: fullHost.toLowerCase(),
      rejectUnauthorized: false,
      method: 'GET',
      path,
      headers: {
        Host: fullHost,
        ...(upgrade
          ? {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            }
          : {}),
        ...headers,
      },
    });
    req.on('upgrade', (res: IncomingMessage, socket: Duplex) => {
      socket.destroy();
      done({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', fail);
    req.end();
  });
}

/** What celld (Deno / workerd URL parsing) could treat as the gateway route, generously. */
function couldBeGatewayPath(raw: string): boolean {
  let path = raw.split('?')[0] ?? '';
  for (let i = 0; i < 3; i += 1) {
    try {
      path = decodeURIComponent(path);
    } catch {
      break;
    }
  }
  path = posix.normalize(path.replaceAll('\\', '/').replace(/\/+/g, '/')).toLowerCase();
  return path.startsWith('/api/self-host/gateway');
}

const HOSTS = ['api', 'app', `ws-${WORKSPACE}`, `ws-${WORKSPACE}--3000`, 'API'];
const CANONICAL = [
  '/api/self-host/gateway',
  '/api/self-host/gateway/',
  '/api/self-host/gateway/frps-plugin?op=Login',
  '/api/self-host/gateway/node-websocket',
];
const TRICKS = [
  '//api/self-host/gateway/frps-plugin',
  '/api//self-host/gateway/frps-plugin',
  '/api/self-host//gateway/node-websocket',
  '/api/self-host/./gateway/frps-plugin',
  '/api/self-host/x/../gateway/frps-plugin',
  '/api/./self-host/gateway/',
  '/api/self-host/gateway%2Ffrps-plugin',
  '/api%2Fself-host%2Fgateway%2Ffrps-plugin',
  '/api/self-host/%67ateway/frps-plugin',
  '/api/self-host/gateway%252Ffrps-plugin',
  '/API/SELF-HOST/GATEWAY/frps-plugin',
  '/Api/Self-Host/Gateway',
  '/api/self-host/gateway;x=1',
  '/api/self-host/gateway%00/frps-plugin',
  '/api/self-host/gateway/..%2Ffrps-plugin',
  // Encoded hyphen: only the raw-request-path clause of the variant matcher sees these.
  '/api/self%2Dhost/gateway/',
  '/API/SELF%2DHOST/gateway',
  '/api/self%252dhost/gateway/frps-plugin',
  '/api/self%252Dhost/gateway/node-websocket',
];

describe('the key-rotation control path is never served publicly', () => {
  // The Worker matches the path exactly (selfhost/key-rotation/control.ts), so another spelling
  // reaches the app's 404; Caddy refuses the canonical forms before celld (sam.d/key-rotation.caddy).
  it.each(
    ['api', 'app', 'API'].flatMap((host) =>
      ['/__sam-selfhost/key-rotation', '/__sam-selfhost/', '/__sam-selfhost/key-rotation?x=1'].map(
        (path) => [host, path] as const
      )
    )
  )('404 on %s for %s', async (host, path) => {
    const reply = await send(host, path, {}, false);
    expect(reply.status, `${host}${path}`).toBe(404);
    expect(celldSeen.filter((seen) => seen.url.includes('__sam-selfhost'))).toEqual([]);
  });
});

describe('internal gateway routes are never served publicly', () => {
  it.each(HOSTS.flatMap((host) => CANONICAL.map((path) => [host, path] as const)))(
    '404 on %s for %s, plain and upgrade',
    async (host, path) => {
      for (const upgrade of [false, true]) {
        const reply = await send(host, path, {}, upgrade);
        expect(reply.status, `${host}${path} upgrade=${upgrade}`).toBe(404);
      }
      expect(celldSeen).toEqual([]);
      expect(nodeSeen).toEqual([]);
    }
  );

  // Non-workspace hosts only: on a ws-* host the Worker hands every request to the workspace
  // proxy before any route (apps/api/src/index.ts; pinned by the workers test 'never forwards
  // the gateway secret to a node, even when a request carrying it reaches the ws-* proxy').
  const API_HOSTS = ['api', 'app', 'API', 'App'];
  it.each(API_HOSTS.flatMap((host) => TRICKS.map((path) => [host, path] as const)))(
    'no path trick on %s reaches the gateway route: %s',
    async (host, path) => {
      for (const upgrade of [false, true]) {
        const reply = await send(host, path, {}, upgrade);
        expect(reply.status, `${host}${path} upgrade=${upgrade}`).not.toBe(101);
        expect(reply.status, `${host}${path} upgrade=${upgrade}`).toBeGreaterThanOrEqual(400);
      }
      // Whatever Caddy did with it, nothing celld could route to the gateway arrived there.
      expect(celldSeen.filter((seen) => couldBeGatewayPath(seen.url))).toEqual([]);
      expect(nodeSeen).toEqual([]);
    }
  );

  it('control: ordinary API traffic and a preview app path naming self-hosting reach celld', async () => {
    expect((await send('api', '/api/projects?q=self-host')).status).toBe(200);
    expect((await send(`ws-${WORKSPACE}--3000`, '/docs/self-hosting')).status).toBe(200);
    expect(celldSeen.map((seen) => seen.url)).toEqual([
      '/api/projects?q=self-host',
      '/docs/self-hosting',
    ]);
  });
});

const FORGED = {
  'X-SAM-Gateway-Secret': 'client-forged-secret',
  'X-SAM-Gateway-Original-Host': `api.${DOMAIN}`,
  'X-SAM-Upstream': '127.0.0.1:7001',
  'X-SAM-Upstream-Uri': '/forged',
  'X-SAM-Upstream-Authorization': 'Bearer forged',
  'X-SAM-Upstream-Cookie': 'forged=1',
  'x-sam-node-id': 'FORGED-NODE',
  'X-Sam-Workspace-Id': 'FORGED-WS',
};

const forwardAuth = () =>
  celldSeen.filter((seen) => seen.url.startsWith('/api/self-host/gateway/node-websocket'));

describe('forward_auth for node WebSockets', () => {
  it.each([WS_HOST, PORT_HOST])(
    'strips client X-SAM-* headers before forward_auth and passes a refusal through (%s)',
    async (host) => {
      decide = () => ({ status: 401, headers: { 'Content-Type': 'application/json' } });
      const reply = await send(host, '/agent/ws', FORGED, true);
      expect(reply.status).toBe(401);
      const [auth, ...more] = forwardAuth();
      expect(more).toEqual([]);
      expect(auth?.headers['x-sam-gateway-secret']).toBe(SECRET);
      expect(auth?.headers['x-sam-gateway-original-host']).toBe(host);
      expect(auth?.headers['x-forwarded-uri']).toBe('/agent/ws');
      for (const name of [
        'x-sam-upstream',
        'x-sam-upstream-uri',
        'x-sam-upstream-authorization',
        'x-sam-upstream-cookie',
        'x-sam-node-id',
        'x-sam-workspace-id',
      ]) {
        expect(auth?.headers[name], name).toBeUndefined();
      }
      expect(nodeSeen).toEqual([]);
    }
  );

  it('proxies an authorized socket with exactly the Worker-decided headers', async () => {
    decide = () => ({
      status: 200,
      headers: {
        'X-SAM-Upstream': `127.0.0.1:${ports.node}`,
        'X-SAM-Upstream-Uri': '/agent/ws?decided=1',
        'X-SAM-Upstream-Authorization': 'Bearer worker-decided',
        'X-SAM-Upstream-Cookie': '',
        'X-SAM-Node-Id': 'NODE-REAL',
        'X-SAM-Workspace-Id': 'WS-REAL',
      },
    });
    const reply = await send(
      WS_HOST,
      '/agent/ws?client=1',
      { ...FORGED, Authorization: 'Bearer client', Cookie: 'session=client' },
      true
    );
    expect(reply.status).toBe(101);
    const [upstream] = nodeSeen;
    expect(upstream?.url).toBe('/agent/ws?decided=1');
    expect(upstream?.headers.authorization).toBe('Bearer worker-decided');
    expect(upstream?.headers.cookie ?? '').toBe('');
    expect(upstream?.headers['x-sam-node-id']).toBe('NODE-REAL');
    expect(upstream?.headers['x-sam-workspace-id']).toBe('WS-REAL');
    expect(upstream?.headers['x-forwarded-host']).toBe(WS_HOST);
    for (const name of [
      'x-sam-gateway-secret',
      'x-sam-gateway-original-host',
      'x-sam-upstream',
      'x-sam-upstream-uri',
      'x-sam-upstream-authorization',
      'x-sam-upstream-cookie',
    ]) {
      expect(upstream?.headers[name], name).toBeUndefined();
    }
  });
});

describe('Set-Cookie on port-preview sockets', () => {
  const allowTo = (uri: string): Decision => ({
    status: 200,
    headers: {
      'X-SAM-Upstream': `127.0.0.1:${ports.node}`,
      'X-SAM-Upstream-Uri': uri,
      'X-SAM-Upstream-Authorization': '',
      'X-SAM-Upstream-Cookie': '',
      'X-SAM-Node-Id': 'NODE-REAL',
      'X-SAM-Workspace-Id': 'WS-REAL',
    },
  });

  it('drops a Set-Cookie the workspace app sends on its 101 upgrade', async () => {
    decide = () => allowTo('/workspaces/W/ports/3000/hmr');
    nodeUpgradeHeaders = { 'Set-Cookie': 'sam_port_access=from-the-app; Path=/' };
    const reply = await send(PORT_HOST, '/hmr', {}, true);
    expect(reply.status).toBe(101);
    expect(nodeSeen).toHaveLength(1);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it("control: SAM's own port-token redirect keeps its cookie", async () => {
    decide = () => ({
      status: 302,
      headers: {
        Location: `https://${PORT_HOST}/app`,
        'Set-Cookie': 'sam_port_access=from-sam; Path=/; HttpOnly; Secure',
      },
    });
    const reply = await send(PORT_HOST, '/app?port_token=t', {}, true);
    expect(reply.status).toBe(302);
    expect(reply.headers['set-cookie']).toEqual([
      'sam_port_access=from-sam; Path=/; HttpOnly; Secure',
    ]);
    expect(nodeSeen).toEqual([]);
  });

  it('control: the agent socket on a non-port host is not a port preview', async () => {
    decide = () => allowTo('/agent/ws');
    nodeUpgradeHeaders = { 'X-Node-Marker': 'reached' };
    const reply = await send(WS_HOST, '/agent/ws', {}, true);
    expect(reply.status).toBe(101);
    expect(reply.headers['x-node-marker']).toBe('reached');
  });
});
