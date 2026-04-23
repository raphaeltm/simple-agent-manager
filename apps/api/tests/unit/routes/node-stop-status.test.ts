/**
 * Behavioral test for the node stop endpoint response.
 *
 * Verifies that POST /:id/stop returns { status: 'stopped' } (not 'deleted').
 * This was a bug where the stop endpoint incorrectly returned 'deleted' status
 * despite only stopping the node.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm/d1');

const mocks = {
  requireNodeOwnership: vi.fn(),
  stopNodeResources: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
  getUserId: vi.fn(() => 'user-123'),
};

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => mocks.getUserId(),
}));

vi.mock('../../../src/middleware/node-auth', () => ({
  requireNodeOwnership: (...args: any[]) => mocks.requireNodeOwnership(...args),
}));

vi.mock('../../../src/services/nodes', () => ({
  stopNodeResources: (...args: any[]) => mocks.stopNodeResources(...args),
  createNodeRecord: vi.fn(),
  deleteNodeResources: vi.fn(),
  provisionNode: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: (...args: any[]) => mocks.stopWorkspaceOnNode(...args),
  getNodeLogsFromNode: vi.fn(),
  getNodeSystemInfoFromNode: vi.fn(),
  listNodeEventsOnNode: vi.fn(),
  nodeAgentRawRequest: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: vi.fn(),
}));

vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn(() => ({
    maxNodes: 10,
    maxWorkspacesPerNode: 5,
    canCreateNode: true,
  })),
}));

vi.mock('../../../src/services/telemetry', () => ({
  recordNodeRoutingMetric: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import the route after mocks are set up
// ---------------------------------------------------------------------------

import { nodesRoutes } from '../../../src/routes/nodes';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number') {
      return c.json(
        { error: appError.error, message: appError.message },
        appError.statusCode as any,
      );
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  app.route('/api/nodes', nodesRoutes);
  return app;
}

function createMockEnv(): Env {
  return {
    DATABASE: {} as any,
    AUTH_KV: {} as any,
    NODE_LIFECYCLE: {} as any,
    ANALYTICS: {} as any,
  } as Env;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/nodes/:id/stop', () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    env = createMockEnv();

    // Default: node exists, running, healthy
    mocks.requireNodeOwnership.mockResolvedValue({
      id: 'node-1',
      status: 'running',
      healthStatus: 'healthy',
      userId: 'user-123',
    });
    mocks.stopNodeResources.mockResolvedValue(undefined);

    // Mock drizzle to return chainable query builders
    const mockUpdateChain: any = {};
    mockUpdateChain.set = vi.fn(() => mockUpdateChain);
    mockUpdateChain.where = vi.fn(() => Promise.resolve());

    const mockSelectChain: any = {};
    mockSelectChain.from = vi.fn(() => mockSelectChain);
    mockSelectChain.where = vi.fn(() => Promise.resolve([]));

    (drizzle as any).mockReturnValue({
      select: vi.fn(() => mockSelectChain),
      update: vi.fn(() => mockUpdateChain),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    });
  });

  it('returns { status: "stopped" } (not "deleted")', async () => {
    const response = await app.request('/api/nodes/node-1/stop', { method: 'POST' }, env);

    expect(response.status).toBe(200);
    const body = await response.json<{ status: string }>();
    expect(body.status).toBe('stopped');
  });

  it('does not return "deleted" status', async () => {
    const response = await app.request('/api/nodes/node-1/stop', { method: 'POST' }, env);

    const body = await response.json<{ status: string }>();
    expect(body.status).not.toBe('deleted');
  });

  it('calls stopNodeResources with correct arguments', async () => {
    await app.request('/api/nodes/node-1/stop', { method: 'POST' }, env);

    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-1', 'user-123', env);
  });
});
