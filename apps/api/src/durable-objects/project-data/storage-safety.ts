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
import {
  type ProjectDataGroupedFtsCleanupResult,
  readProjectDataGroupedFtsCleanupRecheckAt,
} from './grouped-fts-cleanup';
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
import { isProjectInToolPayloadCleanupScope } from './tool-payload-cleanup-config-refusal';
import {
  DEFAULT_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES,
  DEFAULT_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES,
} from './tool-payload-cleanup-manifest';
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
/**
 * Minimum spacing between storage-safety alarms, applied to every cleanup-derived time.
 *
 * Deliberately NOT env-configurable. This is a safety invariant, not a cadence: its only job is
 * to stop the schedule from re-arming at or before `now`, which is what produced the 2026-09-14
 * hot alarm loop. Exposing it as a knob would let an operator set it to 0 and reintroduce the
 * incident. Real cleanup cadences (recheck 24h, archive interval 24h, measure 1h) are all orders
 * of magnitude larger, so this never governs when work actually happens — it only bounds the
 * worst case to one wasted alarm per minute instead of several per second.
 */
export const STORAGE_SAFETY_MIN_ALARM_SPACING_MS = 60_000;

export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO = 0.8;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO = 0.75;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES = 1024 * 1024;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS = 7;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM = 25;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS = 20 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS =
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_BYTES =
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_WALL_TIME_MS =
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS = 5;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS = 5 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS = 1_500;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES = 512 * 1024;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES = 1_900_000;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_MEASURE_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS = 5_000;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED = false;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO = 0.9;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO = 0.85;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS = 2;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_ROWS = 1_000;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_MIN_SESSION_AGE_DAYS = 7;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_TIME_MS = 5 * 1000;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO = 0.98;
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_WEAK_RECLAIM_BYTES = 1;
export const DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS = 7;
export const DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS = 24 * 60 * 60 * 1000;

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
  groupedFtsCleanup: ProjectDataGroupedFtsCleanupResult | null;
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
  toolPayloadCleanupExactConfigValid: boolean;
  toolPayloadCleanupPlanId: string | null;
  toolPayloadCleanupManifestKey: string | null;
  toolPayloadCleanupManifestSha256: string | null;
  toolPayloadCleanupBatchManifestMaxBytes: number;
  toolPayloadCleanupRootManifestMaxBytes: number;
  toolPayloadCleanupMaxTotalRows: number | null;
  toolPayloadCleanupMaxTotalBytes: number | null;
  toolPayloadCleanupMaxTotalR2Operations: number | null;
  toolPayloadCleanupMaxTotalWallTimeMs: number | null;
  toolPayloadCleanupProjectIds: string[] | null;
  toolPayloadCleanupCutoffCreatedAt: number | null;
  toolPayloadCleanupTriggerRatio: number;
  toolPayloadCleanupTargetRatio: number;
  toolPayloadCleanupBatchRows: number;
  toolPayloadCleanupBatchBytes: number;
  toolPayloadCleanupMaxRowBytes: number;
  toolPayloadCleanupMinSessionAgeMs: number;
  toolPayloadCleanupRecheckMs: number;
  toolPayloadCleanupMaxSessionsPerAlarm: number;
  toolPayloadCleanupWallTimeMs: number;
  toolPayloadManualCleanupMaxBatchRows: number;
  toolPayloadManualCleanupMaxBatchBytes: number;
  toolPayloadManualCleanupMaxWallTimeMs: number;
  toolPayloadManualCleanupRecheckMs: number;
  toolPayloadArchiveRetentionMs: number;
  toolPayloadArchiveIntervalMs: number;
  toolPayloadArchiveR2Prefix: string;
  toolPayloadArchiveWriteTimeoutMs: number;
  toolPayloadArchiveMaxOperations: number;
  toolPayloadArchiveRetryDelayMs: number;
  toolPayloadArchiveChunkBytes: number;
  toolPayloadArchiveMaxMetadataBytes: number;
  storageReliefMeasureBatchRows: number;
  storageReliefMeasureMaxBatchRows: number;
  groupedFtsCleanupEnabled: boolean;
  groupedFtsCleanupTriggerRatio: number;
  groupedFtsCleanupTargetRatio: number;
  groupedFtsCleanupBatchSessions: number;
  groupedFtsCleanupBatchRows: number;
  groupedFtsCleanupBatchBytes: number;
  groupedFtsCleanupMinSessionAgeMs: number;
  groupedFtsCleanupRecheckMs: number;
  groupedFtsCleanupWallTimeMs: number;
  groupedFtsCleanupWallUnsafeRatio: number;
  groupedFtsCleanupWeakReclaimBytes: number;
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

function optionalPositiveIntegerIsValid(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (!normalized) return true;
  if (!/^[1-9]\d*$/.test(normalized)) return false;
  return Number.isSafeInteger(Number(normalized));
}

function parseOptionalPositiveInteger(value: string | undefined): number | null {
  const normalized = value?.trim() ?? '';
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalRatioIsValid(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (!normalized) return true;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1;
}

function parseOptionalIdList(value: string | undefined): string[] | null {
  const ids = [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
  return ids.length > 0 ? ids : null;
}

function parseOptionalTimestamp(value: string | undefined): number | null {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
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
  const cleanupBatchBytes = parsePositiveInteger(
    env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES,
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES
  );
  const cleanupMaxRowBytes = parsePositiveInteger(
    env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES,
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES
  );
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
  const groupedFtsCleanupTriggerRatio = parseBoundedRatio(
    env.PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO,
    DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO
  );
  const groupedFtsCleanupTargetRatio = parseBoundedRatio(
    env.PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO,
    DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO
  );
  const groupedFtsCleanupRatiosAreOrdered =
    groupedFtsCleanupTargetRatio < groupedFtsCleanupTriggerRatio;
  const groupedFtsCleanupMinSessionAgeDays = parseNonNegativeInteger(
    env.PROJECT_DATA_GROUPED_FTS_CLEANUP_MIN_SESSION_AGE_DAYS,
    DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_MIN_SESSION_AGE_DAYS
  );
  const storageReliefMeasureMaxBatchRows = parsePositiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS
  );
  const storageReliefMeasureBatchRows = parsePositiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_MEASURE_BATCH_ROWS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_MEASURE_BATCH_ROWS
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
    toolPayloadCleanupExactConfigValid:
      optionalRatioIsValid(env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO) &&
      optionalRatioIsValid(env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO) &&
      cleanupRatiosAreOrdered &&
      cleanupMaxRowBytes <= cleanupBatchBytes &&
      [
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS,
        env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS,
        env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS,
        env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS,
        env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES,
        env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES,
        env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES,
      ].every(optionalPositiveIntegerIsValid),
    toolPayloadCleanupPlanId: env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID?.trim() || null,
    toolPayloadCleanupManifestKey:
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY?.trim() || null,
    toolPayloadCleanupManifestSha256:
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256?.trim() || null,
    toolPayloadCleanupBatchManifestMaxBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES,
      DEFAULT_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES
    ),
    toolPayloadCleanupRootManifestMaxBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES,
      DEFAULT_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES
    ),
    toolPayloadCleanupMaxTotalRows: parseOptionalPositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS
    ),
    toolPayloadCleanupMaxTotalBytes: parseOptionalPositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES
    ),
    toolPayloadCleanupMaxTotalR2Operations: parseOptionalPositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS
    ),
    toolPayloadCleanupMaxTotalWallTimeMs: parseOptionalPositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS
    ),
    toolPayloadCleanupProjectIds: parseOptionalIdList(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS
    ),
    toolPayloadCleanupCutoffCreatedAt: parseOptionalTimestamp(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT
    ),
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
    toolPayloadCleanupBatchBytes: cleanupBatchBytes,
    toolPayloadCleanupMaxRowBytes: cleanupMaxRowBytes,
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
    toolPayloadManualCleanupMaxBatchRows: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS
    ),
    toolPayloadManualCleanupMaxBatchBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_BYTES,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_BYTES
    ),
    toolPayloadManualCleanupMaxWallTimeMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_WALL_TIME_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_WALL_TIME_MS
    ),
    toolPayloadManualCleanupRecheckMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS
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
    toolPayloadArchiveMaxOperations: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS
    ),
    toolPayloadArchiveRetryDelayMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS
    ),
    toolPayloadArchiveChunkBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES
    ),
    toolPayloadArchiveMaxMetadataBytes: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES
    ),
    storageReliefMeasureBatchRows: Math.min(
      storageReliefMeasureBatchRows,
      storageReliefMeasureMaxBatchRows
    ),
    storageReliefMeasureMaxBatchRows,
    groupedFtsCleanupEnabled:
      (env.PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED ?? '').trim().toLowerCase() === 'true',
    groupedFtsCleanupTriggerRatio: groupedFtsCleanupRatiosAreOrdered
      ? groupedFtsCleanupTriggerRatio
      : DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO,
    groupedFtsCleanupTargetRatio: groupedFtsCleanupRatiosAreOrdered
      ? groupedFtsCleanupTargetRatio
      : DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO,
    groupedFtsCleanupBatchSessions: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS
    ),
    groupedFtsCleanupBatchRows: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_ROWS,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_ROWS
    ),
    groupedFtsCleanupBatchBytes: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_BYTES,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_BYTES
    ),
    groupedFtsCleanupMinSessionAgeMs: groupedFtsCleanupMinSessionAgeDays * 24 * 60 * 60 * 1000,
    groupedFtsCleanupRecheckMs: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS
    ),
    groupedFtsCleanupWallTimeMs: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_TIME_MS,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_TIME_MS
    ),
    groupedFtsCleanupWallUnsafeRatio: parseBoundedRatio(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO
    ),
    groupedFtsCleanupWeakReclaimBytes: parsePositiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_WEAK_RECLAIM_BYTES,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_WEAK_RECLAIM_BYTES
    ),
    eventLogCleanupEnabled:
      (env.PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED ?? '').trim().toLowerCase() === 'true',
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
  // Scope, not just the global flag. `runProjectDataToolPayloadCleanup` refuses any project
  // outside PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS one call later, so scheduling a
  // cleanup alarm for one is scheduling work that cannot happen. On 2026-09-14 that put every
  // ProjectData object in the installation into a hot alarm loop: ~20 objects the allowlist
  // excluded each ran 200-380x their normal read volume. Sharing one predicate with the
  // executor is what stops the two drifting apart again.
  const cleanupInScope =
    config.toolPayloadCleanupEnabled &&
    isProjectInToolPayloadCleanupScope(
      readMeta(sql, 'projectId') ?? '',
      config.toolPayloadCleanupProjectIds,
      false
    );
  // Every cleanup-derived time below is a timestamp that only a pass which RUNS TO COMPLETION
  // advances. `createToolPayloadCleanupPlan` has eight distinct `return null` refusal paths, and
  // `writeProjectDataToolPayloadArchiveLastRunAt` sits behind `!shouldContinue` deep in the
  // success path, reachable from none of them. So a cleanup timestamp that falls into the past
  // STAYS there, `Math.min` keeps returning it, and the object re-arms on every tick.
  //
  // Measured in production 2026-09-14: ~5.6 alarm firings per second per object, a ~50x
  // invocation increase with per-invocation cost unchanged, across ~21 objects. There is no
  // platform backoff bounding this — the loop runs through a SUCCESSFUL `alarm()` whose
  // `finally { recalculateAlarm() }` re-arms with a time still <= now, so Cloudflare's
  // throw/retry mechanism is never involved and nothing throttles it but round-trip latency.
  //
  // Clamping here is deliberately structural rather than per-refusal: enumerating which refusals
  // can leave which marker stale is exactly the reasoning that produced the incident. Whatever
  // the executor decides, the schedule must move forward.
  const notBefore = (at: number | null): number | null =>
    at === null ? null : Math.max(at, now + STORAGE_SAFETY_MIN_ALARM_SPACING_MS);

  const cleanupRecheckAt = cleanupInScope
    ? notBefore(readProjectDataToolPayloadCleanupRecheckAt(sql))
    : null;
  const archiveLastRunAt = cleanupInScope ? readProjectDataToolPayloadArchiveLastRunAt(sql) : null;
  let archiveRunAt: number | null = null;
  if (cleanupInScope) {
    // `null` here means "never run", which the original code turned into `now` — a condition a
    // refused pass cannot clear. `notBefore` covers both that case and the subtler one the
    // scope gate does not: a project that DID complete an archive pass once, then regressed into
    // a refusal, whose `archiveLastRunAt + interval` is a fixed point that real time walks past.
    // Two different jobs here, and both are needed.
    //   - The `null` branch is SEMANTIC: "never run" means due one interval from now, not now.
    //     Letting the generic clamp handle it would schedule every never-run in-scope object a
    //     minute out, which is no longer a spin but is still ~60 wasted alarms an hour each.
    //   - `notBefore` is the SAFETY NET for the non-null branch: a project that completed a pass
    //     and then regressed into a refusal has a fixed `archiveLastRunAt + interval` that real
    //     time simply walks past, and nothing will ever advance it.
    archiveRunAt = notBefore(
      archiveLastRunAt === null
        ? now + config.toolPayloadArchiveIntervalMs
        : archiveLastRunAt + config.toolPayloadArchiveIntervalMs
    );
  }
  // Same clamp for the sibling cleaners. Neither has a project-scope allowlist today, so neither
  // can reproduce the scheduler/executor scope divergence above — but both are gated flags slated
  // to be enabled, and both read a marker only their own successful pass advances. If a scope
  // allowlist is ever added to either, `cleanupInScope`'s treatment must be extended to it in the
  // same change (.claude/rules/74-proxy-signals-must-match-the-condition.md).
  const groupedFtsCleanupRecheckAt = config.groupedFtsCleanupEnabled
    ? notBefore(readProjectDataGroupedFtsCleanupRecheckAt(sql))
    : null;
  const eventLogCleanupRecheckAt = config.eventLogCleanupEnabled
    ? notBefore(readProjectDataEventLogCleanupRecheckAt(sql))
    : null;
  return Math.min(
    measureAt,
    ...[
      cleanupRecheckAt,
      archiveRunAt,
      groupedFtsCleanupRecheckAt,
      eventLogCleanupRecheckAt,
    ].filter((value): value is number => value !== null)
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
