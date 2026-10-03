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
  deleteStorageSafetyMeta as deleteMeta,
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
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
  /** The object's `ctx.storage.transactionSync`; the cleanups' pages are atomic only with it. */
  transactionSync: <T>(callback: () => T) => T;
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

function cleanupHadFailure(
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): boolean {
  return (
    (cleanup !== null && (cleanup.rowsFailed > 0 || cleanup.terminationReason === 'error')) ||
    (groupedFtsCleanup !== null &&
      (['circuit_breaker', 'error', 'weak_reclaim', 'storage_full'].includes(
        groupedFtsCleanup.terminationReason
      ) ||
        groupedFtsCleanup.sessionsExcludedForFailure > 0)) ||
    (eventLogCleanup !== null && eventLogCleanup.terminationReason === 'error')
  );
}

function resolveCleanupHealth(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null,
  stageFailures: string[],
  now: number
): ProjectDataStorageCleanupHealth | null {
  if (!cleanupAttempted(cleanup, groupedFtsCleanup, eventLogCleanup) && stageFailures.length === 0)
    return null;
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const afterBytes = sql.databaseSize;
  if (afterBytes <= targetBytes) return 'target_reached';
  // A stage that threw has no result, which must not read as "nothing left to clean".
  if (stageFailures.length > 0) return 'failed';
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
  eventLogCleanup: ProjectDataEventLogCleanupResult | null,
  stageFailures: string[]
): Promise<ProjectDataStorageCleanupHealth | null> {
  if (!projectId) return null;
  const measuredAt = Date.now();
  const cleanupHealth = resolveCleanupHealth(
    sql,
    config,
    cleanup,
    groupedFtsCleanup,
    eventLogCleanup,
    stageFailures,
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
  const lastError =
    cleanupHealth === 'target_unreachable'
      ? truncate(
          `ProjectData storage cleanup target unreachable: databaseSize=${telemetry.databaseSizeBytes}, targetBytes=${targetBytes}, reclaimableBytes=${telemetry.reclaimableBytes ?? 0}`,
          1000
        )
      : cleanupHealth === 'failed' && stageFailures.length > 0
        ? truncate(`ProjectData storage cleanup stage failed: ${stageFailures.join('; ')}`, 1000)
        : null;

  writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
  writeMeta(sql, META_LAST_STATUS, telemetry.status);
  if (lastError) writeMeta(sql, META_LAST_ERROR, truncate(lastError, 500));
  else if (
    stageFailures.length === 0 &&
    !cleanupHadFailure(cleanup, groupedFtsCleanup, eventLogCleanup)
  ) {
    deleteMeta(sql, META_LAST_ERROR);
  }

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

/**
 * One cleanup stage. A throw here used to abort the whole alarm, so a stage that failed on its
 * own bookkeeping (as every write does at the per-object cap) kept the grouped/FTS cleanup,
 * the stage that frees space without writing first, from running at all.
 */
async function isolatedStage<T>(
  sql: SqlStorage,
  projectId: string | null,
  stage: string,
  stageFailures: string[],
  run: () => Promise<T | null>
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log.error('cleanup_stage_failed', { projectId, stage, ...serializeError(error) });
    const message = `${stage}: ${error instanceof Error ? error.message : String(error)}`;
    stageFailures.push(message);
    try {
      writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    } catch {
      // Near the cap this write can fail too; the log line above is the record.
    }
    return null;
  }
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

  const stageFailures: string[] = [];
  const cleanup = await isolatedStage(sql, projectId, 'tool_payload_cleanup', stageFailures, () =>
    runProjectDataToolPayloadCleanup(sql, env, projectId, config, {
      allowStart: measurement !== null,
      now,
      transactionSync: callbacks.transactionSync,
      classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
      recordTelemetry: async (telemetry, fields) => {
        const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config, {
          includeCategoryBreakdown: false,
        });
        await upsertProjectDataStorageTelemetry(env, enriched, fields);
      },
    })
  );
  const groupedFtsCleanup = config.groupedFtsCleanupEnabled
    ? await isolatedStage(sql, projectId, 'grouped_fts_cleanup', stageFailures, () =>
        runProjectDataGroupedFtsCleanup(sql, env, projectId, config, {
          allowStart: measurement !== null || cleanup !== null,
          now,
          transactionSync: callbacks.transactionSync,
          classifyStatus: (databaseSizeBytes) =>
            callbacks.classifyStatus(databaseSizeBytes, config),
        })
      )
    : null;
  const eventLogCleanup = await isolatedStage(
    sql,
    projectId,
    'event_log_cleanup',
    stageFailures,
    () =>
      runProjectDataEventLogCleanup(sql, env, projectId, config, {
        allowStart: measurement !== null || cleanup !== null || groupedFtsCleanup !== null,
        now,
        classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
        recordTelemetry: async (telemetry, fields) => {
          const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config, {
            includeCategoryBreakdown: false,
          });
          await upsertProjectDataStorageTelemetry(env, enriched, fields);
        },
      })
  );
  const cleanupHealth = await persistCleanupHealthTelemetryAndAlerts(
    sql,
    env,
    projectId,
    config,
    callbacks,
    measurement,
    cleanup,
    groupedFtsCleanup,
    eventLogCleanup,
    stageFailures
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
          rearchivableOversizedAttemptsReset: cleanup.rearchivableOversizedAttemptsReset,
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
          nearWall: groupedFtsCleanup.nearWall,
          pagesRolledBackForGrowth: groupedFtsCleanup.pagesRolledBackForGrowth,
          sessionsExcluded: groupedFtsCleanup.sessionsExcluded,
          searchSemantics: groupedFtsCleanup.searchSemantics,
        }
      : null,
  });
  return { measurement, cleanup, groupedFtsCleanup, eventLogCleanup, cleanupHealth, durationMs };
}
