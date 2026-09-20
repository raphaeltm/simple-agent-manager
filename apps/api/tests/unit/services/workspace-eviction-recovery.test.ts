import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { recoverWorkspaceAfterEviction } from '../../../src/services/workspace-eviction-recovery';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ ensureSessionRecovery: vi.fn() }));
vi.mock('../../../src/services/session-recovery', () => ({
  ensureSessionRecovery: mocks.ensureSessionRecovery,
}));

describe('workspace eviction recovery', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSessionRecovery.mockResolvedValue({ status: 'waking', taskId: 'recovery-task' });
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO users (id) VALUES ('user');
      INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
        VALUES ('project', 'user', 'Project', 'project', 'installation', 'acme/repo', 'user');
      INSERT INTO nodes (id, user_id, name, status) VALUES ('node', 'user', 'Node', 'running');
      INSERT INTO workspaces
        (id, user_id, project_id, node_id, chat_session_id, name, repository, branch, status,
         vm_size, vm_location, eviction_generation, created_at, updated_at)
        VALUES ('workspace', 'user', 'project', 'node', 'chat', 'Workspace', 'acme/repo', 'main',
          'evicted', 'large', 'fsn1', 'generation-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO session_snapshots
        (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
         degradation, manifest_r2_key, expires_at, created_at, updated_at)
        VALUES ('snapshot', 'project', 'workspace', 'node', 'user', 'chat', 'vm', 'available',
          'none', 'manifest', '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  });

  it('marks the snapshot sleeping and excludes the unhealthy node on replay-safe recovery', async () => {
    const identity = {
      projectId: 'project',
      workspaceId: 'workspace',
      chatSessionId: 'chat',
      nodeId: 'node',
      generation: 'generation-1',
    };
    await expect(recoverWorkspaceAfterEviction(env, identity)).resolves.toEqual({
      status: 'waking',
      taskId: 'recovery-task',
    });
    await expect(recoverWorkspaceAfterEviction(env, identity)).resolves.toEqual({
      status: 'waking',
      taskId: 'recovery-task',
    });
    expect(sqlite.prepare('SELECT sleeping_at, sleep_status FROM session_snapshots').get()).toEqual(
      {
        sleeping_at: expect.any(String),
        sleep_status: 'sleeping',
      }
    );
    expect(mocks.ensureSessionRecovery).toHaveBeenLastCalledWith(
      env,
      'project',
      'chat',
      undefined,
      {
        excludedNodeId: 'node',
        evictionFence: { workspaceId: 'workspace', nodeId: 'node', generation: 'generation-1' },
      }
    );
  });

  it('fails closed without starting recovery for a stale generation', async () => {
    await expect(
      recoverWorkspaceAfterEviction(env, {
        projectId: 'project',
        workspaceId: 'workspace',
        chatSessionId: 'chat',
        nodeId: 'node',
        generation: 'stale-generation',
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'eviction_snapshot_missing_or_stale' });
    expect(mocks.ensureSessionRecovery).not.toHaveBeenCalled();
  });

  it('acknowledges a delayed duplicate after restoration without starting another recovery', async () => {
    const identity = {
      projectId: 'project',
      workspaceId: 'workspace',
      chatSessionId: 'chat',
      nodeId: 'node',
      generation: 'generation-1',
    };
    await recoverWorkspaceAfterEviction(env, identity);
    sqlite
      .prepare(
        `UPDATE session_snapshots
            SET sleeping_at = NULL, recovery_status = 'restored', recovery_task_id = 'recovery-task'
          WHERE id = 'snapshot'`
      )
      .run();
    mocks.ensureSessionRecovery.mockClear();

    await expect(recoverWorkspaceAfterEviction(env, identity)).resolves.toEqual({
      status: 'waking',
      taskId: 'recovery-task',
    });
    expect(mocks.ensureSessionRecovery).not.toHaveBeenCalled();
    expect(
      sqlite.prepare('SELECT sleeping_at, recovery_status FROM session_snapshots').get()
    ).toEqual({ sleeping_at: null, recovery_status: 'restored' });
  });
});
