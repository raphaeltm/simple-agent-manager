import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { workspaceEvictionCallbackRoute } from '../../../src/routes/projects/workspace-eviction-callback';
import { closeOrphanedComputeUsage } from '../../../src/services/compute-usage';
import {
  finalizeWorkspaceEvictionInNode,
  type WorkspaceEvictionIdentity,
} from '../../../src/services/workspace-eviction-lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  verifyCallbackToken: vi.fn(),
  stopSession: vi.fn(),
  cleanupWorkspaceActivity: vi.fn(),
  recordActivityEvent: vi.fn(),
}));
vi.mock('../../../src/services/jwt', () => ({ verifyCallbackToken: mocks.verifyCallbackToken }));
vi.mock('../../../src/services/project-data', () => ({
  stopSession: mocks.stopSession,
  cleanupWorkspaceActivity: mocks.cleanupWorkspaceActivity,
  recordActivityEvent: mocks.recordActivityEvent,
}));

describe('workspace eviction lifecycle through HTTP and real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let pending: Promise<unknown>[];

  function state() {
    return {
      workspace: sqlite.prepare('SELECT status FROM workspaces WHERE id = ?').get('workspace'),
      agent: sqlite
        .prepare('SELECT status, stopped_at FROM agent_sessions WHERE id = ?')
        .get('agent'),
      usage: sqlite.prepare('SELECT ended_at FROM compute_usage WHERE id = ?').get('usage'),
    };
  }

  async function evict(overrides: Record<string, unknown> = {}) {
    const response = await app.fetch(
      new Request('https://api.test/projects/project/workspaces/workspace/eviction', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'node',
          workspaceId: 'workspace',
          reason: 'memory_pressure',
          snapshotCaptured: false,
          containerStopped: true,
          ...overrides,
        }),
      }),
      env,
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as ExecutionContext
    );
    await Promise.all(pending);
    return response;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCallbackToken.mockResolvedValue({ scope: 'node', workspace: 'node' });
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.cleanupWorkspaceActivity.mockResolvedValue(undefined);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO nodes (id, user_id, status) VALUES ('node', 'user', 'running');
      INSERT INTO workspaces (id, user_id, project_id, node_id, chat_session_id, status, updated_at)
        VALUES ('workspace', 'user', 'project', 'node', 'chat', 'running', '2026-09-01T00:00:00.000Z');
      INSERT INTO agent_sessions (id, workspace_id, user_id, status)
        VALUES ('agent', 'workspace', 'user', 'running');
      INSERT INTO compute_usage (id, workspace_id, user_id, started_at)
        VALUES ('usage', 'workspace', 'user', '2026-09-01T00:00:00.000Z');
    `);
    let finalizationQueue: Promise<unknown> = Promise.resolve();
    env = {
      DATABASE: createSqliteD1(sqlite),
      NODE_LIFECYCLE: {
        idFromName: (name: string) => name,
        get: () => ({
          finalizeWorkspaceEviction: (identity: WorkspaceEvictionIdentity) => {
            const result = finalizationQueue
              .catch(() => undefined)
              .then(() => finalizeWorkspaceEvictionInNode(env, identity));
            finalizationQueue = result;
            return result;
          },
        }),
      },
    } as unknown as Env;
    pending = [];
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as never)
        : c.json({ error: error.message }, 500)
    );
    app.route('/projects', workspaceEvictionCallbackRoute);
  });

  afterEach(() => sqlite.close());

  it('closes metering and sessions at eviction, retaining workspace and snapshot state', async () => {
    sqlite.exec(`INSERT INTO session_snapshots
      (id, workspace_id, chat_session_id, project_id, status, sleep_status, sleep_after, expires_at)
      VALUES ('snapshot', 'workspace', 'chat', 'project', 'available', 'scheduled',
        '2026-09-13T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`);
    expect((await evict()).status).toBe(204);
    const ended = state();
    expect(ended.workspace).toEqual({ status: 'evicted' });
    expect(ended.agent).toEqual({ status: 'stopped', stopped_at: expect.any(String) });
    expect(ended.usage).toEqual({ ended_at: (ended.agent as { stopped_at: string }).stopped_at });
    expect(sqlite.prepare('SELECT id FROM session_snapshots').all()).toEqual([{ id: 'snapshot' }]);
    expect(sqlite.prepare('SELECT sleep_status, sleep_after FROM session_snapshots').get()).toEqual(
      { sleep_status: null, sleep_after: null }
    );
    expect(mocks.stopSession).toHaveBeenCalledWith(env, 'project', 'chat');
    expect(mocks.cleanupWorkspaceActivity).toHaveBeenCalledWith(env, 'project', 'workspace');
    expect((await evict()).status).toBe(410);
    expect(state()).toEqual(ended);
    expect(mocks.recordActivityEvent).toHaveBeenCalledOnce();
  });

  it('does not release reservation or billing when the container failed to stop', async () => {
    const before = state();
    expect((await evict({ containerStopped: false })).status).toBe(409);
    expect(state()).toEqual(before);
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it.each([
    { scope: 'node', workspace: 'another-node' },
    { scope: 'workspace', workspace: 'another-workspace' },
  ])('rejects another resource callback identity: %j', async (token) => {
    mocks.verifyCallbackToken.mockResolvedValue(token);
    const before = state();
    expect((await evict()).status).toBe(403);
    expect(state()).toEqual(before);
  });

  it.each([
    "UPDATE nodes SET status = 'destroying' WHERE id = 'node'",
    "UPDATE workspaces SET chat_session_id = 'replacement' WHERE id = 'workspace'",
    "UPDATE workspaces SET runtime_deletion_confirmed_at = '2026-09-02' WHERE id = 'workspace'",
  ])('fences a lifecycle change after authentication: %s', async (mutation) => {
    const original = env.DATABASE.batch.bind(env.DATABASE);
    env.DATABASE.batch = async (statements) => {
      sqlite.exec(mutation);
      return original(statements);
    };
    const response = await evict();
    expect([409, 410]).toContain(response.status);
    expect(state().workspace).toEqual({ status: 'running' });
    expect(state().agent).toEqual({ status: 'running', stopped_at: null });
    expect(state().usage).toEqual({ ended_at: null });
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it('rolls back the status change when closing billing fails', async () => {
    sqlite.exec(`CREATE TRIGGER refuse_usage_closure BEFORE UPDATE ON compute_usage
      BEGIN SELECT RAISE(ABORT, 'simulated billing write failure'); END`);
    const before = state();
    expect((await evict()).status).toBe(500);
    expect(state()).toEqual(before);
  });

  it('retries ProjectData cleanup after an eviction was committed', async () => {
    mocks.stopSession.mockRejectedValueOnce(new Error('temporary DO failure'));
    expect((await evict()).status).toBe(500);
    expect(state().workspace).toEqual({ status: 'evicted' });
    expect((await evict()).status).toBe(410);
    expect(mocks.stopSession).toHaveBeenCalledTimes(2);
  });

  it('rejects delayed callbacks and finalization from an older runtime after restart', async () => {
    expect((await evict()).status).toBe(204);
    sqlite.exec(`UPDATE workspaces SET status = 'running', eviction_generation = 'new-generation', eviction_finalized_at = NULL;
      UPDATE agent_sessions SET status = 'running', stopped_at = NULL;
      INSERT INTO compute_usage (id, workspace_id) VALUES ('new-usage', 'workspace');`);
    const before = state();
    expect((await evict()).status).toBe(410);
    expect(
      await finalizeWorkspaceEvictionInNode(env, {
        nodeId: 'node',
        workspaceId: 'workspace',
        generation: null,
      })
    ).toBe(false);
    expect(state()).toEqual(before);
    expect(
      sqlite.prepare("SELECT ended_at FROM compute_usage WHERE id = 'new-usage'").get()
    ).toEqual({ ended_at: null });
    expect(mocks.stopSession).toHaveBeenCalledOnce();
    expect((await evict({ evictionGeneration: 'new-generation' })).status).toBe(204);
  });

  it('does not release restart until serialized duplicate cleanup has completed', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.stopSession.mockImplementationOnce(() => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = evict();
    await entered;
    const duplicate = evict();
    expect(sqlite.prepare('SELECT eviction_finalized_at FROM workspaces').get()).toEqual({
      eviction_finalized_at: null,
    });
    release();
    expect((await first).status).toBe(204);
    expect((await duplicate).status).toBe(410);
    expect(mocks.stopSession).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT eviction_finalized_at FROM workspaces').get()).toEqual({
      eviction_finalized_at: expect.any(String),
    });
  });

  it('orphan metering cleanup closes evicted usage at eviction time and preserves live usage', async () => {
    const stoppedAt = '2026-09-02T00:00:00.000Z';
    sqlite
      .prepare("UPDATE workspaces SET status = 'evicted', updated_at = ? WHERE id = 'workspace'")
      .run(stoppedAt);
    sqlite.exec(`INSERT INTO workspaces (id, status) VALUES ('live-workspace', 'running');
      INSERT INTO compute_usage (id, workspace_id) VALUES ('live-usage', 'live-workspace');`);
    expect(await closeOrphanedComputeUsage(drizzle(env.DATABASE, { schema }))).toBe(1);
    expect(state().usage).toEqual({ ended_at: stoppedAt });
    expect(
      sqlite.prepare("SELECT ended_at FROM compute_usage WHERE id = 'live-usage'").get()
    ).toEqual({ ended_at: null });
    expect(await closeOrphanedComputeUsage(drizzle(env.DATABASE, { schema }))).toBe(0);
  });
});
