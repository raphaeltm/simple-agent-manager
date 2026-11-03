/**
 * Daily retention for Operations telemetry: node lifecycle decisions, black box node log
 * captures (R2 object + index row) and sleep/wake step traces.
 *
 * Runs from the `0 3 * * *` cron beside the Operations audit purge (policy b0950dd6: storage
 * cleanup is at most daily). Each store is purged in bounded batches and isolated from the
 * others, so one failing purge cannot stop the rest (rule 53).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  DEFAULT_NODE_DECISION_PURGE_BATCH,
  purgeNodeLifecycleDecisions,
} from '../services/node-lifecycle-decisions';
import {
  DEFAULT_NODE_LOG_CAPTURE_PURGE_BATCH,
  purgeExpiredNodeLogCaptures,
} from '../services/node-log-capture-read';
import { resolveOperationsTelemetrySetting } from '../services/operations-telemetry-settings';
import {
  DEFAULT_SNAPSHOT_TRACE_PURGE_BATCH,
  purgeSessionSnapshotTraces,
} from '../services/session-snapshot-traces';

/** Bounded work per run; a backlog drains over successive daily runs. */
export const OPERATIONS_TELEMETRY_RETENTION_MAX_BATCHES = 20;

export interface OperationsTelemetryRetentionResult {
  /** `null` means that store's purge failed, never "nothing to purge". */
  decisionsDeleted: number | null;
  capturesDeleted: number | null;
  tracesDeleted: number | null;
}

/** Repeat a batch purge until a batch comes back short or the batch budget is spent. */
async function drain(purge: () => Promise<number>, batchSize: number): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < OPERATIONS_TELEMETRY_RETENTION_MAX_BATCHES; batch++) {
    const deleted = await purge();
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

async function isolated(name: string, run: () => Promise<number>): Promise<number | null> {
  try {
    return await run();
  } catch (error) {
    log.error('operations_telemetry_retention.purge_failed', {
      store: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function runOperationsTelemetryRetention(
  env: Env,
  cron: string,
  now: Date = new Date()
): Promise<OperationsTelemetryRetentionResult> {
  const [decisionDays, traceDays] = await Promise.all([
    resolveOperationsTelemetrySetting(env, 'nodeDecisionLogRetentionDays'),
    resolveOperationsTelemetrySetting(env, 'snapshotTraceRetentionDays'),
  ]);
  const result: OperationsTelemetryRetentionResult = {
    decisionsDeleted: await isolated('node_lifecycle_decisions', () =>
      drain(
        () => purgeNodeLifecycleDecisions(env.DATABASE, decisionDays, now),
        DEFAULT_NODE_DECISION_PURGE_BATCH
      )
    ),
    capturesDeleted: await isolated('node_log_captures', () =>
      drain(() => purgeExpiredNodeLogCaptures(env, now), DEFAULT_NODE_LOG_CAPTURE_PURGE_BATCH)
    ),
    tracesDeleted: await isolated('session_snapshot_traces', () =>
      drain(
        () => purgeSessionSnapshotTraces(env.DATABASE, traceDays, now),
        DEFAULT_SNAPSHOT_TRACE_PURGE_BATCH
      )
    ),
  };
  log.info('cron.completed', { cron, type: 'operations-telemetry-retention', ...result });
  return result;
}
