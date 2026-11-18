/**
 * D1 analytics sink for installations without Workers Analytics Engine (self-host on celld).
 *
 * Installed only by the self-host entry (`./index.ts`, `installAnalyticsD1Sink`). When the
 * deployment also sets `ANALYTICS_SINK="d1"`, BOTH sides of product analytics move to the
 * `analytics_events` table in `OBSERVABILITY_DATABASE` through the shared seam
 * (`services/analytics-sink.ts`):
 * - writes: the request middleware and the `/api/t` ingest route call `resolveAnalyticsSink()`;
 * - reads: `queryAnalyticsEngine()` runs the admin queries here after `translateAnalyticsSql()`.
 * Because one `active(env)` answer decides both, a deployment can never record into one store and
 * read from the other. The Cloudflare Worker never imports this module.
 *
 * Write cost: one single-row INSERT per recorded API request (the middleware), one batched
 * INSERT per `/api/t` call; both run in `waitUntil`, never on the response path. Each row holds
 * at most ~1.3 KB (blob lengths are capped below). On celld a D1 write is one object-store
 * round trip (p50 70-98 ms on GCS), so this costs one store write per recorded request.
 * Growth bound: `purgeAnalyticsEvents()` runs in the 5-minute observability purge and deletes
 * rows older than the admin setting analytics.d1.retentionDays (default 90, the longest admin
 * period) and the oldest rows above analytics.d1.maxRows (default 500,000; ~650 MB worst case).
 *
 * No secrets: rows hold the fields Analytics Engine receives, minus detail: the page is stored
 * without query string or fragment and with sensitive segments redacted, the referrer as its
 * origin only, and an anonymous visitor's IP as its network prefix, so tokens in links (query
 * strings, invite paths) and full client addresses are never kept.
 */
import { isSensitiveAnalyticsPathSegment } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveAdminSettingDetailsMany } from '../../services/admin-settings-resolution';
import type { AnalyticsSink } from '../../services/analytics-sink';
import {
  ANALYTICS_D1_MAX_ROWS_SETTING,
  ANALYTICS_D1_PURGE_BATCH_ROWS_SETTING,
  ANALYTICS_D1_PURGE_TICK_BUDGET_MS_SETTING,
  ANALYTICS_D1_RETENTION_DAYS_SETTING,
  DEFAULT_ANALYTICS_D1_MAX_ROWS,
  DEFAULT_ANALYTICS_D1_PURGE_BATCH_ROWS,
  DEFAULT_ANALYTICS_D1_PURGE_TICK_BUDGET_MS,
  DEFAULT_ANALYTICS_D1_RETENTION_DAYS,
} from './settings';

export const ANALYTICS_EVENTS_TABLE = 'analytics_events';
/** Longest stored blob; Analytics Engine caps the whole point at 16 KB, we keep rows small. */
export const ANALYTICS_D1_MAX_BLOB_LENGTH = 256;
/** 1 index + 11 blobs + 3 doubles = 15 binds per row: one statement per row, under D1's 100. */
const BLOB_COUNT = 11;
const DOUBLE_COUNT = 3;

/** Whether this installation records and reads product analytics in D1. Pure: no I/O. */
export function isAnalyticsD1SinkEnabled(
  env: Pick<Env, 'ANALYTICS_SINK' | 'OBSERVABILITY_DATABASE'>
): boolean {
  return env.ANALYTICS_SINK?.trim().toLowerCase() === 'd1' && !!env.OBSERVABILITY_DATABASE;
}

/** The D1 sink for this installation's observability database. */
export function analyticsD1Sink(db: D1Database): AnalyticsSink {
  return { write: (points) => writeAnalyticsPointsToD1(db, points) };
}

/** Strip query string and fragment: a link can carry a token there. */
function withoutQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

const REDACTED_SEGMENT = '[redacted]';

/**
 * The page path without query or fragment, with sensitive segments redacted by the same rule the
 * web tracker applies (`isSensitiveAnalyticsPathSegment`, packages/shared/src/analytics-path.ts).
 * `/api/t` accepts any page value, so the server cannot rely on the tracker having normalized it.
 * Route-pattern parameters (`:projectId`, from the request middleware) are kept: they are names,
 * not values, and admin queries group by them.
 */
function redactedPath(value: string): string {
  const segments = withoutQuery(value).split('/');
  return segments
    .map((segment, index) => {
      if (!segment || segment.startsWith(':')) return segment;
      const previous = index > 0 ? segments[index - 1] : undefined;
      return isSensitiveAnalyticsPathSegment(segment, previous) ? REDACTED_SEGMENT : segment;
    })
    .join('/');
}

/**
 * The ingest route indexes anonymous browser events as `anon-<client IP>`. The D1 sink keeps only
 * the network prefix (IPv4 /24, IPv6 /48), enough to count distinct visitors roughly without
 * storing a full address. Any other index (a user id) is stored as is.
 */
function maskedIndex(value: string): string {
  if (!value.startsWith('anon-')) return value;
  const ip = value.slice('anon-'.length);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `anon-${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) {
    const groups = (ip.split('::')[0] ?? '').split(':').filter(Boolean);
    return `anon-${groups.slice(0, 3).join(':') || '0'}::/48`;
  }
  return 'anon';
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
  if (index === 2) text = redactedPath(text);
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
    const index = maskedIndex(String(point.indexes?.[0] ?? '')).slice(
      0,
      ANALYTICS_D1_MAX_BLOB_LENGTH
    );
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

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

interface RetentionSettings {
  days: number;
  maxRows: number;
  batchRows: number;
  tickBudgetMs: number;
}

const DEFAULT_RETENTION: RetentionSettings = {
  days: DEFAULT_ANALYTICS_D1_RETENTION_DAYS,
  maxRows: DEFAULT_ANALYTICS_D1_MAX_ROWS,
  batchRows: DEFAULT_ANALYTICS_D1_PURGE_BATCH_ROWS,
  tickBudgetMs: DEFAULT_ANALYTICS_D1_PURGE_TICK_BUDGET_MS,
};

/**
 * Retention bounds in one settings read, or null when the settings store cannot be read. A
 * default must not stand in for the operator's policy here: with retention set to 180 days, a
 * 90-day fallback would permanently delete rows the policy keeps. The purge skips that tick and
 * the next one retries.
 */
async function resolveRetention(env: Env): Promise<RetentionSettings | null> {
  try {
    const [days, maxRows, batchRows, tickBudgetMs] = await resolveAdminSettingDetailsMany(env, [
      ANALYTICS_D1_RETENTION_DAYS_SETTING,
      ANALYTICS_D1_MAX_ROWS_SETTING,
      ANALYTICS_D1_PURGE_BATCH_ROWS_SETTING,
      ANALYTICS_D1_PURGE_TICK_BUDGET_MS_SETTING,
    ]);
    return {
      days: positiveInteger(days?.value, DEFAULT_RETENTION.days),
      maxRows: positiveInteger(maxRows?.value, DEFAULT_RETENTION.maxRows),
      batchRows: positiveInteger(batchRows?.value, DEFAULT_RETENTION.batchRows),
      tickBudgetMs: positiveInteger(tickBudgetMs?.value, DEFAULT_RETENTION.tickBudgetMs),
    };
  } catch (err) {
    log.warn('analytics.d1_purge_skipped', {
      reason: 'retention_settings_unreadable',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface AnalyticsPurgeResult {
  deletedByAge: number;
  deletedByCount: number;
  /** False when the tick budget ran out first; the next 5-minute run continues. */
  complete: boolean;
}

/**
 * Deletes the rows `selectIds` names, one batch per statement, until a batch comes back short
 * or the deadline passes. At least one batch runs per call, so every tick makes progress.
 */
async function deleteInBatches(
  db: D1Database,
  selectIds: string,
  binds: unknown[],
  batchRows: number,
  deadline: number
): Promise<{ deleted: number; complete: boolean }> {
  const statement = db.prepare(
    `DELETE FROM ${ANALYTICS_EVENTS_TABLE} WHERE id IN (${selectIds} LIMIT ?)`
  );
  let deleted = 0;
  do {
    const result = await statement.bind(...binds, batchRows).run();
    const changes = result.meta?.changes ?? 0;
    deleted += changes;
    if (changes < batchRows) return { deleted, complete: true };
  } while (Date.now() < deadline);
  return { deleted, complete: false };
}

/**
 * Retention and row cap for the D1 sink. A no-op (no D1 call) unless the sink is enabled, and
 * skipped (null, logged) when the retention settings cannot be read.
 *
 * Bounded by time, not by count (rule 81): batches of `analytics.d1.purgeBatchRows` (default
 * 5,000) repeat until done or `analytics.d1.purgeTickBudgetMs` (default 10 s) is spent, and the
 * next 5-minute tick resumes. Both batch shapes use an index (timestamp for age, the rowid range
 * for the cap), so a batch costs its own rows, not the table. At a conservative 250 ms per
 * object-store-backed statement that is ~200,000 rows per tick (~57.6M a day) against an
 * inflow of one row per recorded request; the worst backlog the settings allow (cap lowered
 * from 10,000,000 to 1) clears in about 50 ticks, roughly 4 hours.
 */
export async function purgeAnalyticsEvents(env: Env): Promise<AnalyticsPurgeResult | null> {
  if (!isAnalyticsD1SinkEnabled(env)) return null;
  const db = env.OBSERVABILITY_DATABASE;
  const retention = await resolveRetention(env);
  if (!retention) return null;
  const { days, maxRows, batchRows, tickBudgetMs } = retention;
  const deadline = Date.now() + tickBudgetMs;

  const byAge = await deleteInBatches(
    db,
    `SELECT id FROM ${ANALYTICS_EVENTS_TABLE} WHERE timestamp < datetime('now', ?)`,
    [`-${days} days`],
    batchRows,
    deadline
  );
  // Keep at most the newest maxRows. Ids grow with insertion order, so every id at or below
  // MAX(id) - maxRows goes; gaps left by earlier deletes only make this keep fewer rows. One
  // primary-key lookup finds the boundary instead of an OFFSET walk over the table.
  let byCount = { deleted: 0, complete: true };
  if (byAge.complete) {
    const top = await db
      .prepare(`SELECT MAX(id) AS maxId FROM ${ANALYTICS_EVENTS_TABLE}`)
      .first<{ maxId: number | null }>();
    const boundary = (top?.maxId ?? 0) - maxRows;
    if (boundary > 0) {
      byCount = await deleteInBatches(
        db,
        `SELECT id FROM ${ANALYTICS_EVENTS_TABLE} WHERE id <= ? ORDER BY id`,
        [boundary],
        batchRows,
        deadline
      );
    }
  }
  const result = {
    deletedByAge: byAge.deleted,
    deletedByCount: byCount.deleted,
    complete: byAge.complete && byCount.complete,
  };
  if (result.deletedByAge > 0 || result.deletedByCount > 0 || !result.complete) {
    log.info('analytics.d1_purge', { ...result, retentionDays: days, maxRows, batchRows });
  }
  return result;
}
