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
 *    Uses `created_at` intentionally — a record created 90+ days ago should be
 *    purged regardless of when it was completed (including stale records just
 *    recovered by the sweep above).
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

/** Default batch size for stale execution recovery per sweep. */
const DEFAULT_TRIGGER_STALE_RECOVERY_BATCH_SIZE = 100;

function parsePositiveInt(value: string | undefined, fallback: number): number {
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
 * Build the reason string for why a stale execution is being recovered.
 */
function buildRecoveryReason(
  exec: StaleExecution,
  taskMap: Map<string, TaskRow>,
): string {
  if (!exec.task_id) {
    return 'Task was never created (submission failed)';
  }

  const task = taskMap.get(exec.task_id);
  if (!task) {
    return `Linked task ${exec.task_id} was deleted`;
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return `Linked task ${exec.task_id} is ${task.status} (sync missed)`;
  }
  return `Linked task ${exec.task_id} stuck in '${task.status}' past stale threshold`;
}

/**
 * Recover trigger executions stuck in 'running' past the stale threshold.
 *
 * Uses batched queries to avoid N+1 round-trips:
 * 1. Single SELECT with LIMIT to fetch stale executions
 * 2. Single SELECT with IN(...) to batch-fetch all linked task statuses
 * 3. Single db.batch() to issue all UPDATE statements together
 */
async function recoverStaleTriggerExecutions(
  db: D1Database,
  staleThresholdMs: number,
  batchSize: number,
): Promise<{ recovered: number; errors: number }> {
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();

  // Step 1: Find stale running executions (bounded by LIMIT).
  // Use COALESCE to handle cases where started_at was never set (submission failure).
  let staleRows: { results: StaleExecution[] };
  try {
    staleRows = await db
      .prepare(
        `SELECT id, trigger_id, task_id, started_at, created_at
         FROM trigger_executions
         WHERE status = 'running'
           AND COALESCE(started_at, created_at) <= ?
         LIMIT ?`,
      )
      .bind(cutoff, batchSize)
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

  // Step 2: Batch-fetch all linked task statuses in a single query.
  const taskIds = [
    ...new Set(
      staleRows.results
        .map((e) => e.task_id)
        .filter((id): id is string => id !== null),
    ),
  ];

  const taskMap = new Map<string, TaskRow>();
  if (taskIds.length > 0) {
    try {
      const placeholders = taskIds.map(() => '?').join(', ');
      const taskRows = await db
        .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`)
        .bind(...taskIds)
        .all<TaskRow>();
      for (const row of taskRows.results) {
        taskMap.set(row.id, row);
      }
    } catch (err) {
      log.error('task_batch_lookup_failed', {
        taskIds,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through — missing tasks will be treated as "deleted"
    }
  }

  // Step 3: Build UPDATE statements and execute as a batch.
  const now = new Date().toISOString();
  let recovered = 0;
  let errors = 0;

  const updateStatements: D1PreparedStatement[] = [];
  const execReasons: { exec: StaleExecution; reason: string }[] = [];

  for (const exec of staleRows.results) {
    const reason = buildRecoveryReason(exec, taskMap);
    execReasons.push({ exec, reason });
    updateStatements.push(
      db
        .prepare(
          `UPDATE trigger_executions
           SET status = 'failed', error_message = ?, completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(reason, now, exec.id),
    );
  }

  try {
    const results = await db.batch<Record<string, unknown>>(updateStatements);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const entry = execReasons[i];
      if (!result || !entry) continue;
      if (result.meta.changes && result.meta.changes > 0) {
        recovered++;
        log.info('stale_execution_recovered', {
          executionId: entry.exec.id,
          triggerId: entry.exec.trigger_id,
          taskId: entry.exec.task_id,
          reason: entry.reason,
        });
      }
    }
  } catch (err) {
    errors = staleRows.results.length;
    log.error('stale_execution_batch_update_failed', {
      count: staleRows.results.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { recovered, errors };
}

/**
 * Purge old trigger execution logs past the retention period.
 * Only deletes executions in terminal states (completed, failed, skipped).
 *
 * Uses `created_at` intentionally: a record created 90+ days ago should be
 * purged regardless of when it reached a terminal state. This keeps the
 * purge logic simple and predictable — records are always purged after
 * a fixed window from creation.
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

  const staleThresholdMs = parsePositiveInt(
    env.TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
    DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
  );
  const retentionDays = parsePositiveInt(
    env.TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
    DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
  );
  const batchSize = parsePositiveInt(
    env.TRIGGER_STALE_RECOVERY_BATCH_SIZE,
    DEFAULT_TRIGGER_STALE_RECOVERY_BATCH_SIZE,
  );

  const stale = await recoverStaleTriggerExecutions(
    env.DATABASE,
    staleThresholdMs,
    batchSize,
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
