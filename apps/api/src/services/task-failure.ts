/**
 * Shared failure transition for tasks that die before the TaskRunner takes
 * ownership (chat-session creation or runner/instant startup failures).
 * Used by the MCP dispatch and trigger submission paths.
 */
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { recordTaskLifecycleEventBestEffort } from './project-lifecycle-events';
import { isTaskStatus, taskStatusIsNonTerminalSql, TERMINAL_STATUS_VALUES } from './task-status';

export interface MarkTaskFailedEventContext {
  env: Env;
  projectId: string;
  source: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  nodeId?: string | null;
}

export interface MarkTaskFailedOptions {
  actorType?: 'agent' | 'system';
  actorId?: string | null;
  completedAt?: string | null;
  executionStep?: string | null;
}

/**
 * Marks a non-terminal task as failed and records its observed prior status.
 * The reason is stored as both the task error message and the event reason.
 *
 * The terminal-state exclusion lives in the UPDATE predicate so a concurrent
 * completion or cancellation that lands after the status read wins atomically.
 * Returns true when this call performed the transition.
 */
export async function markTaskFailedIfNonTerminal(
  database: D1Database,
  taskId: string,
  reason: string,
  eventContext?: MarkTaskFailedEventContext,
  options: MarkTaskFailedOptions = {}
): Promise<boolean> {
  const failedAt = new Date().toISOString();
  const actorType = options.actorType ?? 'system';
  const actorId = options.actorId ?? null;
  const results = await database.batch([
    database.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId),
    database
      .prepare(
        `INSERT INTO task_status_events
         (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, id, status, 'failed', ?, ?, ?, ? FROM tasks
         WHERE id = ? AND ${taskStatusIsNonTerminalSql()}`
      )
      .bind(
        ulid(),
        actorType,
        actorId,
        reason,
        failedAt,
        taskId,
        ...TERMINAL_STATUS_VALUES
      ),
    database
      .prepare(
        `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ?,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
           execution_step = CASE WHEN ? = 1 THEN ? ELSE execution_step END
         WHERE id = ? AND ${taskStatusIsNonTerminalSql()}`
      )
      .bind(
        reason,
        failedAt,
        options.completedAt !== undefined ? 1 : 0,
        options.completedAt ?? null,
        options.executionStep !== undefined ? 1 : 0,
        options.executionStep ?? null,
        taskId,
        ...TERMINAL_STATUS_VALUES
      ),
  ]);
  const observedStatus = (results[0]?.results[0] as { status?: unknown } | undefined)?.status;
  if (!isTaskStatus(observedStatus) || !(results[2]?.meta.changes ?? 0)) return false;
  if (eventContext) {
    await recordTaskLifecycleEventBestEffort(eventContext.env, {
      projectId: eventContext.projectId,
      taskId,
      status: 'failed',
      fromStatus: observedStatus,
      workspaceId: eventContext.workspaceId,
      sessionId: eventContext.sessionId,
      nodeId: eventContext.nodeId,
      actorType,
      actorId,
      reason,
      source: eventContext.source,
      occurredAt: failedAt,
    });
  }
  return true;
}
