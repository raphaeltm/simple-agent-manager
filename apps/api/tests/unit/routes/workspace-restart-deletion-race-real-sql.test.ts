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
  signNodeManagementToken: vi.fn(),
  writeBootLogs: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-restart-race',
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock('../../../src/lib/logger', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/logger')>();
  return {
    ...actual,
    log: { ...actual.log, warn: mocks.logWarn },
  };
});
vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: (...args: unknown[]) => mocks.requireRepositoryOwnerAccess(...args),
}));
vi.mock('../../../src/services/boot-log', () => ({
  writeBootLogs: (...args: unknown[]) => mocks.writeBootLogs(...args),
}));
vi.mock('../../../src/services/compute-usage', () => ({ stopComputeTracking: vi.fn() }));
vi.mock('../../../src/services/jwt', () => ({
  signCallbackToken: vi.fn(),
  signNodeCallbackToken: vi.fn(),
  signNodeManagementToken: (...args: unknown[]) => mocks.signNodeManagementToken(...args),
  verifyCallbackToken: vi.fn(),
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

describe('workspace runtime recreation/deletion races — real SQL', () => {
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

  async function requestLifecycle(action: 'restart' | 'rebuild'): Promise<Response> {
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    return app.fetch(
      new Request(`https://api.test/api/workspaces/${WORKSPACE_ID}/${action}`, {
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
    mocks.signNodeManagementToken.mockResolvedValue({ token: 'signed-test-token' });
    mocks.writeBootLogs.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
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

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it('returns conflict when deletion changes D1 after cancellation but before restart CAS', async () => {
    mocks.cancelWorkspaceDeletion.mockImplementation(async () => {
      sqlite.prepare("UPDATE workspaces SET status = 'stopping' WHERE id = ?").run(WORKSPACE_ID);
      return true;
    });

    const response = await requestLifecycle('restart');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Workspace changed while restart cancellation was being claimed',
    });
    expect(workspaceStatus()).toBe('stopping');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not overwrite stopping when deletion wins at the VM request boundary', async () => {
    let releaseToken: ((value: { token: string }) => void) | undefined;
    let markTokenRequested: (() => void) | undefined;
    const tokenRequested = new Promise<void>((resolve) => {
      markTokenRequested = resolve;
    });
    mocks.signNodeManagementToken.mockImplementation(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseToken = resolve;
          markTokenRequested?.();
        })
    );

    const response = await requestLifecycle('restart');
    await tokenRequested;
    sqlite.prepare("UPDATE workspaces SET status = 'stopping' WHERE id = ?").run(WORKSPACE_ID);
    releaseToken?.({ token: 'signed-test-token' });
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'creating' });
    expect(workspaceStatus()).toBe('stopping');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'workspace_runtime_recreation.identity_fenced',
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        operation: 'restart',
        expectedUserId: USER_ID,
        currentUserId: USER_ID,
        expectedProjectId: PROJECT_ID,
        currentProjectId: PROJECT_ID,
        expectedChatSessionId: CHAT_SESSION_ID,
        currentChatSessionId: CHAT_SESSION_ID,
        expectedNodeId: NODE_ID,
        currentNodeId: NODE_ID,
        expectedStatus: 'creating',
        currentStatus: 'stopping',
        action: 'network_request_refused',
      })
    );
  });

  it('returns conflict when deletion changes D1 after cancellation but before rebuild CAS', async () => {
    sqlite.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(WORKSPACE_ID);
    mocks.cancelWorkspaceDeletion.mockImplementation(async () => {
      sqlite.prepare("UPDATE workspaces SET status = 'stopping' WHERE id = ?").run(WORKSPACE_ID);
      return true;
    });

    const response = await requestLifecycle('rebuild');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Workspace changed while rebuild cancellation was being claimed',
    });
    expect(workspaceStatus()).toBe('stopping');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not overwrite stopping when deletion wins at the rebuild VM request boundary', async () => {
    sqlite.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(WORKSPACE_ID);
    let releaseToken: ((value: { token: string }) => void) | undefined;
    let markTokenRequested: (() => void) | undefined;
    const tokenRequested = new Promise<void>((resolve) => {
      markTokenRequested = resolve;
    });
    mocks.signNodeManagementToken.mockImplementation(
      () =>
        new Promise<{ token: string }>((resolve) => {
          releaseToken = resolve;
          markTokenRequested?.();
        })
    );

    const response = await requestLifecycle('rebuild');
    await tokenRequested;
    sqlite.prepare("UPDATE workspaces SET status = 'stopping' WHERE id = ?").run(WORKSPACE_ID);
    releaseToken?.({ token: 'signed-test-token' });
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'rebuilding' });
    expect(workspaceStatus()).toBe('stopping');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'workspace_runtime_recreation.identity_fenced',
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        operation: 'rebuild',
        expectedUserId: USER_ID,
        currentUserId: USER_ID,
        expectedProjectId: PROJECT_ID,
        currentProjectId: PROJECT_ID,
        expectedChatSessionId: CHAT_SESSION_ID,
        currentChatSessionId: CHAT_SESSION_ID,
        expectedNodeId: NODE_ID,
        currentNodeId: NODE_ID,
        expectedStatus: 'creating',
        currentStatus: 'stopping',
        action: 'network_request_refused',
      })
    );
  });
});
