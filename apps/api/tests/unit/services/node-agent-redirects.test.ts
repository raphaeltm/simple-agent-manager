/**
 * The control plane never follows a node agent's redirect, on any transport (self-host T5
 * follow-up, item 7). Before the fix only reverse-tunnel nodes got `redirect: 'manual'`: a
 * node on another transport, or a legacy row with NULL transport, could answer 302 to a
 * loopback address and the Worker would follow it carrying the management Authorization
 * header. Real node row (SQLite), real HTTP servers, real fetch; only DNS for the node's
 * backend hostname is routed to the local stand-in.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { fetchNodeAgent } from '../../../src/services/node-agent';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NODE_ID = '01m7node0000000000000000aa';
const BASE_DOMAIN = 'example.test';

interface Hit {
  url: string;
  authorization: string | undefined;
}

function listen(handler: (req: IncomingMessage) => { status: number; location?: string }) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', authorization: req.headers.authorization });
    const { status, location } = handler(req);
    res.writeHead(status, location ? { Location: location } : {});
    res.end(status === 200 ? 'ok' : '');
  });
  return { server, hits };
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;

/** A loopback service on the box (celld's operator port, say). */
const internal = listen(() => ({ status: 200 }));
/** The node agent, redirecting every request to the internal service. */
const node = listen(() => ({
  status: 302,
  location: `http://127.0.0.1:${portOf(internal.server)}/v1/state`,
}));

const realFetch = globalThis.fetch;
const routedFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === `${NODE_ID}.vm.${BASE_DOMAIN}`) {
    url.protocol = 'http:';
    url.hostname = '127.0.0.1';
    url.port = String(portOf(node.server));
  }
  return realFetch(url, init);
});

let sqlite: Database.Database;
let env: Env;

beforeAll(async () => {
  for (const { server } of [internal, node]) {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  }
});
afterAll(async () => {
  for (const { server } of [internal, node]) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

beforeEach(() => {
  internal.hits.length = 0;
  node.hits.length = 0;
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.nodeReverseTunnelLeases]);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN } as Env;
  vi.stubGlobal('fetch', routedFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

function seedNode(transport: string | null, runtime = 'vm') {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, vm_size, vm_location,
                          cloud_provider, transport, runtime, created_at, updated_at)
       VALUES (?, 'user-1', 'node', 'running', 'healthy', 'cpx21', 'nbg1', 'hetzner', ?, ?, ?, ?)`
    )
    .run(NODE_ID, transport, runtime, now, now);
}

describe('fetchNodeAgent never follows a node redirect', () => {
  it.each([
    ['vm-public-dns', 'vm-public-dns'],
    ['cloudflare-tunnel', 'cloudflare-tunnel'],
    ['legacy NULL transport', null],
  ])('%s: the 302 comes back as-is and nothing reaches the internal service', async (_n, t) => {
    seedNode(t);
    const response = await fetchNodeAgent(
      NODE_ID,
      env,
      `https://${NODE_ID}.vm.${BASE_DOMAIN}:8443/workspaces/w1/files`,
      { headers: { Authorization: 'Bearer node-management-token' } },
      5_000
    );

    // Liveness: the node itself was asked, with the management token.
    expect(node.hits).toEqual([
      { url: '/workspaces/w1/files', authorization: 'Bearer node-management-token' },
    ]);
    expect(response.status).toBe(302);
    expect(response.ok).toBe(false); // callers (nodeAgentRequest and others) treat it as a failure
    expect(response.headers.get('location')).toContain('/v1/state');
    expect(internal.hits).toEqual([]);
  });
});

/** What every case asserts: the node was asked with its token, its 302 came back untouched. */
function expectRedirectReturned(response: Response, url = '/workspaces/w1/files') {
  expect(node.hits).toEqual([{ url, authorization: 'Bearer node-management-token' }]);
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toContain('/v1/state');
  expect(internal.hits).toEqual([]);
}

describe('the other fetchNodeAgent paths never follow a node redirect either', () => {
  it('without a DATABASE binding (the no-database branch)', async () => {
    const response = await fetchNodeAgent(
      NODE_ID,
      { BASE_DOMAIN } as Env,
      `https://${NODE_ID}.vm.${BASE_DOMAIN}:8443/workspaces/w1/files`,
      { headers: { Authorization: 'Bearer node-management-token' } },
      5_000
    );
    expectRedirectReturned(response);
  });

  it('a cf-container node, through the container binding', async () => {
    seedNode(null, 'cf-container');
    // The VmAgentContainer DO forwards the Request it receives unchanged to the container's
    // port (`containerFetch(request, port)` / `tcpPort.fetch(url, request)`), so the redirect
    // mode is whatever fetchNodeAgent put on it. This stub does the same with a real fetch to
    // the node stand-in.
    const forward = (request: Request) => {
      const url = new URL(request.url);
      url.port = String(portOf(node.server));
      return realFetch(new Request(url, request));
    };
    const stub = { proxyHttp: forward, proxyHttpNoWake: forward, proxyHttpGuarded: forward };
    const containerEnv = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: { idFromName: () => 'container-id', get: () => stub },
    } as unknown as Env;
    for (const noWakeContainer of [false, true]) {
      node.hits.length = 0;
      const response = await fetchNodeAgent(
        NODE_ID,
        containerEnv,
        `https://${NODE_ID}.vm.${BASE_DOMAIN}:8443/workspaces/w1/files`,
        { headers: { Authorization: 'Bearer node-management-token' } },
        5_000,
        { noWakeContainer }
      );
      expectRedirectReturned(response);
    }
  });
});
