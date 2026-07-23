import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  sql: (strings: TemplateStringsArray) => ({ sql: strings.join('') }),
}));

vi.mock('../../../src/db/schema', () => ({
  nodes: { id: 'nodes.id', ipAddress: 'nodes.ipAddress', nodeClass: 'nodes.nodeClass' },
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
        where: vi.fn().mockImplementation(() => ({
          // origin-ca gate: db.select({nodeClass, transport}).from(nodes).where().get()
          get: vi.fn().mockResolvedValue(
            selection
              ? {
                  nodeClass: (state.node as NodeRow)?.nodeClass,
                  transport: (state.node as NodeRow)?.transport,
                }
              : state.node
          ),
          // heartbeat: db.select().from(nodes).where().limit(1)
          limit: vi.fn().mockResolvedValue([state.node]),
        })),
      })),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(() => {
          state.updates.push(values);
          return Promise.resolve();
        }),
      })),
    })),
  };
}

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => createMockDb() }));

vi.mock('../../../src/services/jwt', () => ({
  shouldRefreshCallbackToken: vi.fn(() => state.refreshNeeded),
  signCallbackToken: vi.fn(),
  signNodeCallbackToken: vi.fn().mockResolvedValue('REFRESHED-TOKEN'),
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

async function appRequest(path: string, body: unknown, isText = false): Promise<Response> {
  const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
  const app = new Hono();
  app.route('/api/nodes', nodeLifecycleRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  return app.request(
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

    it('still issues a cert for a managed public-DNS node', async () => {
      state.node = makeNode({ nodeClass: 'managed', transport: 'vm-public-dns' });
      const res = await appRequest('/api/nodes/node-1/origin-ca-certificate', VALID_CSR, true);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('MANAGED-CERT');
    });
  });

  describe('Revocation-on-refresh (critique #4)', () => {
    it('withholds a refreshed token for a deregistered (deleted) node', async () => {
      state.node = makeNode({ status: 'deleted' });
      const res = await appRequest('/api/nodes/node-1/heartbeat', { nodeId: 'node-1' });
      expect(res.status).toBe(200);
      expect((await res.json()).refreshedToken).toBeUndefined();
    });

    it('still refreshes a live node token', async () => {
      state.node = makeNode({ status: 'running' });
      const res = await appRequest('/api/nodes/node-1/heartbeat', { nodeId: 'node-1' });
      expect(res.status).toBe(200);
      expect((await res.json()).refreshedToken).toBe('REFRESHED-TOKEN');
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

    it('DOES backfill IP + A record for a managed node without a tunnel', async () => {
      state.node = makeNode({ tunnelId: null, ipAddress: null });
      // CF-Connecting-IP drives the backfill on a non-tunnel node.
      const { nodeLifecycleRoutes } = await import('../../../src/routes/node-lifecycle');
      const app = new Hono();
      app.route('/api/nodes', nodeLifecycleRoutes);
      const res = await app.request(
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
  });
});
