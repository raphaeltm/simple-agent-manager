import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { ensureSessionRecovery } from '../../src/services/session-recovery';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const { ensureTaskRunnerStartedMock, startTaskRunnerDOMock } = vi.hoisted(() => ({
  ensureTaskRunnerStartedMock: vi.fn(async () => false),
  startTaskRunnerDOMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: ensureTaskRunnerStartedMock,
  startTaskRunnerDO: startTaskRunnerDOMock,
}));

function seedStableRecoveryFixture(sqlite: Database.Database): void {
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO users (id, name, email, github_id, status)
    VALUES ('user-1', 'Test User', 'test@example.com', 'gh-1', 'active');

    INSERT INTO credentials
      (id, user_id, provider, credential_type, credential_kind, is_active,
       encrypted_token, iv, created_at, updated_at)
    VALUES
      ('credential-1', 'user-1', 'hetzner', 'cloud-provider', 'api-key', 1,
       'encrypted', 'iv', '2026-08-15T00:00:00.000Z',
       '2026-08-15T00:00:00.000Z');

    INSERT INTO nodes
      (id, user_id, name, status, health_status, last_heartbeat_at, vm_size,
       vm_location, cloud_provider, created_at, updated_at)
    VALUES
      ('node-1', 'user-1', 'node', 'running', 'healthy', '2026-08-15T00:00:00.000Z',
       'small', 'nbg1', 'hetzner', '2026-08-15T00:00:00.000Z',
       '2026-08-15T00:00:00.000Z');

    INSERT INTO projects
      (id, name, repository, installation_id, default_branch, default_location,
       created_by, created_at, updated_at)
    VALUES
      ('project-1', 'Project', 'owner/repo', 'install-1', 'main', 'nbg1',
       'user-1', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');

    INSERT INTO project_members (project_id, user_id, role, status)
    VALUES ('project-1', 'user-1', 'owner', 'active');

    INSERT INTO workspaces
      (id, user_id, project_id, node_id, status, branch, vm_size, vm_location,
       workspace_profile, chat_session_id, created_at, updated_at)
    VALUES
      ('workspace-1', 'user-1', 'project-1', 'node-1', 'sleeping', 'main', 'small',
       'nbg1', 'lightweight', 'chat-1', '2026-08-15T00:00:00.000Z',
       '2026-08-15T00:00:00.000Z');

    INSERT INTO tasks
      (id, project_id, user_id, chat_session_id, workspace_id, parent_task_id,
       title, description, status, execution_step, priority, task_mode,
       dispatch_depth, triggered_by, created_by, created_at, updated_at)
    VALUES
      ('parent-1', 'project-1', 'user-1', NULL, NULL, NULL, 'Parent', 'Parent work',
       'in_progress', 'running', 0, 'conversation', 0, 'mcp', 'user-1',
       '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
      ('task-1', 'project-1', 'user-1', 'chat-1', 'workspace-1', 'parent-1',
       'Child conversation', 'Original work', 'sleeping', NULL, 0, 'conversation',
       1, 'mcp', 'user-1', '2026-08-15T00:00:00.000Z',
       '2026-08-15T00:00:00.000Z'),
      ('child-before-sleep', 'project-1', 'user-1', NULL, NULL, 'task-1',
       'Pre-sleep child', 'Already dispatched', 'in_progress', 'running', 0,
       'task', 2, 'mcp', 'user-1', '2026-08-15T00:00:00.000Z',
       '2026-08-15T00:00:00.000Z');

    INSERT INTO session_snapshots
      (id, workspace_id, node_id, project_id, user_id, chat_session_id,
       agent_session_id, runtime, status, degradation, manifest_r2_key,
       manifest_json, snapshot_generation, expires_at, sleep_status, sleeping_at,
       recovery_attempts, updated_at)
    VALUES
      ('snapshot-1', 'workspace-1', 'node-1', 'project-1', 'user-1', 'chat-1',
       'agent-1', 'vm', 'available', 'none',
       'snapshots/chat-1/generation-final/manifest.json',
       '{"status":"available","agentType":"claude-code"}', 'generation-final',
       '2099-08-20T00:00:00.000Z', 'sleeping', '2026-08-15T00:00:00.000Z',
       0, '2026-08-15T00:00:00.000Z');
  `);
}

function makeSnapshotClaimable(sqlite: Database.Database, sleepingAt: string): void {
  sqlite
    .prepare(
      `UPDATE session_snapshots
          SET recovery_status = NULL,
              recovery_task_id = NULL,
              recovery_failed_at = NULL,
              recovery_error = NULL,
              sleep_status = 'sleeping',
              sleeping_at = ?,
              recovery_attempts = 0
        WHERE chat_session_id = 'chat-1'`
    )
    .run(sleepingAt);
  sqlite
    .prepare(
      `UPDATE tasks
          SET status = 'sleeping',
              execution_step = NULL,
              workspace_id = 'workspace-1',
              chat_session_id = 'chat-1'
        WHERE id = 'task-1'`
    )
    .run();
  sqlite
    .prepare(`UPDATE workspaces SET chat_session_id = 'chat-1' WHERE id = 'workspace-1'`)
    .run();
}

function taskRow(sqlite: Database.Database, taskId = 'task-1') {
  return sqlite
    .prepare(
      `SELECT id, status, execution_step, chat_session_id, workspace_id,
              parent_task_id, dispatch_depth, recovery_source_task_id,
              superseded_by_task_id, triggered_by
         FROM tasks
        WHERE id = ?`
    )
    .get(taskId);
}

function recoveryTaskCount(sqlite: Database.Database): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE triggered_by = 'session-recovery'`)
      .get() as { count: number }
  ).count;
}

async function wake(database: D1Database) {
  return ensureSessionRecovery({ DATABASE: database } as Env, 'project-1', 'chat-1', {
    taskId: 'task-1',
    projectId: 'project-1',
    chatSessionId: 'chat-1',
  });
}

describe('session recovery stable task identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureTaskRunnerStartedMock.mockResolvedValue(false);
    startTaskRunnerDOMock.mockResolvedValue(undefined);
  });

  it('reactivates the sleeping task without creating a recovery task row', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });

      expect(recoveryTaskCount(sqlite)).toBe(0);
      expect(taskRow(sqlite)).toMatchObject({
        id: 'task-1',
        status: 'queued',
        execution_step: 'node_selection',
        chat_session_id: 'chat-1',
        workspace_id: null,
        parent_task_id: 'parent-1',
        dispatch_depth: 1,
        recovery_source_task_id: null,
        superseded_by_task_id: null,
        triggered_by: 'mcp',
      });
      expect(
        sqlite.prepare(`SELECT parent_task_id FROM tasks WHERE id = 'child-before-sleep'`).get()
      ).toEqual({ parent_task_id: 'task-1' });
      expect(startTaskRunnerDOMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          taskId: 'task-1',
          resumeSnapshotChatSessionId: 'chat-1',
          recoverySourceTaskId: null,
          retrySourceTaskId: null,
        }),
        { reactivate: true }
      );
    } finally {
      sqlite.close();
    }
  });

  it('converges repeated wake attempts on the same task id', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });
      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });

      expect(recoveryTaskCount(sqlite)).toBe(0);
      expect(
        sqlite.prepare(`SELECT recovery_task_id FROM session_snapshots WHERE id = 'snapshot-1'`).get()
      ).toEqual({ recovery_task_id: 'task-1' });
      expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('preserves lineage and fan-out parent identity across multiple sleep/wake cycles', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });
      makeSnapshotClaimable(sqlite, '2026-08-15T00:10:00.000Z');
      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });

      expect(taskRow(sqlite)).toMatchObject({
        parent_task_id: 'parent-1',
        dispatch_depth: 1,
        recovery_source_task_id: null,
        superseded_by_task_id: null,
      });
      expect(
        sqlite
          .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = 'task-1'`)
          .get()
      ).toEqual({ count: 1 });
      expect(recoveryTaskCount(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('keeps the per-parent fan-out counter anchored to the stable task id', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite.exec(`
        INSERT INTO tasks
          (id, project_id, user_id, parent_task_id, title, description, status,
           priority, task_mode, dispatch_depth, triggered_by, created_by, created_at, updated_at)
        VALUES
          ('child-after-wake', 'project-1', 'user-1', 'task-1', 'Post-wake child',
           'Dispatched after wake', 'queued', 0, 'task', 2, 'mcp', 'user-1',
           '2026-08-15T00:02:00.000Z', '2026-08-15T00:02:00.000Z');
      `);
      const database = createSqliteD1(sqlite);

      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });

      expect(
        sqlite
          .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = 'task-1'`)
          .get()
      ).toEqual({ count: 2 });
      expect(recoveryTaskCount(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
