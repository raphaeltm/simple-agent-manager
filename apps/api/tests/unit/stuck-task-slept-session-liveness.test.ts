import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import { getLocalTaskRuntimeLiveness } from '../../src/durable-objects/project-data/task-runtime-liveness';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
import type { Env } from '../../src/env';
import { getTaskRuntimeLiveness } from '../../src/scheduled/stuck-tasks';
import {
  isSupersededTerminalReason,
  needsSessionResumabilityProbe,
  needsTaskSupersessionProbe,
} from '../../src/services/task-runtime-liveness';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(),
}));
vi.mock('../../src/services/fetch-timeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/fetch-timeout')>();
  return {
    ...actual,
    fetchWithTimeout: fetchWithTimeoutMock,
  };
});

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

const TASK_ID = '01M064TG9QK8ZQ3XW0M6P7RCTN';
const task = { id: TASK_ID, project_id: PROJECT_ID, workspace_id: WORKSPACE_ID };

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

function makeNodeHeartbeatStale(): void {
  sqlite
    .prepare(`UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?`)
    .run(iso(-10 * 60 * 1000), NODE_ID);
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

/**
 * The task under classification. `seedRecoverySuccessor` below adds the wake
 * successor that supersedes it; without one, this task is an ordinary
 * non-superseded task and every pre-existing verdict must be unchanged.
 */
function seedTask(
  id: string,
  overrides: {
    status?: string;
    triggeredBy?: string;
    recoverySourceTaskId?: string | null;
    createdAt?: string;
    chatSessionId?: string | null;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                        triggered_by, recovery_source_task_id, chat_session_id,
                        created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, 'task', ?, 0, ?, ?, ?, 'user-1', ?, ?)`
    )
    .run(
      id,
      PROJECT_ID,
      WORKSPACE_ID,
      overrides.status ?? 'in_progress',
      overrides.triggeredBy ?? 'user',
      overrides.recoverySourceTaskId ?? null,
      overrides.chatSessionId === undefined ? CHAT_SESSION_ID : overrides.chatSessionId,
      overrides.createdAt ?? iso(-3_600_000),
      iso(0)
    );
}

/**
 * Reproduce statements 2 and 3 of the `createRecoveryTask` handoff batch, which
 * strip the chat binding from the previous owner and its workspace. This is what
 * makes the resumability probe unreachable for a superseded task, so any test
 * asserting supersession behaviour must apply it rather than assume it.
 */
function nullOutHandoffBindings(): void {
  sqlite.prepare(`UPDATE tasks SET chat_session_id = NULL WHERE id = ?`).run(TASK_ID);
  sqlite.prepare(`UPDATE workspaces SET chat_session_id = NULL WHERE id = ?`).run(WORKSPACE_ID);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.workspaces,
    schema.nodes,
    schema.sessionSnapshots,
    schema.tasks,
  ]);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockReset();
  fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 200 }));
  seedNode();
  seedTask(TASK_ID);
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
          runningWorkspacesOnNode: 1,
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
    return {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
    } as unknown as ProjectDataEnv;
  }

  const doTask = { taskId: TASK_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID };

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

/**
 * First P0 regression from the 2026-08-25 production audit. The stale D1 node
 * heartbeat is intentionally combined with a still-running workspace row, then
 * exercised through the ProjectData liveness adapter — the same guard must hold
 * here and in the cron sweep (`.claude/rules/61`).
 */
describe('ProjectData idle-cleanup liveness for a stale VM node heartbeat', () => {
  const doTask = { taskId: TASK_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID };

  function doEnv(): ProjectDataEnv {
    return {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
    } as unknown as ProjectDataEnv;
  }

  function sqlWithAcpSession(
    opts: {
      acpId?: string;
      lastHeartbeatAt?: number | null;
      updatedAt?: number;
      startedAt?: number;
      sessionState?: {
        activity: string;
        activityAt: number;
        promptStartedAt?: number | null;
        runtimeWorkState?: 'inactive' | 'active' | 'settling' | null;
        runtimeWorkUpdatedAt?: number | null;
        runtimeWorkProgressAt?: number | null;
      };
    } = {}
  ): SqlStorage {
    const db = new Database(':memory:');
    const sql = createSqlStorage(db);
    runMigrations(sql);
    const now = Date.now();
    const acpId = opts.acpId ?? 'acp-live';
    const updatedAt = opts.updatedAt ?? now;
    const startedAt = opts.startedAt ?? now - 60_000;
    const lastHeartbeatAt = opts.lastHeartbeatAt === undefined ? now : opts.lastHeartbeatAt;
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Task', 'active', 0, ?, ?, ?)`,
      CHAT_SESSION_ID,
      WORKSPACE_ID,
      TASK_ID,
      now - 60_000,
      now - 60_000,
      now
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status, agent_type, last_heartbeat_at, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, 'running', 'codex', ?, ?, ?, ?)`,
      acpId,
      CHAT_SESSION_ID,
      WORKSPACE_ID,
      NODE_ID,
      lastHeartbeatAt,
      now - 60_000,
      updatedAt,
      startedAt
    );
    if (opts.sessionState) {
      sql.exec(
        `INSERT INTO session_state (
           session_id, activity, activity_at, prompt_started_at, restart_count,
           runtime_work_state, runtime_work_count, runtime_work_source,
           runtime_work_updated_at, runtime_work_progress_at
         )
         VALUES (?, ?, ?, ?, 0, ?, ?, 'test', ?, ?)`,
        acpId,
        opts.sessionState.activity,
        opts.sessionState.activityAt,
        opts.sessionState.promptStartedAt ?? null,
        opts.sessionState.runtimeWorkState ?? null,
        opts.sessionState.runtimeWorkState ? 1 : null,
        opts.sessionState.runtimeWorkUpdatedAt ?? null,
        opts.sessionState.runtimeWorkProgressAt ?? null
      );
    }
    return sql;
  }

  function sqlWithLiveAcpSession(): SqlStorage {
    return sqlWithAcpSession();
  }

  beforeEach(() => {
    seedWorkspace('running');
    makeNodeHeartbeatStale();
  });

  it('uses the successful node health probe, then proves the task live from local ACP state', async () => {
    const verdict = await getLocalTaskRuntimeLiveness(sqlWithLiveAcpSession(), doEnv(), doTask);

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      'https://01m064tg56ecjw1d127h32brvj.vm.example.test:8443/health',
      { method: 'GET' },
      5_000
    );
    expect(verdict).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_acp_session_live',
      activeAcpSessionId: 'acp-live',
    });
  });

  it('returns conclusive node_not_live only after a failed node health probe', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    const verdict = await getLocalTaskRuntimeLiveness(sqlWithLiveAcpSession(), doEnv(), doTask);

    expect(verdict).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'node_not_live',
    });
  });

  it('preserves the task when the node health probe times out', async () => {
    fetchWithTimeoutMock.mockRejectedValueOnce(
      new Error('Request timed out after 5000ms: https://node-1.vm.example.test:8443/health')
    );

    const verdict = await getLocalTaskRuntimeLiveness(sqlWithLiveAcpSession(), doEnv(), doTask);

    expect(verdict).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'node_health_probe_timeout',
    });
  });

  it('uses fresh prompt-turn state when ACP heartbeat writes are stale', async () => {
    const now = Date.now();
    const staleAt = now - 10 * 60 * 1000;

    const verdict = await getLocalTaskRuntimeLiveness(
      sqlWithAcpSession({
        lastHeartbeatAt: staleAt,
        updatedAt: staleAt,
        startedAt: staleAt,
        sessionState: {
          activity: 'prompting',
          activityAt: now - 30_000,
          promptStartedAt: staleAt,
        },
      }),
      doEnv(),
      doTask
    );

    expect(verdict).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_prompt_turn_active',
      activeAcpSessionId: 'acp-live',
    });
  });

  it('uses fresh runtime-work state when ACP heartbeat writes are absent', async () => {
    const now = Date.now();
    const staleAt = now - 10 * 60 * 1000;

    const verdict = await getLocalTaskRuntimeLiveness(
      sqlWithAcpSession({
        lastHeartbeatAt: null,
        updatedAt: staleAt,
        startedAt: staleAt,
        sessionState: {
          activity: 'idle',
          activityAt: staleAt,
          runtimeWorkState: 'active',
          runtimeWorkUpdatedAt: now - 30_000,
          runtimeWorkProgressAt: now - 60_000,
        },
      }),
      doEnv(),
      doTask
    );

    expect(verdict).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_runtime_work_active',
      activeAcpSessionId: 'acp-live',
    });
  });

  it('treats stale prompt-turn ProjectData state as suspect instead of terminal death', async () => {
    const now = Date.now();
    const staleAt = now - 10 * 60 * 1000;

    const verdict = await getLocalTaskRuntimeLiveness(
      sqlWithAcpSession({
        lastHeartbeatAt: staleAt,
        updatedAt: staleAt,
        startedAt: staleAt,
        sessionState: {
          activity: 'prompting',
          activityAt: staleAt,
          promptStartedAt: staleAt,
        },
      }),
      doEnv(),
      doTask
    );

    expect(verdict).toMatchObject({
      live: false,
      conclusive: false,
      reason: 'task_acp_session_stale',
      activeAcpSessionId: null,
    });
  });
});

/**
 * Regression suite for the 2026-08-24 production incident: a *successful* wake
 * marks its own predecessor "failed".
 *
 * `session-recovery.ts:createRecoveryTask` commits the handoff as one D1 batch
 * that mints a successor, nulls `tasks.chat_session_id` AND
 * `workspaces.chat_session_id` on the previous owner, and then terminalizes
 * nothing. The predecessor is left `in_progress` with a deleted workspace — the
 * exact shape the sweep reads as runtime death — so it was failed on average
 * ~24 minutes later while its conversation carried on in the successor.
 *
 * Production (`sam-prod`, 2026-08-15..24): 61 of 91 `conclusively gone
 * (workspace_deleted)` kills were superseded tasks — 25 with a direct successor
 * and 36 middle links whose successor points past them to the root.
 *
 * This is not merely mislabelling. `sourceTaskGuardCondition`
 * (`session-snapshot-recovery-lifecycle.ts:34`) requires the source task to be
 * NON-terminal, and `sourceTaskGuard` is supplied for every `parent_wakeup`
 * delivery (`project-data/prompt-delivery-runner.ts:194`). Failing a superseded
 * predecessor therefore permanently revokes the durable parent-wake path for
 * that conversation — all 34 production roots with recovery children were
 * `failed`. Hence the fix keeps the predecessor non-terminal (`.claude/rules/58`).
 */
describe('task supersession — a successful wake must not fail its predecessor', () => {
  const SUCCESSOR_ID = '01M0SDBZXG5AEGZJ0JH2YC30Q4';

  /** The wake successor `createRecoveryTask` mints, with a fresh ULID. */
  function seedRecoverySuccessor(
    overrides: { status?: string; rootId?: string; createdAt?: string; id?: string } = {}
  ): void {
    seedTask(overrides.id ?? SUCCESSOR_ID, {
      status: overrides.status ?? 'in_progress',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: overrides.rootId ?? TASK_ID,
      createdAt: overrides.createdAt ?? iso(-60_000),
      chatSessionId: CHAT_SESSION_ID,
    });
  }

  /**
   * The incident, reproduced. The handoff nulls the predecessor's chat binding,
   * so the resumability probe cannot even run (`needsSessionResumabilityProbe`
   * is gated on `workspace.chatSessionId !== null` — `.claude/rules/63`).
   * Supersession is the only signal left that the conversation is alive.
   */
  it('preserves a predecessor whose conversation a live successor now owns', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedRecoverySuccessor();

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      live: false,
      conclusive: false,
      reason: 'workspace_deleted_superseded_by_live_wake',
    });
  });

  /**
   * Chain collapse: `createRecoveryTask` resolves its source as
   * `guard ?? sourceTask.recoverySourceTaskId ?? sourceTask.id`, so a second
   * wake points at the ROOT, never at the middle link it actually replaced.
   * 36 of the 61 production cases have this shape. A direct-child check would
   * miss every one of them.
   */
  it('preserves a middle link superseded by a sibling that points at the root', async () => {
    const ROOT_ID = '01M064TG00ROOT00000000000';
    const MIDDLE_ID = '01M064TG11MIDDLE000000000';
    seedTask(ROOT_ID, { status: 'failed', createdAt: iso(-7_200_000), chatSessionId: null });
    seedTask(MIDDLE_ID, {
      status: 'in_progress',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: ROOT_ID,
      createdAt: iso(-3_600_000),
      chatSessionId: null,
    });
    // The newest wake also points at ROOT, not at MIDDLE.
    seedRecoverySuccessor({ rootId: ROOT_ID, createdAt: iso(-60_000) });
    seedWorkspace('deleted');

    await expect(
      getTaskRuntimeLiveness(env, {
        id: MIDDLE_ID,
        project_id: PROJECT_ID,
        workspace_id: WORKSPACE_ID,
      })
    ).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_superseded_by_live_wake',
    });
  });

  /**
   * 2026-08-26 production incident: a guarded wake can point the successor at
   * the recovery middle link itself. The previous root-family predicate missed
   * this shape because `COALESCE(self.recovery_source_task_id, self.id)` reduced
   * the middle link to its root and never matched `owner.recovery_source_task_id
   * = self.id`.
   */
  it('preserves a recovery middle link superseded by a direct child wake', async () => {
    const ROOT_ID = '01M064TG00ROOT00000000000';
    const MIDDLE_ID = '01M064TG11MIDDLE000000000';
    const DIRECT_CHILD_ID = '01M064TG22DIRECT00000000';
    seedTask(MIDDLE_ID, {
      status: 'in_progress',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: ROOT_ID,
      createdAt: iso(-3_600_000),
      chatSessionId: null,
    });
    seedRecoverySuccessor({
      id: DIRECT_CHILD_ID,
      rootId: MIDDLE_ID,
      createdAt: iso(-6 * 60_000),
    });
    seedWorkspace('deleted');
    sqlite.prepare(`UPDATE workspaces SET chat_session_id = NULL WHERE id = ?`).run(WORKSPACE_ID);

    await expect(
      getTaskRuntimeLiveness(env, {
        id: MIDDLE_ID,
        project_id: PROJECT_ID,
        workspace_id: WORKSPACE_ID,
      })
    ).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_superseded_by_live_wake',
    });
  });

  it('terminalizes a direct-child superseded middle link benignly once the child ends', async () => {
    const ROOT_ID = '01M064TG00ROOT00000000000';
    const MIDDLE_ID = '01M064TG11MIDDLE000000000';
    const DIRECT_CHILD_ID = '01M064TG22DIRECT00000000';
    seedTask(MIDDLE_ID, {
      status: 'in_progress',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: ROOT_ID,
      createdAt: iso(-3_600_000),
      chatSessionId: null,
    });
    seedRecoverySuccessor({
      id: DIRECT_CHILD_ID,
      rootId: MIDDLE_ID,
      status: 'completed',
      createdAt: iso(-6 * 60_000),
    });
    seedWorkspace('deleted');
    sqlite.prepare(`UPDATE workspaces SET chat_session_id = NULL WHERE id = ?`).run(WORKSPACE_ID);

    const verdict = await getTaskRuntimeLiveness(env, {
      id: MIDDLE_ID,
      project_id: PROJECT_ID,
      workspace_id: WORKSPACE_ID,
    });
    expect(verdict).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_deleted_superseded_by_completed_wake',
    });
    expect(isSupersededTerminalReason(verdict.reason)).toBe(true);
  });

  /**
   * Discriminating control (`.claude/rules/58`). Without this, the suite passes
   * equally well with terminalization disabled outright.
   */
  /**
   * Discriminating control (`.claude/rules/58`): the task must still leave the
   * candidate set once the conversation is over. But it ended by supersession,
   * so the verdict carries the benign marker rather than the runtime-death
   * reason — that marker is what makes the sweep record `cancelled`.
   */
  it('terminalizes benignly once the whole recovery family has ended', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedRecoverySuccessor({ status: 'failed' });

    const verdict = await getTaskRuntimeLiveness(env, task);
    expect(verdict).toMatchObject({
      live: false,
      conclusive: true,
      reason: 'workspace_deleted_superseded_by_completed_wake',
    });
    expect(isSupersededTerminalReason(verdict.reason)).toBe(true);
  });

  /**
   * The other half of that control: a task that was NEVER superseded keeps the
   * plain runtime-death reason, so the sweep still records it as `failed`.
   * Without this pair, "everything becomes a benign cancellation" would pass.
   */
  it('keeps the runtime-death reason for a task that was never superseded', async () => {
    seedWorkspace('deleted');

    const verdict = await getTaskRuntimeLiveness(env, task);
    expect(verdict).toMatchObject({ conclusive: true, reason: 'workspace_deleted' });
    expect(isSupersededTerminalReason(verdict.reason)).toBe(false);
  });

  /**
   * Bounded escape (`.claude/rules/47`): a superseded task must leave the
   * candidate set once its successor goes terminal, rather than being preserved
   * forever. Two consecutive classifications across that transition.
   */
  it('releases the predecessor once the live successor terminalizes', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedRecoverySuccessor({ status: 'in_progress' });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: false,
    });

    sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(SUCCESSOR_ID);

    // Bounded escape, but NOT a false failure: the benign marker is what the
    // terminal writer keys on to record `cancelled` instead of `failed`.
    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted_superseded_by_completed_wake',
    });
  });

  /**
   * Rule 47 hot-path discipline: a resumable snapshot short-circuits the
   * classifier before supersession is consulted, so the extra read is skipped.
   */
  it('does not probe supersession when the snapshot already proves resumability', async () => {
    seedWorkspace('deleted');
    seedSnapshot();
    seedRecoverySuccessor();
    let supersessionReads = 0;
    const counting = {
      DATABASE: {
        prepare: (query: string) => {
          if (query.includes('FROM tasks self')) supersessionReads++;
          return createSqliteD1(sqlite).prepare(query);
        },
      },
    } as unknown as Env;

    await expect(getTaskRuntimeLiveness(counting, task)).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_snapshot_resumable',
    });
    expect(supersessionReads).toBe(0);
  });

  /** The gate itself, asserted directly — mirrors the resumability-probe precedent. */
  it('never probes supersession for a running workspace', () => {
    expect(
      needsTaskSupersessionProbe(
        {
          id: WORKSPACE_ID,
          status: 'running',
          chatSessionId: CHAT_SESSION_ID,
          nodeId: NODE_ID,
          nodeRuntime: 'vm',
          nodeStatus: 'running',
          nodeHealthStatus: 'healthy',
          nodeHeartbeatAt: Date.now(),
          runningWorkspacesOnNode: 1,
        },
        'ok'
      )
    ).toBe(false);
  });

  /** The root of a chain is the other half of the incident population (49 of 91). */
  it('preserves the ROOT of a chain that still has a live descendant', async () => {
    const ROOT_ID = '01M064TG00ROOT00000000000';
    const MIDDLE_ID = '01M064TG11MIDDLE000000000';
    seedTask(ROOT_ID, { status: 'in_progress', createdAt: iso(-7_200_000), chatSessionId: null });
    seedTask(MIDDLE_ID, {
      status: 'failed',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: ROOT_ID,
      createdAt: iso(-3_600_000),
      chatSessionId: null,
    });
    seedRecoverySuccessor({ rootId: ROOT_ID, createdAt: iso(-60_000) });
    seedWorkspace('deleted');

    await expect(
      getTaskRuntimeLiveness(env, {
        id: ROOT_ID,
        project_id: PROJECT_ID,
        workspace_id: WORKSPACE_ID,
      })
    ).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_superseded_by_live_wake',
    });
  });

  /** Supersession applies to any non-running status, not just `deleted`. */
  it('applies the same protection to a stopped workspace', async () => {
    seedWorkspace('stopped');
    nullOutHandoffBindings();
    seedRecoverySuccessor();

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_stopped_superseded_by_live_wake',
    });
  });

  /** Direction matters: an OLDER task can never supersede a newer one. */
  it('does not treat an older family member as a superseding wake', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedRecoverySuccessor({ createdAt: iso(-7_200_000) });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  /** A live but unrelated task is not a wake successor. */
  it('does not treat a non-recovery task as a superseding wake', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedTask('01M064TG22UNRELATED000000', {
      status: 'in_progress',
      triggeredBy: 'user',
      recoverySourceTaskId: TASK_ID,
      createdAt: iso(-60_000),
    });

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  /** Project scoping is a SQL predicate, so it needs a real engine (`.claude/rules/28`). */
  it('ignores a live successor belonging to a different project', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                          triggered_by, recovery_source_task_id, created_by, created_at, updated_at)
       VALUES (?, 'project-2', 'user-1', ?, 'task', 'in_progress', 0, 'session-recovery', ?,
               'user-1', ?, ?)`
      )
      .run('01M064TG33OTHERPROJECT000', WORKSPACE_ID, TASK_ID, iso(-60_000), iso(0));

    await expect(getTaskRuntimeLiveness(env, task)).resolves.toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted',
    });
  });

  /** Fail safe: an unreadable supersession probe must withhold the death verdict. */
  it('withholds a death verdict when the supersession read fails', async () => {
    seedWorkspace('deleted');
    const broken = {
      DATABASE: {
        prepare: (query: string) =>
          query.includes('FROM tasks self')
            ? { bind: () => ({ first: () => Promise.reject(new Error('D1 unavailable')) }) }
            : createSqliteD1(sqlite).prepare(query),
      },
    } as unknown as Env;

    await expect(getTaskRuntimeLiveness(broken, task)).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_supersession_unknown',
    });
  });

  /** Rule 61: the guard must hold on the ProjectData runtime too, not just cron. */
  it('preserves a superseded predecessor on the ProjectData runtime as well', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedRecoverySuccessor();
    const sql = createSqlStorage(new Database(':memory:'));
    const doEnv = { DATABASE: createSqliteD1(sqlite) } as unknown as ProjectDataEnv;

    await expect(
      getLocalTaskRuntimeLiveness(sql, doEnv, {
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
      })
    ).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_deleted_superseded_by_live_wake',
    });
  });

  /**
   * Rule 61: the ProjectData runtime must reach the same benign verdict, so the
   * two terminalization writers cannot disagree about what a supersession means.
   */
  it('reaches the benign supersession verdict on the ProjectData runtime too', async () => {
    seedWorkspace('deleted');
    nullOutHandoffBindings();
    seedRecoverySuccessor({ status: 'completed' });
    const sql = createSqlStorage(new Database(':memory:'));
    const doEnv = { DATABASE: createSqliteD1(sqlite) } as unknown as ProjectDataEnv;

    const verdict = await getLocalTaskRuntimeLiveness(sql, doEnv, {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(verdict).toMatchObject({
      conclusive: true,
      reason: 'workspace_deleted_superseded_by_completed_wake',
    });
    expect(isSupersededTerminalReason(verdict.reason)).toBe(true);
  });

  /** A task with no workspace row at all is still protected while superseded. */
  it('preserves a superseded predecessor whose workspace row is gone', async () => {
    seedRecoverySuccessor();

    await expect(
      getTaskRuntimeLiveness(env, { id: TASK_ID, project_id: PROJECT_ID, workspace_id: null })
    ).resolves.toMatchObject({
      conclusive: false,
      reason: 'workspace_missing_superseded_by_live_wake',
    });
  });
});
