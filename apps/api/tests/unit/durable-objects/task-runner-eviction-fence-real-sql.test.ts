/**
 * The TaskRunner's eviction fence through `assertRecoveryAuthority` on a real SQL engine.
 *
 * Staging 2026-11-05: a wake restored the evicted conversation, its source was released and
 * deleted within seconds, and the fence (the source must stay `evicted`) then revoked the
 * wake that had replaced it. The fence guards replacement allocation; once this runner's
 * own restore committed, a released source must not revoke it.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { assertRecoveryAuthority } from '../../../src/durable-objects/task-runner/recovery-authority';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('eviction fence after this runner restored the snapshot', () => {
  let sqlite: Database.Database;
  let env: Env;
  const ctx = { storage: { get: async () => undefined } } as unknown as DurableObjectState;
  const state = {
    taskId: 'wake-task',
    projectId: 'project',
    userId: 'user',
    stepResults: { workspaceId: 'target', chatSessionId: 'chat' },
    config: {
      chatSessionId: 'chat',
      resumeSnapshotChatSessionId: 'chat',
      recoveryAttemptId: null,
      evictionFence: { workspaceId: 'source', nodeId: 'node', generation: 'generation' },
    },
  } as unknown as TaskRunnerState;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
    sqlite.exec(`
      INSERT INTO workspaces (id, user_id, project_id, node_id, status, eviction_generation)
        VALUES ('source', 'user', 'project', 'node', 'evicted', 'generation'),
               ('target', 'user', 'project', 'target-node', 'running', NULL);
      -- The wake task as the step sees it: still delegated, executable by this runner.
      INSERT INTO tasks (id, project_id, user_id, status) VALUES ('wake-task', 'project', 'user', 'delegated');
      INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
          runtime, status, degradation, expires_at, created_at, updated_at,
          recovery_status, recovery_task_id, recovery_workspace_id)
        VALUES ('snapshot', 'project', 'source', 'node', 'user', 'chat', 'vm', 'available', 'none',
          '2099-01-01T00:00:00Z', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z',
          'waking', 'wake-task', NULL);
    `);
  });
  afterEach(() => sqlite.close());

  const check = () => assertRecoveryAuthority(env, ctx, state);
  const restore = (workspace: string) =>
    sqlite.exec(
      `UPDATE session_snapshots SET recovery_status = 'restored', recovery_workspace_id = '${workspace}'`
    );
  const deleteSource = () =>
    sqlite.exec("UPDATE workspaces SET status = 'deleted' WHERE id = 'source'");

  it('passes while the source is still evicted (liveness control)', async () => {
    await expect(check()).resolves.toBeUndefined();
  });

  it('refuses when the source changed before this runner restored anything', async () => {
    deleteSource();
    await expect(check()).rejects.toThrow(
      'Eviction generation changed before replacement allocation'
    );
  });

  it('accepts a released source once this runner restored the snapshot into its workspace', async () => {
    restore('target');
    deleteSource();
    await expect(check()).resolves.toBeUndefined();
  });

  it('still refuses when the restore went to a different workspace', async () => {
    restore('elsewhere');
    deleteSource();
    await expect(check()).rejects.toThrow(
      'Eviction generation changed before replacement allocation'
    );
  });

  // An explicit Restart moves the source to a new generation while the handoff is held. The
  // wake must lose to it even after its own restore, or the conversation runs twice.
  it('still refuses a restarted source after this runner restored the snapshot', async () => {
    restore('target');
    sqlite.exec(
      "UPDATE workspaces SET status = 'running', eviction_generation = 'generation-2' WHERE id = 'source'"
    );
    await expect(check()).rejects.toThrow(
      'Eviction generation changed before replacement allocation'
    );
  });

  it('still refuses a deleted source of a different generation', async () => {
    restore('target');
    sqlite.exec(
      "UPDATE workspaces SET status = 'deleted', eviction_generation = 'generation-2' WHERE id = 'source'"
    );
    await expect(check()).rejects.toThrow(
      'Eviction generation changed before replacement allocation'
    );
  });
});
