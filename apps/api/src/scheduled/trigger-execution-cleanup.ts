/**
 * Trigger Execution Cleanup — recovers stale executions and purges old logs.
 *
 * Three responsibilities:
 * 1. **Stale running recovery**: Finds `trigger_executions` stuck in 'running' past a
 *    configurable age, reads linked task liveness, and terminalizes only missing,
 *    terminal-unsynced, or hard-residence-expired rows. A non-terminal linked task is
 *    preserved at the normal stale threshold.
 *
 * 2. **Stale queued recovery**: Finds `trigger_executions` stuck in 'queued' past a
 *    configurable timeout (default: 5 min), while preserving rows whose linked task is
 *    still non-terminal.
 *
 * 3. **Retention purge**: Deletes old completed/failed/skipped execution records
 *    past the configurable retention period, preventing unbounded table growth.
 *    Uses `created_at` intentionally — a record created 90+ days ago should be
 *    purged regardless of when it was completed (including stale records just
 *    recovered by the sweep above).
 *
 * Called from the cron handler alongside node cleanup and stuck-task recovery.
 */
import {
  DEFAULT_TRIGGER_EXECUTION_HARD_MAX_RESIDENCE_HOURS,
  DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
  DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
  DEFAULT_TRIGGER_STALE_QUEUED_TIMEOUT_MS,
  TASK_TERMINAL_STATUSES,
  TRIGGER_EXECUTION_HARD_MAX_FAILURE_PREFIX,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { reconcileStaleWebhookDeliveries } from '../services/webhook-delivery-reconciliation';
import { purgeExpiredWebhookDeliveries } from '../services/webhook-trigger-store';

const log = createModuleLogger('trigger-execution-cleanup');

/** Default batch size for stale execution recovery per sweep. */
const DEFAULT_TRIGGER_STALE_RECOVERY_BATCH_SIZE = 100;
const MS_PER_HOUR = 60 * 60 * 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface TriggerExecutionCleanupStats {
  /** Number of stale running executions reconciled to a terminal execution status */
  staleRecovered: number;
  /** Number of stale queued executions reconciled to a terminal execution status */
  staleQueuedRecovered: number;
  /** Number of old execution logs purged */
  retentionPurged: number;
  /** Number of expired generic webhook delivery records purged */
  webhookDeliveriesPurged: number;
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
const TERMINAL_TASK_STATUSES = new Set<string>(TASK_TERMINAL_STATUSES);

interface ExecutionRecoveryAction {
  exec: StaleExecution;
  toStatus: 'completed' | 'failed';
  errorMessage: string | null;
}

/**
 * Build the status update for a stale execution after reading the linked task row.
 *
 * Rule 58: the normal stale-threshold verdict mirrors the task terminal record that
 * `syncTriggerExecutionStatus()` reads. A non-terminal task is still the execution
 * owner, so wall-clock age alone is inconclusive and the execution remains active.
 *
 * Rule 47: the hard residence bound is a separate backstop. Admission and incident
 * dispatch reclaim also read task liveness, so this backstop cannot by itself admit
 * a colliding sibling or release a live incident task's lease.
 */
function buildRecoveryAction(
  exec: StaleExecution,
  taskMap: Map<string, TaskRow>,
  options: { hardMaxCutoff: string; hardMaxHours: number }
): ExecutionRecoveryAction | null {
  if (!exec.task_id) {
    return {
      exec,
      toStatus: 'failed',
      errorMessage: 'Task was never created (submission failed)',
    };
  }

  const task = taskMap.get(exec.task_id);
  if (!task) {
    return {
      exec,
      toStatus: 'failed',
      errorMessage: `Linked task ${exec.task_id} was deleted`,
    };
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return {
      exec,
      toStatus: task.status === 'completed' ? 'completed' : 'failed',
      errorMessage:
        task.status === 'completed'
          ? null
          : `Linked task ${exec.task_id} is ${task.status} (sync missed)`,
    };
  }

  if (exec.created_at <= options.hardMaxCutoff) {
    return {
      exec,
      toStatus: 'failed',
      errorMessage: `${TRIGGER_EXECUTION_HARD_MAX_FAILURE_PREFIX} of ${options.hardMaxHours} hours while linked task ${exec.task_id} remained ${task.status}; task liveness still controls trigger admission and incident dispatch lease ownership until the task terminalizes.`,
    };
  }

  log.info('stale_execution_preserved_live_task', {
    executionId: exec.id,
    triggerId: exec.trigger_id,
    taskId: exec.task_id,
    taskStatus: task.status,
    createdAt: exec.created_at,
    startedAt: exec.started_at,
    hardMaxHours: options.hardMaxHours,
  });
  return null;
}

/**
 * Recover trigger executions stuck in a given status past the stale threshold.
 *
 * Uses batched queries to avoid N+1 round-trips:
 * 1. Single SELECT with LIMIT to fetch stale executions
 * 2. Single SELECT with IN(...) to batch-fetch all linked task statuses
 * 3. Single db.batch() to issue all UPDATE statements together
 */
async function recoverStaleExecutionsByStatus(
  db: D1Database,
  status: 'running' | 'queued',
  staleThresholdMs: number,
  hardMaxResidenceHours: number,
  batchSize: number
): Promise<{ recovered: number; errors: number }> {
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
  const hardMaxCutoff = new Date(Date.now() - hardMaxResidenceHours * MS_PER_HOUR).toISOString();

  // Step 1: Find stale executions (bounded by LIMIT).
  // Use COALESCE to handle cases where started_at was never set (submission failure).
  let staleRows: { results: StaleExecution[] };
  try {
    staleRows = await db
      .prepare(
        `SELECT id, trigger_id, task_id, started_at, created_at
         FROM trigger_executions
         WHERE status = ?
           AND COALESCE(started_at, created_at) <= ?
           AND NOT EXISTS (
             SELECT 1 FROM webhook_deliveries d
              WHERE d.execution_id = trigger_executions.id AND d.outcome = 'processing'
           )
         LIMIT ?`
      )
      .bind(status, cutoff, batchSize)
      .all<StaleExecution>();
  } catch (err) {
    log.error('stale_execution_query_failed', {
      status,
      error: err instanceof Error ? err.message : String(err),
    });
    return { recovered: 0, errors: 1 };
  }

  if (!staleRows.results.length) {
    return { recovered: 0, errors: 0 };
  }

  log.info('stale_executions_found', { status, count: staleRows.results.length });

  // Step 2: Batch-fetch all linked task statuses in a single query.
  const taskIds = [
    ...new Set(staleRows.results.map((e) => e.task_id).filter((id): id is string => id !== null)),
  ];

  const taskMap = new Map<string, TaskRow>();
  let taskLookupFailed = false;
  let errors = 0;
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
      // Rule 58: a failed liveness lookup withholds the destructive verdict for
      // linked task rows. Rows with no task_id still have no owner and can be
      // recovered without this lookup.
      taskLookupFailed = true;
      errors += 1;
    }
  }

  // Step 3: Build UPDATE statements and execute as a batch.
  const now = new Date().toISOString();
  let recovered = 0;

  const updateStatements: D1PreparedStatement[] = [];
  const actions: ExecutionRecoveryAction[] = [];

  for (const exec of staleRows.results) {
    if (taskLookupFailed && exec.task_id) {
      log.info('stale_execution_preserved_task_lookup_failed', {
        executionId: exec.id,
        triggerId: exec.trigger_id,
        taskId: exec.task_id,
        status,
      });
      continue;
    }
    const action =
      status === 'queued' && !exec.task_id
        ? {
            exec,
            toStatus: 'failed' as const,
            errorMessage: 'Queued execution never started (submission failed or timed out)',
          }
        : buildRecoveryAction(exec, taskMap, {
            hardMaxCutoff,
            hardMaxHours: hardMaxResidenceHours,
          });
    if (!action) continue;
    actions.push(action);
    updateStatements.push(
      db
        .prepare(
          `UPDATE trigger_executions
           SET status = ?, error_message = ?, completed_at = ?
           WHERE id = ? AND status = ?
             AND NOT EXISTS (
               SELECT 1 FROM webhook_deliveries d
                WHERE d.execution_id = trigger_executions.id AND d.outcome = 'processing'
             )`
        )
        .bind(action.toStatus, action.errorMessage, now, exec.id, status)
    );
  }

  if (updateStatements.length === 0) {
    return { recovered: 0, errors };
  }

  try {
    const results = await db.batch<Record<string, unknown>>(updateStatements);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const entry = actions[i];
      if (!result || !entry) continue;
      if (result.meta.changes && result.meta.changes > 0) {
        recovered++;
        log.info('stale_execution_recovered', {
          executionId: entry.exec.id,
          triggerId: entry.exec.trigger_id,
          taskId: entry.exec.task_id,
          originalStatus: status,
          recoveredStatus: entry.toStatus,
          reason: entry.errorMessage,
        });
      }
    }
  } catch (err) {
    errors += actions.length;
    log.error('stale_execution_batch_update_failed', {
      status,
      count: actions.length,
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
  retentionDays: number
): Promise<{ purged: number; errors: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const result = await db
      .prepare(
        `DELETE FROM trigger_executions
         WHERE status IN ('completed', 'failed', 'skipped')
           AND created_at <= ?`
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
export async function runTriggerExecutionCleanup(env: Env): Promise<TriggerExecutionCleanupStats> {
  // Kill switch
  if (env.TRIGGER_EXECUTION_CLEANUP_ENABLED === 'false') {
    return {
      staleRecovered: 0,
      staleQueuedRecovered: 0,
      retentionPurged: 0,
      webhookDeliveriesPurged: 0,
      errors: 0,
    };
  }

  const staleRunningThresholdMs = parsePositiveInt(
    env.TRIGGER_STALE_EXECUTION_TIMEOUT_MS,
    DEFAULT_TRIGGER_STALE_EXECUTION_TIMEOUT_MS
  );
  const staleQueuedThresholdMs = parsePositiveInt(
    env.TRIGGER_STALE_QUEUED_TIMEOUT_MS,
    DEFAULT_TRIGGER_STALE_QUEUED_TIMEOUT_MS
  );
  const hardMaxResidenceHours = parsePositiveInt(
    env.TRIGGER_EXECUTION_HARD_MAX_RESIDENCE_HOURS,
    DEFAULT_TRIGGER_EXECUTION_HARD_MAX_RESIDENCE_HOURS
  );
  const retentionDays = parsePositiveInt(
    env.TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
    DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS
  );
  const batchSize = parsePositiveInt(
    env.TRIGGER_STALE_RECOVERY_BATCH_SIZE,
    DEFAULT_TRIGGER_STALE_RECOVERY_BATCH_SIZE
  );

  let webhookCleanupErrors = 0;
  try {
    const reconciled = await reconcileStaleWebhookDeliveries(env);
    if (reconciled > 0) log.info('webhook_deliveries_reconciled', { count: reconciled });
  } catch (error) {
    webhookCleanupErrors += 1;
    log.error('webhook_delivery_reconciliation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const staleRunning = await recoverStaleExecutionsByStatus(
    env.DATABASE,
    'running',
    staleRunningThresholdMs,
    hardMaxResidenceHours,
    batchSize
  );
  const staleQueued = await recoverStaleExecutionsByStatus(
    env.DATABASE,
    'queued',
    staleQueuedThresholdMs,
    hardMaxResidenceHours,
    batchSize
  );
  const retention = await purgeOldTriggerExecutions(env.DATABASE, retentionDays);
  let webhookDeliveriesPurged = 0;
  try {
    webhookDeliveriesPurged = await purgeExpiredWebhookDeliveries(env);
  } catch (error) {
    webhookCleanupErrors += 1;
    log.error('webhook_delivery_purge_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    staleRecovered: staleRunning.recovered,
    staleQueuedRecovered: staleQueued.recovered,
    retentionPurged: retention.purged,
    webhookDeliveriesPurged,
    errors: staleRunning.errors + staleQueued.errors + retention.errors + webhookCleanupErrors,
  };
}
