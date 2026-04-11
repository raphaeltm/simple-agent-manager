/**
 * Trigger Execution Cleanup — recovers stale executions and purges old logs.
 *
 * Two responsibilities:
 * 1. **Stale recovery**: Finds `trigger_executions` stuck in 'running' past a
 *    configurable timeout and transitions them to 'failed' with a descriptive reason.
 *    Handles: task deleted, task in terminal state (sync missed), task stuck in
 *    non-terminal state, and no task linked (submission failure).
 *
 * 2. **Retention purge**: Deletes old completed/failed/skipped execution records
 *    past the configurable retention period, preventing unbounded table growth.
 *
 * Called from the cron handler alongside node cleanup and stuck-task recovery.
 */
import {
  DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
  DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../index';
import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('trigger-execution-cleanup');

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseDays(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface TriggerExecutionCleanupStats {
  /** Number of stale running executions recovered to 'failed' */
  staleRecovered: number;
  /** Number of old execution logs purged */
  retentionPurged: number;
  /** Number of errors encountered */
  errors: number;
}

interface StaleExecution {
  id: string;
  trigger_id: string;
  task_id: string | null;
  started_at: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  status: string;
}

/** Terminal task statuses — if a task is in one of these states, the execution should not be 'running'. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Recover trigger executions stuck in 'running' past the stale threshold.
 *
 * For each stale execution, checks the linked task's status:
 * - Task deleted: marks execution as failed ("Linked task was deleted")
 * - Task in terminal state: marks as failed ("Linked task is <status> (sync missed)")
 * - Task in non-terminal state: marks as failed ("Linked task stuck in '<status>' past stale threshold")
 * - No task linked: marks as failed ("Task was never created (submission failed)")
 */
async function recoverStaleTriggerExecutions(
  db: D1Database,
  staleThresholdMs: number,
): Promise<{ recovered: number; errors: number }> {
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
  let recovered = 0;
  let errors = 0;

  // Find all running executions older than the stale threshold.
  // Use COALESCE to handle cases where started_at was never set (submission failure).
  let staleRows: { results: StaleExecution[] };
  try {
    staleRows = await db
      .prepare(
        `SELECT id, trigger_id, task_id, started_at, created_at
         FROM trigger_executions
         WHERE status = 'running'
           AND COALESCE(started_at, created_at) <= ?`,
      )
      .bind(cutoff)
      .all<StaleExecution>();
  } catch (err) {
    log.error('stale_execution_query_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { recovered: 0, errors: 1 };
  }

  if (!staleRows.results.length) {
    return { recovered: 0, errors: 0 };
  }

  log.info('stale_executions_found', { count: staleRows.results.length });

  for (const exec of staleRows.results) {
    try {
      let reason: string;

      if (!exec.task_id) {
        // No task was ever linked — submission failed before task creation
        reason = 'Task was never created (submission failed)';
      } else {
        // Check if the linked task still exists
        const task = await db
          .prepare('SELECT id, status FROM tasks WHERE id = ?')
          .bind(exec.task_id)
          .first<TaskRow>();

        if (!task) {
          reason = `Linked task ${exec.task_id} was deleted`;
        } else if (TERMINAL_TASK_STATUSES.has(task.status)) {
          reason = `Linked task ${exec.task_id} is ${task.status} (sync missed)`;
        } else {
          reason = `Linked task ${exec.task_id} stuck in '${task.status}' past stale threshold`;
        }
      }

      const now = new Date().toISOString();
      const result = await db
        .prepare(
          `UPDATE trigger_executions
           SET status = 'failed', error_message = ?, completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(reason, now, exec.id)
        .run();

      if (result.meta.changes && result.meta.changes > 0) {
        recovered++;
        log.info('stale_execution_recovered', {
          executionId: exec.id,
          triggerId: exec.trigger_id,
          taskId: exec.task_id,
          reason,
        });
      }
    } catch (err) {
      errors++;
      log.error('stale_execution_recovery_failed', {
        executionId: exec.id,
        triggerId: exec.trigger_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { recovered, errors };
}

/**
 * Purge old trigger execution logs past the retention period.
 * Only deletes executions in terminal states (completed, failed, skipped).
 */
async function purgeOldTriggerExecutions(
  db: D1Database,
  retentionDays: number,
): Promise<{ purged: number; errors: number }> {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  try {
    const result = await db
      .prepare(
        `DELETE FROM trigger_executions
         WHERE status IN ('completed', 'failed', 'skipped')
           AND created_at <= ?`,
      )
      .bind(cutoff)
      .run();

    const purged = result.meta.changes ?? 0;
    if (purged > 0) {
      log.info('retention_purge_completed', { purged, retentionDays, cutoff });
    }
    return { purged, errors: 0 };
  } catch (err) {
    log.error('retention_purge_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { purged: 0, errors: 1 };
  }
}

/**
 * Run the full trigger execution cleanup sweep.
 *
 * @param env - Worker environment bindings
 * @returns Stats about recovered stale executions and purged logs
 */
export async function runTriggerExecutionCleanup(
  env: Env,
): Promise<TriggerExecutionCleanupStats> {
  // Kill switch
  if (env.TRIGGER_EXECUTION_CLEANUP_ENABLED === 'false') {
    return { staleRecovered: 0, retentionPurged: 0, errors: 0 };
  }

  const staleThresholdMs = parseMs(
    env.TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
    DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
  );
  const retentionDays = parseDays(
    env.TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
    DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
  );

  const stale = await recoverStaleTriggerExecutions(
    env.DATABASE,
    staleThresholdMs,
  );
  const retention = await purgeOldTriggerExecutions(
    env.DATABASE,
    retentionDays,
  );

  return {
    staleRecovered: stale.recovered,
    retentionPurged: retention.purged,
    errors: stale.errors + retention.errors,
  };
}
