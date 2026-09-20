import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { workspaceEvictionCallbackRoute } from '../../src/routes/projects/workspace-eviction-callback';
import { finalizeWorkspaceEvictionInNode } from '../../src/services/workspace-eviction-lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

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
    sqlite.exec(`
      INSERT INTO users (id, name, email, github_id, status)
      VALUES ('user-1', 'Test User', 'test@example.com', 'gh-1', 'active');

      INSERT INTO credentials
        (id, user_id, provider, credential_type, credential_kind, is_active,
         encrypted_token, iv, created_at, updated_at)
      VALUES ('credential-1', 'user-1', 'hetzner', 'cloud-provider', 'api-key', 1,
        'encrypted', 'iv', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO projects
        (id, user_id, name, normalized_name, repository, installation_id, default_branch,
         default_location, created_by, created_at, updated_at)
      VALUES ('project-1', 'user-1', 'Project', 'project', 'owner/repo', 'install-1',
        'main', 'hel1', 'user-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('project-1', 'user-1', 'owner', 'active');

      INSERT INTO nodes
        (id, user_id, name, status, health_status, runtime, vm_size, vm_location,
         cloud_provider, created_at, updated_at)
      VALUES ('node-1', 'user-1', 'Node', 'running', 'healthy', 'vm', 'small', 'nbg1',
        'hetzner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

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

    let finalizationQueue: Promise<unknown> = Promise.resolve();
    env = {
      DATABASE: createSqliteD1(sqlite),
      NODE_LIFECYCLE: {
        idFromName: (id: string) => id,
        get: () => ({
          getWorkspaceDeletionAttemptState: async () => ({ pending: false }),
          finalizeWorkspaceEviction: (
            identity: Parameters<typeof finalizeWorkspaceEvictionInNode>[1]
          ) => {
            const result = finalizationQueue
              .catch(() => undefined)
              .then(() => finalizeWorkspaceEvictionInNode(env, identity));
            finalizationQueue = result;
            return result;
          },
        }),
      },
    } as unknown as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as never)
        : c.json({ error: error.message }, 500)
    );
    app.route('/projects', workspaceEvictionCallbackRoute);
  });

  afterEach(() => sqlite.close());

  it('commits eviction and starts one fenced normal-placement recovery across replays', async () => {
    const request = () =>
      app.fetch(
        new Request('https://api.test/projects/project-1/workspaces/workspace-1/eviction', {
          method: 'POST',
          headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeId: 'node-1',
            workspaceId: 'workspace-1',
            reason: 'oom_kill',
            snapshotCaptured: true,
            containerStopped: true,
            evictionGeneration: 'generation-1',
          }),
        }),
        env,
        { waitUntil: () => undefined } as unknown as ExecutionContext
      );

    const first = await request();
    expect(first.status, await first.text()).toBe(204);
    expect((await request()).status).toBe(204);

    expect(
      sqlite
        .prepare(`SELECT status, eviction_finalized_at FROM workspaces WHERE id = 'workspace-1'`)
        .get()
    ).toMatchObject({ status: 'evicted', eviction_finalized_at: expect.any(String) });
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE triggered_by = 'session-recovery'`)
        .get()
    ).toEqual({ count: 1 });
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledOnce();
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        vmLocation: 'hel1',
        excludedNodeId: 'node-1',
        evictionFence: {
          workspaceId: 'workspace-1',
          nodeId: 'node-1',
          generation: 'generation-1',
        },
      })
    );
  });
});
