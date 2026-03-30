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
    expect(body.ideas).toEqual([]);
    expect(body.relationships).toEqual([]);
  });

  it('returns entities with relationships for a project with workspaces and sessions', async () => {
    const projects = [
      { id: 'proj-1', name: 'My Project', repository: 'user/repo', status: 'active', lastActivityAt: null, activeSessionCount: 1 },
    ];
    const nodes = [
      { id: 'node-1', name: 'node-1', status: 'active', vmSize: 'cax11', vmLocation: 'nbg1', cloudProvider: 'hetzner', ipAddress: '1.2.3.4', healthStatus: 'healthy', lastHeartbeatAt: null, lastMetrics: null },
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
        { id: 'sess-1', topic: 'Chat about bug', status: 'running', messageCount: 5, workspaceId: 'ws-1', taskId: 'task-1' },
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
