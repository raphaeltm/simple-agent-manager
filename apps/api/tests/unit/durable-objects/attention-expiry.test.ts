import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { runMigrations } from '../../../src/durable-objects/migrations';
import { createAttentionMarker } from '../../../src/durable-objects/project-data/attention';
import { processExpiredAttentionMarkers } from '../../../src/durable-objects/project-data/attention-expiry';
import type { Env } from '../../../src/durable-objects/project-data/types';
import {
  failedTaskIncompleteSnapshotMessage,
  failedTaskNoticeId,
  failedTaskWorkLossMessage,
} from '../../../src/services/failed-task-preservation';
import { persistMessage } from '../../../src/services/project-data';
import { cleanupTaskRun } from '../../../src/services/task-runner';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

vi.mock('../../../src/services/task-runner', () => ({ cleanupTaskRun: vi.fn() }));
vi.mock('../../../src/services/project-data', () => ({
  reconcileTaskWaits: vi.fn(),
  persistMessage: vi.fn().mockResolvedValue('notice-1'),
}));
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
    createSchemaTables(d1Db, [
      schema.tasks,
      schema.taskStatusEvents,
      schema.workspaces,
      schema.projectEventSourceOutbox,
      // Failed-task preservation reads the runtime and the chat's sleep state.
      schema.nodes,
      schema.agentSessions,
      schema.sessionSnapshots,
      schema.sessionSummaries,
    ]);
    d1Db.exec(
      'CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id ON session_snapshots(chat_session_id)'
    );
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
    // This fixture has no node row, so the work cannot be preserved: teardown is
    // delegated to cleanupTaskRun (the real VM stop), not a D1-only `stopped` mark.
    expect(workspaceStatus()).toBe('running');
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Human input request expired after timeout'
    );
    await vi.waitFor(() => expect(cleanupTaskRun).toHaveBeenCalledWith('task-1', env));
    expect(sql.exec('SELECT resolved_reason FROM session_attention_markers').toArray()).toEqual([
      { resolved_reason: 'hard_max_expired' },
    ]);
  });

  it('fails needs_input at its deadline when push delivery was confirmed', async () => {
    hasConfirmedPushDelivery.mockResolvedValue(true);
    createNeedsInput({ expiresAt: START, nextEscalationAt: null });

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('failed');
    expect(workspaceStatus()).toBe('running');
    expect(failSession).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(cleanupTaskRun).toHaveBeenCalledWith('task-1', env));
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

  it('fails reconciliation_checkin expiry when in-flight runtime work exceeds the hard ceiling', async () => {
    env.TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS = '120000';
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
    vi.setSystemTime(START + 130_000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow()).toMatchObject({
      status: 'failed',
      error_message: 'Agent became unresponsive after SAM check-in',
      execution_step: null,
    });
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Agent became unresponsive after SAM check-in'
    );
    await vi.waitFor(() => expect(cleanupTaskRun).toHaveBeenCalledWith('task-1', env));
  });

  it('fails reconciliation_checkin expiry when in-flight prompt activity exceeds the hard ceiling', async () => {
    env.TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS = '120000';
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START + 60_000,
    });
    insertActiveAcpState({
      activity: 'prompting',
      promptStartedAt: START + 1_000,
      activityAt: START + 122_000,
    });
    vi.setSystemTime(START + 130_000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow()).toMatchObject({
      status: 'failed',
      error_message: 'Agent became unresponsive after SAM check-in',
      execution_step: null,
    });
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Agent became unresponsive after SAM check-in'
    );
  });

  it('caps prompt-based reconciliation_checkin re-arm at the hard ceiling', async () => {
    env.TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS = '120000';
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START + 60_000,
    });
    insertActiveAcpState({
      activity: 'prompting',
      promptStartedAt: START + 1_000,
      activityAt: START + 67_000,
    });
    vi.setSystemTime(START + 67_000);

    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow().status).toBe('in_progress');
    expect(
      sql.exec('SELECT resolved_at, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_at: null, expires_at: START + 121_000 }]);
  });

  it('does not re-arm reconciliation_checkin forever without fresh runtime-work evidence', async () => {
    env.TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS = '120000';
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
    expect(
      sql.exec('SELECT resolved_at, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_at: null, expires_at: START + 121_000 }]);

    vi.setSystemTime(START + 121_000);
    await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

    expect(taskRow()).toMatchObject({
      status: 'failed',
      error_message: 'Agent became unresponsive after SAM check-in',
      execution_step: null,
    });
    expect(failSession).toHaveBeenCalledTimes(1);
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
    expect(workspaceStatus()).toBe('running');
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

  describe('failed-task work preservation (idea 01M1XGHX7NQZQYWQRV5C1PJ60N)', () => {
    function seedLiveVmRuntime(agentSessionStatus = 'running') {
      d1Db
        .prepare(
          `INSERT INTO nodes (id, user_id, status, node_role, runtime)
           VALUES ('node-1', 'user-1', 'running', 'workspace', 'vm')`
        )
        .run();
      d1Db.prepare(`UPDATE workspaces SET node_id = 'node-1' WHERE id = 'workspace-1'`).run();
      d1Db
        .prepare(
          `INSERT INTO agent_sessions (id, workspace_id, status, agent_type, created_at)
           VALUES ('agent-1', 'workspace-1', ?, 'claude-code', ?)`
        )
        .run(agentSessionStatus, new Date(START - 60_000).toISOString());
    }

    function seedSleepingSnapshot(capture = { status: 'available', degradation: 'none' }) {
      const sleptAt = new Date(START - 24 * 60 * 60 * 1000).toISOString();
      d1Db
        .prepare(
          `INSERT INTO session_snapshots
             (id, project_id, workspace_id, user_id, chat_session_id, agent_session_id, runtime,
              status, degradation, manifest_r2_key, expires_at, sleeping_at, sleep_status,
              recovery_attempts, sleep_attempts, created_at, updated_at)
           VALUES ('snapshot-1', ?, 'workspace-1', 'user-1', 'session-1', 'agent-1', 'vm',
              ?, ?, 'snapshots/manifest.json', ?, ?, 'sleeping', 0, 0, ?, ?)`
        )
        .run(
          PROJECT_ID,
          capture.status,
          capture.degradation,
          new Date(START + 6 * 24 * 60 * 60 * 1000).toISOString(),
          sleptAt,
          sleptAt,
          sleptAt
        );
    }

    function sleepAlreadyHappened() {
      d1Db.prepare(`UPDATE workspaces SET status = 'deleted' WHERE id = 'workspace-1'`).run();
      sql.exec(`UPDATE chat_sessions SET status = 'sleeping' WHERE id = 'session-1'`);
    }

    function snapshotRow() {
      return d1Db
        .prepare(
          `SELECT status, sleep_status, sleep_after FROM session_snapshots
           WHERE chat_session_id = 'session-1'`
        )
        .get();
    }

    function checkinMarker() {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: START,
      });
    }

    it('keeps an already-sleeping conversation asleep and wakeable when human input expires', async () => {
      // The production shape: the session slept while it waited, a day before the
      // marker expired. Failing it would flip ProjectData sleeping -> failed, which
      // snapshot recovery refuses to wake.
      sleepAlreadyHappened();
      seedSleepingSnapshot();
      hasConfirmedPushDelivery.mockResolvedValue(true);
      createNeedsInput({ expiresAt: START, nextEscalationAt: null });

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow()).toMatchObject({
        status: 'failed',
        error_message: 'Human input request expired after timeout',
      });
      expect(sql.exec('SELECT resolved_reason FROM session_attention_markers').toArray()).toEqual([
        { resolved_reason: 'expired' },
      ]);
      expect(failSession).not.toHaveBeenCalled();
      expect(persistMessage).not.toHaveBeenCalled();
      expect(cleanupTaskRun).not.toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ status: 'available', sleep_status: 'sleeping' });
    });

    it('keeps an already-sleeping conversation asleep when a SAM check-in expires', async () => {
      sleepAlreadyHappened();
      seedSleepingSnapshot();
      checkinMarker();

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow()).toMatchObject({
        status: 'failed',
        error_message: 'Agent became unresponsive after SAM check-in',
      });
      expect(failSession).not.toHaveBeenCalled();
      expect(cleanupTaskRun).not.toHaveBeenCalled();
      expect(snapshotRow()).toMatchObject({ status: 'available', sleep_status: 'sleeping' });
    });

    it('says so when the conversation had already slept with an incomplete snapshot', async () => {
      // The brief's own example: the conversation slept transcript-only a day
      // before its human-input request expired. It stays asleep and wakeable, and
      // the chat says the workspace files may be missing.
      sleepAlreadyHappened();
      seedSleepingSnapshot({ status: 'degraded', degradation: 'transcript-only' });
      hasConfirmedPushDelivery.mockResolvedValue(true);
      createNeedsInput({ expiresAt: START, nextEscalationAt: null });

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow().status).toBe('failed');
      expect(persistMessage).toHaveBeenCalledWith(
        env,
        PROJECT_ID,
        'session-1',
        'system',
        failedTaskIncompleteSnapshotMessage('transcript-only', 'vm'),
        null,
        failedTaskNoticeId('snapshot-incomplete', 'task-1', 'session-1')
      );
      expect(failSession).not.toHaveBeenCalled();
      expect(cleanupTaskRun).not.toHaveBeenCalled();
    });

    it('queues a snapshot-backed sleep instead of tearing down a live runtime', async () => {
      seedLiveVmRuntime();
      checkinMarker();

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow()).toMatchObject({
        status: 'failed',
        error_message: 'Agent became unresponsive after SAM check-in',
      });
      expect(snapshotRow()).toMatchObject({
        status: 'pending',
        sleep_status: 'scheduled',
        sleep_after: new Date(START).toISOString(),
      });
      expect(workspaceStatus()).toBe('running');
      expect(failSession).not.toHaveBeenCalled();
      expect(persistMessage).not.toHaveBeenCalled();
      expect(cleanupTaskRun).not.toHaveBeenCalled();
    });

    it.each([
      ['prompting past the hard ceiling', { activity: 'prompting' }],
      [
        'running harness work past the hard ceiling',
        {
          activity: 'idle',
          activityAt: START + 1_000,
          promptStartedAt: null,
          runtimeWorkState: 'active' as const,
          runtimeWorkUpdatedAt: START + 1_000,
          runtimeWorkProgressAt: START + 1_000,
        },
      ],
    ])(
      'releases a live runtime whose check-in expired with the agent %s',
      async (_label, state) => {
        // The watchdog's own verdict is that this turn will not end. A preservation
        // sleep would wait on it (the drain follows activity), and every capture
        // would race the turn's re-reports: tear it down now and say so.
        env.TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS = '120000';
        seedLiveVmRuntime();
        checkinMarker();
        insertActiveAcpState({
          promptStartedAt: START + 1_000,
          activityAt: START + 122_000,
          ...state,
        });
        vi.setSystemTime(START + 130_000);

        await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

        expect(taskRow()).toMatchObject({
          status: 'failed',
          error_message: 'Agent became unresponsive after SAM check-in',
        });
        expect(snapshotRow()).toBeUndefined();
        expect(persistMessage).toHaveBeenCalledWith(
          env,
          PROJECT_ID,
          'session-1',
          'system',
          failedTaskWorkLossMessage('agent_unresponsive'),
          null,
          failedTaskNoticeId('work-loss', 'task-1', 'session-1')
        );
        expect(failSession).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(cleanupTaskRun).toHaveBeenCalledWith('task-1', env));
      }
    );

    it('still preserves a live runtime whose check-in expired on an idle agent (control)', async () => {
      seedLiveVmRuntime();
      checkinMarker();
      insertActiveAcpState({ activity: 'idle', activityAt: START - 60_000, promptStartedAt: null });

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow().status).toBe('failed');
      expect(snapshotRow()).toMatchObject({ sleep_status: 'scheduled' });
      expect(persistMessage).not.toHaveBeenCalled();
      expect(failSession).not.toHaveBeenCalled();
      expect(cleanupTaskRun).not.toHaveBeenCalled();
    });

    it('says the work was not preserved before failing the session and tearing down', async () => {
      seedLiveVmRuntime('failed');
      checkinMarker();

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow().status).toBe('failed');
      expect(persistMessage).toHaveBeenCalledWith(
        env,
        PROJECT_ID,
        'session-1',
        'system',
        failedTaskWorkLossMessage('no_resumable_agent_session'),
        null,
        failedTaskNoticeId('work-loss', 'task-1', 'session-1')
      );
      expect(failSession).toHaveBeenCalledOnce();
      expect(vi.mocked(persistMessage).mock.invocationCallOrder[0]).toBeLessThan(
        failSession.mock.invocationCallOrder[0] ?? 0
      );
      await vi.waitFor(() => expect(cleanupTaskRun).toHaveBeenCalledWith('task-1', env));
      expect(snapshotRow()).toBeUndefined();
    });

    it('withholds teardown when the preservation lookup fails', async () => {
      seedLiveVmRuntime();
      d1Db.exec('DROP TABLE nodes');
      checkinMarker();

      await processExpiredAttentionMarkers(sql, env, failSession, processingHooks());

      expect(taskRow().status).toBe('failed');
      expect(failSession).not.toHaveBeenCalled();
      expect(persistMessage).not.toHaveBeenCalled();
      expect(cleanupTaskRun).not.toHaveBeenCalled();
    });
  });
});
