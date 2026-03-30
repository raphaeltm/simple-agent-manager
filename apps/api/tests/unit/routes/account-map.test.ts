/**
 * Behavioral tests for the GET /api/account-map route.
 *
 * Tests exercise:
 * - D1 query filtering (only caller's entities)
 * - DO session enrichment via listSessions (per project, in parallel)
 * - DO failure tolerance (Promise.allSettled)
 * - Relationship edge building
 * - Response shape
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { accountMapRoutes } from '../../../src/routes/account-map';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm/d1');

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-123',
}));

vi.mock('../../../src/services/project-data', () => ({
  listSessions: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import * as projectDataService from '../../../src/services/project-data';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/account-map', accountMapRoutes);
  return app;
}

/**
 * Build a mock D1 that returns different results for sequential .limit() calls.
 * The account-map route makes 4 parallel queries via Promise.all, each calling
 * .select().from().where().limit().
 */
function buildMockDB(
  projects: any[],
  nodes: any[],
  workspaces: any[],
  tasks: any[]
) {
  let callIdx = 0;
  const results = [projects, nodes, workspaces, tasks];

  const mockDB = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      const result = results[callIdx % results.length];
      callIdx++;
      return Promise.resolve(result);
    }),
  };
  (drizzle as any).mockReturnValue(mockDB);
  return mockDB;
}

const mockEnv = {
  DATABASE: {} as D1Database,
  PROJECT_DATA: {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
    get: vi.fn(),
  },
  KV: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  },
} as unknown as Env;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /account-map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty response when user has no entities', async () => {
    buildMockDB([], [], [], []);

    const app = buildApp();
    const res = await app.request('/account-map', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.projects).toEqual([]);
    expect(body.nodes).toEqual([]);
    expect(body.workspaces).toEqual([]);
    expect(body.sessions).toEqual([]);
    expect(body.tasks).toEqual([]);

    expect(body.relationships).toEqual([]);
  });

  it('filters to active resources by default', async () => {
    const projects = [
      { id: 'proj-1', name: 'My Project', repository: null, status: 'active', lastActivityAt: null, activeSessionCount: 0 },
    ];
    // Node with inactive status — should be filtered out when activeOnly=true
    const nodes = [
      { id: 'node-1', name: 'node-1', status: 'stopped', vmSize: 'cax11', vmLocation: 'nbg1', cloudProvider: 'hetzner', ipAddress: '1.2.3.4', healthStatus: null, lastHeartbeatAt: null, lastMetrics: null },
      { id: 'node-2', name: 'node-2', status: 'running', vmSize: 'cax11', vmLocation: 'nbg1', cloudProvider: 'hetzner', ipAddress: '1.2.3.5', healthStatus: 'healthy', lastHeartbeatAt: null, lastMetrics: null },
    ];
    const workspaces = [
      { id: 'ws-1', nodeId: 'node-1', projectId: 'proj-1', displayName: 'old-ws', branch: 'main', status: 'stopped', vmSize: 'cax11', chatSessionId: null },
      { id: 'ws-2', nodeId: 'node-2', projectId: 'proj-1', displayName: 'dev-ws', branch: 'main', status: 'running', vmSize: 'cax11', chatSessionId: null },
    ];
    const tasks = [
      { id: 'task-1', projectId: 'proj-1', workspaceId: null, title: 'Done', status: 'completed', executionStep: null, priority: 2 },
      { id: 'task-2', projectId: 'proj-1', workspaceId: 'ws-2', title: 'Active', status: 'in_progress', executionStep: 'agent_session', priority: 1 },
    ];

    buildMockDB(projects, nodes, workspaces, tasks);
    (projectDataService.listSessions as any).mockResolvedValue({
      sessions: [
        { id: 'sess-1', topic: 'Old chat', status: 'stopped', messageCount: 10, workspaceId: null, taskId: null },
        { id: 'sess-2', topic: 'Active chat', status: 'active', messageCount: 3, workspaceId: 'ws-2', taskId: 'task-2' },
      ],
      total: 2,
    });

    const app = buildApp();
    // Default request — activeOnly=true
    const res = await app.request('/account-map', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // Projects are always included
    expect(body.projects).toHaveLength(1);
    // Only active sessions returned
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].status).toBe('active');
  });

  it('returns all resources when activeOnly=false', async () => {
    const projects = [
      { id: 'proj-1', name: 'P', repository: null, status: 'active', lastActivityAt: null, activeSessionCount: 0 },
    ];

    buildMockDB(projects, [], [], []);
    (projectDataService.listSessions as any).mockResolvedValue({
      sessions: [
        { id: 'sess-1', topic: 'Old', status: 'stopped', messageCount: 10, workspaceId: null, taskId: null },
        { id: 'sess-2', topic: 'Active', status: 'active', messageCount: 3, workspaceId: null, taskId: null },
      ],
      total: 2,
    });

    const app = buildApp();
    const res = await app.request('/account-map?activeOnly=false', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // All sessions returned
    expect(body.sessions).toHaveLength(2);
  });

  it('uses separate cache keys for active vs all', async () => {
    buildMockDB([], [], [], []);

    const app = buildApp();

    // First request (active) - miss
    await app.request('/account-map', {}, mockEnv);
    expect(mockEnv.KV.get).toHaveBeenCalledWith('account-map:user-123:active', 'json');
    expect(mockEnv.KV.put).toHaveBeenCalledWith(
      'account-map:user-123:active',
      expect.any(String),
      expect.any(Object)
    );

    vi.clearAllMocks();
    (mockEnv.KV.get as any).mockResolvedValue(null);
    (mockEnv.KV.put as any).mockResolvedValue(undefined);
    buildMockDB([], [], [], []);

    // Second request (all) - different key
    await app.request('/account-map?activeOnly=false', {}, mockEnv);
    expect(mockEnv.KV.get).toHaveBeenCalledWith('account-map:user-123:all', 'json');
  });

  it('returns entities with relationships for a project with workspaces and sessions', async () => {
    const projects = [
      { id: 'proj-1', name: 'My Project', repository: 'user/repo', status: 'active', lastActivityAt: null, activeSessionCount: 1 },
    ];
    const nodes = [
      { id: 'node-1', name: 'node-1', status: 'running', vmSize: 'cax11', vmLocation: 'nbg1', cloudProvider: 'hetzner', ipAddress: '1.2.3.4', healthStatus: 'healthy', lastHeartbeatAt: null, lastMetrics: null },
    ];
    const workspaces = [
      { id: 'ws-1', nodeId: 'node-1', projectId: 'proj-1', displayName: 'dev-ws', branch: 'main', status: 'running', vmSize: 'cax11', chatSessionId: null },
    ];
    const tasks = [
      { id: 'task-1', projectId: 'proj-1', workspaceId: 'ws-1', title: 'Fix bug', status: 'in_progress', executionStep: 'agent_session', priority: 2 },
    ];

    buildMockDB(projects, nodes, workspaces, tasks);
    (projectDataService.listSessions as any).mockResolvedValue({
      sessions: [
        { id: 'sess-1', topic: 'Chat about bug', status: 'active', messageCount: 5, workspaceId: 'ws-1', taskId: 'task-1' },
      ],
      total: 1,
    });

    const app = buildApp();
    const res = await app.request('/account-map', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.projects).toHaveLength(1);
    expect(body.nodes).toHaveLength(1);
    expect(body.workspaces).toHaveLength(1);
    expect(body.tasks).toHaveLength(1);
    expect(body.sessions).toHaveLength(1);

    // Verify relationships are built
    const relTypes = body.relationships.map((r: any) => r.type);
    expect(relTypes).toContain('has_workspace');
    expect(relTypes).toContain('runs_on');
    expect(relTypes).toContain('has_session');
    expect(relTypes).toContain('has_task');
    expect(relTypes).toContain('task_workspace');
  });

  it('tolerates DO failures without failing the request', async () => {
    const projects = [
      { id: 'proj-1', name: 'Failing Project', repository: null, status: 'active', lastActivityAt: null, activeSessionCount: 0 },
    ];

    buildMockDB(projects, [], [], []);
    (projectDataService.listSessions as any).mockRejectedValue(new Error('DO unreachable'));

    const app = buildApp();
    const res = await app.request('/account-map', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.projects).toHaveLength(1);
    expect(body.sessions).toEqual([]);
  });
});
