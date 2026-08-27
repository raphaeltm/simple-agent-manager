import type { TaskActorType, TaskTerminalStatus } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { loadTaskSupersession } from './task-runtime-liveness';
import {
  createTaskWaitTerminalTransitionHook,
  runTaskTerminalTransitionHooks,
} from './task-terminal-transition-hooks';
import { syncTriggerExecutionStatus } from './trigger-execution-sync';
import { cancelVmTaskAdmission } from './vm-admission-control';

const log = createModuleLogger('task_terminal_transition');

const ACTIVE_TERMINALIZABLE_TASK_STATUSES = new Set([
  'queued',
  'in_progress',
  'delegated',
  'awaiting_followup',
]);

export type TaskTerminalTransitionOutcome =
  | 'transitioned'
  | 'already_terminal'
  | 'not_terminalizable'
  | 'not_found'
  | 'scope_mismatch'
  | 'superseded';

interface TaskTerminalTransitionRow {
  id: string;
  project_id: string;
  status: string;
  workspace_id: string | null;
  chat_session_id: string | null;
  parent_task_id: string | null;
}

export interface TransitionTaskToTerminalOptions {
  taskId: string;
  projectId: string | null;
  status: TaskTerminalStatus;
  reason: string | null;
  source: string;
  expectedWorkspaceId?: string | null;
  expectedChatSessionId?: string | null;
  expectedNodeId?: string | null;
  actorType?: TaskActorType;
  actorId?: string | null;
  stopWorkspace?: boolean;
  /**
   * Attention/reconciliation terminalization happens after a task is already
   * actively running. If a legacy row missed `started_at`, set it at the same
   * instant as completion so lifecycle consumers never see a terminal task that
   * appears never to have started.
   */
  fillMissingStartedAt?: boolean;
}

function changed(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function admissionReason(status: TaskTerminalStatus): string {
  if (status === 'failed') return 'task_failed';
  if (status === 'cancelled') return 'task_cancelled';
  return 'task_completed_cleanup';
}

function terminalErrorMessage(status: TaskTerminalStatus, reason: string | null): string | null {
  if (status === 'completed') return null;
  return reason;
}

async function loadTaskRow(
  db: D1Database,
  taskId: string
): Promise<TaskTerminalTransitionRow | null> {
  return db
    .prepare(
      `SELECT id, project_id, status, workspace_id, chat_session_id, parent_task_id
       FROM tasks
       WHERE id = ?
       LIMIT 1`
    )
    .bind(taskId)
    .first<TaskTerminalTransitionRow>();
}

async function workspaceMatchesExpectedNode(
  db: D1Database,
  task: TaskTerminalTransitionRow,
  expectedNodeId: string
): Promise<boolean> {
  if (!task.workspace_id) return false;
  const workspace = await db
    .prepare(
      `SELECT node_id
       FROM workspaces
       WHERE id = ? AND project_id = ?
       LIMIT 1`
    )
    .bind(task.workspace_id, task.project_id)
    .first<{ node_id: string | null }>();
  return workspace?.node_id === expectedNodeId;
}

/**
 * Shared D1 terminal transition contract for non-TaskRunner writers.
 *
 * This helper owns the task-row CAS, task_status_events row, trigger execution
 * sync, durable parent-wake hook, VM admission cancellation, and the same
 * supersession fence used by stuck-task recovery. Callers still own any
 * ProjectData-local session state transitions and activity events.
 */
export async function transitionTaskToTerminal(
  env: Env,
  options: TransitionTaskToTerminalOptions
): Promise<TaskTerminalTransitionOutcome> {
  if (!options.projectId) {
    log.warn('task_terminal_transition.project_scope_missing', {
      taskId: options.taskId,
      status: options.status,
      source: options.source,
      action: 'rejected',
    });
    return 'scope_mismatch';
  }

  const task = await loadTaskRow(env.DATABASE, options.taskId);
  if (!task) return 'not_found';
  if (task.project_id !== options.projectId) return 'scope_mismatch';
  if (
    options.expectedWorkspaceId !== undefined &&
    options.expectedWorkspaceId !== null &&
    task.workspace_id !== options.expectedWorkspaceId
  ) {
    return 'scope_mismatch';
  }
  if (
    options.expectedChatSessionId !== undefined &&
    options.expectedChatSessionId !== null &&
    task.chat_session_id !== options.expectedChatSessionId
  ) {
    return 'scope_mismatch';
  }
  if (
    options.expectedNodeId !== undefined &&
    options.expectedNodeId !== null &&
    !(await workspaceMatchesExpectedNode(env.DATABASE, task, options.expectedNodeId))
  ) {
    return 'scope_mismatch';
  }
  if (task.status === options.status) return 'already_terminal';
  if (['completed', 'failed', 'cancelled'].includes(task.status)) return 'already_terminal';
  if (!ACTIVE_TERMINALIZABLE_TASK_STATUSES.has(task.status)) return 'not_terminalizable';

  const now = new Date().toISOString();
  const errorMessage = terminalErrorMessage(options.status, options.reason);
  const updateTask = env.DATABASE.prepare(
    `UPDATE tasks
     SET status = ?,
         execution_step = NULL,
         error_message = ?,
         started_at = CASE WHEN ? = 1 THEN COALESCE(started_at, ?) ELSE started_at END,
         completed_at = ?,
         updated_at = ?
     WHERE id = ?
       AND project_id = ?
       AND status = ?
       AND (? IS NULL OR workspace_id = ?)
       AND (? IS NULL OR chat_session_id = ?)
       AND (
         ? IS NULL
         OR (
           workspace_id IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM workspaces w
             WHERE w.id = tasks.workspace_id
               AND w.project_id = tasks.project_id
               AND w.node_id = ?
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM tasks succ
          WHERE succ.project_id = tasks.project_id
            AND succ.id <> tasks.id
            AND succ.triggered_by = 'session-recovery'
            AND succ.created_at > tasks.created_at
            AND succ.status NOT IN ('completed', 'failed', 'cancelled')
            AND (
              succ.id = COALESCE(tasks.recovery_source_task_id, tasks.id)
              OR succ.recovery_source_task_id = COALESCE(tasks.recovery_source_task_id, tasks.id)
              OR succ.recovery_source_task_id = tasks.id
            )
       )`
  ).bind(
    options.status,
    errorMessage,
    options.fillMissingStartedAt === false ? 0 : 1,
    now,
    now,
    now,
    options.taskId,
    options.projectId,
    task.status,
    options.expectedWorkspaceId ?? null,
    options.expectedWorkspaceId ?? null,
    options.expectedChatSessionId ?? null,
    options.expectedChatSessionId ?? null,
    options.expectedNodeId ?? null,
    options.expectedNodeId ?? null
  );
  const insertEvent = env.DATABASE.prepare(
    `INSERT INTO task_status_events
       (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ?
     FROM tasks
     WHERE id = ?
       AND project_id = ?
       AND status = ?
       AND completed_at = ?
       AND ((? IS NULL AND error_message IS NULL) OR error_message = ?)`
  ).bind(
    ulid(),
    task.status,
    options.status,
    options.actorType ?? 'system',
    options.actorId ?? null,
    options.reason,
    now,
    options.taskId,
    options.projectId,
    options.status,
    now,
    errorMessage,
    errorMessage
  );

  const [updateResult, eventResult] = await env.DATABASE.batch([updateTask, insertEvent]);
  if (changed(updateResult) === 0) {
    try {
      const supersession = await loadTaskSupersession(
        env.DATABASE,
        options.projectId,
        options.taskId
      );
      return supersession === 'live' ? 'superseded' : 'not_terminalizable';
    } catch (err) {
      log.warn('task_terminal_transition.supersession_diagnosis_failed', {
        taskId: options.taskId,
        projectId: options.projectId,
        source: options.source,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'not_terminalizable';
    }
  }
  if (changed(eventResult) === 0) {
    throw new Error('Task terminal transition did not append its status event');
  }

  await syncTriggerExecutionStatus(
    env.DATABASE,
    options.taskId,
    options.status,
    options.reason ?? undefined
  );
  await cancelVmTaskAdmission(env, options.taskId, admissionReason(options.status)).catch((err) => {
    log.warn('task_terminal_transition.admission_cancel_failed', {
      taskId: options.taskId,
      projectId: options.projectId,
      status: options.status,
      source: options.source,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  if (options.stopWorkspace !== false && task.workspace_id) {
    await env.DATABASE.prepare(
      `UPDATE workspaces
       SET status = 'stopped', updated_at = ?
       WHERE id = ? AND project_id = ? AND status IN ('running', 'recovery')`
    )
      .bind(now, task.workspace_id, options.projectId)
      .run();
  }
  await runTaskTerminalTransitionHooks(
    {
      taskId: options.taskId,
      projectId: options.projectId,
      parentTaskId: task.parent_task_id,
      status: options.status,
      reason: options.reason,
      occurredAt: now,
      source: options.source,
    },
    [createTaskWaitTerminalTransitionHook(env)]
  );

  return 'transitioned';
}
