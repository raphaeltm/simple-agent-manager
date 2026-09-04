import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cancelWorkspaceDeletion: vi.fn(),
  recordActivityEvent: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  restartWorkspaceOnNode: vi.fn(),
  writeBootLogs: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-restart-race',
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: (...args: unknown[]) => mocks.requireRepositoryOwnerAccess(...args),
}));
vi.mock('../../../src/services/boot-log', () => ({
  writeBootLogs: (...args: unknown[]) => mocks.writeBootLogs(...args),
}));
vi.mock('../../../src/services/compute-usage', () => ({ stopComputeTracking: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({
  rebuildWorkspaceOnNode: vi.fn(),
  restartWorkspaceOnNode: (...args: unknown[]) => mocks.restartWorkspaceOnNode(...args),
  stopWorkspaceOnNode: vi.fn(),
}));
vi.mock('../../../src/services/nodes', () => ({ stopNodeResources: vi.fn() }));
vi.mock('../../../src/services/project-data', () => ({
  recordActivityEvent: (...args: unknown[]) => mocks.recordActivityEvent(...args),
}));
vi.mock('../../../src/services/session-sleep', () => ({ sleepWorkspaceSession: vi.fn() }));
vi.mock('../../../src/services/session-snapshots', () => ({
  deleteSessionSnapshotState: vi.fn(),
}));

const USER_ID = 'user-restart-race';
const PROJECT_ID = 'project-restart-race';
const NODE_ID = 'node-restart-race';
const WORKSPACE_ID = 'workspace-restart-race';
const CHAT_SESSION_ID = 'chat-restart-race';

describe('POST /api/workspaces/:id/restart deletion races — real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let waitUntilPromises: Promise<unknown>[];

  function workspaceStatus(): string {
    return (
      sqlite.prepare('SELECT status FROM workspaces WHERE id = ?').get(WORKSPACE_ID) as {
        status: string;
      }
    ).status;
  }

  async function requestRestart(): Promise<Response> {
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    return app.fetch(
      new Request(`https://api.test/api/workspaces/${WORKSPACE_ID}/restart`, {
        method: 'POST',
      }),
      env,
      executionContext
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    waitUntilPromises = [];
    sqlite
      .prepare("INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')")
      .run(USER_ID, 'restart-race@example.test');
    sqlite
      .prepare("INSERT INTO projects (id, user_id, name, repo_provider) VALUES (?, ?, ?, 'github')")
      .run(PROJECT_ID, USER_ID, 'Restart race project');
    sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, name, status, health_status, node_role, node_class, runtime)
         VALUES (?, ?, ?, 'running', 'healthy', 'workspace', 'managed', 'vm')`
      )
      .run(NODE_ID, USER_ID, 'Restart race node');
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, user_id, project_id, chat_session_id, name, repository, branch,
            status, vm_size, vm_location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', 'small', 'nbg1')`
      )
      .run(
        WORKSPACE_ID,
        NODE_ID,
        USER_ID,
        PROJECT_ID,
        CHAT_SESSION_ID,
        'Restart race workspace',
        'example/repository',
        'main'
      );

    mocks.cancelWorkspaceDeletion.mockResolvedValue(true);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.restartWorkspaceOnNode.mockResolvedValue(undefined);
    mocks.writeBootLogs.mockResolvedValue(undefined);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: {} as KVNamespace,
      NODE_LIFECYCLE: {
        idFromName: (name: string) => name,
        get: () => ({ cancelWorkspaceDeletion: mocks.cancelWorkspaceDeletion }),
      } as unknown as DurableObjectNamespace,
    } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/workspaces', lifecycleRoutes);
  });

  afterEach(() => sqlite.close());

  it('returns conflict when deletion changes D1 after cancellation but before restart CAS', async () => {
    mocks.cancelWorkspaceDeletion.mockImplementation(async () => {
      sqlite.prepare("UPDATE workspaces SET status = 'stopping' WHERE id = ?").run(WORKSPACE_ID);
      return true;
    });

    const response = await requestRestart();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Workspace changed while restart cancellation was being claimed',
    });
    expect(workspaceStatus()).toBe('stopping');
    expect(mocks.restartWorkspaceOnNode).not.toHaveBeenCalled();
  });

  it('does not overwrite stopping when deletion wins at the VM request boundary', async () => {
    mocks.restartWorkspaceOnNode.mockImplementation(
      async (
        _nodeId: string,
        _workspaceId: string,
        _env: Env,
        _userId: string,
        options: { beforeExternalMutation: () => Promise<void> }
      ) => {
        sqlite.prepare("UPDATE workspaces SET status = 'stopping' WHERE id = ?").run(WORKSPACE_ID);
        await options.beforeExternalMutation();
      }
    );

    const response = await requestRestart();
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'creating' });
    expect(workspaceStatus()).toBe('stopping');
    expect(mocks.restartWorkspaceOnNode).toHaveBeenCalledOnce();
  });
});
