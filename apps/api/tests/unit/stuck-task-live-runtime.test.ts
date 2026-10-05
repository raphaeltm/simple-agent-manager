/**
 * Stuck-task recovery for live runtimes, replayed from the 2026-10-04 production
 * evidence (task 01M42YQSYPGFSX8ADC3ZYMXJVY).
 *
 * Two findings, both exercised through the real `recoverStuckTasks` entry point
 * (`.claude/rules/62`):
 *
 * 1. The sweep kept idle conversations (correctly) but recorded them as "VM agent
 *    heartbeat is recent ... hard timeout at 480 min", once per five-minute sweep.
 *    The real basis was the task's own ACP session heartbeat on an idle agent,
 *    and no 480-minute timeout exists for a live runtime.
 * 2. The 24h runaway-cost ceiling was held off for 11 hours (task
 *    01M3Z4CCZH5N22754V7CVVN9WR reached a 35.3h runtime generation) because a
 *    failing sleep was retried every few minutes and each retry re-stamped the
 *    timestamp the "in flight" predicate ages from.
 *
 * The harness is real end to end where the bug lived: D1 tables on SQLite built
 * from the drizzle schema (`.claude/rules/28`), the ProjectData SQL store with
 * migrations, the real ProjectData reader behind the cron adapter's RPC, the real
 * activity writer (`upsertActivityState`), and the real `persistError`. The clock
 * is injected, so a 25-hour runtime costs nothing to simulate.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../src/db/observability-schema';
import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import { upsertActivityState } from '../../src/durable-objects/project-data/session-state';
import { readTaskAcpLivenessSignals } from '../../src/durable-objects/project-data/task-runtime-liveness';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
import type { Env } from '../../src/env';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }));
vi.mock('../../src/services/fetch-timeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/fetch-timeout')>();
  return { ...actual, fetchWithTimeout: fetchWithTimeoutMock };
});

const { cleanupTaskRunMock } = vi.hoisted(() => ({ cleanupTaskRunMock: vi.fn() }));
vi.mock('../../src/services/task-runner', () => ({ cleanupTaskRun: cleanupTaskRunMock }));

const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/logger')>()),
  log: logSpy,
  createModuleLogger: () => logSpy,
}));

/** The cron adapter reaches ProjectData over RPC; route it to the real reader. */
const { projectDataRpc } = vi.hoisted(() => ({
  projectDataRpc: {
    sql: null as SqlStorage | null,
    messages: [] as Record<string, unknown>[],
    /** Simulates an unreachable ProjectData Durable Object. */
    unreachable: false,
  },
}));
vi.mock('../../src/services/project-data', () => ({
  getMessages: vi.fn(async () => ({ messages: projectDataRpc.messages, hasMore: false })),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listAcpSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  failSession: vi.fn().mockResolvedValue(undefined),
  getTaskAcpLivenessSignals: vi.fn(
    async (
      _env: unknown,
      _projectId: string,
      opts: Parameters<typeof readTaskAcpLivenessSignals>[2]
    ) => {
      if (projectDataRpc.unreachable) throw new Error('ProjectData RPC failed');
      if (!projectDataRpc.sql) throw new Error('ProjectData store not seeded');
      return readTaskAcpLivenessSignals(projectDataRpc.sql, {} as ProjectDataEnv, opts);
    }
  ),
}));
vi.mock('../../src/services/vm-agent-container', () => ({
  inspectVmAgentContainerLifecycle: vi.fn(),
}));

const PROJECT_ID = 'project-1';
const TASK_ID = '01M3Z4CCZH5N22754V7CVVN9WR';
const WORKSPACE_ID = '01M3Z4CGTEWNBP3VSTFQK90XJ1';
const NODE_ID = '01M3YEDZ53BN98PN3WVNWNWF9P';
const CHAT_SESSION_ID = 'ebdc3d65-2076-47f0-a437-3316799799ef';
const ACP_ID = '01M3Z4E5JRK12M91ZTE1YEQNMP';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The injected "now" every scenario starts from. */
const T0 = Date.parse('2026-10-04T07:00:00.000Z');

let d1: Database.Database;
let projectDb: Database.Database;
let doSql: SqlStorage;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function seedTask(o: { startedAt: number; workspaceId?: string | null }): void {
  d1.prepare(
    `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                        triggered_by, chat_session_id, execution_step, task_mode,
                        started_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, 'task', 'in_progress', 0, 'user', ?, 'awaiting_followup',
             'conversation', ?, 'user-1', ?, ?)`
  ).run(
    TASK_ID,
    PROJECT_ID,
    o.workspaceId === undefined ? WORKSPACE_ID : o.workspaceId,
    CHAT_SESSION_ID,
    iso(o.startedAt),
    iso(o.startedAt),
    iso(o.startedAt)
  );
}

/** A running workspace on a healthy node: a live runtime generation. */
function seedLiveRuntime(o: { generationStartedAt: number; nodeHeartbeatAt: number }): void {
  d1.prepare(
    `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size, vm_location,
                             project_id, chat_session_id, node_id, created_at, updated_at)
     VALUES (?, 'user-1', 'ws', 'org/repo', 'main', 'running', 'cx23', 'hel1', ?, ?, ?, ?, ?)`
  ).run(
    WORKSPACE_ID,
    PROJECT_ID,
    CHAT_SESSION_ID,
    NODE_ID,
    iso(o.generationStartedAt),
    iso(o.nodeHeartbeatAt)
  );
  d1.prepare(
    `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at, runtime,
                        vm_size, vm_location, cloud_provider, created_at, updated_at)
     VALUES (?, 'user-1', 'node', 'running', 'healthy', ?, 'vm', 'cx23', 'hel1', 'hetzner', ?, ?)`
  ).run(NODE_ID, iso(o.nodeHeartbeatAt), iso(o.generationStartedAt), iso(o.nodeHeartbeatAt));
}

/** The task's ProjectData chat session and its running ACP session. */
function seedAcpSession(o: { heartbeatAt: number; initialPrompt?: string }): void {
  doSql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Task', 'active', 0, ?, ?, ?)`,
    CHAT_SESSION_ID,
    WORKSPACE_ID,
    TASK_ID,
    T0 - 30 * HOUR,
    T0 - 30 * HOUR,
    o.heartbeatAt
  );
  doSql.exec(
    `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status, agent_type,
                               initial_prompt, last_heartbeat_at, created_at, updated_at, started_at)
     VALUES (?, ?, ?, ?, 'running', 'claude-code', ?, ?, ?, ?, ?)`,
    ACP_ID,
    CHAT_SESSION_ID,
    WORKSPACE_ID,
    NODE_ID,
    o.initialPrompt ?? null,
    o.heartbeatAt,
    T0 - 30 * HOUR,
    o.heartbeatAt,
    T0 - 30 * HOUR
  );
}

/** Keep the ACP heartbeat and the node heartbeat fresh at `at`, as the VM agent does. */
function heartbeat(at: number): void {
  doSql.exec(
    'UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?',
    at,
    at,
    ACP_ID
  );
  d1.prepare('UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?').run(iso(at), NODE_ID);
}

/** A prompt turn that ran and ended: the agent handed control back at `endedAt`. */
function promptTurnEnded(startedAt: number, endedAt: number): void {
  upsertActivityState(doSql, ACP_ID, {
    activity: 'prompting',
    observedAt: startedAt,
    now: startedAt,
  });
  upsertActivityState(doSql, ACP_ID, { activity: 'idle', observedAt: endedAt, now: endedAt });
}

/** Delay before a failed sleep is retried (`DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS`). */
const SLEEP_RETRY_DELAY = 5 * MINUTE;

/**
 * A `session_snapshots` row. A failed sleep keeps a due `sleep_after` and a small
 * attempt count, so the row is in flight under both the current predicate and the
 * bounded-episode predicate the sleep-budget task is introducing.
 */
function seedSleepRecord(o: {
  sleepStatus: string;
  sleepingAt?: number | null;
  sleepClaimedAt?: number | null;
  status?: string;
  degradation?: string;
}): void {
  d1.prepare(
    `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
                                    runtime, status, degradation, manifest_r2_key, home_r2_key,
                                    expires_at, sleeping_at, sleep_status, sleep_after,
                                    sleep_claimed_at, sleep_attempts, recovery_attempts,
                                    created_at, updated_at)
     VALUES ('snapshot-1', ?, ?, ?, 'user-1', ?, 'vm', ?, ?, 'manifest-key', 'home-key', ?, ?, ?,
             ?, ?, 2, 0, ?, ?)`
  ).run(
    PROJECT_ID,
    WORKSPACE_ID,
    NODE_ID,
    CHAT_SESSION_ID,
    o.status ?? 'degraded',
    o.degradation ?? 'transcript-only',
    iso(T0 + 7 * 24 * HOUR),
    o.sleepingAt == null ? null : iso(o.sleepingAt),
    o.sleepStatus,
    o.sleepClaimedAt == null || o.sleepStatus === 'sleeping'
      ? null
      : iso(o.sleepClaimedAt + SLEEP_RETRY_DELAY),
    o.sleepClaimedAt == null ? null : iso(o.sleepClaimedAt),
    iso(T0 - 30 * HOUR),
    iso(T0 - 30 * HOUR)
  );
}

/**
 * One more failed attempt: the claim stamps `sleep_claimed_at` and the failure
 * reschedules `sleep_after`, the timestamps the in-flight predicate ages from. The
 * status stays `failed`, as every 5-minute sample of the incident showed.
 */
function retryClaim(at: number): void {
  d1.prepare(
    `UPDATE session_snapshots SET sleep_claimed_at = ?, sleep_after = ?, updated_at = ?
      WHERE id = 'snapshot-1'`
  ).run(iso(at), iso(at + SLEEP_RETRY_DELAY), iso(at));
}

function env(overrides: Partial<Record<string, unknown>> = {}): Env {
  const kv = new Map<string, string>();
  return {
    DATABASE: createSqliteD1(d1),
    OBSERVABILITY_DATABASE: createSqliteD1(d1),
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
    TASK_RUN_ABSOLUTE_CEILING_MS: String(24 * HOUR),
    NODE_HEARTBEAT_STALE_SECONDS: '180',
    BASE_DOMAIN: 'example.test',
    AI: { run: vi.fn() },
    ...overrides,
  } as unknown as Env;
}

function taskRow(): { status: string; error_message: string | null } {
  return d1.prepare('SELECT status, error_message FROM tasks WHERE id = ?').get(TASK_ID) as {
    status: string;
    error_message: string | null;
  };
}

interface PersistedRow {
  level: string;
  message: string;
  context: Record<string, unknown>;
}

function liveRuntimeRows(): PersistedRow[] {
  return (
    d1
      .prepare(
        `SELECT level, message, context FROM platform_errors
          WHERE task_id = ? AND context LIKE '%stuck_task_heartbeat_skip%'
          ORDER BY timestamp`
      )
      .all(TASK_ID) as Array<{ level: string; message: string; context: string }>
  ).map((row) => ({ ...row, context: JSON.parse(row.context) as Record<string, unknown> }));
}

function loggedEvents(level: 'info' | 'warn', event: string): Array<Record<string, unknown>> {
  return logSpy[level].mock.calls
    .filter((call) => call[0] === event)
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockResolvedValue(new Response(null, { status: 200 }));
  cleanupTaskRunMock.mockResolvedValue(undefined);
  d1 = new Database(':memory:');
  createSchemaTables(d1, [
    schema.tasks,
    schema.taskStatusEvents,
    schema.workspaces,
    schema.nodes,
    schema.sessionSnapshots,
    schema.triggerExecutions,
    schema.projectEventSourceOutbox,
    observabilitySchema.platformErrors,
  ]);
  projectDb = new Database(':memory:');
  doSql = createSqlStorage(projectDb);
  runMigrations(doSql);
  projectDataRpc.sql = doSql;
  projectDataRpc.messages = [];
  projectDataRpc.unreachable = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live-runtime record: what kept the task, and why', () => {
  /** Nine hours in, idle for eight: the a06bcb69 / 83d09155 shape. */
  function seedIdleConversation(): void {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    promptTurnEnded(T0 - 8 * HOUR - MINUTE, T0 - 8 * HOUR);
  }

  it('records an idle conversation as idle, with the bound that really applies', async () => {
    seedIdleConversation();

    const result = await recoverStuckTasks(env());

    // Kept: an idle conversation awaiting its user is never a hung task.
    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.heartbeatSkipped).toBe(1);

    const rows = liveRuntimeRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.level).toBe('info');
    expect(row.context).toMatchObject({
      recoveryType: 'stuck_task_heartbeat_skip',
      preservationKey: 'task_acp_session_live:idle',
      livenessReason: 'task_acp_session_live',
      workState: 'idle',
      activity: 'idle',
      acpHeartbeatAgeMs: 20_000,
      lastActivityAgeMs: 8 * HOUR,
      runtimeGenerationMs: 9 * HOUR,
      absoluteCeilingMs: 24 * HOUR,
      sleepOutcome: 'none',
    });
    expect(row.message).toContain('its agent session is alive but idle');
    expect(row.message).toContain('control handed back 8h 0m ago');
    expect(row.message).toContain('No sleep is scheduled or in flight for it.');
    expect(row.message).toContain('Live basis: task_acp_session_live.');
    expect(row.message).toContain(
      'bounded only by the 1440-min absolute ceiling on runtime-generation age (now 540 min)'
    );
    // The two claims that misled the 2026-10-04 investigation must be gone.
    expect(row.message).not.toMatch(/hard timeout|VM agent heartbeat|480/);
  });

  it('writes one durable row per liveness basis, and a new one when the basis changes', async () => {
    seedIdleConversation();

    await recoverStuckTasks(env());
    vi.setSystemTime(T0 + 5 * MINUTE);
    heartbeat(T0 + 5 * MINUTE - 10_000);
    const second = await recoverStuckTasks(env());

    // Liveness: the second sweep did reach and keep the task.
    expect(second.heartbeatSkipped).toBe(1);
    expect(liveRuntimeRows()).toHaveLength(1);
    // Every sweep still logs, so the timeline survives in Workers Logs.
    expect(loggedEvents('info', 'stuck_task.skipped_active_heartbeat')).toHaveLength(2);

    // The user replies: a prompt turn starts.
    vi.setSystemTime(T0 + 10 * MINUTE);
    heartbeat(T0 + 10 * MINUTE - 10_000);
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 + 9 * MINUTE,
      now: T0 + 9 * MINUTE,
    });
    await recoverStuckTasks(env());

    const rows = liveRuntimeRows();
    expect(rows.map((row) => row.context.preservationKey)).toEqual([
      'task_acp_session_live:idle',
      'task_prompt_turn_active:prompt_turn_active',
    ]);
    expect(rows[1].message).toContain('a prompt turn is in progress');
  });

  /** The dedupe key holds `_`, a LIKE wildcard: it must match literally. */
  it('does not let a near-miss key suppress the record', async () => {
    seedIdleConversation();
    d1.prepare(
      `INSERT INTO platform_errors (id, source, level, message, context, task_id, timestamp, created_at)
       VALUES ('near-miss', 'api', 'info', 'older row', ?, ?, ?, ?)`
    ).run(
      JSON.stringify({
        recoveryType: 'stuck_task_heartbeat_skip',
        preservationKey: 'taskXacpXsessionXlive:idle',
      }),
      TASK_ID,
      T0 - HOUR,
      T0 - HOUR
    );

    await recoverStuckTasks(env());

    expect(liveRuntimeRows().map((row) => row.context.preservationKey)).toEqual([
      'taskXacpXsessionXlive:idle',
      'task_acp_session_live:idle',
    ]);
  });

  it('records an active prompt turn with its basis and ages', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 90 * MINUTE,
      now: T0 - 90 * MINUTE,
    });
    // A persisted message refreshes the turn's activity clock while it works.
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 2 * MINUTE,
      now: T0 - 2 * MINUTE,
    });

    await recoverStuckTasks(env());

    const [row] = liveRuntimeRows();
    expect(row.level).toBe('info');
    expect(row.context).toMatchObject({
      preservationKey: 'task_prompt_turn_active:prompt_turn_active',
      livenessReason: 'task_prompt_turn_active',
      workState: 'prompt_turn_active',
      activity: 'prompting',
      lastActivityAgeMs: 2 * MINUTE,
      promptStartedAgeMs: 90 * MINUTE,
      runtimeGenerationMs: 9 * HOUR,
      sleepOutcome: null,
    });
    expect(row.message).toContain(
      'a prompt turn is in progress (last activity 2m ago; turn started 1h 30m ago).'
    );
    expect(row.message).toContain('(now 540 min)');
  });

  it('fails a long live prompt when Clef classifies transcript silence as stalled', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 90 * MINUTE,
      now: T0 - 90 * MINUTE,
    });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 2 * MINUTE,
      now: T0 - 2 * MINUTE,
    });
    projectDataRpc.messages = [
      {
        id: 'msg-1',
        role: 'tool',
        content: 'Started release artifact build.',
        createdAt: T0 - 80 * MINUTE,
      },
    ];
    const aiRun = vi.fn().mockResolvedValue({
      answers: {
        stall_status: {
          value: 'stalled',
          probabilities: { stalled: 0.93, still_working: 0.04, uncertain: 0.03 },
        },
        reason: { value: 'transcript_silent' },
      },
    });

    const result = await recoverStuckTasks(env({ AI: { run: aiRun } }));

    expect(result.failedInProgress).toBe(1);
    expect(result.heartbeatSkipped).toBe(0);
    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain('SAM detected a stalled agent turn');
    expect(cleanupTaskRunMock).toHaveBeenCalledWith(TASK_ID, expect.anything());
    expect(aiRun).toHaveBeenCalledWith(
      '@cf/cloudflare/clef',
      expect.objectContaining({
        model: 'clef',
        questions: expect.objectContaining({ stall_status: expect.any(Object) }),
      })
    );
  });

  it('keeps a long live prompt when transcript output is recent', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 90 * MINUTE,
      now: T0 - 90 * MINUTE,
    });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 2 * MINUTE,
      now: T0 - 2 * MINUTE,
    });
    projectDataRpc.messages = [
      {
        id: 'msg-1',
        role: 'tool',
        content: 'Compiling crate simple-agent-manager...',
        createdAt: T0 - 10 * MINUTE,
      },
    ];
    const aiRun = vi.fn();

    const result = await recoverStuckTasks(env({ AI: { run: aiRun } }));

    expect(result.heartbeatSkipped).toBe(1);
    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('names the failing sleep that is not releasing an idle runtime', async () => {
    seedIdleConversation();
    seedSleepRecord({ sleepStatus: 'failed', sleepClaimedAt: T0 - 2 * MINUTE });

    await recoverStuckTasks(env());

    const [row] = liveRuntimeRows();
    expect(row.context).toMatchObject({
      sleepOutcome: 'preserve',
      sleepArm: 'in_flight',
      sleepStatus: 'failed',
    });
    expect(row.message).toContain('Its sleep is in flight or retrying (sleep status: failed).');
  });

  /**
   * An OOM-killed tool leaves exactly this: the turn says `prompting`, nothing has
   * been reported for hours, and the agent process still heartbeats. The runtime
   * is live (never fail it on this evidence), but the stall must be visible.
   */
  it('warns when a prompt turn has reported nothing for hours while its agent stays alive', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'prompting',
      observedAt: T0 - 3 * HOUR,
      now: T0 - 3 * HOUR,
    });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('in_progress');
    const [row] = liveRuntimeRows();
    expect(row.level).toBe('warn');
    expect(row.context).toMatchObject({
      preservationKey: 'task_acp_session_live:prompt_turn_unproven',
      workState: 'prompt_turn_unproven',
      promptStartedAgeMs: 3 * HOUR,
    });
    expect(row.message).toContain('it may be on a long tool call or wedged');
    expect(loggedEvents('warn', 'stuck_task.skipped_active_heartbeat')).toHaveLength(1);
  });

  it('reports finite tool or background work as work in flight', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    promptTurnEnded(T0 - 2 * HOUR, T0 - HOUR);
    upsertActivityState(doSql, ACP_ID, {
      activity: 'idle',
      observedAt: T0 - 30_000,
      now: T0 - 30_000,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude-background-tasks',
      runtimeWorkProgressAt: T0 - MINUTE,
    });

    await recoverStuckTasks(env());

    const [row] = liveRuntimeRows();
    expect(row.context).toMatchObject({
      preservationKey: 'task_runtime_work_active:runtime_work_active',
      runtimeWorkProgressAgeMs: MINUTE,
    });
    expect(row.message).toContain('agent tool or background work is in flight');
  });

  /** Policy a35180d5: no prompt, error text or other content reaches logs or rows. */
  it('never copies prompt text or error details into logs or records', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000, initialPrompt: 'CANARY-PROMPT-8f2c' });
    upsertActivityState(doSql, ACP_ID, {
      activity: 'error',
      observedAt: T0 - HOUR,
      now: T0 - HOUR,
      statusError: 'CANARY-ERROR-91ab sk-live-secret',
    });

    await recoverStuckTasks(env());

    const persisted = JSON.stringify(liveRuntimeRows());
    const logged = JSON.stringify([
      ...logSpy.info.mock.calls,
      ...logSpy.warn.mock.calls,
      ...logSpy.error.mock.calls,
      ...logSpy.debug.mock.calls,
    ]);
    for (const canary of ['CANARY-PROMPT-8f2c', 'CANARY-ERROR-91ab', 'sk-live-secret']) {
      expect(persisted).not.toContain(canary);
      expect(logged).not.toContain(canary);
    }
    // Liveness: the record exists and carries the safe label.
    expect(liveRuntimeRows()[0].context).toMatchObject({ workState: 'unknown', activity: 'error' });
  });

  /**
   * Canonical idleness (policy 0f05422d): child tasks and durable subtask waits
   * never pin compute. A parent that ended its turn to wait for its children is
   * idle, and nothing in the record treats the children as its work.
   */
  it('reports a parent waiting on subtasks as idle; its children are not its work', async () => {
    seedIdleConversation();
    // A child the parent dispatched two minutes ago, still being placed.
    d1.prepare(
      `INSERT INTO tasks (id, project_id, user_id, parent_task_id, title, status, priority,
                          triggered_by, execution_step, task_mode, created_by, created_at,
                          updated_at)
       VALUES ('child-1', ?, 'user-1', ?, 'child', 'queued', 0, 'mcp', 'node_selection', 'task',
               'user-1', ?, ?)`
    ).run(PROJECT_ID, TASK_ID, iso(T0 - 2 * MINUTE), iso(T0 - 2 * MINUTE));

    const result = await recoverStuckTasks(env());

    expect(result.candidatesScanned).toBe(2);
    expect(liveRuntimeRows()[0].context).toMatchObject({
      workState: 'idle',
      sleepOutcome: 'none',
    });
    const child = d1.prepare(`SELECT status FROM tasks WHERE id = 'child-1'`).get() as {
      status: string;
    };
    expect(child.status).toBe('queued');
  });

  /**
   * A healthy host does not make a task live: its own ACP session's heartbeat has
   * gone stale, so the verdict is inconclusive. Kept (never failed on stale
   * evidence), and not recorded as a live runtime either.
   */
  it('keeps but does not call live a task whose own ACP heartbeat is stale on a healthy host', async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20 * MINUTE });
    promptTurnEnded(T0 - 2 * HOUR, T0 - HOUR);

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.heartbeatSkipped).toBe(0);
    expect(liveRuntimeRows()).toHaveLength(0);
    expect(result.candidatesScanned).toBe(1);
  });

  /** An unreachable ProjectData object is unknown, never death evidence. */
  it('keeps a task when ProjectData cannot be reached', async () => {
    seedIdleConversation();
    projectDataRpc.unreachable = true;

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.heartbeatSkipped).toBe(0);
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * Identity: an ACP session left over from the task's previous workspace (a
   * prior runtime generation) still heartbeats. It must not make the CURRENT
   * workspace live, so the verdict stays inconclusive.
   */
  it("does not let an older generation's ACP session prove the current runtime live", async () => {
    seedTask({ startedAt: T0 - 9 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 9 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    doSql.exec(`UPDATE acp_sessions SET workspace_id = 'previous-workspace' WHERE id = ?`, ACP_ID);

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.heartbeatSkipped).toBe(0);
    expect(liveRuntimeRows()).toHaveLength(0);
    // Liveness: the sweep did select and evaluate the task (`.claude/rules/62`).
    expect(result.candidatesScanned).toBe(1);
  });

  /**
   * The shape that followed the manual node deletion on 2026-10-04: the runtime is
   * gone. Still failed, but the reason states the observed age, not "480".
   */
  it('fails a runtime that is gone with its real age and cause', async () => {
    seedTask({ startedAt: T0 - 23 * HOUR, workspaceId: null });

    const result = await recoverStuckTasks(env());

    expect(result.failedInProgress).toBe(1);
    expect(taskRow()).toEqual({
      status: 'failed',
      error_message:
        'Task runtime is no longer live (workspace_missing); task started 1380 minutes ago. ' +
        'Last step: awaiting_followup.',
    });
  });
});

describe('absolute ceiling: an in-flight sleep cannot hold it off forever', () => {
  /** A live runtime whose generation began at `generationStart`, mid sleep-retry loop. */
  function seedRetryLoop(generationStart: number): void {
    seedTask({ startedAt: generationStart });
    seedLiveRuntime({ generationStartedAt: generationStart, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    promptTurnEnded(generationStart + HOUR, generationStart + HOUR + MINUTE);
    seedSleepRecord({ sleepStatus: 'failed', sleepClaimedAt: T0 - MINUTE });
  }

  /**
   * The production incident, replayed. The sleep is retried every few minutes and
   * every claim re-stamps the in-flight anchor. Before the fix each of these sweeps
   * preserved the task, and the ceiling never fired (35.3h observed).
   */
  it('defers inside the sleep grace, then terminalizes past it', async () => {
    const generationStart = T0 - 24 * HOUR - 10 * MINUTE;
    seedRetryLoop(generationStart);

    // 10 minutes past the ceiling: still within the 60-minute grace.
    await recoverStuckTasks(env());
    expect(taskRow().status).toBe('in_progress');
    expect(loggedEvents('info', 'stuck_task.preserved_sleeping')).toContainEqual(
      expect.objectContaining({ source: 'ceiling', arm: 'in_flight', overrunMs: 10 * MINUTE })
    );

    // 50 minutes past, after another retry claim: still deferring.
    vi.setSystemTime(generationStart + 24 * HOUR + 50 * MINUTE);
    heartbeat(Date.now() - 10_000);
    retryClaim(Date.now() - MINUTE);
    await recoverStuckTasks(env());
    expect(taskRow().status).toBe('in_progress');

    // 65 minutes past, after yet another retry claim: the grace has run out.
    vi.setSystemTime(generationStart + 25 * HOUR + 5 * MINUTE);
    heartbeat(Date.now() - 10_000);
    retryClaim(Date.now() - MINUTE);
    const result = await recoverStuckTasks(env());

    expect(result.failedInProgress).toBe(1);
    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain(
      'its automatic sleep was still in flight (sleep status: failed) 65 minutes past the ceiling, ' +
        'beyond the 60-minute sleep grace.'
    );
    expect(loggedEvents('warn', 'stuck_task.ceiling_sleep_grace_expired')).toHaveLength(1);
    // The terminal gate must not re-defer to the very sleep the grace outlasted.
    expect(loggedEvents('warn', 'stuck_task.in_flight_sleep_not_honored')).toHaveLength(1);
    expect(cleanupTaskRunMock).toHaveBeenCalledWith(TASK_ID, expect.anything());
  });

  it('honours TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS', async () => {
    seedRetryLoop(T0 - 35 * HOUR);

    await recoverStuckTasks(env({ TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS: String(12 * HOUR) }));

    // 11 hours past the ceiling, inside a 12-hour grace.
    expect(taskRow().status).toBe('in_progress');
  });

  it('still defers to a restorable sleep record, however far past the ceiling', async () => {
    seedTask({ startedAt: T0 - 35 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 35 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });
    seedSleepRecord({
      sleepStatus: 'sleeping',
      sleepingAt: T0 - 2 * MINUTE,
      status: 'available',
      degradation: 'none',
    });

    const result = await recoverStuckTasks(env());

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.candidatesScanned).toBe(1);
    expect(loggedEvents('info', 'stuck_task.preserved_sleeping')).toContainEqual(
      expect.objectContaining({ source: 'ceiling', arm: 'restorable' })
    );
  });

  /** `.claude/rules/58` requirement 4: an unknown answer never resolves to destroy. */
  it('withholds the ceiling when the sleep record cannot be read', async () => {
    seedRetryLoop(T0 - 35 * HOUR);
    const real = createSqliteD1(d1);

    const result = await recoverStuckTasks(
      env({
        DATABASE: {
          ...real,
          prepare: (query: string) =>
            query.includes('FROM session_snapshots')
              ? { bind: () => ({ first: () => Promise.reject(new Error('D1 unavailable')) }) }
              : real.prepare(query),
        },
      })
    );

    expect(taskRow()).toEqual({ status: 'in_progress', error_message: null });
    expect(result.candidatesScanned).toBe(1);
  });

  /** Control: no sleep record at all, so the ceiling fires with today's reason. */
  it('terminalizes a live runtime with no sleep record at the ceiling, as before', async () => {
    seedTask({ startedAt: T0 - 25 * HOUR });
    seedLiveRuntime({ generationStartedAt: T0 - 25 * HOUR, nodeHeartbeatAt: T0 - 30_000 });
    seedAcpSession({ heartbeatAt: T0 - 20_000 });

    await recoverStuckTasks(env());

    expect(taskRow().status).toBe('failed');
    expect(taskRow().error_message).toContain(
      'live-runtime tasks are bounded to prevent unbounded compute'
    );
    expect(loggedEvents('warn', 'stuck_task.ceiling_sleep_grace_expired')).toHaveLength(0);
  });

  it('warns when the configured grace is shorter than one sleep episode', async () => {
    seedTask({ startedAt: T0 - HOUR });

    await recoverStuckTasks(env({ TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS: String(10 * MINUTE) }));

    expect(loggedEvents('warn', 'stuck_task.misconfigured_ceiling_sleep_grace')).toEqual([
      expect.objectContaining({
        ceilingSleepGraceMs: 10 * MINUTE,
        inFlightSleepMaxAgeMs: 30 * MINUTE,
      }),
    ]);
  });
});
