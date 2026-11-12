/**
 * D1 analytics sink for installations without Workers Analytics Engine (self-host on celld).
 *
 * One switch, `ANALYTICS_SINK="d1"`, moves BOTH sides of product analytics to the
 * `analytics_events` table in `OBSERVABILITY_DATABASE`:
 * - writes: the request middleware and the `/api/t` ingest route call `resolveAnalyticsSink()`;
 * - reads: `queryAnalyticsEngine()` runs the admin queries here after `translateAnalyticsSql()`.
 * Because the same switch decides both, a deployment can never record into one store and read
 * from the other. Unset (every Cloudflare installation), nothing here runs.
 *
 * Write cost: one single-row INSERT per recorded API request (the middleware), one batched
 * INSERT per `/api/t` call; both run in `waitUntil`, never on the response path. Each row holds
 * at most ~1.3 KB (blob lengths are capped below). On celld a D1 write is one object-store
 * round trip (p50 70-98 ms on GCS), so this costs one store write per recorded request.
 * Growth bound: `purgeAnalyticsEvents()` runs in the 5-minute observability purge and deletes
 * rows older than the admin setting operations.analyticsD1RetentionDays (default 90, the longest
 * admin period) and the oldest rows above operations.analyticsD1MaxRows (default 500,000; ~650 MB
 * worst case).
 *
 * No secrets: rows hold the fields Analytics Engine receives, minus URL detail: the page is stored
 * without query string or fragment, and the referrer as its origin only, so tokens in links
 * (query strings, invite paths) are never kept.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveOperationsTelemetrySetting } from './operations-telemetry-settings';

export const ANALYTICS_EVENTS_TABLE = 'analytics_events';
/** Longest stored blob; Analytics Engine caps the whole point at 16 KB, we keep rows small. */
export const ANALYTICS_D1_MAX_BLOB_LENGTH = 256;
/** 1 index + 11 blobs + 3 doubles = 15 binds per row: one statement per row, under D1's 100. */
const BLOB_COUNT = 11;
const DOUBLE_COUNT = 3;

export type AnalyticsSinkEnv = Pick<Env, 'ANALYTICS' | 'ANALYTICS_SINK' | 'OBSERVABILITY_DATABASE'>;

/** Whether this installation records and reads product analytics in D1. */
export function isAnalyticsD1SinkEnabled(
  env: Pick<Env, 'ANALYTICS_SINK' | 'OBSERVABILITY_DATABASE'>
): boolean {
  return env.ANALYTICS_SINK?.trim().toLowerCase() === 'd1' && !!env.OBSERVABILITY_DATABASE;
}

/** Where analytics data points go. Same shape as Analytics Engine's `writeDataPoint`. */
export interface AnalyticsSink {
  write(points: AnalyticsEngineDataPoint[]): Promise<void>;
}

/** The sink for this installation, or null when analytics has nowhere to go. */
export function resolveAnalyticsSink(env: AnalyticsSinkEnv): AnalyticsSink | null {
  if (isAnalyticsD1SinkEnabled(env)) {
    const db = env.OBSERVABILITY_DATABASE;
    return { write: (points) => writeAnalyticsPointsToD1(db, points) };
  }
  const dataset = env.ANALYTICS;
  if (!dataset) return null;
  return {
    write: async (points) => {
      for (const point of points) dataset.writeDataPoint(point);
    },
  };
}

/** Strip query string and fragment: a link can carry a token, the path cannot. */
function withoutQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function originOnly(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function blobAt(point: AnalyticsEngineDataPoint, index: number): string {
  const raw = point.blobs?.[index];
  let text = raw === null || raw === undefined ? '' : typeof raw === 'string' ? raw : '';
  // blob3 (page / route pattern): path only. The web tracker already redacts id- and
  // token-shaped segments (apps/web/src/lib/analytics.ts normalizeAnalyticsPath).
  if (index === 2) text = withoutQuery(text);
  // blob4 (referrer): origin only. For API requests it is the browser's Referer, the full app
  // URL, whose path can carry a token (invite links); no admin query reads more than the origin.
  if (index === 3) text = originOnly(text);
  return text.slice(0, ANALYTICS_D1_MAX_BLOB_LENGTH);
}

function doubleAt(point: AnalyticsEngineDataPoint, index: number): number {
  const value = point.doubles?.[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const INSERT_SQL = `INSERT INTO ${ANALYTICS_EVENTS_TABLE} (timestamp, index1, ${Array.from(
  { length: BLOB_COUNT },
  (_, i) => `blob${i + 1}`
).join(', ')}, double1, double2, double3) VALUES (datetime('now'), ?, ${Array(
  BLOB_COUNT + DOUBLE_COUNT
)
  .fill('?')
  .join(', ')})`;

export async function writeAnalyticsPointsToD1(
  db: D1Database,
  points: AnalyticsEngineDataPoint[]
): Promise<void> {
  if (points.length === 0) return;
  const statements = points.map((point) => {
    const index = String(point.indexes?.[0] ?? '').slice(0, ANALYTICS_D1_MAX_BLOB_LENGTH);
    const blobs = Array.from({ length: BLOB_COUNT }, (_, i) => blobAt(point, i));
    const doubles = Array.from({ length: DOUBLE_COUNT }, (_, i) => doubleAt(point, i));
    return db.prepare(INSERT_SQL).bind(index, ...blobs, ...doubles);
  });
  const [only] = statements;
  if (statements.length === 1 && only) await only.run();
  else await db.batch(statements);
}

/**
 * Translate the Analytics Engine SQL dialect used by the admin analytics routes into SQLite.
 * Covers exactly the constructs those routes use; anything else Analytics-Engine-specific left
 * after translation is refused, so a new admin query fails loudly instead of returning wrong
 * numbers on self-host.
 */
export function translateAnalyticsSql(sql: string): string {
  let out = sql;
  // FROM <dataset> -> the D1 table (the dataset name is an identifier, see analytics-config.ts).
  out = out.replace(/\bFROM\s+[A-Za-z_][A-Za-z0-9_]*/g, `FROM ${ANALYTICS_EVENTS_TABLE}`);
  // NOW() - INTERVAL 'N' DAY
  out = out.replace(
    /NOW\(\)\s*-\s*INTERVAL\s*'(\d+)'\s*DAY/gi,
    (_m, days: string) => `datetime('now', '-${Number(days)} days')`
  );
  // toStartOfInterval(timestamp, INTERVAL 'N' DAY): epoch-aligned N-day buckets, as in AE.
  out = out.replace(
    /toStartOfInterval\(\s*timestamp\s*,\s*INTERVAL\s*'(\d+)'\s*DAY\s*\)/gi,
    (_m, days: string) => {
      const seconds = Number(days) * 86_400;
      return `datetime((CAST(strftime('%s', timestamp) AS INTEGER) / ${seconds}) * ${seconds}, 'unixepoch')`;
    }
  );
  out = out.replace(/toDate\(\s*timestamp\s*\)/gi, 'date(timestamp)');
  out = out.replace(/\bcount\(\s*\)/gi, 'count(*)');

  const leftover =
    /(\bINTERVAL\b|\b(?:NOW|toStartOf\w*|toDate\w*|formatDateTime|quantile\w*|uniq\w*|if|countIf|sumIf)\s*\(|\b_sample_interval\b)/i.exec(
      out
    );
  if (leftover) {
    throw new Error(`Analytics query uses "${leftover[1]}", which the D1 sink cannot translate`);
  }
  return out;
}

/** Run an admin analytics query (Analytics Engine dialect) against the D1 sink. */
export async function queryAnalyticsD1(db: D1Database, sql: string): Promise<unknown[]> {
  const result = await db.prepare(translateAnalyticsSql(sql)).all();
  return result.results ?? [];
}

export interface AnalyticsPurgeResult {
  deletedByAge: number;
  deletedByCount: number;
}

/** Retention and row cap for the D1 sink. A no-op (no D1 call) unless the sink is enabled. */
export async function purgeAnalyticsEvents(env: Env): Promise<AnalyticsPurgeResult | null> {
  if (!isAnalyticsD1SinkEnabled(env)) return null;
  const db = env.OBSERVABILITY_DATABASE;
  const [days, maxRows] = await Promise.all([
    resolveOperationsTelemetrySetting(env, 'analyticsD1RetentionDays'),
    resolveOperationsTelemetrySetting(env, 'analyticsD1MaxRows'),
  ]);

  const byAge = await db
    .prepare(`DELETE FROM ${ANALYTICS_EVENTS_TABLE} WHERE timestamp < datetime('now', ?)`)
    .bind(`-${days} days`)
    .run();
  // Keep the newest maxRows by id (ids grow with insertion order). Deletes nothing when under cap.
  const byCount = await db
    .prepare(
      `DELETE FROM ${ANALYTICS_EVENTS_TABLE} WHERE id <= (SELECT id FROM ${ANALYTICS_EVENTS_TABLE} ORDER BY id DESC LIMIT 1 OFFSET ?)`
    )
    .bind(maxRows)
    .run();
  const result = {
    deletedByAge: byAge.meta?.changes ?? 0,
    deletedByCount: byCount.meta?.changes ?? 0,
  };
  if (result.deletedByAge > 0 || result.deletedByCount > 0) {
    log.info('analytics.d1_purge', { ...result, retentionDays: days, maxRows });
  }
  return result;
}
