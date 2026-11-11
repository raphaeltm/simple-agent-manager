import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

/**
 * BYO / user-owned node behaviors on node-lifecycle callback routes (Phase 0, PR 0B):
 *  - Origin CA wildcard issuance is DENIED server-side for user-owned / tunnel nodes (critique #2).
 *  - Callback-token refresh is withheld for deregistered (deleted) nodes (critique #4).
 *  - Heartbeat A-record / IP backfill is skipped when the node has a tunnel (critique #8).
 */

type NodeRow = {
  id: string;
  status: string;
  healthStatus: string;
  nodeRole: string;
  nodeClass: string;
  transport: string | null;
  tunnelId: string | null;
  ipAddress: string | null;
  providerInstanceId: string | null;
  errorMessage: string | null;
  backendDnsRecordId: string | null;
};

const state = vi.hoisted(() => ({
  node: null as unknown,
  updates: [] as Array<Record<string, unknown>>,
  refreshNeeded: true,
  issuedCert: 'MANAGED-CERT',
  dns: { create: null as unknown, update: null as unknown },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  desc: (col: unknown) => col,
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  notInArray: (col: unknown, values: unknown[]) => ({ op: 'notInArray', col, values }),
  sql: (strings: TemplateStringsArray) => ({ sql: strings.join('') }),
}));

vi.mock('../../../src/db/schema', () => ({
  nodes: {
    id: 'nodes.id',
    ipAddress: 'nodes.ipAddress',
    nodeClass: 'nodes.nodeClass',
    status: 'nodes.status',
  },
  workspaces: {
    id: 'workspaces.id',
    projectId: 'workspaces.projectId',
    nodeId: 'workspaces.nodeId',
    status: 'workspaces.status',
  },
  deploymentEnvironments: { id: 'de.id', nodeId: 'de.nodeId' },
}));

function createMockDb() {
  return {
    select: vi.fn().mockImplementation((selection?: Record<string, unknown>) => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          if (selection && 'userId' in selection) {
            return Promise.resolve([]);
          }
          return {
            // origin-ca gate: db.select({nodeClass, transport}).from(nodes).where().get()
            get: vi.fn().mockResolvedValue(
              selection
                ? {
                    nodeClass: (state.node as NodeRow)?.nodeClass,
                    status: (state.node as NodeRow)?.status,
                    transport: (state.node as NodeRow)?.transport,
                  }
                : state.node
            ),
            // heartbeat: db.select().from(nodes).where().limit(1)
            limit: vi.fn().mockResolvedValue([state.node]),
          };
        }),
      })),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(() => {
          state.updates.push(values);
          return {
            returning: vi.fn().mockResolvedValue([{ status: 'running' }]),
          };
        }),
      })),
    })),
  };
}

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => createMockDb() }));

vi.mock('../../../src/services/jwt', () => ({
  shouldRefreshCallbackToken: vi.fn(() => state.refreshNeeded),
  signCallbackToken: vi.fn(),
  signCurrentWorkspaceCallbackToken: vi.fn(),
  signNodeCallbackToken: vi.fn().mockResolvedValue('REFRESHED-TOKEN'),
  signCurrentNodeCallbackToken: vi.fn().mockResolvedValue('REFRESHED-TOKEN'),
  signNodeManagementToken: vi.fn(),
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'node-1', scope: 'node', type: 'callback' }),
}));

vi.mock('../../../src/services/origin-ca-certificates', () => ({
  issueNodeOriginCertificate: vi.fn().mockImplementation(async () => ({
    certificate: state.issuedCert,
    hostnames: ['*.example.com'],
    requestedValidity: 7,
  })),
}));

vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn().mockImplementation(async () => {
    state.dns.create = true;
    return 'dns-record-id';
  }),
  updateDNSRecord: vi.fn().mockImplementation(async () => {
    state.dns.update = true;
  }),
}));

vi.mock('../../../src/services/project-data', () => ({
  updateNodeHeartbeats: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../../src/lib/logger', () => ({
  createModuleLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../src/middleware/auth', () => ({ getUserId: vi.fn().mockReturnValue('user-1') }));

function makeNode(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: 'node-1',
    status: 'running',
    healthStatus: 'healthy',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    transport: null,
    tunnelId: null,
    ipAddress: null,
    providerInstanceId: 'srv-1',
    errorMessage: null,
    backendDnsRecordId: null,
    ...overrides,
  };
}

let nodeLifecycleApp: Hono | null = null;

beforeAll(async () => {
  const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
  const app = new Hono();
  app.route('/api/nodes', nodeLifecycleRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 410 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  nodeLifecycleApp = app;
}, 15000);

function getNodeLifecycleApp(): Hono {
  if (!nodeLifecycleApp) {
    throw new Error('node lifecycle app was not initialized');
  }
  return nodeLifecycleApp;
}

async function appRequest(path: string, body: unknown, isText = false): Promise<Response> {
  return getNodeLifecycleApp().request(
    path,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer node-token',
        'Content-Type': isText ? 'text/plain' : 'application/json',
      },
      body: isText ? (body as string) : JSON.stringify(body),
    },
    { DATABASE: {}, CF_API_TOKEN: 'cf', BASE_DOMAIN: 'example.com' },
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  );
}

const VALID_CSR =
  '-----BEGIN CERTIFICATE REQUEST-----\nMIIBmock\n-----END CERTIFICATE REQUEST-----';

describe('node-lifecycle BYO gates', () => {
  beforeEach(() => {
    state.node = makeNode();
    state.updates = [];
    state.refreshNeeded = true;
    state.dns = { create: null, update: null };
  });

  describe('Origin CA issuance gate (critique #2)', () => {
    it('denies wildcard cert issuance for a user-owned node', async () => {
      state.node = makeNode({ nodeClass: 'user-owned', transport: 'cloudflare-tunnel' });
      const res = await appRequest('/api/nodes/node-1/origin-ca-certificate', VALID_CSR, true);
      expect(res.status).toBe(403);
    });

    it('denies issuance for a tunnel-transport node even if class is managed', async () => {
      state.node = makeNode({ nodeClass: 'managed', transport: 'cloudflare-tunnel' });
      const res = await appRequest('/api/nodes/node-1/origin-ca-certificate', VALID_CSR, true);
      expect(res.status).toBe(403);
    });

    it('denies issuance for a managed reverse-tunnel node (no tunnelId, transport only)', async () => {
      state.node = makeNode({ nodeClass: 'managed', transport: 'reverse-tunnel', tunnelId: null });
      const res = await appRequest('/api/nodes/node-1/origin-ca-certificate', VALID_CSR, true);
      expect(res.status).toBe(403);
    });

    it('still issues a cert for a managed public-DNS node', async () => {
      state.node = makeNode({ nodeClass: 'managed', transport: 'vm-public-dns' });
      const res = await appRequest('/api/nodes/node-1/origin-ca-certificate', VALID_CSR, true);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('MANAGED-CERT');
    });
  });

  describe('Revocation-on-refresh (critique #4)', () => {
    it('returns terminal gone for a deregistered (deleted) node before refresh or health mutation', async () => {
      state.node = makeNode({ status: 'deleted' });
      const res = await appRequest('/api/nodes/node-1/heartbeat', { nodeId: 'node-1' });
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ error: 'GONE' });
      expect(state.updates).toHaveLength(0);
    });

    it('still refreshes a live node token', async () => {
      state.node = makeNode({ status: 'running' });
      const res = await appRequest('/api/nodes/node-1/heartbeat', { nodeId: 'node-1' });
      expect(res.status).toBe(200);
      expect((await res.json()).refreshedToken).toBe('REFRESHED-TOKEN');
    });
  });

  describe('VM agent build identity persistence', () => {
    it('stores agentVersion reported by /ready', async () => {
      const res = await appRequest('/api/nodes/node-1/ready', { agentVersion: 'build-sha-1' });
      expect(res.status).toBe(200);
      expect(state.updates).toContainEqual(
        expect.objectContaining({ agentVersion: 'build-sha-1' })
      );
    });

    it('stores agentVersion reported by heartbeat', async () => {
      const res = await appRequest('/api/nodes/node-1/heartbeat', {
        nodeId: 'node-1',
        agentVersion: 'build-sha-2',
      });
      expect(res.status).toBe(200);
      expect(state.updates).toContainEqual(
        expect.objectContaining({ agentVersion: 'build-sha-2' })
      );
    });
  });

  describe('Heartbeat creatingWorkspaces rollout compatibility', () => {
    it('accepts old agents that omit creatingWorkspaces', async () => {
      const res = await appRequest('/api/nodes/node-1/heartbeat', { nodeId: 'node-1' });

      expect(res.status).toBe(200);
      expect(state.updates).toContainEqual(expect.objectContaining({ healthStatus: 'healthy' }));
    });

    it('stores creatingWorkspaces even when no metrics payload is present', async () => {
      const res = await appRequest('/api/nodes/node-1/heartbeat', {
        nodeId: 'node-1',
        creatingWorkspaces: 2,
      });

      expect(res.status).toBe(200);
      expect(state.updates).toContainEqual(
        expect.objectContaining({ lastMetrics: JSON.stringify({ creatingWorkspaces: 2 }) })
      );
    });
  });

  describe('Heartbeat A-record backfill skip for tunnel nodes (critique #8)', () => {
    it('does NOT create an A record or backfill IP for a tunnel node', async () => {
      state.node = makeNode({
        nodeClass: 'user-owned',
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: null,
      });
      const res = await appRequest('/api/nodes/node-1/heartbeat', { nodeId: 'node-1' });
      expect(res.status).toBe(200);
      expect(state.dns.create).toBeNull();
      // No ipAddress written into any node update payload.
      expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
    });

    function heartbeatFrom(ip: string) {
      return getNodeLifecycleApp().request(
        '/api/nodes/node-1/heartbeat',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer node-token',
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
          },
          body: JSON.stringify({ nodeId: 'node-1' }),
        },
        { DATABASE: {}, BASE_DOMAIN: 'example.com' },
        { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
      );
    }

    it('ignores the connecting IP of a workspace tunnel node even when one is sent', async () => {
      state.node = makeNode({
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: null,
      });
      const res = await heartbeatFrom('203.0.113.9');
      expect(res.status).toBe(200);
      expect(state.dns.create).toBeNull();
      expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
    });

    it('does NOT backfill the IP or create an A record for a managed reverse-tunnel node', async () => {
      // Reverse-tunnel nodes carry no tunnelId: the gate must read the row's transport, and
      // CF-Connecting-IP (the node's real egress IP through Caddy) must not be backfilled,
      // even when the node has no stored IP (the case that would otherwise backfill).
      state.node = makeNode({
        transport: 'reverse-tunnel',
        tunnelId: null,
        ipAddress: null,
      });
      const res = await heartbeatFrom('203.0.113.7');
      expect(res.status).toBe(200);
      expect(state.dns.create).toBeNull();
      expect(state.dns.update).toBeNull();
      expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
      // Liveness: the heartbeat itself was recorded.
      expect(state.updates).toContainEqual(expect.objectContaining({ healthStatus: 'healthy' }));
    });

    it('records the IPv4 of a deployment tunnel node with no IP, without any backend A record', async () => {
      state.node = makeNode({
        nodeRole: 'deployment',
        status: 'creating',
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: null,
        errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
      });
      const res = await heartbeatFrom('203.0.113.8');
      expect(res.status).toBe(200);
      // App routes need the public IP (grey-cloud A records); the node hostname stays the CNAME.
      expect(state.updates).toContainEqual(
        expect.objectContaining({
          ipAddress: '203.0.113.8',
          status: 'running',
          // The "Awaiting IP allocation" error is cleared in the same write.
          errorMessage: expect.objectContaining({ sql: 'NULL' }),
        })
      );
      expect(state.dns.create).toBeNull();
      expect(state.dns.update).toBeNull();
    });

    it('records the IPv4 of an already-running deployment tunnel node that has none', async () => {
      state.node = makeNode({
        nodeRole: 'deployment',
        status: 'running',
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: null,
      });
      expect((await heartbeatFrom('203.0.113.6')).status).toBe(200);
      expect(state.updates).toContainEqual(expect.objectContaining({ ipAddress: '203.0.113.6' }));
      expect(state.dns.create).toBeNull();
    });

    it('never backfills a user-owned tunnel node even with the deployment role (server-side class gate)', async () => {
      state.node = makeNode({
        nodeRole: 'deployment',
        nodeClass: 'user-owned',
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: null,
      });
      expect((await heartbeatFrom('203.0.113.5')).status).toBe(200);
      expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
    });

    it('never backfills a deployment tunnel node from a non-IPv4 address or over a stored IP', async () => {
      state.node = makeNode({
        nodeRole: 'deployment',
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: null,
      });
      expect((await heartbeatFrom('2001:db8::8')).status).toBe(200);
      expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
      state.node = makeNode({
        nodeRole: 'deployment',
        transport: 'cloudflare-tunnel',
        tunnelId: 'tunnel-uuid',
        ipAddress: '198.51.100.4',
      });
      expect((await heartbeatFrom('203.0.113.8')).status).toBe(200);
      expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
      expect(state.dns.create).toBeNull();
    });

    it('DOES backfill IP + A record for a managed node without a tunnel', async () => {
      state.node = makeNode({ tunnelId: null, ipAddress: null });
      // CF-Connecting-IP drives the backfill on a non-tunnel node.
      const res = await getNodeLifecycleApp().request(
        '/api/nodes/node-1/heartbeat',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer node-token',
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.7',
          },
          body: JSON.stringify({ nodeId: 'node-1' }),
        },
        { DATABASE: {}, BASE_DOMAIN: 'example.com' },
        { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
      );
      expect(res.status).toBe(200);
      expect(state.updates.some((u) => u.ipAddress === '203.0.113.7')).toBe(true);
    });

    it.each(['not-an-ip', '203.0.113.7:443', ''])(
      'does NOT backfill a node IP from a malformed CF-Connecting-IP (%j), with X-Forwarded-For set',
      async (header) => {
        state.node = makeNode({ tunnelId: null, ipAddress: null });
        const res = await getNodeLifecycleApp().request(
          '/api/nodes/node-1/heartbeat',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer node-token',
              'Content-Type': 'application/json',
              'CF-Connecting-IP': header,
              'X-Forwarded-For': '203.0.113.9',
            },
            body: JSON.stringify({ nodeId: 'node-1' }),
          },
          { DATABASE: {}, BASE_DOMAIN: 'example.com' },
          { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
        );
        // Liveness: the heartbeat itself was accepted and recorded.
        expect(res.status).toBe(200);
        expect(state.updates).toContainEqual(expect.objectContaining({ healthStatus: 'healthy' }));
        expect(state.updates.some((u) => 'ipAddress' in u)).toBe(false);
      }
    );

    // Existing-deployment invariant: the reverse-tunnel case was ADDED to the gate, it did not
    // widen it to every tunnel transport. A cloudflare-tunnel node whose tunnel_id is still NULL
    // (tunnel not yet journaled) kept backfilling before the reverse-tunnel work and still must.
    it.each([
      ['cloudflare-tunnel', 'cloudflare-tunnel'],
      ['vm-public-dns', 'vm-public-dns'],
      ['legacy NULL transport', null],
    ] as const)(
      'still backfills a %s node whose tunnel_id is NULL (pre-reverse-tunnel predicate)',
      async (_name, transport) => {
        state.node = makeNode({ transport, tunnelId: null, ipAddress: null });
        const res = await getNodeLifecycleApp().request(
          '/api/nodes/node-1/heartbeat',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer node-token',
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '203.0.113.8',
            },
            body: JSON.stringify({ nodeId: 'node-1' }),
          },
          { DATABASE: {}, BASE_DOMAIN: 'example.com' },
          { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
        );
        expect(res.status).toBe(200);
        expect(state.updates.some((u) => u.ipAddress === '203.0.113.8')).toBe(true);
      }
    );
  });
});
