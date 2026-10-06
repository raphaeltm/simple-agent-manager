import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => ({
  bindingRow: { workspaceId: 'ws-1' } as { workspaceId: string } | null,
  verifyCallbackToken: vi.fn(),
  notifyTaskRunnerWorkspaceBuildStarted: vi.fn(),
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const env = { DATABASE: {} } as never;

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ get: vi.fn().mockResolvedValue(mocks.bindingRow) }),
        }),
      }),
    }),
  }),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: mocks.verifyCallbackToken,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  notifyTaskRunnerWorkspaceBuildStarted: mocks.notifyTaskRunnerWorkspaceBuildStarted,
}));

async function createTestApp(): Promise<Hono> {
  const { buildStartedCallbackRoute } = await import(
    '../../../src/routes/projects/build-started-callback'
  );
  const app = new Hono();
  app.route('/api/projects', buildStartedCallbackRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  return app;
}

describe('build-started callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bindingRow = { workspaceId: 'ws-1' };
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.notifyTaskRunnerWorkspaceBuildStarted.mockResolvedValue(undefined);
  });

  it('uses workspace callback JWT auth and notifies the TaskRunner for the task route path', async () => {
    const app = await createTestApp();

    const response = await app.request(
      '/api/projects/project-1/tasks/task-1/build-started',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1' }),
      },
      env
    );

    expect(response.status).toBe(204);
    expect(mocks.verifyCallbackToken).toHaveBeenCalledWith('callback-token', env, {
      expectedScope: 'workspace',
    });
    expect(mocks.notifyTaskRunnerWorkspaceBuildStarted).toHaveBeenCalledWith(
      env,
      'task-1',
      'ws-1'
    );
  });

  it('rejects a valid callback token for a different workspace', async () => {
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-other',
      type: 'callback',
      scope: 'workspace',
    });
    const app = await createTestApp();

    const response = await app.request(
      '/api/projects/project-1/tasks/task-1/build-started',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws-1' }),
      },
      env
    );

    expect(response.status).toBe(403);
    expect(mocks.notifyTaskRunnerWorkspaceBuildStarted).not.toHaveBeenCalled();
  });
});
