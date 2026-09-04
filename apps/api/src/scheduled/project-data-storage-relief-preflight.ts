import type {
  ProjectDataStorageReliefMeasureCursor,
  ProjectDataStorageReliefToolPayloadSessionMeasure,
} from '../durable-objects/project-data/storage-relief-measurement';
import { DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX } from '../durable-objects/project-data/tool-payload-cleanup';
import {
  type ToolPayloadCleanupManifestBatchProof,
  type ToolPayloadCleanupManifestRoot,
  writeToolPayloadCleanupManifestBatch,
  writeToolPayloadCleanupManifestRoot,
} from '../durable-objects/project-data/tool-payload-cleanup-manifest';
import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import { measureProjectDataStorageRelief } from '../services/project-data';

const log = createModuleLogger('project_data.storage_relief_preflight');

export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS = 5_000;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS = 5 * 60 * 1_000;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES = 100;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS = 500_000;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES = 2_000_000_000;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MS = 60_000;
export const DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_WALL_TIME_MS = 20_000;
const PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MARGIN_MS = 5_000;
const PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INNER_RETURN_MARGIN_MS = 500;
const PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_MANIFEST_BYTES = 1_750_000;

type PreflightStatus = 'running' | 'complete' | 'truncated' | 'failed';
type PreflightSkipReason = 'disabled' | 'invalid_config' | 'cadence' | 'leased' | 'terminal';

type PreflightConfig = {
  enabled: boolean;
  planId: string;
  projectId: string;
  cutoffCreatedAt: number;
  configJson: string;
  batchRows: number;
  intervalMs: number;
  maxBatches: number;
  maxRows: number;
  maxBytes: number;
  leaseMs: number;
  wallTimeMs: number;
  archivePrefix: string;
  archiveWriteTimeoutMs: number;
  valid: boolean;
};

type PreflightRow = {
  plan_id: string;
  project_id: string;
  status: PreflightStatus;
  cutoff_created_at: number;
  config_json: string;
  cursor_json: string | null;
  batches_started: number;
  rows_examined: number;
  eligible_rows: number;
  eligible_bytes: number;
  legacy_oversized_rows: number;
  legacy_oversized_bytes: number;
  rearchivable_oversized_rows: number;
  rearchivable_oversized_bytes: number;
  oversized_rows: number;
  oversized_bytes: number;
  archived_rows: number;
  skipped_rows: number;
  session_count: number;
  sessions_json: string;
  sessions_sha256: string | null;
  target_batches_json: string;
  target_manifest_key: string | null;
  target_manifest_bytes: number | null;
  target_manifest_sha256: string | null;
  database_size_bytes: number | null;
  next_eligible_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  started_at: number;
  completed_at: number | null;
  last_error: string | null;
  updated_at: number;
};

export type ProjectDataStorageReliefPreflightResult = {
  enabled: boolean;
  skipped: boolean;
  skipReason: PreflightSkipReason | null;
  planId: string | null;
  projectId: string | null;
  status: PreflightStatus | null;
  cutoffCreatedAt: number | null;
  batchesStarted: number;
  rowsExamined: number;
  eligibleRows: number;
  eligibleBytes: number;
  sessionCount: number;
  sessionManifestSha256: string | null;
  targetManifestKey: string | null;
  targetManifestBytes: number | null;
  targetManifestSha256: string | null;
  databaseSizeBytes: number | null;
  completedAt: number | null;
  lastError: string | null;
};

function positiveInteger(
  raw: string | undefined,
  fallback: number
): { value: number; valid: boolean } {
  const normalized = raw?.trim() ?? '';
  if (!normalized) return { value: fallback, valid: true };
  if (!/^[1-9][0-9]*$/.test(normalized)) return { value: fallback, valid: false };
  const parsed = Number(normalized);
  return {
    value: Number.isSafeInteger(parsed) ? parsed : fallback,
    valid: Number.isSafeInteger(parsed),
  };
}

function requiredTimestamp(raw: string | undefined): number {
  const normalized = raw?.trim() ?? '';
  if (!normalized) return -1;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function configFromEnv(env: Env): PreflightConfig {
  const planId = env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PLAN_ID?.trim() ?? '';
  const projectId = env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PROJECT_ID?.trim() ?? '';
  const cutoffCreatedAt = requiredTimestamp(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT
  );
  const enabled = env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED === 'true';
  const batchRows = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS
  );
  const intervalMs = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS
  );
  const maxBatches = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES
  );
  const maxRows = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS
  );
  const maxBytes = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES
  );
  const leaseMs = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MS
  );
  const wallTimeMs = positiveInteger(
    env.PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_WALL_TIME_MS,
    DEFAULT_PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_WALL_TIME_MS
  );
  const archiveWriteTimeoutMs = positiveInteger(
    env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS,
    5_000
  );
  const archivePrefix =
    env.PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX?.trim() ||
    DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX;
  const configJson = JSON.stringify({
    projectId,
    cutoffCreatedAt,
    batchRows: batchRows.value,
    intervalMs: intervalMs.value,
    maxBatches: maxBatches.value,
    maxRows: maxRows.value,
    maxBytes: maxBytes.value,
    leaseMs: leaseMs.value,
    wallTimeMs: wallTimeMs.value,
    archivePrefix,
    archiveWriteTimeoutMs: archiveWriteTimeoutMs.value,
  });
  return {
    enabled,
    planId,
    projectId,
    cutoffCreatedAt,
    configJson,
    batchRows: batchRows.value,
    intervalMs: intervalMs.value,
    maxBatches: maxBatches.value,
    maxRows: maxRows.value,
    maxBytes: maxBytes.value,
    leaseMs: leaseMs.value,
    wallTimeMs: wallTimeMs.value,
    archivePrefix,
    archiveWriteTimeoutMs: archiveWriteTimeoutMs.value,
    valid: Boolean(
      planId &&
      projectId &&
      cutoffCreatedAt >= 0 &&
      batchRows.valid &&
      intervalMs.valid &&
      maxBatches.valid &&
      maxRows.valid &&
      maxBytes.valid &&
      leaseMs.valid &&
      wallTimeMs.valid &&
      archiveWriteTimeoutMs.valid &&
      leaseMs.value >= wallTimeMs.value + PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_LEASE_MARGIN_MS
    ),
  };
}

function emptyResult(
  config: PreflightConfig,
  skipReason: PreflightSkipReason
): ProjectDataStorageReliefPreflightResult {
  return {
    enabled: config.enabled,
    skipped: true,
    skipReason,
    planId: config.planId || null,
    projectId: config.projectId || null,
    status: null,
    cutoffCreatedAt: config.cutoffCreatedAt >= 0 ? config.cutoffCreatedAt : null,
    batchesStarted: 0,
    rowsExamined: 0,
    eligibleRows: 0,
    eligibleBytes: 0,
    sessionCount: 0,
    sessionManifestSha256: null,
    targetManifestKey: null,
    targetManifestBytes: null,
    targetManifestSha256: null,
    databaseSizeBytes: null,
    completedAt: null,
    lastError: null,
  };
}

function resultFromRow(
  row: PreflightRow,
  skipReason: PreflightSkipReason | null = null
): ProjectDataStorageReliefPreflightResult {
  return {
    enabled: true,
    skipped: skipReason !== null,
    skipReason,
    planId: row.plan_id,
    projectId: row.project_id,
    status: row.status,
    cutoffCreatedAt: row.cutoff_created_at,
    batchesStarted: row.batches_started,
    rowsExamined: row.rows_examined,
    eligibleRows: row.eligible_rows,
    eligibleBytes: row.eligible_bytes,
    sessionCount: row.session_count,
    sessionManifestSha256: row.sessions_sha256,
    targetManifestKey: row.target_manifest_key,
    targetManifestBytes: row.target_manifest_bytes,
    targetManifestSha256: row.target_manifest_sha256,
    databaseSizeBytes: row.database_size_bytes,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

type SessionManifest = Record<
  string,
  Omit<ProjectDataStorageReliefToolPayloadSessionMeasure, 'sessionId'>
>;

function parseSessionManifest(raw: string): SessionManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ProjectData relief preflight session manifest is malformed');
  }
  const numericFields: Array<
    keyof Omit<ProjectDataStorageReliefToolPayloadSessionMeasure, 'sessionId'>
  > = [
    'rowsExamined',
    'eligibleRows',
    'eligibleBytes',
    'legacyOversizedRows',
    'legacyOversizedBytes',
    'rearchivableOversizedRows',
    'rearchivableOversizedBytes',
    'oversizedRows',
    'oversizedBytes',
    'archivedRows',
    'skippedRows',
  ];
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (!sessionId || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ProjectData relief preflight session manifest is malformed');
    }
    const record = value as Record<string, unknown>;
    for (const field of numericFields) {
      if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) {
        throw new Error('ProjectData relief preflight session manifest is malformed');
      }
    }
  }
  return parsed as SessionManifest;
}

function mergeSessionManifest(
  raw: string,
  slices: ProjectDataStorageReliefToolPayloadSessionMeasure[]
): { json: string; count: number } {
  const manifest = parseSessionManifest(raw);
  for (const slice of slices) {
    const current = manifest[slice.sessionId] ?? {
      rowsExamined: 0,
      eligibleRows: 0,
      eligibleBytes: 0,
      legacyOversizedRows: 0,
      legacyOversizedBytes: 0,
      rearchivableOversizedRows: 0,
      rearchivableOversizedBytes: 0,
      oversizedRows: 0,
      oversizedBytes: 0,
      archivedRows: 0,
      skippedRows: 0,
    };
    manifest[slice.sessionId] = {
      rowsExamined: current.rowsExamined + slice.rowsExamined,
      eligibleRows: current.eligibleRows + slice.eligibleRows,
      eligibleBytes: current.eligibleBytes + slice.eligibleBytes,
      legacyOversizedRows: current.legacyOversizedRows + slice.legacyOversizedRows,
      legacyOversizedBytes: current.legacyOversizedBytes + slice.legacyOversizedBytes,
      rearchivableOversizedRows:
        current.rearchivableOversizedRows + slice.rearchivableOversizedRows,
      rearchivableOversizedBytes:
        current.rearchivableOversizedBytes + slice.rearchivableOversizedBytes,
      oversizedRows: current.oversizedRows + slice.oversizedRows,
      oversizedBytes: current.oversizedBytes + slice.oversizedBytes,
      archivedRows: current.archivedRows + slice.archivedRows,
      skippedRows: current.skippedRows + slice.skippedRows,
    };
  }
  const ordered = Object.fromEntries(
    Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right))
  );
  const json = JSON.stringify(ordered);
  if (
    new TextEncoder().encode(json).byteLength >
    PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_MANIFEST_BYTES
  ) {
    throw new Error('ProjectData relief preflight session manifest exceeded its D1 row bound');
  }
  return { json, count: Object.keys(ordered).length };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseTargetBatchProofs(raw: string): ToolPayloadCleanupManifestBatchProof[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('ProjectData relief preflight target batch manifest is malformed');
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ProjectData relief preflight target batch manifest is malformed');
    }
    const proof = value as Record<string, unknown>;
    if (
      proof.ordinal !== index ||
      typeof proof.key !== 'string' ||
      !proof.key ||
      !Number.isSafeInteger(proof.bytes) ||
      Number(proof.bytes) <= 0 ||
      typeof proof.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      !Number.isSafeInteger(proof.targetCount) ||
      Number(proof.targetCount) <= 0 ||
      !Number.isSafeInteger(proof.projectedReclaimableBytes) ||
      Number(proof.projectedReclaimableBytes) <= 0 ||
      !Number.isSafeInteger(proof.firstRowId) ||
      Number(proof.firstRowId) <= 0 ||
      !Number.isSafeInteger(proof.lastRowId) ||
      Number(proof.lastRowId) < Number(proof.firstRowId)
    ) {
      throw new Error('ProjectData relief preflight target batch proof is malformed');
    }
    return {
      ordinal: index,
      key: proof.key,
      bytes: Number(proof.bytes),
      sha256: proof.sha256,
      targetCount: Number(proof.targetCount),
      projectedReclaimableBytes: Number(proof.projectedReclaimableBytes),
      firstRowId: Number(proof.firstRowId),
      lastRowId: Number(proof.lastRowId),
    };
  });
}

function verifySessionManifestTotals(
  manifestJson: string,
  expected: Omit<ProjectDataStorageReliefToolPayloadSessionMeasure, 'sessionId'>
): void {
  const actual = Object.values(parseSessionManifest(manifestJson)).reduce(
    (totals, session) => ({
      rowsExamined: totals.rowsExamined + session.rowsExamined,
      eligibleRows: totals.eligibleRows + session.eligibleRows,
      eligibleBytes: totals.eligibleBytes + session.eligibleBytes,
      legacyOversizedRows: totals.legacyOversizedRows + session.legacyOversizedRows,
      legacyOversizedBytes: totals.legacyOversizedBytes + session.legacyOversizedBytes,
      rearchivableOversizedRows:
        totals.rearchivableOversizedRows + session.rearchivableOversizedRows,
      rearchivableOversizedBytes:
        totals.rearchivableOversizedBytes + session.rearchivableOversizedBytes,
      oversizedRows: totals.oversizedRows + session.oversizedRows,
      oversizedBytes: totals.oversizedBytes + session.oversizedBytes,
      archivedRows: totals.archivedRows + session.archivedRows,
      skippedRows: totals.skippedRows + session.skippedRows,
    }),
    {
      rowsExamined: 0,
      eligibleRows: 0,
      eligibleBytes: 0,
      legacyOversizedRows: 0,
      legacyOversizedBytes: 0,
      rearchivableOversizedRows: 0,
      rearchivableOversizedBytes: 0,
      oversizedRows: 0,
      oversizedBytes: 0,
      archivedRows: 0,
      skippedRows: 0,
    }
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('ProjectData relief preflight session manifest totals do not match the run');
  }
}

async function readRun(env: Env, planId: string): Promise<PreflightRow | null> {
  return env.DATABASE.prepare(
    `SELECT * FROM project_data_storage_relief_preflights WHERE plan_id = ?`
  )
    .bind(planId)
    .first<PreflightRow>();
}

async function initializeRun(
  env: Env,
  config: PreflightConfig,
  now: number
): Promise<PreflightRow> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_data_storage_relief_preflights
       (plan_id, project_id, status, cutoff_created_at, config_json,
        next_eligible_at, started_at, updated_at)
     VALUES (?, ?, 'running', ?, ?, 0, ?, ?)`
  )
    .bind(config.planId, config.projectId, config.cutoffCreatedAt, config.configJson, now, now)
    .run();
  const row = await readRun(env, config.planId);
  if (!row) throw new Error(`ProjectData relief preflight ${config.planId} was not initialized`);
  if (
    row.project_id !== config.projectId ||
    row.cutoff_created_at !== config.cutoffCreatedAt ||
    row.config_json !== config.configJson
  ) {
    throw new Error(
      `ProjectData relief preflight ${config.planId} conflicts with its immutable scope or budgets`
    );
  }
  return row;
}

function parseCursor(raw: string | null): ProjectDataStorageReliefMeasureCursor | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ProjectData relief preflight cursor is malformed');
  }
  const toolPayload = (parsed as Record<string, unknown>).toolPayload;
  if (!toolPayload || typeof toolPayload !== 'object' || Array.isArray(toolPayload)) {
    throw new Error('ProjectData relief preflight cursor is malformed');
  }
  const cursor = toolPayload as Record<string, unknown>;
  if (
    !Number.isSafeInteger(cursor.rowId) ||
    Number(cursor.rowId) <= 0 ||
    typeof cursor.sessionId !== 'string' ||
    cursor.sessionId.length === 0 ||
    !Number.isSafeInteger(cursor.createdAt) ||
    Number(cursor.createdAt) < 0 ||
    !Number.isSafeInteger(cursor.sequence) ||
    Number(cursor.sequence) < -1 ||
    typeof cursor.messageId !== 'string' ||
    cursor.messageId.length === 0
  ) {
    throw new Error('ProjectData relief preflight cursor is malformed');
  }
  return {
    toolPayload: {
      rowId: Number(cursor.rowId),
      sessionId: cursor.sessionId,
      createdAt: Number(cursor.createdAt),
      sequence: Number(cursor.sequence),
      messageId: cursor.messageId,
    },
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  operation.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`ProjectData relief preflight exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function claimRun(
  env: Env,
  config: PreflightConfig,
  row: PreflightRow,
  now: number,
  leaseOwner: string
): Promise<PreflightRow | null> {
  if (row.status !== 'running') return null;
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_storage_relief_preflights
     SET batches_started = batches_started + 1,
         next_eligible_at = ?,
         lease_owner = ?,
         lease_expires_at = ?,
         last_error = NULL,
         updated_at = ?
     WHERE plan_id = ?
       AND status = 'running'
       AND next_eligible_at <= ?
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
  )
    .bind(now + config.intervalMs, leaseOwner, now + config.leaseMs, now, config.planId, now, now)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return readRun(env, config.planId);
}

function terminalStatus(
  config: PreflightConfig,
  claimed: PreflightRow,
  totals: { rowsExamined: number; eligibleBytes: number },
  hasMore: boolean,
  byteLimitReached: boolean
): PreflightStatus {
  if (!hasMore) return 'complete';
  if (
    byteLimitReached ||
    claimed.batches_started >= config.maxBatches ||
    totals.rowsExamined >= config.maxRows ||
    totals.eligibleBytes >= config.maxBytes
  ) {
    return 'truncated';
  }
  return 'running';
}

async function recordFailure(
  env: Env,
  config: PreflightConfig,
  claimed: PreflightRow,
  leaseOwner: string,
  now: number,
  error: unknown
): Promise<PreflightRow> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  const status: PreflightStatus =
    claimed.batches_started >= config.maxBatches ? 'failed' : 'running';
  await env.DATABASE.prepare(
    `UPDATE project_data_storage_relief_preflights
     SET status = ?,
         completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
         last_error = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE plan_id = ? AND lease_owner = ?`
  )
    .bind(status, status, now, message, now, config.planId, leaseOwner)
    .run();
  log.warn('slice_failed_closed', {
    planId: config.planId,
    projectId: config.projectId,
    batchesStarted: claimed.batches_started,
    ...serializeError(error),
  });
  return (await readRun(env, config.planId)) ?? claimed;
}

export async function runProjectDataStorageReliefPreflight(
  env: Env,
  date = new Date()
): Promise<ProjectDataStorageReliefPreflightResult> {
  const config = configFromEnv(env);
  if (!config.enabled) return emptyResult(config, 'disabled');
  const now = date.getTime();
  if (!config.valid || config.cutoffCreatedAt > now) {
    return emptyResult(config, 'invalid_config');
  }

  let row: PreflightRow;
  try {
    row = await initializeRun(env, config, now);
  } catch (error) {
    log.warn('initialization_failed_closed', {
      planId: config.planId,
      projectId: config.projectId,
      ...serializeError(error),
    });
    return { ...emptyResult(config, 'invalid_config'), lastError: String(error) };
  }
  if (row.status !== 'running') return resultFromRow(row, 'terminal');
  if (row.lease_owner && row.lease_expires_at !== null && row.lease_expires_at > now) {
    return resultFromRow(row, 'leased');
  }
  if (row.next_eligible_at > now) return resultFromRow(row, 'cadence');

  const leaseOwner = crypto.randomUUID();
  const claimed = await claimRun(env, config, row, now, leaseOwner);
  if (!claimed) {
    row = (await readRun(env, config.planId)) ?? row;
    return resultFromRow(row, row.status === 'running' ? 'leased' : 'terminal');
  }

  try {
    const remainingRows = Math.max(config.maxRows - claimed.rows_examined, 0);
    if (remainingRows === 0 || claimed.batches_started > config.maxBatches) {
      await env.DATABASE.prepare(
        `UPDATE project_data_storage_relief_preflights
         SET status = 'truncated', completed_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE plan_id = ? AND lease_owner = ?`
      )
        .bind(now, now, config.planId, leaseOwner)
        .run();
      return resultFromRow((await readRun(env, config.planId)) ?? claimed);
    }

    const cursor = parseCursor(claimed.cursor_json);
    const sliceDeadlineMs = Date.now() + config.wallTimeMs;
    const measurementBudgetMs = Math.max(Math.floor(config.wallTimeMs / 2), 1);
    const innerDeadlineMs = Date.now() + measurementBudgetMs;
    const measurement = await withTimeout(
      measureProjectDataStorageRelief(env, config.projectId, {
        cursor,
        limit: Math.min(config.batchRows, remainingRows),
        surface: 'tool_payloads',
        cutoffCreatedAt: config.cutoffCreatedAt,
        maxEligibleBytes: Math.max(config.maxBytes - claimed.eligible_bytes, 0),
        deadlineMs: innerDeadlineMs,
      }),
      measurementBudgetMs + PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INNER_RETURN_MARGIN_MS
    );
    const tool = measurement.toolPayloads;
    const totals = {
      rowsExamined: claimed.rows_examined + tool.rowsExamined,
      eligibleRows: claimed.eligible_rows + tool.eligibleRows,
      eligibleBytes: claimed.eligible_bytes + tool.eligibleBytes,
    };
    const status = terminalStatus(config, claimed, totals, tool.hasMore, tool.byteLimitReached);
    const completedAt = status === 'running' ? null : now;
    const cursorJson =
      status === 'running' && tool.nextCursor
        ? JSON.stringify({ toolPayload: tool.nextCursor })
        : null;
    const sessionManifest = mergeSessionManifest(claimed.sessions_json, tool.sessions);
    verifySessionManifestTotals(sessionManifest.json, {
      rowsExamined: totals.rowsExamined,
      eligibleRows: totals.eligibleRows,
      eligibleBytes: totals.eligibleBytes,
      legacyOversizedRows: claimed.legacy_oversized_rows + tool.legacyOversizedRows,
      legacyOversizedBytes: claimed.legacy_oversized_bytes + tool.legacyOversizedBytes,
      rearchivableOversizedRows:
        claimed.rearchivable_oversized_rows + tool.rearchivableOversizedRows,
      rearchivableOversizedBytes:
        claimed.rearchivable_oversized_bytes + tool.rearchivableOversizedBytes,
      oversizedRows: claimed.oversized_rows + tool.oversizedRows,
      oversizedBytes: claimed.oversized_bytes + tool.oversizedBytes,
      archivedRows: claimed.archived_rows + tool.archivedRows,
      skippedRows: claimed.skipped_rows + tool.skippedRows,
    });
    const sessionManifestSha256 = await sha256Text(sessionManifest.json);
    const targetBatchProofs = parseTargetBatchProofs(claimed.target_batches_json);
    if (tool.targets.length !== tool.eligibleRows) {
      throw new Error('ProjectData relief preflight eligible target count is inconsistent');
    }
    if (tool.targets.length > 0) {
      const firstTarget = tool.targets[0];
      const lastTarget = tool.targets.at(-1);
      if (!firstTarget || !lastTarget) {
        throw new Error('ProjectData relief preflight target bounds are missing');
      }
      const ordinal = targetBatchProofs.length;
      const written = await writeToolPayloadCleanupManifestBatch({
        r2: env.PROJECT_DATA_ARCHIVE_R2,
        archivePrefix: config.archivePrefix,
        manifest: {
          version: 1,
          planId: config.planId,
          projectId: config.projectId,
          cutoffCreatedAt: config.cutoffCreatedAt,
          ordinal,
          targets: tool.targets,
        },
        timeoutMs: config.archiveWriteTimeoutMs,
        deadlineMs: sliceDeadlineMs,
      });
      targetBatchProofs.push({
        ordinal,
        key: written.key,
        bytes: written.bytes,
        sha256: written.sha256,
        targetCount: tool.targets.length,
        projectedReclaimableBytes: tool.eligibleBytes,
        firstRowId: firstTarget.rowId,
        lastRowId: lastTarget.rowId,
      });
    }
    const targetBatchesJson = JSON.stringify(targetBatchProofs);
    if (
      new TextEncoder().encode(targetBatchesJson).byteLength >
      PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_MANIFEST_BYTES
    ) {
      throw new Error('ProjectData relief preflight target batch proofs exceeded D1 row bound');
    }
    let targetManifest:
      | { key: string; bytes: number; sha256: string; value: ToolPayloadCleanupManifestRoot }
      | undefined;
    if (status !== 'running') {
      targetManifest = await writeToolPayloadCleanupManifestRoot({
        r2: env.PROJECT_DATA_ARCHIVE_R2,
        archivePrefix: config.archivePrefix,
        manifest: {
          version: 1,
          planId: config.planId,
          projectId: config.projectId,
          cutoffCreatedAt: config.cutoffCreatedAt,
          createdAt: now,
          eligibleRows: totals.eligibleRows,
          eligibleBytes: totals.eligibleBytes,
          batches: targetBatchProofs,
        },
        timeoutMs: config.archiveWriteTimeoutMs,
        deadlineMs: sliceDeadlineMs,
      });
    }
    const finalize = await env.DATABASE.prepare(
      `UPDATE project_data_storage_relief_preflights
       SET status = ?,
           cursor_json = ?,
           rows_examined = ?,
           eligible_rows = ?,
           eligible_bytes = ?,
           legacy_oversized_rows = legacy_oversized_rows + ?,
           legacy_oversized_bytes = legacy_oversized_bytes + ?,
           rearchivable_oversized_rows = rearchivable_oversized_rows + ?,
           rearchivable_oversized_bytes = rearchivable_oversized_bytes + ?,
           oversized_rows = oversized_rows + ?,
           oversized_bytes = oversized_bytes + ?,
           archived_rows = archived_rows + ?,
           skipped_rows = skipped_rows + ?,
           session_count = ?,
           sessions_json = ?,
           sessions_sha256 = ?,
           target_batches_json = ?,
           target_manifest_key = ?,
           target_manifest_bytes = ?,
           target_manifest_sha256 = ?,
           database_size_bytes = ?,
           completed_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = ?
       WHERE plan_id = ? AND lease_owner = ?`
    )
      .bind(
        status,
        cursorJson,
        totals.rowsExamined,
        totals.eligibleRows,
        totals.eligibleBytes,
        tool.legacyOversizedRows,
        tool.legacyOversizedBytes,
        tool.rearchivableOversizedRows,
        tool.rearchivableOversizedBytes,
        tool.oversizedRows,
        tool.oversizedBytes,
        tool.archivedRows,
        tool.skippedRows,
        sessionManifest.count,
        sessionManifest.json,
        sessionManifestSha256,
        targetBatchesJson,
        targetManifest?.key ?? null,
        targetManifest?.bytes ?? null,
        targetManifest?.sha256 ?? null,
        measurement.databaseSizeBytes,
        completedAt,
        now,
        config.planId,
        leaseOwner
      )
      .run();
    if ((finalize.meta.changes ?? 0) !== 1) {
      throw new Error('ProjectData relief preflight lost its lease before result persistence');
    }
    const updated = (await readRun(env, config.planId)) ?? claimed;
    log.info(status === 'running' ? 'slice_completed' : 'preflight_terminal', {
      planId: config.planId,
      projectId: config.projectId,
      status,
      cutoffCreatedAt: config.cutoffCreatedAt,
      batchesStarted: updated.batches_started,
      rowsExamined: updated.rows_examined,
      eligibleRows: updated.eligible_rows,
      eligibleBytes: updated.eligible_bytes,
      sessionCount: updated.session_count,
      sessionManifestSha256: updated.sessions_sha256,
      targetManifestKey: updated.target_manifest_key,
      targetManifestSha256: updated.target_manifest_sha256,
      databaseSizeBytes: updated.database_size_bytes,
    });
    return resultFromRow(updated);
  } catch (error) {
    return resultFromRow(await recordFailure(env, config, claimed, leaseOwner, now, error));
  }
}
