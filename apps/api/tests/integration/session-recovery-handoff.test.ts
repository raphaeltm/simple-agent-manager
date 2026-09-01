import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { getTaskRuntimeLiveness } from '../../src/scheduled/stuck-tasks';
import { ensureSessionRecovery } from '../../src/services/session-recovery';
import { isSessionRecoverySourceTaskGuardValid } from '../../src/services/session-recovery-authority';
import { claimSessionSnapshotRecovery } from '../../src/services/session-snapshot-recovery-lifecycle';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const { ensureTaskRunnerStartedMock, startTaskRunnerDOMock } = vi.hoisted(() => ({
  ensureTaskRunnerStartedMock: vi.fn(async () => false),
  startTaskRunnerDOMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/task-runner-do', () => ({
  ensureTaskRunnerStarted: ensureTaskRunnerStartedMock,
  startTaskRunnerDO: startTaskRunnerDOMock,
}));

function seedRecoveryFixture(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.workspaces,
    schema.tasks,
    schema.taskStatusEvents,
    schema.sessionSnapshots,
    schema.agentProfiles,
    schema.nodes,
    schema.credentials,
    schema.capacityPools,
    schema.capacitySources,
    schema.capacityPoolCandidates,
  ]);
  sqlite.exec(`
    INSERT INTO users (id, name, email, github_id)
    VALUES ('user-1', 'Test User', 'test@example.com', 'gh-1');

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

    INSERT INTO workspaces
      (id, user_id, project_id, node_id, status, branch, vm_size, vm_location,
       workspace_profile, chat_session_id, created_at, updated_at)
    VALUES
      ('workspace-1', 'user-1', 'project-1', 'node-1', 'sleeping', 'main', 'small',
       'nbg1', 'lightweight', 'chat-1', '2026-08-15T00:00:00.000Z',
       '2026-08-15T00:00:00.000Z');

    INSERT INTO tasks
      (id, project_id, user_id, chat_session_id, workspace_id, title, description,
       status, execution_step, priority, task_mode, dispatch_depth, triggered_by,
       created_by, created_at, updated_at)
    VALUES
      ('parent-1', 'project-1', 'user-1', 'chat-1', 'workspace-1', 'Parent task',
       'Original work', 'awaiting_followup', NULL, 0, 'conversation', 0, 'mcp',
       'user-1', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');

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
       '2099-08-20T00:00:00.000Z', 'sleeping', '2026-08-15T00:00:00.000Z', 0,
       '2026-08-15T00:00:00.000Z');
  `);
}

function guard() {
  return { taskId: 'parent-1', projectId: 'project-1', chatSessionId: 'chat-1' };
}

async function expectWakingRecovery(
  database: D1Database,
  sourceTaskGuard = guard()
): Promise<{ taskId: string }> {
  const wake = await ensureSessionRecovery(
    { DATABASE: database } as Env,
    'project-1',
    'chat-1',
    sourceTaskGuard
  );
  expect(wake).toMatchObject({ status: 'waking' });
  if (wake.status !== 'waking') throw new Error('wake was not claimable');
  return wake;
}

async function expectUnavailableRecovery(
  database: D1Database,
  reason: string | ReturnType<typeof expect.stringContaining>
): Promise<void> {
  await expect(
    ensureSessionRecovery({ DATABASE: database } as Env, 'project-1', 'chat-1', guard())
  ).resolves.toMatchObject({ status: 'unavailable', reason });
}

function taskOwnership(sqlite: Database.Database, taskId: string) {
  return sqlite
    .prepare(`SELECT status, chat_session_id, superseded_by_task_id FROM tasks WHERE id = ?`)
    .get(taskId);
}

function expectTaskOwnership(
  sqlite: Database.Database,
  taskId: string,
  expected: Record<string, unknown>
): void {
  expect(taskOwnership(sqlite, taskId)).toMatchObject(expected);
}

function markWorkspaceDeleted(sqlite: Database.Database): void {
  sqlite.prepare(`UPDATE workspaces SET status = 'deleted' WHERE id = 'workspace-1'`).run();
}

function markRecoveryTaskRunning(sqlite: Database.Database, taskId: string): void {
  sqlite
    .prepare(
      `UPDATE tasks
          SET status = 'in_progress', execution_step = 'running',
              workspace_id = 'workspace-1', started_at = ?, updated_at = ?
        WHERE id = ?`
    )
    .run('2026-08-15T00:01:00.000Z', '2026-08-15T00:01:00.000Z', taskId);
}

function makeSnapshotClaimable(sqlite: Database.Database, sleepingAt: string): void {
  sqlite
    .prepare(
      `UPDATE session_snapshots
          SET recovery_status = NULL, recovery_task_id = NULL, sleep_status = 'sleeping',
              sleeping_at = ?, recovery_attempts = 0
        WHERE chat_session_id = 'chat-1'`
    )
    .run(sleepingAt);
}

function expectWorkspaceChatOwner(sqlite: Database.Database): void {
  expect(
    sqlite.prepare(`SELECT chat_session_id FROM workspaces WHERE id = 'workspace-1'`).get()
  ).toEqual({ chat_session_id: 'chat-1' });
}

describe('session recovery handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureTaskRunnerStartedMock.mockResolvedValue(false);
    startTaskRunnerDOMock.mockResolvedValue(undefined);
  });

  it('atomically transfers the session binding to a recovery task linked to its source', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      const wake = await expectWakingRecovery(database);

      expect(
        sqlite
          .prepare(
            `SELECT id, chat_session_id, recovery_source_task_id, triggered_by
               FROM tasks WHERE triggered_by = 'session-recovery'`
          )
          .get()
      ).toMatchObject({
        chat_session_id: 'chat-1',
        recovery_source_task_id: 'parent-1',
        triggered_by: 'session-recovery',
      });
      expectTaskOwnership(sqlite, 'parent-1', {
        chat_session_id: null,
        superseded_by_task_id: wake.taskId,
      });
      expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  /**
   * Rule 62: reach the classifier through the REAL writer. The unit suite
   * simulates the handoff's chat-binding strip by hand; this drives the actual
   * `ensureSessionRecovery` -> `createRecoveryTask` batch and then asks the real
   * sweep classifier about the predecessor it left behind. If the writer's SQL
   * ever changes shape, this is the test that notices — the hand-rolled fixture
   * would not.
   */
  it('leaves a predecessor the real handoff produced classified as superseded, not dead', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      await expectWakingRecovery(database);

      // The predecessor is exactly as the real batch left it: in_progress, chat
      // binding stripped, and (once NodeLifecycle reaps it) workspace deleted.
      markWorkspaceDeleted(sqlite);

      await expect(
        getTaskRuntimeLiveness({ DATABASE: database } as Env, {
          id: 'parent-1',
          project_id: 'project-1',
          workspace_id: 'workspace-1',
        })
      ).resolves.toMatchObject({
        live: false,
        conclusive: false,
        reason: 'workspace_deleted_superseded_by_live_wake',
      });
    } finally {
      sqlite.close();
    }
  });

  it('creates a direct-child successor for a guarded recovery middle link and protects that middle link', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      const firstWake = await expectWakingRecovery(database);

      const middleTaskId = firstWake.taskId;
      markRecoveryTaskRunning(sqlite, middleTaskId);
      makeSnapshotClaimable(sqlite, '2026-08-15T00:02:00.000Z');

      const secondWake = await expectWakingRecovery(database, {
        taskId: middleTaskId,
        projectId: 'project-1',
        chatSessionId: 'chat-1',
      });

      expect(
        sqlite
          .prepare(
            `SELECT recovery_source_task_id, chat_session_id, triggered_by
               FROM tasks WHERE id = ?`
          )
          .get(secondWake.taskId)
      ).toMatchObject({
        recovery_source_task_id: middleTaskId,
        chat_session_id: 'chat-1',
        triggered_by: 'session-recovery',
      });
      expectTaskOwnership(sqlite, middleTaskId, {
        chat_session_id: null,
        superseded_by_task_id: secondWake.taskId,
      });

      markWorkspaceDeleted(sqlite);

      await expect(
        getTaskRuntimeLiveness({ DATABASE: database } as Env, {
          id: middleTaskId,
          project_id: 'project-1',
          workspace_id: 'workspace-1',
        })
      ).resolves.toMatchObject({
        live: false,
        conclusive: false,
        reason: 'workspace_deleted_superseded_by_live_wake',
      });
    } finally {
      sqlite.close();
    }
  });

  it('keeps ownership coherent through three guarded sleep/wake cycles', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      const firstWake = await expectWakingRecovery(database);
      markRecoveryTaskRunning(sqlite, firstWake.taskId);
      makeSnapshotClaimable(sqlite, '2026-08-15T00:02:00.000Z');

      const secondWake = await expectWakingRecovery(database, {
        taskId: firstWake.taskId,
        projectId: 'project-1',
        chatSessionId: 'chat-1',
      });
      markRecoveryTaskRunning(sqlite, secondWake.taskId);
      makeSnapshotClaimable(sqlite, '2026-08-15T00:03:00.000Z');

      const thirdWake = await expectWakingRecovery(database, {
        taskId: secondWake.taskId,
        projectId: 'project-1',
        chatSessionId: 'chat-1',
      });

      expectTaskOwnership(sqlite, firstWake.taskId, {
        status: 'in_progress',
        chat_session_id: null,
        superseded_by_task_id: secondWake.taskId,
      });
      expectTaskOwnership(sqlite, secondWake.taskId, {
        status: 'in_progress',
        chat_session_id: null,
        superseded_by_task_id: thirdWake.taskId,
      });
      expect(
        sqlite.prepare(`SELECT status, chat_session_id FROM tasks WHERE id = ?`).get(thirdWake.taskId)
      ).toMatchObject({ status: 'queued', chat_session_id: 'chat-1' });

      markWorkspaceDeleted(sqlite);
      const secondVerdict = await getTaskRuntimeLiveness({ DATABASE: database } as Env, {
        id: secondWake.taskId,
        project_id: 'project-1',
        workspace_id: 'workspace-1',
      });
      expect(secondVerdict.reason).toBe('workspace_deleted_superseded_by_live_wake');
      expect(taskOwnership(sqlite, secondWake.taskId)).not.toMatchObject({ status: 'failed' });
    } finally {
      sqlite.close();
    }
  });

  it('treats guarded and unguarded wake handoffs as the same durable ownership marker', async () => {
    const guardedSqlite = new Database(':memory:');
    const unguardedSqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(guardedSqlite);
      const guardedDb = createSqliteD1(guardedSqlite);
      const guardedWake = await expectWakingRecovery(guardedDb, guard());

      seedRecoveryFixture(unguardedSqlite);
      const unguardedDb = createSqliteD1(unguardedSqlite);
      const unguardedWake = await ensureSessionRecovery(
        { DATABASE: unguardedDb } as Env,
        'project-1',
        'chat-1'
      );
      expect(unguardedWake).toMatchObject({ status: 'waking' });
      if (unguardedWake.status !== 'waking') throw new Error('unguarded wake was not claimable');

      expectTaskOwnership(guardedSqlite, 'parent-1', {
        chat_session_id: null,
        superseded_by_task_id: guardedWake.taskId,
      });
      expectTaskOwnership(unguardedSqlite, 'parent-1', {
        chat_session_id: null,
        superseded_by_task_id: unguardedWake.taskId,
      });
    } finally {
      guardedSqlite.close();
      unguardedSqlite.close();
    }
  });

  it('keeps a cancelled superseded source wakeable when its exact successor is live', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      const firstWake = await expectWakingRecovery(database);
      markRecoveryTaskRunning(sqlite, firstWake.taskId);
      sqlite.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = 'parent-1'`).run();

      await expect(isSessionRecoverySourceTaskGuardValid(database, guard())).resolves.toBe(true);

      makeSnapshotClaimable(sqlite, '2026-08-15T00:02:00.000Z');
      const drizzled = drizzle(database, { schema });
      await expect(
        claimSessionSnapshotRecovery(drizzled, {} as Env, {
          chatSessionId: 'chat-1',
          userId: 'user-1',
          taskId: '01M064TGCLAIMCANCEL000000',
          sourceTaskGuard: guard(),
        })
      ).resolves.toMatchObject({ status: 'claimed' });

      sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(firstWake.taskId);
      await expect(isSessionRecoverySourceTaskGuardValid(database, guard())).resolves.toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('marks the exact root-family owner during a guarded owner-path handoff', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      const firstWake = await expectWakingRecovery(database);

      markRecoveryTaskRunning(sqlite, firstWake.taskId);
      makeSnapshotClaimable(sqlite, '2026-08-15T00:02:00.000Z');

      const secondWake = await expectWakingRecovery(database);

      expectTaskOwnership(sqlite, 'parent-1', {
        chat_session_id: null,
        superseded_by_task_id: firstWake.taskId,
      });
      expectTaskOwnership(sqlite, firstWake.taskId, {
        chat_session_id: null,
        superseded_by_task_id: secondWake.taskId,
      });
      expect(
        sqlite.prepare(`SELECT chat_session_id FROM tasks WHERE id = ?`).get(secondWake.taskId)
      ).toEqual({ chat_session_id: 'chat-1' });
    } finally {
      sqlite.close();
    }
  });

  /**
   * The load-bearing justification for this whole fix: `sourceTaskGuardCondition`
   * requires the source task to be NON-terminal, so a falsely-failed predecessor
   * permanently revokes the guarded/parent-wake path. This proves the capability
   * actually survives — not merely that the label is nicer.
   */
  it('keeps the guarded wake path claimable after the predecessor is classified', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);

      await expectWakingRecovery(database);
      markWorkspaceDeleted(sqlite);

      // The sweep evaluates the predecessor and must not terminalize it...
      const verdict = await getTaskRuntimeLiveness({ DATABASE: database } as Env, {
        id: 'parent-1',
        project_id: 'project-1',
        workspace_id: 'workspace-1',
      });
      expect(verdict.conclusive).toBe(false);
      // The exact status does not matter; staying NON-TERMINAL is what
      // `sourceTaskGuardCondition` requires.
      expect(
        sqlite.prepare(`SELECT status FROM tasks WHERE id = 'parent-1'`).get()
      ).not.toMatchObject({ status: 'failed' });

      // ...so a subsequent guarded claim against that same source still resolves.
      // Pre-fix, the sweep would have marked parent-1 failed and this claim would
      // have been refused with `source_task_not_wakeable`.
      const drizzled = drizzle(database, { schema });
      makeSnapshotClaimable(sqlite, new Date(Date.now() - 60_000).toISOString());
      const claim = await claimSessionSnapshotRecovery(drizzled, {} as Env, {
        chatSessionId: 'chat-1',
        userId: 'user-1',
        taskId: '01M064TGCLAIMAGAIN0000000',
        sourceTaskGuard: guard(),
      });
      expect(claim.status).not.toBe('unavailable');
    } finally {
      sqlite.close();
    }
  });

  it('still lets an explicit user follow-up resume a completed conversation', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'parent-1'`).run();
      const database = createSqliteD1(sqlite);

      await expect(
        ensureSessionRecovery({ DATABASE: database } as Env, 'project-1', 'chat-1')
      ).resolves.toMatchObject({ status: 'waking' });

      expect(
        sqlite
          .prepare(
            `SELECT chat_session_id, recovery_source_task_id
               FROM tasks WHERE triggered_by = 'session-recovery'`
          )
          .get()
      ).toEqual({ chat_session_id: 'chat-1', recovery_source_task_id: 'parent-1' });
      expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('does not detach or create recovery work when the parent terminalizes at the batch barrier', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const base = createSqliteD1(sqlite);
      let crossedBarrier = false;
      const database = {
        ...base,
        batch: async (statements: D1PreparedStatement[]) => {
          crossedBarrier = true;
          sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'parent-1'`).run();
          return base.batch(statements);
        },
      } as D1Database;

      await expectUnavailableRecovery(database, 'source_task_not_wakeable');

      expect(crossedBarrier).toBe(true);
      expectTaskOwnership(sqlite, 'parent-1', {
        status: 'completed',
        chat_session_id: 'chat-1',
        superseded_by_task_id: null,
      });
      expectWorkspaceChatOwner(sqlite);
      expect(
        sqlite
          .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE triggered_by = 'session-recovery'`)
          .get()
      ).toEqual({ count: 0 });
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('revokes a completed handoff when the parent terminalizes before runner start', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const base = createSqliteD1(sqlite);
      let batchCount = 0;
      const database = {
        ...base,
        batch: async (statements: D1PreparedStatement[]) => {
          batchCount += 1;
          const result = await base.batch(statements);
          if (batchCount === 1) {
            sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'parent-1'`).run();
          }
          return result;
        },
      } as D1Database;

      await expectUnavailableRecovery(database, 'source_task_not_wakeable');

      expect(batchCount).toBe(2);
      expectTaskOwnership(sqlite, 'parent-1', {
        status: 'completed',
        chat_session_id: 'chat-1',
        superseded_by_task_id: null,
      });
      expect(
        sqlite
          .prepare(
            `SELECT status, chat_session_id, recovery_source_task_id
               FROM tasks WHERE triggered_by = 'session-recovery'`
          )
          .get()
      ).toEqual({
        status: 'cancelled',
        chat_session_id: null,
        recovery_source_task_id: 'parent-1',
      });
      expectWorkspaceChatOwner(sqlite);
      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('restores ownership after a definite runner-start failure so a later wake can retry', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);
      startTaskRunnerDOMock.mockRejectedValueOnce(new Error('runner start rejected'));

      await expectUnavailableRecovery(database, expect.stringContaining('recovery_start_failed'));

      expectTaskOwnership(sqlite, 'parent-1', {
        status: 'awaiting_followup',
        chat_session_id: 'chat-1',
        superseded_by_task_id: null,
      });
      expect(
        sqlite
          .prepare(
            `SELECT status, chat_session_id
               FROM tasks WHERE triggered_by = 'session-recovery'
               ORDER BY created_at ASC LIMIT 1`
          )
          .get()
      ).toEqual({ status: 'failed', chat_session_id: null });
      expectWorkspaceChatOwner(sqlite);

      await expectWakingRecovery(database);
      expect(startTaskRunnerDOMock).toHaveBeenCalledTimes(2);
    } finally {
      sqlite.close();
    }
  });

  it('rechecks the parent after runner inspection and before crossing the start boundary', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);
      ensureTaskRunnerStartedMock.mockImplementationOnce(async () => {
        sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'parent-1'`).run();
        return false;
      });

      await expectUnavailableRecovery(database, 'source_task_not_wakeable');

      expect(startTaskRunnerDOMock).not.toHaveBeenCalled();
      expectTaskOwnership(sqlite, 'parent-1', {
        status: 'completed',
        chat_session_id: 'chat-1',
        superseded_by_task_id: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('restores the handoff when revocation is detected inside the runner start boundary', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedRecoveryFixture(sqlite);
      const database = createSqliteD1(sqlite);
      startTaskRunnerDOMock.mockImplementationOnce(async (_env, input) => {
        expect(input).toMatchObject({ recoverySourceTaskId: 'parent-1' });
        sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 'parent-1'`).run();
        throw new Error('Session recovery authority was revoked');
      });

      await expectUnavailableRecovery(database, expect.stringContaining('recovery_start_failed'));

      expectTaskOwnership(sqlite, 'parent-1', {
        status: 'completed',
        chat_session_id: 'chat-1',
        superseded_by_task_id: null,
      });
      expect(
        sqlite
          .prepare(
            `SELECT status, chat_session_id
               FROM tasks WHERE triggered_by = 'session-recovery'`
          )
          .get()
      ).toEqual({ status: 'failed', chat_session_id: null });
      expectWorkspaceChatOwner(sqlite);
    } finally {
      sqlite.close();
    }
  });
});
