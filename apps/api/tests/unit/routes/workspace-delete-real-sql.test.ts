import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/workspaces/crud';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  claimWorkspaceDeletionAttempt: vi.fn(),
  confirmWorkspaceDeletion: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  signNodeManagementToken: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getAuth: () => ({ user: { id: 'user-delete-route' } }),
  getUserId: () => 'user-delete-route',
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
vi.mock('../../../src/services/jwt', () => ({
  signCallbackToken: vi.fn(),
  signNodeCallbackToken: vi.fn(),
  signNodeManagementToken: (...args: unknown[]) => mocks.signNodeManagementToken(...args),
  signPortAccessToken: vi.fn(),
  signTerminalToken: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

const USER_ID = 'user-delete-route';
const NODE_ID = 'node-delete-route';
const WORKSPACE_ID = 'workspace-delete-route';

describe('DELETE /api/workspaces/:id deletion outcomes — real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function workspaceStatus(): string | null {
    const row = sqlite.prepare('SELECT status FROM workspaces WHERE id = ?').get(WORKSPACE_ID) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  function setWorkspaceStatus(status: string): void {
    sqlite.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, WORKSPACE_ID);
  }

  async function requestDelete(): Promise<Response> {
    return app.fetch(
      new Request(`https://api.test/api/workspaces/${WORKSPACE_ID}`, {
        method: 'DELETE',
      }),
      env
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare("INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')")
      .run(USER_ID, 'delete-route@example.test');
    sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, name, status, health_status, node_role, node_class, runtime,
            provider_instance_id, runtime_incarnation_id)
         VALUES (?, ?, ?, 'running', 'healthy', 'workspace', 'managed', 'vm', ?, ?)`
      )
      .run(NODE_ID, USER_ID, 'Delete route node', 'provider-delete-route', 'runtime-delete-route');
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, node_id, user_id, name, repository, branch, status, vm_size, vm_location)
         VALUES (?, ?, ?, ?, ?, ?, 'stopped', 'small', 'nbg1')`
      )
      .run(WORKSPACE_ID, NODE_ID, USER_ID, 'Delete route workspace', 'example/repository', 'main');

    mocks.claimWorkspaceDeletionAttempt.mockResolvedValue('claimed');
    mocks.confirmWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(true);
    mocks.signNodeManagementToken.mockResolvedValue({ token: 'signed-test-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );

    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
      NODE_AGENT_REQUEST_TIMEOUT_MS: '5',
      NODE_LIFECYCLE: {
        idFromName: (name: string) => name,
        get: () => ({
          claimWorkspaceDeletionAttempt: mocks.claimWorkspaceDeletionAttempt,
          confirmWorkspaceDeletion: mocks.confirmWorkspaceDeletion,
          scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
        }),
      } as unknown as DurableObjectNamespace,
    } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((error, context) =>
      error instanceof AppError
        ? context.json(error.toJSON(), error.statusCode as never)
        : context.json({ error: 'INTERNAL_ERROR', message: error.message }, 500)
    );
    app.route('/api/workspaces', crudRoutes);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it('returns 409 without changing D1 or calling the VM when the durable claim is fenced', async () => {
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValueOnce('fenced');

    const response = await requestDelete();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      deletionStatus: 'rejected',
      workspaceStatus: 'unchanged',
      reason: 'workspace_active',
    });
    expect(workspaceStatus()).toBe('stopped');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
  });

  it('returns 202 for an identical deletion attempt that is already durably in flight', async () => {
    setWorkspaceStatus('stopping');
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValueOnce('already_claimed_same_identity');

    const response = await requestDelete();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deletionStatus: 'pending',
      workspaceStatus: 'stopping',
      reason: 'runtime_deletion_unconfirmed',
    });
    expect(workspaceStatus()).toBe('stopping');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 202, persists stopping, and retains retry when the real VM request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const abort = () => {
              const error = new Error('aborted test request');
              error.name = 'AbortError';
              reject(error);
            };
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          })
      )
    );

    const response = await requestDelete();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deletionStatus: 'pending',
      workspaceStatus: 'stopping',
      reason: 'runtime_deletion_unconfirmed',
    });
    expect(workspaceStatus()).toBe('stopping');
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledOnce();
    expect(mocks.confirmWorkspaceDeletion).not.toHaveBeenCalled();
  });

  it('returns 409 with full identity telemetry when node incarnation changes at the VM boundary', async () => {
    mocks.signNodeManagementToken.mockImplementationOnce(async () => {
      sqlite
        .prepare(
          'UPDATE nodes SET provider_instance_id = ?, runtime_incarnation_id = ? WHERE id = ?'
        )
        .run('provider-delete-route-new', 'runtime-delete-route-new', NODE_ID);
      return { token: 'signed-test-token' };
    });

    const response = await requestDelete();

    expect(response.status).toBe(409);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith('workspace_deletion.identity_fenced', {
      expectedWorkspaceId: WORKSPACE_ID,
      currentWorkspaceId: WORKSPACE_ID,
      expectedUserId: USER_ID,
      currentUserId: USER_ID,
      expectedProjectId: null,
      currentProjectId: null,
      expectedChatSessionId: null,
      currentChatSessionId: null,
      expectedNodeId: NODE_ID,
      currentNodeId: NODE_ID,
      expectedNodeUserId: USER_ID,
      currentNodeUserId: USER_ID,
      expectedNodeRuntime: 'vm',
      currentNodeRuntime: 'vm',
      expectedNodeProviderInstanceId: 'provider-delete-route',
      currentNodeProviderInstanceId: 'provider-delete-route-new',
      expectedNodeRuntimeIncarnationId: 'runtime-delete-route',
      currentNodeRuntimeIncarnationId: 'runtime-delete-route-new',
      currentStatus: 'stopping',
      reason: 'workspace_assignment_changed',
      source: 'explicit',
      phase: 'vm_request_boundary',
      action: 'rejected',
    });
  });

  it('returns 202 when VM proof exists but a concurrent status write defers finalization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        setWorkspaceStatus('stopped');
        return new Response(null, { status: 204 });
      })
    );

    const response = await requestDelete();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deletionStatus: 'pending',
      workspaceStatus: 'stopping',
      reason: 'runtime_deletion_finalization_pending',
    });
    expect(workspaceStatus()).toBe('stopping');
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledOnce();
    expect(mocks.confirmWorkspaceDeletion).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'workspace_deletion.confirmed_finalization_deferred',
      expect.objectContaining({
        expectedWorkspaceId: WORKSPACE_ID,
        currentWorkspaceId: WORKSPACE_ID,
        expectedUserId: USER_ID,
        currentUserId: USER_ID,
        expectedNodeId: NODE_ID,
        currentNodeId: NODE_ID,
        expectedNodeProviderInstanceId: 'provider-delete-route',
        currentNodeProviderInstanceId: 'provider-delete-route',
        expectedNodeRuntimeIncarnationId: 'runtime-delete-route',
        currentNodeRuntimeIncarnationId: 'runtime-delete-route',
        currentStatus: 'stopped',
        action: 'durable_attempt_retained',
      })
    );
  });

  it('returns 200 and removes the row only after VM confirmation and lifecycle finalization', async () => {
    const response = await requestDelete();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deletionStatus: 'confirmed',
    });
    expect(workspaceStatus()).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(mocks.confirmWorkspaceDeletion).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
  });
});
