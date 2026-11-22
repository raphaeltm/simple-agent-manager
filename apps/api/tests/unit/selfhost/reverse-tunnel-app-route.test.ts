/**
 * Route authorization for deployment app ingress on the box, through the real entry point Caddy
 * calls (GET /api/self-host/gateway/app-route, gateway secret header) on a real SQL engine. The
 * schema comes from the drizzle definitions, the lease table from its shipped migration, and the
 * leases from the real lease writer. Only the token signer is replaced (it needs an RSA key), with
 * one that names the node it signs for, so the binding is visible.
 *
 * Attack cases sit beside an owner control and each guard was deleted once to see its attack go
 * red (recorded in the PR).
 */
import { buildDeploymentRouteTargets } from '@simple-agent-manager/app-deployment';
import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';

vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: vi.fn(async (userId: string, nodeId: string) => ({
    token: `mgmt:${userId}:${nodeId}`,
    expiresAt: '2026-12-01T00:00:00.000Z',
  })),
}));

const { createSelfHostGatewayRoutes } =
  await import('../../../src/selfhost/reverse-tunnel/gateway');
const { installReverseTunnelTransport } =
  await import('../../../src/selfhost/reverse-tunnel/transport');
const { ensureReverseTunnelLease, releaseUnallocatedReverseTunnelLease } =
  await import('../../../src/selfhost/reverse-tunnel/leases');
const { applySqliteMigration, createSchemaTables, createSqliteD1 } =
  await import('../../helpers/sqlite-d1');

const BASE = 'box.example.test';
const SECRET = ['app', 'route', 'gateway', 'fixture', 'secret', 'value', 'long', 'enough'].join(
  '-'
);
const ENV_A = '01M81ENVAAAAAAAAAAAAAAAAAA';
const ENV_B = '01M81ENVBBBBBBBBBBBBBBBBBB';
// Hostnames from the producer the release fetch uses, so a scheme change cannot leave this behind.
const routeHost = (environmentId: string) =>
  buildDeploymentRouteTargets(JSON.parse(manifest(3000)), { environmentId, baseDomain: BASE })[0]!
    .hostname;

let sqlite: Database.Database;
let HOST_A: string;
let HOST_B: string;
let env: Env;
const ports: Record<string, number> = {};

function manifest(port: number) {
  return JSON.stringify({
    version: 1,
    services: {
      web: {
        image: {
          registry: 'docker.io',
          repository: 'example/web',
          digest: `sha256:${'a'.repeat(64)}`,
        },
        env: {},
        volumes: [],
      },
    },
    volumes: {},
    routes: [{ service: 'web', port, mode: 'public' }],
  });
}

function run(sql: string, ...args: unknown[]) {
  sqlite.prepare(sql).run(...args);
}

async function seedTenant(tag: 'A' | 'B', envId: string) {
  const user = `user-${tag}`;
  const node = `NODE${tag}`;
  const incarnation = `inc-${tag}`;
  run(`INSERT INTO projects (id, user_id) VALUES (?, ?)`, `proj-${tag}`, user);
  run(
    `INSERT INTO nodes (id, user_id, status, runtime, node_class, node_role, transport, runtime_incarnation_id)
     VALUES (?, ?, 'running', 'vm', 'managed', 'deployment', 'reverse-tunnel', ?)`,
    node,
    user,
    incarnation
  );
  run(
    `INSERT INTO deployment_environments (id, project_id, node_id, status) VALUES (?, ?, ?, 'active')`,
    envId,
    `proj-${tag}`,
    node
  );
  run(
    `INSERT INTO deployment_releases (id, environment_id, version, manifest) VALUES (?, ?, 1, ?)`,
    `rel-${tag}`,
    envId,
    manifest(3000)
  );
  const lease = await ensureReverseTunnelLease(env as never, {
    nodeId: node,
    userId: user,
    runtimeIncarnationId: incarnation,
  });
  ports[node] = lease.port;
}

async function decide(host: string, uri = '/index.html?x=1', secret = SECRET) {
  const gateway = createSelfHostGatewayRoutes(() => new Response(null, { status: 500 }));
  return gateway.request(
    '/api/self-host/gateway/app-route',
    {
      headers: {
        'X-SAM-Gateway-Secret': secret,
        'X-SAM-Gateway-Original-Host': host,
        'X-Forwarded-Uri': uri,
      },
    },
    env
  );
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.projects,
    schema.nodes,
    schema.deploymentEnvironments,
    schema.deploymentReleases,
  ]);
  applySqliteMigration(
    sqlite,
    new URL('../../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql', import.meta.url)
  );
  installReverseTunnelTransport(generateCloudInit);
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: BASE,
    VM_AGENT_TRANSPORT: 'reverse-tunnel',
    REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
    ENCRYPTION_KEY: 'test-encryption-key-for-app-route-leases',
  } as unknown as Env;
  HOST_A = routeHost(ENV_A);
  HOST_B = routeHost(ENV_B);
  await seedTenant('A', ENV_A);
  await seedTenant('B', ENV_B);
});

describe('app-route decision', () => {
  it('owner: names the bound node lease, the vm-agent URI and a token for that node', async () => {
    const response = await decide(HOST_A);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${ports.NODEA}`);
    expect(response.headers.get('X-SAM-Upstream-Uri')).toBe(
      `/deployment/app-ingress/${HOST_A}/index.html?x=1`
    );
    expect(response.headers.get('X-SAM-Node-Id')).toBe('NODEA');
    expect(response.headers.get('X-SAM-Upstream-Node-Authorization')).toBe(
      'Bearer mgmt:user-A:NODEA'
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it("foreign project: another project's hostname goes to its own node, never this one", async () => {
    const response = await decide(HOST_B);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SAM-Upstream')).toBe(`127.0.0.1:${ports.NODEB}`);
    expect(response.headers.get('X-SAM-Node-Id')).toBe('NODEB');
    expect(ports.NODEA).not.toBe(ports.NODEB);
  });

  it('a hostname naming the environment but not a route of its latest release is refused', async () => {
    // Same environment id, another service/port: a guessable name, not an applied route.
    const response = await decide(HOST_A.replace('-web-3000-', '-db-5432-'));
    expect(response.status).toBe(404);
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it("foreign node: an environment bound to another owner's node is refused", async () => {
    run(`UPDATE deployment_environments SET node_id = 'NODEB' WHERE id = ?`, ENV_A);
    const response = await decide(HOST_A);
    expect(response.status).toBe(404);
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it.each([
    ['a workspace node', `UPDATE nodes SET node_role = 'workspace' WHERE id = 'NODEA'`],
    ['a public-transport node', `UPDATE nodes SET transport = 'vm-public-dns' WHERE id = 'NODEA'`],
    ['a node being destroyed', `UPDATE nodes SET status = 'destroying' WHERE id = 'NODEA'`],
    [
      'a stopped environment',
      `UPDATE deployment_environments SET status = 'stopped' WHERE id = '${ENV_A}'`,
    ],
    [
      'an unbound environment',
      `UPDATE deployment_environments SET node_id = NULL WHERE id = '${ENV_A}'`,
    ],
  ])('refuses %s', async (_name, sql) => {
    run(sql);
    expect((await decide(HOST_A)).status).toBe(404);
    // Control: the other tenant is unaffected.
    expect((await decide(HOST_B)).status).toBe(200);
  });

  it('a released lease (the node incarnation is gone) answers 503, not an upstream', async () => {
    await releaseUnallocatedReverseTunnelLease(env as never, 'NODEA', 'inc-A', 'test');
    const response = await decide(HOST_A);
    expect(response.status).toBe(503);
    expect(response.headers.get('X-SAM-Upstream')).toBeNull();
  });

  it.each([
    ['not under apps', () => `web.${BASE}`],
    ['the apps name itself', () => `apps.${BASE}`],
    ['two labels under apps', () => `x.${HOST_A}`],
    ['another domain', () => HOST_A.replace(BASE, 'evil.example')],
    ['userinfo smuggling', () => `${HOST_A}@evil.example`],
  ])('refuses a host that is %s', async (_name, host) => {
    expect((await decide(host())).status).toBe(404);
  });

  it('refuses a request without the gateway secret', async () => {
    expect((await decide(HOST_A, '/', 'wrong-secret-value-of-sufficient-length-xx')).status).toBe(
      401
    );
  });
});
