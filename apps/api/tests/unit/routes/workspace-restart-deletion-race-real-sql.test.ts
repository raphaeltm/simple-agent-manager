import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { stopWorkspaceOnNode } from '../../../src/services/node-agent';
import {
  finalizeWorkspaceEvictionInNode,
  type WorkspaceEvictionIdentity,
} from '../../../src/services/workspace-eviction-lifecycle';
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
        get: () => ({
          cancelWorkspaceDeletion: mocks.cancelWorkspaceDeletion,
          finalizeWorkspaceEviction: (identity: WorkspaceEvictionIdentity) =>
            finalizeWorkspaceEvictionInNode(env, identity),
        }),
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

  function prepareEvictedRestart() {
    sqlite
      .prepare(
        `UPDATE workspaces SET status = 'evicted', eviction_generation = 'old-generation',
      eviction_finalized_at = '2026-09-13T00:00:00.000Z', resolved_reservation_json = ? WHERE id = ?`
      )
      .run(
        JSON.stringify({
          version: 1,
          cpuMillis: 1000,
          memoryMb: 1024,
          diskMb: 1024,
          maxCoTenants: 4,
          exclusiveNode: false,
          source: 'platform',
          sourceId: 'platform',
        }),
        WORKSPACE_ID
      );
    sqlite
      .prepare(
        `UPDATE nodes SET provider_instance_id = 'vm-1', credential_source = 'user',
      observed_hardware_source = 'observed', observed_provider_instance_vcpu_count = 2,
      observed_provider_instance_memory_mb = 4096, observed_provider_instance_disk_gb = 80,
      last_heartbeat_at = ?, last_metrics = ? WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        JSON.stringify({ version: 1, cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
        NODE_ID
      );
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
      VALUES (?, ?, 'owner', 'active')`
      )
      .run(PROJECT_ID, USER_ID);
  }

  it('snapshots the current generation for an internal VM Stop before a delayed network request', async () => {
    sqlite
      .prepare("UPDATE workspaces SET eviction_generation = 'observed-generation' WHERE id = ?")
      .run(WORKSPACE_ID);
    mocks.signNodeManagementToken.mockImplementationOnce(async () => {
      sqlite
        .prepare("UPDATE workspaces SET eviction_generation = 'successor-generation' WHERE id = ?")
        .run(WORKSPACE_ID);
      return { token: 'signed-test-token' };
    });
    await stopWorkspaceOnNode(NODE_ID, WORKSPACE_ID, env, USER_ID);
    expect(JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body as string)).toEqual({
      expectedEvictionGeneration: 'observed-generation',
    });
  });

  it('preserves an explicit Stop claim generation instead of refreshing it from a successor', async () => {
    sqlite
      .prepare("UPDATE workspaces SET eviction_generation = 'successor-generation' WHERE id = ?")
      .run(WORKSPACE_ID);
    await stopWorkspaceOnNode(NODE_ID, WORKSPACE_ID, env, USER_ID, {
      expectedEvictionGeneration: 'claimed-generation',
    });
    expect(JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body as string)).toEqual({
      expectedEvictionGeneration: 'claimed-generation',
    });
  });

  it('refuses an internal Stop after workspace attachment identity changes', async () => {
    sqlite.prepare('UPDATE workspaces SET node_id = NULL WHERE id = ?').run(WORKSPACE_ID);
    await expect(stopWorkspaceOnNode(NODE_ID, WORKSPACE_ID, env, USER_ID)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('restarts an evicted workspace with a fresh reservation, metering row and exact generation pair', async () => {
    prepareEvictedRestart();
    sqlite
      .prepare('UPDATE workspaces SET stop_runtime_confirmed_at = ? WHERE id = ?')
      .run('2026-09-01T00:00:00.000Z', WORKSPACE_ID);
    const response = await requestLifecycle('restart');
    expect(response.status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect(workspaceStatus()).toBe('creating');
    const row = sqlite
      .prepare('SELECT eviction_generation, eviction_finalized_at FROM workspaces WHERE id = ?')
      .get(WORKSPACE_ID) as { eviction_generation: string };
    expect(row).toEqual({
      eviction_generation: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      eviction_finalized_at: null,
    });
    expect(
      sqlite
        .prepare('SELECT stop_runtime_confirmed_at FROM workspaces WHERE id = ?')
        .get(WORKSPACE_ID)
    ).toEqual({ stop_runtime_confirmed_at: null });
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(JSON.parse(request?.body as string)).toEqual({
      evictionGeneration: row.eviction_generation,
      expectedEvictionGeneration: 'old-generation',
    });
    expect(sqlite.prepare('SELECT workspace_id, ended_at FROM compute_usage').all()).toEqual([
      { workspace_id: WORKSPACE_ID, ended_at: null },
    ]);
  });

  it('refuses eviction restart after another placement consumes the available node memory', async () => {
    prepareEvictedRestart();
    mocks.cancelWorkspaceDeletion.mockImplementation(async () => {
      sqlite
        .prepare('UPDATE nodes SET observed_provider_instance_memory_mb = 1024 WHERE id = ?')
        .run(NODE_ID);
      return true;
    });
    expect((await requestLifecycle('restart')).status).toBe(409);
    expect(workspaceStatus()).toBe('evicted');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT id FROM compute_usage').all()).toEqual([]);
  });

  it('closes evicted restart metering when runtime start fails before dispatch', async () => {
    prepareEvictedRestart();
    mocks.signNodeManagementToken.mockRejectedValueOnce(new Error('token signing failed'));

    const response = await requestLifecycle('restart');
    expect(response.status).toBe(200);
    await Promise.all(waitUntilPromises);

    expect(workspaceStatus()).toBe('evicted');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT ended_at FROM compute_usage').all()).toEqual([
      { ended_at: expect.any(String) },
    ]);
    expect(
      sqlite.prepare('SELECT eviction_generation FROM workspaces WHERE id = ?').get(WORKSPACE_ID)
    ).toEqual({ eviction_generation: 'old-generation' });

    expect((await requestLifecycle('restart')).status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect(sqlite.prepare('SELECT ended_at FROM compute_usage ORDER BY rowid').all()).toEqual([
      { ended_at: expect.any(String) },
      { ended_at: null },
    ]);
    expect(
      JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body as string)
    ).toMatchObject({ expectedEvictionGeneration: 'old-generation' });
  });

  it('restores the eviction when boot-log setup fails before metering and dispatch', async () => {
    prepareEvictedRestart();
    mocks.writeBootLogs.mockRejectedValueOnce(new Error('KV unavailable'));
    expect((await requestLifecycle('restart')).status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect(workspaceStatus()).toBe('evicted');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT id FROM compute_usage').all()).toEqual([]);
  });

  it('fails closed when compute tracking cannot start', async () => {
    prepareEvictedRestart();
    sqlite.exec(`CREATE TRIGGER reject_usage BEFORE INSERT ON compute_usage
      BEGIN SELECT RAISE(ABORT, 'metering unavailable'); END`);
    expect((await requestLifecycle('restart')).status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect(workspaceStatus()).toBe('evicted');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT id FROM compute_usage').all()).toEqual([]);
  });

  it('rechecks admission after an evicted restart fails before dispatch', async () => {
    prepareEvictedRestart();
    mocks.signNodeManagementToken.mockRejectedValueOnce(new Error('token signing failed'));
    expect((await requestLifecycle('restart')).status).toBe(200);
    await Promise.all(waitUntilPromises);
    sqlite
      .prepare('UPDATE nodes SET observed_provider_instance_memory_mb = 1024 WHERE id = ?')
      .run(NODE_ID);
    expect((await requestLifecycle('restart')).status).toBe(409);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT ended_at FROM compute_usage').all()).toEqual([
      { ended_at: expect.any(String) },
    ]);
  });

  it('does not close successor metering when an older restart loses its lifecycle fence', async () => {
    prepareEvictedRestart();
    mocks.signNodeManagementToken.mockImplementationOnce(async () => {
      sqlite
        .prepare(
          "UPDATE workspaces SET status = 'running', eviction_generation = 'successor' WHERE id = ?"
        )
        .run(WORKSPACE_ID);
      sqlite
        .prepare(
          `INSERT INTO compute_usage (id, user_id, workspace_id, node_id, server_type, vcpu_count, started_at, created_at)
        VALUES ('successor-usage', ?, ?, ?, 'small', 2, ?, ?)`
        )
        .run(USER_ID, WORKSPACE_ID, NODE_ID, new Date().toISOString(), new Date().toISOString());
      return { token: 'signed-test-token' };
    });
    expect((await requestLifecycle('restart')).status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect(workspaceStatus()).toBe('running');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT ended_at FROM compute_usage ORDER BY rowid').all()).toEqual([
      { ended_at: expect.any(String) },
      { ended_at: null },
    ]);
  });

  it('preserves metering and the new generation when runtime dispatch has an ambiguous failure', async () => {
    prepareEvictedRestart();
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('connection reset after request sent'));
    expect((await requestLifecycle('restart')).status).toBe(200);
    await Promise.all(waitUntilPromises);
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(workspaceStatus()).toBe('creating');
    expect((await requestLifecycle('restart')).status).toBe(400);
    expect(sqlite.prepare('SELECT ended_at FROM compute_usage').all()).toEqual([
      { ended_at: null },
    ]);
    expect(
      sqlite.prepare('SELECT eviction_generation FROM workspaces WHERE id = ?').get(WORKSPACE_ID)
    ).not.toEqual({ eviction_generation: 'old-generation' });
  });

  it.each(['restart', 'rebuild'] as const)(
    'clears earlier Stop proof when %s creates a new runtime generation',
    async (action) => {
      sqlite
        .prepare(
          `UPDATE workspaces SET status = 'error', eviction_generation = 'old-generation',
      stop_runtime_confirmed_at = '2026-09-01T00:00:00.000Z' WHERE id = ?`
        )
        .run(WORKSPACE_ID);
      expect((await requestLifecycle(action)).status).toBe(action === 'rebuild' ? 202 : 200);
      await Promise.all(waitUntilPromises);
      expect(
        sqlite
          .prepare('SELECT stop_runtime_confirmed_at FROM workspaces WHERE id = ?')
          .get(WORKSPACE_ID)
      ).toEqual({ stop_runtime_confirmed_at: null });
    }
  );

  it('refuses platform eviction restart when its user quota is exhausted', async () => {
    prepareEvictedRestart();
    sqlite.prepare("UPDATE nodes SET credential_source = 'platform' WHERE id = ?").run(NODE_ID);
    sqlite
      .prepare('INSERT INTO user_quotas (id, user_id, monthly_vcpu_hours_limit) VALUES (?, ?, 0)')
      .run('quota', USER_ID);
    expect((await requestLifecycle('restart')).status).toBe(403);
    expect(workspaceStatus()).toBe('evicted');
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
