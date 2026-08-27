/**
 * ProjectData storage safety firebreak.
 *
 * This module intentionally avoids sharding or broad data movement. It provides:
 * - direct per-object `databaseSize` measurement from SQLite-backed DO storage;
 * - latest-row and append-only D1 telemetry with growth forecasts;
 * - throttled operator-visible observability alerts;
 * - bounded automatic cleanup for safely reclaimable archived tool payloads;
 * - a bounded, explicit emergency purge of low-value event logs.
 */
import { createModuleLogger, serializeError } from '../../lib/logger';
import {
  type ProjectDataEventLogCleanupResult,
  readProjectDataEventLogCleanupRecheckAt,
} from './event-log-cleanup';
import { runProjectDataStorageSafetyAlarmCore } from './storage-alarm';
import {
  type ProjectDataStorageCategoryBreakdown,
  type ProjectDataStorageCleanupHealth,
} from './storage-category-telemetry';
import { runProjectDataStorageEmergencyPurgeCore } from './storage-emergency-purge';
import {
  META_LAST_ERROR,
  META_LAST_MEASURED_AT,
  META_LAST_STATUS,
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import {
  enrichProjectDataStorageTelemetry,
  maybePersistProjectDataStorageAlert,
  type ProjectDataStorageTelemetryEnrichmentOptions,
  upsertProjectDataStorageTelemetry,
} from './storage-telemetry';
import {
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX,
  type ProjectDataToolPayloadCleanupResult,
  readProjectDataToolPayloadArchiveLastRunAt,
  readProjectDataToolPayloadCleanupRecheckAt,
} from './tool-payload-cleanup';
import type { Env } from './types';

const log = createModuleLogger('project_data.storage_safety');

export const PROJECT_DATA_STORAGE_STATUSES = [
  'ok',
  'notice',
  'warning',
  'critical',
  'degraded',
] as const;

export type ProjectDataStorageStatus = (typeof PROJECT_DATA_STORAGE_STATUSES)[number];

export const DEFAULT_PROJECT_DATA_STORAGE_LIMIT_BYTES = 10_000_000_000;
export const DEFAULT_PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_STORAGE_NOTICE_RATIO = 0.6;
export const DEFAULT_PROJECT_DATA_STORAGE_WARNING_RATIO = 0.8;
export const DEFAULT_PROJECT_DATA_STORAGE_CRITICAL_RATIO = 0.9;
export const DEFAULT_PROJECT_DATA_STORAGE_DEGRADED_RATIO = 0.95;
export const DEFAULT_PROJECT_DATA_STORAGE_EMERGENCY_TARGET_RATIO = 0.9;
export const DEFAULT_PROJECT_DATA_STORAGE_EMERGENCY_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_STORAGE_EMERGENCY_MAX_BATCHES = 4;
export const DEFAULT_PROJECT_DATA_STORAGE_GROWTH_LOOKBACK_DAYS = 7;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO = 0.8;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO = 0.75;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES = 1024 * 1024;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS = 7;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS = 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM = 25;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS = 20 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS = 5;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS = 5 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS = 7;
export const DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS = 60 * 1000;

export interface ProjectDataStorageTelemetry {
  projectId: string;
  measuredAt: number;
  databaseSizeBytes: number;
  limitBytes: number;
  usageRatio: number;
  status: ProjectDataStorageStatus;
  growthRateBytesPerDay: number | null;
  estimatedDaysToLimit: number | null;
  cleanupHealth: ProjectDataStorageCleanupHealth | null;
  reclaimableBytes: number | null;
  categoryBreakdown: ProjectDataStorageCategoryBreakdown | null;
}

export interface ProjectDataStorageEmergencyPurgeInput {
  reason?: string | null;
  targetRatio?: number | null;
  batchRows?: number | null;
  maxBatches?: number | null;
}

export interface ProjectDataStorageEmergencyPurgeResult {
  projectId: string;
  reason: string;
  beforeBytes: number;
  afterBytes: number;
  limitBytes: number;
  targetBytes: number;
  statusBefore: ProjectDataStorageStatus;
  statusAfter: ProjectDataStorageStatus;
  batches: number;
  maxBatches: number;
  batchRows: number;
  rowsDeleted: {
    activityEvents: number;
    acpSessionEvents: number;
  };
  exhaustedCandidates: boolean;
}

export interface ProjectDataStorageAlarmResult {
  measurement: ProjectDataStorageTelemetry | null;
  cleanup: ProjectDataToolPayloadCleanupResult | null;
  eventLogCleanup: ProjectDataEventLogCleanupResult | null;
  cleanupHealth: ProjectDataStorageCleanupHealth | null;
  durationMs: number;
}

export interface StorageSafetyConfig {
  enabled: boolean;
  limitBytes: number;
  measureIntervalMs: number;
  alertIntervalMs: number;
  noticeRatio: number;
  warningRatio: number;
  criticalRatio: number;
  degradedRatio: number;
  emergencyTargetRatio: number;
  emergencyBatchRows: number;
  emergencyMaxBatches: number;
  growthLookbackMs: number;
  toolPayloadCleanupEnabled: boolean;
  toolPayloadCleanupTriggerRatio: number;
  toolPayloadCleanupTargetRatio: number;
  toolPayloadCleanupBatchRows: number;
  toolPayloadCleanupBatchBytes: number;
  toolPayloadCleanupMaxRowBytes: number;
  toolPayloadCleanupMinSessionAgeMs: number;
  toolPayloadCleanupRecheckMs: number;
  toolPayloadCleanupMaxSessionsPerAlarm: number;
  toolPayloadCleanupWallTimeMs: number;
  toolPayloadArchiveRetentionMs: number;
  toolPayloadArchiveIntervalMs: number;
  toolPayloadArchiveR2Prefix: string;
  toolPayloadArchiveWriteTimeoutMs: number;
  toolPayloadArchiveRetryDelayMs: number;
  eventLogCleanupEnabled: boolean;
  eventLogCleanupBatchRows: number;
  eventLogCleanupMinSessionAgeMs: number;
  eventLogCleanupRecheckMs: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoundedRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return true;
  return !['0', 'false', 'off', 'disabled'].includes(value.trim().toLowerCase());
}

function stripBoundarySlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function parseR2Prefix(value: string | undefined, fallback: string): string {
  const parsed = stripBoundarySlashes((value ?? fallback).trim());
  return parsed || fallback;
}

export function resolveStorageSafetyConfig(env: Env): StorageSafetyConfig {
  const noticeRatio = parseBoundedRatio(
    env.PROJECT_DATA_STORAGE_NOTICE_RATIO,
    DEFAULT_PROJECT_DATA_STORAGE_NOTICE_RATIO
  );
  const warningRatio = parseBoundedRatio(
    env.PROJECT_DATA_STORAGE_WARNING_RATIO,
    DEFAULT_PROJECT_DATA_STORAGE_WARNING_RATIO
  );
  const criticalRatio = parseBoundedRatio(
    env.PROJECT_DATA_STORAGE_CRITICAL_RATIO,
    DEFAULT_PROJECT_DATA_STORAGE_CRITICAL_RATIO
  );
  const degradedRatio = parseBoundedRatio(
    env.PROJECT_DATA_STORAGE_DEGRADED_RATIO,
    DEFAULT_PROJECT_DATA_STORAGE_DEGRADED_RATIO
  );

  const thresholdsAreOrdered =
    noticeRatio < warningRatio && warningRatio < criticalRatio && criticalRatio < degradedRatio;
  const cleanupTriggerRatio = parseBoundedRatio(
    env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO,
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO
  );
  const cleanupTargetRatio = parseBoundedRatio(
    env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO,
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO
  );
  const cleanupRatiosAreOrdered = cleanupTargetRatio < cleanupTriggerRatio;
  const cleanupMinSessionAgeDays = parseNonNegativeInteger(
    env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS,
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS
  );
  const archiveRetentionDays = parseNonNegativeInteger(
    env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS,
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS
  );
  const growthLookbackDays = parsePositiveInteger(
    env.PROJECT_DATA_STORAGE_GROWTH_LOOKBACK_DAYS,
    DEFAULT_PROJECT_DATA_STORAGE_GROWTH_LOOKBACK_DAYS
  );
  const eventLogCleanupMinSessionAgeDays = parseNonNegativeInteger(
    env.PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS,
    DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS
  );

  return {
    enabled: envFlagEnabled(env.PROJECT_DATA_STORAGE_TELEMETRY_ENABLED),
    limitBytes: parsePositiveInteger(
      env.PROJECT_DATA_STORAGE_LIMIT_BYTES,
      DEFAULT_PROJECT_DATA_STORAGE_LIMIT_BYTES
    ),
    measureIntervalMs: parsePositiveInteger(
      env.PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS,
      DEFAULT_PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS
    ),
    alertIntervalMs: parsePositiveInteger(
      env.PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS,
      DEFAULT_PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS
    ),
    noticeRatio: thresholdsAreOrdered ? noticeRatio : DEFAULT_PROJECT_DATA_STORAGE_NOTICE_RATIO,
    warningRatio: thresholdsAreOrdered ? warningRatio : DEFAULT_PROJECT_DATA_STORAGE_WARNING_RATIO,
    criticalRatio: thresholdsAreOrdered
      ? criticalRatio
      : DEFAULT_PROJECT_DATA_STORAGE_CRITICAL_RATIO,
    degradedRatio: thresholdsAreOrdered
      ? degradedRatio
      : DEFAULT_PROJECT_DATA_STORAGE_DEGRADED_RATIO,
    emergencyTargetRatio: parseBoundedRatio(
      env.PROJECT_DATA_STORAGE_EMERGENCY_TARGET_RATIO,
      DEFAULT_PROJECT_DATA_STORAGE_EMERGENCY_TARGET_RATIO
    ),
    emergencyBatchRows: parsePositiveInteger(
      env.PROJECT_DATA_STORAGE_EMERGENCY_BATCH_ROWS,
      DEFAULT_PROJECT_DATA_STORAGE_EMERGENCY_BATCH_ROWS
    ),
    emergencyMaxBatches: parsePositiveInteger(
      env.PROJECT_DATA_STORAGE_EMERGENCY_MAX_BATCHES,
      DEFAULT_PROJECT_DATA_STORAGE_EMERGENCY_MAX_BATCHES
    ),
    growthLookbackMs: growthLookbackDays * 24 * 60 * 60 * 1000,
    toolPayloadCleanupEnabled: envFlagEnabled(env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED),
    toolPayloadCleanupTriggerRatio: cleanupRatiosAreOrdered
      ? cleanupTriggerRatio
      : DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO,
    toolPayloadCleanupTargetRatio: cleanupRatiosAreOrdered
      ? cleanupTargetRatio
      : DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO,
    toolPayloadCleanupBatchRows: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS
    ),
    toolPayloadCleanupBatchBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES
    ),
    toolPayloadCleanupMaxRowBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES
    ),
    toolPayloadCleanupMinSessionAgeMs: cleanupMinSessionAgeDays * 24 * 60 * 60 * 1000,
    toolPayloadCleanupRecheckMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    ),
    toolPayloadCleanupMaxSessionsPerAlarm: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM
    ),
    toolPayloadCleanupWallTimeMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS
    ),
    toolPayloadArchiveRetentionMs: archiveRetentionDays * 24 * 60 * 60 * 1000,
    toolPayloadArchiveIntervalMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS
    ),
    toolPayloadArchiveR2Prefix: parseR2Prefix(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX
    ),
    toolPayloadArchiveWriteTimeoutMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS
    ),
    toolPayloadArchiveRetryDelayMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS
    ),
    eventLogCleanupEnabled: envFlagEnabled(env.PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED),
    eventLogCleanupBatchRows: parsePositiveInteger(
      env.PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS,
      DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS
    ),
    eventLogCleanupMinSessionAgeMs: eventLogCleanupMinSessionAgeDays * 24 * 60 * 60 * 1000,
    eventLogCleanupRecheckMs: parsePositiveInteger(
      env.PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS,
      DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS
    ),
  };
}

export function classifyStorageUsage(
  databaseSizeBytes: number,
  config: Pick<
    StorageSafetyConfig,
    'limitBytes' | 'noticeRatio' | 'warningRatio' | 'criticalRatio' | 'degradedRatio'
  >
): ProjectDataStorageStatus {
  const usageRatio = databaseSizeBytes / config.limitBytes;
  if (usageRatio >= config.degradedRatio) return 'degraded';
  if (usageRatio >= config.criticalRatio) return 'critical';
  if (usageRatio >= config.warningRatio) return 'warning';
  if (usageRatio >= config.noticeRatio) return 'notice';
  return 'ok';
}

async function buildTelemetry(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  measuredAt: number = Date.now(),
  cleanupHealth: ProjectDataStorageCleanupHealth | null = null,
  options: ProjectDataStorageTelemetryEnrichmentOptions = {}
): Promise<ProjectDataStorageTelemetry> {
  const config = resolveStorageSafetyConfig(env);
  const databaseSizeBytes = sql.databaseSize;
  const usageRatio = databaseSizeBytes / config.limitBytes;
  const baseTelemetry: ProjectDataStorageTelemetry = {
    projectId,
    measuredAt,
    databaseSizeBytes,
    limitBytes: config.limitBytes,
    usageRatio,
    status: classifyStorageUsage(databaseSizeBytes, config),
    growthRateBytesPerDay: null,
    estimatedDaysToLimit: null,
    cleanupHealth,
    reclaimableBytes: null,
    categoryBreakdown: null,
  };
  return enrichProjectDataStorageTelemetry(sql, env, baseTelemetry, config, options);
}

export function computeStorageSafetyAlarmTime(
  sql: SqlStorage,
  env: Env,
  now: number = Date.now()
): number | null {
  const config = resolveStorageSafetyConfig(env);
  if (!config.enabled) return null;
  if (!readMeta(sql, 'projectId')) return null;
  const lastMeasuredAt = readMetaNumber(sql, META_LAST_MEASURED_AT);
  const measureAt = lastMeasuredAt === null ? now : lastMeasuredAt + config.measureIntervalMs;
  const cleanupRecheckAt = config.toolPayloadCleanupEnabled
    ? readProjectDataToolPayloadCleanupRecheckAt(sql)
    : null;
  const archiveLastRunAt = config.toolPayloadCleanupEnabled
    ? readProjectDataToolPayloadArchiveLastRunAt(sql)
    : null;
  let archiveRunAt: number | null = null;
  if (config.toolPayloadCleanupEnabled) {
    archiveRunAt =
      archiveLastRunAt === null ? now : archiveLastRunAt + config.toolPayloadArchiveIntervalMs;
  }
  const eventLogCleanupRecheckAt = config.eventLogCleanupEnabled
    ? readProjectDataEventLogCleanupRecheckAt(sql)
    : null;
  return Math.min(
    measureAt,
    ...[cleanupRecheckAt, archiveRunAt, eventLogCleanupRecheckAt].filter(
      (value): value is number => value !== null
    )
  );
}

export function shouldMeasureProjectDataStorage(
  sql: SqlStorage,
  env: Env,
  now: number = Date.now()
): boolean {
  const config = resolveStorageSafetyConfig(env);
  if (!config.enabled) return false;
  if (!readMeta(sql, 'projectId')) return false;
  const lastMeasuredAt = readMetaNumber(sql, META_LAST_MEASURED_AT);
  return lastMeasuredAt === null || now - lastMeasuredAt >= config.measureIntervalMs;
}

export async function measureAndPersistProjectDataStorage(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  reason: 'alarm' | 'admin' = 'alarm'
): Promise<ProjectDataStorageTelemetry | null> {
  const config = resolveStorageSafetyConfig(env);
  if (!config.enabled) return null;
  if (!projectId) {
    log.warn('measure_skipped_missing_project_id');
    return null;
  }

  const telemetry = await buildTelemetry(sql, env, projectId, Date.now(), null, {
    includeCategoryBreakdown: reason !== 'alarm',
  });
  writeMeta(sql, META_LAST_MEASURED_AT, String(telemetry.measuredAt));
  writeMeta(sql, META_LAST_STATUS, telemetry.status);

  try {
    await upsertProjectDataStorageTelemetry(env, telemetry, {
      lastAlarmAt: reason === 'alarm' ? telemetry.measuredAt : null,
      lastError: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    log.warn('telemetry_upsert_failed', {
      projectId,
      ...serializeError(error),
    });
  }

  try {
    await maybePersistProjectDataStorageAlert(sql, env, telemetry, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
    log.warn('alert_failed', {
      projectId,
      ...serializeError(error),
    });
  }

  return telemetry;
}

export async function runProjectDataStorageSafetyAlarm(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  options: { transactionSync?: <T>(callback: () => T) => T } = {}
): Promise<ProjectDataStorageAlarmResult> {
  const config = resolveStorageSafetyConfig(env);
  return runProjectDataStorageSafetyAlarmCore(sql, env, projectId, config, {
    ...(options.transactionSync ? { transactionSync: options.transactionSync } : {}),
    shouldMeasure: shouldMeasureProjectDataStorage,
    measureAndPersist: measureAndPersistProjectDataStorage,
    classifyStatus: classifyStorageUsage,
    buildTelemetry,
  });
}

export async function runProjectDataStorageEmergencyPurge(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  input: ProjectDataStorageEmergencyPurgeInput = {}
): Promise<ProjectDataStorageEmergencyPurgeResult> {
  const config = resolveStorageSafetyConfig(env);
  return runProjectDataStorageEmergencyPurgeCore(sql, env, projectId, input, config, {
    classifyStatus: classifyStorageUsage,
    buildTelemetry,
  });
}
