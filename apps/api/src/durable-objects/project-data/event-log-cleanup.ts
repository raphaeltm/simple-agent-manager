import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import type {
  ProjectDataStorageStatus,
  ProjectDataStorageTelemetry,
  StorageSafetyConfig,
} from './storage-safety';
import {
  deleteStorageSafetyMeta as deleteMeta,
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  readStorageSafetyMetaNumber as readMetaNumber,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import type { Env } from './types';

const log = createModuleLogger('project_data.event_log_cleanup');

const META_EVENT_LOG_CLEANUP_RECHECK_AT = 'storageSafetyEventLogCleanupRecheckAt';

export interface ProjectDataEventLogCleanupResult {
  projectId: string;
  beforeBytes: number;
  afterBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  cutoffUpdatedAt: number;
  rowsDeleted: {
    activityEvents: number;
    acpSessionEvents: number;
  };
  candidateBytesDeleted: {
    activityEvents: number;
    acpSessionEvents: number;
  };
  exhaustedCandidates: boolean;
  recheckAt: number | null;
}

export interface ProjectDataEventLogCleanupOptions {
  allowStart?: boolean;
  now?: number;
  classifyStatus: (databaseSizeBytes: number) => ProjectDataStorageStatus;
  recordTelemetry: (
    telemetry: ProjectDataStorageTelemetry,
    fields: {
      lastPurgeAt?: number | null;
      lastPurgeReason?: string | null;
      lastPurgeRows?: number | null;
      lastPurgeDatabaseSizeBytes?: number | null;
      lastError?: string | null;
    }
  ) => Promise<void>;
}

type EventLogCleanupPlan = {
  projectId: string;
  now: number;
  beforeBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  cutoffUpdatedAt: number;
};

type EventLogCandidateSummary = {
  rows: number;
  bytes: number;
};

export function readProjectDataEventLogCleanupRecheckAt(sql: SqlStorage): number | null {
  return readMetaNumber(sql, META_EVENT_LOG_CLEANUP_RECHECK_AT);
}

function normalizeCount(row: unknown): number {
  if (!isJsonRecord(row)) return 0;
  const count = row.count;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

function normalizeCandidateSummary(row: unknown): EventLogCandidateSummary {
  if (!isJsonRecord(row)) return { rows: 0, bytes: 0 };
  const rows = row.rows;
  const bytes = row.bytes;
  return {
    rows: typeof rows === 'number' && Number.isFinite(rows) ? rows : 0,
    bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0,
  };
}

function writeEventLogCleanupRecheckAt(sql: SqlStorage, recheckAt: number): void {
  writeMeta(sql, META_EVENT_LOG_CLEANUP_RECHECK_AT, String(recheckAt));
}

function clearEventLogCleanupState(sql: SqlStorage): void {
  deleteMeta(sql, META_EVENT_LOG_CLEANUP_RECHECK_AT);
}

function createEventLogCleanupPlan(
  sql: SqlStorage,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: ProjectDataEventLogCleanupOptions
): EventLogCleanupPlan | null {
  if (!config.enabled || !config.eventLogCleanupEnabled || !projectId) return null;
  const now = options.now ?? Date.now();
  const beforeBytes = sql.databaseSize;
  const triggerBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTriggerRatio);
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const pendingRecheckAt = readProjectDataEventLogCleanupRecheckAt(sql);
  const hasPendingCleanup = pendingRecheckAt !== null;

  if (beforeBytes <= targetBytes) {
    clearEventLogCleanupState(sql);
    return null;
  }
  if (pendingRecheckAt !== null && pendingRecheckAt > now) {
    return null;
  }
  if (!hasPendingCleanup && !options.allowStart) {
    return null;
  }
  if (beforeBytes < triggerBytes && !hasPendingCleanup) {
    return null;
  }

  return {
    projectId,
    now,
    beforeBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    batchRows: config.eventLogCleanupBatchRows,
    cutoffUpdatedAt: now - config.eventLogCleanupMinSessionAgeMs,
  };
}

function summarizeActivityEventCandidates(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  limit: number
): EventLogCandidateSummary {
  return normalizeCandidateSummary(
    sql
      .exec(
        `SELECT
           COUNT(*) AS rows,
           COALESCE(SUM(length(CAST(COALESCE(payload, '') AS BLOB))), 0) AS bytes
         FROM (
           SELECT e.id, e.payload
           FROM activity_events e
           JOIN chat_sessions s ON s.id = e.session_id
           WHERE s.status IN ('stopped', 'failed')
             AND s.updated_at <= ?
           ORDER BY e.created_at ASC, e.id ASC
           LIMIT ?
         )`,
        cutoffUpdatedAt,
        limit
      )
      .toArray()[0]
  );
}

function summarizeAcpSessionEventCandidates(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  limit: number
): EventLogCandidateSummary {
  return normalizeCandidateSummary(
    sql
      .exec(
        `SELECT
           COUNT(*) AS rows,
           COALESCE(SUM(
             length(CAST(COALESCE(reason, '') AS BLOB))
             + length(CAST(COALESCE(metadata, '') AS BLOB))
           ), 0) AS bytes
         FROM (
           SELECT e.id, e.reason, e.metadata
           FROM acp_session_events e
           JOIN acp_sessions a ON a.id = e.acp_session_id
           JOIN chat_sessions s ON s.id = a.chat_session_id
           WHERE s.status IN ('stopped', 'failed')
             AND a.status IN ('completed', 'failed', 'interrupted')
             AND s.updated_at <= ?
           ORDER BY e.created_at ASC, e.id ASC
           LIMIT ?
         )`,
        cutoffUpdatedAt,
        limit
      )
      .toArray()[0]
  );
}

function deleteActivityEventCandidates(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  limit: number
): void {
  sql.exec(
    `DELETE FROM activity_events
     WHERE id IN (
       SELECT id
       FROM (
         SELECT e.id
         FROM activity_events e
         JOIN chat_sessions s ON s.id = e.session_id
         WHERE s.status IN ('stopped', 'failed')
           AND s.updated_at <= ?
         ORDER BY e.created_at ASC, e.id ASC
         LIMIT ?
       )
     )`,
    cutoffUpdatedAt,
    limit
  );
}

function deleteAcpSessionEventCandidates(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  limit: number
): void {
  sql.exec(
    `DELETE FROM acp_session_events
     WHERE id IN (
       SELECT id
       FROM (
         SELECT e.id
         FROM acp_session_events e
         JOIN acp_sessions a ON a.id = e.acp_session_id
         JOIN chat_sessions s ON s.id = a.chat_session_id
         WHERE s.status IN ('stopped', 'failed')
           AND a.status IN ('completed', 'failed', 'interrupted')
           AND s.updated_at <= ?
         ORDER BY e.created_at ASC, e.id ASC
         LIMIT ?
       )
     )`,
    cutoffUpdatedAt,
    limit
  );
}

function hasActivityEventCandidatesAfter(sql: SqlStorage, cutoffUpdatedAt: number): boolean {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT e.id
         FROM activity_events e
         JOIN chat_sessions s ON s.id = e.session_id
         WHERE s.status IN ('stopped', 'failed')
           AND s.updated_at <= ?
         LIMIT 1
       )`,
      cutoffUpdatedAt
    )
    .toArray()[0];
  return normalizeCount(row) > 0;
}

function hasAcpSessionEventCandidatesAfter(sql: SqlStorage, cutoffUpdatedAt: number): boolean {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT e.id
         FROM acp_session_events e
         JOIN acp_sessions a ON a.id = e.acp_session_id
         JOIN chat_sessions s ON s.id = a.chat_session_id
         WHERE s.status IN ('stopped', 'failed')
           AND a.status IN ('completed', 'failed', 'interrupted')
           AND s.updated_at <= ?
         LIMIT 1
       )`,
      cutoffUpdatedAt
    )
    .toArray()[0];
  return normalizeCount(row) > 0;
}

function deleteEventLogBatch(sql: SqlStorage, plan: EventLogCleanupPlan): {
  rowsDeleted: ProjectDataEventLogCleanupResult['rowsDeleted'];
  candidateBytesDeleted: ProjectDataEventLogCleanupResult['candidateBytesDeleted'];
} {
  const activity = summarizeActivityEventCandidates(sql, plan.cutoffUpdatedAt, plan.batchRows);
  const acp = summarizeAcpSessionEventCandidates(sql, plan.cutoffUpdatedAt, plan.batchRows);

  if (activity.rows > 0) {
    deleteActivityEventCandidates(sql, plan.cutoffUpdatedAt, plan.batchRows);
  }
  if (acp.rows > 0) {
    deleteAcpSessionEventCandidates(sql, plan.cutoffUpdatedAt, plan.batchRows);
  }

  return {
    rowsDeleted: {
      activityEvents: activity.rows,
      acpSessionEvents: acp.rows,
    },
    candidateBytesDeleted: {
      activityEvents: activity.bytes,
      acpSessionEvents: acp.bytes,
    },
  };
}

async function recordEventLogCleanupTelemetry(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  options: ProjectDataEventLogCleanupOptions,
  projectId: string,
  afterBytes: number,
  rowsDeleted: number,
  lastError: string | null
): Promise<void> {
  if (rowsDeleted <= 0 && !lastError) return;

  const measuredAt = Date.now();
  writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
  const statusAfter = options.classifyStatus(afterBytes);
  writeMeta(sql, META_LAST_STATUS, statusAfter);
  const telemetry: ProjectDataStorageTelemetry = {
    projectId,
    measuredAt,
    databaseSizeBytes: afterBytes,
    limitBytes: config.limitBytes,
    usageRatio: afterBytes / config.limitBytes,
    status: statusAfter,
    growthRateBytesPerDay: null,
    estimatedDaysToLimit: null,
    cleanupHealth: null,
    reclaimableBytes: null,
    categoryBreakdown: null,
  };

  try {
    await options.recordTelemetry(telemetry, {
      lastPurgeAt: rowsDeleted > 0 ? measuredAt : null,
      lastPurgeReason: rowsDeleted > 0 ? 'auto_terminal_event_log_cleanup' : null,
      lastPurgeRows: rowsDeleted > 0 ? rowsDeleted : null,
      lastPurgeDatabaseSizeBytes: rowsDeleted > 0 ? afterBytes : null,
      lastError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    log.warn('telemetry_upsert_failed', {
      projectId,
      ...serializeError(error),
    });
  }
}

function buildEventLogCleanupResult(
  plan: EventLogCleanupPlan,
  afterBytes: number,
  rowsDeleted: ProjectDataEventLogCleanupResult['rowsDeleted'],
  candidateBytesDeleted: ProjectDataEventLogCleanupResult['candidateBytesDeleted'],
  exhaustedCandidates: boolean,
  recheckAt: number | null
): ProjectDataEventLogCleanupResult {
  return {
    projectId: plan.projectId,
    beforeBytes: plan.beforeBytes,
    afterBytes,
    limitBytes: plan.limitBytes,
    triggerBytes: plan.triggerBytes,
    targetBytes: plan.targetBytes,
    batchRows: plan.batchRows,
    cutoffUpdatedAt: plan.cutoffUpdatedAt,
    rowsDeleted,
    candidateBytesDeleted,
    exhaustedCandidates,
    recheckAt,
  };
}

function shouldReturnEventLogCleanupResult(
  rowsDeleted: ProjectDataEventLogCleanupResult['rowsDeleted'],
  exhaustedCandidates: boolean,
  recheckAt: number | null
): boolean {
  return (
    rowsDeleted.activityEvents > 0 ||
    rowsDeleted.acpSessionEvents > 0 ||
    exhaustedCandidates ||
    recheckAt !== null
  );
}

async function handleEventLogCleanupFailure(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  options: ProjectDataEventLogCleanupOptions,
  plan: EventLogCleanupPlan,
  error: unknown
): Promise<ProjectDataEventLogCleanupResult> {
  const recheckAt = plan.now + config.eventLogCleanupRecheckMs;
  writeEventLogCleanupRecheckAt(sql, recheckAt);

  const message = truncate(error instanceof Error ? error.message : String(error), 500);
  writeMeta(sql, META_LAST_ERROR, message);
  log.warn('failed_retry_scheduled', {
    projectId: plan.projectId,
    recheckAt,
    ...serializeError(error),
  });

  await recordEventLogCleanupTelemetry(
    sql,
    config,
    options,
    plan.projectId,
    plan.beforeBytes,
    0,
    message
  );

  return buildEventLogCleanupResult(
    plan,
    plan.beforeBytes,
    { activityEvents: 0, acpSessionEvents: 0 },
    { activityEvents: 0, acpSessionEvents: 0 },
    false,
    recheckAt
  );
}

export async function runProjectDataEventLogCleanup(
  sql: SqlStorage,
  _env: Env,
  projectId: string | null,
  config: StorageSafetyConfig,
  options: ProjectDataEventLogCleanupOptions
): Promise<ProjectDataEventLogCleanupResult | null> {
  const plan = createEventLogCleanupPlan(sql, projectId, config, options);
  if (!plan) return null;

  let rowsDeleted: ProjectDataEventLogCleanupResult['rowsDeleted'];
  let candidateBytesDeleted: ProjectDataEventLogCleanupResult['candidateBytesDeleted'];
  try {
    const batch = deleteEventLogBatch(sql, plan);
    rowsDeleted = batch.rowsDeleted;
    candidateBytesDeleted = batch.candidateBytesDeleted;
  } catch (error) {
    return handleEventLogCleanupFailure(sql, config, options, plan, error);
  }

  const afterBytes = sql.databaseSize;
  const hasMoreCandidates =
    afterBytes > plan.targetBytes &&
    (hasActivityEventCandidatesAfter(sql, plan.cutoffUpdatedAt) ||
      hasAcpSessionEventCandidatesAfter(sql, plan.cutoffUpdatedAt));
  const recheckAt = hasMoreCandidates ? plan.now + config.eventLogCleanupRecheckMs : null;
  if (recheckAt !== null) {
    writeEventLogCleanupRecheckAt(sql, recheckAt);
  } else {
    clearEventLogCleanupState(sql);
  }

  const totalRowsDeleted = rowsDeleted.activityEvents + rowsDeleted.acpSessionEvents;
  const exhaustedCandidates = afterBytes > plan.targetBytes && recheckAt === null;
  const result = buildEventLogCleanupResult(
    plan,
    afterBytes,
    rowsDeleted,
    candidateBytesDeleted,
    exhaustedCandidates,
    recheckAt
  );

  await recordEventLogCleanupTelemetry(
    sql,
    config,
    options,
    plan.projectId,
    afterBytes,
    totalRowsDeleted,
    null
  );
  if (totalRowsDeleted > 0 || exhaustedCandidates) {
    log.warn('completed', { ...result });
  }

  return shouldReturnEventLogCleanupResult(rowsDeleted, exhaustedCandidates, recheckAt)
    ? result
    : null;
}
