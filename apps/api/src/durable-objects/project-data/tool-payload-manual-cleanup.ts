import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import {
  classifyStorageUsage,
  resolveStorageSafetyConfig,
  type StorageSafetyConfig,
} from './storage-safety';
import {
  deleteStorageSafetyMeta as deleteMeta,
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
  truncateStorageSafetyMetaValue as truncate,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import {
  enrichProjectDataStorageTelemetry,
  upsertProjectDataStorageTelemetry,
} from './storage-telemetry';
import { runProjectDataToolPayloadCleanup } from './tool-payload-cleanup';
import {
  PROJECT_DATA_MANUAL_TOOL_PAYLOAD_CLEANUP_RESULT_VERSION as MANUAL_CLEANUP_RESULT_VERSION,
  type ProjectDataManualToolPayloadCleanupBudgets,
  type ProjectDataManualToolPayloadCleanupCooldown,
  type ProjectDataManualToolPayloadCleanupInput,
  type ProjectDataManualToolPayloadCleanupResult,
  type ProjectDataManualToolPayloadCleanupSkipReason,
  ProjectDataManualToolPayloadCleanupStateError,
  type ProjectDataManualToolPayloadCleanupTelemetry,
  type ProjectDataManualToolPayloadCleanupTerminationReason,
  type ProjectDataToolPayloadCleanupOptions,
  type ProjectDataToolPayloadCleanupResult,
} from './tool-payload-cleanup-types';
import type { Env } from './types';

const log = createModuleLogger('project_data.tool_payload_manual_cleanup');

const META_MANUAL_CLEANUP_IDEMPOTENCY_KEY = 'storageSafetyToolPayloadManualCleanupIdempotencyKey';
const META_MANUAL_CLEANUP_FINGERPRINT = 'storageSafetyToolPayloadManualCleanupFingerprint';
const META_MANUAL_CLEANUP_REASON = 'storageSafetyToolPayloadManualCleanupReason';
const META_MANUAL_CLEANUP_STARTED_AT = 'storageSafetyToolPayloadManualCleanupStartedAt';
const META_MANUAL_CLEANUP_NEXT_ALLOWED_AT = 'storageSafetyToolPayloadManualCleanupNextAllowedAt';
const META_MANUAL_CLEANUP_RESULT_JSON = 'storageSafetyToolPayloadManualCleanupResultJson';

const MAX_MANUAL_CLEANUP_REASON_LENGTH = 500;
const MAX_MANUAL_CLEANUP_IDEMPOTENCY_KEY_LENGTH = 200;
const MANUAL_TOOL_PAYLOAD_CLEANUP_PURGE_REASON = 'manual_tool_payload_archive_cleanup';

function readStoredResult(sql: SqlStorage): ProjectDataManualToolPayloadCleanupResult | null {
  const raw = readMeta(sql, META_MANUAL_CLEANUP_RESULT_JSON);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonRecord(parsed)) return null;
    if (parsed.version !== MANUAL_CLEANUP_RESULT_VERSION) return null;
    if (typeof parsed.projectId !== 'string') return null;
    if (typeof parsed.idempotencyKey !== 'string') return null;
    return parsed as ProjectDataManualToolPayloadCleanupResult;
  } catch {
    return null;
  }
}

function normalizeRequiredString(
  value: string,
  field: 'reason' | 'idempotencyKey',
  maxLength: number
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ProjectDataManualToolPayloadCleanupStateError(
      'invalid_request',
      `${field} is required`
    );
  }
  if (normalized.length > maxLength) {
    throw new ProjectDataManualToolPayloadCleanupStateError(
      'invalid_request',
      `${field} must be ${maxLength} characters or fewer`
    );
  }
  return normalized;
}

function resolveBudgetValue(
  field: 'batchRows' | 'batchBytes' | 'wallTimeMs',
  requested: number | null | undefined,
  fallback: number,
  maximum: number
): number {
  if (requested === null || requested === undefined) return Math.min(fallback, maximum);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum) {
    throw new ProjectDataManualToolPayloadCleanupStateError(
      'invalid_request',
      `${field} must be between 1 and ${maximum}`
    );
  }
  return requested;
}

function resolveBudgets(
  config: StorageSafetyConfig,
  input: Pick<ProjectDataManualToolPayloadCleanupInput, 'batchRows' | 'batchBytes' | 'wallTimeMs'>
): ProjectDataManualToolPayloadCleanupBudgets {
  const maxBatchRows = config.toolPayloadManualCleanupMaxBatchRows;
  const maxBatchBytes = config.toolPayloadManualCleanupMaxBatchBytes;
  const maxWallTimeMs = config.toolPayloadManualCleanupMaxWallTimeMs;
  return {
    batchRows: resolveBudgetValue(
      'batchRows',
      input.batchRows,
      config.toolPayloadCleanupBatchRows,
      maxBatchRows
    ),
    batchBytes: resolveBudgetValue(
      'batchBytes',
      input.batchBytes,
      config.toolPayloadCleanupBatchBytes,
      maxBatchBytes
    ),
    wallTimeMs: resolveBudgetValue(
      'wallTimeMs',
      input.wallTimeMs,
      config.toolPayloadCleanupWallTimeMs,
      maxWallTimeMs
    ),
    maxBatchRows,
    maxBatchBytes,
    maxWallTimeMs,
    recheckMs: config.toolPayloadManualCleanupRecheckMs,
  };
}

function buildFingerprint(input: {
  reason: string;
  budgets: ProjectDataManualToolPayloadCleanupBudgets;
  cutoffCreatedAt: number | null;
}): string {
  return JSON.stringify({
    reason: input.reason,
    cutoffCreatedAt: input.cutoffCreatedAt,
    batchRows: input.budgets.batchRows,
    batchBytes: input.budgets.batchBytes,
    wallTimeMs: input.budgets.wallTimeMs,
  });
}

function buildLegacyFingerprint(input: {
  reason: string;
  budgets: ProjectDataManualToolPayloadCleanupBudgets;
}): string {
  return JSON.stringify({
    reason: input.reason,
    batchRows: input.budgets.batchRows,
    batchBytes: input.budgets.batchBytes,
    wallTimeMs: input.budgets.wallTimeMs,
  });
}

function readManualNextAllowedAt(sql: SqlStorage): number | null {
  return readMetaNumber(sql, META_MANUAL_CLEANUP_NEXT_ALLOWED_AT);
}

function buildCooldown(
  nextAllowedAt: number,
  recheckMs: number,
  now: number
): ProjectDataManualToolPayloadCleanupCooldown {
  const remainingMs = Math.max(nextAllowedAt - now, 0);
  return {
    active: remainingMs > 0,
    nextAllowedAt,
    remainingMs,
    recheckMs,
  };
}

function telemetryFromCleanup(
  cleanup: ProjectDataToolPayloadCleanupResult | null,
  fallback: {
    beforeBytes: number;
    afterBytes: number;
    terminationReason: ProjectDataManualToolPayloadCleanupTerminationReason;
  }
): ProjectDataManualToolPayloadCleanupTelemetry {
  if (!cleanup) {
    return {
      beforeBytes: fallback.beforeBytes,
      afterBytes: fallback.afterBytes,
      reclaimedBytes: Math.max(fallback.beforeBytes - fallback.afterBytes, 0),
      terminationReason: fallback.terminationReason,
      rowsScanned: 0,
      rowsUpdated: 0,
      rowsFailed: 0,
      sessionsScanned: 0,
      originalToolMetadataBytes: 0,
      storedToolMetadataBytes: 0,
      exhaustedCandidates: false,
      cursor: null,
      recheckAt: null,
    };
  }
  return {
    beforeBytes: cleanup.beforeBytes,
    afterBytes: cleanup.afterBytes,
    reclaimedBytes: cleanup.reclaimedBytes,
    terminationReason: cleanup.terminationReason,
    rowsScanned: cleanup.rowsScanned,
    rowsUpdated: cleanup.rowsUpdated,
    rowsFailed: cleanup.rowsFailed,
    sessionsScanned: cleanup.sessionsScanned,
    originalToolMetadataBytes: cleanup.originalToolMetadataBytes,
    storedToolMetadataBytes: cleanup.storedToolMetadataBytes,
    exhaustedCandidates: cleanup.exhaustedCandidates,
    cursor: cleanup.cursor,
    recheckAt: cleanup.recheckAt,
  };
}

function buildSkippedResult(input: {
  projectId: string;
  reason: string;
  idempotencyKey: string;
  skipReason: ProjectDataManualToolPayloadCleanupSkipReason;
  startedAt: number;
  budgets: ProjectDataManualToolPayloadCleanupBudgets;
  nextAllowedAt: number;
  beforeBytes: number;
}): ProjectDataManualToolPayloadCleanupResult {
  return {
    version: MANUAL_CLEANUP_RESULT_VERSION,
    projectId: input.projectId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    idempotent: false,
    attempted: false,
    skipReason: input.skipReason,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    budgets: input.budgets,
    cooldown: buildCooldown(input.nextAllowedAt, input.budgets.recheckMs, input.startedAt),
    telemetry: telemetryFromCleanup(null, {
      beforeBytes: input.beforeBytes,
      afterBytes: input.beforeBytes,
      terminationReason: input.skipReason,
    }),
    cleanup: null,
  };
}

function updateReplayCooldown(
  result: ProjectDataManualToolPayloadCleanupResult,
  now: number
): ProjectDataManualToolPayloadCleanupResult {
  const nextAllowedAt = readResultNextAllowedAt(result);
  return {
    ...result,
    idempotent: true,
    cooldown: buildCooldown(nextAllowedAt, result.budgets.recheckMs, now),
  };
}

function readResultNextAllowedAt(result: ProjectDataManualToolPayloadCleanupResult): number {
  return result.cooldown.nextAllowedAt;
}

function persistStarted(
  sql: SqlStorage,
  input: {
    idempotencyKey: string;
    fingerprint: string;
    reason: string;
    startedAt: number;
    nextAllowedAt: number;
  }
): void {
  writeMeta(sql, META_MANUAL_CLEANUP_IDEMPOTENCY_KEY, input.idempotencyKey);
  writeMeta(sql, META_MANUAL_CLEANUP_FINGERPRINT, input.fingerprint);
  writeMeta(
    sql,
    META_MANUAL_CLEANUP_REASON,
    truncate(input.reason, MAX_MANUAL_CLEANUP_REASON_LENGTH)
  );
  writeMeta(sql, META_MANUAL_CLEANUP_STARTED_AT, String(input.startedAt));
  writeMeta(sql, META_MANUAL_CLEANUP_NEXT_ALLOWED_AT, String(input.nextAllowedAt));
  deleteMeta(sql, META_MANUAL_CLEANUP_RESULT_JSON);
}

function persistCompleted(
  sql: SqlStorage,
  result: ProjectDataManualToolPayloadCleanupResult
): void {
  writeMeta(sql, META_MANUAL_CLEANUP_RESULT_JSON, JSON.stringify(result));
}

function buildManualConfig(
  config: StorageSafetyConfig,
  budgets: ProjectDataManualToolPayloadCleanupBudgets
): StorageSafetyConfig {
  return {
    ...config,
    enabled: true,
    toolPayloadCleanupEnabled: true,
    toolPayloadCleanupBatchRows: budgets.batchRows,
    toolPayloadCleanupBatchBytes: budgets.batchBytes,
    toolPayloadCleanupWallTimeMs: budgets.wallTimeMs,
    toolPayloadCleanupRecheckMs: budgets.recheckMs,
  };
}

function cleanupTelemetryOptions(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  transactionSync?: <T>(callback: () => T) => T,
  now?: number,
  nowMs?: () => number
): ProjectDataToolPayloadCleanupOptions {
  return {
    allowStart: true,
    forceStart: true,
    ...(now !== undefined ? { now } : {}),
    ...(nowMs ? { nowMs } : {}),
    ...(transactionSync ? { transactionSync } : {}),
    classifyStatus: (databaseSizeBytes) => classifyStorageUsage(databaseSizeBytes, config),
    recordTelemetry: async (telemetry, fields) => {
      const enriched = await enrichProjectDataStorageTelemetry(sql, env, telemetry, config, {
        includeCategoryBreakdown: false,
      });
      await upsertProjectDataStorageTelemetry(env, enriched, fields);
    },
    purgeReason: MANUAL_TOOL_PAYLOAD_CLEANUP_PURGE_REASON,
  };
}

export async function runProjectDataManualToolPayloadCleanup(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  input: ProjectDataManualToolPayloadCleanupInput,
  options: { transactionSync?: <T>(callback: () => T) => T } = {}
): Promise<ProjectDataManualToolPayloadCleanupResult> {
  const now = input.now ?? Date.now();
  const config = resolveStorageSafetyConfig(env);
  const budgets = resolveBudgets(config, input);
  const reason = normalizeRequiredString(input.reason, 'reason', MAX_MANUAL_CLEANUP_REASON_LENGTH);
  const idempotencyKey = normalizeRequiredString(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_MANUAL_CLEANUP_IDEMPOTENCY_KEY_LENGTH
  );
  const fingerprint = buildFingerprint({
    reason,
    budgets,
    cutoffCreatedAt: config.toolPayloadCleanupCutoffCreatedAt,
  });
  const compatibleLegacyFingerprint =
    config.toolPayloadCleanupCutoffCreatedAt === null
      ? buildLegacyFingerprint({ reason, budgets })
      : null;
  const beforeBytes = sql.databaseSize;
  const resolvedProjectId = projectId?.trim() || '';
  if (!resolvedProjectId) {
    return buildSkippedResult({
      projectId: '',
      reason,
      idempotencyKey,
      skipReason: 'missing_project_id',
      startedAt: now,
      budgets,
      nextAllowedAt: now + budgets.recheckMs,
      beforeBytes,
    });
  }

  const existingKey = readMeta(sql, META_MANUAL_CLEANUP_IDEMPOTENCY_KEY);
  const existingFingerprint = readMeta(sql, META_MANUAL_CLEANUP_FINGERPRINT);
  if (existingKey === idempotencyKey) {
    // `compatibleLegacyFingerprint` is null whenever an exact cutoff is configured.
    // Comparing against it directly would let a MISSING stored fingerprint (also null)
    // silently pass as compatible, so a reused key could replay or start cleanup with
    // different inputs. Require a real legacy fingerprint before accepting it.
    const matchesLegacyFingerprint =
      compatibleLegacyFingerprint !== null && existingFingerprint === compatibleLegacyFingerprint;
    if (existingFingerprint !== fingerprint && !matchesLegacyFingerprint) {
      throw new ProjectDataManualToolPayloadCleanupStateError(
        'idempotency_conflict',
        'idempotencyKey was already used with different manual cleanup input'
      );
    }
    const stored = readStoredResult(sql);
    if (stored) return updateReplayCooldown(stored, now);

    const inProgressNextAllowedAt = readManualNextAllowedAt(sql);
    if (inProgressNextAllowedAt !== null && inProgressNextAllowedAt > now) {
      return buildSkippedResult({
        projectId: resolvedProjectId,
        reason,
        idempotencyKey,
        skipReason: 'idempotency_in_progress',
        startedAt: now,
        budgets,
        nextAllowedAt: inProgressNextAllowedAt,
        beforeBytes,
      });
    }
  }

  const nextAllowedAt = readManualNextAllowedAt(sql);
  if (nextAllowedAt !== null && nextAllowedAt > now) {
    return buildSkippedResult({
      projectId: resolvedProjectId,
      reason,
      idempotencyKey,
      skipReason: 'cooldown',
      startedAt: now,
      budgets,
      nextAllowedAt,
      beforeBytes,
    });
  }

  const newNextAllowedAt = now + budgets.recheckMs;
  const transactionSync = options.transactionSync ?? (<T>(callback: () => T): T => callback());
  transactionSync(() =>
    persistStarted(sql, {
      idempotencyKey,
      fingerprint,
      reason,
      startedAt: now,
      nextAllowedAt: newNextAllowedAt,
    })
  );

  const manualConfig = buildManualConfig(config, budgets);
  const cleanup = await runProjectDataToolPayloadCleanup(
    sql,
    env,
    resolvedProjectId,
    manualConfig,
    cleanupTelemetryOptions(sql, env, manualConfig, options.transactionSync, now, input.nowMs)
  );
  const completedAt = input.nowMs?.() ?? Date.now();
  const afterBytes = sql.databaseSize;
  const result: ProjectDataManualToolPayloadCleanupResult = {
    version: MANUAL_CLEANUP_RESULT_VERSION,
    projectId: resolvedProjectId,
    reason,
    idempotencyKey,
    idempotent: false,
    attempted: true,
    skipReason: cleanup ? null : 'not_needed',
    startedAt: now,
    completedAt,
    budgets,
    cooldown: buildCooldown(newNextAllowedAt, budgets.recheckMs, completedAt),
    telemetry: telemetryFromCleanup(cleanup, {
      beforeBytes,
      afterBytes,
      terminationReason: cleanup ? cleanup.terminationReason : 'not_needed',
    }),
    cleanup,
  };
  transactionSync(() => persistCompleted(sql, result));
  log.warn('completed', {
    projectId: resolvedProjectId,
    reason: truncate(reason, MAX_MANUAL_CLEANUP_REASON_LENGTH),
    idempotent: result.idempotent,
    skipReason: result.skipReason,
    terminationReason: result.telemetry.terminationReason,
    rowsUpdated: result.telemetry.rowsUpdated,
    reclaimedBytes: result.telemetry.reclaimedBytes,
  });
  return result;
}
