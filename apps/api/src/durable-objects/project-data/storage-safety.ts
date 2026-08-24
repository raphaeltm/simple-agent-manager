/**
 * ProjectData storage safety firebreak.
 *
 * This module intentionally avoids sharding or broad data movement. It provides:
 * - direct per-object `databaseSize` measurement from SQLite-backed DO storage;
 * - D1 telemetry and throttled observability alerts;
 * - a bounded, explicit emergency purge of low-value event logs.
 */
import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { persistError } from '../../services/observability';
import { stripToolMetadataPayloadForStorage } from './tool-metadata-storage';
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
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO = 0.8;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO = 0.75;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS = 500;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS = 7;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS = 60 * 1000;
export const DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM = 25;

const META_LAST_MEASURED_AT = 'storageSafetyLastMeasuredAt';
const META_LAST_STATUS = 'storageSafetyLastStatus';
const META_LAST_ALERT_AT = 'storageSafetyLastAlertAt';
const META_LAST_ALERT_STATUS = 'storageSafetyLastAlertStatus';
const META_LAST_ERROR = 'storageSafetyLastError';
const META_TOOL_CLEANUP_CURSOR_SESSION_ID = 'storageSafetyToolCleanupCursorSessionId';
const META_TOOL_CLEANUP_CURSOR_CREATED_AT = 'storageSafetyToolCleanupCursorCreatedAt';
const META_TOOL_CLEANUP_CURSOR_SEQUENCE = 'storageSafetyToolCleanupCursorSequence';
const META_TOOL_CLEANUP_CURSOR_MESSAGE_ID = 'storageSafetyToolCleanupCursorMessageId';
const META_TOOL_CLEANUP_RECHECK_AT = 'storageSafetyToolCleanupRecheckAt';
const TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID = '__session_exhausted__';

export interface ProjectDataStorageTelemetry {
  projectId: string;
  measuredAt: number;
  databaseSizeBytes: number;
  limitBytes: number;
  usageRatio: number;
  status: ProjectDataStorageStatus;
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

export interface ProjectDataToolPayloadCleanupResult {
  projectId: string;
  beforeBytes: number;
  afterBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  cursor:
    | {
        sessionId: string;
        createdAt: number;
        sequence: number;
        messageId: string;
      }
    | null;
  exhaustedCandidates: boolean;
  recheckAt: number | null;
}

export interface ProjectDataStorageAlarmResult {
  measurement: ProjectDataStorageTelemetry | null;
  cleanup: ProjectDataToolPayloadCleanupResult | null;
}

interface StorageSafetyConfig {
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
  toolPayloadCleanupEnabled: boolean;
  toolPayloadCleanupTriggerRatio: number;
  toolPayloadCleanupTargetRatio: number;
  toolPayloadCleanupBatchRows: number;
  toolPayloadCleanupMinSessionAgeMs: number;
  toolPayloadCleanupRecheckMs: number;
  toolPayloadCleanupMaxSessionsPerAlarm: number;
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
    toolPayloadCleanupMinSessionAgeMs: cleanupMinSessionAgeDays * 24 * 60 * 60 * 1000,
    toolPayloadCleanupRecheckMs: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    ),
    toolPayloadCleanupMaxSessionsPerAlarm: parsePositiveInteger(
      env.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM,
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_SESSIONS_PER_ALARM
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

function readMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec('SELECT value FROM do_meta WHERE key = ?', key).toArray()[0];
  if (!isJsonRecord(row)) return null;
  const value = (row as Record<string, unknown>).value;
  return typeof value === 'string' ? value : null;
}

function readMetaNumber(sql: SqlStorage, key: string): number | null {
  const raw = readMeta(sql, key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function writeMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    `INSERT INTO do_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

function deleteMeta(sql: SqlStorage, key: string): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', key);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function buildTelemetry(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  measuredAt: number = Date.now()
): ProjectDataStorageTelemetry {
  const config = resolveStorageSafetyConfig(env);
  const databaseSizeBytes = sql.databaseSize;
  const usageRatio = databaseSizeBytes / config.limitBytes;
  return {
    projectId,
    measuredAt,
    databaseSizeBytes,
    limitBytes: config.limitBytes,
    usageRatio,
    status: classifyStorageUsage(databaseSizeBytes, config),
  };
}

async function upsertTelemetry(
  env: Env,
  telemetry: ProjectDataStorageTelemetry,
  fields: {
    lastAlarmAt?: number | null;
    lastAlertAt?: number | null;
    lastAlertStatus?: ProjectDataStorageStatus | null;
    lastPurgeAt?: number | null;
    lastPurgeReason?: string | null;
    lastPurgeRows?: number | null;
    lastPurgeDatabaseSizeBytes?: number | null;
    lastError?: string | null;
  } = {}
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO project_data_storage_telemetry (
       project_id,
       measured_at,
       database_size_bytes,
       limit_bytes,
       usage_ratio,
       status,
       last_alarm_at,
       last_alert_at,
       last_alert_status,
       last_purge_at,
       last_purge_reason,
       last_purge_rows,
       last_purge_database_size_bytes,
       last_error,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       measured_at = excluded.measured_at,
       database_size_bytes = excluded.database_size_bytes,
       limit_bytes = excluded.limit_bytes,
       usage_ratio = excluded.usage_ratio,
       status = excluded.status,
       last_alarm_at = COALESCE(excluded.last_alarm_at, project_data_storage_telemetry.last_alarm_at),
       last_alert_at = COALESCE(excluded.last_alert_at, project_data_storage_telemetry.last_alert_at),
       last_alert_status = COALESCE(excluded.last_alert_status, project_data_storage_telemetry.last_alert_status),
       last_purge_at = COALESCE(excluded.last_purge_at, project_data_storage_telemetry.last_purge_at),
       last_purge_reason = COALESCE(excluded.last_purge_reason, project_data_storage_telemetry.last_purge_reason),
       last_purge_rows = COALESCE(excluded.last_purge_rows, project_data_storage_telemetry.last_purge_rows),
       last_purge_database_size_bytes = COALESCE(excluded.last_purge_database_size_bytes, project_data_storage_telemetry.last_purge_database_size_bytes),
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  )
    .bind(
      telemetry.projectId,
      telemetry.measuredAt,
      telemetry.databaseSizeBytes,
      telemetry.limitBytes,
      telemetry.usageRatio,
      telemetry.status,
      fields.lastAlarmAt ?? null,
      fields.lastAlertAt ?? null,
      fields.lastAlertStatus ?? null,
      fields.lastPurgeAt ?? null,
      fields.lastPurgeReason ? truncate(fields.lastPurgeReason, 500) : null,
      fields.lastPurgeRows ?? null,
      fields.lastPurgeDatabaseSizeBytes ?? null,
      fields.lastError ? truncate(fields.lastError, 1000) : null,
      Date.now()
    )
    .run();
}

async function maybePersistStorageAlert(
  sql: SqlStorage,
  env: Env,
  telemetry: ProjectDataStorageTelemetry
): Promise<void> {
  if (telemetry.status !== 'critical' && telemetry.status !== 'degraded') return;
  const config = resolveStorageSafetyConfig(env);
  const now = Date.now();
  const lastAlertAt = readMetaNumber(sql, META_LAST_ALERT_AT);
  const lastAlertStatus = readMeta(sql, META_LAST_ALERT_STATUS);
  if (
    lastAlertAt !== null &&
    now - lastAlertAt < config.alertIntervalMs &&
    lastAlertStatus === telemetry.status
  ) {
    return;
  }

  writeMeta(sql, META_LAST_ALERT_AT, String(now));
  writeMeta(sql, META_LAST_ALERT_STATUS, telemetry.status);

  log.error('threshold_exceeded', {
    projectId: telemetry.projectId,
    status: telemetry.status,
    databaseSizeBytes: telemetry.databaseSizeBytes,
    limitBytes: telemetry.limitBytes,
    usageRatio: telemetry.usageRatio,
  });

  if (!env.OBSERVABILITY_DATABASE) return;

  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: telemetry.status === 'degraded' ? 'error' : 'warn',
      message: `ProjectData storage usage is ${telemetry.status}`,
      context: {
        projectId: telemetry.projectId,
        databaseSizeBytes: telemetry.databaseSizeBytes,
        limitBytes: telemetry.limitBytes,
        usageRatio: telemetry.usageRatio,
        status: telemetry.status,
      },
    },
    undefined
  );

  await upsertTelemetry(env, telemetry, {
    lastAlertAt: now,
    lastAlertStatus: telemetry.status,
  });
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
    ? readMetaNumber(sql, META_TOOL_CLEANUP_RECHECK_AT)
    : null;
  if (cleanupRecheckAt === null) return measureAt;
  return Math.min(measureAt, cleanupRecheckAt);
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

  const telemetry = buildTelemetry(sql, env, projectId);
  writeMeta(sql, META_LAST_MEASURED_AT, String(telemetry.measuredAt));
  writeMeta(sql, META_LAST_STATUS, telemetry.status);

  try {
    await upsertTelemetry(env, telemetry, {
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
    await maybePersistStorageAlert(sql, env, telemetry);
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

type ToolPayloadCleanupCursor = {
  sessionId: string;
  createdAt: number;
  sequence: number;
  messageId: string;
};

type ToolPayloadCandidate = ToolPayloadCleanupCursor & {
  toolMetadata: string;
};

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function readToolPayloadCleanupCursor(sql: SqlStorage): ToolPayloadCleanupCursor | null {
  const sessionId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  const createdAt = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  const sequence = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  const messageId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  if (!sessionId || createdAt === null || sequence === null || !messageId) return null;
  return { sessionId, createdAt, sequence, messageId };
}

function writeToolPayloadCleanupCursor(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor,
  recheckAt: number
): void {
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID, cursor.sessionId);
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT, String(cursor.createdAt));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE, String(cursor.sequence));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID, cursor.messageId);
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
}

function clearToolPayloadCleanupState(sql: SqlStorage): void {
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_RECHECK_AT);
}

function isSessionExhaustedCursor(cursor: ToolPayloadCleanupCursor): boolean {
  return (
    cursor.createdAt === Number.MAX_SAFE_INTEGER &&
    cursor.sequence === Number.MAX_SAFE_INTEGER &&
    cursor.messageId === TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID
  );
}

function buildSessionExhaustedCursor(sessionId: string): ToolPayloadCleanupCursor {
  return {
    sessionId,
    createdAt: Number.MAX_SAFE_INTEGER,
    sequence: Number.MAX_SAFE_INTEGER,
    messageId: TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID,
  };
}

function publicToolPayloadCleanupCursor(
  cursor: ToolPayloadCleanupCursor | null
): ProjectDataToolPayloadCleanupResult['cursor'] {
  if (!cursor) return null;
  return {
    sessionId: cursor.sessionId,
    createdAt: cursor.createdAt,
    sequence: cursor.sequence,
    messageId: cursor.messageId,
  };
}

function selectNextTerminalSessionId(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  afterSessionId: string
): string | null {
  const cursor = sql
    .exec(
      `SELECT id
       FROM chat_sessions
       WHERE status IN ('stopped', 'failed')
         AND updated_at <= ?
         AND id > ?
       ORDER BY id ASC
       LIMIT 1`,
      cutoffUpdatedAt,
      afterSessionId
    )
    .raw();

  let sessionId: string | null = null;
  for (const row of cursor) {
    const id = row[0];
    if (typeof id === 'string') sessionId = id;
  }
  return sessionId;
}

function selectToolPayloadCandidates(
  sql: SqlStorage,
  sessionId: string,
  cursor: ToolPayloadCleanupCursor | null,
  limit: number
): ToolPayloadCandidate[] {
  if (cursor && cursor.sessionId === sessionId) {
    const rows = sql
      .exec(
        `SELECT id, created_at, COALESCE(sequence, 0) AS sequence, tool_metadata
         FROM chat_messages
         WHERE session_id = ?
           AND role = 'tool'
           AND tool_metadata IS NOT NULL
           AND tool_metadata LIKE '%"content"%'
           AND (
             created_at > ?
             OR (created_at = ? AND COALESCE(sequence, 0) > ?)
             OR (created_at = ? AND COALESCE(sequence, 0) = ? AND id > ?)
           )
         ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC
         LIMIT ?`,
        sessionId,
        cursor.createdAt,
        cursor.createdAt,
        cursor.sequence,
        cursor.createdAt,
        cursor.sequence,
        cursor.messageId,
        limit
      )
      .raw();
    return parseToolPayloadCandidateRows(sessionId, rows);
  }

  const rows = sql
    .exec(
      `SELECT id, created_at, COALESCE(sequence, 0) AS sequence, tool_metadata
       FROM chat_messages
       WHERE session_id = ?
         AND role = 'tool'
         AND tool_metadata IS NOT NULL
         AND tool_metadata LIKE '%"content"%'
       ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC
       LIMIT ?`,
      sessionId,
      limit
    )
    .raw();
  return parseToolPayloadCandidateRows(sessionId, rows);
}

function parseToolPayloadCandidateRows(
  sessionId: string,
  rows: IterableIterator<unknown[]>
): ToolPayloadCandidate[] {
  const candidates: ToolPayloadCandidate[] = [];
  for (const row of rows) {
    const id = row[0];
    const createdAt = rawNumber(row[1]);
    const sequence = rawNumber(row[2]);
    const toolMetadata = row[3];
    if (
      typeof id === 'string' &&
      createdAt !== null &&
      sequence !== null &&
      typeof toolMetadata === 'string'
    ) {
      candidates.push({ sessionId, createdAt, sequence, messageId: id, toolMetadata });
    }
  }
  return candidates;
}

function updateToolMetadata(sql: SqlStorage, messageId: string, toolMetadata: string | null): void {
  sql.exec('UPDATE chat_messages SET tool_metadata = ? WHERE id = ?', toolMetadata, messageId);
}

export async function runProjectDataToolPayloadCleanup(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  options: { allowStart?: boolean; now?: number } = {}
): Promise<ProjectDataToolPayloadCleanupResult | null> {
  const config = resolveStorageSafetyConfig(env);
  if (!config.enabled || !config.toolPayloadCleanupEnabled || !projectId) return null;
  const now = options.now ?? Date.now();

  const beforeBytes = sql.databaseSize;
  const triggerBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTriggerRatio);
  const targetBytes = Math.floor(config.limitBytes * config.toolPayloadCleanupTargetRatio);
  const pendingCursor = readToolPayloadCleanupCursor(sql);
  const pendingRecheckAt = readMetaNumber(sql, META_TOOL_CLEANUP_RECHECK_AT);
  const hasPendingCleanup = pendingCursor !== null || pendingRecheckAt !== null;

  if (beforeBytes <= targetBytes) {
    clearToolPayloadCleanupState(sql);
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

  const cutoffUpdatedAt = now - config.toolPayloadCleanupMinSessionAgeMs;
  const batchRows = config.toolPayloadCleanupBatchRows;
  let cursor = pendingCursor;
  let sessionId = cursor
    ? isSessionExhaustedCursor(cursor)
      ? selectNextTerminalSessionId(sql, cutoffUpdatedAt, cursor.sessionId)
      : cursor.sessionId
    : selectNextTerminalSessionId(sql, cutoffUpdatedAt, '');
  let sessionsScanned = 0;
  let rowsScanned = 0;
  let rowsUpdated = 0;
  let originalToolMetadataBytes = 0;
  let storedToolMetadataBytes = 0;
  let lastCursor: ToolPayloadCleanupCursor | null = null;
  let lastScannedSessionId: string | null = null;
  let hasMoreCandidates = false;

  while (
    sessionId &&
    rowsScanned < batchRows &&
    sessionsScanned < config.toolPayloadCleanupMaxSessionsPerAlarm
  ) {
    const remainingRows = batchRows - rowsScanned;
    const messageCursor = cursor?.sessionId === sessionId ? cursor : null;
    const candidates = selectToolPayloadCandidates(sql, sessionId, messageCursor, remainingRows);
    lastScannedSessionId = sessionId;
    sessionsScanned++;

    for (const candidate of candidates) {
      rowsScanned++;
      lastCursor = candidate;
      const stripped = stripToolMetadataPayloadForStorage(candidate.toolMetadata, env);
      if (!stripped.stripped) continue;

      updateToolMetadata(sql, candidate.messageId, stripped.value);
      rowsUpdated++;
      originalToolMetadataBytes += stripped.originalBytes;
      storedToolMetadataBytes += stripped.storedBytes;
    }

    if (candidates.length >= remainingRows) {
      hasMoreCandidates = true;
      break;
    }

    sessionId = selectNextTerminalSessionId(sql, cutoffUpdatedAt, sessionId);
    cursor = sessionId ? null : cursor;
  }

  const afterBytes = sql.databaseSize;
  const pausedForSessionScanBudget =
    afterBytes > targetBytes &&
    !hasMoreCandidates &&
    sessionId !== null &&
    sessionsScanned >= config.toolPayloadCleanupMaxSessionsPerAlarm &&
    lastScannedSessionId !== null;
  const continuationCursor = hasMoreCandidates
    ? lastCursor
    : pausedForSessionScanBudget && lastScannedSessionId
      ? buildSessionExhaustedCursor(lastScannedSessionId)
      : null;
  const shouldContinue = afterBytes > targetBytes && continuationCursor !== null;
  const recheckAt = shouldContinue ? now + config.toolPayloadCleanupRecheckMs : null;
  if (continuationCursor && recheckAt !== null) {
    writeToolPayloadCleanupCursor(sql, continuationCursor, recheckAt);
  } else {
    clearToolPayloadCleanupState(sql);
  }

  const exhaustedCandidates =
    afterBytes > targetBytes &&
    !shouldContinue &&
    sessionId === null;

  const result: ProjectDataToolPayloadCleanupResult = {
    projectId,
    beforeBytes,
    afterBytes,
    limitBytes: config.limitBytes,
    triggerBytes,
    targetBytes,
    batchRows,
    sessionsScanned,
    rowsScanned,
    rowsUpdated,
    originalToolMetadataBytes,
    storedToolMetadataBytes,
    cursor: shouldContinue ? publicToolPayloadCleanupCursor(continuationCursor) : null,
    exhaustedCandidates,
    recheckAt,
  };

  if (rowsUpdated > 0) {
    const measuredAt = Date.now();
    writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
    const statusAfter = classifyStorageUsage(afterBytes, config);
    writeMeta(sql, META_LAST_STATUS, statusAfter);
    const telemetry: ProjectDataStorageTelemetry = {
      projectId,
      measuredAt,
      databaseSizeBytes: afterBytes,
      limitBytes: config.limitBytes,
      usageRatio: afterBytes / config.limitBytes,
      status: statusAfter,
    };

    try {
      await upsertTelemetry(env, telemetry, {
        lastPurgeAt: measuredAt,
        lastPurgeReason: 'auto_tool_payload_cleanup',
        lastPurgeRows: rowsUpdated,
        lastPurgeDatabaseSizeBytes: afterBytes,
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMeta(sql, META_LAST_ERROR, truncate(message, 500));
      log.warn('tool_payload_cleanup_telemetry_upsert_failed', {
        projectId,
        ...serializeError(error),
      });
    }
  }

  if (rowsUpdated > 0 || exhaustedCandidates) {
    log.warn('tool_payload_cleanup_completed', { ...result });
  }

  return rowsScanned > 0 || rowsUpdated > 0 || exhaustedCandidates || shouldContinue
    ? result
    : null;
}

export async function runProjectDataStorageSafetyAlarm(
  sql: SqlStorage,
  env: Env,
  projectId: string | null
): Promise<ProjectDataStorageAlarmResult> {
  const now = Date.now();
  let measurement: ProjectDataStorageTelemetry | null = null;
  if (shouldMeasureProjectDataStorage(sql, env, now)) {
    measurement = await measureAndPersistProjectDataStorage(sql, env, projectId, 'alarm');
  }
  const cleanup = await runProjectDataToolPayloadCleanup(sql, env, projectId, {
    allowStart: measurement !== null,
    now,
  });
  return { measurement, cleanup };
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

export async function runProjectDataStorageEmergencyPurge(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  input: ProjectDataStorageEmergencyPurgeInput = {}
): Promise<ProjectDataStorageEmergencyPurgeResult> {
  if (!projectId) {
    throw new Error('ProjectData storage purge requires a persisted projectId');
  }

  const config = resolveStorageSafetyConfig(env);
  const targetRatio = input.targetRatio && input.targetRatio > 0 && input.targetRatio < 1
    ? input.targetRatio
    : config.emergencyTargetRatio;
  const batchRows = input.batchRows && Number.isSafeInteger(input.batchRows) && input.batchRows > 0
    ? input.batchRows
    : config.emergencyBatchRows;
  const maxBatches =
    input.maxBatches && Number.isSafeInteger(input.maxBatches) && input.maxBatches > 0
      ? input.maxBatches
      : config.emergencyMaxBatches;
  const targetBytes = Math.floor(config.limitBytes * targetRatio);
  const reason = truncate(input.reason?.trim() || 'manual_emergency_purge', 500);
  const beforeBytes = sql.databaseSize;
  const statusBefore = classifyStorageUsage(beforeBytes, config);
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
  const statusAfter = classifyStorageUsage(afterBytes, config);
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
  const telemetry: ProjectDataStorageTelemetry = {
    projectId,
    measuredAt,
    databaseSizeBytes: afterBytes,
    limitBytes: config.limitBytes,
    usageRatio: afterBytes / config.limitBytes,
    status: statusAfter,
  };
  writeMeta(sql, META_LAST_MEASURED_AT, String(measuredAt));
  writeMeta(sql, META_LAST_STATUS, statusAfter);

  try {
    await upsertTelemetry(env, telemetry, {
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

  log.warn('emergency_purge_completed', { ...result });
  return result;
}
