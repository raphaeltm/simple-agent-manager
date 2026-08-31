import { createModuleLogger, serializeError } from '../../lib/logger';
import {
  type ProjectDataEventLogCleanupResult,
  readProjectDataEventLogCleanupRecheckAt,
  runProjectDataEventLogCleanup,
} from './event-log-cleanup';
import {
  type ProjectDataGroupedFtsCleanupResult,
  readProjectDataGroupedFtsCleanupRecheckAt,
  runProjectDataGroupedFtsCleanup,
} from './grouped-fts-cleanup';
import type { ProjectDataStorageCleanupHealth } from './storage-category-telemetry';
import type {
  ProjectDataStorageAlarmResult,
  ProjectDataStorageStatus,
  ProjectDataStorageTelemetry,
  StorageSafetyConfig,
} from './storage-safety';
import {
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  readStorageSafetyMeta as readMeta,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import {
  enrichProjectDataStorageTelemetry,
  maybePersistProjectDataStorageAlert,
  type ProjectDataStorageTelemetryEnrichmentOptions,
  STORAGE_ALERT_REASON_CLEANUP_TARGET_UNREACHABLE,
  upsertProjectDataStorageTelemetry,
} from './storage-telemetry';
import {
  type ProjectDataToolPayloadCleanupResult,
  readProjectDataToolPayloadCleanupRecheckAt,
  runProjectDataToolPayloadCleanup,
} from './tool-payload-cleanup';
import type { Env } from './types';

const log = createModuleLogger('project_data.storage_alarm');

export interface ProjectDataStorageAlarmCallbacks {
  transactionSync?: <T>(callback: () => T) => T;
  shouldMeasure: (sql: SqlStorage, env: Env, now: number) => boolean;
  measureAndPersist: (
    sql: SqlStorage,
    env: Env,
    projectId: string | null,
    reason: 'alarm'
  ) => Promise<ProjectDataStorageTelemetry | null>;
  classifyStatus: (
    databaseSizeBytes: number,
    config: StorageSafetyConfig
  ) => ProjectDataStorageStatus;
  buildTelemetry: (
    sql: SqlStorage,
    env: Env,
    projectId: string,
    measuredAt: number,
    cleanupHealth: ProjectDataStorageCleanupHealth | null,
    options?: ProjectDataStorageTelemetryEnrichmentOptions
  ) => Promise<ProjectDataStorageTelemetry>;
}

function hasPendingCleanup(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null,
  now: number
): boolean {
  const toolRecheckAt = cleanup?.recheckAt ?? readProjectDataToolPayloadCleanupRecheckAt(sql);
  const groupedFtsRecheckAt =
    groupedFtsCleanup?.recheckAt ?? readProjectDataGroupedFtsCleanupRecheckAt(sql);
  const eventLogRecheckAt =
    eventLogCleanup?.recheckAt ?? readProjectDataEventLogCleanupRecheckAt(sql);
  const hasToolCleanupPending =
    config.toolPayloadCleanupEnabled && toolRecheckAt !== null && toolRecheckAt > now;
  const hasGroupedFtsCleanupPending =
    config.groupedFtsCleanupEnabled && groupedFtsRecheckAt !== null && groupedFtsRecheckAt > now;
  const hasEventLogCleanupPending =
    config.eventLogCleanupEnabled && eventLogRecheckAt !== null && eventLogRecheckAt > now;
  return hasToolCleanupPending || hasGroupedFtsCleanupPending || hasEventLogCleanupPending;
}

function cleanupAttempted(
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): boolean {
  return cleanup !== null || groupedFtsCleanup !== null || eventLogCleanup !== null;
}

function cleanupCandidatesExhausted(
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): boolean {
  const toolCleanupExhausted =
    !config.toolPayloadCleanupEnabled || cleanup === null || cleanup.exhaustedCandidates;
  const groupedFtsCleanupExhausted =
    !config.groupedFtsCleanupEnabled ||
    groupedFtsCleanup === null ||
    groupedFtsCleanup.terminationReason === 'candidates_exhausted';
  const eventLogCleanupExhausted =
    !config.eventLogCleanupEnabled ||
    eventLogCleanup === null ||
    eventLogCleanup.exhaustedCandidates;
  return toolCleanupExhausted && groupedFtsCleanupExhausted && eventLogCleanupExhausted;
}

function resolveCleanupHealth(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null,
  now: number
): ProjectDataStorageCleanupHealth | null {
  if (!cleanupAttempted(cleanup, groupedFtsCleanup, eventLogCleanup)) return null;
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const afterBytes = sql.databaseSize;
  if (afterBytes <= targetBytes) return 'target_reached';
  if (hasPendingCleanup(sql, config, cleanup, groupedFtsCleanup, eventLogCleanup, now)) {
    return 'running';
  }
  if (cleanupCandidatesExhausted(config, cleanup, groupedFtsCleanup, eventLogCleanup)) {
    return 'target_unreachable';
  }
  return 'running';
}

async function persistCleanupHealthTelemetryAndAlerts(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  config: StorageSafetyConfig,
  callbacks: ProjectDataStorageAlarmCallbacks,
  measurement: ProjectDataStorageTelemetry | null,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): Promise<ProjectDataStorageCleanupHealth | null> {
  if (!projectId) return null;
  const measuredAt = Date.now();
  const cleanupHealth = resolveCleanupHealth(
    sql,
    config,
    cleanup,
    groupedFtsCleanup,
    eventLogCleanup,
    measuredAt
  );
  if (!cleanupHealth) return null;

  const computedTelemetry = await callbacks.buildTelemetry(
    sql,
    env,
    projectId,
    measuredAt,
    cleanupHealth,
    { includeCategoryBreakdown: false }
  );
  const telemetry =
    measurement?.growthRateBytesPerDay !== null &&
    measurement?.growthRateBytesPerDay !== undefined &&
    (computedTelemetry.growthRateBytesPerDay === null ||
      computedTelemetry.growthRateBytesPerDay <= 0)
      ? {
          ...computedTelemetry,
          growthRateBytesPerDay: measurement.growthRateBytesPerDay,
          estimatedDaysToLimit: measurement.estimatedDaysToLimit,
        }
      : computedTelemetry;
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const previousError = readMeta(sql, META_LAST_ERROR);
  const lastError =
    cleanupHealth === 'target_unreachable'
      ? truncate(
          [
            `ProjectData storage cleanup target unreachable: databaseSize=${telemetry.databaseSizeBytes}, targetBytes=${targetBytes}, reclaimableBytes=${telemetry.reclaimableBytes ?? 0}`,
            previousError ? `previousError=${previousError}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join('; '),
          1000
        )
      : null;

  writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
  writeMeta(sql, META_LAST_STATUS, telemetry.status);
  if (lastError) writeMeta(sql, META_LAST_ERROR, truncate(lastError, 500));

  try {
    await upsertProjectDataStorageTelemetry(
      env,
      telemetry,
      {
        lastAlarmAt: measurement ? null : measuredAt,
        lastError,
      },
      { appendHistory: cleanupHealth === 'target_unreachable' }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    log.warn('cleanup_health_telemetry_upsert_failed', {
      projectId,
      ...serializeError(error),
    });
  }

  if (cleanupHealth === 'target_unreachable') {
    try {
      await maybePersistProjectDataStorageAlert(
        sql,
        env,
        telemetry,
        config,
        STORAGE_ALERT_REASON_CLEANUP_TARGET_UNREACHABLE
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
      log.warn('cleanup_target_unreachable_alert_failed', {
        projectId,
        ...serializeError(error),
      });
    }
  }

  return cleanupHealth;
}

export async function runProjectDataStorageSafetyAlarmCore(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  config: StorageSafetyConfig,
  callbacks: ProjectDataStorageAlarmCallbacks
): Promise<ProjectDataStorageAlarmResult> {
  const startedAt = Date.now();
  const now = Date.now();
  let measurement: ProjectDataStorageTelemetry | null = null;
  if (callbacks.shouldMeasure(sql, env, now)) {
    measurement = await callbacks.measureAndPersist(sql, env, projectId, 'alarm');
  }

  const cleanup = await runProjectDataToolPayloadCleanup(sql, env, projectId, config, {
    allowStart: measurement !== null,
    now,
    ...(callbacks.transactionSync ? { transactionSync: callbacks.transactionSync } : {}),
    classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
    recordTelemetry: async (telemetry, fields) => {
      const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config, {
        includeCategoryBreakdown: false,
      });
      await upsertProjectDataStorageTelemetry(env, enriched, fields);
    },
  });
  const groupedFtsCleanup = config.groupedFtsCleanupEnabled
    ? await runProjectDataGroupedFtsCleanup(sql, env, projectId, config, {
        allowStart: measurement !== null || cleanup !== null,
        now,
        classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
      })
    : null;
  const eventLogCleanup = await runProjectDataEventLogCleanup(sql, env, projectId, config, {
    allowStart: measurement !== null || cleanup !== null || groupedFtsCleanup !== null,
    now,
    classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
    recordTelemetry: async (telemetry, fields) => {
      const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config, {
        includeCategoryBreakdown: false,
      });
      await upsertProjectDataStorageTelemetry(env, enriched, fields);
    },
  });
  const cleanupHealth = await persistCleanupHealthTelemetryAndAlerts(
    sql,
    env,
    projectId,
    config,
    callbacks,
    measurement,
    cleanup,
    groupedFtsCleanup,
    eventLogCleanup
  );
  const durationMs = Date.now() - startedAt;
  log.info('completed', {
    projectId,
    durationMs,
    measured: measurement !== null,
    databaseSizeBytes: measurement?.databaseSizeBytes ?? sql.databaseSize,
    cleanupHealth,
    toolPayloadCleanup: cleanup
      ? {
          rowsScanned: cleanup.rowsScanned,
          rowsUpdated: cleanup.rowsUpdated,
          rowsFailed: cleanup.rowsFailed,
          batchRows: cleanup.batchRows,
          batchBytes: cleanup.batchBytes,
          toolMetadataBytesScanned: cleanup.toolMetadataBytesScanned,
          toolMetadataBytesRead: cleanup.toolMetadataBytesRead,
          originalToolMetadataBytes: cleanup.originalToolMetadataBytes,
          storedToolMetadataBytes: cleanup.storedToolMetadataBytes,
          exhaustedCandidates: cleanup.exhaustedCandidates,
        }
      : null,
    eventLogCleanup: eventLogCleanup
      ? {
          rowsDeleted: eventLogCleanup.rowsDeleted,
          rowsExamined: eventLogCleanup.rowsExamined,
          candidateBytesDeleted: eventLogCleanup.candidateBytesDeleted,
          originalBytes: eventLogCleanup.originalBytes,
          reclaimedBytes: eventLogCleanup.reclaimedBytes,
          terminationReason: eventLogCleanup.terminationReason,
          batchRows: eventLogCleanup.batchRows,
          exhaustedCandidates: eventLogCleanup.exhaustedCandidates,
        }
      : null,
    groupedFtsCleanup: groupedFtsCleanup
      ? {
          terminationReason: groupedFtsCleanup.terminationReason,
          rowsExamined: groupedFtsCleanup.rowsExamined,
          sessionsExamined: groupedFtsCleanup.sessionsExamined,
          sessionsCleaned: groupedFtsCleanup.sessionsCleaned,
          groupedRowsDeleted: groupedFtsCleanup.groupedRowsDeleted,
          ftsRowsDeleted: groupedFtsCleanup.ftsRowsDeleted,
          originalContentBytes: groupedFtsCleanup.originalContentBytes,
          reclaimedBytes: groupedFtsCleanup.reclaimedBytes,
          searchSemantics: groupedFtsCleanup.searchSemantics,
        }
      : null,
  });
  return { measurement, cleanup, groupedFtsCleanup, eventLogCleanup, cleanupHealth, durationMs };
}
