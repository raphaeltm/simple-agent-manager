import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { ensureSessionLinked } from '../../src/durable-objects/task-runner/session-linking';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { crudRoutes } from '../../src/routes/tasks/crud';
import { ensureSessionRecovery } from '../../src/services/session-recovery';
import { cancelVmTaskAdmission } from '../../src/services/vm-admission-control';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const { ensureTaskRunnerStartedMock, startTaskRunnerDOMock, getUserIdMock } = vi.hoisted(() => ({
  getUserIdMock: vi.fn(() => 'user-1'),
  ensureTaskRunnerStartedMock: vi.fn(async () => false),
  startTaskRunnerDOMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: ensureTaskRunnerStartedMock,
  startTaskRunnerDO: startTaskRunnerDOMock,
}));

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: getUserIdMock,
}));
vi.mock('../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: vi.fn(async () => ({
    status: 'retry',
    reason: 'runtime_deletion_unconfirmed',
  })),
}));
vi.mock('../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn(async () => undefined),
  repairFailedSessionForSnapshotRecovery: vi.fn(async () => undefined),
  linkSessionToWorkspace: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/project-lifecycle-events', () => ({
  recordTaskLifecycleEventBestEffort: vi.fn(async () => undefined),
  isLifecycleTaskStatus: () => true,
}));

async function archive(database: D1Database) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.route('/api/projects/:projectId/tasks', crudRoutes);
  return app.fetch(
    new Request('https://api.test/api/projects/project-1/tasks/task-1/close', {
      method: 'POST',
    }),
    { DATABASE: database } as Env,
    {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext
  );
}

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
  sqlite.prepare(`UPDATE workspaces SET chat_session_id = 'chat-1' WHERE id = 'workspace-1'`).run();
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
    getUserIdMock.mockReturnValue('user-1');
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
          recoverySourceTaskId: 'task-1',
          retrySourceTaskId: null,
        }),
        { reactivate: true }
      );
    } finally {
      sqlite.close();
    }
  });

  it('wakes from an older snapshot after a later confirmed-deleted runtime retained the binding', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite.exec(`
        CREATE UNIQUE INDEX workspace_chat_unique ON workspaces(chat_session_id);
        UPDATE workspaces SET status = 'deleted', chat_session_id = NULL,
          runtime_deletion_confirmed_at = '2026-08-15T01:00:00.000Z' WHERE id = 'workspace-1';
        UPDATE tasks SET workspace_id = NULL WHERE id = 'task-1';
        INSERT INTO workspaces (id, user_id, project_id, node_id, status, chat_session_id,
          runtime_deletion_confirmed_at) VALUES
          ('later-predecessor', 'user-1', 'project-1', 'node-1', 'deleted', 'chat-1',
           '2026-08-15T02:00:00.000Z'),
          ('replacement', 'user-1', 'project-1', 'node-1', 'running', NULL, NULL),
          ('unrelated-live', 'user-1', 'project-1', 'node-1', 'running', 'other-chat', NULL);
      `);
      const database = createSqliteD1(sqlite);
      // Exercise the actual runtime session-link writer, including the production UNIQUE
      // constraint. A wake response alone misses the asynchronous linking failure.
      startTaskRunnerDOMock.mockImplementationOnce(async () => {
        await ensureSessionLinked(
          {
            taskId: 'task-1',
            projectId: 'project-1',
            stepResults: { chatSessionId: 'chat-1' },
            config: { resumeSnapshotChatSessionId: 'chat-1', taskMode: 'conversation' },
          } as TaskRunnerState,
          'replacement',
          {
            env: { DATABASE: database },
            assertRecoveryAuthority: vi.fn(async () => undefined),
          } as unknown as TaskRunnerContext
        );
      });
      let releaseBatch!: () => void;
      let batchClaimed!: () => void;
      const heldBatch = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      const claimed = new Promise<void>((resolve) => {
        batchClaimed = resolve;
      });
      const batch = database.batch.bind(database);
      vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
        batchClaimed();
        await heldBatch;
        return batch(statements);
      });
      const firstWake = wake(database);
      await claimed;
      // Overlap two more callers with the claimed-but-not-started first wake.
      const followers = await Promise.all([wake(database), wake(database)]);
      releaseBatch();
      await expect(firstWake).resolves.toEqual({ status: 'waking', taskId: 'task-1' });
      expect(followers).toEqual([
        { status: 'waking', taskId: 'task-1' },
        { status: 'waking', taskId: 'task-1' },
      ]);
      expect(taskRow(sqlite)).toMatchObject({
        id: 'task-1',
        chat_session_id: 'chat-1',
        workspace_id: 'replacement',
        parent_task_id: 'parent-1',
      });
      expect(
        sqlite.prepare('SELECT id, status, chat_session_id FROM workspaces ORDER BY id').all()
      ).toEqual([
        { id: 'later-predecessor', status: 'deleted', chat_session_id: null },
        { id: 'replacement', status: 'running', chat_session_id: 'chat-1' },
        { id: 'unrelated-live', status: 'running', chat_session_id: 'other-chat' },
        { id: 'workspace-1', status: 'deleted', chat_session_id: null },
      ]);
      expect(
        sqlite.prepare('SELECT snapshot_generation, workspace_id FROM session_snapshots').get()
      ).toEqual({ snapshot_generation: 'generation-final', workspace_id: 'workspace-1' });
      expect(recoveryTaskCount(sqlite)).toBe(0);
      expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['deleted', 'project-1', 'user-1', null, null, false],
    ['running', 'project-1', 'user-1', null, null, false],
    ['stopping', 'project-1', 'user-1', null, null, false],
    ['running', 'project-1', 'user-1', 'confirmed', 'terminated', false],
    ['stopping', 'project-1', 'user-1', 'confirmed', 'terminated', false],
    ['deleted', 'other-project', 'user-1', 'confirmed', null, false],
    ['deleted', 'project-1', 'other-user', 'confirmed', null, false],
    ['deleted', 'project-1', 'user-1', null, 'terminated', true],
  ])(
    'only releases a scoped confirmed-deleted predecessor (%s/%s/%s/%s/%s)',
    async (status, projectId, userId, deletionConfirmed, nodeTerminated, released) => {
      const sqlite = new Database(':memory:');
      try {
        seedStableRecoveryFixture(sqlite);
        sqlite.exec(`CREATE UNIQUE INDEX workspace_chat_unique ON workspaces(chat_session_id);
          UPDATE workspaces SET status = 'deleted', chat_session_id = NULL WHERE id = 'workspace-1';
          UPDATE tasks SET workspace_id = NULL WHERE id = 'task-1';`);
        sqlite
          .prepare(
            `INSERT INTO workspaces
          (id,user_id,project_id,node_id,status,chat_session_id,runtime_deletion_confirmed_at)
          VALUES ('retained',?,?, 'node-1',?,'chat-1',?)`
          )
          .run(userId, projectId, status, deletionConfirmed);
        sqlite.prepare('UPDATE nodes SET runtime_termination_confirmed_at = ?').run(nodeTerminated);
        await wake(createSqliteD1(sqlite));
        expect(
          sqlite.prepare("SELECT chat_session_id FROM workspaces WHERE id='retained'").pluck().get()
        ).toBe(released ? null : 'chat-1');
        expect(
          sqlite.prepare("SELECT status FROM workspaces WHERE id='retained'").pluck().get()
        ).toBe(status);
      } finally {
        sqlite.close();
      }
    }
  );

  it('does not release any predecessor after the claimed attempt is replaced before the batch', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite.exec(`UPDATE workspaces SET chat_session_id = NULL WHERE id = 'workspace-1';
        INSERT INTO workspaces (id,user_id,project_id,status,chat_session_id,runtime_deletion_confirmed_at)
        VALUES ('retained','user-1','project-1','deleted','chat-1','confirmed');`);
      const database = createSqliteD1(sqlite);
      const batch = database.batch.bind(database);
      vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
        sqlite.exec("UPDATE session_snapshots SET recovery_attempt_id = 'newer-attempt'");
        return batch(statements);
      });
      await expect(wake(database)).resolves.toMatchObject({ status: 'unavailable' });
      expect(
        sqlite.prepare("SELECT chat_session_id FROM workspaces WHERE id='retained'").pluck().get()
      ).toBe('chat-1');
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['completed collision cleanup', 'sleeping', null, true, true, -60, -65, true],
    ['cooldown still active', 'sleeping', null, true, true, -2, -65, false],
    ['active task', 'in_progress', null, true, true, -60, -65, false],
    ['assigned runtime', 'sleeping', 'workspace-1', true, true, -60, -65, false],
    ['unconfirmed retained runtime', 'sleeping', null, false, true, -60, -65, false],
    ['unconfirmed snapshot runtime', 'sleeping', null, true, false, -60, -65, false],
    ['failure predates this claim', 'sleeping', null, true, true, -70, -65, false],
    ['live claim lease', 'sleeping', null, true, true, 0, 0, false],
  ])(
    'reconciles only a reported stale collision failure: %s',
    async (
      _label,
      status,
      workspaceId,
      predecessorConfirmed,
      originalConfirmed,
      failedMinutes,
      claimedMinutes,
      canWake
    ) => {
      const sqlite = new Database(':memory:');
      try {
        seedStableRecoveryFixture(sqlite);
        const at = (minutes: number) =>
          new Date(Date.now() + Number(minutes) * 60_000).toISOString();
        const failedAt = at(Number(failedMinutes));
        sqlite.exec(`CREATE UNIQUE INDEX workspace_chat_unique ON workspaces(chat_session_id);
          UPDATE workspaces SET status='deleted', chat_session_id=NULL WHERE id='workspace-1';
          INSERT INTO workspaces (id,user_id,project_id,status,chat_session_id)
          VALUES ('retained','user-1','project-1','deleted','chat-1');`);
        sqlite
          .prepare("UPDATE workspaces SET runtime_deletion_confirmed_at=? WHERE id='workspace-1'")
          .run(originalConfirmed ? at(-90) : null);
        sqlite
          .prepare("UPDATE workspaces SET runtime_deletion_confirmed_at=? WHERE id='retained'")
          .run(predecessorConfirmed ? at(-50) : null);
        sqlite
          .prepare(
            `UPDATE tasks SET status=?,workspace_id=?,updated_at=?,
          error_message='D1_ERROR: UNIQUE constraint failed: workspaces.chat_session_id' WHERE id='task-1'`
          )
          .run(status, workspaceId, failedAt);
        sqlite
          .prepare(
            `UPDATE session_snapshots SET recovery_status='waking',recovery_task_id='task-1',
          recovery_attempt_id='old-attempt',recovery_claimed_at=?,recovery_failed_at=NULL,
          recovery_attempts=3,recovery_workspace_id='workspace-1'`
          )
          .run(at(Number(claimedMinutes)));
        const database = createSqliteD1(sqlite);
        let result;
        if (canWake) {
          let claimed!: () => void;
          let release!: () => void;
          const ready = new Promise<void>((resolve) => {
            claimed = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const batch = database.batch.bind(database);
          vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
            claimed();
            await held;
            return batch(statements);
          });
          const first = wake(database);
          await ready;
          const followers = await Promise.all([wake(database), wake(database)]);
          release();
          result = await first;
          expect(followers).toEqual([
            { status: 'waking', taskId: 'task-1' },
            { status: 'waking', taskId: 'task-1' },
          ]);
        } else {
          result = await wake(database);
        }
        if (canWake) {
          expect(result).toEqual({ status: 'waking', taskId: 'task-1' });
          expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(1);
          expect(
            sqlite
              .prepare('SELECT recovery_attempts,recovery_failed_at FROM session_snapshots')
              .get()
          ).toEqual({ recovery_attempts: 1, recovery_failed_at: null });
          expect(
            sqlite
              .prepare("SELECT chat_session_id FROM workspaces WHERE id='retained'")
              .pluck()
              .get()
          ).toBeNull();
        } else {
          expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
          const snapshot = sqlite
            .prepare('SELECT recovery_attempts,recovery_failed_at FROM session_snapshots')
            .get();
          expect(snapshot).toEqual({
            recovery_attempts: 3,
            recovery_failed_at: _label === 'cooldown still active' ? failedAt : null,
          });
          expect(
            sqlite
              .prepare("SELECT chat_session_id FROM workspaces WHERE id='retained'")
              .pluck()
              .get()
          ).toBe('chat-1');
        }
      } finally {
        sqlite.close();
      }
    }
  );

  it('preserves the coordination channel on the stable task through wake', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite
        .prepare("UPDATE tasks SET coordination_channel = 'feature.wake' WHERE id = 'task-1'")
        .run();
      const result = await wake(createSqliteD1(sqlite));
      expect(result.status).toBe('waking');
      expect(
        sqlite.prepare('SELECT coordination_channel FROM tasks WHERE id = ?').get('task-1')
      ).toEqual({ coordination_channel: 'feature.wake' });
    } finally {
      sqlite.close();
    }
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'allows a human follow-up to a %s conversation',
    async (status) => {
      const sqlite = new Database(':memory:');
      try {
        seedStableRecoveryFixture(sqlite);
        sqlite
          .prepare(
            "UPDATE tasks SET status = ?, completed_at = '2026-08-15T00:00:00.000Z', error_message = 'previous outcome' WHERE id = 'task-1'"
          )
          .run(status);
        const database = createSqliteD1(sqlite);
        await expect(
          ensureSessionRecovery({ DATABASE: database } as Env, 'project-1', 'chat-1')
        ).resolves.toEqual({ status: 'waking', taskId: 'task-1' });
        expect(taskRow(sqlite)).toMatchObject({ status: 'queued', parent_task_id: 'parent-1' });
        expect(
          sqlite.prepare("SELECT completed_at, error_message FROM tasks WHERE id = 'task-1'").get()
        ).toEqual({ completed_at: null, error_message: null });
        expect(recoveryTaskCount(sqlite)).toBe(0);
      } finally {
        sqlite.close();
      }
    }
  );

  it('rolls back completion if atomic snapshot invalidation fails', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite.exec(`CREATE TRIGGER reject_archive BEFORE UPDATE OF sleeping_at ON session_snapshots
        WHEN NEW.sleeping_at IS NULL BEGIN SELECT RAISE(ABORT, 'archive intent unavailable'); END;`);
      const database = createSqliteD1(sqlite);
      expect((await archive(database)).status).toBe(500);
      expect(taskRow(sqlite)).toMatchObject({ status: 'sleeping', workspace_id: 'workspace-1' });
      expect(
        sqlite.prepare('SELECT sleeping_at FROM session_snapshots').pluck().get()
      ).toBeTruthy();
      expect(sqlite.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(0);
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['archive-first', 'user-1'],
    ['claim-first', 'user-1'],
    ['archive-first', 'member-1'],
    ['claim-first', 'member-1'],
  ])('destructive archive fences human recovery (%s, caller %s)', async (ordering, caller) => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite.exec(`INSERT INTO users (id, name, email, github_id, status)
        VALUES ('member-1', 'Member', 'member@example.com', 'gh-member', 'active');
        INSERT INTO project_members (project_id, user_id, role, status)
        VALUES ('project-1', 'member-1', 'maintainer', 'active');`);
      getUserIdMock.mockReturnValue(caller);
      const database = createSqliteD1(sqlite);
      if (ordering === 'archive-first') {
        expect((await archive(database)).status).toBe(caller === 'user-1' ? 409 : 200);
      } else {
        const batch = database.batch.bind(database);
        vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
          // Recovery claimed the snapshot, but has not yet queued the task.
          expect(
            sqlite.prepare('SELECT recovery_status FROM session_snapshots').pluck().get()
          ).toBe('waking');
          expect((await archive(database)).status).toBe(caller === 'user-1' ? 409 : 200);
          return batch(statements);
        });
      }
      await expect(
        ensureSessionRecovery({ DATABASE: database } as Env, 'project-1', 'chat-1')
      ).resolves.toMatchObject({ status: 'unavailable' });
      expect(taskRow(sqlite)).toMatchObject({ status: 'completed', workspace_id: 'workspace-1' });
      expect(sqlite.prepare('SELECT chat_session_id FROM workspaces').pluck().get()).toBe('chat-1');
      expect(
        sqlite
          .prepare(
            'SELECT sleeping_at, recovery_attempt_id, manifest_r2_key FROM session_snapshots'
          )
          .get()
      ).toMatchObject({
        sleeping_at: null,
        recovery_attempt_id: null,
        manifest_r2_key: 'snapshots/chat-1/generation-final/manifest.json',
      });
      expect(
        sqlite
          .prepare("SELECT COUNT(*) FROM task_status_events WHERE to_status = 'queued'")
          .pluck()
          .get()
      ).toBe(0);
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('does not revive a terminal conversation for an automated wake', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      sqlite.exec("UPDATE tasks SET status = 'cancelled' WHERE id = 'task-1'");
      await expect(wake(createSqliteD1(sqlite))).resolves.toMatchObject({ status: 'unavailable' });
      expect(taskRow(sqlite)).toMatchObject({ status: 'cancelled' });
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('requires acknowledgment of this wake attempt after an ambiguous runner response', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      startTaskRunnerDOMock.mockRejectedValueOnce(new Error('RPC interrupted'));
      ensureTaskRunnerStartedMock.mockResolvedValueOnce(false);
      await expect(wake(createSqliteD1(sqlite))).resolves.toMatchObject({ status: 'unavailable' });
      expect(ensureTaskRunnerStartedMock).toHaveBeenCalledWith(
        expect.anything(),
        'task-1',
        expect.any(String)
      );
      expect(
        sqlite
          .prepare("SELECT recovery_status FROM session_snapshots WHERE id = 'snapshot-1'")
          .get()
      ).toEqual({ recovery_status: 'failed' });
      expect(taskRow(sqlite)).toMatchObject({ status: 'sleeping' });
      expect(
        sqlite.prepare("SELECT completed_at FROM tasks WHERE id = 'task-1'").pluck().get()
      ).toBeNull();
      await expect(wake(createSqliteD1(sqlite))).resolves.toMatchObject({
        status: 'waking',
        taskId: 'task-1',
      });
      expect(taskRow(sqlite)).toMatchObject({ status: 'queued' });
    } finally {
      sqlite.close();
    }
  });

  it.each([null, 'older-wake'])(
    'keeps a new wake admission when cleanup arrives from %s',
    async (oldAttempt) => {
      const sqlite = new Database(':memory:');
      try {
        seedStableRecoveryFixture(sqlite);
        sqlite.exec(`UPDATE session_snapshots SET recovery_task_id='task-1', recovery_attempt_id='new-wake';
        UPDATE tasks SET admission_state='provisioning' WHERE id='task-1';
        INSERT INTO vm_task_admissions (task_id,project_id,user_id,provider,credential_domain_key,provider_domain_key,scope_key,requested_vm_size,requested_vm_location,state)
        VALUES ('task-1','project-1','user-1','hetzner','credential','provider','scope','small','nbg1','provisioning');
        INSERT INTO vm_provisioning_leases (scope_key,owner_task_id,provider,credential_domain_key,provider_domain_key,requested_vm_size,expires_at)
        VALUES ('scope','task-1','hetzner','credential','provider','small','2099-01-01');`);
        const env = { DATABASE: createSqliteD1(sqlite) } as Env;
        await cancelVmTaskAdmission(env, 'task-1', 'task_failed', oldAttempt);
        expect(
          sqlite.prepare("SELECT state FROM vm_task_admissions WHERE task_id='task-1'").get()
        ).toEqual({ state: 'provisioning' });
        expect(
          sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()
        ).toEqual({ count: 1 });
        expect(sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()).toEqual(
          { admission_state: 'provisioning' }
        );
        await cancelVmTaskAdmission(env, 'task-1', 'task_failed', 'new-wake');
        expect(
          sqlite.prepare("SELECT state FROM vm_task_admissions WHERE task_id='task-1'").get()
        ).toEqual({ state: 'failed' });
        expect(
          sqlite.prepare('SELECT COUNT(*) AS count FROM vm_provisioning_leases').get()
        ).toEqual({ count: 0 });
        expect(sqlite.prepare("SELECT admission_state FROM tasks WHERE id='task-1'").get()).toEqual(
          { admission_state: 'failed' }
        );
      } finally {
        sqlite.close();
      }
    }
  );

  it('converges repeated wake attempts on the same task id', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedStableRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });
      await expect(wake(database)).resolves.toEqual({ status: 'waking', taskId: 'task-1' });

      expect(recoveryTaskCount(sqlite)).toBe(0);
      expect(
        sqlite
          .prepare(`SELECT recovery_task_id FROM session_snapshots WHERE id = 'snapshot-1'`)
          .get()
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
        sqlite.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = 'task-1'`).get()
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
        sqlite.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = 'task-1'`).get()
      ).toEqual({ count: 2 });
      expect(recoveryTaskCount(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
