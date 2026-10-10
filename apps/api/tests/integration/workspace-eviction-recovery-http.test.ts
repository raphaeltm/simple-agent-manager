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
});
