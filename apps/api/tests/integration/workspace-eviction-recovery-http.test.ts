import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createAllSchemaTables } from '../helpers/sqlite-d1';
import {
  createEvictionApp,
  createEvictionEnv,
  postEvictionCallback,
  seedEvictionOwnerAndNode,
} from '../helpers/workspace-eviction-route-harness';

const mocks = vi.hoisted(() => ({
  startTaskRunnerDO: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ scope: 'node', workspace: 'node-1' })),
}));
vi.mock('../../src/services/project-data', () => ({
  getSession: vi.fn(async () => null),
  stopSession: vi.fn(async () => undefined),
  cleanupWorkspaceActivity: vi.fn(async () => undefined),
  recordActivityEvent: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: vi.fn(async () => false),
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

describe('workspace eviction HTTP recovery vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startTaskRunnerDO.mockReset().mockResolvedValue(undefined);
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedEvictionOwnerAndNode(sqlite);
    sqlite.exec(`
      INSERT INTO workspaces
        (id, user_id, project_id, node_id, chat_session_id, status, branch, vm_size,
         vm_location, workspace_profile, eviction_generation, created_at, updated_at)
      VALUES ('workspace-1', 'user-1', 'project-1', 'node-1', 'chat-1', 'running',
        'main', 'small', 'nbg1', 'lightweight', 'generation-1',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO tasks
        (id, project_id, user_id, chat_session_id, workspace_id, title, status, priority,
         task_mode, dispatch_depth, triggered_by, created_by, placement_explanation_json,
         created_at, updated_at)
      VALUES ('source-task', 'project-1', 'user-1', 'chat-1', 'workspace-1', 'Source',
        'completed', 0, 'conversation', 0, 'mcp', 'user-1',
        '{"kind":"direct_placement","explicitVmLocation":false}',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO session_snapshots
        (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
         degradation, manifest_r2_key, manifest_json, expires_at, created_at, updated_at)
      VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', 'chat-1',
        'vm', 'available', 'none', 'snapshot/manifest.json', '{}',
        '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
    env = createEvictionEnv(sqlite);
    app = createEvictionApp();
  });

  afterEach(() => sqlite.close());

  it('commits eviction and starts one fenced normal-placement recovery across replays', async () => {
    const request = () => postEvictionCallback(app, env);

    const first = await request();
    expect(first.status, await first.text()).toBe(204);
    expect((await request()).status).toBe(204);

    expect(
      sqlite
        .prepare(`SELECT status, eviction_finalized_at FROM workspaces WHERE id = 'workspace-1'`)
        .get()
    ).toMatchObject({ status: 'evicted', eviction_finalized_at: expect.any(String) });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM tasks`).get()).toEqual({ count: 1 });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledOnce();
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        taskId: 'source-task',
        vmLocation: 'hel1',
        excludedNodeId: 'node-1',
        evictionFence: {
          workspaceId: 'workspace-1',
          nodeId: 'node-1',
          generation: 'generation-1',
        },
      }),
      { reactivate: true }
    );
    expect(sqlite.prepare('SELECT id, status, triggered_by FROM tasks').get()).toEqual({
      id: 'source-task',
      status: 'queued',
      triggered_by: 'mcp',
    });
  });
  it('retries a retained conversation after startup failed and detached its source chat', async () => {
    mocks.startTaskRunnerDO.mockRejectedValueOnce(new Error('temporary runner startup failure'));
    const first = await postEvictionCallback(app, env);
    expect(first.status, await first.text()).toBe(409);
    expect(
      sqlite
        .prepare(`SELECT status, chat_session_id FROM workspaces WHERE id = 'workspace-1'`)
        .get()
    ).toEqual({ status: 'evicted', chat_session_id: null });
    expect(sqlite.prepare(`SELECT status FROM tasks WHERE id = 'source-task'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(
      sqlite.prepare(`SELECT recovery_status, recovery_attempts FROM session_snapshots`).get()
    ).toEqual({ recovery_status: 'failed', recovery_attempts: 1 });

    const replay = await postEvictionCallback(app, env);
    expect(replay.status, await replay.text()).toBe(204);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT status FROM tasks WHERE id = 'source-task'`).get()).toEqual({
      status: 'queued',
    });
    expect(
      sqlite.prepare(`SELECT recovery_status, recovery_attempts FROM session_snapshots`).get()
    ).toEqual({ recovery_status: 'waking', recovery_attempts: 2 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM tasks`).get()).toEqual({ count: 1 });
  });

  it('does not retry a detached snapshot belonging to another eviction generation', async () => {
    mocks.startTaskRunnerDO.mockRejectedValueOnce(new Error('temporary runner startup failure'));
    await postEvictionCallback(app, env);
    sqlite.exec(`UPDATE session_snapshots SET eviction_recovery_generation = 'newer-generation'`);
    const replay = await postEvictionCallback(app, env);
    expect(replay.status, await replay.text()).toBe(204);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(1);
  });

  it.each(['user_id', 'project_id', 'eviction_recovery_node_id', 'workspace_id'])(
    'does not borrow a detached snapshot with changed %s ownership',
    async (field) => {
      mocks.startTaskRunnerDO.mockRejectedValueOnce(new Error('temporary runner startup failure'));
      expect((await postEvictionCallback(app, env)).status).toBe(409);
      // This fixture adapter does not enforce foreign keys; the mismatch must
      // independently fail the production ownership predicates.
      sqlite.prepare(`UPDATE session_snapshots SET ${field} = 'another-owner'`).run();
      expect((await postEvictionCallback(app, env)).status).toBe(204);
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(1);
    }
  );

  it('bounds repeated startup failures while retaining the task and saved snapshot', async () => {
    mocks.startTaskRunnerDO.mockRejectedValue(new Error('runner unavailable'));
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS = '2';
    expect((await postEvictionCallback(app, env)).status).toBe(409);
    expect((await postEvictionCallback(app, env)).status).toBe(409);
    // Budget exhaustion is a visible report, not an endless callback/start loop.
    expect((await postEvictionCallback(app, env)).status).toBe(204);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT status FROM tasks WHERE id = 'source-task'`).get()).toEqual({
      status: 'sleeping',
    });
    expect(
      sqlite
        .prepare(`SELECT status, recovery_attempts, recovery_error FROM session_snapshots`)
        .get()
    ).toMatchObject({
      status: 'available',
      recovery_attempts: 2,
      recovery_error: expect.stringContaining('retry budget'),
    });
  });
  it('does not decay the automatic callback budget after delayed retries', async () => {
    mocks.startTaskRunnerDO.mockRejectedValue(new Error('runner unavailable'));
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS = '2';
    expect((await postEvictionCallback(app, env)).status).toBe(409);
    sqlite.exec(`UPDATE session_snapshots SET recovery_failed_at = '2020-01-01T00:00:00.000Z'`);
    expect((await postEvictionCallback(app, env)).status).toBe(409);
    expect(sqlite.prepare(`SELECT recovery_attempts FROM session_snapshots`).get()).toEqual({
      recovery_attempts: 2,
    });
    sqlite.exec(`UPDATE session_snapshots SET recovery_failed_at = '2020-01-01T00:00:00.000Z'`);
    expect((await postEvictionCallback(app, env)).status).toBe(204);
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(2);
  });
});
