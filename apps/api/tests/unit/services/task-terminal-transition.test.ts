import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { reconcileTaskWaits } from '../../../src/services/project-data';
import { transitionTaskToTerminal } from '../../../src/services/task-terminal-transition';
import { cancelVmTaskAdmission } from '../../../src/services/vm-admission-control';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const admitProjectEventSourceIntentById = vi.hoisted(() =>
  vi.fn(async () => ({ state: 'admitted' }))
);

vi.mock('../../../src/services/project-data', () => ({ reconcileTaskWaits: vi.fn() }));
vi.mock('../../../src/services/project-event-source-outbox', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, admitProjectEventSourceIntentById };
});
vi.mock('../../../src/services/vm-admission-control', () => ({
  cancelVmTaskAdmission: vi.fn().mockResolvedValue(undefined),
}));

const NOW = new Date('2026-08-11T00:00:00.000Z');
const PROJECT_ID = 'project-1';

describe('transitionTaskToTerminal', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.tasks,
      schema.taskStatusEvents,
      schema.workspaces,
      schema.triggerExecutions,
      schema.projectEventSourceOutbox,
    ]);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
    seedWorkspace('workspace-1');
    seedTask('task-1', {
      workspaceId: 'workspace-1',
      chatSessionId: 'session-1',
      parentTaskId: 'parent-task-1',
      triggerExecutionId: 'trigger-execution-1',
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    seedTriggerExecution('trigger-execution-1', 'task-1');
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  function seedWorkspace(id: string, status = 'running', nodeId: string | null = 'node-1') {
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, project_id, user_id, name, repository, branch, node_id, status, vm_size, vm_location)
         VALUES (?, ?, 'user-1', 'Workspace', 'repo', 'main', ?, ?, 'small', 'nbg1')`
      )
      .run(id, PROJECT_ID, nodeId, status);
  }

  function seedTask(
    id: string,
    opts: {
      workspaceId: string | null;
      chatSessionId: string | null;
      parentTaskId?: string | null;
      status?: string;
      triggerExecutionId?: string | null;
      triggeredBy?: string;
      recoverySourceTaskId?: string | null;
      supersededByTaskId?: string | null;
      createdAt: string;
    }
  ) {
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, chat_session_id, recovery_source_task_id, parent_task_id,
            workspace_id, title, status, execution_step, task_mode, triggered_by,
            trigger_execution_id, superseded_by_task_id, created_by, created_at, updated_at)
         VALUES (?, ?, 'user-1', ?, ?, ?, ?, ?, ?, 'awaiting_followup', 'task', ?, ?, ?, 'user-1', ?, ?)`
      )
      .run(
        id,
        PROJECT_ID,
        opts.chatSessionId,
        opts.recoverySourceTaskId ?? null,
        opts.parentTaskId ?? null,
        opts.workspaceId,
        id,
        opts.status ?? 'in_progress',
        opts.triggeredBy ?? 'user',
        opts.triggerExecutionId ?? null,
        opts.supersededByTaskId ?? null,
        opts.createdAt,
        opts.createdAt
      );
  }

  function seedTriggerExecution(id: string, taskId: string) {
    sqlite
      .prepare(
        `INSERT INTO trigger_executions (id, trigger_id, project_id, status, task_id, created_at)
         VALUES (?, 'trigger-1', ?, 'running', ?, ?)`
      )
      .run(id, PROJECT_ID, taskId, new Date(NOW.getTime() - 60_000).toISOString());
  }

  function taskRow(id = 'task-1') {
    return sqlite
      .prepare(
        `SELECT status, execution_step, error_message, started_at, completed_at,
                terminal_transition_id
         FROM tasks WHERE id = ?`
      )
      .get(id) as {
      status: string;
      execution_step: string | null;
      error_message: string | null;
      started_at: string | null;
      completed_at: string | null;
      terminal_transition_id: string | null;
    };
  }

  function statusEvents(taskId = 'task-1') {
    return sqlite
      .prepare(
        `SELECT from_status, to_status, actor_type, actor_id, reason
         FROM task_status_events WHERE task_id = ?
         ORDER BY created_at`
      )
      .all(taskId);
  }

  it('records the full terminal contract once and remains idempotent on retry', async () => {
    const first = await transitionTaskToTerminal(env, {
      taskId: 'task-1',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Agent became unresponsive after SAM check-in',
      source: 'test.attention_expiry',
      expectedWorkspaceId: 'workspace-1',
      expectedChatSessionId: 'session-1',
      expectedNodeId: 'node-1',
    });
    const second = await transitionTaskToTerminal(env, {
      taskId: 'task-1',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Agent became unresponsive after SAM check-in',
      source: 'test.attention_expiry',
      expectedWorkspaceId: 'workspace-1',
      expectedChatSessionId: 'session-1',
      expectedNodeId: 'node-1',
    });

    expect(first).toBe('transitioned');
    expect(second).toBe('already_terminal');
    expect(taskRow()).toEqual({
      status: 'failed',
      execution_step: null,
      error_message: 'Agent became unresponsive after SAM check-in',
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
      terminal_transition_id: expect.any(String),
    });
    expect(statusEvents()).toEqual([
      {
        from_status: 'in_progress',
        to_status: 'failed',
        actor_type: 'system',
        actor_id: null,
        reason: 'Agent became unresponsive after SAM check-in',
      },
    ]);
    expect(
      sqlite
        .prepare(`SELECT status, completed_at, error_message FROM trigger_executions WHERE id = ?`)
        .get('trigger-execution-1')
    ).toEqual({
      status: 'failed',
      completed_at: NOW.toISOString(),
      error_message: 'Agent became unresponsive after SAM check-in',
    });
    expect(
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = ?`).pluck().get('workspace-1')
    ).toBe('stopped');
    expect(cancelVmTaskAdmission).toHaveBeenCalledTimes(1);
    expect(cancelVmTaskAdmission).toHaveBeenCalledWith(env, 'task-1', 'task_failed');
    expect(reconcileTaskWaits).toHaveBeenCalledTimes(1);
    expect(reconcileTaskWaits).toHaveBeenCalledWith(env, PROJECT_ID, 'task-1');
    const outboxRows = sqlite
      .prepare(
        `SELECT id, project_id, source, event_type, subject_type, subject_id, delivery_key,
                state, event_payload_json
           FROM project_event_source_outbox`
      )
      .all() as Array<{
      id: string;
      project_id: string;
      source: string;
      event_type: string;
      subject_type: string;
      subject_id: string;
      delivery_key: string;
      state: string;
      event_payload_json: string;
    }>;
    expect(admitProjectEventSourceIntentById).toHaveBeenCalledTimes(1);
    expect(admitProjectEventSourceIntentById).toHaveBeenCalledWith(env, outboxRows[0]?.id);
    expect(JSON.parse(outboxRows[0]?.event_payload_json ?? '{}')).toMatchObject({
      metadata: {
        taskId: 'task-1',
        status: 'failed',
        fromStatus: 'in_progress',
        parentTaskId: 'parent-task-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        reason: 'Agent became unresponsive after SAM check-in',
        transitionSource: 'test.attention_expiry',
      },
    });
    expect(outboxRows.map(({ event_payload_json: _eventPayloadJson, ...row }) => row)).toEqual([
      {
        id: outboxRows[0]?.id,
        project_id: PROJECT_ID,
        source: 'sam.lifecycle',
        event_type: 'task.failed',
        subject_type: 'task',
        subject_id: 'task-1',
        delivery_key: expect.stringMatching(/^task:task-1:status:failed:transition:/),
        state: 'pending',
      },
    ]);
  });

  it('captures distinct terminal events when the same task fails again after requeue', async () => {
    const fail = (reason: string) =>
      transitionTaskToTerminal(env, {
        taskId: 'task-1',
        projectId: PROJECT_ID,
        status: 'failed',
        reason,
        source: 'test.requeued_failure',
      });
    expect(await fail('First attempt failed')).toBe('transitioned');
    const firstTransitionId = taskRow().terminal_transition_id;
    sqlite
      .prepare(
        `UPDATE tasks SET status = 'in_progress', completed_at = NULL,
      error_message = NULL WHERE id = 'task-1'`
      )
      .run();
    expect(await fail('Second attempt failed')).toBe('transitioned');
    const secondTransitionId = taskRow().terminal_transition_id;
    expect(secondTransitionId).not.toBe(firstTransitionId);
    const rows = sqlite
      .prepare(
        `SELECT delivery_key, state, event_payload_json
      FROM project_event_source_outbox ORDER BY rowid`
      )
      .all() as Array<{
      delivery_key: string;
      state: string;
      event_payload_json: string;
    }>;
    expect(rows.map((row) => row.delivery_key)).toEqual([
      `task:task-1:status:failed:transition:${firstTransitionId}`,
      `task:task-1:status:failed:transition:${secondTransitionId}`,
    ]);
    expect(rows.map((row) => row.state)).toEqual(['pending', 'pending']);
    expect(rows.map((row) => JSON.parse(row.event_payload_json).metadata.reason)).toEqual([
      'First attempt failed',
      'Second attempt failed',
    ]);
    expect(admitProjectEventSourceIntentById).toHaveBeenCalledTimes(2);
  });

  it('rejects stale terminal evidence after workspace node ownership changes', async () => {
    sqlite.prepare(`UPDATE workspaces SET node_id = ? WHERE id = ?`).run('node-2', 'workspace-1');

    const outcome = await transitionTaskToTerminal(env, {
      taskId: 'task-1',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Old node failed after stale liveness snapshot',
      source: 'test.stuck_tasks',
      expectedWorkspaceId: 'workspace-1',
      expectedChatSessionId: 'session-1',
      expectedNodeId: 'node-1',
    });

    expect(outcome).toBe('scope_mismatch');
    expect(taskRow()).toMatchObject({
      status: 'in_progress',
      execution_step: 'awaiting_followup',
      error_message: null,
      completed_at: null,
    });
    expect(statusEvents()).toEqual([]);
    expect(
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = ?`).pluck().get('workspace-1')
    ).toBe('running');
    expect(cancelVmTaskAdmission).not.toHaveBeenCalled();
    expect(reconcileTaskWaits).not.toHaveBeenCalled();
    expect(admitProjectEventSourceIntentById).not.toHaveBeenCalled();
  });

  it('does not capture a source intent when a same-millisecond cancellation wins first', async () => {
    const database = env.DATABASE;
    const originalBatch = database.batch.bind(database);
    env = {
      ...env,
      DATABASE: {
        ...database,
        batch: vi.fn(async (statements) => {
          sqlite
            .prepare(
              `UPDATE tasks
                  SET status = 'cancelled', error_message = 'cancelled first',
                      completed_at = ?, updated_at = ?
                WHERE id = ?`
            )
            .run(NOW.toISOString(), NOW.toISOString(), 'task-1');
          return originalBatch(statements);
        }),
      } as unknown as D1Database,
    } as Env;

    const outcome = await transitionTaskToTerminal(env, {
      taskId: 'task-1',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Old observation lost the race',
      source: 'test.race',
      expectedWorkspaceId: 'workspace-1',
      expectedChatSessionId: 'session-1',
    });

    expect(outcome).toBe('not_terminalizable');
    expect(statusEvents()).toEqual([]);
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM project_event_source_outbox`).get()
    ).toEqual({ count: 0 });
    expect(admitProjectEventSourceIntentById).not.toHaveBeenCalled();
  });

  it('terminalizes queued rows for scheduled timeout recovery', async () => {
    seedTask('queued-task', {
      workspaceId: null,
      chatSessionId: null,
      status: 'queued',
      triggerExecutionId: null,
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });

    const outcome = await transitionTaskToTerminal(env, {
      taskId: 'queued-task',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Task stuck in queued state',
      source: 'test.stuck_tasks',
      fillMissingStartedAt: false,
    });

    expect(outcome).toBe('transitioned');
    expect(taskRow('queued-task')).toMatchObject({
      status: 'failed',
      execution_step: null,
      error_message: 'Task stuck in queued state',
      started_at: null,
      completed_at: NOW.toISOString(),
    });
    expect(statusEvents('queued-task')).toEqual([
      {
        from_status: 'queued',
        to_status: 'failed',
        actor_type: 'system',
        actor_id: null,
        reason: 'Task stuck in queued state',
      },
    ]);
  });

  it('preserves an active predecessor when its session-recovery successor has not accepted the wake', async () => {
    seedWorkspace('workspace-2');
    seedTask('task-2', {
      workspaceId: 'workspace-2',
      chatSessionId: 'session-2',
      status: 'queued',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: 'task-1',
      createdAt: new Date(NOW.getTime() - 30_000).toISOString(),
    });
    sqlite.prepare(`UPDATE tasks SET superseded_by_task_id = 'task-2' WHERE id = 'task-1'`).run();

    const outcome = await transitionTaskToTerminal(env, {
      taskId: 'task-1',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Agent became unresponsive after SAM check-in',
      source: 'test.attention_expiry',
      expectedWorkspaceId: 'workspace-1',
      expectedChatSessionId: 'session-1',
    });

    expect(outcome).toBe('superseded');
    expect(taskRow()).toMatchObject({
      status: 'in_progress',
      execution_step: 'awaiting_followup',
      error_message: null,
      completed_at: null,
    });
    expect(statusEvents()).toEqual([]);
    expect(
      sqlite.prepare(`SELECT status FROM workspaces WHERE id = ?`).pluck().get('workspace-1')
    ).toBe('running');
    expect(cancelVmTaskAdmission).not.toHaveBeenCalled();
    expect(reconcileTaskWaits).not.toHaveBeenCalled();
  });
});
