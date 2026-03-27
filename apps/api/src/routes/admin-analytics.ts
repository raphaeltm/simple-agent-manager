import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth, requireApproved, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getForwardStatus } from '../services/analytics-forward';

const DEFAULT_ANALYTICS_SQL_API_URL = 'https://api.cloudflare.com/client/v4/accounts';
const DEFAULT_PERIOD_DAYS = 30;
const DEFAULT_DATASET = 'sam_analytics';
const DEFAULT_TOP_EVENTS_LIMIT = 50;
const DEFAULT_GEO_LIMIT = 50;
const DEFAULT_RETENTION_WEEKS = 12;
/** Analytics Engine hard cap on result rows; queries without explicit LIMIT silently truncate here. */
const MAX_RETENTION_QUERY_ROWS = 10_000;

/** Parse an integer env var with validation; returns fallback on NaN or non-positive values. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Convert a period string (24h, 7d, 30d, 90d) to an Analytics Engine SQL interval expression. */
function periodToInterval(period: string): string {
  switch (period) {
    case '24h':
      return "INTERVAL '1' DAY";
    case '30d':
      return "INTERVAL '30' DAY";
    case '90d':
      return "INTERVAL '90' DAY";
    case '7d':
    default:
      return "INTERVAL '7' DAY";
  }
}

/** Feature event categories for grouping in the adoption chart. */
const FEATURE_EVENTS = [
  'project_created', 'project_deleted',
  'workspace_created', 'workspace_started', 'workspace_stopped',
  'task_submitted', 'task_completed', 'task_failed',
  'node_created', 'node_deleted',
  'credential_saved', 'session_created',
  'settings_changed',
];

const adminAnalyticsRoutes = new Hono<{ Bindings: Env }>();

// All analytics routes require superadmin
adminAnalyticsRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * Execute an Analytics Engine SQL query via the Cloudflare API.
 */
async function queryAnalyticsEngine(
  env: Env,
  sql: string,
): Promise<unknown> {
  const baseUrl = env.ANALYTICS_SQL_API_URL || DEFAULT_ANALYTICS_SQL_API_URL;
  const accountId = env.CF_ACCOUNT_ID;

  if (!accountId) {
    throw errors.internal('CF_ACCOUNT_ID is not configured');
  }

  const url = `${baseUrl}/${accountId}/analytics_engine/sql`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('Analytics Engine SQL API error', {
      status: response.status,
      body: body.slice(0, 500),
      sql: sql.slice(0, 300),
    });
    throw errors.internal(`Analytics Engine query failed: ${response.status} — ${body.slice(0, 300)}`);
  }

  const body = await response.json() as { data?: unknown[]; meta?: unknown[] };
  // Return only the data rows — do not leak internal column metadata to the client
  return body.data ?? [];
}

/**
 * GET /api/admin/analytics/dau — Daily active users (last N days)
 */
adminAnalyticsRoutes.get('/dau', async (c) => {
  const periodDays = parsePositiveInt(c.env.ANALYTICS_DEFAULT_PERIOD_DAYS, DEFAULT_PERIOD_DAYS);
  const dataset = c.env.ANALYTICS_DATASET || DEFAULT_DATASET;

  const sql = `
    SELECT
      toDate(timestamp) AS date,
      uniq(index1) AS unique_users
    FROM ${dataset}
    WHERE timestamp >= NOW() - INTERVAL '${periodDays}' DAY
      AND blob1 != ''
      AND index1 != 'anonymous'
    GROUP BY date
    ORDER BY date ASC
  `;

  const data = await queryAnalyticsEngine(c.env, sql);
  return c.json({ dau: data, periodDays });
});

/**
 * GET /api/admin/analytics/events — Top events with counts
 * Query param: ?period=24h|7d|30d (default 7d)
 */
adminAnalyticsRoutes.get('/events', async (c) => {
  const period = c.req.query('period') || '7d';
  const dataset = c.env.ANALYTICS_DATASET || DEFAULT_DATASET;
  const intervalExpr = periodToInterval(period);
  const topEventsLimit = parsePositiveInt(c.env.ANALYTICS_TOP_EVENTS_LIMIT, DEFAULT_TOP_EVENTS_LIMIT);

  const sql = `
    SELECT
      blob1 AS event_name,
      count() AS count,
      uniq(index1) AS unique_users,
      avg(double1) AS avg_response_ms
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 != ''
    GROUP BY event_name
    ORDER BY count DESC
    LIMIT ${topEventsLimit}
  `;

  const data = await queryAnalyticsEngine(c.env, sql);
  return c.json({ events: data, period });
});

/**
 * GET /api/admin/analytics/funnel — Conversion funnel
 * signup → project_created → workspace_created → task_submitted
 */
adminAnalyticsRoutes.get('/funnel', async (c) => {
  const periodDays = parsePositiveInt(c.env.ANALYTICS_DEFAULT_PERIOD_DAYS, DEFAULT_PERIOD_DAYS);
  const dataset = c.env.ANALYTICS_DATASET || DEFAULT_DATASET;

  const sql = `
    SELECT
      blob1 AS event_name,
      uniq(index1) AS unique_users
    FROM ${dataset}
    WHERE timestamp >= NOW() - INTERVAL '${periodDays}' DAY
      AND blob1 IN ('signup', 'login', 'project_created', 'workspace_created', 'task_submitted')
      AND index1 != 'anonymous'
    GROUP BY event_name
  `;

  const data = await queryAnalyticsEngine(c.env, sql);
  return c.json({ funnel: data, periodDays });
});

/**
 * GET /api/admin/analytics/feature-adoption — Feature adoption with daily trend
 * Query param: ?period=24h|7d|30d|90d (default 30d)
 *
 * Returns per-feature-event counts + unique users + daily breakdown for sparklines.
 */
adminAnalyticsRoutes.get('/feature-adoption', async (c) => {
  const period = c.req.query('period') || '30d';
  const dataset = c.env.ANALYTICS_DATASET || DEFAULT_DATASET;
  const intervalExpr = periodToInterval(period);

  const eventList = FEATURE_EVENTS.map((e) => `'${e}'`).join(', ');

  // Aggregate totals per event
  const totalsSql = `
    SELECT
      blob1 AS event_name,
      count() AS count,
      uniq(index1) AS unique_users
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 IN (${eventList})
      AND index1 != 'anonymous'
    GROUP BY event_name
    ORDER BY count DESC
  `;

  // Daily trend per event for sparklines
  const trendSql = `
    SELECT
      blob1 AS event_name,
      toDate(timestamp) AS date,
      count() AS count
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 IN (${eventList})
      AND index1 != 'anonymous'
    GROUP BY event_name, date
    ORDER BY event_name, date ASC
  `;

  const [totals, trend] = await Promise.all([
    queryAnalyticsEngine(c.env, totalsSql),
    queryAnalyticsEngine(c.env, trendSql),
  ]);

  return c.json({ totals, trend, period });
});

/**
 * GET /api/admin/analytics/geo — Geographic distribution of users
 * Query param: ?period=24h|7d|30d|90d (default 30d)
 */
adminAnalyticsRoutes.get('/geo', async (c) => {
  const period = c.req.query('period') || '30d';
  const dataset = c.env.ANALYTICS_DATASET || DEFAULT_DATASET;
  const intervalExpr = periodToInterval(period);
  const geoLimit = parsePositiveInt(c.env.ANALYTICS_GEO_LIMIT, DEFAULT_GEO_LIMIT);

  const sql = `
    SELECT
      blob10 AS country,
      count() AS event_count,
      uniq(index1) AS unique_users
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob10 != ''
      AND index1 != 'anonymous'
    GROUP BY country
    ORDER BY unique_users DESC
    LIMIT ${geoLimit}
  `;

  const data = await queryAnalyticsEngine(c.env, sql);
  return c.json({ geo: data, period });
});

/**
 * GET /api/admin/analytics/retention — Weekly cohort retention
 * Query param: ?weeks=N (default from ANALYTICS_RETENTION_WEEKS, fallback 12)
 *
 * Groups users by signup week, then checks how many returned in each subsequent week.
 * Uses a self-join style query: first appearance (signup event) defines the cohort week,
 * then any subsequent event defines "returned in week N".
 */
adminAnalyticsRoutes.get('/retention', async (c) => {
  const dataset = c.env.ANALYTICS_DATASET || DEFAULT_DATASET;
  const weeks = parsePositiveInt(c.req.query('weeks') || c.env.ANALYTICS_RETENTION_WEEKS, DEFAULT_RETENTION_WEEKS);

  // Two-query approach:
  // 1. Get cohort week (first activity) per user
  // 2. Get all active weeks per user
  // Then compute retention on the API layer for flexibility.
  //
  // NOTE: Analytics Engine SQL does not support toStartOfWeek — use
  // toStartOfInterval(timestamp, INTERVAL 7 DAY) which buckets into
  // epoch-aligned 7-day intervals.

  const cohortSql = `
    SELECT
      index1 AS user_id,
      min(toStartOfInterval(timestamp, INTERVAL 7 DAY)) AS cohort_week
    FROM ${dataset}
    WHERE timestamp >= NOW() - INTERVAL '${weeks * 7}' DAY
      AND index1 != 'anonymous'
      AND blob1 != ''
    GROUP BY user_id
    LIMIT ${MAX_RETENTION_QUERY_ROWS}
  `;

  const activitySql = `
    SELECT
      index1 AS user_id,
      toStartOfInterval(timestamp, INTERVAL 7 DAY) AS active_week
    FROM ${dataset}
    WHERE timestamp >= NOW() - INTERVAL '${weeks * 7}' DAY
      AND index1 != 'anonymous'
      AND blob1 != ''
    GROUP BY user_id, active_week
    LIMIT ${MAX_RETENTION_QUERY_ROWS}
  `;

  const [cohortData, activityData] = await Promise.all([
    queryAnalyticsEngine(c.env, cohortSql) as Promise<Array<{ user_id: string; cohort_week: string }>>,
    queryAnalyticsEngine(c.env, activitySql) as Promise<Array<{ user_id: string; active_week: string }>>,
  ]);

  // Build cohort map: userId -> cohort_week
  const userCohort = new Map<string, string>();
  for (const row of cohortData) {
    userCohort.set(row.user_id, row.cohort_week);
  }

  // Build retention matrix: cohort_week -> { week_offset -> Set<userId> }
  const cohorts = new Map<string, Map<number, Set<string>>>();
  for (const row of activityData) {
    const cw = userCohort.get(row.user_id);
    if (!cw) continue;

    const cohortTime = new Date(cw).getTime();
    const activeTime = new Date(row.active_week).getTime();
    const weekOffset = Math.round((activeTime - cohortTime) / (7 * 24 * 60 * 60 * 1000));

    if (weekOffset < 0 || weekOffset > weeks) continue;

    if (!cohorts.has(cw)) {
      cohorts.set(cw, new Map());
    }
    const weekMap = cohorts.get(cw)!;
    if (!weekMap.has(weekOffset)) {
      weekMap.set(weekOffset, new Set());
    }
    weekMap.get(weekOffset)!.add(row.user_id);
  }

  // Convert to serializable format, sorted by cohort week
  const retention = Array.from(cohorts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortWeek, weekMap]) => {
      const cohortSize = weekMap.get(0)?.size ?? 0;
      const weekOffsets: Array<{ week: number; users: number; rate: number }> = [];

      for (const [offset, users] of Array.from(weekMap.entries()).sort(([a], [b]) => a - b)) {
        weekOffsets.push({
          week: offset,
          users: users.size,
          rate: cohortSize > 0 ? Math.round((users.size / cohortSize) * 100) : 0,
        });
      }

      return { cohortWeek, cohortSize, weeks: weekOffsets };
    });

  const truncated =
    cohortData.length >= MAX_RETENTION_QUERY_ROWS ||
    activityData.length >= MAX_RETENTION_QUERY_ROWS;

  return c.json({ retention, weeks, truncated });
});

/**
 * GET /api/admin/analytics/forward-status — Forwarding configuration and cursor state
 */
adminAnalyticsRoutes.get('/forward-status', async (c) => {
  const status = await getForwardStatus(c.env);
  return c.json(status);
});

export { adminAnalyticsRoutes };
