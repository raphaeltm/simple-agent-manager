import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { getLocalTaskRuntimeLiveness } from '../../src/durable-objects/project-data/task-runtime-liveness';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
import type { Env } from '../../src/env';
import { getTaskRuntimeLiveness } from '../../src/scheduled/stuck-tasks';
import { needsSessionResumabilityProbe } from '../../src/services/task-runtime-liveness';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

/**
 * Vertical slice (`.claude/rules/35`) for the 2026-08-16 production incident,
 * exercising the real cron adapter against a real SQL engine rather than a
 * `.where()`-ignoring mock — the resumability guard IS a SQL predicate
 * (project + workspace scoped), so `.claude/rules/28` requires a real engine.
 *
 * Row values are the production shapes recovered from `sam-prod`:
 *   workspace 01M06502R3MW9JY75M7WK68B42 / session 8bd22a42-cf37-41fa-9947-30e78a0b6ece
 * which was terminalized with "conclusively gone ... (workspace_deleted)" while
 * its snapshot was asleep and unexpired for another seven days.
 */

const PROJECT_ID = 'project-1';
const WORKSPACE_ID = '01M06502R3MW9JY75M7WK68B42';
const CHAT_SESSION_ID = '8bd22a42-cf37-41fa-9947-30e78a0b6ece';
const NODE_ID = '01M064TG56ECJW1D127H32BRVJ';

const task = { project_id: PROJECT_ID, workspace_id: WORKSPACE_ID };

let sqlite: Database.Database;
let env: Env;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedWorkspace(status: string): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size, vm_location,
                             project_id, chat_session_id, node_id, created_at, updated_at)
     VALUES (?, 'user-1', 'ws', 'org/repo', 'main', ?, 'cpx21', 'nbg1', ?, ?, ?, ?, ?)`
    )
    .run(WORKSPACE_ID, status, PROJECT_ID, CHAT_SESSION_ID, NODE_ID, iso(-3_600_000), iso(0));
}

/** A node that is still healthy — the incident's node was `running`/`healthy`. */
function seedNode(): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at,
                        vm_size, vm_location, cloud_provider, created_at, updated_at)
     VALUES (?, 'user-1', 'node', 'running', 'healthy', ?, 'cpx21', 'nbg1', 'hetzner', ?, ?)`
    )
    .run(NODE_ID, iso(0), iso(-3_600_000), iso(0));
}

function seedSnapshot(
  overrides: {
    projectId?: string;
    workspaceId?: string;
    chatSessionId?: string;
    sleepStatus?: string | null;
    sleepingAt?: string | null;
    expiresAt?: string;
    status?: string;
    degradation?: string;
    recoveryAttempts?: number;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
                                    runtime, status, degradation, manifest_r2_key, home_r2_key,
                                    expires_at, sleeping_at, sleep_status, recovery_attempts,
                                    sleep_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user-1', ?, 'vm', ?, ?, 'manifest-key', 'home-key', ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      'snapshot-1',
      overrides.projectId ?? PROJECT_ID,
      overrides.workspaceId ?? WORKSPACE_ID,
      NODE_ID,
      overrides.chatSessionId ?? CHAT_SESSION_ID,
      overrides.status ?? 'available',
      overrides.degradation ?? 'none',
      overrides.expiresAt ?? iso(7 * 24 * 60 * 60 * 1000),
      overrides.sleepingAt === undefined ? iso(-9 * 60 * 1000) : overrides.sleepingAt,
      overrides.sleepStatus === undefined ? 'sleeping' : overrides.sleepStatus,
      overrides.recoveryAttempts ?? 0,
      iso(-3_600_000),
      iso(0)
    );
}

/** A D1 binding whose `session_snapshots` reads always throw. */
function brokenSnapshotDb(): { DATABASE: unknown } {
  return {
    DATABASE: {
      prepare: (query: string) =>
        query.includes('session_snapshots')
          ? { bind: () => ({ first: () => Promise.reject(new Error('D1 unavailable')) }) }
          : createSqliteD1(sqlite).prepare(query),
    },
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.workspaces, schema.nodes, schema.sessionSnapshots]);
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  seedNode();
});

describe('stuck-task liveness for a slept session', () => {
  it('does not declare a slept, restorable session conclusively dead', async () => {
    // NodeLifecycle rewrote 'sleeping' -> 'deleted' five minutes after the sleep.
    seedWorkspace('deleted');
    seedSnapshot();

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_snapshot_resumable',
      workspaceStatus: 'deleted',
    });
  });

  it('preserves a degraded snapshot the recovery path would still restore', async () => {
    seedWorkspace('deleted');
    seedSnapshot({ status: 'degraded', degradation: 'entries-skipped' });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({ conclusive: false });
  });

  it('still fails a user-deleted workspace whose snapshot row is gone', async () => {
    // Discriminating control: a user delete destroys the snapshot row, so this
    // must terminalize exactly as before. Without this case, the tests above
    // would also pass if terminalization had simply been disabled.
    seedWorkspace('deleted');

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('fails once the snapshot has expired', async () => {
    // Bounded escape path (`.claude/rules/47`): resumability cannot outlive the
    // snapshot, so a task can never be preserved indefinitely.
    seedWorkspace('deleted');
    seedSnapshot({ expiresAt: iso(-1_000) });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('fails when the session already woke', async () => {
    // Every real wake path (`markSessionSnapshotAwakeInPlace`,
    // `completeSessionSnapshotRecovery`) clears sleep_status back to NULL.
    seedWorkspace('deleted');
    seedSnapshot({ sleepStatus: null });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('fails when expires_at is stored unparseable', async () => {
    // Exercises `parseTimestamp`'s NaN -> null path through the REAL loader,
    // not just the pure classifier: a corrupt bound must terminalize, never
    // pin the task open (`.claude/rules/47`).
    seedWorkspace('deleted');
    seedSnapshot({ expiresAt: 'not-a-timestamp' });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('fails once the snapshot has exhausted its wake attempts', async () => {
    // Parity with `claimSessionSnapshotRecovery`, which refuses to claim once
    // recovery_attempts reaches the max. Preserving here would strand the task
    // for the full snapshot TTL waiting on a wake that can never happen.
    seedWorkspace('deleted');
    seedSnapshot({ recoveryAttempts: 3 });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('still preserves while a wake attempt remains', async () => {
    seedWorkspace('deleted');
    seedSnapshot({ recoveryAttempts: 2 });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_snapshot_resumable',
    });
  });

  it('withholds a death verdict when the cron adapter snapshot read fails', async () => {
    // Rule 44 symmetry: the cron adapter has its own try/catch, so it needs its
    // own error-path proof rather than inheriting the DO adapter's.
    seedWorkspace('deleted');

    await expect(
      getTaskRuntimeLiveness(brokenSnapshotDb() as unknown as Env, task)
    ).resolves.toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_resumability_unknown',
    });
  });

  it('ignores a snapshot belonging to a different project', async () => {
    // Proves the `project_id` predicate is evaluated. Deleting it from the
    // query makes this case return `conclusive: false` instead.
    seedWorkspace('deleted');
    seedSnapshot({ projectId: 'project-2' });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('ignores a snapshot belonging to a different workspace', async () => {
    // Proves the `workspace_id` predicate is evaluated.
    seedWorkspace('deleted');
    seedSnapshot({ workspaceId: 'workspace-other' });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('applies the same protection to a stopped workspace', async () => {
    seedWorkspace('stopped');
    seedSnapshot();

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_stopped_snapshot_resumable',
    });
  });

  it('leaves a running workspace on the normal ACP-liveness path', async () => {
    // Owner-path control: a healthy workspace must never be diverted onto the
    // resumability branch, even with a live snapshot row present. Asserting the
    // absence of the resumability reasons is the load-bearing part — asserting
    // only `workspaceStatus` would pass even if the branch had swallowed it.
    seedWorkspace('running');
    seedSnapshot();

    const result = await getTaskRuntimeLiveness(env, task);
    expect(result.workspaceStatus).toBe('running');
    expect(result.reason).not.toContain('snapshot_resumable');
    expect(result.reason).not.toContain('resumability_unknown');
    // Proves the gate itself refuses to probe a running workspace, independent
    // of whatever the downstream ACP probe concludes in this harness.
    expect(
      needsSessionResumabilityProbe(
        {
          id: WORKSPACE_ID,
          status: 'running',
          chatSessionId: CHAT_SESSION_ID,
          nodeId: NODE_ID,
          nodeRuntime: 'vm',
          nodeStatus: 'running',
          nodeHealthStatus: 'healthy',
          nodeHeartbeatAt: Date.now(),
        },
        'ok'
      )
    ).toBe(false);
  });
});

/**
 * `.claude/rules/44` — the classifier gate reads `session_snapshots`, so EVERY
 * adapter that feeds it must supply the signal. There are exactly two in
 * production; this covers the ProjectData one that backs both DO idle sweeps
 * (`processExpiredCleanups` and `checkWorkspaceIdleTimeouts`), which reach the
 * classifier via `terminalizeIdleTaskInD1`.
 */
describe('ProjectData idle-cleanup liveness for a slept session', () => {
  function doEnv(): ProjectDataEnv {
    return { DATABASE: createSqliteD1(sqlite) } as unknown as ProjectDataEnv;
  }

  const doTask = { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID };

  it('preserves a slept, restorable session instead of terminalizing it', async () => {
    seedWorkspace('deleted');
    seedSnapshot();
    const sql = createSqlStorage(new Database(':memory:'));

    await expect(getLocalTaskRuntimeLiveness(sql, doEnv(), doTask)).resolves.toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_snapshot_resumable',
    });
  });

  it('still terminalizes when no snapshot row exists', async () => {
    seedWorkspace('deleted');
    const sql = createSqlStorage(new Database(':memory:'));

    await expect(getLocalTaskRuntimeLiveness(sql, doEnv(), doTask)).resolves.toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  it('withholds a death verdict when the snapshot read fails', async () => {
    seedWorkspace('deleted');
    const sql = createSqlStorage(new Database(':memory:'));
    const broken = brokenSnapshotDb() as unknown as ProjectDataEnv;

    await expect(getLocalTaskRuntimeLiveness(sql, broken, doTask)).resolves.toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_resumability_unknown',
    });
  });
});
