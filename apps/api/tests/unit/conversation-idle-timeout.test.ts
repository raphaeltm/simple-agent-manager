import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/logger')>()),
  createModuleLogger: () => loggerMocks,
}));

import { runMigrations } from '../../src/durable-objects/migrations';
import {
  checkWorkspaceIdleTimeouts,
  processExpiredCleanups,
} from '../../src/durable-objects/project-data/idle-cleanup';
import { terminalizeIdleTaskInD1 } from '../../src/durable-objects/project-data/idle-cleanup-terminalization';
import { getLocalTaskRuntimeLiveness } from '../../src/durable-objects/project-data/task-runtime-liveness';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
import type { Env } from '../../src/env';
import { getTaskRuntimeLiveness } from '../../src/scheduled/stuck-tasks';
import { createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from './durable-objects/sql-storage-test-utils';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const PROJECT_ID = 'project-1';
const TIMEOUT_MS = 60 * 60 * 1000;

const D1_SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    workspace_idle_timeout_ms INTEGER
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    health_status TEXT,
    last_heartbeat_at TEXT,
    runtime TEXT
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chat_session_id TEXT,
    node_id TEXT,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE trigger_executions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    completed_at TEXT,
    error_message TEXT
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    chat_session_id TEXT,
    status TEXT NOT NULL,
    execution_step TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    error_message TEXT,
    output_summary TEXT,
    trigger_execution_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_tasks_chat_session ON tasks(chat_session_id)
    WHERE chat_session_id IS NOT NULL;
  CREATE TABLE task_status_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  );
`;

interface SeedOptions {
  taskId?: string;
  workspaceId?: string;
  sessionId?: string;
  projectId?: string;
  workspaceStatus?: string;
  nodeStatus?: string;
  nodeHealthStatus?: string;
  nodeRuntime?: string;
  taskChatSessionId?: string | null;
  acpStatus?: 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'interrupted';
  withTrigger?: boolean;
  lastActivityAt?: number;
  scheduleExpired?: boolean;
  scheduleRetryCount?: number;
}

describe('ProjectData idle cleanup runtime liveness contract', () => {
  let projectDb: Database.Database;
  let d1Db: Database.Database;
  let sql: SqlStorage;
  let env: ProjectDataEnv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    projectDb = new Database(':memory:');
    d1Db = new Database(':memory:');
    sql = createSqlStorage(projectDb);
    runMigrations(sql);
    d1Db.exec(D1_SCHEMA);
    d1Db
      .prepare('INSERT INTO projects (id, workspace_idle_timeout_ms) VALUES (?, NULL)')
      .run(PROJECT_ID);
    env = {
      DATABASE: createSqliteD1(d1Db),
      SESSION_IDLE_TIMEOUT_MINUTES: '60',
      IDLE_CLEANUP_RETRY_DELAY_MS: '300000',
      IDLE_CLEANUP_MAX_RETRIES: '1',
      IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP: '5',
      WORKSPACE_IDLE_TIMEOUT_MS: String(2 * TIMEOUT_MS),
      NODE_HEARTBEAT_STALE_SECONDS: '180',
      TASK_LIVENESS_MAX_ACP_SESSIONS: '5',
      TASK_LIVENESS_PROBE_TIMEOUT_MS: '5000',
      MAX_MESSAGES_PER_SESSION: '100000',
    } as ProjectDataEnv;
    vi.clearAllMocks();
  });

  afterEach(() => {
    projectDb.close();
    d1Db.close();
    vi.useRealTimers();
  });

  function seed(
    options: SeedOptions = {}
  ): Required<Pick<SeedOptions, 'taskId' | 'workspaceId' | 'sessionId' | 'projectId'>> {
    const taskId = options.taskId ?? 'task-1';
    const workspaceId = options.workspaceId ?? 'workspace-1';
    const sessionId = options.sessionId ?? 'session-1';
    const projectId = options.projectId ?? PROJECT_ID;
    const nodeId = `node-${workspaceId}`;
    const triggerId = options.withTrigger ? `trigger-${taskId}` : null;
    const lastActivityAt = options.lastActivityAt ?? NOW - 3 * TIMEOUT_MS;

    d1Db
      .prepare(
        `INSERT OR IGNORE INTO nodes
       (id, status, health_status, last_heartbeat_at, runtime)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        nodeId,
        options.nodeStatus ?? 'running',
        options.nodeHealthStatus ?? 'healthy',
        new Date(NOW).toISOString(),
        options.nodeRuntime ?? 'vm'
      );
    d1Db
      .prepare(
        `INSERT OR IGNORE INTO workspaces
       (id, project_id, user_id, chat_session_id, node_id, status, updated_at)
       VALUES (?, ?, 'user-1', ?, ?, ?, ?)`
      )
      .run(
        workspaceId,
        projectId,
        sessionId,
        nodeId,
        options.workspaceStatus ?? 'running',
        new Date(NOW).toISOString()
      );
    if (triggerId) {
      d1Db
        .prepare(`INSERT INTO trigger_executions (id, status) VALUES (?, 'running')`)
        .run(triggerId);
    }
    d1Db
      .prepare(
        `INSERT INTO tasks
       (id, project_id, user_id, workspace_id, chat_session_id, status,
        execution_step, updated_at, output_summary, trigger_execution_id, created_at)
       VALUES (?, ?, 'user-1', ?, ?, 'in_progress', 'running', ?, NULL, ?, ?)`
      )
      .run(
        taskId,
        projectId,
        workspaceId,
        options.taskChatSessionId === undefined ? sessionId : options.taskChatSessionId,
        new Date(NOW - TIMEOUT_MS).toISOString(),
        triggerId,
        new Date(NOW - TIMEOUT_MS).toISOString()
      );

    projectDb
      .prepare(
        `INSERT INTO chat_sessions
       (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Idle cleanup test', 'active', 0, ?, ?, ?)`
      )
      .run(sessionId, workspaceId, taskId, lastActivityAt, lastActivityAt, lastActivityAt);
    projectDb
      .prepare(
        `INSERT OR IGNORE INTO workspace_activity
       (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(workspaceId, sessionId, lastActivityAt, lastActivityAt, lastActivityAt);
    projectDb
      .prepare(
        `INSERT INTO acp_sessions
       (id, chat_session_id, workspace_id, node_id, status, agent_type,
        last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'openai-codex', ?, ?, ?)`
      )
      .run(
        `acp-${taskId}`,
        sessionId,
        workspaceId,
        nodeId,
        options.acpStatus ?? 'running',
        NOW,
        NOW - TIMEOUT_MS,
        NOW
      );
    if (options.scheduleExpired) {
      projectDb
        .prepare(
          `INSERT INTO idle_cleanup_schedule
         (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
         VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          workspaceId,
          taskId,
          NOW - 1,
          NOW - TIMEOUT_MS - 1,
          options.scheduleRetryCount ?? 0
        );
    }
    return { taskId, workspaceId, sessionId, projectId };
  }

  function task(taskId: string): Record<string, unknown> {
    return d1Db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
  }

  async function runPathA(
    stopWorkspace = vi.fn().mockResolvedValue(undefined)
  ): Promise<typeof stopWorkspace> {
    await processExpiredCleanups(sql, env, PROJECT_ID, stopWorkspace, vi.fn(), vi.fn());
    return stopWorkspace;
  }

  it('preserves a live task and defers its expired schedule across two sweeps', async () => {
    const { taskId, sessionId } = seed({ scheduleExpired: true });
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);

    await runPathA(stopWorkspace);
    await runPathA(stopWorkspace);

    expect(task(taskId).status).toBe('in_progress');
    expect(stopWorkspace).not.toHaveBeenCalled();
    expect(
      projectDb
        .prepare('SELECT COUNT(*) FROM idle_cleanup_schedule WHERE session_id = ?')
        .pluck()
        .get(sessionId)
    ).toBe(1);
    expect(
      projectDb
        .prepare('SELECT cleanup_at FROM idle_cleanup_schedule WHERE session_id = ?')
        .pluck()
        .get(sessionId)
    ).toBeGreaterThan(NOW);
    expect(d1Db.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(0);
  });

  it('preserves recovery as inconclusive', async () => {
    const { taskId } = seed({ workspaceStatus: 'recovery', scheduleExpired: true });
    const stopWorkspace = await runPathA();

    expect(task(taskId).status).toBe('in_progress');
    expect(stopWorkspace).not.toHaveBeenCalled();
  });

  it('fails a conclusively dead task with diagnostics, event, trigger sync, and one-sweep escape', async () => {
    const { taskId, workspaceId, sessionId, projectId } = seed({
      nodeStatus: 'stopped',
      withTrigger: true,
      scheduleExpired: true,
    });
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);

    await runPathA(stopWorkspace);
    await runPathA(stopWorkspace);

    const failed = task(taskId);
    expect(failed).toMatchObject({
      status: 'failed',
      execution_step: null,
      output_summary: null,
    });
    expect(failed.error_message).toContain('session_idle_cleanup');
    expect(failed.error_message).toContain(`configured timeout ${TIMEOUT_MS}ms`);
    expect(failed.error_message).toContain('node_not_live');
    expect(stopWorkspace).toHaveBeenCalledTimes(1);
    expect(stopWorkspace).toHaveBeenCalledWith(workspaceId, projectId);
    expect(
      projectDb
        .prepare('SELECT COUNT(*) FROM idle_cleanup_schedule WHERE session_id = ?')
        .pluck()
        .get(sessionId)
    ).toBe(0);
    expect(
      d1Db
        .prepare(
          `SELECT from_status, to_status, actor_type, reason
       FROM task_status_events WHERE task_id = ?`
        )
        .get(taskId)
    ).toMatchObject({
      from_status: 'in_progress',
      to_status: 'failed',
      actor_type: 'system',
      reason: failed.error_message,
    });
    expect(
      d1Db
        .prepare('SELECT status, error_message FROM trigger_executions WHERE id = ?')
        .get(`trigger-${taskId}`)
    ).toMatchObject({
      status: 'failed',
      error_message: failed.error_message,
    });
    expect(
      d1Db.prepare('SELECT COUNT(*) FROM task_status_events WHERE task_id = ?').pluck().get(taskId)
    ).toBe(1);
  });

  it('terminalizes and reaps a task-mode session whose task link is NULL but workspace binding matches', async () => {
    const { taskId, workspaceId, sessionId, projectId } = seed({
      nodeStatus: 'stopped',
      scheduleExpired: true,
      taskChatSessionId: null,
    });
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);

    await runPathA(stopWorkspace);

    expect(task(taskId)).toMatchObject({
      status: 'failed',
      chat_session_id: sessionId,
    });
    expect(stopWorkspace).toHaveBeenCalledWith(workspaceId, projectId);
    expect(
      projectDb
        .prepare('SELECT COUNT(*) FROM idle_cleanup_schedule WHERE session_id = ?')
        .pluck()
        .get(sessionId)
    ).toBe(0);
  });

  it('honors the configured candidate bound with deterministic Path A ordering', async () => {
    env.IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP = '1';
    const first = seed({
      taskId: 'task-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      nodeStatus: 'stopped',
      scheduleExpired: true,
    });
    const second = seed({
      taskId: 'task-b',
      workspaceId: 'workspace-b',
      sessionId: 'session-b',
      nodeStatus: 'stopped',
      scheduleExpired: true,
    });

    await runPathA();

    expect(task(first.taskId).status).toBe('failed');
    expect(task(second.taskId).status).toBe('in_progress');
    expect(
      projectDb.prepare('SELECT session_id FROM idle_cleanup_schedule ORDER BY session_id').all()
    ).toEqual([{ session_id: second.sessionId }]);
  });

  it('scopes Path B to the reporter session and preserves an unrelated same-workspace task', async () => {
    const reporter = seed({
      taskId: 'task-reporter',
      sessionId: 'session-reporter',
      nodeStatus: 'stopped',
    });
    const unrelated = seed({
      taskId: 'task-unrelated',
      workspaceId: reporter.workspaceId,
      sessionId: 'session-unrelated',
      nodeStatus: 'stopped',
    });
    const deleteWorkspace = vi.fn().mockResolvedValue(undefined);

    await checkWorkspaceIdleTimeouts(sql, env, PROJECT_ID, deleteWorkspace, vi.fn(), vi.fn());

    expect(task(reporter.taskId).status).toBe('failed');
    expect(task(unrelated.taskId).status).toBe('in_progress');
    expect(deleteWorkspace).toHaveBeenCalledWith(reporter.workspaceId, PROJECT_ID);
    expect(d1Db.prepare('SELECT task_id FROM task_status_events').all()).toEqual([
      { task_id: reporter.taskId },
    ]);
  });

  it('Path B terminalizes a legacy NULL-linked reporter task through the workspace binding', async () => {
    const reporter = seed({
      taskId: 'task-null-link-reporter',
      sessionId: 'session-null-link-reporter',
      taskChatSessionId: null,
      nodeStatus: 'stopped',
    });
    const deleteWorkspace = vi.fn().mockResolvedValue(undefined);

    await checkWorkspaceIdleTimeouts(sql, env, PROJECT_ID, deleteWorkspace, vi.fn(), vi.fn());

    expect(task(reporter.taskId)).toMatchObject({
      status: 'failed',
      chat_session_id: reporter.sessionId,
    });
    expect(deleteWorkspace).toHaveBeenCalledWith(reporter.workspaceId, PROJECT_ID);
  });

  it('rejects a cross-project reporter with structured scope context and no mutation', async () => {
    const seeded = seed();

    const result = await terminalizeIdleTaskInD1(sql, env, {
      sweep: 'workspace_idle_timeout',
      projectId: 'project-other',
      taskId: seeded.taskId,
      workspaceId: seeded.workspaceId,
      sessionId: seeded.sessionId,
      idleDurationMs: 3 * TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
    });

    expect(result.outcome).toBe('rejected');
    expect(task(seeded.taskId).status).toBe('in_progress');
    expect(d1Db.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(0);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'scope_rejected',
      expect.objectContaining({ mismatch: 'project_id', action: 'rejected' })
    );
  });

  it('rejects a non-null task/session mismatch and leaves the pair discriminating', async () => {
    const seeded = seed({ taskChatSessionId: 'session-other' });

    const result = await terminalizeIdleTaskInD1(sql, env, {
      sweep: 'session_idle_cleanup',
      projectId: PROJECT_ID,
      taskId: seeded.taskId,
      workspaceId: seeded.workspaceId,
      sessionId: seeded.sessionId,
      idleDurationMs: 2 * TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
    });

    expect(result.outcome).toBe('rejected');
    expect(task(seeded.taskId)).toMatchObject({
      status: 'in_progress',
      chat_session_id: 'session-other',
    });
    expect(d1Db.prepare('SELECT COUNT(*) FROM task_status_events').pluck().get()).toBe(0);
  });

  it('moves permanently preserved idle cleanup rows out of the active candidate set after max residence', async () => {
    env.IDLE_CLEANUP_MAX_RESIDENCE_MS = '1';
    const { taskId, sessionId } = seed({ scheduleExpired: true });
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn();

    await processExpiredCleanups(sql, env, PROJECT_ID, stopWorkspace, broadcast, vi.fn());
    await processExpiredCleanups(sql, env, PROJECT_ID, stopWorkspace, broadcast, vi.fn());

    expect(task(taskId).status).toBe('in_progress');
    expect(stopWorkspace).not.toHaveBeenCalled();
    expect(
      projectDb
        .prepare(
          `SELECT terminal_state, failure_notified_at
           FROM idle_cleanup_schedule WHERE session_id = ?`
        )
        .get(sessionId)
    ).toMatchObject({
      terminal_state: 'preserved_max_residence_exceeded',
      failure_notified_at: expect.any(Number),
    });
    expect(
      projectDb
        .prepare(
          `SELECT COUNT(*) FROM idle_cleanup_schedule
           WHERE cleanup_at <= ? AND terminal_state IS NULL`
        )
        .pluck()
        .get(NOW)
    ).toBe(0);
    expect(
      projectDb
        .prepare(
          `SELECT COUNT(*) FROM session_attention_markers
           WHERE session_id = ? AND kind = 'idle_cleanup_failed' AND resolved_at IS NULL`
        )
        .pluck()
        .get(sessionId)
    ).toBe(1);
    expect(
      projectDb
        .prepare(
          `SELECT COUNT(*) FROM chat_messages
           WHERE session_id = ? AND role = 'system'
             AND content LIKE 'Idle cleanup could not complete%'`
        )
        .pluck()
        .get(sessionId)
    ).toBe(1);
  });

  it('keeps retry exhaustion visible without deleting the schedule or duplicating the toast', async () => {
    const { sessionId } = seed({
      scheduleExpired: true,
      scheduleRetryCount: 1,
      taskChatSessionId: 'session-other',
    });
    const broadcast = vi.fn();

    await processExpiredCleanups(sql, env, PROJECT_ID, vi.fn(), broadcast, vi.fn());
    await processExpiredCleanups(sql, env, PROJECT_ID, vi.fn(), broadcast, vi.fn());

    expect(
      projectDb
        .prepare(
          `SELECT terminal_state, terminal_reason, failure_notified_at
           FROM idle_cleanup_schedule WHERE session_id = ?`
        )
        .get(sessionId)
    ).toMatchObject({
      terminal_state: 'retry_exhausted',
      terminal_reason: 'Idle cleanup reporter scope did not match the task',
      failure_notified_at: expect.any(Number),
    });
    expect(
      projectDb
        .prepare(
          `SELECT COUNT(*) FROM chat_messages
           WHERE session_id = ? AND role = 'system'
             AND content = 'Idle cleanup failed after retries. Your work has been preserved — please check the workspace manually.'`
        )
        .pluck()
        .get(sessionId)
    ).toBe(1);
    expect(
      projectDb
        .prepare(
          `SELECT COUNT(*) FROM session_attention_markers
           WHERE session_id = ? AND kind = 'idle_cleanup_failed' AND resolved_at IS NULL`
        )
        .pluck()
        .get(sessionId)
    ).toBe(1);
  });

  it('preserves the task when the D1 runtime snapshot probe errors', async () => {
    const seeded = seed();
    const baseDatabase = env.DATABASE;
    env = {
      ...env,
      DATABASE: {
        ...baseDatabase,
        prepare: vi.fn((query: string) => {
          if (query.includes('FROM workspaces w')) {
            return {
              bind: vi.fn().mockReturnValue({
                first: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
              }),
            } as unknown as D1PreparedStatement;
          }
          return baseDatabase.prepare(query);
        }),
      } as D1Database,
    };

    const result = await terminalizeIdleTaskInD1(sql, env, {
      sweep: 'session_idle_cleanup',
      projectId: PROJECT_ID,
      taskId: seeded.taskId,
      workspaceId: seeded.workspaceId,
      sessionId: seeded.sessionId,
      idleDurationMs: 2 * TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
    });

    expect(result).toMatchObject({
      outcome: 'preserved',
      liveness: { live: false, conclusive: false, reason: 'task_liveness_unknown' },
    });
    expect(task(seeded.taskId).status).toBe('in_progress');
  });

  it('preserves the task when the bounded container lifecycle probe times out', async () => {
    const seeded = seed({ nodeRuntime: 'cf-container' });
    env = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {
        idFromName: vi.fn().mockReturnValue('container-do-id'),
        get: vi.fn().mockReturnValue({
          inspectLifecycle: vi.fn().mockReturnValue(new Promise(() => undefined)),
        }),
      } as unknown as ProjectDataEnv['VM_AGENT_CONTAINER'],
    };

    const pending = terminalizeIdleTaskInD1(sql, env, {
      sweep: 'workspace_idle_timeout',
      projectId: PROJECT_ID,
      taskId: seeded.taskId,
      workspaceId: seeded.workspaceId,
      sessionId: seeded.sessionId,
      idleDurationMs: 3 * TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(pending).resolves.toMatchObject({
      outcome: 'preserved',
      liveness: {
        live: false,
        conclusive: false,
        reason: 'cf_container_lifecycle_timeout',
      },
    });
    expect(task(seeded.taskId).status).toBe('in_progress');
  });

  it('keeps cron and DO-local adapters in parity on the shared classifier', async () => {
    const seeded = seed();
    const sessions = projectDb
      .prepare('SELECT * FROM acp_sessions WHERE chat_session_id = ?')
      .all(seeded.sessionId)
      .map((row) => ({
        id: row.id as string,
        chatSessionId: row.chat_session_id as string,
        workspaceId: row.workspace_id as string,
        nodeId: row.node_id as string,
        acpSdkSessionId: null,
        parentSessionId: null,
        status: row.status as 'running',
        agentType: row.agent_type as string,
        initialPrompt: null,
        errorMessage: null,
        lastHeartbeatAt: row.last_heartbeat_at as number,
        forkDepth: 0,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        assignedAt: null,
        startedAt: null,
        completedAt: null,
        interruptedAt: null,
      }));
    const cronEnv = {
      ...env,
      PROJECT_DATA: {
        idFromName: vi.fn().mockReturnValue('project-do-id'),
        get: vi.fn().mockReturnValue({
          ensureProjectId: vi.fn().mockResolvedValue(undefined),
          getTaskAcpLivenessSignals: vi
            .fn()
            .mockResolvedValue({ sessions, total: sessions.length, sessionWork: null }),
        }),
      },
    } as unknown as Env;

    const [cron, local] = await Promise.all([
      getTaskRuntimeLiveness(cronEnv, {
        project_id: PROJECT_ID,
        workspace_id: seeded.workspaceId,
      }),
      getLocalTaskRuntimeLiveness(sql, env, {
        projectId: PROJECT_ID,
        workspaceId: seeded.workspaceId,
      }),
    ]);

    expect(cron).toEqual(local);
    expect(local).toMatchObject({
      live: true,
      conclusive: true,
      reason: 'task_acp_session_live',
    });
  });
});
