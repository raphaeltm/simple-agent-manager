import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  verifyCallbackToken: vi.fn(),
  notifyTaskRunnerWorkspaceBuildStarted: vi.fn(),
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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

let sqlite: Database.Database;
let env: Env;

function seed(workspaceStatus: string, nodeStatus: string): void {
  sqlite
    .prepare(`INSERT INTO nodes (id, user_id, status) VALUES ('node-1', 'user-1', ?)`)
    .run(nodeStatus);
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, project_id, node_id, status)
       VALUES ('ws-1', 'user-1', 'project-1', 'node-1', ?)`
    )
    .run(workspaceStatus);
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id)
       VALUES ('task-1', 'project-1', 'user-1', 'ws-1')`
    )
    .run();
}

async function createTestApp(): Promise<Hono> {
  const { buildStartedCallbackRoute } =
    await import('../../../src/routes/projects/build-started-callback');
  const app = new Hono();
  app.route('/api/projects', buildStartedCallbackRoute);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 410 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  return app;
}

async function postBuildStarted(app: Hono, workspaceId = 'ws-1'): Promise<Response> {
  return app.request(
    '/api/projects/project-1/tasks/task-1/build-started',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer callback-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    },
    env
  );
}

describe('build-started callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.tasks]);
    env = { DATABASE: createSqliteD1(sqlite), KV: {} } as unknown as Env;
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.notifyTaskRunnerWorkspaceBuildStarted.mockResolvedValue(undefined);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('uses workspace callback JWT auth and notifies the TaskRunner for a creating workspace', async () => {
    seed('creating', 'running');
    const app = await createTestApp();

    const response = await postBuildStarted(app);

    expect(response.status).toBe(204);
    expect(mocks.verifyCallbackToken).toHaveBeenCalledWith('callback-token', env, {
      expectedScope: 'workspace',
    });
    expect(mocks.notifyTaskRunnerWorkspaceBuildStarted).toHaveBeenCalledWith(env, 'task-1', 'ws-1');
  });

  it('rejects a valid callback token for a different workspace', async () => {
    seed('creating', 'running');
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'ws-other',
      type: 'callback',
      scope: 'workspace',
    });
    const app = await createTestApp();

    const response = await postBuildStarted(app);

    expect(response.status).toBe(403);
    expect(mocks.notifyTaskRunnerWorkspaceBuildStarted).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'stopping', 'sleeping', 'deleted', 'error'])(
    'refuses a still-valid token after its workspace became %s',
    async (status) => {
      seed(status, 'running');
      const app = await createTestApp();

      const response = await postBuildStarted(app);

      expect(response.status).toBe(410);
      expect(mocks.notifyTaskRunnerWorkspaceBuildStarted).not.toHaveBeenCalled();
    }
  );

  it.each(['stopping', 'destroyed'])(
    'refuses a creating workspace whose node is %s',
    async (nodeStatus) => {
      seed('creating', nodeStatus);
      const app = await createTestApp();

      const response = await postBuildStarted(app);

      expect(response.status).toBe(410);
      expect(mocks.notifyTaskRunnerWorkspaceBuildStarted).not.toHaveBeenCalled();
    }
  );
});
