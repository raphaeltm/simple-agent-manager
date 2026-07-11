import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';
import * as projectDataService from '../../../src/services/project-data';

const mocks = vi.hoisted(() => {
  const task = {
    id: 'task-recoverable',
    projectId: 'proj-recoverable',
    userId: 'user-1',
    workspaceId: 'ws-recoverable',
    status: 'running',
    title: 'Recoverable prompt error',
    taskMode: 'conversation',
    executionStep: 'running',
    errorMessage: null as string | null,
    outputBranch: null as string | null,
    outputPrUrl: null as string | null,
    finalizedAt: null as string | null,
  };
  return {
    task,
    updateSets: [] as Array<Record<string, unknown>>,
    waitUntilPromises: [] as Promise<unknown>[],
  };
});

const MOCK_DATABASE_BINDING = {
  prepare: vi.fn(),
  batch: vi.fn(),
};

const MOCK_PROJECT_DATA_BINDING = {
  idFromName: vi.fn((projectId: string) => projectId),
  get: vi.fn(),
};

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: (selection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (selection && 'chatSessionId' in selection) {
              return Promise.resolve([{ chatSessionId: 'chat-recoverable' }]);
            }
            return Promise.resolve([{ ...mocks.task }]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateSets.push(values);
        Object.assign(mocks.task, values);
        return {
          where: () => Promise.resolve(),
        };
      },
    }),
  }),
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-recoverable', type: 'callback', scope: 'workspace' }),
}));

vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
  stopSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResourcesOrThrow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/notification', () => ({
  getProjectName: vi.fn().mockResolvedValue('Recoverable Project'),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  notifyTaskFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-status', () => ({
  canTransitionTaskStatus: vi.fn().mockReturnValue(true),
  getAllowedTaskTransitions: vi.fn().mockReturnValue(['completed', 'failed', 'cancelled']),
  isTaskStatus: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/routes/tasks/_helpers', () => ({
  computeBlockedForTask: vi.fn().mockResolvedValue(false),
  setTaskStatus: vi.fn(async (_db, task, toStatus, _source, _workspace, options) => ({
    ...task,
    status: toStatus,
    errorMessage: options?.errorMessage ?? null,
  })),
}));

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

async function postCallback(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    '/api/projects/proj-recoverable/tasks/task-recoverable/status/callback',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    {
      DATABASE: MOCK_DATABASE_BINDING,
      PROJECT_DATA: MOCK_PROJECT_DATA_BINDING,
    },
    {
      waitUntil: (promise: Promise<unknown>) => {
        mocks.waitUntilPromises.push(promise);
      },
    }
  );
}

async function flushWaitUntil(): Promise<void> {
  await Promise.all(mocks.waitUntilPromises);
}

async function expectOk(res: Response): Promise<void> {
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`expected 200, got ${res.status}: ${body}`);
  }
}

describe('task callback recoverable errors', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.task.status = 'running';
    mocks.task.taskMode = 'conversation';
    mocks.task.executionStep = 'running';
    mocks.task.errorMessage = null;
    mocks.updateSets.length = 0;
    mocks.waitUntilPromises.length = 0;
    app = await createTestApp();
  });

  it('persists recoverable execution-step errors without stopping the chat session', async () => {
    const res = await postCallback(app, {
      executionStep: 'awaiting_followup',
      errorMessage: 'Provider credits exhausted. Add credits and retry.',
    });

    await expectOk(res);
    expect(mocks.updateSets.at(-1)).toMatchObject({
      executionStep: 'awaiting_followup',
      errorMessage: 'Provider credits exhausted. Add credits and retry.',
    });
    expect(mocks.updateSets.at(-1)).not.toHaveProperty('status');
    expect(mocks.task.status).toBe('running');

    await flushWaitUntil();

    expect(projectDataService.stopSession).not.toHaveBeenCalled();
    expect(projectDataService.recordActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      'proj-recoverable',
      'task.agent_error_recoverable',
      'workspace_callback',
      'ws-recoverable',
      'ws-recoverable',
      'chat-recoverable',
      'task-recoverable',
      expect.objectContaining({
        executionStep: 'awaiting_followup',
        errorMessage: 'Provider credits exhausted. Add credits and retry.',
      })
    );
  });

  it('clears stale recoverable error messages on later execution-step callbacks', async () => {
    mocks.task.errorMessage = 'previous recoverable error';

    const res = await postCallback(app, {
      executionStep: 'awaiting_followup',
    });

    await expectOk(res);
    expect(mocks.updateSets.at(-1)).toMatchObject({
      executionStep: 'awaiting_followup',
      errorMessage: null,
    });

    await flushWaitUntil();

    expect(projectDataService.stopSession).not.toHaveBeenCalled();
    expect(projectDataService.recordActivityEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'task.agent_error_recoverable',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('schedules terminal cleanup for failed callbacks', async () => {
    const { cleanupTerminalTaskResourcesOrThrow } =
      await import('../../../src/services/task-terminal-cleanup');

    const res = await postCallback(app, {
      toStatus: 'failed',
      reason: 'Agent prompt failed',
      errorMessage: 'fatal error',
    });

    await expectOk(res);

    await flushWaitUntil();

    expect(cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalledWith(
      expect.anything(),
      'task-recoverable',
      {
        status: 'failed',
        errorMessage: 'fatal error',
        projectId: 'proj-recoverable',
        failureLogEvent: 'task.callback_terminal_cleanup_failed',
        logContext: { projectId: 'proj-recoverable', source: 'task.callback' },
      }
    );
    expect(projectDataService.stopSession).not.toHaveBeenCalled();
  });

  it('accepts a repeated same-terminal callback and reruns idempotent cleanup', async () => {
    const { cleanupTerminalTaskResourcesOrThrow } =
      await import('../../../src/services/task-terminal-cleanup');
    const { setTaskStatus } = await import('../../../src/routes/tasks/_helpers');
    mocks.task.status = 'failed';
    mocks.task.errorMessage = 'fatal error';

    const res = await postCallback(app, {
      toStatus: 'failed',
      reason: 'duplicate delivery',
      errorMessage: 'fatal error',
    });

    await expectOk(res);
    expect(cleanupTerminalTaskResourcesOrThrow).toHaveBeenCalledWith(
      expect.anything(),
      'task-recoverable',
      {
        status: 'failed',
        errorMessage: 'fatal error',
        projectId: 'proj-recoverable',
        failureLogEvent: 'task.callback_terminal_cleanup_failed',
        logContext: { projectId: 'proj-recoverable', source: 'task.callback.idempotent' },
      }
    );
    // Idempotency invariant: the already-terminal row is NOT written again.
    expect(setTaskStatus).not.toHaveBeenCalled();
  });
});
