/**
 * Observability Service — error persistence, querying, health aggregation,
 * and Cloudflare Workers Observability API proxy.
 *
 * All errors are stored in the dedicated OBSERVABILITY_DATABASE (separate D1).
 * See specs/023-admin-observability/data-model.md for entity definitions.
 */

import type { PlatformErrorLevel,PlatformErrorSource } from '@simple-agent-manager/shared';
import { and, count, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as observabilitySchema from '../db/observability-schema';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { log } from '../lib/logger';

// =============================================================================
// Constants (configurable via env)
// =============================================================================

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_STACK_LENGTH = 4096;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;

const VALID_SOURCES = new Set<string>(['client', 'vm-agent', 'api']);
const VALID_LEVELS = new Set<string>(['error', 'warn', 'info']);

// =============================================================================
// Helpers
// =============================================================================

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

function generateId(): string {
  return crypto.randomUUID();
}

function getConfigNumber(env: Env, key: keyof Env, fallback: number): number {
  const val = env[key] as string | undefined;
  if (val) {
    const n = parseInt(val, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

// =============================================================================
// Error Persistence (T018)
// =============================================================================

export interface PersistErrorInput {
  source: PlatformErrorSource;
  level?: PlatformErrorLevel;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
  userId?: string | null;
  nodeId?: string | null;
  workspaceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  timestamp?: number; // ms epoch; defaults to now
}

/**
 * Persist a single error to the observability D1 database.
 * Validates/truncates fields. Fails silently on D1 errors (logs to console).
 */
export async function persistError(
  db: D1Database,
  input: PersistErrorInput
): Promise<void> {
  try {
    const source = VALID_SOURCES.has(input.source) ? input.source : 'api';
    const level = input.level && VALID_LEVELS.has(input.level) ? input.level : 'error';

    const drizzleDb = drizzle(db, { schema: observabilitySchema });

    await drizzleDb.insert(observabilitySchema.platformErrors).values({
      id: generateId(),
      source,
      level,
      message: truncate(input.message, MAX_MESSAGE_LENGTH),
      stack: input.stack ? truncate(input.stack, MAX_STACK_LENGTH) : null,
      context: input.context ? JSON.stringify(input.context) : null,
      userId: input.userId ?? null,
      nodeId: input.nodeId ?? null,
      workspaceId: input.workspaceId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ? truncate(input.userAgent, MAX_USER_AGENT_LENGTH) : null,
      timestamp: input.timestamp ?? Date.now(),
    });
  } catch (err) {
    // Fail-silent: never let observability writes impact the caller
    log.warn('observability.persist_error_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Persist a batch of errors. Each error is inserted individually
 * (D1 batch operations have limited transaction support).
 */
export async function persistErrorBatch(
  db: D1Database,
  inputs: PersistErrorInput[],
  env?: Env
): Promise<void> {
  const maxBatch = env
    ? getConfigNumber(env, 'OBSERVABILITY_ERROR_BATCH_SIZE', DEFAULT_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;

  const batch = inputs.slice(0, maxBatch);

  for (const input of batch) {
    await persistError(db, input);
  }
}

// =============================================================================
// Error Querying (T019)
// =============================================================================

export interface QueryErrorsParams {
  source?: PlatformErrorSource;
  level?: PlatformErrorLevel;
  search?: string;
  startTime?: number; // ms epoch
  endTime?: number; // ms epoch
  limit?: number;
  cursor?: string; // base64 encoded timestamp cursor
}

export interface QueryErrorsResult {
  errors: Array<{
    id: string;
    source: string;
    level: string;
    message: string;
    stack: string | null;
    context: Record<string, unknown> | null;
    userId: string | null;
    nodeId: string | null;
    workspaceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    timestamp: string; // ISO 8601
  }>;
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

/**
 * Query errors from the observability database with filtering, search, and pagination.
 */
export async function queryErrors(
  db: D1Database,
  params: QueryErrorsParams = {}
): Promise<QueryErrorsResult> {
  const drizzleDb = drizzle(db, { schema: observabilitySchema });
  const { platformErrors } = observabilitySchema;

  const limit = Math.min(params.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const conditions: ReturnType<typeof eq>[] = [];

  if (params.source && VALID_SOURCES.has(params.source)) {
    conditions.push(eq(platformErrors.source, params.source));
  }

  if (params.level && VALID_LEVELS.has(params.level)) {
    conditions.push(eq(platformErrors.level, params.level));
  }

  if (params.startTime) {
    conditions.push(gte(platformErrors.timestamp, params.startTime));
  }

  if (params.endTime) {
    conditions.push(lte(platformErrors.timestamp, params.endTime));
  }

  if (params.search) {
    conditions.push(like(platformErrors.message, `%${params.search}%`));
  }

  // Cursor-based pagination: decode cursor as timestamp
  if (params.cursor) {
    try {
      const cursorTs = parseInt(atob(params.cursor), 10);
      if (!isNaN(cursorTs)) {
        conditions.push(lte(platformErrors.timestamp, cursorTs));
      }
    } catch {
      // Invalid cursor, ignore
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Get total count (without cursor/limit)
  const countConditions = conditions.filter((_, i) => {
    // Exclude cursor condition (last one if cursor was provided)
    if (params.cursor && i === conditions.length - 1) return false;
    return true;
  });
  const countWhere = countConditions.length > 0 ? and(...countConditions) : undefined;

  const [totalResult] = await drizzleDb
    .select({ count: count() })
    .from(platformErrors)
    .where(countWhere);

  const total = totalResult?.count ?? 0;

  // Fetch rows (limit + 1 to determine hasMore)
  const rows = await drizzleDb
    .select()
    .from(platformErrors)
    .where(where)
    .orderBy(desc(platformErrors.timestamp))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  // Build next cursor from last row's timestamp
  const lastRow = resultRows[resultRows.length - 1];
  const nextCursor = hasMore && lastRow
    ? btoa(String(lastRow.timestamp - 1))
    : null;

  return {
    errors: resultRows.map((row) => ({
      id: row.id,
      source: row.source,
      level: row.level,
      message: row.message,
      stack: row.stack,
      context: row.context ? JSON.parse(row.context) : null,
      userId: row.userId,
      nodeId: row.nodeId,
      workspaceId: row.workspaceId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      timestamp: new Date(row.timestamp).toISOString(),
    })),
    cursor: nextCursor,
    hasMore,
    total,
  };
}

// =============================================================================
// Health Summary (T040 — Phase 4, but defined here for colocation)
// =============================================================================

export interface HealthSummaryResult {
  activeNodes: number;
  activeWorkspaces: number;
  inProgressTasks: number;
  errorCount24h: number;
  timestamp: string;
}

/**
 * Compute platform health summary from both databases.
 */
export async function getHealthSummary(
  mainDb: D1Database,
  observabilityDb: D1Database
): Promise<HealthSummaryResult> {
  const db = drizzle(mainDb, { schema });
  const obsDb = drizzle(observabilityDb, { schema: observabilitySchema });

  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

  const [nodesResult, workspacesResult, tasksResult, errorsResult] = await Promise.all([
    db.select({ count: count() }).from(schema.nodes).where(eq(schema.nodes.status, 'running')),
    db.select({ count: count() }).from(schema.workspaces).where(eq(schema.workspaces.status, 'running')),
    db.select({ count: count() }).from(schema.tasks).where(
      or(
        eq(schema.tasks.status, 'queued'),
        eq(schema.tasks.status, 'delegated'),
        eq(schema.tasks.status, 'in_progress')
      )
    ),
    obsDb.select({ count: count() }).from(observabilitySchema.platformErrors).where(
      gte(observabilitySchema.platformErrors.timestamp, twentyFourHoursAgo)
    ),
  ]);

  return {
    activeNodes: nodesResult[0]?.count ?? 0,
    activeWorkspaces: workspacesResult[0]?.count ?? 0,
    inProgressTasks: tasksResult[0]?.count ?? 0,
    errorCount24h: errorsResult[0]?.count ?? 0,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Error Trends (T072 — Phase 7, but defined here for colocation)
// =============================================================================

const RANGE_TO_INTERVAL: Record<string, { intervalMs: number; intervalLabel: string }> = {
  '1h':  { intervalMs: 5 * 60 * 1000, intervalLabel: '5m' },
  '24h': { intervalMs: 60 * 60 * 1000, intervalLabel: '1h' },
  '7d':  { intervalMs: 24 * 60 * 60 * 1000, intervalLabel: '1d' },
  '30d': { intervalMs: 24 * 60 * 60 * 1000, intervalLabel: '1d' },
};

const RANGE_TO_MS: Record<string, number> = {
  '1h':  60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface ErrorTrendsResult {
  range: string;
  interval: string;
  buckets: Array<{
    timestamp: string;
    total: number;
    bySource: Record<string, number>;
  }>;
}

/**
 * Get aggregated error counts grouped by time interval and source.
 */
export async function getErrorTrends(
  db: D1Database,
  range: string = '24h',
  interval?: string
): Promise<ErrorTrendsResult> {
  const rangeMs = RANGE_TO_MS[range] ?? RANGE_TO_MS['24h']!;
  const resolvedInterval = (interval && RANGE_TO_INTERVAL[range])
    ? RANGE_TO_INTERVAL[range]!
    : (RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL['24h']!);

  const now = Date.now();
  const startTime = now - rangeMs;

  const drizzleDb = drizzle(db, { schema: observabilitySchema });
  const { platformErrors } = observabilitySchema;

  // Query raw error data within time range
  const rows = await drizzleDb
    .select({
      source: platformErrors.source,
      timestamp: platformErrors.timestamp,
    })
    .from(platformErrors)
    .where(gte(platformErrors.timestamp, startTime))
    .orderBy(platformErrors.timestamp);

  // Build buckets
  const { intervalMs, intervalLabel } = resolvedInterval;
  const bucketCount = Math.ceil(rangeMs / intervalMs);
  const buckets: Array<{
    timestamp: string;
    total: number;
    bySource: Record<string, number>;
  }> = [];

  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = startTime + i * intervalMs;
    buckets.push({
      timestamp: new Date(bucketStart).toISOString(),
      total: 0,
      bySource: { client: 0, 'vm-agent': 0, api: 0 },
    });
  }

  // Assign rows to buckets
  for (const row of rows) {
    const bucketIndex = Math.floor((row.timestamp - startTime) / intervalMs);
    const bucket = buckets[bucketIndex];
    if (bucket) {
      bucket.total++;
      const currentCount = bucket.bySource[row.source];
      if (currentCount !== undefined) {
        bucket.bySource[row.source] = currentCount + 1;
      }
    }
  }

  return {
    range,
    interval: intervalLabel,
    buckets,
  };
}

// =============================================================================
// Retention Purge (T023)
// =============================================================================

export interface PurgeResult {
  deletedByAge: number;
  deletedByCount: number;
}

/**
 * Purge expired errors based on retention days and max row count.
 */
export async function purgeExpiredErrors(
  db: D1Database,
  env: Env
): Promise<PurgeResult> {
  const retentionDays = getConfigNumber(env, 'OBSERVABILITY_ERROR_RETENTION_DAYS', DEFAULT_RETENTION_DAYS);
  const maxRows = getConfigNumber(env, 'OBSERVABILITY_ERROR_MAX_ROWS', DEFAULT_MAX_ROWS);

  const drizzleDb = drizzle(db, { schema: observabilitySchema });
  const { platformErrors } = observabilitySchema;

  const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // 1. Delete by age
  await drizzleDb
    .delete(platformErrors)
    .where(lte(platformErrors.createdAt, cutoffTimestamp));

  // D1 doesn't return row count from delete, so we track separately
  // Count remaining rows
  const [countResult] = await drizzleDb
    .select({ count: count() })
    .from(platformErrors);

  const currentCount = countResult?.count ?? 0;
  let deletedByCount = 0;

  // 2. Delete by count (oldest first)
  if (currentCount > maxRows) {
    const excess = currentCount - maxRows;
    // Delete oldest `excess` rows by selecting their IDs
    const oldestRows = await drizzleDb
      .select({ id: platformErrors.id })
      .from(platformErrors)
      .orderBy(platformErrors.createdAt)
      .limit(excess);

    for (const row of oldestRows) {
      await drizzleDb
        .delete(platformErrors)
        .where(eq(platformErrors.id, row.id));
    }

    deletedByCount = oldestRows.length;
  }

  return {
    deletedByAge: 0, // D1 doesn't return affected rows; rely on count check
    deletedByCount,
  };
}

// =============================================================================
// Cloudflare Workers Observability API Proxy (T049 — Phase 5, US3)
// =============================================================================

const DEFAULT_LOG_QUERY_LIMIT = 100;
const MAX_LOG_QUERY_LIMIT = 500;
const DEFAULT_LOG_QUERY_RATE_LIMIT = 30;

const CF_OBSERVABILITY_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Get the configured rate limit for CF log queries (per minute).
 */
export function getLogQueryRateLimit(env: Env): number {
  return getConfigNumber(env, 'OBSERVABILITY_LOG_QUERY_RATE_LIMIT', DEFAULT_LOG_QUERY_RATE_LIMIT);
}

export interface QueryCloudflarLogsInput {
  cfApiToken: string;
  cfAccountId: string;
  timeRange: { start: string; end: string };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string | null;
  scriptName?: string;
  /** Optional caller-supplied queryId for pagination consistency. Generated per-request if omitted. */
  queryId?: string;
}

/**
 * Proxy query to Cloudflare Workers Observability Telemetry API.
 * Transforms request/response and never exposes CF credentials or raw errors.
 */
export async function queryCloudflareLogs(
  input: QueryCloudflarLogsInput
): Promise<{ logs: Array<{ timestamp: string; level: string; event: string; message: string; details: Record<string, unknown>; invocationId?: string }>; cursor: string | null; hasMore: boolean; queryId: string }> {
  const limit = Math.min(input.limit ?? DEFAULT_LOG_QUERY_LIMIT, MAX_LOG_QUERY_LIMIT);
  const queryId = input.queryId || crypto.randomUUID();

  // Build the CF Observability API query
  // See: https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
  // The CF Telemetry API requires filters, orderBy, needle, etc. inside a `parameters` object.
  // Top-level fields are: queryId, timeframe, view, limit, parameters.
  const filters: Array<{ key: string; operation: string; type: string; value: unknown }> = [];

  if (input.levels && input.levels.length > 0) {
    filters.push({
      key: '$workers.event.level',
      operation: 'in',
      type: 'string',
      value: input.levels,
    });
  }

  if (input.scriptName) {
    filters.push({
      key: '$workers.scriptName',
      operation: 'eq',
      type: 'string',
      value: input.scriptName,
    });
  }

  const parameters: Record<string, unknown> = {
    datasets: [],
    filters,
    orderBy: { value: 'timestamp', order: 'desc' },
    limit,
  };

  // Use needle for full-text search (the CF API's dedicated search mechanism)
  if (input.search) {
    parameters.needle = {
      value: input.search,
      isRegex: false,
      matchCase: false,
    };
  }

  const body: Record<string, unknown> = {
    queryId,
    timeframe: {
      from: new Date(input.timeRange.start).getTime(),
      to: new Date(input.timeRange.end).getTime(),
    },
    view: 'events',
    limit,
    parameters,
  };

  if (input.cursor) {
    body.offset = input.cursor;
  }

  const url = `${CF_OBSERVABILITY_API_BASE}/${input.cfAccountId}/workers/observability/telemetry/query`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${input.cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Network error — return 502-style error without leaking details
    throw new CfApiError('Cloudflare Observability API is unreachable');
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new CfApiError(
        'Cloudflare Observability API returned 403: The CF_API_TOKEN is missing the "Account: Workers Observability (Read)" permission. ' +
        'Edit the API token in Cloudflare Dashboard to add this permission.'
      );
    }
    if (response.status === 401) {
      throw new CfApiError(
        'Cloudflare Observability API returned 401: The CF_API_TOKEN is invalid or expired. ' +
        'Regenerate the token in Cloudflare Dashboard.'
      );
    }
    let detail = '';
    try {
      const errBody = await response.text();
      if (errBody) detail = `: ${errBody.slice(0, 200)}`;
    } catch { /* ignore */ }
    throw new CfApiError(`Cloudflare Observability API returned ${response.status}${detail}`);
  }

  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    throw new CfApiError('Invalid response from Cloudflare Observability API');
  }

  // Normalize CF response to our LogQueryResponse shape.
  // The CF Telemetry API response structure (from cloudflare-typescript SDK):
  //   result.events.events — array of telemetry event objects
  //   Each event: { $metadata: { id, level, message, type, ... }, $workers: { scriptName, event, ... }, timestamp, dataset, source }
  const result = data.result as Record<string, unknown> | undefined;

  // Extract events: result.events.events (new format) or result.events (legacy fallback)
  let events: Array<Record<string, unknown>> = [];
  const eventsContainer = result?.events as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  if (Array.isArray(eventsContainer)) {
    // Legacy format: result.events is directly an array
    events = eventsContainer;
  } else if (eventsContainer && Array.isArray(eventsContainer.events)) {
    // New format: result.events.events is the array
    events = eventsContainer.events as Array<Record<string, unknown>>;
  } else if (result?.data && Array.isArray(result.data)) {
    // Fallback: result.data
    events = result.data as Array<Record<string, unknown>>;
  }

  // Extract cursor for pagination from the run object
  const run = result?.run as Record<string, unknown> | undefined;
  const nextCursor = (run?.offset ?? result?.cursor ?? data.cursor ?? null) as string | null;

  const logs = events.map((event) => {
    // New format: $metadata contains level, message, type; $workers contains scriptName, event details
    const metadata = event.$metadata as Record<string, unknown> | undefined;
    const workers = event.$workers as Record<string, unknown> | undefined;
    const workerEvent = workers?.event as Record<string, unknown> | undefined;
    // Legacy format fallback
    const legacyEvent = event.event as Record<string, unknown> | undefined;

    const timestamp = event.timestamp;
    const timestampStr = typeof timestamp === 'number'
      ? new Date(timestamp).toISOString()
      : (timestamp ?? event.eventTimestamp ?? '') as string;

    return {
      timestamp: timestampStr,
      level: (metadata?.level ?? legacyEvent?.level ?? event.level ?? 'info') as string,
      event: (metadata?.type ?? workers?.eventType ?? legacyEvent?.type ?? event.type ?? 'unknown') as string,
      message: (metadata?.message ?? legacyEvent?.message ?? event.message ?? '') as string,
      details: stripSensitiveFields({
        ...(workerEvent ?? legacyEvent ?? {}),
        scriptName: workers?.scriptName,
        requestId: metadata?.requestId ?? workers?.requestId,
        outcome: workers?.outcome,
      }),
      invocationId: (metadata?.requestId ?? workers?.requestId ?? event.invocationId ?? event.traceId) as string | undefined,
    };
  });

  return {
    logs,
    cursor: nextCursor,
    hasMore: nextCursor !== null && logs.length >= limit,
    queryId,
  };
}

/**
 * Remove potentially sensitive fields from CF API response details.
 */
function stripSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'token']);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key.toLowerCase())) continue;
    result[key] = value;
  }

  return result;
}

/**
 * Error class for CF API failures — surfaces a safe message.
 */
export class CfApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfApiError';
  }
}
