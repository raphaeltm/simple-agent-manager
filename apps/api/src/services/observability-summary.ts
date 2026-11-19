import { count, eq, gte, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as observabilitySchema from '../db/observability-schema';
import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  DEFAULT_MAX_ROWS,
  DEFAULT_RETENTION_DAYS,
  type ErrorTrendsResult,
  getConfigNumber,
  type HealthSummaryResult,
  type PurgeResult,
  RANGE_TO_INTERVAL,
  RANGE_TO_MS,
} from './observability-common';

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
    db
      .select({ count: count() })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.status, 'running')),
    db
      .select({ count: count() })
      .from(schema.tasks)
      .where(
        or(
          eq(schema.tasks.status, 'queued'),
          eq(schema.tasks.status, 'delegated'),
          eq(schema.tasks.status, 'in_progress')
        )
      ),
    obsDb
      .select({ count: count() })
      .from(observabilitySchema.platformErrors)
      .where(gte(observabilitySchema.platformErrors.timestamp, twentyFourHoursAgo)),
  ]);

  return {
    activeNodes: nodesResult[0]?.count ?? 0,
    activeWorkspaces: workspacesResult[0]?.count ?? 0,
    inProgressTasks: tasksResult[0]?.count ?? 0,
    errorCount24h: errorsResult[0]?.count ?? 0,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get aggregated error counts grouped by time interval and source.
 */
export async function getErrorTrends(
  db: D1Database,
  range: string = '24h',
  interval?: string
): Promise<ErrorTrendsResult> {
  const fallbackRangeMs = RANGE_TO_MS['24h'];
  if (fallbackRangeMs === undefined) {
    throw new Error('Internal error: RANGE_TO_MS is missing the 24h fallback entry');
  }
  const rangeMs = RANGE_TO_MS[range] ?? fallbackRangeMs;

  const fallbackInterval = RANGE_TO_INTERVAL['24h'];
  if (fallbackInterval === undefined) {
    throw new Error('Internal error: RANGE_TO_INTERVAL is missing the 24h fallback entry');
  }
  const rangeInterval = RANGE_TO_INTERVAL[range];
  const resolvedInterval =
    interval && rangeInterval ? rangeInterval : (rangeInterval ?? fallbackInterval);

  const now = Date.now();
  const startTime = now - rangeMs;

  const drizzleDb = drizzle(db, { schema: observabilitySchema });
  const { platformErrors } = observabilitySchema;

  const { intervalMs, intervalLabel } = resolvedInterval;
  const bucketExpression = sql<number>`CAST((${platformErrors.timestamp} - ${startTime}) / ${intervalMs} AS INTEGER)`;
  const rows = await drizzleDb
    .select({ source: platformErrors.source, bucket: bucketExpression, count: count() })
    .from(platformErrors)
    .where(gte(platformErrors.timestamp, startTime))
    .groupBy(bucketExpression, platformErrors.source);

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
    const bucketIndex = Number(row.bucket);
    const bucket = buckets[bucketIndex];
    if (bucket) {
      bucket.total += Number(row.count);
      const currentCount = bucket.bySource[row.source];
      if (currentCount !== undefined) {
        bucket.bySource[row.source] = currentCount + Number(row.count);
      }
    }
  }

  return {
    range,
    interval: intervalLabel,
    buckets,
  };
}

/**
 * Purge expired errors based on retention days and max row count.
 */
export async function purgeExpiredErrors(db: D1Database, env: Env): Promise<PurgeResult> {
  const retentionDays = getConfigNumber(
    env,
    'OBSERVABILITY_ERROR_RETENTION_DAYS',
    DEFAULT_RETENTION_DAYS
  );
  const maxRows = getConfigNumber(env, 'OBSERVABILITY_ERROR_MAX_ROWS', DEFAULT_MAX_ROWS);

  const drizzleDb = drizzle(db, { schema: observabilitySchema });
  const { platformErrors } = observabilitySchema;

  const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // 1. Delete by age
  await drizzleDb.delete(platformErrors).where(lte(platformErrors.createdAt, cutoffTimestamp));

  // D1 doesn't return row count from delete, so we track separately
  // Count remaining rows
  const [countResult] = await drizzleDb.select({ count: count() }).from(platformErrors);

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
      await drizzleDb.delete(platformErrors).where(eq(platformErrors.id, row.id));
    }

    deletedByCount = oldestRows.length;
  }

  return {
    deletedByAge: 0, // D1 doesn't return affected rows; rely on count check
    deletedByCount,
  };
}
