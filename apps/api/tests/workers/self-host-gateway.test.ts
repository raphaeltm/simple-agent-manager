/**
 * Self-host gateway endpoints through the REAL Worker entry wrapped by the self-host entry
 * (`selfhost/reverse-tunnel/entry.ts` `withReverseTunnel`), on workerd + D1 with the shared
 * migration chain plus the self-host 0255 lease DDL: the frps server plugin, Caddy forward_auth
 * for node WebSockets, and the ws-* proxy routing a reverse-tunnel node to its lease. The
 * forward_auth tests drive the unchanged ws-* / logs-stream authentication by re-dispatch and
 * assert that no request is sent to any node (Caddy does that).
 */
import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import leaseDdl from '../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql?raw';
import { withReverseTunnel } from '../../src/selfhost/reverse-tunnel/entry';
import { ensureReverseTunnelLease } from '../../src/selfhost/reverse-tunnel/leases';
import { signPortAccessToken, signTerminalToken } from '../../src/services/jwt';
import { seedNode, seedSignedInUser, seedUser, seedWorkspace } from './helpers/seed-d1';

// Built at runtime so no secret-shaped literal sits in the source (gitleaks).
const SECRET = ['gateway', 'fixture', 'value', 'for', 'self', 'host', 'tests'].join('-');
const testEnv = (): Env =>
  ({ ...env, VM_AGENT_TRANSPORT: 'reverse-tunnel', REVERSE_TUNNEL_GATEWAY_SECRET: SECRET }) as Env;
const API = `https://api.${env.BASE_DOMAIN}`;
const selfHost = withReverseTunnel(worker, generateCloudInit);

beforeAll(async () => {
  const statements = leaseDdl
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await env.DATABASE.prepare(statement).run();
});

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Any node fetch from the Worker would be a bug on the gateway path.
  upstream = vi.fn(async () => new Response('unexpected node fetch', { status: 599 }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

async function call(request: Request, e: Env = testEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await selfHost.fetch(request, e, ctx);
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

const metas = (n: SeededNode) => ({
  node_id: n.nodeId,
  incarnation: n.incarnation,
  credential: n.credential,
});

interface Verdict {
  reject: boolean;
  reject_reason?: string;
  unchange?: boolean;
  content?: Record<string, unknown>;
}
async function verdict(response: Response): Promise<Verdict> {
  expect(response.status).toBe(200);
  return (await response.json()) as Verdict;
}

describe('frps plugin endpoint', () => {
  it('serializes the Login allow as unchange:false with the server-chosen run_id, and fences later ops on it', async () => {
    await seedUser('rt-owner');
    const a = await seedReverseNode('A', 'rt-owner');
    const login = await verdict(
      await call(
        frpsCall('Login', { user: a.nodeId, metas: metas(a), version: '0.72.0', pool_count: 1 })
      )
    );
    // frps applies `content` only with unchange:false; every Login field survives.
    expect(login.reject).toBe(false);
    expect(login.unchange).toBe(false);
    expect(login.content).toMatchObject({
      user: a.nodeId,
      metas: metas(a),
      version: '0.72.0',
      pool_count: 1,
    });
    const runId = login.content?.run_id;
    expect(runId).toMatch(/^[0-9a-f]{32}$/);
    // A duplicate Login for the same lease gets the same run_id, so frps replaces the old control.
    const again = await verdict(await call(frpsCall('Login', { user: a.nodeId, metas: metas(a) })));
    expect(again.content?.run_id).toBe(runId);

    const user = { user: a.nodeId, metas: metas(a), run_id: runId };
    expect(await verdict(await call(frpsCall('Ping', { user })))).toEqual({
      reject: false,
      unchange: true,
    });
    const proxy = {
      user,
      proxy_name: `${a.nodeId}.sam-agent`,
      proxy_type: 'tcp',
      remote_port: a.port,
    };
    expect(await verdict(await call(frpsCall('NewProxy', proxy)))).toEqual({
      reject: false,
      unchange: true,
    });
    // A control session whose run_id is not the server-chosen one is refused.
    expect(
      await verdict(await call(frpsCall('Ping', { user: { ...user, run_id: 'client-chosen' } })))
    ).toEqual({ reject: true, reject_reason: 'control session identity mismatch' });
  });

  it('refuses a released lease on Ping (session revocation), with a live control', async () => {
    await seedUser('rt-rel');
    const a = await seedReverseNode('R', 'rt-rel');
    const login = await verdict(await call(frpsCall('Login', { user: a.nodeId, metas: metas(a) })));
    const ping = () =>
      call(
        frpsCall('Ping', {
          user: { user: a.nodeId, metas: metas(a), run_id: login.content?.run_id },
        })
      );
    expect((await verdict(await ping())).reject).toBe(false);
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

  it('fails closed on a wrong secret, no secret, a foreign basic user, an unknown op and a malformed body', async () => {
    expect((await call(frpsCall('Login', {}, 'x'.repeat(40)))).status).toBe(401);
    expect((await call(frpsCall('Login', {}), { ...env } as Env)).status).toBe(404);
    const foreignUser = frpsCall('Login', {});
    foreignUser.headers.set('Authorization', `Basic ${btoa(`admin:${SECRET}`)}`);
    expect((await call(foreignUser)).status).toBe(401);
    expect((await verdict(await call(frpsCall('CloseProxy', {})))).reject).toBe(true);
    expect(await verdict(await call(frpsCall('Login', { user: 'x' })))).toEqual({
      reject: true,
      reject_reason: 'malformed plugin request',
    });
    expect(upstream).not.toHaveBeenCalled();
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
      'Sec-WebSocket-Key': btoa('the sample nonce'),
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

  it('refuses a socket to a node whose lease was released, with a live-lease owner control', async () => {
    await seedUser('rt-ws-rel');
    const live = await seedReverseNode('E', 'rt-ws-rel');
    const released = await seedReverseNode('F', 'rt-ws-rel');
    await env.DATABASE.prepare(
      "UPDATE node_reverse_tunnel_leases SET status = 'released' WHERE node_id = ?"
    )
      .bind(released.nodeId)
      .run();
    const cookie = await seedSignedInUser('rt-ws-rel');
    const logs = (n: SeededNode) =>
      call(
        gatewayCall(`api.${env.BASE_DOMAIN}`, `/api/nodes/${n.nodeId}/logs/stream`, {
          Cookie: cookie,
        })
      );
    const refused = await logs(released);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('X-SAM-Upstream')).toBeNull();
    expect((await logs(live)).headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${live.port}`);

    const workspaceId = await seedWorkspaceOn(released, 'rt-ws-rel', 'RE1');
    const socket = await call(
      gatewayCall(`ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`, '/agent/ws', {
        Cookie: cookie,
      })
    );
    expect(socket.status).toBe(503);
    expect(socket.headers.get('X-SAM-Upstream')).toBeNull();
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

  it('refuses a socket host that URL parsing would rewrite, with a same-workspace owner control', async () => {
    await seedUser('rt-ws-host');
    const node = await seedReverseNode('H', 'rt-ws-host');
    const workspaceId = await seedWorkspaceOn(node, 'rt-ws-host', 'HH1');
    await env.DATABASE.prepare('UPDATE workspaces SET ports_public_enabled = 1 WHERE id = ?')
      .bind(workspaceId)
      .run();
    const clean = `ws-${workspaceId.toLowerCase()}--3000.${env.BASE_DOMAIN}`;
    const owner = await call(gatewayCall(clean, '/'));
    expect(owner.status).toBe(200);
    expect(owner.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${node.port}`);
    // The URL parser strips the tab, so the parsed hostname is exactly `clean`; only the
    // hostname-equality guard tells the two apart.
    const rewritten = clean.replace('--3000.', '--3000\t.');
    expect(new URL(`https://${rewritten}/`).hostname).toBe(clean);
    const refused = await call(gatewayCall(rewritten, '/'));
    expect(refused.status).toBe(403);
    expect(refused.headers.get('X-SAM-Upstream')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
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

const sessionTokenOf = (cookie: string) => cookie.split('=')[1]!.split('.')[0]!;

describe('ws-* proxy after the move out of index.ts (other transports unchanged)', () => {
  it.each([
    ['vm-public-dns', 'vm-public-dns'],
    ['cloudflare-tunnel', 'cloudflare-tunnel'],
    ['legacy NULL transport', null],
  ] as const)('proxies a %s workspace to its public backend hostname', async (_name, transport) => {
    const userId = `rt-pub-${transport ?? 'null'}`;
    await seedUser(userId);
    const nodeId = `RTPUB${(transport ?? 'NULL').replaceAll('-', '').toUpperCase()}`.slice(0, 20);
    await seedNode(nodeId, userId, { status: 'running' });
    await env.DATABASE.prepare('UPDATE nodes SET transport = ? WHERE id = ?')
      .bind(transport, nodeId)
      .run();
    const workspaceId = {
      'vm-public-dns': '01KRRTPBVMPD00000000000000',
      'cloudflare-tunnel': '01KRRTPBCFTN00000000000000',
      none: '01KRRTPBNXNE00000000000000',
    }[transport ?? 'none'];
    await seedWorkspace(workspaceId, nodeId, userId, { status: 'running' });
    upstream.mockImplementation(async () => new Response('node says hi'));
    const response = await call(
      new Request(
        `https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}/workspaces/x/files/list?p=1`,
        {
          headers: {
            Cookie: await seedSignedInUser(userId),
            'X-SAM-Node-Id': 'spoofed',
            'X-SAM-Gateway-Secret': SECRET,
          },
        }
      )
    );
    expect(await response.text()).toBe('node says hi');
    expect(upstream).toHaveBeenCalledTimes(1);
    const [target, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(
      `https://${nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:8443/workspaces/x/files/list?p=1`
    );
    const sent = new Headers(init.headers);
    expect(sent.get('x-sam-node-id')).toBe(nodeId);
    expect(sent.get('x-sam-workspace-id')).toBe(workspaceId);
    expect(sent.get('x-forwarded-host')).toBe(`ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`);
    expect(sent.get('x-sam-gateway-secret')).toBeNull();
  });

  it('serves a reverse-tunnel node on its lease, never on a public hostname', async () => {
    await seedUser('rt-serve');
    const node = await seedReverseNode('D', 'rt-serve');
    const workspaceId = await seedWorkspaceOn(node, 'rt-serve', 'RD1');
    upstream.mockImplementation(async () => new Response('from the lease port'));
    const response = await call(
      new Request(`https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}/x?y=1`, {
        headers: { Cookie: await seedSignedInUser('rt-serve') },
      })
    );
    expect(await response.text()).toBe('from the lease port');
    expect(upstream).toHaveBeenCalledTimes(1);
    const [target, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(`http://127.0.0.1:${node.port}/x?y=1`);
    expect(init.redirect).toBe('manual');
  });

  it('answers 503 for a reverse-tunnel node whose lease is gone, without any fetch', async () => {
    await seedUser('rt-gone');
    const node = await seedReverseNode('Q', 'rt-gone');
    const workspaceId = await seedWorkspaceOn(node, 'rt-gone', 'GN1');
    await env.DATABASE.prepare(
      "UPDATE node_reverse_tunnel_leases SET status = 'released' WHERE node_id = ?"
    )
      .bind(node.nodeId)
      .run();
    const response = await call(
      new Request(`https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}/x`, {
        headers: { Cookie: await seedSignedInUser('rt-gone') },
      })
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'NODE_UNREACHABLE' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('control: an Instant (cf-container) workspace keeps its container path and the gateway refuses it', async () => {
    await seedUser('rt-cfc');
    await seedNode('RTCFCNODE', 'rt-cfc', { status: 'running' });
    await env.DATABASE.prepare("UPDATE nodes SET runtime = 'cf-container' WHERE id = ?")
      .bind('RTCFCNODE')
      .run();
    const workspaceId = '01KRRTCFC00000000000000000';
    await seedWorkspace(workspaceId, 'RTCFCNODE', 'rt-cfc', { status: 'running' });
    const cookie = await seedSignedInUser('rt-cfc');
    const http = await call(
      new Request(`https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}/x`, {
        headers: { Cookie: cookie },
      }),
      { ...testEnv(), CF_CONTAINER_ENABLED: 'false' } as Env
    );
    expect(http.status).toBe(503);
    expect(await http.json()).toMatchObject({ error: 'CF_CONTAINER_DISABLED' });
    const gateway = await call(
      gatewayCall(`ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}`, '/agent/ws', {
        Cookie: cookie,
      })
    );
    expect(gateway.status).toBe(502);
    expect(await gateway.json()).toMatchObject({ error: 'GATEWAY_UNSUPPORTED_TRANSPORT' });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('gateway attack cases', () => {
  it('refuses the node log stream to another user and to no session, with an owner control', async () => {
    await seedUser('rt-la-owner');
    await seedUser('rt-la-other');
    const node = await seedReverseNode('W', 'rt-la-owner');
    const path = `/api/nodes/${node.nodeId}/logs/stream`;
    const owner = await call(
      gatewayCall(`api.${env.BASE_DOMAIN}`, path, { Cookie: await seedSignedInUser('rt-la-owner') })
    );
    expect(owner.status).toBe(200);
    expect(owner.headers.get('X-SAM-Upstream-Authorization')).toMatch(/^Bearer ey/);
    for (const headers of [{ Cookie: await seedSignedInUser('rt-la-other') }, {}]) {
      const refused = await call(gatewayCall(`api.${env.BASE_DOMAIN}`, path, headers));
      expect([401, 403, 404]).toContain(refused.status);
      expect(refused.headers.get('X-SAM-Upstream')).toBeNull();
      expect(refused.headers.get('X-SAM-Upstream-Authorization')).toBeNull();
      expect(refused.headers.get('Authorization')).toBeNull();
    }
  });

  it('refuses the log stream of a node that is not on the reverse tunnel', async () => {
    await seedUser('rt-la-dns');
    await seedNode('RTLADNSNODE', 'rt-la-dns', { status: 'running' });
    const response = await call(
      gatewayCall(`api.${env.BASE_DOMAIN}`, '/api/nodes/RTLADNSNODE/logs/stream', {
        Cookie: await seedSignedInUser('rt-la-dns'),
      })
    );
    expect(response.status).toBe(502);
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it('authorizes a terminal socket with a terminal token for its workspace only', async () => {
    await seedUser('rt-tt');
    const node = await seedReverseNode('T', 'rt-tt');
    const a = await seedWorkspaceOn(node, 'rt-tt', 'TA1');
    const b = await seedWorkspaceOn(node, 'rt-tt', 'TB1');
    const sessionToken = sessionTokenOf(await seedSignedInUser('rt-tt'));
    const { token } = await signTerminalToken('rt-tt', a, testEnv(), { sessionToken });
    const ok = await call(
      gatewayCall(`ws-${a.toLowerCase()}.${env.BASE_DOMAIN}`, `/terminal/ws?token=${token}`)
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-SAM-Upstream-Uri')).toBe(`/terminal/ws?token=${token}`);
    expect(ok.headers.get('X-SAM-Upstream-Cookie')).toBe('');
    const otherWorkspace = await call(
      gatewayCall(`ws-${b.toLowerCase()}.${env.BASE_DOMAIN}`, `/terminal/ws?token=${token}`)
    );
    expect(otherWorkspace.status).toBe(401);
    expect(otherWorkspace.headers.get('X-SAM-Upstream')).toBeNull();
    const portProxy = await signTerminalToken('port-proxy', a, testEnv(), { sessionToken });
    const asPortProxy = await call(
      gatewayCall(
        `ws-${a.toLowerCase()}.${env.BASE_DOMAIN}`,
        `/terminal/ws?token=${portProxy.token}`
      )
    );
    expect(asPortProxy.status).toBe(401);
  });
});

describe('lease port range membership at the point the upstream is produced', () => {
  // Ports a lease must never name: celld's public + unauthenticated operator listeners, frps,
  // the bundled object store, plus a port just past the configured range.
  const outOfRange = [8080, 7001, 7000, 9000, 30000];

  async function nodeWithLeasePort(label: string, userId: string, port: number) {
    const node = await seedReverseNode(label, userId);
    await env.DATABASE.prepare(
      "UPDATE node_reverse_tunnel_leases SET port = ? WHERE node_id = ? AND status = 'active'"
    )
      .bind(port, node.nodeId)
      .run();
    return node;
  }

  it.each(outOfRange)(
    'never hands Caddy an upstream outside the range (lease port %i), with an in-range control',
    async (port) => {
      const userId = `rt-range-gw-${port}`;
      await seedUser(userId);
      const node = await nodeWithLeasePort(`G${port}`, userId, port);
      const cookie = await seedSignedInUser(userId);
      const path = `/api/nodes/${node.nodeId}/logs/stream`;
      const refused = await call(gatewayCall(`api.${env.BASE_DOMAIN}`, path, { Cookie: cookie }));
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(refused.headers.get('X-SAM-Upstream')).toBeNull();
      expect(refused.headers.get('X-SAM-Upstream-Authorization')).toBeNull();
      // Control: the same node on an in-range port is authorized.
      await env.DATABASE.prepare(
        "UPDATE node_reverse_tunnel_leases SET port = ? WHERE node_id = ? AND status = 'active'"
      )
        .bind(node.port, node.nodeId)
        .run();
      const allowed = await call(gatewayCall(`api.${env.BASE_DOMAIN}`, path, { Cookie: cookie }));
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${node.port}`);
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  it.each(outOfRange)(
    'never fetches an out-of-range lease port from the ws-* proxy (lease port %i)',
    async (port) => {
      const userId = `rt-range-ws-${port}`;
      await seedUser(userId);
      const node = await nodeWithLeasePort(`W${port}`, userId, port);
      const workspaceId = await seedWorkspaceOn(node, userId, `R${port}`);
      const response = await call(
        new Request(`https://ws-${workspaceId.toLowerCase()}.${env.BASE_DOMAIN}/x`, {
          headers: { Cookie: await seedSignedInUser(userId) },
        })
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(upstream).not.toHaveBeenCalled();
    }
  );
});

describe('control-plane node requests (system-info) on the reverse tunnel', () => {
  it('reach the lease port, and answer a designed 503 once the lease is released, never fetching', async () => {
    await seedUser('rt-sysinfo');
    const node = await seedReverseNode('Y', 'rt-sysinfo');
    const cookie = await seedSignedInUser('rt-sysinfo');
    const sysInfo = () =>
      call(
        new Request(`${API}/api/nodes/${node.nodeId}/system-info`, { headers: { Cookie: cookie } })
      );
    upstream.mockImplementation(async () => Response.json({ cpu: { count: 2 } }));
    const live = await sysInfo();
    expect(live.status).toBe(200);
    expect(String(upstream.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:${node.port}/system-info`);

    upstream.mockClear();
    await env.DATABASE.prepare(
      "UPDATE node_reverse_tunnel_leases SET status = 'released' WHERE node_id = ?"
    )
      .bind(node.nodeId)
      .run();
    const released = await sysInfo();
    expect(released.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});
