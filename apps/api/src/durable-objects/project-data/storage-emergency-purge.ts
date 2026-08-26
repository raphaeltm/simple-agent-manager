import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import type {
  ProjectDataStorageEmergencyPurgeInput,
  ProjectDataStorageEmergencyPurgeResult,
  ProjectDataStorageStatus,
  ProjectDataStorageTelemetry,
  StorageSafetyConfig,
} from './storage-safety';
import {
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import { upsertProjectDataStorageTelemetry } from './storage-telemetry';
import type { Env } from './types';

const log = createModuleLogger('project_data.storage_emergency_purge');

export interface ProjectDataStorageEmergencyPurgeCallbacks {
  classifyStatus: (
    databaseSizeBytes: number,
    config: StorageSafetyConfig
  ) => ProjectDataStorageStatus;
  buildTelemetry: (
    sql: SqlStorage,
    env: Env,
    projectId: string,
    measuredAt: number
  ) => Promise<ProjectDataStorageTelemetry>;
}

function normalizeCount(row: unknown): number {
  if (!isJsonRecord(row)) return 0;
  const count = (row as Record<string, unknown>).count;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

function countOldestActivityEventRows(sql: SqlStorage, limit: number): number {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS count
       FROM (SELECT id FROM activity_events ORDER BY created_at ASC LIMIT ?)`,
      limit
    )
    .toArray()[0];
  return normalizeCount(row);
}

function countOldestAcpSessionEventRows(sql: SqlStorage, limit: number): number {
  const row = sql
    .exec(
      `SELECT COUNT(*) AS count
       FROM (SELECT id FROM acp_session_events ORDER BY created_at ASC LIMIT ?)`,
      limit
    )
    .toArray()[0];
  return normalizeCount(row);
}

function countOldestRows(
  sql: SqlStorage,
  table: 'activity_events' | 'acp_session_events',
  limit: number
): number {
  if (table === 'activity_events') {
    return countOldestActivityEventRows(sql, limit);
  }
  return countOldestAcpSessionEventRows(sql, limit);
}

function deleteOldestActivityEventRows(sql: SqlStorage, limit: number): void {
  sql.exec(
    `DELETE FROM activity_events
     WHERE id IN (
       SELECT id FROM activity_events
       ORDER BY created_at ASC
       LIMIT ?
     )`,
    limit
  );
}

function deleteOldestAcpSessionEventRows(sql: SqlStorage, limit: number): void {
  sql.exec(
    `DELETE FROM acp_session_events
     WHERE id IN (
       SELECT id FROM acp_session_events
       ORDER BY created_at ASC
       LIMIT ?
     )`,
    limit
  );
}

function deleteOldestRows(
  sql: SqlStorage,
  table: 'activity_events' | 'acp_session_events',
  limit: number
): number {
  const candidateCount = countOldestRows(sql, table, limit);
  if (candidateCount <= 0) return 0;

  if (table === 'activity_events') {
    deleteOldestActivityEventRows(sql, limit);
  } else {
    deleteOldestAcpSessionEventRows(sql, limit);
  }

  return candidateCount;
}

export async function runProjectDataStorageEmergencyPurgeCore(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  input: ProjectDataStorageEmergencyPurgeInput,
  config: StorageSafetyConfig,
  callbacks: ProjectDataStorageEmergencyPurgeCallbacks
): Promise<ProjectDataStorageEmergencyPurgeResult> {
  if (!projectId) {
    throw new Error('ProjectData storage purge requires a persisted projectId');
  }

  const targetRatio =
    input.targetRatio && input.targetRatio > 0 && input.targetRatio < 1
      ? input.targetRatio
      : config.emergencyTargetRatio;
  const batchRows =
    input.batchRows && Number.isSafeInteger(input.batchRows) && input.batchRows > 0
      ? input.batchRows
      : config.emergencyBatchRows;
  const maxBatches =
    input.maxBatches && Number.isSafeInteger(input.maxBatches) && input.maxBatches > 0
      ? input.maxBatches
      : config.emergencyMaxBatches;
  const targetBytes = Math.floor(config.limitBytes * targetRatio);
  const reason = truncate(input.reason?.trim() || 'manual_emergency_purge', 500);
  const beforeBytes = sql.databaseSize;
  const statusBefore = callbacks.classifyStatus(beforeBytes, config);
  const rowsDeleted = { activityEvents: 0, acpSessionEvents: 0 };
  let batches = 0;
  let exhaustedCandidates = false;

  while (sql.databaseSize > targetBytes && batches < maxBatches) {
    const activityDeleted = deleteOldestRows(sql, 'activity_events', batchRows);
    const acpDeleted = deleteOldestRows(sql, 'acp_session_events', batchRows);
    rowsDeleted.activityEvents += activityDeleted;
    rowsDeleted.acpSessionEvents += acpDeleted;
    batches++;

    if (activityDeleted === 0 && acpDeleted === 0) {
      exhaustedCandidates = true;
      break;
    }
  }

  const afterBytes = sql.databaseSize;
  const statusAfter = callbacks.classifyStatus(afterBytes, config);
  const totalRowsDeleted = rowsDeleted.activityEvents + rowsDeleted.acpSessionEvents;
  const result: ProjectDataStorageEmergencyPurgeResult = {
    projectId,
    reason,
    beforeBytes,
    afterBytes,
    limitBytes: config.limitBytes,
    targetBytes,
    statusBefore,
    statusAfter,
    batches,
    maxBatches,
    batchRows,
    rowsDeleted,
    exhaustedCandidates,
  };

  const measuredAt = Date.now();
  const telemetry = await callbacks.buildTelemetry(sql, env, projectId, measuredAt);
  writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
  writeMeta(sql, META_LAST_STATUS, statusAfter);

  try {
    await upsertProjectDataStorageTelemetry(env, telemetry, {
      lastPurgeAt: measuredAt,
      lastPurgeReason: reason,
      lastPurgeRows: totalRowsDeleted,
      lastPurgeDatabaseSizeBytes: afterBytes,
      lastError: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    log.warn('purge_telemetry_upsert_failed', {
      projectId,
      ...serializeError(error),
    });
  }

  log.warn('completed', { ...result });
  return result;
}
