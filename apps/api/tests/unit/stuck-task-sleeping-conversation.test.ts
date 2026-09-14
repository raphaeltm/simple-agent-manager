/**
 * Sweep-level regression for the 2026-09-14 incident: the stuck-task sweep
 * terminalized conversations that had already gone to sleep correctly.
 *
 * Measured on `sam-prod` for 2026-09-07T09:08Z..2026-09-14T09:08Z: of 57 sweep
 * verdicts across the three terminal branches, **53** were this bug.
 *
 *   | shape                                                   |  n | covered by |
 *   |---------------------------------------------------------|----|------------|
 *   | ceiling + `sleeping` snapshot, workspace `deleted`       | 45 | "ceiling"  |
 *   | `tasks.workspace_id` NULL + snapshot `workspace_id` NULL |  4 | "workspace row is gone" |
 *   | `sleep_status='scheduled'` (sleep in flight)             |  1 | "mid-sleep" |
 *   | wake budget spent inside the decay window                |  3 | out of scope — rule-58-consistent with the resumer |
 *   | genuinely dead (`terminal_failed` / no snapshot)         | 16 | the controls — these MUST keep failing |
 *
 * `.claude/rules/62`: every case enters through the real `recoverStuckTasks`, not
 * a branch handler, because the ceiling branch does not call the liveness adapter
 * at all — which is exactly why `stuck-task-slept-session-liveness.test.ts` (which
 * drives `getTaskRuntimeLiveness` directly) stayed green through 45 daily
 * production failures.
 *
 * `.claude/rules/28`: the guard IS a SQL predicate, so these run against a real
 * SQLite engine built from the drizzle schema, never a `.where()`-ignoring mock.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../src/db/observability-schema';
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

const { getTaskAcpLivenessSignalsMock, containerLifecycleMock } = vi.hoisted(() => ({
  getTaskAcpLivenessSignalsMock: vi.fn(),
  containerLifecycleMock: vi.fn(),
}));
vi.mock('../../src/services/vm-agent-container', () => ({
  inspectVmAgentContainerLifecycle: containerLifecycleMock,
}));
vi.mock('../../src/services/project-data', () => ({
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listAcpSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  failSession: vi.fn().mockResolvedValue(undefined),
  getTaskAcpLivenessSignals: getTaskAcpLivenessSignalsMock,
}));

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';
const WORKSPACE_ID = '01M06502R3MW9JY75M7WK68B42';
const NODE_ID = '01M064TG56ECJW1D127H32BRVJ';
const CHAT_SESSION_ID = '8bd22a42-cf37-41fa-9947-30e78a0b6ece';
const TASK_ID = '01M064TG9QK8ZQ3XW0M6P7RCTN';

const HOUR = 60 * 60 * 1000;
/** Past the 24h absolute runaway-cost ceiling. */
const PAST_CEILING = -25 * HOUR;
/** Past the 8h hard timeout but below the ceiling — the liveness branch's window. */
const PAST_HARD_TIMEOUT = -9 * HOUR;

let sqlite: Database.Database;

/** An ISO timestamp `offsetMs` from now; negative is in the past. */
function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** An `in_progress` conversation task, defaulting to the 25h-past-ceiling shape. */
function seedTask(
  o: {
    id?: string;
    projectId?: string;
    workspaceId?: string | null;
    chatSessionId?: string | null;
    startedAt?: string;
    executionStep?: string;
    taskMode?: string;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                        triggered_by, chat_session_id, execution_step, task_mode,
                        started_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, 'task', 'in_progress', 0, 'user', ?, ?, ?, ?, 'user-1', ?, ?)`
    )
    .run(
      o.id ?? TASK_ID,
      o.projectId ?? PROJECT_ID,
      o.workspaceId === undefined ? WORKSPACE_ID : o.workspaceId,
      o.chatSessionId === undefined ? CHAT_SESSION_ID : o.chatSessionId,
      o.executionStep ?? 'awaiting_followup',
      o.taskMode ?? 'conversation',
      o.startedAt ?? iso(PAST_CEILING),
      o.startedAt ?? iso(PAST_CEILING),
      o.startedAt ?? iso(PAST_CEILING)
    );
}

/** The task's workspace. Defaults to `deleted` — what sleeping does to it. */
function seedWorkspace(
  o: { status?: string; createdAt?: string; chatSessionId?: string | null } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size, vm_location,
                             project_id, chat_session_id, node_id, created_at, updated_at)
     VALUES (?, 'user-1', 'ws', 'org/repo', 'main', ?, 'cpx21', 'nbg1', ?, ?, ?, ?, ?)`
    )
    .run(
      WORKSPACE_ID,
      o.status ?? 'deleted',
      PROJECT_ID,
      o.chatSessionId === undefined ? CHAT_SESSION_ID : o.chatSessionId,
      NODE_ID,
      o.createdAt ?? iso(PAST_CEILING),
      iso(0)
    );
}

/** A healthy node — the production rows in this incident all had one. */
function seedNode(o: { heartbeatAt?: string; runtime?: string } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at, runtime,
                        vm_size, vm_location, cloud_provider, created_at, updated_at)
     VALUES (?, 'user-1', 'node', 'running', 'healthy', ?, ?, 'cpx21', 'nbg1', 'hetzner', ?, ?)`
    )
    .run(NODE_ID, o.heartbeatAt ?? iso(0), o.runtime ?? 'vm', iso(PAST_CEILING), iso(0));
}

/** The `session_snapshots` row. Defaults to a restorable, unexpired `sleeping` record. */
function seedSnapshot(
  o: {
    projectId?: string;
    workspaceId?: string | null;
    chatSessionId?: string;
    sleepStatus?: string | null;
    sleepingAt?: string | null;
    expiresAt?: string;
    status?: string;
    degradation?: string;
    recoveryAttempts?: number;
    recoveryFailedAt?: string | null;
    sleepClaimedAt?: string | null;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
                                    runtime, status, degradation, manifest_r2_key, home_r2_key,
                                    expires_at, sleeping_at, sleep_status, sleep_claimed_at,
                                    recovery_attempts, recovery_failed_at, sleep_attempts,
                                    created_at, updated_at)
     VALUES ('snapshot-1', ?, ?, ?, 'user-1', ?, 'vm', ?, ?, 'manifest-key', 'home-key',
             ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      o.projectId ?? PROJECT_ID,
      o.workspaceId === undefined ? WORKSPACE_ID : o.workspaceId,
      NODE_ID,
      o.chatSessionId ?? CHAT_SESSION_ID,
      o.status ?? 'available',
      o.degradation ?? 'none',
      o.expiresAt ?? iso(7 * 24 * HOUR),
      o.sleepingAt === undefined ? iso(-20 * HOUR) : o.sleepingAt,
      o.sleepStatus === undefined ? 'sleeping' : o.sleepStatus,
      o.sleepClaimedAt ?? null,
      o.recoveryAttempts ?? 0,
      o.recoveryFailedAt ?? null,
      iso(-25 * HOUR),
      iso(0)
    );
}

/** A sweep env with the production 4h / 8h / 24h thresholds. */
function env(overrides: Partial<Record<string, unknown>> = {}): Env {
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
    TASK_RUN_MAX_EXECUTION_MS: String(4 * HOUR),
    TASK_RUN_HARD_TIMEOUT_MS: String(8 * HOUR),
    TASK_RUN_ABSOLUTE_CEILING_MS: String(24 * HOUR),
    NODE_HEARTBEAT_STALE_SECONDS: '180',
    BASE_DOMAIN: 'example.test',
    ...overrides,
  } as unknown as Env;
}

/** A D1 binding whose `session_snapshots` reads always throw. */
function brokenSnapshotEnv(): Env {
  const real = createSqliteD1(sqlite);
  return env({
    DATABASE: {
      ...real,
      prepare: (query: string) =>
        query.includes('session_snapshots')
          ? { bind: () => ({ first: () => Promise.reject(new Error('D1 unavailable')) }) }
          : real.prepare(query),
    },
  });
}

/** The persisted verdict: what the sweep actually wrote, if anything. */
function taskRow(id = TASK_ID): { status: string; error_message: string | null } {
  return sqlite.prepare(`SELECT status, error_message FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    error_message: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockResolvedValue({ ok: true, status: 200 });
  containerLifecycleMock.mockResolvedValue({ status: 'running', activeWorkStatus: null });
  // A live ACP session, so the "live runtime" controls below are live for a
  // reason the production system would also accept.
  getTaskAcpLivenessSignalsMock.mockResolvedValue({
    sessions: [
      {
        id: 'acp-1',
        status: 'running',
        workspaceId: WORKSPACE_ID,
        lastHeartbeatAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: Date.now() - 1_000,
        createdAt: Date.now() - 2_000,
      },
    ],
    total: 1,
    sessionWork: null,
  });
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.tasks,
    schema.taskStatusEvents,
    schema.workspaces,
    schema.nodes,
    schema.sessionSnapshots,
    schema.triggerExecutions,
    schema.projectEventSourceOutbox,
    observabilitySchema.platformErrors,
  ]);
});

describe('runaway-cost ceiling — a sleeping conversation is not runaway compute', () => {
  /**
   * The incident, reproduced. 45 of 45 production ceiling failures had exactly
   * this shape. RED against pre-fix code: the ceiling short-circuited on
   * `executionMs > absoluteCeilingMs` and `break`ed before `probeLiveness()`,
   * writing `failed` with the runaway-cost message.
   */
  it('preserves a sleeping session whose workspace was deleted, 25h after started_at', async () => {
    seedTask();
    seedWorkspace({ status: 'deleted' });
    seedNode();
    seedSnapshot({ sleepStatus: 'sleeping' });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.failedInProgress).toBe(0);
  });

  /**
   * The `workspace_missing` shape: `tasks.workspace_id` is NULL and so is the
   * snapshot's own `workspace_id`, so the workspace-scoped resumability probe
   * cannot reach the row at all — only a `chat_session_id`-keyed lookup can.
   * 4 production rows (`.claude/rules/63`).
   */
  it('preserves a sleeping session whose workspace row is gone entirely', async () => {
    seedTask({ workspaceId: null });
    seedSnapshot({ workspaceId: null });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * The `workspaces.chat_session_id IS NULL` shape a wake handoff produces
   * (`session-recovery.ts:createRecoveryTask` stmt 3). The task still knows its
   * canonical chat session; the workspace no longer does.
   */
  it('preserves a sleeping session whose workspace lost its chat binding', async () => {
    seedTask();
    seedWorkspace({ status: 'deleted', chatSessionId: null });
    seedNode();
    seedSnapshot();

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /** A snapshot recorded against a previous incarnation of the workspace. */
  it('preserves a sleeping session whose snapshot points at an older workspace', async () => {
    seedTask();
    seedWorkspace({ status: 'deleted' });
    seedNode();
    seedSnapshot({ workspaceId: '01M06502R3MW9JY75M7WK68OLD' });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * Sleep in flight. `isSessionResumable` requires `sleep_status='sleeping'`, so
   * this shape was terminalized (1 production row). The shared resumer predicate
   * accepts it; the bound is `SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`.
   */
  it('preserves a conversation that is mid-sleep (sleep_status=scheduled)', async () => {
    seedTask();
    seedWorkspace({ status: 'stopping' });
    seedNode();
    seedSnapshot({
      sleepStatus: 'scheduled',
      sleepingAt: null,
      sleepClaimedAt: iso(-60_000),
    });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * The ceiling's OWN sleep guard, isolated. Here the workspace is still
   * `running`, so a runtime generation IS allocated and 25h old — the ceiling
   * genuinely applies — and only the sleep lookup stops it. That is the case
   * where a sleep capture is in flight against live compute: destroying the task
   * mid-capture would corrupt the handoff. Bounded by
   * `SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`.
   */
  it('preserves a 25h LIVE runtime whose sleep capture is in flight', async () => {
    seedTask({ executionStep: 'running' });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_CEILING) });
    seedNode({ heartbeatAt: iso(-30_000) });
    seedSnapshot({ sleepStatus: 'stopping', sleepingAt: null, sleepClaimedAt: iso(-60_000) });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.failedInProgress).toBe(0);
  });

  /**
   * Its bound. An in-flight sleep older than `SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`
   * (30 min default) no longer preserves, so a wedged capture cannot make a live
   * 25h runtime immortal (`.claude/rules/47`).
   */
  it('still terminalizes a 25h live runtime whose sleep capture has gone stale', async () => {
    seedTask({ executionStep: 'running' });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_CEILING) });
    seedNode({ heartbeatAt: iso(-30_000) });
    seedSnapshot({ sleepStatus: 'stopping', sleepingAt: null, sleepClaimedAt: iso(-2 * HOUR) });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('runaway-cost ceiling');
  });

  /**
   * `.claude/rules/58` requirement 4 — an unknown answer must never resolve to
   * "destroy". Paired with a liveness assertion: the sweep must have RUN, which
   * the preserved-not-absent task row plus the scanned count together prove.
   */
  /**
   * The fixture shape matters here. With a `deleted` workspace row,
   * `needsSessionResumabilityProbe` fires FIRST and its own throw yields the
   * pre-existing `workspace_deleted_resumability_unknown` escape — so the test
   * would pass without the new guard existing at all. `workspace_id: null` makes
   * that probe decline (`workspace === null`), leaving the task-scoped lookup as
   * the only `session_snapshots` query the broken binding can intercept.
   */
  it('withholds the terminal verdict when the sleep lookup fails', async () => {
    seedTask({ workspaceId: null });
    seedSnapshot({ workspaceId: null });

    const result = await recoverStuckTasks(brokenSnapshotEnv());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * THE COST BACKSTOP CONTROL. Without this, the suite passes equally well with
   * the ceiling deleted outright. A live VM runtime whose generation is 25h old
   * and which holds no sleep record is still terminalized as runaway compute.
   */
  it('still terminalizes a live 25h runtime with no sleep record', async () => {
    seedTask({ executionStep: 'running' });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_CEILING) });
    seedNode({ heartbeatAt: iso(-30_000) });

    const result = await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('runaway-cost ceiling');
    expect(result.failedInProgress).toBe(1);
    // The ceiling must stay cheap: no ProjectData DO round-trip on this path.
    expect(getTaskAcpLivenessSignalsMock).not.toHaveBeenCalled();
  });

  /**
   * `.claude/rules/74` — the ceiling measures the ALLOCATED RUNTIME GENERATION,
   * not the conversation row. A woken conversation whose task row is 25h old but
   * whose current workspace was allocated an hour ago is not runaway compute.
   */
  it('ages the ceiling from the live runtime generation, not tasks.started_at', async () => {
    seedTask({ executionStep: 'running' });
    seedWorkspace({ status: 'running', createdAt: iso(-1 * HOUR) });
    seedNode({ heartbeatAt: iso(-30_000) });

    const result = await recoverStuckTasks(env());

    // Preserved outright: the ceiling declines, and the liveness branch then sees
    // a live runtime. `error_message` null is the positive proof no verdict was
    // written at all, not merely that the wording changed.
    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.failedInProgress).toBe(0);
    expect(result.heartbeatSkipped).toBe(1);
  });

  /**
   * The discriminating pair for the test above: same fixture, generation older
   * than the ceiling, and it fires. Proves the generation timestamp is what
   * constrains the gate rather than the shape of the seeded data.
   */
  it('still fires once the live runtime generation itself passes the ceiling', async () => {
    seedTask({ executionStep: 'running' });
    seedWorkspace({ status: 'running', createdAt: iso(-25 * HOUR) });
    seedNode({ heartbeatAt: iso(-30_000) });

    await recoverStuckTasks(env());

    expect(taskRow().error_message).toContain('runaway-cost ceiling');
  });

  /**
   * `.claude/rules/74` requirement 5 — a degraded input must not weaken the
   * backstop. When the workspace row cannot be read, the ceiling falls back to
   * `tasks.started_at` and still applies.
   */
  it('falls back to started_at and still applies the ceiling when the workspace read fails', async () => {
    seedTask({ executionStep: 'running', chatSessionId: null });
    seedWorkspace({ status: 'running', createdAt: iso(-1 * HOUR) });
    seedNode({ heartbeatAt: iso(-30_000) });

    const real = createSqliteD1(sqlite);
    const result = await recoverStuckTasks(
      env({
        DATABASE: {
          ...real,
          prepare: (query: string) =>
            query.includes('running_workspaces_on_node')
              ? { bind: () => ({ first: () => Promise.reject(new Error('D1 unavailable')) }) }
              : real.prepare(query),
        },
      })
    );

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('runaway-cost ceiling');
    expect(result.failedInProgress).toBe(1);
  });

  /**
   * The bound (`.claude/rules/58` requirement 3). An expired snapshot is not
   * recoverable, so preserving it would strand the task forever.
   */
  it('terminalizes once the snapshot has expired', async () => {
    seedTask();
    seedWorkspace({ status: 'deleted' });
    seedNode();
    seedSnapshot({ expiresAt: iso(-HOUR) });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
  });

  /** Cross-project scoping, proven against a real SQL engine (`.claude/rules/28`). */
  it('ignores a sleeping snapshot belonging to a different project', async () => {
    seedTask();
    seedWorkspace({ status: 'deleted' });
    seedNode();
    seedSnapshot({ projectId: OTHER_PROJECT_ID });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
  });
});

describe('liveness and reconciliation branches — the same guard applies', () => {
  /**
   * The 240/480-minute liveness branch. `workspace_missing` was a CONCLUSIVE
   * death verdict with only a supersession escape, so a task with no workspace
   * row was failed even with a `sleeping` snapshot (2 production rows on this
   * branch, 2 more on the reconciliation-grace branch).
   */
  it('preserves a sleeping session past the hard timeout when the workspace row is gone', async () => {
    seedTask({ workspaceId: null, startedAt: iso(PAST_HARD_TIMEOUT) });
    seedSnapshot({ workspaceId: null });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.failedInProgress).toBe(0);
  });

  /**
   * THE LIVENESS CONTROL. A genuinely dead runtime — no workspace row and no
   * snapshot at all — must still be terminalized. Without this, "preserved" would
   * also be satisfied by the liveness branch being broken outright.
   */
  it('still terminalizes a genuinely gone runtime with no snapshot', async () => {
    seedTask({ workspaceId: null, startedAt: iso(PAST_HARD_TIMEOUT) });

    const result = await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('workspace_missing');
    expect(result.failedInProgress).toBe(1);
  });

  /**
   * A terminally-failed snapshot is NOT restorable — the resumer refuses it, so
   * the destroyer must too (`.claude/rules/58`: equal, not merely safer). 4
   * production rows had this shape and were correctly failed.
   */
  it('still terminalizes when the snapshot is terminally failed', async () => {
    seedTask({ workspaceId: null, startedAt: iso(PAST_HARD_TIMEOUT) });
    seedSnapshot({ workspaceId: null, sleepStatus: 'terminal_failed' });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
  });

  /**
   * The reconciliation-grace branch (`timeForCheck > min(halfThreshold,
   * mismatchGraceMs)`), reached below the 4h soft timeout. Same classifier, same
   * blind spot before the fix.
   */
  it('preserves a sleeping session on the reconciliation-grace branch', async () => {
    seedTask({ workspaceId: null, startedAt: iso(-30 * 60 * 1000) });
    seedSnapshot({ workspaceId: null });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /** Its discriminating control on the same branch. */
  it('still terminalizes a dead runtime on the reconciliation-grace branch', async () => {
    seedTask({ workspaceId: null, startedAt: iso(-30 * 60 * 1000) });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('conclusively gone');
  });

  /**
   * THE `node_not_live` SHAPE, and the reason the classifier fix had to cover all
   * five conclusive-death returns rather than the two workspace-level ones.
   *
   * `NodeLifecycle` destroys the node at sleep and only rewrites
   * `workspaces.status` to `deleted` about five minutes later (the gap described
   * in `.claude/rules/58`). Inside that window the workspace still reads
   * `running`, so `needsTaskSupersessionProbe` declines to probe and the verdict
   * lands on `node_not_live` — conclusive, and unguarded before this fix.
   * Production carried it: `node_not_live` with a `scheduled` snapshot, twice in
   * the 30 days to 2026-09-14.
   */
  it('preserves a sleeping session whose node is destroyed while the workspace still reads running', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at, runtime,
                          vm_size, vm_location, cloud_provider, created_at, updated_at)
       VALUES (?, 'user-1', 'node', 'destroyed', 'healthy', ?, 'vm', 'cpx21', 'nbg1', 'hetzner', ?, ?)`
      )
      .run(NODE_ID, iso(-30_000), iso(PAST_HARD_TIMEOUT), iso(0));
    seedSnapshot();

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /** Its discriminating control: a destroyed node with no sleep record still fails. */
  it('still terminalizes a destroyed node with no sleep record', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at, runtime,
                          vm_size, vm_location, cloud_provider, created_at, updated_at)
       VALUES (?, 'user-1', 'node', 'destroyed', 'healthy', ?, 'vm', 'cpx21', 'nbg1', 'hetzner', ?, ?)`
      )
      .run(NODE_ID, iso(-30_000), iso(PAST_HARD_TIMEOUT), iso(0));

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('node_not_live');
  });

  /**
   * The `task_acp_session_terminal` shape: workspace and node both still read
   * healthy, but the task's ACP sessions have gone terminal — which is what sleep
   * does to them. Conclusive, and unguarded before this fix.
   */
  it('preserves a sleeping session whose ACP sessions have gone terminal', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    seedNode({ heartbeatAt: iso(-30_000) });
    seedSnapshot();
    getTaskAcpLivenessSignalsMock.mockResolvedValue({
      sessions: [
        {
          id: 'acp-1',
          status: 'completed',
          workspaceId: WORKSPACE_ID,
          lastHeartbeatAt: Date.now(),
          updatedAt: Date.now(),
          startedAt: Date.now() - 1_000,
          createdAt: Date.now() - 2_000,
        },
      ],
      total: 1,
      sessionWork: null,
    });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /** Its discriminating control. */
  it('still terminalizes terminal ACP sessions with no sleep record', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    seedNode({ heartbeatAt: iso(-30_000) });
    getTaskAcpLivenessSignalsMock.mockResolvedValue({
      sessions: [
        {
          id: 'acp-1',
          status: 'completed',
          workspaceId: WORKSPACE_ID,
          lastHeartbeatAt: Date.now(),
          updatedAt: Date.now(),
          startedAt: Date.now() - 1_000,
          createdAt: Date.now() - 2_000,
        },
      ],
      total: 1,
      sessionWork: null,
    });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('task_acp_session_terminal');
  });

  /**
   * THE `cf_container_<terminal>` SHAPE — the third previously-unguarded conclusive
   * path, and the one that matters for Instant sessions: sleeping an Instant
   * workspace stops its container while `workspaces.status` still reads `running`.
   */
  it('preserves a sleeping Instant session whose container has stopped', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    seedNode({ heartbeatAt: iso(-30_000), runtime: 'cf-container' });
    seedSnapshot();
    containerLifecycleMock.mockResolvedValue({ status: 'stopped', activeWorkStatus: null });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.candidatesScanned).toBe(1);
  });

  /** Its discriminating control: the same stopped container with no sleep record. */
  it('still terminalizes a stopped Instant container with no sleep record', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    seedNode({ heartbeatAt: iso(-30_000), runtime: 'cf-container' });
    containerLifecycleMock.mockResolvedValue({ status: 'stopped', activeWorkStatus: null });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('cf_container_stopped');
  });

  /**
   * `sleep_status='failed'` is a retry-eligible in-flight state the sleep
   * scheduler produces routinely, and it takes a different arm of the shared
   * predicate than `scheduled` (the `sleep_attempts < ?` retry budget).
   */
  it('preserves a conversation whose sleep attempt failed but is still retry-eligible', async () => {
    seedTask({ workspaceId: null });
    seedSnapshot({
      workspaceId: null,
      sleepStatus: 'failed',
      sleepingAt: null,
      sleepClaimedAt: iso(-60_000),
    });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * The guard is deliberately NOT scoped to `task_mode='conversation'`. The
   * incident population was conversation-mode, but recoverability is a property of
   * the SESSION, not of the task's lifecycle semantics: a task-mode row paused at
   * `awaiting_followup` whose session slept is equally wakeable, and failing it
   * would destroy the same recoverable work. This test pins that decision so a
   * future reader does not "tighten" it back to conversation-only.
   */
  it('preserves a task-mode row whose session is asleep, not just conversation-mode', async () => {
    seedTask({ taskMode: 'task', workspaceId: null });
    seedSnapshot({ workspaceId: null });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    // Liveness pairing: 'nothing changed' is also satisfied by the sweep never
    // reaching this candidate (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * A live runtime is still live — this must NOT be swept up by any of the new
   * preserve paths, and it must not be failed either.
   */
  it('leaves a live runtime below the ceiling untouched', async () => {
    seedTask({ executionStep: 'running', startedAt: iso(PAST_HARD_TIMEOUT) });
    seedWorkspace({ status: 'running', createdAt: iso(PAST_HARD_TIMEOUT) });
    seedNode({ heartbeatAt: iso(-30_000) });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.heartbeatSkipped).toBe(1);
  });
});
