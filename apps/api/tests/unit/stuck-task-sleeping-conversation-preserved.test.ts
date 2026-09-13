/**
 * Sweep-level regression for the 2026-09-13 incident: sleeping conversations
 * terminalized as `failed` by the stuck-task sweep.
 *
 * Production `sam-prod`, 2026-09-06..13: 41 of the week's 94 task failures were
 * sweep verdicts on conversations that had gone to sleep correctly and were
 * still wakeable — 32 via the runaway-cost ceiling, 9 via the liveness and
 * reconciliation-grace branches. Every one showed a red "Task failed".
 *
 * These tests enter through the REAL `recoverStuckTasks` against a real SQL
 * engine and assert the PERSISTED `tasks.status` (`.claude/rules/62`,
 * `.claude/rules/28`). The classifier suite in
 * `stuck-task-slept-session-liveness.test.ts` proves the verdict; only this file
 * proves the sweep honours it, and only this file reaches the ceiling branch,
 * which never runs a liveness probe at all.
 *
 * Fixture values are the production shapes recovered from `sam-prod`:
 *   - shape A: `tasks.workspace_id IS NULL`, no `workspaces` row, snapshot
 *     `workspace_id` nulled by `ON DELETE SET NULL` (6 of 9 liveness failures)
 *   - shape B: `recovery_attempts = 3` with `recovery_failed_at` 0-3 minutes old
 *     (tasks `01M20YT9EH…`, `01M213XGR2…`, `01M22VG3JN…`)
 *   - ceiling: workspace row present and `deleted`, snapshot sleeping and
 *     unexpired (32 of 35 ceiling failures)
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }));
vi.mock('../../src/services/fetch-timeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/fetch-timeout')>();
  return { ...actual, fetchWithTimeout: fetchWithTimeoutMock };
});

vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/project-data', () => ({
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listAcpSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  getTaskAcpLivenessSignals: vi.fn().mockResolvedValue({ sessions: [], sessionWork: null }),
  failSession: vi.fn().mockResolvedValue(undefined),
}));

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';
const WORKSPACE_ID = '01M2145J47SWA5P2KMJBGKAB47';
const NODE_ID = '01M064TG56ECJW1D127H32BRVJ';
const CHAT_SESSION_ID = 'b176e912-19b8-47e9-88bc-f2c04d6167e9';
const TASK_ID = '01M213XGR2P0Q648PC9Y9YNA41';

const HOUR = 60 * 60 * 1000;
/** Past the 24h ceiling, matching production's daily ceiling firings. */
const TWENTY_FIVE_HOURS = 25 * HOUR;
/** Past the 8h hard timeout but under the ceiling — the liveness branch. */
const NINE_HOURS = 9 * HOUR;

let sqlite: Database.Database;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedNode(heartbeatOffsetMs = 0): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at,
                        vm_size, vm_location, cloud_provider, created_at, updated_at)
     VALUES (?, 'user-1', 'node', 'running', 'healthy', ?, 'cpx21', 'nbg1', 'hetzner', ?, ?)`
    )
    .run(NODE_ID, iso(heartbeatOffsetMs), iso(-TWENTY_FIVE_HOURS), iso(0));
}

function seedWorkspace(
  o: {
    id?: string;
    status?: string;
    createdAt?: string;
    chatSessionId?: string | null;
    projectId?: string;
    userId?: string;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size, vm_location,
                             project_id, chat_session_id, node_id, created_at, updated_at)
     VALUES (?, ?, 'ws', 'org/repo', 'main', ?, 'cpx21', 'nbg1', ?, ?, ?, ?, ?)`
    )
    .run(
      o.id ?? WORKSPACE_ID,
      o.userId ?? 'user-1',
      o.status ?? 'deleted',
      o.projectId ?? PROJECT_ID,
      o.chatSessionId === undefined ? CHAT_SESSION_ID : o.chatSessionId,
      NODE_ID,
      o.createdAt ?? iso(-TWENTY_FIVE_HOURS),
      iso(0)
    );
}

function seedSnapshot(
  o: {
    projectId?: string;
    workspaceId?: string | null;
    chatSessionId?: string;
    userId?: string;
    sleepStatus?: string | null;
    sleepingAt?: string | null;
    expiresAt?: string;
    status?: string;
    degradation?: string;
    recoveryAttempts?: number;
    recoveryFailedAt?: string | null;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
                                    runtime, status, degradation, manifest_r2_key, home_r2_key,
                                    expires_at, sleeping_at, sleep_status, recovery_attempts,
                                    recovery_failed_at, sleep_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'vm', ?, ?, 'manifest-key', 'home-key', ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      `snapshot-${o.chatSessionId ?? CHAT_SESSION_ID}`,
      o.projectId ?? PROJECT_ID,
      o.workspaceId === undefined ? WORKSPACE_ID : o.workspaceId,
      NODE_ID,
      o.userId ?? 'user-1',
      o.chatSessionId ?? CHAT_SESSION_ID,
      o.status ?? 'available',
      o.degradation ?? 'none',
      o.expiresAt ?? iso(7 * 24 * HOUR),
      o.sleepingAt === undefined ? iso(-2 * HOUR) : o.sleepingAt,
      o.sleepStatus === undefined ? 'sleeping' : o.sleepStatus,
      o.recoveryAttempts ?? 0,
      o.recoveryFailedAt ?? null,
      iso(-TWENTY_FIVE_HOURS),
      iso(0)
    );
}

function seedTask(
  o: {
    id?: string;
    projectId?: string;
    taskMode?: string;
    executionStep?: string | null;
    startedAt?: string;
    workspaceId?: string | null;
    chatSessionId?: string | null;
  } = {}
): void {
  const startedAt = o.startedAt ?? iso(-TWENTY_FIVE_HOURS);
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                        triggered_by, chat_session_id, task_mode, execution_step,
                        started_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, 'conversation', 'in_progress', 0, 'user', ?, ?, ?, ?, 'user-1', ?, ?)`
    )
    .run(
      o.id ?? TASK_ID,
      o.projectId ?? PROJECT_ID,
      o.workspaceId === undefined ? WORKSPACE_ID : o.workspaceId,
      o.chatSessionId === undefined ? CHAT_SESSION_ID : o.chatSessionId,
      o.taskMode ?? 'conversation',
      o.executionStep === undefined ? null : o.executionStep,
      startedAt,
      startedAt,
      startedAt
    );
}

function env(): Env {
  const kv = new Map<string, string>();
  return {
    DATABASE: createSqliteD1(sqlite),
    OBSERVABILITY_DATABASE: createSqliteD1(sqlite),
    KV: {
      get: vi.fn(async (k: string) => kv.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        kv.set(k, v);
      }),
    },
    TASK_RUNNER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
      get: vi.fn().mockReturnValue({ getStatus: vi.fn().mockRejectedValue(new Error('no DO')) }),
    },
    TASK_RUN_MAX_EXECUTION_MS: '14400000', // 4h
    TASK_RUN_HARD_TIMEOUT_MS: '28800000', // 8h
    TASK_RUN_ABSOLUTE_CEILING_MS: '86400000', // 24h
    SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '3',
    SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS: '900000', // 15 min
    NODE_HEARTBEAT_STALE_SECONDS: '180',
    BASE_DOMAIN: 'example.test',
  } as unknown as Env;
}

function rowOf(id = TASK_ID): { status: string; error_message: string | null } {
  return sqlite.prepare(`SELECT status, error_message FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    error_message: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockReset();
  // A node health probe that cannot reach the node is inconclusive, never fatal.
  fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 503 }));
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.workspaces,
    schema.nodes,
    schema.sessionSnapshots,
    schema.tasks,
    schema.taskStatusEvents,
    schema.triggerExecutions,
    schema.vmTaskAdmissions,
    schema.vmProvisioningLeases,
  ]);
  seedNode();
});

describe('stuck-task sweep — a sleeping conversation is preserved, not failed', () => {
  it('preserves a sleeping conversation past the 24h runaway-cost ceiling', async () => {
    // The dominant production shape: 32 of 35 ceiling failures. The workspace row
    // is `deleted` (NodeLifecycle rewrites it five minutes after the sleep) and
    // the snapshot is sleeping, restorable and unexpired. RED before the fix.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot();
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
    expect(rowOf().error_message).toBeNull();
  });

  it('preserves a sleeping conversation on the liveness-timeout branch', async () => {
    // `execution_step='awaiting_followup'` past the 8h hard timeout: the sweep's
    // second terminal branch, 12 production failures this week.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot();
    seedTask({ executionStep: 'awaiting_followup', startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
  });

  it('preserves a sleeping conversation whose workspace row is gone but whose snapshot still resolves', async () => {
    // Production shape A, with the snapshot still naming a live workspace row:
    // `tasks.workspace_id IS NULL`, so the classifier reaches `workspace_missing`
    // — but `loadRecoveryContext` reads the SNAPSHOT's workspace, which exists.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot();
    seedTask({ workspaceId: null, startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
  });

  it('preserves a conversation inside the wake-retry decay window', async () => {
    // Production shape B: tasks `01M20YT9EH…`, `01M213XGR2…` and `01M22VG3JN…`
    // were failed 0, 1 and 3 minutes after `recovery_failed_at`, inside a window
    // the resumer reopens by itself 15 minutes later.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot({ recoveryAttempts: 3, recoveryFailedAt: iso(-60 * 1000) });
    seedTask({ executionStep: 'awaiting_followup', startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
  });

  it('preserves a conversation whose sleep is scheduled but not yet captured', async () => {
    // The sleep lifecycle owns this row and is moving it to a claimable state.
    seedWorkspace({ status: 'running', chatSessionId: CHAT_SESSION_ID });
    seedSnapshot({ sleepStatus: 'scheduled', sleepingAt: null });
    seedTask({ executionStep: 'awaiting_followup', startedAt: iso(-TWENTY_FIVE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
  });
});

describe('stuck-task sweep — controls that must still terminalize', () => {
  it('still fails a live 25h runtime at the ceiling', async () => {
    // The cost backstop must keep working: a running workspace on a healthy node
    // with a fresh heartbeat, whose ALLOCATION is 25 hours old. Without this the
    // suite passes equally well with the ceiling deleted outright.
    seedWorkspace({
      status: 'running',
      chatSessionId: CHAT_SESSION_ID,
      createdAt: iso(-TWENTY_FIVE_HOURS),
    });
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('failed');
    expect(rowOf().error_message).toContain('runaway-cost ceiling');
  });

  it('still fails a genuinely dead runtime with no snapshot row', async () => {
    // A user-initiated delete destroys the snapshot row entirely, so snapshot
    // ABSENCE is the discriminator between "slept" and "destroyed"
    // (`.claude/rules/58` req 5).
    seedWorkspace({ status: 'deleted' });
    seedTask({ executionStep: 'awaiting_followup', startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('failed');
    expect(rowOf().error_message).toContain('no longer live');
  });

  it('retires an expired sleep as a lifecycle cancellation, never a failure', async () => {
    // Bounded escape (`.claude/rules/47`): the snapshot TTL still retires the
    // task. But a sleep that outlived its snapshot is a lifecycle outcome, not an
    // agent failure — policies a974b04f and 486d1dd1, and `ActiveTaskCard` keys
    // its red banner on `status === 'failed'`.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot({ expiresAt: iso(-1000) });
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('cancelled');
    expect(rowOf().error_message).toContain('expired');
  });

  it('retires a sleep whose runtime workspace row is gone as a lifecycle cancellation', async () => {
    // Production shape A proper: the snapshot's own `workspace_id` was nulled by
    // `ON DELETE SET NULL`, so `loadRecoveryContext` can never accept this wake.
    // Preserving it would hang the task until the TTL for a wake that cannot
    // happen (`.claude/rules/58` req 2). Tracked as idea 01M2CQD1FK7YA96VD6Q74302K0.
    seedSnapshot({ workspaceId: null });
    seedTask({ workspaceId: null, startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('cancelled');
    expect(rowOf().error_message).toContain('no longer exists');
  });

  it('retires a spent wake budget that can never decay', async () => {
    // `recovery_failed_at IS NULL` means no attempt ever reported back, so
    // `sessionRecoveryBudgetAvailable` never releases the budget. The refusal is
    // permanent, and the bounded escape must fire.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot({ recoveryAttempts: 3, recoveryFailedAt: null });
    seedTask({ executionStep: 'awaiting_followup', startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('cancelled');
  });

  it('does not let another project’s snapshot preserve a task', async () => {
    // `.claude/rules/11` / `.claude/rules/28`: the project predicate is a SQL
    // predicate and needs a real engine plus a foreign-project attack fixture.
    // Deleting `AND project_id = ?` from the loader makes this row preserve.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot({ projectId: OTHER_PROJECT_ID });
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('failed');
  });

  it('preserves the owner-path control in the same fixture shape', async () => {
    // The owner control `.claude/rules/28` requires beside every attack case:
    // "the foreign snapshot did not preserve" is also satisfied by preservation
    // being broken outright.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot({ projectId: PROJECT_ID });
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
  });

  it('records failed, not cancelled, for a task-mode run the sleep guard does not cover', async () => {
    // The sleep guard's scope: conversation-mode tasks, plus anything parked at
    // `awaiting_followup`. A task-mode run still at `running` is neither, so an
    // expired snapshot must NOT be relabelled as a lifecycle cancellation for it.
    //
    // The snapshot has to be expired for this to discriminate: a WAKEABLE
    // snapshot is preserved by the liveness classifier regardless of task mode,
    // which is pre-existing `.claude/rules/58` behaviour and not what this
    // control is about. The paired conversation-mode case is
    // "retires an expired sleep as a lifecycle cancellation" above.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot({ expiresAt: iso(-1000) });
    seedTask({ taskMode: 'task', executionStep: 'running', startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('failed');
    expect(rowOf().error_message).toContain('no longer live');
  });

  it('preserves a task-mode run whose session is still wakeable', async () => {
    // Pre-existing `.claude/rules/58` behaviour, pinned here so the scope control
    // above cannot be misread as "task-mode tasks are never preserved". The
    // conversation is recoverable, so terminalizing would destroy real work
    // whatever the task's mode.
    seedWorkspace({ status: 'deleted' });
    seedSnapshot();
    seedTask({ taskMode: 'task', executionStep: 'running', startedAt: iso(-NINE_HOURS) });

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
  });
});

describe('stuck-task sweep — the ceiling ages the allocation, not the conversation', () => {
  it('does not charge the ceiling to a 25h conversation whose allocation is minutes old', async () => {
    // The `.claude/rules/74` divergence case: a conversation legitimately lives
    // for weeks across many sleeps and wakes, and each wake provisions a NEW
    // workspace. The current allocation, not the `tasks` row, is what a
    // runaway-cost ceiling exists to bound.
    seedWorkspace({
      status: 'running',
      chatSessionId: CHAT_SESSION_ID,
      createdAt: iso(-10 * 60 * 1000),
    });
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().error_message ?? '').not.toContain('runaway-cost ceiling');
    // Liveness control (`.claude/rules/62`): the absence above is also satisfied
    // by the sweep never reaching this task. A running workspace on a healthy
    // node is live, so it must simply be preserved.
    expect(rowOf().status).toBe('in_progress');
  });

  it('withholds the ceiling verdict when the allocation lookup cannot resolve', async () => {
    // `.claude/rules/74` req 5: a degraded input must fail closed rather than
    // revert to the `tasks.started_at` proxy that caused the bug.
    seedWorkspace({ status: 'running', chatSessionId: CHAT_SESSION_ID });
    sqlite.prepare(`UPDATE workspaces SET created_at = 'not-a-timestamp' WHERE id = ?`).run(
      WORKSPACE_ID
    );
    seedTask();

    await recoverStuckTasks(env());

    expect(rowOf().status).toBe('in_progress');
    expect(rowOf().error_message ?? '').not.toContain('runaway-cost ceiling');
  });
});
