import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';

const mocks = vi.hoisted(() => ({
  advanceWorkspaceReady: vi.fn(),
  verifyCallbackToken: vi.fn(),
  preparedSql: [] as string[],
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: mocks.verifyCallbackToken,
}));
vi.mock('../../../src/services/task-runner-do', () => ({
  advanceTaskRunnerWorkspaceReady: mocks.advanceWorkspaceReady,
}));
vi.mock('../../../src/services/workspace-deletion-callback-signal', () => ({
  signalWorkspaceDeletionUnconfirmedCallback: vi.fn(),
}));

const activeWorkspace = {
  workspaceId: 'ws-race',
  userId: 'user-1',
  projectId: 'project-1',
  chatSessionId: 'session-1',
  status: 'creating',
  nodeId: 'node-1',
  nodeStatus: 'running',
};

function makeDb(workspaceReads: Array<Record<string, unknown>>) {
  return {
    select: vi.fn(() => {
      const builder = {
        from: vi.fn(() => builder),
        leftJoin: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => [
          workspaceReads.shift() ?? { ...activeWorkspace, status: 'stopping' },
        ]),
      };
      return builder;
    }),
  };
}

function makeEnv() {
  const database = {
    prepare: vi.fn((sql: string) => {
      mocks.preparedSql.push(sql);
      return {
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      };
    }),
  } as unknown as D1Database;
  return { DATABASE: database } as Env;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 410);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/workspaces', lifecycleRoutes);
  return app;
}

describe('workspace lifecycle callback deletion races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preparedSql.length = 0;
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-race',
      type: 'callback',
      scope: 'workspace',
    });
  });

  it.each([
    ['/workspaces/ws-race/ready', { status: 'running' }],
    ['/workspaces/ws-race/provisioning-failed', { errorMessage: 'failed' }],
  ])('lets deletion win %s without notifying TaskRunner', async (path, body) => {
    vi.mocked(drizzle).mockReturnValue(
      makeDb([activeWorkspace, { ...activeWorkspace, status: 'stopping' }]) as never
    );

    const response = await makeApp().request(
      path,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      makeEnv()
    );

    expect(response.status).toBe(410);
    expect(mocks.advanceWorkspaceReady).not.toHaveBeenCalled();
    expect(mocks.preparedSql[0]).toContain('AND user_id = ?');
    expect(mocks.preparedSql[0]).toContain('AND project_id IS ?');
    expect(mocks.preparedSql[0]).toContain('AND chat_session_id IS ?');
    expect(mocks.preparedSql[0]).toContain('AND node_id IS ?');
    expect(mocks.preparedSql[0]).toContain('AND status = ?');
    expect(mocks.preparedSql[0]).toContain('AND nodes.status = ?');
  });
});
