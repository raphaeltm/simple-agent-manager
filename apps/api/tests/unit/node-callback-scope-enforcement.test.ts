/**
 * Node Callback Auth Scope Enforcement Tests
 *
 * Verifies that:
 * - Node endpoints reject workspace-scoped tokens
 * - Node endpoints accept node-scoped and legacy tokens
 */
import { Hono } from 'hono';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/middleware/error';
import type { CallbackTokenPayload } from '../../src/services/jwt';

// Mock better-auth
vi.mock('../../src/auth', () => ({
  createAuth: () => ({
    api: { getSession: vi.fn().mockResolvedValue(null) },
  }),
}));

// Mock drizzle
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 'node-test',
            status: 'running',
            healthStatus: 'healthy',
            lastHeartbeatAt: new Date().toISOString(),
            heartbeatStaleAfterSeconds: 180,
          }]),
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  }),
}));

// Mock JWT with controllable scope
const mockVerifyCallbackToken = vi.fn<(token: string, env: unknown) => Promise<CallbackTokenPayload>>();
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: [string, unknown]) => mockVerifyCallbackToken(...args),
  signCallbackToken: vi.fn().mockResolvedValue('mock-ws-token'),
  signNodeCallbackToken: vi.fn().mockResolvedValue('mock-node-token'),
  signNodeManagementToken: vi.fn().mockResolvedValue({ token: 'mgmt-token', expiresAt: '2030-01-01' }),
  shouldRefreshCallbackToken: vi.fn().mockReturnValue(false),
}));

// Mock other dependencies
vi.mock('../../src/services/nodes', () => ({
  createNodeRecord: vi.fn(),
  deleteNodeResources: vi.fn(),
  provisionNode: vi.fn(),
  stopNodeResources: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  createWorkspaceOnNode: vi.fn(),
  getNodeLogsFromNode: vi.fn(),
  getNodeSystemInfoFromNode: vi.fn(),
  listNodeEventsOnNode: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
}));

vi.mock('../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn(),
  updateDNSRecord: vi.fn(),
}));

vi.mock('../../src/services/telemetry', () => ({
  recordNodeRoutingMetric: vi.fn(),
}));

vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn(),
  persistErrorBatch: vi.fn(),
}));

vi.mock('../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn().mockReturnValue({ maxNodesPerUser: 10, nodeHeartbeatStaleSeconds: 180 }),
}));

vi.mock('../../src/services/project-data', () => ({
  updateNodeHeartbeats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/middleware/node-auth', () => ({
  requireNodeOwnership: vi.fn().mockResolvedValue({
    id: 'node-test',
    status: 'running',
    healthStatus: 'healthy',
    userId: 'user-1',
  }),
}));

async function createTestApp() {
  const { nodesRoutes } = await import('../../src/routes/nodes');
  const { nodeLifecycleRoutes } = await import('../../src/routes/node-lifecycle');
  const app = new Hono();
  app.route('/api/nodes', nodesRoutes);
  app.route('/api/nodes', nodeLifecycleRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  return app;
}

describe('node callback auth — scope enforcement', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestApp();
  });

  it('REJECTS workspace-scoped tokens on node heartbeat endpoint', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      scope: 'workspace',
    });

    const res = await app.request('/api/nodes/node-test/heartbeat', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer workspace-scoped-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe('Insufficient token scope');
  });

  it('ACCEPTS node-scoped tokens on node heartbeat endpoint', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-test',
      type: 'callback',
      scope: 'node',
    });

    const res = await app.request('/api/nodes/node-test/heartbeat', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer node-scoped-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    // Should not be 403 — the heartbeat may fail for other reasons (DB mocks) but auth passes
    expect(res.status).not.toBe(403);
  });

  it('ACCEPTS legacy tokens (no scope) on node heartbeat endpoint', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-test',
      type: 'callback',
      // No scope — legacy token
    });

    const res = await app.request('/api/nodes/node-test/heartbeat', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer legacy-node-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).not.toBe(401);
  });

  it('REJECTS workspace-scoped tokens on node ready endpoint', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      scope: 'workspace',
    });

    const res = await app.request('/api/nodes/node-test/ready', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer workspace-scoped-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe('Insufficient token scope');
  });

  it('REJECTS workspace-scoped tokens on node errors endpoint', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      scope: 'workspace',
    });

    const res = await app.request('/api/nodes/node-test/errors', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer workspace-scoped-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ errors: [] }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe('Insufficient token scope');
  });
});
