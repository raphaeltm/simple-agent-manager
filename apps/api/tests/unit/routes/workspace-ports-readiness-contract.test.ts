import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { workspacesRoutes } from '../../../src/routes/workspaces';

const mocks = vi.hoisted(() => {
  class MockNodeAgentHttpError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly responseBody: string
    ) {
      super(`Node Agent request failed: ${statusCode} ${responseBody}`);
      this.name = 'NodeAgentHttpError';
    }
  }

  class MockNodeAgentFetchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NodeAgentFetchError';
    }
  }

  return {
    workspaceRows: [] as Array<{
      id: string;
      userId: string;
      nodeId: string | null;
      status: string;
    }>,
    getWorkspacePortsOnNode: vi.fn(),
    NodeAgentHttpError: MockNodeAgentHttpError,
    NodeAgentFetchError: MockNodeAgentFetchError,
  };
});

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'user-1',
  getAuth: () => ({
    user: {
      id: 'user-1',
      role: 'user',
      status: 'active',
      email: 'test@example.com',
      name: 'Test User',
      avatarUrl: null,
    },
    session: { id: 'session-1', expiresAt: new Date('2030-01-01T00:00:00.000Z') },
  }),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => Promise.resolve(mocks.workspaceRows)),
    };
    return {
      select: vi.fn(() => query),
    };
  }),
}));

vi.mock('../../../src/services/node-agent', () => ({
  getWorkspacePortsOnNode: mocks.getWorkspacePortsOnNode,
  NodeAgentHttpError: mocks.NodeAgentHttpError,
  NodeAgentFetchError: mocks.NodeAgentFetchError,
  waitForNodeAgentReady: vi.fn(),
}));

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/workspaces', workspacesRoutes);
  return app;
}

const app = createApp();

function workspaceRow(status: string, nodeId: string | null = 'node-1') {
  return {
    id: 'workspace-1',
    userId: 'user-1',
    nodeId,
    status,
  };
}

async function getPorts() {
  return app.request(
    '/api/workspaces/workspace-1/ports',
    {},
    { DATABASE: {}, BASE_DOMAIN: 'example.com' } as Env
  );
}

describe('workspace ports API readiness contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRows = [workspaceRow('running')];
    mocks.getWorkspacePortsOnNode.mockResolvedValue({
      ports: [{ port: 3000, protocol: 'http', url: 'https://example.com' }],
    });
  });

  it('returns gone instead of a thrown 404 when the owned workspace row is absent', async () => {
    mocks.workspaceRows = [];

    const response = await getPorts();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ports: [],
      state: 'gone',
      workspaceStatus: null,
      retryable: false,
    });
    expect(mocks.getWorkspacePortsOnNode).not.toHaveBeenCalled();
  });

  it.each([
    ['sleeping', 200, false],
    ['stopped', 200, false],
    ['deleted', 200, false],
    ['creating', 202, true],
    ['provisioning', 202, true],
  ])('maps workspace status %s to structured readiness state', async (status, expectedStatus, retryable) => {
    mocks.workspaceRows = [workspaceRow(status)];

    const response = await getPorts();

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      ports: [],
      state: ['creating', 'provisioning'].includes(status) ? 'not_ready' : status,
      workspaceStatus: status,
      retryable,
    });
    expect(mocks.getWorkspacePortsOnNode).not.toHaveBeenCalled();
  });

  it('preserves successful running workspace port responses', async () => {
    const response = await getPorts();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ports: [{ port: 3000 }],
    });
    expect(mocks.getWorkspacePortsOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      expect.any(Object),
      'user-1'
    );
  });

  it('downgrades expected upstream 503s to retryable not_ready instead of erroring', async () => {
    mocks.getWorkspacePortsOnNode.mockRejectedValue(
      new mocks.NodeAgentHttpError(503, 'runtime not ready')
    );

    const response = await getPorts();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ports: [],
      state: 'not_ready',
      workspaceStatus: 'running',
      retryable: true,
      diagnostics: { upstreamStatus: 503 },
    });
  });

  it('downgrades transport fetch failures to retryable not_ready', async () => {
    mocks.getWorkspacePortsOnNode.mockRejectedValue(
      new mocks.NodeAgentFetchError('Request timed out after 30000ms')
    );

    const response = await getPorts();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ports: [],
      state: 'not_ready',
      workspaceStatus: 'running',
      retryable: true,
      diagnostics: { reason: 'fetch_exception' },
    });
  });

  it('does not hide unexpected node-agent failures as readiness', async () => {
    mocks.getWorkspacePortsOnNode.mockRejectedValue(
      new mocks.NodeAgentHttpError(500, 'boom')
    );

    const response = await getPorts();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'INTERNAL_ERROR',
    });
  });
});
