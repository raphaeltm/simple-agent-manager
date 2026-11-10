/**
 * Self-hosted gateway endpoints through the REAL worker entry point on workerd + D1 with the
 * full migration chain (including 0232): the frps server plugin and Caddy forward_auth for node
 * WebSockets. The forward_auth tests drive the unchanged ws-* / logs-stream authentication by
 * re-dispatch, and assert that no request is sent to any node (Caddy does that).
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import { signPortAccessToken } from '../../src/services/jwt';
import {
  deriveReverseTunnelCredential,
  hashReverseTunnelCredential,
} from '../../src/services/node-reverse-tunnel-config';
import { ensureReverseTunnelLease } from '../../src/services/node-reverse-tunnel-leases';
import { seedNode, seedSignedInUser, seedUser, seedWorkspace } from './helpers/seed-d1';

const SECRET = 'gw-secret-0123456789abcdef0123456789abcdef';
const testEnv = (): Env => ({ ...env, REVERSE_TUNNEL_GATEWAY_SECRET: SECRET }) as Env;
const API = `https://api.${env.BASE_DOMAIN}`;

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Any node fetch from the Worker would be a bug on the gateway path.
  upstream = vi.fn(async () => new Response('unexpected node fetch', { status: 599 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

async function call(request: Request, e: Env = testEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, e, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface SeededNode {
  nodeId: string;
  incarnation: string;
  port: number;
  credential: string;
}

async function seedReverseNode(label: string, userId: string): Promise<SeededNode> {
  const nodeId = `RT${label}${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`.toUpperCase();
  const incarnation = crypto.randomUUID();
  await seedNode(nodeId, userId, { status: 'running' });
  await env.DATABASE.prepare(
    `UPDATE nodes SET runtime = 'vm', node_class = 'managed', transport = 'reverse-tunnel',
       runtime_incarnation_id = ? WHERE id = ?`
  )
    .bind(incarnation, nodeId)
    .run();
  const lease = await ensureReverseTunnelLease(testEnv(), {
    nodeId,
    userId,
    runtimeIncarnationId: incarnation,
  });
  return { nodeId, incarnation, port: lease.port, credential: lease.credential };
}

function frpsCall(op: string, content: unknown, secret = SECRET): Request {
  return new Request(`http://127.0.0.1:8080/api/self-host/gateway/frps-plugin?op=${op}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`frps:${secret}`)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version: '0.1.0', op, content }),
  });
}

const metas = (n: SeededNode, over: Partial<Record<string, string>> = {}) => ({
  node_id: n.nodeId,
  incarnation: n.incarnation,
  credential: n.credential,
  ...over,
});

async function verdict(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as { reject: boolean; reject_reason?: string };
}

describe('frps plugin endpoint', () => {
  it('admits the owner: Login, NewProxy on its own leased port, Ping', async () => {
    await seedUser('rt-owner');
    const a = await seedReverseNode('A', 'rt-owner');
    expect(
      await verdict(await call(frpsCall('Login', { user: a.nodeId, metas: metas(a) })))
    ).toEqual({ reject: false, unchange: true });
    const proxy = {
      user: { user: a.nodeId, metas: metas(a), run_id: 'r1' },
      proxy_name: `${a.nodeId}.sam-agent`,
      proxy_type: 'tcp',
      remote_port: a.port,
    };
    expect((await verdict(await call(frpsCall('NewProxy', proxy)))).reject).toBe(false);
    const ping = { user: { user: a.nodeId, metas: metas(a), run_id: 'r1' }, timestamp: 1 };
    expect((await verdict(await call(frpsCall('Ping', ping)))).reject).toBe(false);
  });

  it("refuses a node with a valid credential claiming another node's port", async () => {
    await seedUser('rt-attacker');
    await seedUser('rt-victim');
    const attacker = await seedReverseNode('X', 'rt-attacker');
    const victim = await seedReverseNode('V', 'rt-victim');
    expect(attacker.port).not.toBe(victim.port);
    const claim = (remotePort: number) =>
      call(
        frpsCall('NewProxy', {
          user: { user: attacker.nodeId, metas: metas(attacker), run_id: 'r' },
          proxy_name: `${attacker.nodeId}.sam-agent`,
          proxy_type: 'tcp',
          remote_port: remotePort,
        })
      );
    const attack = await verdict(await claim(victim.port));
    expect(attack).toEqual({
      reject: true,
      reject_reason: 'remote port is not leased to this node',
    });
    // Owner-path control with the same credential and fixture: its own port is admitted.
    expect((await verdict(await claim(attacker.port))).reject).toBe(false);
  });

  it("refuses one node's credential presented as another node's identity", async () => {
    await seedUser('rt-imp');
    const a = await seedReverseNode('I', 'rt-imp');
    const b = await seedReverseNode('J', 'rt-imp');
    const forged = await verdict(
      await call(
        frpsCall('Login', {
          user: b.nodeId,
          metas: { node_id: b.nodeId, incarnation: b.incarnation, credential: a.credential },
        })
      )
    );
    expect(forged.reject).toBe(true);
    const mismatch = await verdict(
      await call(frpsCall('Login', { user: b.nodeId, metas: metas(a) }))
    );
    expect(mismatch).toEqual({ reject: true, reject_reason: 'user must equal node id' });
  });

  it('refuses a released lease and a superseded incarnation on Ping (session revocation)', async () => {
    await seedUser('rt-rel');
    const a = await seedReverseNode('R', 'rt-rel');
    const ping = () =>
      call(frpsCall('Ping', { user: { user: a.nodeId, metas: metas(a), run_id: 'r' } }));
    expect((await verdict(await ping())).reject).toBe(false);
    await env.DATABASE.prepare('UPDATE nodes SET runtime_incarnation_id = ? WHERE id = ?')
      .bind(crypto.randomUUID(), a.nodeId)
      .run();
    expect(await verdict(await ping())).toEqual({
      reject: true,
      reject_reason: 'node incarnation is not live',
    });
    await env.DATABASE.prepare(
      "UPDATE node_reverse_tunnel_leases SET status = 'released' WHERE node_id = ?"
    )
      .bind(a.nodeId)
      .run();
    expect(await verdict(await ping())).toEqual({
      reject: true,
      reject_reason: 'node lease is released',
    });
  });

  it.each([
    ['an udp proxy', { proxy_type: 'udp' }, 'only one tcp proxy is allowed'],
    ['a foreign proxy name', { proxy_name: 'other.sam-agent' }, 'proxy name is not the node agent'],
  ])('refuses %s', async (_name, over, reason) => {
    await seedUser('rt-shape');
    const a = await seedReverseNode('S', 'rt-shape');
    const response = await call(
      frpsCall('NewProxy', {
        user: { user: a.nodeId, metas: metas(a), run_id: 'r' },
        proxy_name: `${a.nodeId}.sam-agent`,
        proxy_type: 'tcp',
        remote_port: a.port,
        ...over,
      })
    );
    expect(await verdict(response)).toEqual({ reject: true, reject_reason: reason });
  });

  it('fails closed on a wrong secret, no secret, an unknown op and a malformed body', async () => {
    expect((await call(frpsCall('Login', {}, 'x'.repeat(40)))).status).toBe(401);
    expect((await call(frpsCall('Login', {}), { ...env } as Env)).status).toBe(404);
    expect((await verdict(await call(frpsCall('CloseProxy', {})))).reject).toBe(true);
    expect(await verdict(await call(frpsCall('Login', { user: 'x' })))).toEqual({
      reject: true,
      reject_reason: 'malformed plugin request',
    });
  });

  it('stores only a hash of the credential', async () => {
    await seedUser('rt-hash');
    const a = await seedReverseNode('H', 'rt-hash');
    const row = await env.DATABASE.prepare(
      'SELECT id, credential_hash AS hash FROM node_reverse_tunnel_leases WHERE node_id = ?'
    )
      .bind(a.nodeId)
      .first<{ id: string; hash: string }>();
    expect(row?.hash).toBe(await hashReverseTunnelCredential(a.credential));
    expect(row?.hash).not.toContain(a.credential);
    expect(
      await deriveReverseTunnelCredential(testEnv(), {
        leaseId: row!.id,
        nodeId: a.nodeId,
        runtimeIncarnationId: a.incarnation,
      })
    ).toBe(a.credential);
  });
});

describe('lease allocation on D1', () => {
  it('never hands two concurrent nodes the same port', async () => {
    await seedUser('rt-conc');
    const nodes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => seedReverseNode(`C${i}`, 'rt-conc'))
    );
    const ports = nodes.map((n) => n.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('gives the last free port to exactly one of two contenders', async () => {
    await seedUser('rt-last');
    const ids = ['L1', 'L2'].map((l) => `RT${l}${crypto.randomUUID().slice(0, 8)}`.toUpperCase());
    const incarnations = ids.map(() => crypto.randomUUID());
    for (const [i, id] of ids.entries()) {
      await seedNode(id, 'rt-last', { status: 'running' });
      await env.DATABASE.prepare(
        `UPDATE nodes SET runtime = 'vm', node_class = 'managed', transport = 'reverse-tunnel',
           runtime_incarnation_id = ? WHERE id = ?`
      )
        .bind(incarnations[i], id)
        .run();
    }
    const oneFreePort = {
      ...testEnv(),
      REVERSE_TUNNEL_PORT_RANGE_START: '28999',
      REVERSE_TUNNEL_PORT_RANGE_END: '28999',
    };
    const results = await Promise.allSettled(
      ids.map((nodeId, i) =>
        ensureReverseTunnelLease(oneFreePort as Env, {
          nodeId,
          userId: 'rt-last',
          runtimeIncarnationId: incarnations[i]!,
        })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('No free reverse-tunnel port in 28999-28999');
  });
});

function gatewayCall(
  forwardedHost: string,
  forwardedUri: string,
  headers: Record<string, string> = {},
  secret = SECRET
): Request {
  return new Request(`${API}/api/self-host/gateway/node-websocket`, {
    headers: {
      'X-SAM-Gateway-Secret': secret,
      // As deploy/selfhost/caddy/sam.d/node-ws.caddy sends it: celld derives request.url from
      // X-Forwarded-Host, so that names the API host and the socket's host travels separately.
      'X-Forwarded-Host': `api.${env.BASE_DOMAIN}`,
      'X-SAM-Gateway-Original-Host': forwardedHost,
      'X-Forwarded-Uri': forwardedUri,
      'X-Forwarded-Method': 'GET',
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      ...headers,
    },
  });
}

async function seedWorkspaceOn(node: SeededNode, userId: string, label: string) {
  const workspaceId = `01KRRT${label}${'0'.repeat(20 - label.length)}`;
  await seedWorkspace(workspaceId, node.nodeId, userId, { status: 'running' });
  return workspaceId;
}

describe('node WebSocket forward_auth', () => {
  it('authorizes a public-port preview socket and returns the loopback upstream, never fetching', async () => {
    await seedUser('rt-ws-pub');
    const node = await seedReverseNode('P', 'rt-ws-pub');
    const workspaceId = await seedWorkspaceOn(node, 'rt-ws-pub', 'PB1');
    await env.DATABASE.prepare('UPDATE workspaces SET ports_public_enabled = 1 WHERE id = ?')
      .bind(workspaceId)
      .run();
    const response = await call(
      gatewayCall(`ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}`, '/hmr?revision=2', {
        Cookie: 'sam_port_access=stale; app=1',
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${node.port}`);
    const uri = new URL(`http://x${response.headers.get('X-SAM-Upstream-Uri')}`);
    expect(uri.pathname).toBe(`/workspaces/${workspaceId}/ports/3000/hmr`);
    expect(uri.searchParams.get('revision')).toBe('2');
    expect(uri.searchParams.get('token')).toBeTruthy();
    expect(response.headers.get('X-SAM-Node-Id')).toBe(node.nodeId);
    expect(response.headers.get('X-SAM-Workspace-Id')).toBe(workspaceId);
    // The preview auth cookie is stripped exactly as on the Worker path; other cookies remain.
    expect(response.headers.get('X-SAM-Upstream-Cookie')).toBe('app=1');
    expect(response.headers.get('X-SAM-Gateway-Decision')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('turns a port token into the cookie redirect, with the cookie, like the Worker path', async () => {
    await seedUser('rt-ws-tok');
    const node = await seedReverseNode('T', 'rt-ws-tok');
    const workspaceId = await seedWorkspaceOn(node, 'rt-ws-tok', 'TK1');
    const token = await signPortAccessToken('rt-ws-tok', workspaceId, 3000, testEnv());
    const response = await call(
      gatewayCall(
        `ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}`,
        `/app?port_token=${token}`
      )
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Set-Cookie')).toContain(`sam_port_access=${token}`);
    expect(response.headers.get('Location')).not.toContain('port_token');
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it('refuses an unauthenticated private port and an unauthenticated terminal socket', async () => {
    await seedUser('rt-ws-anon');
    const node = await seedReverseNode('N', 'rt-ws-anon');
    const workspaceId = await seedWorkspaceOn(node, 'rt-ws-anon', 'AN1');
    const port = await call(
      gatewayCall(`ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}`, '/')
    );
    expect(port.status).toBe(401);
    expect(port.headers.get('X-SAM-Upstream')).toBeNull();
    const terminal = await call(
      gatewayCall(`ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`, '/terminal/ws')
    );
    expect(terminal.status).toBe(401);
    expect(terminal.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it("authorizes the owner's session for the agent socket but not another user's", async () => {
    await seedUser('rt-ws-own');
    await seedUser('rt-ws-other');
    const node = await seedReverseNode('O', 'rt-ws-own');
    const workspaceId = await seedWorkspaceOn(node, 'rt-ws-own', 'WN1');
    const host = `ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`;
    const owner = await call(
      gatewayCall(host, '/agent/ws?x=1', { Cookie: await seedSignedInUser('rt-ws-own') })
    );
    expect(owner.status).toBe(200);
    expect(owner.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${node.port}`);
    expect(owner.headers.get('X-SAM-Upstream-Uri')).toBe('/agent/ws?x=1');
    const other = await call(
      gatewayCall(host, '/agent/ws?x=1', { Cookie: await seedSignedInUser('rt-ws-other') })
    );
    expect(other.status).toBe(404);
    expect(other.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it('authorizes the node log stream for its owner and injects a node management token', async () => {
    await seedUser('rt-logs');
    const node = await seedReverseNode('G', 'rt-logs');
    const response = await call(
      gatewayCall(`api.${env.BASE_DOMAIN}`, `/api/nodes/${node.nodeId}/logs/stream?source=agent`, {
        Cookie: await seedSignedInUser('rt-logs'),
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${node.port}`);
    const uri = new URL(`http://x${response.headers.get('X-SAM-Upstream-Uri')}`);
    expect(uri.pathname).toBe('/logs/stream');
    expect(uri.searchParams.get('source')).toBe('agent');
    expect(response.headers.get('X-SAM-Upstream-Authorization')).toMatch(/^Bearer ey/);
    // The browser's own cookie must not reach the vm-agent on this route.
    expect(response.headers.get('X-SAM-Upstream-Cookie')).toBe('');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a node that is not on the reverse-tunnel transport', async () => {
    await seedUser('rt-ws-dns');
    await seedNode('RTPUBLICDNSNODE', 'rt-ws-dns', { status: 'running' });
    const workspaceId = '01KRRTDNS00000000000000000';
    await seedWorkspace(workspaceId, 'RTPUBLICDNSNODE', 'rt-ws-dns', { status: 'running' });
    await env.DATABASE.prepare('UPDATE workspaces SET ports_public_enabled = 1 WHERE id = ?')
      .bind(workspaceId)
      .run();
    const response = await call(
      gatewayCall(`ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}`, '/')
    );
    expect(response.status).toBe(502);
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('never forwards the gateway secret to a node, even when a request carrying it reaches the ws-* proxy', async () => {
    await seedUser('rt-ws-leak');
    const node = await seedReverseNode('K', 'rt-ws-leak');
    const workspaceId = await seedWorkspaceOn(node, 'rt-ws-leak', 'KK1');
    await env.DATABASE.prepare('UPDATE workspaces SET ports_public_enabled = 1 WHERE id = ?')
      .bind(workspaceId)
      .run();
    upstream.mockImplementation(async () => new Response('from node'));
    // What celld produced before the fix: the forward_auth subrequest's URL host rewritten
    // to the socket's ws-* host, so the ws-* proxy (not the gateway route) handled it.
    const response = await call(
      new Request(`https://ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}/x`, {
        headers: { 'X-SAM-Gateway-Secret': SECRET },
      })
    );
    expect(await response.text()).toBe('from node');
    const sent = upstream.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(sent.headers).get('x-sam-gateway-secret')).toBeNull();
    expect(String(upstream.mock.calls[0]?.[0])).toContain(`http://127.0.0.1:${node.port}/`);
  });

  it('reads the socket host from the gateway header, not X-Forwarded-Host', async () => {
    const response = await call(
      new Request(`${API}/api/self-host/gateway/node-websocket`, {
        headers: {
          'X-SAM-Gateway-Secret': SECRET,
          'X-Forwarded-Host': `ws-01krrtx0000000000000000000--3000.${env.BASE_DOMAIN}`,
          'X-Forwarded-Uri': '/',
          'X-Forwarded-Method': 'GET',
          Upgrade: 'websocket',
        },
      })
    );
    expect(response.status).toBe(403);
  });

  it('fails closed on a wrong or missing secret and on non-gateway targets', async () => {
    const host = `ws-01krrtx0000000000000000000.${env.BASE_DOMAIN}`;
    expect((await call(gatewayCall(host, '/', {}, 'y'.repeat(40)))).status).toBe(401);
    expect((await call(gatewayCall(host, '/'), { ...env } as Env)).status).toBe(404);
    expect((await call(gatewayCall(`api.${env.BASE_DOMAIN}`, '/api/projects'))).status).toBe(403);
    expect(
      (await call(gatewayCall(host, '/', { Upgrade: '' }))).status,
      'plain HTTP is not a gateway route'
    ).toBe(403);
  });
});
