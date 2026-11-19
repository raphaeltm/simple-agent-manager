import type { SQL } from 'drizzle-orm';
import { and, count, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as observabilitySchema from '../db/observability-schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_QUERY_LIMIT,
  getConfigNumber,
  MAX_QUERY_LIMIT,
  type PersistErrorInput,
  type QueryErrorsParams,
  type QueryErrorsResult,
  VALID_LEVELS,
  VALID_SOURCES,
} from './observability-common';
import {
  DEFAULT_MAX_CONTEXT_LENGTH,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_STACK_LENGTH,
  DEFAULT_MAX_USER_AGENT_LENGTH,
  getFieldLimit,
  type ObservabilityFieldLimitEnv,
  safeParseContext,
  serializeBoundedContext as boundContext,
  truncate,
} from './observability-fields';

export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Persist a single error to the observability D1 database.
 * Validates/truncates fields. Fails silently on D1 errors (logs to console).
 */
export async function persistError(
  db: D1Database,
  input: PersistErrorInput,
  env?: ObservabilityFieldLimitEnv
): Promise<void> {
  try {
    const source = VALID_SOURCES.has(input.source) ? input.source : 'api';
    const level = input.level && VALID_LEVELS.has(input.level) ? input.level : 'error';
    const messageMaxLength = env
      ? getFieldLimit(env, 'OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH', DEFAULT_MAX_MESSAGE_LENGTH)
      : DEFAULT_MAX_MESSAGE_LENGTH;
    const stackMaxLength = env
      ? getFieldLimit(env, 'OBSERVABILITY_ERROR_STACK_MAX_LENGTH', DEFAULT_MAX_STACK_LENGTH)
      : DEFAULT_MAX_STACK_LENGTH;
    const userAgentMaxLength = env
      ? getFieldLimit(
          env,
          'OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH',
          DEFAULT_MAX_USER_AGENT_LENGTH
        )
      : DEFAULT_MAX_USER_AGENT_LENGTH;
    const contextMaxLength = env
      ? getFieldLimit(env, 'OBSERVABILITY_ERROR_CONTEXT_MAX_LENGTH', DEFAULT_MAX_CONTEXT_LENGTH)
      : DEFAULT_MAX_CONTEXT_LENGTH;

    const drizzleDb = drizzle(db, { schema: observabilitySchema });

    await drizzleDb.insert(observabilitySchema.platformErrors).values({
      id: input.id ?? generateId(),
      source,
      level,
      message: truncate(input.message, messageMaxLength),
      stack: input.stack ? truncate(input.stack, stackMaxLength) : null,
      context: input.context ? boundContext(input.context, contextMaxLength) : null,
      userId: input.userId ?? null,
      nodeId: input.nodeId ?? null,
      workspaceId: input.workspaceId ?? null,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ? truncate(input.userAgent, userAgentMaxLength) : null,
      timestamp: input.timestamp ?? Date.now(),
    });
  } catch (err) {
    // Fail-silent: never let observability writes impact the caller
    log.warn('observability.persist_error_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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
    await persistError(db, input, env);
  }
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
  const conditions: SQL[] = [];

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

  if (params.nodeId) conditions.push(eq(platformErrors.nodeId, params.nodeId));
  if (params.workspaceId) conditions.push(eq(platformErrors.workspaceId, params.workspaceId));
  if (params.taskId) conditions.push(eq(platformErrors.taskId, params.taskId));
  if (params.sessionId) conditions.push(eq(platformErrors.sessionId, params.sessionId));
  if (params.userId) conditions.push(eq(platformErrors.userId, params.userId));

  if (params.search) {
    const searchPattern = `%${params.search}%`;
    const searchCondition = or(
      like(platformErrors.message, searchPattern),
      like(platformErrors.context, searchPattern)
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
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

  const [totalResults, rows] = await Promise.all([
    drizzleDb.select({ count: count() }).from(platformErrors).where(countWhere),
    drizzleDb
      .select()
      .from(platformErrors)
      .where(where)
      .orderBy(desc(platformErrors.timestamp))
      .limit(limit + 1),
  ]);
  const total = totalResults[0]?.count ?? 0;

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  // Build next cursor from last row's timestamp
  const lastRow = resultRows[resultRows.length - 1];
  const nextCursor = hasMore && lastRow ? btoa(String(lastRow.timestamp - 1)) : null;

  return {
    errors: resultRows.map((row) => ({
      id: row.id,
      source: row.source,
      level: row.level,
      message: row.message,
      stack: row.stack,
      context: safeParseContext(row.context, row.id),
      userId: row.userId,
      nodeId: row.nodeId,
      workspaceId: row.workspaceId,
      taskId: row.taskId,
      sessionId: row.sessionId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      timestamp: new Date(row.timestamp).toISOString(),
    })),
    cursor: nextCursor,
    hasMore,
    total,
  };
}
