import { Hono } from 'hono';

import type { Env } from '../env';
import { getAnalyticsDataset } from '../lib/analytics-config';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getForwardStatus } from '../services/analytics-forward';
import { resolvePlatformCapabilities } from '../services/platform-capabilities';
import {
  DEFAULT_PERIOD_DAYS,
  DEFAULT_TOP_EVENTS_LIMIT,
  FEATURE_EVENTS,
  parsePeriod,
  parsePositiveInt,
  periodToInterval,
  queryAnalyticsEngine,
} from './admin-analytics-query';
import { registerAdminWebsiteTrafficRoutes } from './admin-analytics-website-traffic';
const adminAnalyticsRoutes = new Hono<{ Bindings: Env }>();

// All analytics routes require superadmin
adminAnalyticsRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

// Every query route reads Cloudflare's Analytics Engine SQL API, or a self-host local sink. With
// neither there is nothing to query (and no dataset name is configured), so answer "not available"
// before any route builds SQL. Forward status is local state and stays readable. Pure: no I/O.
adminAnalyticsRoutes.use('/*', async (c, next) => {
  if (
    !resolvePlatformCapabilities(c.env).analyticsQuery &&
    !c.req.path.endsWith('/forward-status')
  ) {
    throw errors.featureUnavailable(
      'analyticsQuery',
      'Analytics is not available on this installation'
    );
  }
  await next();
});
/**
 * GET /api/admin/analytics/dau — Daily active users (last N days)
 */
adminAnalyticsRoutes.get('/dau', async (c) => {
  const periodDays = parsePositiveInt(c.env.ANALYTICS_DEFAULT_PERIOD_DAYS, DEFAULT_PERIOD_DAYS);
  const dataset = getAnalyticsDataset(c.env);

  const sql = `
    SELECT
      toDate(timestamp) AS date,
      count(DISTINCT index1) AS unique_users
    FROM ${dataset}
    WHERE timestamp >= NOW() - INTERVAL '${periodDays}' DAY
      AND blob1 != ''
      AND index1 != 'anonymous'
    GROUP BY date
    ORDER BY date ASC
  `;

  const data = (await queryAnalyticsEngine(c.env, sql)) as Array<{
    date: string;
    unique_users: string;
  }>;
  const dau = data.map((row) => ({
    date: row.date,
    unique_users: Number(row.unique_users),
  }));
  return c.json({ dau, periodDays });
});

/**
 * GET /api/admin/analytics/events — Top events with counts
 * Query param: ?period=24h|7d|30d (default 7d)
 */
adminAnalyticsRoutes.get('/events', async (c) => {
  const period = parsePeriod(c.req.query('period'));
  const dataset = getAnalyticsDataset(c.env);
  const intervalExpr = periodToInterval(period);
  const topEventsLimit = parsePositiveInt(
    c.env.ANALYTICS_TOP_EVENTS_LIMIT,
    DEFAULT_TOP_EVENTS_LIMIT
  );

  const sql = `
    SELECT
      blob1 AS event_name,
      count() AS count,
      count(DISTINCT index1) AS unique_users,
      avg(double1) AS avg_response_ms
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 != ''
    GROUP BY event_name
    ORDER BY count DESC
    LIMIT ${topEventsLimit}
  `;

  const data = (await queryAnalyticsEngine(c.env, sql)) as Array<{
    event_name: string;
    count: string;
    unique_users: string;
    avg_response_ms: string;
  }>;
  const events = data.map((row) => ({
    event_name: row.event_name,
    count: Number(row.count),
    unique_users: Number(row.unique_users),
    avg_response_ms: Number(row.avg_response_ms),
  }));
  return c.json({ events, period });
});

/**
 * GET /api/admin/analytics/feature-adoption — Feature adoption with daily trend
 * Query param: ?period=24h|7d|30d|90d (default 30d)
 *
 * Returns per-feature-event counts + unique users + daily breakdown for sparklines.
 */
adminAnalyticsRoutes.get('/feature-adoption', async (c) => {
  const period = parsePeriod(c.req.query('period') || '30d');
  const dataset = getAnalyticsDataset(c.env);
  const intervalExpr = periodToInterval(period);

  const eventList = FEATURE_EVENTS.map((e) => `'${e}'`).join(', ');

  // Aggregate totals per event
  const totalsSql = `
    SELECT
      blob1 AS event_name,
      count() AS count,
      count(DISTINCT index1) AS unique_users
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

  const [totalsRaw, trendRaw] = await Promise.all([
    queryAnalyticsEngine(c.env, totalsSql) as Promise<
      Array<{ event_name: string; count: string; unique_users: string }>
    >,
    queryAnalyticsEngine(c.env, trendSql) as Promise<
      Array<{ event_name: string; date: string; count: string }>
    >,
  ]);

  const totals = totalsRaw.map((row) => ({
    event_name: row.event_name,
    count: Number(row.count),
    unique_users: Number(row.unique_users),
  }));
  const trend = trendRaw.map((row) => ({
    event_name: row.event_name,
    date: row.date,
    count: Number(row.count),
  }));

  return c.json({ totals, trend, period });
});

registerAdminWebsiteTrafficRoutes(adminAnalyticsRoutes);

/**
 * GET /api/admin/analytics/forward-status — Forwarding configuration and cursor state
 */
adminAnalyticsRoutes.get('/forward-status', async (c) => {
  const status = await getForwardStatus(c.env);
  return c.json(status);
});

export { adminAnalyticsRoutes };
