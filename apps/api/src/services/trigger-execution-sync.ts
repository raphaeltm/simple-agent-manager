/**
 * Syncs trigger execution status when a task reaches a terminal state.
 *
 * Multiple code paths transition tasks to terminal states (completed/failed/cancelled).
 * Each path MUST call this function to keep triggerExecutions in sync, otherwise
 * cron triggers with skipIfRunning=true will permanently stop firing.
 *
 * Best-effort: errors are logged but never propagated to the caller.
 */

import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('trigger-execution-sync');

/**
 * Sync trigger execution status for a task that has reached a terminal state.
 * Queries the task's triggerExecutionId and updates the corresponding execution row.
 *
 * @param db - D1 database instance
 * @param taskId - The task that reached a terminal state
 * @param toStatus - The terminal status: 'completed', 'failed', or 'cancelled'
 * @param errorMessage - Optional error message (used when toStatus is 'failed')
 */
export async function syncTriggerExecutionStatus(
  db: D1Database,
  taskId: string,
  toStatus: 'completed' | 'failed' | 'cancelled',
  errorMessage?: string,
): Promise<void> {
  try {
    // Look up the task's trigger execution link
    const task = await db
      .prepare('SELECT trigger_execution_id FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ trigger_execution_id: string | null }>();

    if (!task?.trigger_execution_id) {
      return; // Task is not linked to a trigger execution — nothing to sync
    }

    const execStatus = toStatus === 'completed' ? 'completed' : 'failed';
    const now = new Date().toISOString();

    await db
      .prepare(
        `UPDATE trigger_executions SET status = ?, completed_at = ?, error_message = ? WHERE id = ? AND status = 'running'`,
      )
      .bind(
        execStatus,
        now,
        toStatus === 'failed' ? (errorMessage?.trim() || 'Task failed') : null,
        task.trigger_execution_id,
      )
      .run();

    log.info('trigger_execution_synced', {
      taskId,
      triggerExecutionId: task.trigger_execution_id,
      execStatus,
    });
  } catch (err) {
    // Best-effort — never fail the parent operation
    log.error('trigger_execution_sync_failed', {
      taskId,
      toStatus,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
