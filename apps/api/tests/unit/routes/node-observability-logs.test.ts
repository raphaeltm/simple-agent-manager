import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mockRequireNodeOwnership = vi.fn();
const mockGetNodeLogsFromNode = vi.fn();
const mockListNodeContainersFromNode = vi.fn();

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/node-auth', () => ({
  requireNodeOwnership: (...args: unknown[]) => mockRequireNodeOwnership(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
  listNodeContainersFromNode: (...args: unknown[]) => mockListNodeContainersFromNode(...args),
  getNodeSystemInfoFromNode: vi.fn(),
  listNodeEventsOnNode: vi.fn(),
  nodeAgentRawRequest: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
}));

vi.mock('../../../src/services/node-agent-diagnostics', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
  listNodeContainersFromNode: (...args: unknown[]) => mockListNodeContainersFromNode(...args),
  getNodeSystemInfoFromNode: vi.fn(),
}));

vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: vi.fn(),
  deleteNodeResources: vi.fn(),
  provisionNode: vi.fn(),
  stopNodeResources: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: vi.fn(),
}));

vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn(() => ({ maxNodes: 10, maxWorkspacesPerNode: 5, canCreateNode: true })),
}));

vi.mock('../../../src/services/telemetry', () => ({
  recordNodeRoutingMetric: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { nodesRoutes } = await import('../../../src/routes/nodes');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/nodes', nodesRoutes);
  return app;
}

describe('node observability log routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireNodeOwnership.mockResolvedValue({ id: 'node-1', status: 'running', userId: 'user-1' });
  });

  it('returns docker container entries from the node agent proxy', async () => {
    mockGetNodeLogsFromNode.mockResolvedValue({
      entries: [{ timestamp: '2026-06-18T10:00:00Z', level: 'info', source: 'docker:web-1', message: 'ready' }],
      nextCursor: null,
      hasMore: false,
    });

    const response = await createApp().request(
      '/api/nodes/node-1/logs?source=docker&container=web-1',
      {},
      { DATABASE: {} } as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.entries[0]).toMatchObject({ source: 'docker:web-1', message: 'ready' });
    expect(mockGetNodeLogsFromNode).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      'user-1',
      'source=docker&container=web-1',
    );
  });

  it('lists containers for the node log picker', async () => {
    mockListNodeContainersFromNode.mockResolvedValue({
      containers: [{ id: 'abc', name: 'web-1', image: 'nginx', state: 'running', status: 'Up' }],
    });

    const response = await createApp().request('/api/nodes/node-1/containers', {}, { DATABASE: {} } as Env);

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.containers).toHaveLength(1);
    expect(body.containers[0].name).toBe('web-1');
  });
});
