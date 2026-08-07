/**
 * Behavioral IDOR tests for shared-project task lifecycle authorization.
 *
 * These tests mount the REAL route handlers, stub the DB to return rows whose
 * projectId / userId DIFFER from the route's projectId / the caller's userId,
 * and assert 404 + zero mutation. They replace the prior source-contract tests
 * (readFileSync + toContain) which were banned for auth code (rules 02/28).
 *
 * Each test is discriminating: it MUST fail if the guard is inverted or removed.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  requireProjectCapability: vi.fn(),
  requireOwnedWorkspace: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  cleanupTaskRun: vi.fn(),
  cleanupTerminalTaskResourcesOrThrow: vi.fn(),
  recordActivityEvent: vi.fn(),
  cleanupWorkspaceForDeletion: vi.fn(),
  createSession: vi.fn(),
  stopSession: vi.fn(),
  failSession: vi.fn(),
  getGitHubUserAccessToken: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
  resolveCredentialSource: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getAuth: () => ({ user: { id: 'caller-user', name: 'Caller', email: 'caller@test.com' } }),
  getUserId: () => 'caller-user',
}));
vi.mock('../../../src/middleware/project-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/project-auth')>();
  return {
    ...actual,
    requireProjectCapability: mocks.requireProjectCapability,
    requireOwnedWorkspace: mocks.requireOwnedWorkspace,
  };
});
vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));
vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: mocks.cleanupTaskRun,
}));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResourcesOrThrow: mocks.cleanupTerminalTaskResourcesOrThrow,
}));
vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: mocks.recordActivityEvent,
  createSession: mocks.createSession,
  stopSession: mocks.stopSession,
  failSession: mocks.failSession,
}));
vi.mock('../../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: (...args: unknown[]) => mocks.cleanupWorkspaceForDeletion(...args),
}));
vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessToken: mocks.getGitHubUserAccessToken,
}));
vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
}));

import { crudRoutes } from '../../../src/routes/tasks/crud';
import { runRoutes } from '../../../src/routes/tasks/run';

function buildDb(selectResults: unknown[][]) {
  const updateSets: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const pending = Promise.resolve(rows);
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
      $dynamic: vi.fn(() => chain),
      then: (resolve: (v: unknown[]) => unknown, reject?: (r: unknown) => unknown) =>
        pending.then(resolve, reject),
    };
    return chain;
  });
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updateSets.push(values);
      return {
        where: vi.fn(() => Promise.resolve()),
      };
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => Promise.resolve()),
  }));

  return { select, update, insert, updateSets };
}

function createRunApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/tasks', runRoutes);
  return app;
}

function createCrudApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/tasks', crudRoutes);
  return app;
}

const mockEnv = {
  DATABASE: {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ run: vi.fn(() => Promise.resolve({ meta: { changes: 1 } })) })),
    })),
  } as unknown as D1Database,
  BASE_DOMAIN: 'sammy.party',
} as Env;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('shared project task authorization — behavioral IDOR tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-A' });
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.cleanupTaskRun.mockResolvedValue(undefined);
    mocks.cleanupTerminalTaskResourcesOrThrow.mockResolvedValue(undefined);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.cleanupWorkspaceForDeletion.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue('sess-1');
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.failSession.mockResolvedValue(undefined);
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([{ id: 42, fullName: 'org/repo' }]);
    mocks.resolveCredentialSource.mockResolvedValue({ credentialSource: 'user' });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Finding 1: POST /:taskId/run — cross-project task IDOR
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/run rejects cross-project tasks', () => {
    it('returns 404 when the task belongs to a different project than the route', async () => {
      const crossProjectTask = {
        id: 'task-victim',
        projectId: 'project-VICTIM',
        userId: 'other-user',
        status: 'ready',
        title: 'Victim task',
        description: null,
        outputBranch: null,
        agentProfileHint: null,
      };
      const db = buildDb([[crossProjectTask]]);
      vi.mocked(drizzle).mockReturnValue(db as never);

      const response = await createRunApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-victim/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(404);
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Finding 1: POST /:taskId/run/cleanup — cross-project task IDOR
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/run/cleanup rejects cross-project tasks', () => {
    it('returns 404 when the task belongs to a different project than the route', async () => {
      const crossProjectTask = {
        id: 'task-victim',
        projectId: 'project-VICTIM',
        userId: 'other-user',
        status: 'completed',
        workspaceId: 'ws-victim',
      };
      const db = buildDb([[crossProjectTask]]);
      vi.mocked(drizzle).mockReturnValue(db as never);

      const response = await createRunApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-victim/run/cleanup', {
          method: 'POST',
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(404);
      expect(mocks.cleanupTaskRun).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // HIGH-2: POST /:taskId/run/cleanup — requiredUserId threading
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/run/cleanup threads requiredUserId to cleanupTaskRun', () => {
    it('passes the caller userId as the 4th argument to cleanupTaskRun', async () => {
      const task = {
        id: 'task-cleanup-1',
        projectId: 'project-A',
        userId: 'task-creator',
        status: 'completed',
        workspaceId: 'ws-creator',
      };
      const db = buildDb([[task]]);
      vi.mocked(drizzle).mockReturnValue(db as never);

      const response = await createRunApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-cleanup-1/run/cleanup', {
          method: 'POST',
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(200);
      // waitUntil is called with the cleanupTaskRun promise
      expect(mockCtx.waitUntil).toHaveBeenCalled();
      expect(mocks.cleanupTaskRun).toHaveBeenCalledWith(
        'task-cleanup-1',
        mockEnv,
        undefined,
        'caller-user',
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Finding 2: POST /:taskId/delegate — cross-project workspace IDOR
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/delegate rejects cross-project workspace', () => {
    it('returns 404 when the caller workspace belongs to a different project', async () => {
      const task = {
        id: 'task-1',
        projectId: 'project-A',
        userId: 'owner-user',
        status: 'ready',
      };
      const workspaceInProjectB = {
        id: 'ws-in-B',
        userId: 'caller-user',
        projectId: 'project-B',
        status: 'running',
      };
      // task lookup, blocked deps (getTaskDependencies), blocked deps (dependency tasks)
      const db = buildDb([[task], [], []]);
      vi.mocked(drizzle).mockReturnValue(db as never);
      mocks.requireOwnedWorkspace.mockResolvedValue(workspaceInProjectB);

      const response = await createCrudApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-1/delegate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws-in-B' }),
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Finding 3: POST /:taskId/status — cross-tenant cleanup scoping
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/status terminal cleanup is caller-scoped', () => {
    it('passes requiredUserId to cleanupTerminalTaskResourcesOrThrow on cancellation', async () => {
      const task = {
        id: 'task-owned-by-other',
        projectId: 'project-A',
        userId: 'task-owner',
        status: 'in_progress',
        title: 'Other user task',
        workspaceId: 'ws-owner',
        errorMessage: null,
        triggerExecutionId: null,
      };
      const updatedTask = { ...task, status: 'cancelled', errorMessage: null };
      // select chain: task lookup, blocked deps, setTaskStatus re-read,
      // computeBlockedForTask final, toDisplayTaskResponse profile hint
      const db = buildDb([[task], [], [updatedTask], [], []]);
      vi.mocked(drizzle).mockReturnValue(db as never);

      const response = await createCrudApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-owned-by-other/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toStatus: 'cancelled' }),
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(200);
      expect(mocks.cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalledWith(
        mockEnv,
        'task-owned-by-other',
        expect.objectContaining({
          status: 'cancelled',
          requiredUserId: 'caller-user',
          projectId: 'project-A',
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Finding 6: Cross-owner dependency blocking
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/delegate rejects cross-project task', () => {
    it('returns 404 when the task belongs to a different project', async () => {
      const crossProjectTask = {
        id: 'task-in-victim-project',
        projectId: 'project-VICTIM',
        userId: 'other-user',
        status: 'ready',
      };
      const db = buildDb([[crossProjectTask]]);
      vi.mocked(drizzle).mockReturnValue(db as never);

      const response = await createCrudApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-in-victim-project/delegate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws-1' }),
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(404);
      expect(mocks.requireOwnedWorkspace).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Finding 1: POST /:taskId/close — cross-project IDOR
  // ───────────────────────────────────────────────────────────────────────────
  describe('POST /:taskId/close rejects cross-project tasks', () => {
    it('returns 404 when the task belongs to a different project than the route', async () => {
      const crossProjectTask = {
        id: 'task-cross',
        projectId: 'project-VICTIM',
        userId: 'victim-user',
        status: 'in_progress',
        taskMode: 'conversation',
        workspaceId: 'ws-victim',
      };
      const db = buildDb([[crossProjectTask]]);
      vi.mocked(drizzle).mockReturnValue(db as never);

      const response = await createCrudApp().fetch(
        new Request('https://api.test/api/projects/project-A/tasks/task-cross/close', {
          method: 'POST',
        }),
        mockEnv,
        mockCtx,
      );

      expect(response.status).toBe(404);
      expect(mocks.cleanupWorkspaceForDeletion).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
