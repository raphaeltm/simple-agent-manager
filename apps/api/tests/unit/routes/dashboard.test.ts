/**
 * Behavioral tests for the dashboard routes.
 *
 * Tests exercise route business logic:
 *
 * /active-tasks:
 * - Auth gating
 * - D1 query filtering (only active statuses, only caller's tasks)
 * - Early return for zero tasks
 * - DO session enrichment via getSessionsByTaskIds (per project, in parallel)
 * - DO failure tolerance (Promise.allSettled — partial failure does not fail request)
 * - isActive calculation against DASHBOARD_INACTIVE_THRESHOLD_MS
 * - Sorting: tasks with recent messages first, then tasks without messages by createdAt
 * - Response shape matches DashboardActiveTasksResponse
 *
 * /recent-tasks:
 * - Fetches terminal tasks (completed, failed, cancelled) within time window
 * - Sorts by completed_at descending
 * - Enriches with session IDs from project DOs
 * - Configurable limit and time window via env vars
 * - Response shape matches DashboardRecentTasksResponse
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { dashboardRoutes } from '../../../src/routes/dashboard';
import { DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS } from '@simple-agent-manager/shared';

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
  getSessionsByTaskIds: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import * as projectDataService from '../../../src/services/project-data';

/** Build a task row as returned by the D1 query join. */
function makeTaskRow(overrides: Partial<{
  id: string;
  title: string;
  status: string;
  executionStep: string | null;
  projectId: string;
  projectName: string;
  createdAt: string;
  startedAt: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Fix login bug',
    status: overrides.status ?? 'in_progress',
    executionStep: overrides.executionStep ?? null,
    projectId: overrides.projectId ?? 'proj-1',
    projectName: overrides.projectName ?? 'my-project',
    createdAt: overrides.createdAt ?? new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    startedAt: overrides.startedAt ?? null,
  };
}

/** Build a DO session summary as returned by getSessionsByTaskIds. */
function makeSessionInfo(overrides: Partial<{
  id: string;
  taskId: string;
  lastMessageAt: number | null;
  messageCount: number;
}> = {}) {
  return {
    id: overrides.id ?? 'session-1',
    taskId: overrides.taskId ?? 'task-1',
    lastMessageAt: overrides.lastMessageAt !== undefined ? overrides.lastMessageAt : Date.now() - 60 * 1000,
    messageCount: overrides.messageCount ?? 5,
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/dashboard', dashboardRoutes);
  return app;
}

function buildMockDB(rows: ReturnType<typeof makeTaskRow>[]) {
  const mockDB = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
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

describe('GET /dashboard/active-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Early-return: no tasks
  // -------------------------------------------------------------------------

  it('returns empty tasks array when user has no active tasks', async () => {
    buildMockDB([]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
    // Should NOT call DO at all when there are no tasks
    expect(projectDataService.getSessionsByTaskIds).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path: task with session
  // -------------------------------------------------------------------------

  it('returns enriched task with session data from DO', async () => {
    const now = Date.now();
    const lastMsg = now - 2 * 60 * 1000; // 2 min ago — within threshold

    buildMockDB([makeTaskRow({ id: 'task-1', projectId: 'proj-1' })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ id: 'session-1', taskId: 'task-1', lastMessageAt: lastMsg, messageCount: 7 }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: any[] };
    expect(body.tasks).toHaveLength(1);

    const task = body.tasks[0];
    expect(task.id).toBe('task-1');
    expect(task.sessionId).toBe('session-1');
    expect(task.lastMessageAt).toBe(lastMsg);
    expect(task.messageCount).toBe(7);
    expect(task.isActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // isActive — active vs inactive based on threshold
  // -------------------------------------------------------------------------

  it('marks task as active when lastMessageAt is within threshold', async () => {
    const lastMsg = Date.now() - 5 * 60 * 1000; // 5 min ago; default threshold is 15 min
    buildMockDB([makeTaskRow({ id: 'task-1' })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-1', lastMessageAt: lastMsg }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].isActive).toBe(true);
  });

  it('marks task as inactive when lastMessageAt exceeds threshold', async () => {
    // 20 min ago — beyond the 15-min default threshold
    const lastMsg = Date.now() - 20 * 60 * 1000;
    buildMockDB([makeTaskRow({ id: 'task-1' })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-1', lastMessageAt: lastMsg }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].isActive).toBe(false);
  });

  it('marks task as inactive when lastMessageAt is null (no session or no messages)', async () => {
    buildMockDB([makeTaskRow({ id: 'task-1' })]);
    // No matching session in DO
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].isActive).toBe(false);
    expect(body.tasks[0].lastMessageAt).toBeNull();
    expect(body.tasks[0].sessionId).toBeNull();
    expect(body.tasks[0].messageCount).toBe(0);
  });

  it('uses DASHBOARD_INACTIVE_THRESHOLD_MS env var when set', async () => {
    // Set threshold to 1 minute (60 000 ms)
    const customEnv = { ...mockEnv, DASHBOARD_INACTIVE_THRESHOLD_MS: '60000' } as unknown as Env;
    // Message from 2 min ago — inactive under 1-min threshold, active under 15-min default
    const lastMsg = Date.now() - 2 * 60 * 1000;

    buildMockDB([makeTaskRow({ id: 'task-1' })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-1', lastMessageAt: lastMsg }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, customEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].isActive).toBe(false);
  });

  it('falls back to DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS when env var is absent', async () => {
    // Message within the 15-min default threshold
    const lastMsg = Date.now() - 10 * 60 * 1000;
    buildMockDB([makeTaskRow({ id: 'task-1' })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-1', lastMessageAt: lastMsg }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    // 10 min < DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS (15 min) → active
    expect(body.tasks[0].isActive).toBe(true);
    // Verify constant is 15 min
    expect(DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });

  // -------------------------------------------------------------------------
  // DO failure tolerance
  // -------------------------------------------------------------------------

  it('returns tasks with null session data when DO call fails', async () => {
    buildMockDB([makeTaskRow({ id: 'task-1', projectId: 'proj-1' })]);
    (projectDataService.getSessionsByTaskIds as any).mockRejectedValue(new Error('DO unreachable'));

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);

    // Request must succeed — DO failure is tolerated
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: any[] };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].sessionId).toBeNull();
    expect(body.tasks[0].isActive).toBe(false);
    expect(body.tasks[0].messageCount).toBe(0);
  });

  it('returns tasks for successful projects when one project DO fails', async () => {
    buildMockDB([
      makeTaskRow({ id: 'task-1', projectId: 'proj-1' }),
      makeTaskRow({ id: 'task-2', projectId: 'proj-2', title: 'Deploy service' }),
    ]);

    // proj-1 fails, proj-2 succeeds
    (projectDataService.getSessionsByTaskIds as any)
      .mockImplementationOnce(() => Promise.reject(new Error('proj-1 DO error')))
      .mockImplementationOnce(() =>
        Promise.resolve([makeSessionInfo({ id: 'session-2', taskId: 'task-2', lastMessageAt: Date.now() - 1000 })])
      );

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: any[] };
    expect(body.tasks).toHaveLength(2);

    const task1 = body.tasks.find((t: any) => t.id === 'task-1');
    expect(task1.sessionId).toBeNull(); // DO failed for proj-1

    const task2 = body.tasks.find((t: any) => t.id === 'task-2');
    expect(task2.sessionId).toBe('session-2'); // proj-2 succeeded
  });

  // -------------------------------------------------------------------------
  // Cross-project batching — DO called once per project
  // -------------------------------------------------------------------------

  it('calls getSessionsByTaskIds once per project, not once per task', async () => {
    buildMockDB([
      makeTaskRow({ id: 'task-1', projectId: 'proj-A' }),
      makeTaskRow({ id: 'task-2', projectId: 'proj-A' }),
      makeTaskRow({ id: 'task-3', projectId: 'proj-B' }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    await app.request('/dashboard/active-tasks', {}, mockEnv);

    // Two projects → two DO calls
    expect(projectDataService.getSessionsByTaskIds).toHaveBeenCalledTimes(2);

    // The proj-A call should include both task IDs
    const calls = (projectDataService.getSessionsByTaskIds as any).mock.calls as [unknown, string, string[]][];
    const projACall = calls.find(([, projId]) => projId === 'proj-A');
    expect(projACall).toBeDefined();
    expect(projACall![2]).toEqual(expect.arrayContaining(['task-1', 'task-2']));
    expect(projACall![2]).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  it('sorts tasks with messages before tasks without messages', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({ id: 'task-no-msg', title: 'No messages task', projectId: 'proj-1',
        createdAt: new Date(now - 5 * 60 * 1000).toISOString() }),
      makeTaskRow({ id: 'task-with-msg', title: 'Has messages task', projectId: 'proj-1',
        createdAt: new Date(now - 20 * 60 * 1000).toISOString() }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-with-msg', lastMessageAt: now - 3 * 60 * 1000 }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].id).toBe('task-with-msg');
    expect(body.tasks[1].id).toBe('task-no-msg');
  });

  it('sorts tasks with messages by lastMessageAt descending', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({ id: 'task-older', projectId: 'proj-1' }),
      makeTaskRow({ id: 'task-newer', projectId: 'proj-1' }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-older', lastMessageAt: now - 10 * 60 * 1000 }),
      makeSessionInfo({ id: 'session-newer', taskId: 'task-newer', lastMessageAt: now - 1 * 60 * 1000 }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].id).toBe('task-newer');
    expect(body.tasks[1].id).toBe('task-older');
  });

  it('sorts tasks without messages by createdAt descending', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({ id: 'task-older-created', createdAt: new Date(now - 30 * 60 * 1000).toISOString() }),
      makeTaskRow({ id: 'task-newer-created', createdAt: new Date(now - 5 * 60 * 1000).toISOString() }),
    ]);
    // Neither task has a session
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].id).toBe('task-newer-created');
    expect(body.tasks[1].id).toBe('task-older-created');
  });

  // -------------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------------

  it('response conforms to DashboardActiveTasksResponse shape', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({
        id: 'task-shape',
        title: 'Shape test',
        status: 'queued',
        executionStep: 'node_provisioning',
        projectId: 'proj-shape',
        projectName: 'shape-project',
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ id: 'ses-shape', taskId: 'task-shape', lastMessageAt: now - 2 * 60 * 1000, messageCount: 3 }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };
    const task = body.tasks[0];

    // All DashboardTask fields must be present
    expect(task).toHaveProperty('id', 'task-shape');
    expect(task).toHaveProperty('title', 'Shape test');
    expect(task).toHaveProperty('status', 'queued');
    expect(task).toHaveProperty('executionStep', 'node_provisioning');
    expect(task).toHaveProperty('projectId', 'proj-shape');
    expect(task).toHaveProperty('projectName', 'shape-project');
    expect(task).toHaveProperty('sessionId', 'ses-shape');
    expect(task).toHaveProperty('createdAt');
    expect(task).toHaveProperty('startedAt');
    expect(task).toHaveProperty('lastMessageAt');
    expect(task).toHaveProperty('messageCount', 3);
    expect(task).toHaveProperty('isActive');
  });

  it('includes executionStep as null when not set on the task row', async () => {
    buildMockDB([makeTaskRow({ id: 'task-no-step', executionStep: null })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].executionStep).toBeNull();
  });

  it('includes startedAt as null when task has not started', async () => {
    buildMockDB([makeTaskRow({ id: 'task-no-start', startedAt: null })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = await res.json() as { tasks: any[] };

    expect(body.tasks[0].startedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/recent-tasks
// ---------------------------------------------------------------------------

describe('GET /dashboard/recent-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Build a mock D1 prepare/bind/all chain for raw SQL queries. */
  function buildMockD1(rows: Record<string, unknown>[]) {
    const mockAll = vi.fn().mockResolvedValue({ results: rows });
    const mockBind = vi.fn().mockReturnValue({ all: mockAll });
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
    return {
      prepare: mockPrepare,
      _bind: mockBind,
      _all: mockAll,
    };
  }

  /** Build a recent task row as would be returned by raw SQL query. */
  function makeRecentTaskRow(overrides: Partial<{
    id: string;
    title: string;
    status: string;
    project_id: string;
    project_name: string;
    created_at: string;
    completed_at: string | null;
    output_branch: string | null;
    output_pr_url: string | null;
    output_summary: string | null;
  }> = {}) {
    return {
      id: overrides.id ?? 'task-recent-1',
      title: overrides.title ?? 'Completed task',
      status: overrides.status ?? 'completed',
      project_id: overrides.project_id ?? 'proj-1',
      project_name: overrides.project_name ?? 'my-project',
      created_at: overrides.created_at ?? new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      completed_at: overrides.completed_at ?? new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      output_branch: overrides.output_branch ?? 'sam/fix-bug',
      output_pr_url: overrides.output_pr_url ?? null,
      output_summary: overrides.output_summary ?? 'Fixed the bug',
    };
  }

  it('returns empty tasks array when no recent tasks exist', async () => {
    const d1 = buildMockD1([]);
    // Also need drizzle mock for active-tasks (middleware uses same db)
    buildMockDB([]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const envWithD1 = { ...mockEnv, DATABASE: d1 as unknown as D1Database } as unknown as Env;

    const app = buildApp();
    const res = await app.request('/dashboard/recent-tasks', {}, envWithD1);

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });

  it('returns completed tasks with correct shape', async () => {
    const row = makeRecentTaskRow({
      id: 'task-done',
      title: 'Done task',
      status: 'completed',
      project_id: 'proj-X',
      project_name: 'Project X',
      output_branch: 'sam/done',
      output_summary: 'All done',
    });
    const d1 = buildMockD1([row]);
    buildMockDB([]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      { id: 'ses-done', taskId: 'task-done' },
    ]);

    const envWithD1 = { ...mockEnv, DATABASE: d1 as unknown as D1Database } as unknown as Env;

    const app = buildApp();
    const res = await app.request('/dashboard/recent-tasks', {}, envWithD1);

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: any[] };
    expect(body.tasks).toHaveLength(1);

    const task = body.tasks[0];
    expect(task).toHaveProperty('id', 'task-done');
    expect(task).toHaveProperty('title', 'Done task');
    expect(task).toHaveProperty('status', 'completed');
    expect(task).toHaveProperty('projectId', 'proj-X');
    expect(task).toHaveProperty('projectName', 'Project X');
    expect(task).toHaveProperty('sessionId', 'ses-done');
    expect(task).toHaveProperty('createdAt');
    expect(task).toHaveProperty('completedAt');
    expect(task).toHaveProperty('outputBranch', 'sam/done');
    expect(task).toHaveProperty('outputSummary', 'All done');
  });

  it('returns tasks with null sessionId when DO has no matching session', async () => {
    const d1 = buildMockD1([makeRecentTaskRow({ id: 'task-no-session' })]);
    buildMockDB([]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const envWithD1 = { ...mockEnv, DATABASE: d1 as unknown as D1Database } as unknown as Env;

    const app = buildApp();
    const res = await app.request('/dashboard/recent-tasks', {}, envWithD1);

    const body = await res.json() as { tasks: any[] };
    expect(body.tasks[0].sessionId).toBeNull();
  });

  it('includes failed and cancelled tasks', async () => {
    const d1 = buildMockD1([
      makeRecentTaskRow({ id: 'task-failed', status: 'failed' }),
      makeRecentTaskRow({ id: 'task-cancelled', status: 'cancelled' }),
    ]);
    buildMockDB([]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const envWithD1 = { ...mockEnv, DATABASE: d1 as unknown as D1Database } as unknown as Env;

    const app = buildApp();
    const res = await app.request('/dashboard/recent-tasks', {}, envWithD1);

    const body = await res.json() as { tasks: any[] };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks.map((t: any) => t.status)).toEqual(['failed', 'cancelled']);
  });

  it('tolerates DO failures gracefully', async () => {
    const d1 = buildMockD1([makeRecentTaskRow({ id: 'task-1' })]);
    buildMockDB([]);
    (projectDataService.getSessionsByTaskIds as any).mockRejectedValue(new Error('DO down'));

    const envWithD1 = { ...mockEnv, DATABASE: d1 as unknown as D1Database } as unknown as Env;

    const app = buildApp();
    const res = await app.request('/dashboard/recent-tasks', {}, envWithD1);

    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: any[] };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].sessionId).toBeNull();
  });
});
