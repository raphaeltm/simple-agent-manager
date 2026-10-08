import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { persistRuntimeEnded } from '../../../src/durable-objects/vm-agent-container-runtime';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { workspaceStopRoutes } from '../../../src/routes/workspaces/workspace-stop';
import { sweepMaxLifetimeNodes } from '../../../src/scheduled/node-cleanup/node-phases';
import {
  claimNodeForCleanup,
  emptyResult,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';
import { sweepTerminalCfContainers } from '../../../src/scheduled/node-cleanup/terminal-cf-container-phase';
import { stopNodeResources } from '../../../src/services/node-resource-lifecycle';
import { attemptWorkspaceDeletion } from '../../../src/services/workspace-deletion';
import { finalizeWorkspaceLifecycleClosure } from '../../../src/services/workspace-lifecycle-finalizer';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user',
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/services/workspace-lifecycle-finalizer', () => ({
  finalizeWorkspaceLifecycleClosure: vi.fn().mockResolvedValue({}),
}));

const old = '2026-10-01T00:00:00.000Z';
const now = new Date('2026-10-03T00:00:00.000Z');
describe('Instant lifecycle with real SQL and ordered container callbacks', () => {
  let sqlite: Database.Database;
  let env: Env;
  let destroy: ReturnType<typeof vi.fn>;
  const row = (table: string) =>
    sqlite
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(table === 'nodes' ? 'node' : 'workspace') as Record<string, unknown>;
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO nodes (id,user_id,status,runtime,node_role,node_class,created_at,updated_at,runtime_incarnation_id) VALUES ('node','user','sleeping','cf-container','workspace','managed',?,?,'incarnation')`
      )
      .run(old, old);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id,node_id,user_id,status,created_at,updated_at) VALUES ('workspace','node','user','sleeping',?,?)`
      )
      .run(old, old);
    sqlite
      .prepare(
        `INSERT INTO tasks (id,user_id,status,auto_provisioned_node_id) VALUES ('task','user','sleeping','node')`
      )
      .run();
    destroy = vi.fn().mockResolvedValue(undefined);
    env = {
      CF_CONTAINER_ENABLED: 'true',
      DATABASE: createSqliteD1(sqlite),
      VM_AGENT_CONTAINER: {
        idFromName: (id: string) => id,
        get: () => ({ destroyForUser: destroy }),
      },
    } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('keeps the sleeping wake target beyond both node lifetime ceilings', async () => {
    const result = emptyResult();
    await sweepMaxLifetimeNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      now,
      resolveCleanupConfig(env),
      result
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(row('nodes').status).toBe('sleeping');
  });
  it('rejects a cleanup claim after Instant has entered sleep but permits VM release', async () => {
    const candidate = { id: 'node', user_id: 'user', status: 'sleeping' };
    expect(
      await claimNodeForCleanup(env, candidate, now.toISOString(), { requireWorkspaceIdle: false })
    ).toBe(false);
    sqlite.prepare("UPDATE nodes SET runtime = 'vm'").run();
    expect(
      await claimNodeForCleanup(env, candidate, now.toISOString(), { requireWorkspaceIdle: false })
    ).toBe(true);
  });
  it('does not let onStop steal strict teardown claims before proof is written', async () => {
    destroy.mockImplementation(async () => {
      expect(row('nodes').status).toBe('destroying');
      expect(row('workspaces').status).toBe('stopping');
      await persistRuntimeEnded(
        env,
        { nodeId: 'node', workspaceId: 'workspace' },
        'stopped',
        'stopped'
      );
      expect(row('nodes').status).toBe('destroying');
      expect(row('workspaces').status).toBe('stopping');
    });
    await stopNodeResources('node', 'user', env);
    expect(row('nodes').status).toBe('deleted');
    expect(row('nodes').runtime_termination_confirmed_at).toBeTruthy();
    await stopNodeResources('node', 'user', env);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('archives a slept container directly without proxying a wake request', async () => {
    const result = await attemptWorkspaceDeletion({
      env,
      expected: {
        workspaceId: 'workspace',
        nodeId: 'node',
        nodeUserId: 'user',
        nodeRuntime: 'cf-container',
        nodeProviderInstanceId: null,
        nodeRuntimeIncarnationId: 'incarnation',
        userId: 'user',
        projectId: null,
        chatSessionId: null,
      },
      attempt: 1,
      source: 'test',
      mode: 'explicit',
    });
    expect(result.status).toBe('confirmed');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(row('workspaces').status).toBe('deleted');
  });
  it('reconciles a failed archive even when the completed chat once owned sleep', async () => {
    sqlite.prepare("UPDATE workspaces SET status = 'stopping', chat_session_id = 'chat'").run();
    sqlite
      .prepare("UPDATE tasks SET status = 'completed', workspace_id = 'workspace', updated_at = ?")
      .run(old);
    const result = emptyResult();
    await sweepTerminalCfContainers(env, now, resolveCleanupConfig(env), result);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(row('nodes').status).toBe('deleted');
  });
  it('ignores a late runtime callback after deletion', async () => {
    await stopNodeResources('node', 'user', env);
    await persistRuntimeEnded(
      env,
      { nodeId: 'node', workspaceId: 'workspace' },
      'stopped',
      'stopped'
    );
    expect(row('nodes').status).toBe('deleted');
    expect(row('workspaces').status).toBe('deleted');
  });
  it('rejects a replaced container identity before changing any lifecycle state', async () => {
    await expect(
      stopNodeResources('node', 'user', env, {
        expectedRuntime: {
          userId: 'user',
          runtime: 'cf-container',
          providerInstanceId: null,
          runtimeIncarnationId: 'old-incarnation',
        },
      })
    ).rejects.toThrow('changed');
    expect(row('nodes').status).toBe('sleeping');
    expect(row('workspaces').status).toBe('sleeping');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('accepts Stop on an already stopped Instant and accepts its repeat', async () => {
    sqlite.prepare("UPDATE nodes SET status = 'stopped'").run();
    sqlite.prepare("UPDATE workspaces SET status = 'stopped'").run();
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      c.json({ error: err.message }, err instanceof AppError ? err.statusCode : 500)
    );
    app.route('/workspaces', workspaceStopRoutes);
    const pending: Promise<unknown>[] = [];
    const request = () =>
      app.fetch(new Request('https://test/workspaces/workspace/stop', { method: 'POST' }), env, {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
      } as ExecutionContext);
    vi.mocked(finalizeWorkspaceLifecycleClosure).mockRejectedValueOnce(
      new Error('transient closure failure')
    );
    const first = await request();
    expect(first.status).toBe(200);
    await Promise.all(pending);
    expect(row('nodes').status).toBe('deleted');
    const repeat = await request();
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ status: 'stopped' });
    expect(finalizeWorkspaceLifecycleClosure).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
