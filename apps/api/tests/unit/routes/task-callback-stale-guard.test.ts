import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

// S2: a superseded (dead) Instant container can POST a stale `toStatus:'failed'`
// callback with a still-valid token AFTER the DO recovered a NEW generation to
// running. The guard must reject that (protect the healthy task) while still
// failing the task for a genuine crash of the CURRENT container.

const mocks = vi.hoisted(() => {
  const task = {
    id: 'task-stale',
    projectId: 'proj-stale',
    userId: 'user-1',
    parentTaskId: null as string | null,
    workspaceId: 'ws-stale',
    status: 'in_progress',
    title: 'Instant task',
    description: null as string | null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    executionStep: 'running',
    errorMessage: null as string | null,
    outputSummary: null as string | null,
    outputBranch: null as string | null,
    outputPrUrl: null as string | null,
    startedAt: null as string | null,
    completedAt: null as string | null,
    finalizedAt: null as string | null,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
  return {
    task,
    // Row returned to the guard's agent_sessions⋈workspaces⋈nodes read.
    guardRow: { updatedAt: null as string | null, runtime: 'cf-container' as string | null },
    updateSets: [] as Array<Record<string, unknown>>,
    setTaskStatus: vi.fn(),
    computeBlockedForTask: vi.fn(),
    cleanupTerminalTaskResourcesOrThrow: vi.fn(),
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    waitUntilPromises: [] as Promise<unknown>[],
  };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: (selection?: Record<string, unknown>) => {
      const rows = () => {
        if (selection && 'updatedAt' in selection) return [{ ...mocks.guardRow }];
        if (selection && 'chatSessionId' in selection) return [{ chatSessionId: 'chat-stale' }];
        return [{ ...mocks.task }];
      };
      const afterOrderBy = { limit: () => Promise.resolve(rows()) };
      const terminal = {
        limit: () => Promise.resolve(rows()),
        orderBy: () => afterOrderBy,
      };
      const joinable: { leftJoin: () => typeof joinable; where: () => typeof terminal } = {
        leftJoin: () => joinable,
        where: () => terminal,
      };
      return { from: () => joinable };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateSets.push(values);
        Object.assign(mocks.task, values);
        return { where: () => Promise.resolve() };
      },
    }),
  }),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-stale', type: 'callback', scope: 'workspace' }),
}));

vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResourcesOrThrow: mocks.cleanupTerminalTaskResourcesOrThrow,
}));

vi.mock('../../../src/services/notification', () => ({
  getProjectName: vi.fn().mockResolvedValue('Stale Project'),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  notifyTaskFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-status', () => ({
  canTransitionTaskStatus: vi.fn().mockReturnValue(true),
  getAllowedTaskTransitions: vi.fn().mockReturnValue(['completed', 'failed', 'cancelled']),
  isTaskStatus: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/routes/tasks/_helpers', () => ({
  computeBlockedForTask: mocks.computeBlockedForTask.mockResolvedValue(false),
  setTaskStatus: mocks.setTaskStatus.mockImplementation(
    async (_db, task, toStatus, _source, _workspace, options) => ({
      ...task,
      status: toStatus,
      errorMessage: options?.errorMessage ?? null,
    })
  ),
}));

const TOKEN_IAT_SECONDS = 1_700_000_000;
const TOKEN_IAT_MS = TOKEN_IAT_SECONDS * 1000;

function tokenWithIatSeconds(iatSeconds: number): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg({ iat: iatSeconds, workspace: 'ws-stale' })}.sig`;
}

const OLD_TOKEN = tokenWithIatSeconds(TOKEN_IAT_SECONDS);

async function createTestApp(): Promise<Hono> {
  const { taskCallbackRoute } = await import('../../../src/routes/tasks/callback');
  const app = new Hono();
  app.route('/api/projects', taskCallbackRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
    }
    return c.json(
      { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
      500
    );
  });
  return app;
}

async function postFailed(app: Hono, token = OLD_TOKEN): Promise<Response> {
  return app.request(
    '/api/projects/proj-stale/tasks/task-stale/status/callback',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus: 'failed', reason: 'agent error', errorMessage: 'fatal' }),
    },
    { DATABASE: {}, PROJECT_DATA: { idFromName: (id: string) => id, get: vi.fn() } },
    { waitUntil: (p: Promise<unknown>) => mocks.waitUntilPromises.push(p) }
  );
}

describe('task callback stale Instant guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.task.status = 'in_progress';
    mocks.task.errorMessage = null;
    mocks.updateSets.length = 0;
    mocks.waitUntilPromises.length = 0;
    mocks.guardRow = { updatedAt: null, runtime: 'cf-container' };
    mocks.computeBlockedForTask.mockResolvedValue(false);
  });

  it('(a) rejects a stale failed callback after recovery completed — task NOT regressed', async () => {
    // Recovery reconciled the workspace's agent session to running 180s after
    // the OLD container token was issued (≫ 60s margin) ⇒ superseded generation.
    mocks.guardRow = {
      runtime: 'cf-container',
      updatedAt: new Date(TOKEN_IAT_MS + 180_000).toISOString(),
    };
    const app = await createTestApp();

    const res = await postFailed(app);

    expect(res.status).toBe(200);
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).not.toHaveBeenCalled();
    expect(mocks.task.status).toBe('in_progress'); // unchanged
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('in_progress');
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'task.rejected_stale_callback',
      expect.objectContaining({
        projectId: 'proj-stale',
        taskId: 'task-stale',
        workspaceId: 'ws-stale',
        runtime: 'cf-container',
        toStatus: 'failed',
        action: 'rejected_stale_callback',
      })
    );
  });

  it('(b) still fails the task for a genuine crash of the CURRENT container (no recovery)', async () => {
    // Same generation: last reconciled ~at token issuance (gap 0.5s ≪ margin).
    mocks.guardRow = {
      runtime: 'cf-container',
      updatedAt: new Date(TOKEN_IAT_MS + 500).toISOString(),
    };
    const app = await createTestApp();

    const res = await postFailed(app);

    expect(res.status).toBe(200);
    expect(mocks.setTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'task-stale' }),
      'failed',
      'workspace_callback',
      'ws-stale',
      expect.objectContaining({ errorMessage: 'fatal' })
    );
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalledWith(
      'task.rejected_stale_callback',
      expect.anything()
    );
  });

  it('(c) rejects a stale failed callback arriving DURING recovery (row reconciled, not yet running)', async () => {
    mocks.guardRow = {
      runtime: 'cf-container',
      updatedAt: new Date(TOKEN_IAT_MS + 300_000).toISOString(),
    };
    const app = await createTestApp();

    const res = await postFailed(app);

    expect(res.status).toBe(200);
    expect(mocks.setTaskStatus).not.toHaveBeenCalled();
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'task.rejected_stale_callback',
      expect.objectContaining({ action: 'rejected_stale_callback' })
    );
  });

  it('does not engage for VM-runtime nodes even when the row is newer than the token', async () => {
    mocks.guardRow = {
      runtime: 'vm',
      updatedAt: new Date(TOKEN_IAT_MS + 999_000).toISOString(),
    };
    const app = await createTestApp();

    const res = await postFailed(app);

    expect(res.status).toBe(200);
    expect(mocks.setTaskStatus).toHaveBeenCalled();
    expect(mocks.cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalled();
  });
});
