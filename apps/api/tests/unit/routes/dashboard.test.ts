/**
 * Behavioral tests for the dashboard /active-tasks route.
 *
 * Tests exercise the route's business logic:
 * - Auth gating
 * - D1 query filtering (only active statuses, only caller's tasks)
 * - Early return for zero tasks
 * - DO session enrichment via getSessionsByTaskIds (per project, in parallel)
 * - DO failure tolerance (Promise.allSettled — partial failure does not fail request)
 * - isActive calculation against DASHBOARD_INACTIVE_THRESHOLD_MS
 * - Ranking: most recent activity first (newest message, else start/submit time),
 *   capped at DASHBOARD_ACTIVE_TASK_LIMIT only after every candidate is ranked
 * - Candidate read bounded by DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT and the SQL bind ceiling
 * - Response shape matches DashboardActiveTasksResponse
 *
 * The real-SQL vertical slice for "rank before capping" lives in
 * dashboard-active-tasks-real-sql.test.ts.
 */
import {
  DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT,
  DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT,
  DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS,
} from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { dashboardRoutes } from '../../../src/routes/dashboard';

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

vi.mock('../../../src/services/agent-activity', () => ({
  listAgentActivityTasks: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import * as agentActivityService from '../../../src/services/agent-activity';
import * as projectDataService from '../../../src/services/project-data';

/** Build a task row as returned by the D1 query join. */
function makeTaskRow(
  overrides: Partial<{
    id: string;
    title: string;
    status: string;
    executionStep: string | null;
    projectId: string;
    projectName: string;
    createdAt: string;
    startedAt: string | null;
    agentActivityState: 'working' | 'awake-idle' | 'sleeping' | 'superseded';
  }> = {}
) {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Fix login bug',
    status: overrides.status ?? 'in_progress',
    executionStep: overrides.executionStep ?? null,
    projectId: overrides.projectId ?? 'proj-1',
    projectName: overrides.projectName ?? 'my-project',
    createdAt: overrides.createdAt ?? new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    startedAt: overrides.startedAt ?? null,
    agentActivityState: overrides.agentActivityState ?? 'working',
  };
}

/** Build a DO session summary as returned by getSessionsByTaskIds. */
function makeSessionInfo(
  overrides: Partial<{
    id: string;
    taskId: string;
    lastMessageAt: number | null;
    messageCount: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'session-1',
    taskId: overrides.taskId ?? 'task-1',
    lastMessageAt:
      overrides.lastMessageAt !== undefined ? overrides.lastMessageAt : Date.now() - 60 * 1000,
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
  (agentActivityService.listAgentActivityTasks as any).mockResolvedValue(rows);
  return agentActivityService.listAgentActivityTasks;
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
    (agentActivityService.listAgentActivityTasks as any).mockResolvedValue([]);
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
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
    expect(agentActivityService.listAgentActivityTasks).toHaveBeenCalledWith(
      mockEnv,
      expect.objectContaining({
        activeOnly: true,
        limit: DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT,
        userId: 'user-123',
      })
    );
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
      makeSessionInfo({
        id: 'session-1',
        taskId: 'task-1',
        lastMessageAt: lastMsg,
        messageCount: 7,
      }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: any[] };
    expect(body.tasks).toHaveLength(1);

    const task = body.tasks[0];
    expect(task.id).toBe('task-1');
    expect(task.sessionId).toBe('session-1');
    expect(task.lastMessageAt).toBe(lastMsg);
    expect(task.messageCount).toBe(7);
    expect(task.isActive).toBe(true);
    expect(task.agentActivityState).toBe('working');
  });

  it('preserves sleeping state from the shared agent-activity derivation', async () => {
    buildMockDB([makeTaskRow({ id: 'task-sleeping', agentActivityState: 'sleeping' })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks[0]).toMatchObject({
      id: 'task-sleeping',
      agentActivityState: 'sleeping',
      isActive: false,
    });
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
    const body = (await res.json()) as { tasks: any[] };

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
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks[0].isActive).toBe(false);
  });

  it('marks task as inactive when lastMessageAt is null (no session or no messages)', async () => {
    buildMockDB([makeTaskRow({ id: 'task-1' })]);
    // No matching session in DO
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

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
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks[0].isActive).toBe(false);
  });

  it('caps the response at DASHBOARD_ACTIVE_TASK_LIMIT without shrinking the candidate read', async () => {
    const customEnv = { ...mockEnv, DASHBOARD_ACTIVE_TASK_LIMIT: '2' } as unknown as Env;
    const now = Date.now();
    // Oldest first, so slicing before ranking would return the wrong two.
    buildMockDB(
      [4, 3, 2, 1].map((minutesAgo) =>
        makeTaskRow({
          id: `task-${minutesAgo}m`,
          createdAt: new Date(now - minutesAgo * 60 * 1000).toISOString(),
        })
      )
    );
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, customEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks.map((t: any) => t.id)).toEqual(['task-1m', 'task-2m']);
    expect(agentActivityService.listAgentActivityTasks).toHaveBeenCalledWith(
      customEnv,
      expect.objectContaining({ limit: DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT })
    );
  });

  it('reads DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT candidates when set', async () => {
    const customEnv = {
      ...mockEnv,
      DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT: '40',
    } as unknown as Env;
    buildMockDB([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, customEnv);

    expect(res.status).toBe(200);
    expect(agentActivityService.listAgentActivityTasks).toHaveBeenCalledWith(
      customEnv,
      expect.objectContaining({ activeOnly: true, limit: 40, userId: 'user-123' })
    );
  });

  it('clamps the candidate read to the SQL bind ceiling of the per-project session lookup', async () => {
    // Every candidate in one project travels in a single DO `IN (...)` list, and
    // Cloudflare SQL rejects a statement's 101st bound parameter.
    const customEnv = {
      ...mockEnv,
      DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT: '500',
    } as unknown as Env;
    buildMockDB([]);

    const app = buildApp();
    await app.request('/dashboard/active-tasks', {}, customEnv);

    expect(agentActivityService.listAgentActivityTasks).toHaveBeenCalledWith(
      customEnv,
      expect.objectContaining({ limit: 100 })
    );
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
    const body = (await res.json()) as { tasks: any[] };

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
    const body = (await res.json()) as { tasks: any[] };
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
        Promise.resolve([
          makeSessionInfo({ id: 'session-2', taskId: 'task-2', lastMessageAt: Date.now() - 1000 }),
        ])
      );

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: any[] };
    expect(body.tasks).toHaveLength(2);

    const task1 = body.tasks.find((t: any) => t.id === 'task-1');
    expect(task1.sessionId).toBeNull(); // DO failed for proj-1

    const task2 = body.tasks.find((t: any) => t.id === 'task-2');
    expect(task2.sessionId).toBe('session-2'); // proj-2 succeeded
  });

  it('ranks tasks from a project whose session lookup failed by start time, then caps the mix', async () => {
    const now = Date.now();
    const minutesAgo = (m: number) => new Date(now - m * 60 * 1000).toISOString();
    buildMockDB([
      ...[10, 20, 90, 120].map((m) =>
        makeTaskRow({ id: `task-ok-${m}m`, projectId: 'proj-ok', createdAt: minutesAgo(180) })
      ),
      ...[5, 60, 150].map((m) =>
        makeTaskRow({
          id: `task-down-${m}m`,
          projectId: 'proj-down',
          createdAt: minutesAgo(200),
          startedAt: minutesAgo(m),
        })
      ),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockImplementation(
      async (_env: Env, projectId: string) => {
        if (projectId === 'proj-down') throw new Error('proj-down DO unreachable');
        return [10, 20, 90, 120].map((m) =>
          makeSessionInfo({
            id: `session-ok-${m}m`,
            taskId: `task-ok-${m}m`,
            lastMessageAt: now - m * 60 * 1000,
          })
        );
      }
    );

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(res.status).toBe(200);
    expect(body.tasks.map((t: any) => t.id)).toEqual([
      'task-down-5m',
      'task-ok-10m',
      'task-ok-20m',
      'task-down-60m',
      'task-ok-90m',
      'task-ok-120m',
    ]);
    expect(body.tasks.find((t: any) => t.id === 'task-down-5m').sessionId).toBeNull();
    expect(body.tasks.find((t: any) => t.id === 'task-ok-10m').sessionId).toBe('session-ok-10m');
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
    const calls = (projectDataService.getSessionsByTaskIds as any).mock.calls as [
      unknown,
      string,
      string[],
    ][];
    const projACall = calls.find(([, projId]) => projId === 'proj-A');
    expect(projACall).toBeDefined();
    expect(projACall![2]).toEqual(expect.arrayContaining(['task-1', 'task-2']));
    expect(projACall![2]).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Ranking and the display cap
  // -------------------------------------------------------------------------

  it('returns only the six most recently active tasks by default', async () => {
    const now = Date.now();
    const submittedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const minutesAgo = [80, 10, 70, 20, 60, 30, 50, 40];
    buildMockDB(minutesAgo.map((m) => makeTaskRow({ id: `task-${m}m`, createdAt: submittedAt })));
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue(
      minutesAgo.map((m) =>
        makeSessionInfo({
          id: `session-${m}m`,
          taskId: `task-${m}m`,
          lastMessageAt: now - m * 60 * 1000,
        })
      )
    );

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT).toBe(6);
    expect(body.tasks.map((t: any) => t.id)).toEqual([
      'task-10m',
      'task-20m',
      'task-30m',
      'task-40m',
      'task-50m',
      'task-60m',
    ]);
  });

  it('ranks a task without messages by when it was submitted, not below every task with messages', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({
        id: 'task-dormant',
        createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeTaskRow({
        id: 'task-older-submitted',
        createdAt: new Date(now - 5 * 60 * 1000).toISOString(),
      }),
      makeTaskRow({
        id: 'task-recent-msg',
        createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
      }),
      makeTaskRow({
        id: 'task-just-submitted',
        status: 'queued',
        createdAt: new Date(now - 1 * 60 * 1000).toISOString(),
      }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-recent-msg', lastMessageAt: now - 3 * 60 * 1000 }),
      makeSessionInfo({
        id: 'session-dormant',
        taskId: 'task-dormant',
        lastMessageAt: now - 24 * 60 * 60 * 1000,
      }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks.map((t: any) => t.id)).toEqual([
      'task-just-submitted',
      'task-recent-msg',
      'task-older-submitted',
      'task-dormant',
    ]);
  });

  it('ranks a started task without messages by when it started', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({
        id: 'task-submitted-recently',
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
      }),
      makeTaskRow({
        id: 'task-started-recently',
        createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
        startedAt: new Date(now - 2 * 60 * 1000).toISOString(),
      }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks.map((t: any) => t.id)).toEqual([
      'task-started-recently',
      'task-submitted-recently',
    ]);
  });

  it('breaks activity ties on task id so repeated polls return the same order', async () => {
    const lastMessageAt = Date.now() - 60 * 1000;
    const sessions = [
      makeSessionInfo({ id: 'session-b', taskId: 'task-b', lastMessageAt }),
      makeSessionInfo({ id: 'session-a', taskId: 'task-a', lastMessageAt }),
    ];
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue(sessions);
    const app = buildApp();

    for (const order of [
      ['task-b', 'task-a'],
      ['task-a', 'task-b'],
    ]) {
      buildMockDB(order.map((id) => makeTaskRow({ id })));
      const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
      const body = (await res.json()) as { tasks: any[] };
      expect(body.tasks.map((t: any) => t.id)).toEqual(['task-a', 'task-b']);
    }
  });

  it('ranks and links a task by its most recently updated session when it has several', async () => {
    const now = Date.now();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const others = [10, 20, 30, 40, 50, 60];
    buildMockDB([
      makeTaskRow({ id: 'task-multi', createdAt: threeDaysAgo }),
      ...others.map((m) => makeTaskRow({ id: `task-${m}m`, createdAt: threeDaysAgo })),
    ]);
    // The DO returns sessions most recently updated first (ORDER BY updated_at DESC).
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({
        id: 'session-current',
        taskId: 'task-multi',
        lastMessageAt: now - 60 * 1000,
        messageCount: 12,
      }),
      ...others.map((m) =>
        makeSessionInfo({
          id: `session-${m}m`,
          taskId: `task-${m}m`,
          lastMessageAt: now - m * 60 * 1000,
        })
      ),
      makeSessionInfo({
        id: 'session-previous',
        taskId: 'task-multi',
        lastMessageAt: now - 2 * 24 * 60 * 60 * 1000,
        messageCount: 40,
      }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks).toHaveLength(6);
    expect(body.tasks[0]).toMatchObject({
      id: 'task-multi',
      sessionId: 'session-current',
      lastMessageAt: now - 60 * 1000,
      messageCount: 12,
    });
  });

  it('ranks a task with an unparseable timestamp last instead of failing the request', async () => {
    buildMockDB([
      makeTaskRow({ id: 'task-malformed', createdAt: 'not-a-date' }),
      makeTaskRow({
        id: 'task-valid',
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(res.status).toBe(200);
    expect(body.tasks.map((t: any) => t.id)).toEqual(['task-valid', 'task-malformed']);
  });

  it('sorts tasks with messages by lastMessageAt descending', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({ id: 'task-older', projectId: 'proj-1' }),
      makeTaskRow({ id: 'task-newer', projectId: 'proj-1' }),
    ]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([
      makeSessionInfo({ taskId: 'task-older', lastMessageAt: now - 10 * 60 * 1000 }),
      makeSessionInfo({
        id: 'session-newer',
        taskId: 'task-newer',
        lastMessageAt: now - 1 * 60 * 1000,
      }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks[0].id).toBe('task-newer');
    expect(body.tasks[1].id).toBe('task-older');
  });

  it('sorts tasks without messages by createdAt descending', async () => {
    const now = Date.now();
    buildMockDB([
      makeTaskRow({
        id: 'task-older-created',
        createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
      }),
      makeTaskRow({
        id: 'task-newer-created',
        createdAt: new Date(now - 5 * 60 * 1000).toISOString(),
      }),
    ]);
    // Neither task has a session
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

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
      makeSessionInfo({
        id: 'ses-shape',
        taskId: 'task-shape',
        lastMessageAt: now - 2 * 60 * 1000,
        messageCount: 3,
      }),
    ]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };
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
    expect(task).toHaveProperty('agentActivityState', 'working');
  });

  it('includes executionStep as null when not set on the task row', async () => {
    buildMockDB([makeTaskRow({ id: 'task-no-step', executionStep: null })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks[0].executionStep).toBeNull();
  });

  it('includes startedAt as null when task has not started', async () => {
    buildMockDB([makeTaskRow({ id: 'task-no-start', startedAt: null })]);
    (projectDataService.getSessionsByTaskIds as any).mockResolvedValue([]);

    const app = buildApp();
    const res = await app.request('/dashboard/active-tasks', {}, mockEnv);
    const body = (await res.json()) as { tasks: any[] };

    expect(body.tasks[0].startedAt).toBeNull();
  });
});
