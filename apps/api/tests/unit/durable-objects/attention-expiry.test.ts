import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { createAttentionMarker } from '../../../src/durable-objects/project-data/attention';
import { processExpiredAttentionMarkers } from '../../../src/durable-objects/project-data/attention-expiry';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { cleanupTaskRun } from '../../../src/services/task-runner';
import { createSqlStorage } from './sql-storage-test-utils';

vi.mock('../../../src/services/task-runner', () => ({ cleanupTaskRun: vi.fn() }));

const START = new Date('2026-08-11T00:00:00.000Z').getTime();

interface State {
  taskStatus: string;
  taskError: string | null;
  workspaceStatus: string;
}

function createD1(state: State): D1Database {
  return {
    prepare: vi.fn((query: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        run: vi.fn(async () => {
          if (query.includes("UPDATE tasks SET status = 'failed'")) {
            state.taskStatus = 'failed';
            state.taskError = args[0] as string;
          }
          if (query.includes("UPDATE workspaces SET status = 'stopped'")) {
            state.workspaceStatus = 'stopped';
          }
          return { success: true };
        }),
      })),
    })),
  } as unknown as D1Database;
}

describe('delivery-aware attention expiry', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let state: State;
  let hasConfirmedPushDelivery: ReturnType<typeof vi.fn>;
  let resendPushNotification: ReturnType<typeof vi.fn>;
  let notificationGet: ReturnType<typeof vi.fn>;
  let env: Env;
  let failSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
         (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('session-1', 'workspace-1', 'task-1', 'Expiry test', 'active', 0, ?, ?, ?)`,
      START,
      START,
      START
    );
    state = { taskStatus: 'in_progress', taskError: null, workspaceStatus: 'running' };
    hasConfirmedPushDelivery = vi.fn().mockResolvedValue(false);
    resendPushNotification = vi.fn().mockResolvedValue(undefined);
    notificationGet = vi.fn().mockReturnValue({
      hasConfirmedPushDelivery,
      resendPushNotification,
    });
    env = {
      DATABASE: createD1(state),
      NOTIFICATION: {
        idFromName: vi.fn((value: string) => value),
        get: notificationGet,
      },
      HUMAN_INPUT_UNDELIVERED_GRACE_MS: '1000',
      HUMAN_INPUT_MAX_WAIT_MS: '5000',
      HUMAN_INPUT_ESCALATION_FRACTIONS: '0.25,0.75',
    } as unknown as Env;
    failSession = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

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

    await processExpiredAttentionMarkers(sql, env, failSession);

    expect(resendPushNotification).toHaveBeenCalledWith('user-1', 'notification-1');
    expect(state.taskStatus).toBe('in_progress');
    expect(
      sql
        .exec('SELECT escalation_count, next_escalation_at FROM session_attention_markers')
        .toArray()
    ).toEqual([{ escalation_count: 1, next_escalation_at: START + 3000 }]);
  });

  it('extends an undelivered needs_input deadline and terminates at the hard max on the next tick', async () => {
    createNeedsInput({ expiresAt: START, nextEscalationAt: null });

    await processExpiredAttentionMarkers(sql, env, failSession);

    expect(state.taskStatus).toBe('in_progress');
    expect(failSession).not.toHaveBeenCalled();
    expect(
      sql.exec('SELECT resolved_at, expires_at FROM session_attention_markers').toArray()
    ).toEqual([{ resolved_at: null, expires_at: START + 1000 }]);

    vi.setSystemTime(START + 5000);
    await processExpiredAttentionMarkers(sql, env, failSession);

    expect(state).toEqual({
      taskStatus: 'failed',
      taskError: 'Human input request expired after timeout',
      workspaceStatus: 'stopped',
    });
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

    await processExpiredAttentionMarkers(sql, env, failSession);

    expect(state.taskStatus).toBe('failed');
    expect(state.workspaceStatus).toBe('stopped');
    expect(failSession).toHaveBeenCalledOnce();
  });

  it('keeps reconciliation_checkin terminal behavior unchanged and never applies delivery grace', async () => {
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      kind: 'reconciliation_checkin',
      source: 'sam_orchestrator',
      expiresAt: START,
    });

    await processExpiredAttentionMarkers(sql, env, failSession);

    expect(state).toEqual({
      taskStatus: 'failed',
      taskError: 'Agent became unresponsive after SAM check-in',
      workspaceStatus: 'stopped',
    });
    expect(failSession).toHaveBeenCalledWith(
      'session-1',
      'Agent became unresponsive after SAM check-in'
    );
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
