import { createModuleLogger, serializeError } from '../../lib/logger';
import {
  type ProjectDataEventLogCleanupResult,
  readProjectDataEventLogCleanupRecheckAt,
  runProjectDataEventLogCleanup,
} from './event-log-cleanup';
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
    cleanupHealth: ProjectDataStorageCleanupHealth | null
  ) => Promise<ProjectDataStorageTelemetry>;
}

function hasPendingCleanup(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null,
  now: number
): boolean {
  const toolRecheckAt = cleanup?.recheckAt ?? readProjectDataToolPayloadCleanupRecheckAt(sql);
  const eventLogRecheckAt =
    eventLogCleanup?.recheckAt ?? readProjectDataEventLogCleanupRecheckAt(sql);
  const hasToolCleanupPending =
    config.toolPayloadCleanupEnabled && toolRecheckAt !== null && toolRecheckAt > now;
  const hasEventLogCleanupPending =
    config.eventLogCleanupEnabled && eventLogRecheckAt !== null && eventLogRecheckAt > now;
  return hasToolCleanupPending || hasEventLogCleanupPending;
}

function cleanupAttempted(
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): boolean {
  return cleanup !== null || eventLogCleanup !== null;
}

function cleanupCandidatesExhausted(
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): boolean {
  const toolCleanupExhausted =
    !config.toolPayloadCleanupEnabled || cleanup === null || cleanup.exhaustedCandidates;
  const eventLogCleanupExhausted =
    !config.eventLogCleanupEnabled || eventLogCleanup === null || eventLogCleanup.exhaustedCandidates;
  return toolCleanupExhausted && eventLogCleanupExhausted;
}

function resolveCleanupHealth(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  eventLogCleanup: ProjectDataEventLogCleanupResult | null,
  now: number
): ProjectDataStorageCleanupHealth | null {
  if (!cleanupAttempted(cleanup, eventLogCleanup)) return null;
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const afterBytes = sql.databaseSize;
  if (afterBytes <= targetBytes) return 'target_reached';
  if (hasPendingCleanup(sql, config, cleanup, eventLogCleanup, now)) return 'running';
  if (cleanupCandidatesExhausted(config, cleanup, eventLogCleanup)) return 'target_unreachable';
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
  eventLogCleanup: ProjectDataEventLogCleanupResult | null
): Promise<ProjectDataStorageCleanupHealth | null> {
  if (!projectId) return null;
  const measuredAt = Date.now();
  const cleanupHealth = resolveCleanupHealth(sql, config, cleanup, eventLogCleanup, measuredAt);
  if (!cleanupHealth) return null;

  const computedTelemetry = await callbacks.buildTelemetry(
    sql,
    env,
    projectId,
    measuredAt,
    cleanupHealth
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
  const now = Date.now();
  let measurement: ProjectDataStorageTelemetry | null = null;
  if (callbacks.shouldMeasure(sql, env, now)) {
    measurement = await callbacks.measureAndPersist(sql, env, projectId, 'alarm');
  }

  const cleanup = await runProjectDataToolPayloadCleanup(sql, env, projectId, config, {
    allowStart: measurement !== null,
    now,
    classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
    recordTelemetry: async (telemetry, fields) => {
      const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config);
      await upsertProjectDataStorageTelemetry(env, enriched, fields);
    },
  });
  const eventLogCleanup = await runProjectDataEventLogCleanup(sql, env, projectId, config, {
    allowStart: measurement !== null || cleanup !== null,
    now,
    classifyStatus: (databaseSizeBytes) => callbacks.classifyStatus(databaseSizeBytes, config),
    recordTelemetry: async (telemetry, fields) => {
      const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config);
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
    eventLogCleanup
  );
  return { measurement, cleanup, eventLogCleanup, cleanupHealth };
}
