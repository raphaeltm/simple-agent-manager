import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mockRequireNodeOwnership = vi.fn();
const mockGetNodeLogsFromNode = vi.fn();
const mockListNodeContainersFromNode = vi.fn();
const mockFetchNodeAgent = vi.fn();
const mockGetNodeAgentRequestTimeoutMs = vi.fn();
const mockSignNodeManagementToken = vi.fn();

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/node-auth', () => ({
  requireNodeOwnership: (...args: unknown[]) => mockRequireNodeOwnership(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  fetchNodeAgent: (...args: unknown[]) => mockFetchNodeAgent(...args),
  getNodeAgentRequestTimeoutMs: (...args: unknown[]) => mockGetNodeAgentRequestTimeoutMs(...args),
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
  signNodeManagementToken: (...args: unknown[]) => mockSignNodeManagementToken(...args),
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
    mockGetNodeAgentRequestTimeoutMs.mockReturnValue(30_000);
    mockSignNodeManagementToken.mockResolvedValue({
      token: 'node-management-token',
      expiresAt: '2026-08-23T05:00:00.000Z',
    });
    mockFetchNodeAgent.mockResolvedValue(new Response('proxied', { status: 200 }));
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

  it('proxies log stream with node-management auth and strips client auth material', async () => {
    const response = await createApp().request(
      '/api/nodes/node-1/logs/stream?source=docker&level=debug&token=client-supplied-token',
      {
        headers: {
          Authorization: 'Bearer user-api-token',
          Cookie: 'better-auth.session_token=user-session',
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'websocket-upgrade-key-placeholder',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Protocol': 'sam.logs',
          'Sec-WebSocket-Extensions': 'permessage-deflate',
          Origin: 'https://app.example.com',
        },
      },
      {
        BASE_DOMAIN: 'example.com',
        VM_AGENT_PROTOCOL: 'https',
        VM_AGENT_PORT: '8443',
      } as Env,
    );

    expect(response.status).toBe(200);
    expect(mockSignNodeManagementToken).toHaveBeenCalledWith('user-1', 'node-1', null, expect.anything());
    expect(mockFetchNodeAgent).toHaveBeenCalledTimes(1);

    const [, , vmUrl, init] = mockFetchNodeAgent.mock.calls[0];
    const parsedVmUrl = new URL(vmUrl as string);
    expect(parsedVmUrl.pathname).toBe('/logs/stream');
    expect(parsedVmUrl.searchParams.get('token')).toBe('node-management-token');
    expect(parsedVmUrl.searchParams.get('source')).toBe('docker');
    expect(parsedVmUrl.searchParams.get('level')).toBe('debug');

    const forwardedHeaders = (init as { headers: Headers }).headers;
    expect(forwardedHeaders.get('Authorization')).toBe('Bearer node-management-token');
    expect(forwardedHeaders.get('Cookie')).toBeNull();
    expect(forwardedHeaders.get('X-SAM-Node-Id')).toBe('node-1');
    expect(forwardedHeaders.get('Upgrade')).toBe('websocket');
    expect(forwardedHeaders.get('Sec-WebSocket-Protocol')).toBe('sam.logs');
  });
});
