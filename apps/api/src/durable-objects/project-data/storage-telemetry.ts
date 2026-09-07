import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { persistError } from '../../services/observability';
import {
  measureProjectDataStorageCategories,
  type ProjectDataStorageCategoryBreakdown,
} from './storage-category-telemetry';
import type {
  ProjectDataStorageStatus,
  ProjectDataStorageTelemetry,
  StorageSafetyConfig,
} from './storage-safety';
import {
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import type { Env } from './types';

const log = createModuleLogger('project_data.storage_telemetry');

const META_LAST_ALERT_AT = 'storageSafetyLastAlertAt';
const META_LAST_ALERT_STATUS = 'storageSafetyLastAlertStatus';
const META_LAST_ALERT_REASON = 'storageSafetyLastAlertReason';
export const STORAGE_ALERT_REASON_THRESHOLD = 'threshold_exceeded';
export const STORAGE_ALERT_REASON_CLEANUP_TARGET_UNREACHABLE = 'cleanup_target_unreachable';

export type ProjectDataStorageAlertReason =
  | typeof STORAGE_ALERT_REASON_THRESHOLD
  | typeof STORAGE_ALERT_REASON_CLEANUP_TARGET_UNREACHABLE;

type ProjectDataStorageTrendSource = {
  measuredAt: number;
  databaseSizeBytes: number;
};

export type ProjectDataStorageTelemetryUpdateFields = {
  lastAlarmAt?: number | null;
  lastAlertAt?: number | null;
  lastAlertStatus?: ProjectDataStorageStatus | null;
  lastAlertReason?: string | null;
  lastPurgeAt?: number | null;
  lastPurgeReason?: string | null;
  lastPurgeRows?: number | null;
  lastPurgeDatabaseSizeBytes?: number | null;
  lastError?: string | null;
};

export interface ProjectDataStorageTelemetryEnrichmentOptions {
  includeCategoryBreakdown?: boolean;
}

function normalizeTrendSource(row: unknown): ProjectDataStorageTrendSource | null {
  if (!isJsonRecord(row)) return null;
  const measuredAt = row.measured_at;
  const databaseSizeBytes = row.database_size_bytes;
  if (
    typeof measuredAt !== 'number' ||
    !Number.isFinite(measuredAt) ||
    typeof databaseSizeBytes !== 'number' ||
    !Number.isFinite(databaseSizeBytes)
  ) {
    return null;
  }
  return { measuredAt, databaseSizeBytes };
}

async function readGrowthTrendSource(
  env: Env,
  projectId: string,
  measuredAt: number,
  config: Pick<StorageSafetyConfig, 'growthLookbackMs'>
): Promise<ProjectDataStorageTrendSource | null> {
  const lookbackStart = measuredAt - config.growthLookbackMs;

  try {
    const history = await env.DATABASE.prepare(
      `SELECT measured_at, database_size_bytes
       FROM project_data_storage_telemetry_history
       WHERE project_id = ?
         AND measured_at < ?
         AND measured_at >= ?
       ORDER BY measured_at ASC
       LIMIT 1`
    )
      .bind(projectId, measuredAt, lookbackStart)
      .first();
    const historySource = normalizeTrendSource(history);
    if (historySource) return historySource;
  } catch (error) {
    log.warn('growth_history_read_failed', {
      projectId,
      ...serializeError(error),
    });
  }

  try {
    const latest = await env.DATABASE.prepare(
      `SELECT measured_at, database_size_bytes
       FROM project_data_storage_telemetry
       WHERE project_id = ?
         AND measured_at < ?
       ORDER BY measured_at DESC
       LIMIT 1`
    )
      .bind(projectId, measuredAt)
      .first();
    return normalizeTrendSource(latest);
  } catch (error) {
    log.warn('growth_latest_read_failed', {
      projectId,
      ...serializeError(error),
    });
    return null;
  }
}

function computeGrowthForecast(
  telemetry: Pick<ProjectDataStorageTelemetry, 'measuredAt' | 'databaseSizeBytes' | 'limitBytes'>,
  source: ProjectDataStorageTrendSource | null
): Pick<ProjectDataStorageTelemetry, 'growthRateBytesPerDay' | 'estimatedDaysToLimit'> {
  if (!source || source.measuredAt >= telemetry.measuredAt) {
    return { growthRateBytesPerDay: null, estimatedDaysToLimit: null };
  }

  const elapsedDays = (telemetry.measuredAt - source.measuredAt) / (24 * 60 * 60 * 1000);
  if (elapsedDays <= 0) {
    return { growthRateBytesPerDay: null, estimatedDaysToLimit: null };
  }

  const growthRateBytesPerDay =
    (telemetry.databaseSizeBytes - source.databaseSizeBytes) / elapsedDays;
  if (growthRateBytesPerDay <= 0) {
    return { growthRateBytesPerDay: 0, estimatedDaysToLimit: null };
  }

  const remainingBytes = telemetry.limitBytes - telemetry.databaseSizeBytes;
  return {
    growthRateBytesPerDay,
    estimatedDaysToLimit: remainingBytes <= 0 ? 0 : remainingBytes / growthRateBytesPerDay,
  };
}

export async function enrichProjectDataStorageTelemetry(
  sql: SqlStorage,
  env: Env,
  telemetry: ProjectDataStorageTelemetry,
  config: StorageSafetyConfig,
  options: ProjectDataStorageTelemetryEnrichmentOptions = {}
): Promise<ProjectDataStorageTelemetry> {
  const includeCategoryBreakdown = options.includeCategoryBreakdown ?? true;
  const categoryBreakdown: ProjectDataStorageCategoryBreakdown | null = includeCategoryBreakdown
    ? (telemetry.categoryBreakdown ??
      measureProjectDataStorageCategories(sql, config, telemetry.measuredAt))
    : telemetry.categoryBreakdown;
  const source = await readGrowthTrendSource(env, telemetry.projectId, telemetry.measuredAt, config);
  const forecast = computeGrowthForecast(telemetry, source);

  return {
    ...telemetry,
    ...forecast,
    reclaimableBytes: categoryBreakdown?.reclaimableBytes ?? telemetry.reclaimableBytes,
    categoryBreakdown,
  };
}

export async function upsertProjectDataStorageTelemetry(
  env: Env,
  telemetry: ProjectDataStorageTelemetry,
  fields: ProjectDataStorageTelemetryUpdateFields = {},
  options: { appendHistory?: boolean } = { appendHistory: true }
): Promise<void> {
  const categoryBreakdownJson = telemetry.categoryBreakdown
    ? JSON.stringify(telemetry.categoryBreakdown)
    : null;
  const now = Date.now();
  const lastErrorWasProvided = Object.prototype.hasOwnProperty.call(fields, 'lastError');

  await env.DATABASE.prepare(
    `INSERT INTO project_data_storage_telemetry (
       project_id,
       measured_at,
       database_size_bytes,
       limit_bytes,
       usage_ratio,
       status,
       growth_rate_bytes_per_day,
       estimated_days_to_limit,
       cleanup_health,
       reclaimable_bytes,
       category_breakdown_json,
       last_alarm_at,
       last_alert_at,
       last_alert_status,
       last_alert_reason,
       last_purge_at,
       last_purge_reason,
       last_purge_rows,
       last_purge_database_size_bytes,
       last_error,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       measured_at = excluded.measured_at,
       database_size_bytes = excluded.database_size_bytes,
       limit_bytes = excluded.limit_bytes,
       usage_ratio = excluded.usage_ratio,
       status = excluded.status,
       growth_rate_bytes_per_day = excluded.growth_rate_bytes_per_day,
       estimated_days_to_limit = excluded.estimated_days_to_limit,
       cleanup_health = excluded.cleanup_health,
       reclaimable_bytes = excluded.reclaimable_bytes,
       category_breakdown_json = excluded.category_breakdown_json,
       last_alarm_at = COALESCE(excluded.last_alarm_at, project_data_storage_telemetry.last_alarm_at),
       last_alert_at = COALESCE(excluded.last_alert_at, project_data_storage_telemetry.last_alert_at),
       last_alert_status = COALESCE(excluded.last_alert_status, project_data_storage_telemetry.last_alert_status),
       last_alert_reason = COALESCE(excluded.last_alert_reason, project_data_storage_telemetry.last_alert_reason),
       last_purge_at = COALESCE(excluded.last_purge_at, project_data_storage_telemetry.last_purge_at),
       last_purge_reason = COALESCE(excluded.last_purge_reason, project_data_storage_telemetry.last_purge_reason),
       last_purge_rows = COALESCE(excluded.last_purge_rows, project_data_storage_telemetry.last_purge_rows),
       last_purge_database_size_bytes = COALESCE(excluded.last_purge_database_size_bytes, project_data_storage_telemetry.last_purge_database_size_bytes),
       last_error = CASE
         WHEN ? = 1 THEN excluded.last_error
         ELSE project_data_storage_telemetry.last_error
       END,
       updated_at = excluded.updated_at`
  )
    .bind(
      telemetry.projectId,
      telemetry.measuredAt,
      telemetry.databaseSizeBytes,
      telemetry.limitBytes,
      telemetry.usageRatio,
      telemetry.status,
      telemetry.growthRateBytesPerDay,
      telemetry.estimatedDaysToLimit,
      telemetry.cleanupHealth,
      telemetry.reclaimableBytes,
      categoryBreakdownJson,
      fields.lastAlarmAt ?? null,
      fields.lastAlertAt ?? null,
      fields.lastAlertStatus ?? null,
      fields.lastAlertReason ? truncate(fields.lastAlertReason, 100) : null,
      fields.lastPurgeAt ?? null,
      fields.lastPurgeReason ? truncate(fields.lastPurgeReason, 500) : null,
      fields.lastPurgeRows ?? null,
      fields.lastPurgeDatabaseSizeBytes ?? null,
      fields.lastError ? truncate(fields.lastError, 1000) : null,
      now,
      lastErrorWasProvided ? 1 : 0
    )
    .run();

  if (options.appendHistory !== false) {
    await appendTelemetryHistory(env, telemetry, categoryBreakdownJson, now);
  }
}

async function appendTelemetryHistory(
  env: Env,
  telemetry: ProjectDataStorageTelemetry,
  categoryBreakdownJson: string | null,
  createdAt: number
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO project_data_storage_telemetry_history (
       id,
       project_id,
       measured_at,
       database_size_bytes,
       limit_bytes,
       usage_ratio,
       status,
       growth_rate_bytes_per_day,
       estimated_days_to_limit,
       cleanup_health,
       reclaimable_bytes,
       category_breakdown_json,
       created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      telemetry.projectId,
      telemetry.measuredAt,
      telemetry.databaseSizeBytes,
      telemetry.limitBytes,
      telemetry.usageRatio,
      telemetry.status,
      telemetry.growthRateBytesPerDay,
      telemetry.estimatedDaysToLimit,
      telemetry.cleanupHealth,
      telemetry.reclaimableBytes,
      categoryBreakdownJson,
      createdAt
    )
    .run();
}

function formatUsageRatio(usageRatio: number): string {
  return `${(usageRatio * 100).toFixed(2)}%`;
}

function formatGrowthForecast(telemetry: ProjectDataStorageTelemetry): string {
  if (telemetry.growthRateBytesPerDay === null) {
    return 'growth unavailable';
  }
  const growth = `${Math.round(telemetry.growthRateBytesPerDay)} bytes/day`;
  if (telemetry.estimatedDaysToLimit === null) {
    return `${growth}, time to limit unavailable`;
  }
  return `${growth}, ${telemetry.estimatedDaysToLimit.toFixed(1)} days to limit`;
}

export async function maybePersistProjectDataStorageAlert(
  sql: SqlStorage,
  env: Env,
  telemetry: ProjectDataStorageTelemetry,
  config: Pick<StorageSafetyConfig, 'alertIntervalMs'>,
  reason: ProjectDataStorageAlertReason = STORAGE_ALERT_REASON_THRESHOLD
): Promise<void> {
  const isThresholdAlert = ['warning', 'critical', 'degraded'].includes(telemetry.status);
  const isCleanupTargetUnreachable = reason === STORAGE_ALERT_REASON_CLEANUP_TARGET_UNREACHABLE;
  if (!isThresholdAlert && !isCleanupTargetUnreachable) return;

  const now = Date.now();
  const lastAlertAt = readMetaNumber(sql, META_LAST_ALERT_AT);
  const lastAlertStatus = readMeta(sql, META_LAST_ALERT_STATUS);
  const lastAlertReason = readMeta(sql, META_LAST_ALERT_REASON);
  if (
    lastAlertAt !== null &&
    now - lastAlertAt < config.alertIntervalMs &&
    lastAlertStatus === telemetry.status &&
    lastAlertReason === reason
  ) {
    return;
  }

  const growthText = formatGrowthForecast(telemetry);
  const message = isCleanupTargetUnreachable
    ? `ProjectData storage cleanup target unreachable (${formatUsageRatio(telemetry.usageRatio)}, ${growthText})`
    : `ProjectData storage usage is ${telemetry.status} (${formatUsageRatio(
        telemetry.usageRatio
      )}, ${growthText})`;
  const level =
    isCleanupTargetUnreachable || telemetry.status === 'critical' || telemetry.status === 'degraded'
      ? 'error'
      : 'warn';

  const logContext = {
    projectId: telemetry.projectId,
    status: telemetry.status,
    databaseSizeBytes: telemetry.databaseSizeBytes,
    limitBytes: telemetry.limitBytes,
    usageRatio: telemetry.usageRatio,
    growthRateBytesPerDay: telemetry.growthRateBytesPerDay,
    estimatedDaysToLimit: telemetry.estimatedDaysToLimit,
    cleanupHealth: telemetry.cleanupHealth,
    reclaimableBytes: telemetry.reclaimableBytes,
  };
  if (level === 'error') {
    log.error(reason, logContext);
  } else {
    log.warn(reason, logContext);
  }

  if (!env.OBSERVABILITY_DATABASE) return;

  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level,
      message,
      context: {
        projectId: telemetry.projectId,
        databaseSizeBytes: telemetry.databaseSizeBytes,
        limitBytes: telemetry.limitBytes,
        usageRatio: telemetry.usageRatio,
        status: telemetry.status,
        alertReason: reason,
        growthRateBytesPerDay: telemetry.growthRateBytesPerDay,
        estimatedDaysToLimit: telemetry.estimatedDaysToLimit,
        cleanupHealth: telemetry.cleanupHealth,
        reclaimableBytes: telemetry.reclaimableBytes,
        categoryBreakdown: telemetry.categoryBreakdown,
      },
    },
    undefined
  );

  await upsertProjectDataStorageTelemetry(
    env,
    telemetry,
    {
      lastAlertAt: now,
      lastAlertStatus: telemetry.status,
      lastAlertReason: reason,
    },
    { appendHistory: false }
  );

  writeMeta(sql, META_LAST_ALERT_AT, String(now));
  writeMeta(sql, META_LAST_ALERT_STATUS, telemetry.status);
  writeMeta(sql, META_LAST_ALERT_REASON, reason);
}
