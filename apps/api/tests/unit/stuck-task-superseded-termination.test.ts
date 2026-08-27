/**
 * Sweep-level regression for the 2026-08-24 incident, at the layer that actually
 * writes the status.
 *
 * The classifier tests in `stuck-task-slept-session-liveness.test.ts` prove the
 * verdict carries the supersession marker. They do NOT prove the sweep honours
 * it — and a review round found exactly that gap: `recoverStuckTasks` has three
 * independent branches that can terminalize a task, and the first cut of this fix
 * only taught ONE of them about supersession. The two timeout branches
 * (`executionMs > maxExecutionMs`, `executionMs > absoluteCeilingMs`) set
 * `isStuck` first, which skips the fixed branch entirely, so a superseded
 * predecessor was still written `failed`.
 *
 * That was the mainline outcome, not an edge case: a predecessor's `started_at`
 * is never reset by the handoff, so `executionMs` keeps growing for the whole
 * time it sits superseded — and session recovery exists precisely for
 * conversations idle for hours to days (7-day snapshot TTL).
 *
 * These tests drive the real `recoverStuckTasks` against a real SQL engine and
 * assert the PERSISTED `tasks.status`, per `.claude/rules/66` required tests.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { log } from '../../src/lib/logger';
import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

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
  failSession: vi.fn().mockResolvedValue(undefined),
}));

const PROJECT_ID = 'project-1';
const WORKSPACE_ID = '01M06502R3MW9JY75M7WK68B42';
const NODE_ID = '01M064TG56ECJW1D127H32BRVJ';
const CHAT_SESSION_ID = '8bd22a42-cf37-41fa-9947-30e78a0b6ece';
const PREDECESSOR_ID = '01M064TG9QK8ZQ3XW0M6P7RCTN';
const SUCCESSOR_ID = '01M0SDBZXG5AEGZJ0JH2YC30Q4';

let sqlite: Database.Database;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedTask(
  id: string,
  o: {
    status?: string;
    triggeredBy?: string;
    recoverySourceTaskId?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    chatSessionId?: string | null;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id, title, status, priority,
                        triggered_by, recovery_source_task_id, chat_session_id, execution_step,
                        started_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, 'task', ?, 0, ?, ?, ?, 'running', ?, 'user-1', ?, ?)`
    )
    .run(
      id,
      PROJECT_ID,
      WORKSPACE_ID,
      o.status ?? 'in_progress',
      o.triggeredBy ?? 'user',
      o.recoverySourceTaskId ?? null,
      o.chatSessionId === undefined ? null : o.chatSessionId,
      o.startedAt === undefined ? iso(-6 * 60 * 60 * 1000) : o.startedAt,
      o.createdAt ?? iso(-6 * 60 * 60 * 1000),
      iso(-6 * 60 * 60 * 1000)
    );
}

/** The wake successor `createRecoveryTask` mints. */
function seedSuccessor(
  status: string,
  o: {
    id?: string;
    recoverySourceTaskId?: string;
    createdAt?: string;
    chatSessionId?: string | null;
  } = {}
): void {
  seedTask(o.id ?? SUCCESSOR_ID, {
    status,
    triggeredBy: 'session-recovery',
    recoverySourceTaskId: o.recoverySourceTaskId ?? PREDECESSOR_ID,
    createdAt: o.createdAt ?? iso(-60_000),
    startedAt: iso(-60_000),
    chatSessionId: o.chatSessionId === undefined ? CHAT_SESSION_ID : o.chatSessionId,
  });
}

function env(
  o: {
    beforeTerminalUpdate?: () => void;
  } = {}
): Env {
  const kv = new Map<string, string>();
  const database = createSqliteD1(sqlite);
  const guardedDatabase = o.beforeTerminalUpdate
    ? ({
        ...database,
        prepare: (sql: string) => {
          const statement = database.prepare(sql);
          const isTerminalUpdate =
            /UPDATE\s+tasks\s+SET\s+status\s*=\s*\?/i.test(sql) &&
            /completed_at\s*=\s*\?/i.test(sql);
          if (!isTerminalUpdate) return statement;
          return {
            ...statement,
            bind: (...params: unknown[]) => {
              const bound = statement.bind(...params);
              return {
                ...bound,
                run: async () => {
                  o.beforeTerminalUpdate?.();
                  return bound.run();
                },
                runSync: () => {
                  o.beforeTerminalUpdate?.();
                  return bound.runSync();
                },
              };
            },
          };
        },
      } as D1Database)
    : database;
  return {
    DATABASE: guardedDatabase,
    KV: {
      get: vi.fn(async (k: string) => kv.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        kv.set(k, v);
      }),
    },
    OBSERVABILITY_DATABASE: createSqliteD1(sqlite),
    TASK_RUNNER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
      get: vi.fn().mockReturnValue({
        getStatus: vi.fn().mockRejectedValue(new Error('no DO')),
      }),
    },
    TASK_RUN_MAX_EXECUTION_MS: '14400000', // 4h
    TASK_RUN_HARD_TIMEOUT_MS: '28800000', // 8h
    TASK_RUN_ABSOLUTE_CEILING_MS: '86400000', // 24h
    NODE_HEARTBEAT_STALE_SECONDS: '180',
    BASE_DOMAIN: 'example.test',
  } as unknown as Env;
}

function statusOf(id: string): { status: string; error_message: string | null } {
  return sqlite.prepare(`SELECT status, error_message FROM tasks WHERE id = ?`).get(id) as {
    status: string;
    error_message: string | null;
  };
}

function makeWorkspaceRunning(): void {
  sqlite
    .prepare(`UPDATE workspaces SET status = 'running', chat_session_id = ? WHERE id = ?`)
    .run(CHAT_SESSION_ID, WORKSPACE_ID);
}

function makeNodeHeartbeatStale(): void {
  sqlite
    .prepare(
      `UPDATE nodes SET status = 'running', health_status = 'healthy', last_heartbeat_at = ? WHERE id = ?`
    )
    .run(iso(-10 * 60 * 1000), NODE_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithTimeoutMock.mockReset();
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
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, health_status, last_heartbeat_at,
                        vm_size, vm_location, cloud_provider, created_at, updated_at)
     VALUES (?, 'user-1', 'node', 'running', 'healthy', ?, 'cpx21', 'nbg1', 'hetzner', ?, ?)`
    )
    .run(NODE_ID, iso(0), iso(-7_200_000), iso(0));
  // The handoff deleted the predecessor's workspace and nulled its chat binding.
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, name, repository, branch, status, vm_size, vm_location,
                             project_id, chat_session_id, node_id, created_at, updated_at)
     VALUES (?, 'user-1', 'ws', 'org/repo', 'main', 'deleted', 'cpx21', 'nbg1', ?, NULL, ?, ?, ?)`
    )
    .run(WORKSPACE_ID, PROJECT_ID, NODE_ID, iso(-7_200_000), iso(0));
});

describe('stuck-task sweep — superseded predecessors are cancelled, never failed', () => {
  /**
   * The branch the first cut missed. `started_at` 6h ago exceeds the 4h
   * max-execution timeout, so `case 'in_progress'` sets `isStuck` and the
   * reconciliation-grace branch never runs.
   */
  it('records cancelled when the max-execution timeout fires on a superseded task', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-6 * 60 * 60 * 1000) });
    seedSuccessor('completed');

    await recoverStuckTasks(env());

    const row = statusOf(PREDECESSOR_ID);
    expect(row.status).toBe('cancelled');
    expect(row.error_message).toContain('Superseded by a later session wake');
    expect(row.error_message).not.toContain('no longer live');
  });

  /**
   * The second missed branch: the absolute runaway-cost ceiling terminalized
   * without probing liveness at all.
   */
  it('records cancelled when the absolute ceiling fires on a superseded task', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-30 * 60 * 60 * 1000) });
    seedSuccessor('completed');

    await recoverStuckTasks(env());

    const row = statusOf(PREDECESSOR_ID);
    expect(row.status).toBe('cancelled');
    expect(row.error_message).toContain('Superseded by a later session wake');
    expect(row.error_message).not.toContain('runaway-cost ceiling');
  });

  /**
   * Discriminating control (`.claude/rules/58`): an identically-timed-out task
   * that was NEVER superseded must still be recorded as a real failure. Without
   * this, "cancel everything" would pass the two cases above.
   */
  it('still records failed for a timed-out task that was never superseded', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-6 * 60 * 60 * 1000) });

    await recoverStuckTasks(env());

    const row = statusOf(PREDECESSOR_ID);
    expect(row.status).toBe('failed');
    expect(row.error_message).not.toContain('Superseded');
  });

  /** Same control for the ceiling branch. */
  it('still records failed at the absolute ceiling when never superseded', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-30 * 60 * 60 * 1000) });

    await recoverStuckTasks(env());

    const row = statusOf(PREDECESSOR_ID);
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('runaway-cost ceiling');
  });

  /** A live successor still preserves the predecessor entirely — no write at all. */
  it('leaves a predecessor untouched while its successor is still live', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-6 * 60 * 60 * 1000) });
    seedSuccessor('in_progress');

    await recoverStuckTasks(env());

    expect(statusOf(PREDECESSOR_ID).status).toBe('in_progress');
  });

  /**
   * The case that matters most, and the one the first ceiling fix got wrong:
   * past the 24h ceiling with a still-LIVE successor. Terminalizing here would
   * not merely mislabel a dead task — `cancelled` is a member of
   * TERMINAL_TASK_STATUSES, so it revokes the recovery guard the live successor
   * depends on, and `abortRevokedSourceTaskWake` turns that into stopping a
   * running container. A superseded predecessor holds no compute (its workspace
   * is already deleted), so the cost ceiling has nothing to bound.
   */
  it('preserves a superseded predecessor past the ceiling while its successor is live', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-30 * 60 * 60 * 1000) });
    seedSuccessor('in_progress');

    await recoverStuckTasks(env());

    const row = statusOf(PREDECESSOR_ID);
    expect(row.status).toBe('in_progress');
    expect(row.error_message).toBeNull();
  });

  /** Bounded escape: the moment that successor ends, the ceiling cancels it. */
  it('cancels the same predecessor once its successor finally ends', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-30 * 60 * 60 * 1000) });
    seedSuccessor('in_progress');

    await recoverStuckTasks(env());
    expect(statusOf(PREDECESSOR_ID).status).toBe('in_progress');

    sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(SUCCESSOR_ID);
    await recoverStuckTasks(env());

    expect(statusOf(PREDECESSOR_ID).status).toBe('cancelled');
  });

  /** The status event must record the same benign transition, not a failure. */
  it('appends a cancelled status event for the supersession', async () => {
    seedTask(PREDECESSOR_ID, { startedAt: iso(-6 * 60 * 60 * 1000) });
    seedSuccessor('completed');

    await recoverStuckTasks(env());

    const event = sqlite
      .prepare(`SELECT to_status, reason FROM task_status_events WHERE task_id = ?`)
      .get(PREDECESSOR_ID) as { to_status: string; reason: string } | undefined;
    expect(event?.to_status).toBe('cancelled');
    expect(event?.reason).toContain('Superseded by a later session wake');
  });

  it('does not kill a predecessor when a live successor appears after the sweep probe', async () => {
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-10 * 60 * 1000),
      createdAt: iso(-60 * 60 * 1000),
    });
    const skippedSupersessionGuard = vi.spyOn(log, 'info');
    let insertedSuccessor = false;

    const result = await recoverStuckTasks(
      env({
        beforeTerminalUpdate: () => {
          if (insertedSuccessor) return;
          insertedSuccessor = true;
          seedSuccessor('queued', { createdAt: iso(-30_000) });
        },
      })
    );

    expect(insertedSuccessor).toBe(true);
    expect(result.failedInProgress).toBe(0);
    expect(statusOf(PREDECESSOR_ID)).toMatchObject({
      status: 'in_progress',
      error_message: null,
    });
    expect(statusOf(SUCCESSOR_ID).status).toBe('queued');
    expect(skippedSupersessionGuard).toHaveBeenCalledWith(
      'stuck_task.skipped_supersession_guard',
      expect.objectContaining({ taskId: PREDECESSOR_ID, projectId: PROJECT_ID })
    );
    skippedSupersessionGuard.mockRestore();
  });

  it('keeps the supersession fence on a stale-heartbeat node_not_live terminal write', async () => {
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-10 * 60 * 1000),
      createdAt: iso(-60 * 60 * 1000),
      chatSessionId: CHAT_SESSION_ID,
    });
    makeWorkspaceRunning();
    makeNodeHeartbeatStale();
    let insertedSuccessor = false;

    const result = await recoverStuckTasks(
      env({
        beforeTerminalUpdate: () => {
          if (insertedSuccessor) return;
          insertedSuccessor = true;
          seedSuccessor('queued', { createdAt: iso(-30_000) });
        },
      })
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      'https://01m064tg56ecjw1d127h32brvj.vm.example.test:8443/health',
      { method: 'GET' },
      5_000
    );
    expect(insertedSuccessor).toBe(true);
    expect(result.failedInProgress).toBe(0);
    expect(statusOf(PREDECESSOR_ID)).toMatchObject({
      status: 'in_progress',
      error_message: null,
    });
    expect(statusOf(SUCCESSOR_ID).status).toBe('queued');
  });

  it('still kills the same dead predecessor when no successor appears at write time', async () => {
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-10 * 60 * 1000),
      createdAt: iso(-60 * 60 * 1000),
    });

    const result = await recoverStuckTasks(env());

    expect(result.failedInProgress).toBe(1);
    expect(statusOf(PREDECESSOR_ID).status).toBe('failed');
    expect(statusOf(PREDECESSOR_ID).error_message).toContain('workspace_deleted');
  });

  it('matches live successors through the root family when the predecessor is a middle link', async () => {
    const rootId = '01M064TG9QK8ZQ3XW0M6P7ROOT';
    const middleId = PREDECESSOR_ID;
    const siblingSuccessorId = '01M0SDBZXG5AEGZJ0JH2SIBLG';
    seedTask(rootId, {
      startedAt: iso(-3 * 60 * 60 * 1000),
      createdAt: iso(-3 * 60 * 60 * 1000),
      chatSessionId: null,
    });
    seedTask(middleId, {
      startedAt: iso(-10 * 60 * 1000),
      createdAt: iso(-2 * 60 * 60 * 1000),
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: rootId,
      chatSessionId: null,
    });
    let insertedSuccessor = false;

    await recoverStuckTasks(
      env({
        beforeTerminalUpdate: () => {
          if (insertedSuccessor) return;
          insertedSuccessor = true;
          seedSuccessor('in_progress', {
            id: siblingSuccessorId,
            recoverySourceTaskId: rootId,
            createdAt: iso(-30_000),
            chatSessionId: CHAT_SESSION_ID,
          });
        },
      })
    );

    expect(insertedSuccessor).toBe(true);
    expect(statusOf(middleId).status).toBe('in_progress');
    expect(statusOf(siblingSuccessorId).status).toBe('in_progress');
  });

  it('preserves a recovery middle link when a live successor points directly at it', async () => {
    const rootId = '01M064TG9QK8ZQ3XW0M6P7ROOT';
    seedTask(rootId, {
      status: 'failed',
      startedAt: iso(-3 * 60 * 60 * 1000),
      createdAt: iso(-3 * 60 * 60 * 1000),
      chatSessionId: null,
    });
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-6 * 60 * 60 * 1000),
      createdAt: iso(-2 * 60 * 60 * 1000),
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: rootId,
      chatSessionId: null,
    });
    seedSuccessor('in_progress', {
      recoverySourceTaskId: PREDECESSOR_ID,
      createdAt: iso(-6 * 60_000),
      chatSessionId: CHAT_SESSION_ID,
    });

    const result = await recoverStuckTasks(env());

    expect(result.failedInProgress).toBe(0);
    expect(statusOf(PREDECESSOR_ID)).toMatchObject({
      status: 'in_progress',
      error_message: null,
    });
    expect(statusOf(SUCCESSOR_ID).status).toBe('in_progress');
  });

  it('cancels a direct-child superseded middle link benignly once that child ends', async () => {
    const rootId = '01M064TG9QK8ZQ3XW0M6P7ROOT';
    seedTask(rootId, {
      status: 'failed',
      startedAt: iso(-3 * 60 * 60 * 1000),
      createdAt: iso(-3 * 60 * 60 * 1000),
      chatSessionId: null,
    });
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-6 * 60 * 60 * 1000),
      createdAt: iso(-2 * 60 * 60 * 1000),
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: rootId,
      chatSessionId: null,
    });
    seedSuccessor('completed', {
      recoverySourceTaskId: PREDECESSOR_ID,
      createdAt: iso(-6 * 60_000),
      chatSessionId: CHAT_SESSION_ID,
    });

    const result = await recoverStuckTasks(env());

    expect(result.failedInProgress).toBe(1);
    const row = statusOf(PREDECESSOR_ID);
    expect(row.status).toBe('cancelled');
    expect(row.error_message).toContain('Superseded by a later session wake');
    expect(row.error_message).not.toContain('workspace_deleted');
  });

  it('keeps the write-time supersession fence for direct-child middle-link races', async () => {
    const rootId = '01M064TG9QK8ZQ3XW0M6P7ROOT';
    seedTask(rootId, {
      status: 'failed',
      startedAt: iso(-3 * 60 * 60 * 1000),
      createdAt: iso(-3 * 60 * 60 * 1000),
      chatSessionId: null,
    });
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-10 * 60 * 1000),
      createdAt: iso(-2 * 60 * 60 * 1000),
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: rootId,
      chatSessionId: null,
    });
    let insertedSuccessor = false;

    const result = await recoverStuckTasks(
      env({
        beforeTerminalUpdate: () => {
          if (insertedSuccessor) return;
          insertedSuccessor = true;
          seedSuccessor('queued', {
            recoverySourceTaskId: PREDECESSOR_ID,
            createdAt: iso(-30_000),
            chatSessionId: CHAT_SESSION_ID,
          });
        },
      })
    );

    expect(insertedSuccessor).toBe(true);
    expect(result.failedInProgress).toBe(0);
    expect(statusOf(PREDECESSOR_ID)).toMatchObject({
      status: 'in_progress',
      error_message: null,
    });
    expect(statusOf(SUCCESSOR_ID).status).toBe('queued');
  });

  it('keeps the successor source-task guard valid when the atomic guard blocks the kill', async () => {
    seedTask(PREDECESSOR_ID, {
      startedAt: iso(-10 * 60 * 1000),
      createdAt: iso(-60 * 60 * 1000),
    });
    let insertedSuccessor = false;

    await recoverStuckTasks(
      env({
        beforeTerminalUpdate: () => {
          if (insertedSuccessor) return;
          insertedSuccessor = true;
          seedSuccessor('queued', { createdAt: iso(-30_000) });
        },
      })
    );

    const guardRow = sqlite
      .prepare(
        `SELECT source.id
           FROM tasks source
          WHERE source.id = ?
            AND source.project_id = ?
            AND source.status NOT IN ('completed', 'failed', 'cancelled')
            AND (
              source.chat_session_id = ?
              OR EXISTS (
                SELECT 1 FROM tasks recovery
                 WHERE recovery.recovery_source_task_id = source.id
                   AND recovery.project_id = ?
                   AND recovery.chat_session_id = ?
                   AND recovery.triggered_by = 'session-recovery'
                   AND recovery.status NOT IN ('completed', 'failed', 'cancelled')
              )
            )`
      )
      .get(PREDECESSOR_ID, PROJECT_ID, CHAT_SESSION_ID, PROJECT_ID, CHAT_SESSION_ID);

    expect(statusOf(PREDECESSOR_ID).status).toBe('in_progress');
    expect(guardRow).toMatchObject({ id: PREDECESSOR_ID });
  });
});
