import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runWorkspaceEvictionRecovery } from '../../../src/scheduled/workspace-eviction-recovery';
import { ensureSessionRecovery } from '../../../src/services/session-recovery';
import { claimSessionSnapshotRecovery } from '../../../src/services/session-snapshot-recovery-lifecycle';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/session-recovery', () => ({ ensureSessionRecovery: vi.fn() }));
const now = new Date('2026-10-29T10:00:00.000Z');
let sqlite: Database.Database;
let env: Env;
let pending: Promise<unknown>[];
const waitUntil = (promise: Promise<unknown>) => {
  pending.push(promise);
};

function setting(name: string, value: number) {
  sqlite
    .prepare(
      `INSERT INTO platform_settings (key,value,updated_at,updated_by) VALUES (?,?,?,'admin')`
    )
    .run(name, JSON.stringify(value), now.toISOString());
}

function seed(id = 'one') {
  sqlite
    .prepare(
      `INSERT INTO workspaces
    (id,user_id,project_id,node_id,chat_session_id,name,repository,branch,status,vm_size,vm_location,eviction_generation,created_at,updated_at)
    VALUES (?, 'user','project','node',?, 'Workspace','acme/repo','main','evicted','large','fsn1','generation',?,?)`
    )
    .run('ws-' + id, 'chat-' + id, now.toISOString(), now.toISOString());
  sqlite
    .prepare(
      `INSERT INTO tasks
    (id,project_id,user_id,chat_session_id,title,status,created_by,created_at,updated_at)
    VALUES (?, 'project','user',?,'Task','sleeping','user',?,?)`
    )
    .run('task-' + id, 'chat-' + id, now.toISOString(), now.toISOString());
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
    (id,project_id,workspace_id,node_id,user_id,chat_session_id,runtime,status,degradation,
     manifest_r2_key,expires_at,created_at,updated_at,sleeping_at,recovery_status,recovery_attempts,
     recovery_failed_at,recovery_task_id,recovery_attempt_id,eviction_recovery_workspace_id,
     eviction_recovery_node_id,eviction_recovery_generation)
    VALUES (?, 'project',?,'node','user',?,'vm','available','none','manifest',
      '2026-11-01T00:00:00.000Z',?,?,?,'failed',1,'2026-10-29T09:00:00.000Z',?,?,?,'node','generation')`
    )
    .run(
      'snapshot-' + id,
      'ws-' + id,
      'chat-' + id,
      now.toISOString(),
      '2026-10-29T09:00:00.000Z',
      now.toISOString(),
      'task-' + id,
      'attempt-' + id,
      'ws-' + id
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`INSERT INTO users(id) VALUES ('user');
    INSERT INTO projects(id,user_id,name,normalized_name,installation_id,repository,created_by)
      VALUES ('project','user','Project','project','installation','acme/repo','user');
    INSERT INTO nodes(id,user_id,name,status) VALUES ('node','user','Node','running');`);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  pending = [];
  vi.mocked(ensureSessionRecovery).mockResolvedValue({ status: 'waking', taskId: 'task-one' });
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

describe('failed eviction recovery sweep', () => {
  it('dispatches an accepted wake that subsequently failed, with exact durable retry authority', async () => {
    seed();
    expect(await runWorkspaceEvictionRecovery(env, waitUntil, now)).toEqual({ selected: 1 });
    await Promise.all(pending);
    expect(ensureSessionRecovery).toHaveBeenCalledWith(
      env,
      'project',
      'chat-one',
      {
        taskId: 'task-one',
        projectId: 'project',
        chatSessionId: 'chat-one',
        evictionRecoveryRetry: {
          workspaceId: 'ws-one',
          nodeId: 'node',
          generation: 'generation',
          recoveryAttemptId: 'attempt-one',
          maxAttempts: 3,
        },
      },
      {
        excludedNodeId: 'node',
        evictionFence: { workspaceId: 'ws-one', nodeId: 'node', generation: 'generation' },
        wakeCause: 'runtime_lost',
        interruptedWork: undefined,
      }
    );
    const guard = vi.mocked(ensureSessionRecovery).mock.calls[0]![3];
    const result = await claimSessionSnapshotRecovery(drizzle(env.DATABASE, { schema }), env, {
      chatSessionId: 'chat-one',
      userId: 'user',
      taskId: 'task-one',
      recoveryAttemptId: 'retry',
      sourceTaskGuard: guard,
      now,
    });
    expect(result).toEqual({ status: 'claimed', taskId: 'task-one' });
    expect(
      sqlite
        .prepare(
          'SELECT recovery_status,recovery_attempts,recovery_attempt_id FROM session_snapshots'
        )
        .get()
    ).toEqual({ recovery_status: 'waking', recovery_attempts: 2, recovery_attempt_id: 'retry' });
  });

  it.each([
    "UPDATE tasks SET status='cancelled'",
    "UPDATE tasks SET status='completed'",
    "UPDATE tasks SET user_id='other-user'",
    "UPDATE workspaces SET status='running'",
    "UPDATE workspaces SET eviction_generation='successor'",
    "UPDATE session_snapshots SET eviction_recovery_workspace_id='other-workspace'",
    "UPDATE session_snapshots SET recovery_status='waking'",
    'UPDATE session_snapshots SET recovery_attempts=3',
    "UPDATE session_snapshots SET expires_at='2026-10-29T09:00:00.000Z'",
    "UPDATE session_snapshots SET recovery_failed_at='2026-10-29T09:59:59.000Z'",
  ])('does not select ineligible state: %s', async (mutation) => {
    seed();
    sqlite.exec(mutation);
    expect(await runWorkspaceEvictionRecovery(env, waitUntil, now)).toEqual({ selected: 0 });
    expect(ensureSessionRecovery).not.toHaveBeenCalled();
  });

  it.each([
    "UPDATE tasks SET status='cancelled'",
    "UPDATE tasks SET status='in_progress'",
    "UPDATE workspaces SET eviction_generation='successor'",
    "UPDATE session_snapshots SET workspace_id='successor'",
    "UPDATE session_snapshots SET recovery_attempt_id='newer-attempt'",
    "UPDATE session_snapshots SET recovery_attempts=3,recovery_failed_at='2020-01-01T00:00:00.000Z'",
  ])(
    'atomically rejects post-selection races without decaying spent budgets: %s',
    async (mutation) => {
      seed();
      await runWorkspaceEvictionRecovery(env, waitUntil, now);
      await Promise.all(pending);
      const guard = vi.mocked(ensureSessionRecovery).mock.calls[0]![3];
      sqlite.exec(mutation);
      await claimSessionSnapshotRecovery(drizzle(env.DATABASE, { schema }), env, {
        chatSessionId: 'chat-one',
        userId: 'user',
        taskId: 'task-one',
        recoveryAttemptId: 'retry',
        sourceTaskGuard: guard,
        now,
      });
      expect(
        sqlite.prepare('SELECT recovery_status,recovery_attempt_id FROM session_snapshots').get()
      ).toMatchObject({ recovery_status: 'failed' });
      expect(sqlite.prepare('SELECT recovery_attempt_id FROM session_snapshots').get()).not.toEqual(
        { recovery_attempt_id: 'retry' }
      );
    }
  );

  it('retries a detached source after accepted startup failure without inventing continuation', async () => {
    seed();
    sqlite.exec(`UPDATE workspaces SET chat_session_id = NULL;
      UPDATE session_snapshots SET eviction_recovery_interrupted_work = 0;`);
    expect(await runWorkspaceEvictionRecovery(env, waitUntil, now)).toEqual({ selected: 1 });
    await Promise.all(pending);
    expect(vi.mocked(ensureSessionRecovery).mock.calls[0]![4]).toMatchObject({
      interruptedWork: false,
    });
    const guard = vi.mocked(ensureSessionRecovery).mock.calls[0]![3];
    expect(
      await claimSessionSnapshotRecovery(drizzle(env.DATABASE, { schema }), env, {
        chatSessionId: 'chat-one',
        userId: 'user',
        taskId: 'task-one',
        recoveryAttemptId: 'retry',
        sourceTaskGuard: guard,
        now,
      })
    ).toEqual({ status: 'claimed', taskId: 'task-one' });
  });

  it('limits selection to the configured batch', async () => {
    seed();
    seed('two');
    setting('operations.evictionRecoveryRetryBatchSize', 1);
    expect(await runWorkspaceEvictionRecovery(env, waitUntil, now)).toEqual({ selected: 1 });
    await Promise.all(pending);
    expect(ensureSessionRecovery).toHaveBeenCalledTimes(1);
  });

  it('starts no further retries after the configured wall budget', async () => {
    seed();
    seed('two');
    setting('operations.evictionRecoveryRetryWallMs', 1);
    let clock = now.getTime();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.mocked(ensureSessionRecovery).mockImplementationOnce(async () => {
      clock += 2;
      return { status: 'waking', taskId: 'task-one' };
    });
    await runWorkspaceEvictionRecovery(env, waitUntil, now);
    await Promise.all(pending);
    expect(ensureSessionRecovery).toHaveBeenCalledTimes(1);
  });

  it('concurrent selected retries converge on one durable attempt claim', async () => {
    seed();
    await Promise.all([
      runWorkspaceEvictionRecovery(env, waitUntil, now),
      runWorkspaceEvictionRecovery(env, waitUntil, now),
    ]);
    await Promise.all(pending);
    const guard = vi.mocked(ensureSessionRecovery).mock.calls[0]![3];
    const db = drizzle(env.DATABASE, { schema });
    const results = await Promise.all(
      ['retry-a', 'retry-b'].map((recoveryAttemptId) =>
        claimSessionSnapshotRecovery(db, env, {
          chatSessionId: 'chat-one',
          userId: 'user',
          taskId: 'task-one',
          recoveryAttemptId,
          sourceTaskGuard: guard,
          now,
        })
      )
    );
    expect(results.filter((result) => result.status === 'claimed')).toHaveLength(1);
    expect(sqlite.prepare('SELECT recovery_attempts FROM session_snapshots').get()).toEqual({
      recovery_attempts: 2,
    });
  });

  it.each(['refusal', 'exception'])(
    'rotates blocked rows beyond the batch without altering clean failure budget: %s',
    async (mode) => {
      seed();
      seed('two');
      seed('three');
      setting('operations.evictionRecoveryRetryBatchSize', 1);
      if (mode === 'refusal') {
        vi.mocked(ensureSessionRecovery).mockResolvedValue({
          status: 'unavailable',
          reason: 'workspace_deletion_unconfirmed',
        });
      } else {
        vi.mocked(ensureSessionRecovery).mockRejectedValue(new Error('placement read unavailable'));
      }
      for (let turn = 0; turn < 3; turn++) {
        pending = [];
        await runWorkspaceEvictionRecovery(env, waitUntil, now);
        await Promise.all(pending);
      }
      expect(new Set(vi.mocked(ensureSessionRecovery).mock.calls.map((call) => call[2])).size).toBe(
        3
      );
      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) count FROM session_snapshots WHERE updated_at = ?
        AND recovery_failed_at = '2026-10-29T09:00:00.000Z' AND recovery_attempts = 1`
          )
          .get(now.toISOString())
      ).toEqual({ count: 3 });
      expect(await runWorkspaceEvictionRecovery(env, waitUntil, now)).toEqual({ selected: 0 });
    }
  );

  it('does not rotate a successor claim after a stale preclaim error', async () => {
    seed();
    vi.mocked(ensureSessionRecovery).mockImplementationOnce(async () => {
      sqlite.exec(
        `UPDATE session_snapshots SET recovery_attempt_id = 'successor', updated_at = '2026-10-29T09:30:00.000Z'`
      );
      throw new Error('stale worker response');
    });
    await runWorkspaceEvictionRecovery(env, waitUntil, now);
    await Promise.all(pending);
    expect(
      sqlite.prepare('SELECT recovery_attempt_id, updated_at FROM session_snapshots').get()
    ).toEqual({ recovery_attempt_id: 'successor', updated_at: '2026-10-29T09:30:00.000Z' });
  });

  it('continues after an individual retry error', async () => {
    seed();
    seed('two');
    vi.mocked(ensureSessionRecovery).mockRejectedValueOnce(new Error('D1 transient'));
    await runWorkspaceEvictionRecovery(env, waitUntil, now);
    await Promise.all(pending);
    expect(ensureSessionRecovery).toHaveBeenCalledTimes(2);
  });
});
