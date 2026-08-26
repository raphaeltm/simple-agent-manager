import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { runMigrations } from '../../../src/durable-objects/migrations';
import { createAttentionMarker } from '../../../src/durable-objects/project-data/attention';
import { processExpiredAttentionMarkers } from '../../../src/durable-objects/project-data/attention-expiry';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { cleanupTaskRun } from '../../../src/services/task-runner';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

vi.mock('../../../src/services/task-runner', () => ({ cleanupTaskRun: vi.fn() }));
vi.mock('../../../src/services/project-data', () => ({ reconcileTaskWaits: vi.fn() }));
vi.mock('../../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: vi.fn().mockResolvedValue(undefined),
}));

const START = new Date('2026-08-11T00:00:00.000Z').getTime();
const PROJECT_ID = 'project-1';

describe('delivery-aware attention expiry', () => {
  let doDb: Database.Database;
  let d1Db: Database.Database;
  let sql: SqlStorage;
  let hasConfirmedPushDelivery: ReturnType<typeof vi.fn>;
  let resendPushNotification: ReturnType<typeof vi.fn>;
  let notificationGet: ReturnType<typeof vi.fn>;
  let env: Env;
  let failSession: ReturnType<typeof vi.fn>;
  let scheduleSummarySync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    doDb = new Database(':memory:');
    sql = createSqlStorage(doDb);
    runMigrations(sql);
    d1Db = new Database(':memory:');
    createSchemaTables(d1Db, [schema.tasks, schema.taskStatusEvents, schema.workspaces]);
    sql.exec(
      `INSERT INTO chat_sessions
         (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('session-1', 'workspace-1', 'task-1', 'Expiry test', 'active', 0, ?, ?, ?)`,
      START,
      START,
      START
    );
    seedWorkspace();
    seedTask();
    hasConfirmedPushDelivery = vi.fn().mockResolvedValue(false);
    resendPushNotification = vi.fn().mockResolvedValue(undefined);
    notificationGet = vi.fn().mockReturnValue({
      hasConfirmedPushDelivery,
      resendPushNotification,
    });
    env = {
      DATABASE: createSqliteD1(d1Db),
      NOTIFICATION: {
        idFromName: vi.fn((value: string) => value),
        get: notificationGet,
      },
      HUMAN_INPUT_UNDELIVERED_GRACE_MS: '1000',
      HUMAN_INPUT_MAX_WAIT_MS: '5000',
      HUMAN_INPUT_ESCALATION_FRACTIONS: '0.25,0.75',
      TASK_RECONCILIATION_RESPONSE_DEADLINE_MS: '60000',
    } as unknown as Env;
    failSession = vi.fn().mockResolvedValue(undefined);
    scheduleSummarySync = vi.fn();
  });

  afterEach(() => {
    doDb.close();
    d1Db.close();
    vi.useRealTimers();
  });

  function processingHooks() {
    return { projectId: PROJECT_ID, scheduleSummarySync };
  }

  function seedWorkspace(status = 'running') {
    d1Db
      .prepare(
        `INSERT INTO workspaces (id, project_id, user_id, name, repository, branch, status, vm_size, vm_location, chat_session_id)
         VALUES ('workspace-1', ?, 'user-1', 'Workspace', 'repo', 'main', ?, 'small', 'nbg1', 'session-1')`
      )
      .run(PROJECT_ID, status);
  }

  function seedTask(status = 'in_progress') {
    d1Db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, chat_session_id, workspace_id, title, status, execution_step,
            task_mode, triggered_by, created_by, created_at, updated_at)
         VALUES
           ('task-1', ?, 'user-1', 'session-1', 'workspace-1', 'Task', ?, 'awaiting_followup',
            'task', 'user', 'user-1', ?, ?)`
      )
      .run(
        PROJECT_ID,
        status,
        new Date(START - 60_000).toISOString(),
        new Date(START).toISOString()
      );
  }

  function taskRow() {
    return d1Db
      .prepare(
        `SELECT status, error_message, started_at, completed_at, execution_step
         FROM tasks WHERE id = 'task-1'`
      )
      .get() as {
      status: string;
      error_message: string | null;
      started_at: string | null;
      completed_at: string | null;
      execution_step: string | null;
    };
  }

  function workspaceStatus(): string {
    return d1Db
      .prepare(`SELECT status FROM workspaces WHERE id = 'workspace-1'`)
      .pluck()
      .get() as string;
  }

  function statusEvents() {
    return d1Db
      .prepare(
        `SELECT from_status, to_status, actor_type, actor_id, reason
         FROM task_status_events WHERE task_id = 'task-1'
         ORDER BY created_at`
      )
      .all();
  }

  function insertActiveAcpState(
    overrides: {
      activity?: string;
      activityAt?: number;
      promptStartedAt?: number | null;
      runtimeWorkState?: 'inactive' | 'active' | 'settling' | null;
      runtimeWorkUpdatedAt?: number | null;
      runtimeWorkProgressAt?: number | null;
    } = {}
  ) {
    const activityAt = overrides.activityAt ?? START + 1_000;
    sql.exec(
      `INSERT INTO acp_sessions
         (id, chat_session_id, workspace_id, status, created_at, updated_at, assigned_at, started_at)
       VALUES ('acp-1', 'session-1', 'workspace-1', 'running', ?, ?, ?, ?)`,
      START - 120_000,
      activityAt,
      START - 120_000,
      START - 120_000
    );
    sql.exec(
      `INSERT INTO session_state
         (session_id, activity, activity_at, prompt_started_at,
          runtime_work_state, runtime_work_updated_at, runtime_work_progress_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'acp-1',
      overrides.activity ?? 'prompting',
      activityAt,
      overrides.promptStartedAt ?? activityAt,
      overrides.runtimeWorkState ?? null,
      overrides.runtimeWorkUpdatedAt ?? null,
      overrides.runtimeWorkProgressAt ?? null
    );
  }

  function createNeedsInput(overrides: Record<string, unknown> = {}) {
    return createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'needs_input',
      source: 'request_human_input',
      sourceNotificationId: 'notification-1',
      notificationUserId: 'user-1',
      expiresAt: START + 4000,
      nextEscalationAt: START + 1000,
      maxExpiresAt: START + 5000,
      ...overrides,
    } as Parameters<typeof createAttentionMarker>[1]);
  }

  it('re-notifies at each configured escalation without failing the task', async () => {
    createNeedsInput();
    vi.setSystemTime(START + 1000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(resendPushNotification).toHaveBeenCalledWith('user-1', 'notification-1');
    expect(taskRow().status).toBe('in_progress');
    expect(
      sql
        .exec('SELECT escalation_count, next_escalation_at FROM session_attention_markers')
        .toArray()
    ).toEqual([{ escalation_count: 1, next_escalation_at: START + 3000 }]);
  });

  it('extends an undelivered needs_input deadline and terminates at the hard max on the next tick', async () => {
    createNeedsInput({ expiresAt: START, nextEscalationAt: null });

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('in_progress');
    expect(failSession).not.toHaveBeenCalled();
    expect(
      sql.exec('SELECT resolved_at, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_at: null, expires_at: START + 1000 }]);

    vi.setSystemTime(START + 5000);
    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow()).toMatchObject({
      status: 'failed',
      error_message: 'Human input request expired after timeout',
      execution_step: null,
    });
    expect(workspaceStatus()).toBe('stopped');
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Human input request expired after timeout'
    );
    expect(sql.exec('SELECT resolved_reason FROM session_attention_markers').toArray()).toEqual([
      { resolved_reason: 'hard_max_expired' },
    ]);
  });

  it('fails needs_input at its deadline when push delivery was confirmed', async () => {
    hasConfirmedPushDelivery.mockResolvedValue(true);
    createNeedsInput({ expiresAt: START, nextEscalationAt: null });

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('failed');
    expect(workspaceStatus()).toBe('stopped');
    expect(failSession).toHaveBeenCalledOnce();
  });

  it('renews an expired reconciliation_checkin while current-generation prompting is active', async () => {
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START + 60_000,
    });
    insertActiveAcpState({ activity: 'prompting', activityAt: START + 1_000 });
    vi.setSystemTime(START + 67_000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('in_progress');
    expect(workspaceStatus()).toBe('running');
    expect(failSession).not.toHaveBeenCalled();
    expect(cleanupTaskRun).not.toHaveBeenCalled();
    expect(
      sql.exec('SELECT resolved_at, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_at: null, expires_at: START + 127_000 }]);
    expect(
      sql
        .exec(
          `SELECT event_type, payload
           FROM activity_events WHERE event_type = 'attention.expiry_deferred'`
        )
        .toArray()
    ).toHaveLength(1);
  });

  it('renews an expired reconciliation_checkin while current-generation runtime work is active', async () => {
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START + 60_000,
    });
    insertActiveAcpState({
      activity: 'idle',
      activityAt: START + 1_000,
      promptStartedAt: null,
      runtimeWorkState: 'active',
      runtimeWorkUpdatedAt: START + 1_000,
      runtimeWorkProgressAt: START + 1_000,
    });
    vi.setSystemTime(START + 67_000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('in_progress');
    expect(failSession).not.toHaveBeenCalled();
    expect(
      sql.exec('SELECT resolved_at, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_at: null, expires_at: START + 127_000 }]);
  });

  it('does not renew reconciliation_checkin from stale pre-check-in activity evidence', async () => {
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START,
    });
    insertActiveAcpState({ activity: 'prompting', activityAt: START - 1_000 });

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('failed');
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Agent became unresponsive after SAM check-in'
    );
  });

  it('does not renew reconciliation_checkin from ACP heartbeat alone', async () => {
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START + 60_000,
    });
    sql.exec(
      `INSERT INTO acp_sessions
         (id, chat_session_id, workspace_id, status, created_at, updated_at,
          assigned_at, started_at, last_heartbeat_at)
       VALUES ('acp-1', 'session-1', 'workspace-1', 'running', ?, ?, ?, ?, ?)`,
      START - 120_000,
      START + 67_000,
      START - 120_000,
      START - 120_000,
      START + 67_000
    );
    vi.setSystemTime(START + 67_000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('failed');
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Agent became unresponsive after SAM check-in'
    );
  });

  it('fails genuine reconciliation_checkin expiry through the terminal contract idempotently', async () => {
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START,
    });

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());
    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    const task = taskRow();
    expect(task).toMatchObject({
      status: 'failed',
      error_message: 'Agent became unresponsive after SAM check-in',
      execution_step: null,
    });
    expect(task.started_at).toBe(new Date(START).toISOString());
    expect(task.completed_at).toBe(new Date(START).toISOString());
    expect(statusEvents()).toEqual([
      {
        from_status: 'in_progress',
        to_status: 'failed',
        actor_type: 'system',
        actor_id: null,
        reason: 'Agent became unresponsive after SAM check-in',
      },
    ]);
    expect(workspaceStatus()).toBe('stopped');
    expect(failSession).toHaveBeenCalledTimes(1);
    expect(scheduleSummarySync).toHaveBeenCalledTimes(1);
    expect(notificationGet).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(cleanupTaskRun).toHaveBeenCalledWith('task-1', env));
    expect(
      sql.exec('SELECT resolved_reason, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_reason: 'expired', expires_at: START }]);
    expect(
      sql
        .exec(
          `SELECT event_type, workspace_id, session_id, task_id
           FROM activity_events WHERE event_type = 'attention.expired'`
        )
        .toArray()
    ).toEqual([
      {
        event_type: 'attention.expired',
        workspace_id: 'workspace-1',
        session_id: 'session-1',
        task_id: 'task-1',
      },
    ]);
  });
});
