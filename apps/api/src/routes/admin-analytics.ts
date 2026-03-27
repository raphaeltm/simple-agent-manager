import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth, requireApproved, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';

const DEFAULT_ANALYTICS_SQL_API_URL = 'https://api.cloudflare.com/client/v4/accounts';
const DEFAULT_PERIOD_DAYS = 30;
const DEFAULT_DATASET = 'sam_analytics';
const DEFAULT_TOP_EVENTS_LIMIT = 50;

/** Parse an integer env var with validation; returns fallback on NaN or non-positive values. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
    });
    throw errors.internal(`Analytics Engine query failed: ${response.status}`);
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

  let intervalExpr: string;
  switch (period) {
    case '24h':
      intervalExpr = "INTERVAL '1' DAY";
      break;
    case '30d':
      intervalExpr = "INTERVAL '30' DAY";
      break;
    case '7d':
    default:
      intervalExpr = "INTERVAL '7' DAY";
      break;
  }

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

export { adminAnalyticsRoutes };
