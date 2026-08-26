import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { reconcileTaskWaits } from '../../../src/services/project-data';
import { transitionTaskToTerminal } from '../../../src/services/task-terminal-transition';
import { cancelVmTaskAdmission } from '../../../src/services/vm-admission-control';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/project-data', () => ({ reconcileTaskWaits: vi.fn() }));
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

  function seedWorkspace(id: string, status = 'running') {
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, user_id, name, repository, branch, status, vm_size, vm_location)
         VALUES (?, ?, 'user-1', 'Workspace', 'repo', 'main', ?, 'small', 'nbg1')`
      )
      .run(id, PROJECT_ID, status);
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
      createdAt: string;
    }
  ) {
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, project_id, user_id, chat_session_id, recovery_source_task_id, parent_task_id,
            workspace_id, title, status, execution_step, task_mode, triggered_by,
            trigger_execution_id, created_by, created_at, updated_at)
         VALUES (?, ?, 'user-1', ?, ?, ?, ?, ?, ?, 'awaiting_followup', 'task', ?, ?, 'user-1', ?, ?)`
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
        `SELECT status, execution_step, error_message, started_at, completed_at
         FROM tasks WHERE id = ?`
      )
      .get(id) as {
      status: string;
      execution_step: string | null;
      error_message: string | null;
      started_at: string | null;
      completed_at: string | null;
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
    });
    const second = await transitionTaskToTerminal(env, {
      taskId: 'task-1',
      projectId: PROJECT_ID,
      status: 'failed',
      reason: 'Agent became unresponsive after SAM check-in',
      source: 'test.attention_expiry',
      expectedWorkspaceId: 'workspace-1',
      expectedChatSessionId: 'session-1',
    });

    expect(first).toBe('transitioned');
    expect(second).toBe('already_terminal');
    expect(taskRow()).toEqual({
      status: 'failed',
      execution_step: null,
      error_message: 'Agent became unresponsive after SAM check-in',
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
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
  });

  it('preserves an active predecessor when a live session-recovery successor owns the wake', async () => {
    seedWorkspace('workspace-2');
    seedTask('task-2', {
      workspaceId: 'workspace-2',
      chatSessionId: 'session-2',
      status: 'in_progress',
      triggeredBy: 'session-recovery',
      recoverySourceTaskId: 'task-1',
      createdAt: new Date(NOW.getTime() - 30_000).toISOString(),
    });

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
