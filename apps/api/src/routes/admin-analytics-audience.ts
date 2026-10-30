import { type Hono } from 'hono';

import type { Env } from '../env';
import { getAnalyticsDataset } from '../lib/analytics-config';
import {
  DEFAULT_RETENTION_WEEKS,
  DEFAULT_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT,
  MAX_RETENTION_QUERY_ROWS,
  parsePeriod,
  parsePositiveInt,
  periodToInterval,
  queryAnalyticsEngine,
} from './admin-analytics-query';
export function registerAdminAudienceAnalyticsRoutes(
  adminAnalyticsRoutes: Hono<{ Bindings: Env }>
) {
  adminAnalyticsRoutes.get('/retention', async (c) => {
    const dataset = getAnalyticsDataset(c.env);
    const weeks = parsePositiveInt(
      c.req.query('weeks') || c.env.ANALYTICS_RETENTION_WEEKS,
      DEFAULT_RETENTION_WEEKS
    );

    // Two-query approach:
    // 1. Get cohort week (first activity) per user
    // 2. Get all active weeks per user
    // Then compute retention on the API layer for flexibility.
    //
    // NOTE: Analytics Engine SQL does not support toStartOfWeek — use
    // toStartOfInterval(timestamp, INTERVAL '7' DAY) which buckets into
    // epoch-aligned 7-day intervals.

    const cohortSql = `
    SELECT
      index1 AS user_id,
      min(toStartOfInterval(timestamp, INTERVAL '7' DAY)) AS cohort_week
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
      toStartOfInterval(timestamp, INTERVAL '7' DAY) AS active_week
    FROM ${dataset}
    WHERE timestamp >= NOW() - INTERVAL '${weeks * 7}' DAY
      AND index1 != 'anonymous'
      AND blob1 != ''
    GROUP BY user_id, active_week
    LIMIT ${MAX_RETENTION_QUERY_ROWS}
  `;

    const [cohortData, activityData] = await Promise.all([
      queryAnalyticsEngine(c.env, cohortSql) as Promise<
        Array<{ user_id: string; cohort_week: string }>
      >,
      queryAnalyticsEngine(c.env, activitySql) as Promise<
        Array<{ user_id: string; active_week: string }>
      >,
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

      let weekMap = cohorts.get(cw);
      if (!weekMap) {
        weekMap = new Map<number, Set<string>>();
        cohorts.set(cw, weekMap);
      }
      let userSet = weekMap.get(weekOffset);
      if (!userSet) {
        userSet = new Set<string>();
        weekMap.set(weekOffset, userSet);
      }
      userSet.add(row.user_id);
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
   * GET /api/admin/analytics/website-traffic — Website traffic by section and top pages
   * Query param: ?period=24h|7d|30d|90d (default 7d)
   *
   * Groups page_view events from the marketing site (identified by host in blob2)
   * into sections (Landing, Blog, Docs, Presentations) and returns top pages per section.
   *
   * blob2 stores host for client-side events (e.g. www.simple-agent-manager.org)
   * while API middleware events store projectId in blob2. Website traffic queries
   * filter on blob1='page_view' which only comes from client-side events.
   */
  adminAnalyticsRoutes.get('/website-traffic', async (c) => {
    const period = parsePeriod(c.req.query('period'));
    const dataset = getAnalyticsDataset(c.env);
    const intervalExpr = periodToInterval(period);
    const topPagesLimit = parsePositiveInt(
      c.env.ANALYTICS_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT,
      DEFAULT_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT
    );

    // Section totals: group page_view events by host and path prefix.
    // NOTE: blob2 = host for client-side events (page_view), blob2 = projectId for API events.
    // The blob1='page_view' filter isolates client events since only the tracker sends this event.
    // blob8 = sessionId for client events (browser session), requestId for API events.
    const sectionsSql = `
    SELECT
      blob2 AS host,
      count() AS total_views,
      count(DISTINCT index1) AS unique_visitors,
      count(DISTINCT blob8) AS unique_sessions
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 = 'page_view'
      AND blob2 != ''
    GROUP BY host
    ORDER BY total_views DESC
  `;

    // Top pages across all hosts (approximate: fetches topPagesLimit*5 globally, then groups in-memory)
    const topPagesSql = `
    SELECT
      blob2 AS host,
      blob3 AS page,
      count() AS views,
      count(DISTINCT index1) AS unique_visitors
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 = 'page_view'
      AND blob2 != ''
      AND blob3 != ''
    GROUP BY host, page
    ORDER BY views DESC
    LIMIT ${topPagesLimit * 5}
  `;

    // Daily trend for sparkline (capped at 500 rows to stay within AE limits)
    const trendSql = `
    SELECT
      blob2 AS host,
      toDate(timestamp) AS date,
      count() AS views
    FROM ${dataset}
    WHERE timestamp >= NOW() - ${intervalExpr}
      AND blob1 = 'page_view'
      AND blob2 != ''
    GROUP BY host, date
    ORDER BY host, date ASC
    LIMIT 500
  `;

    const [hostTotals, topPagesData, trendData] = await Promise.all([
      queryAnalyticsEngine(c.env, sectionsSql) as Promise<
        Array<{
          host: string;
          total_views: string;
          unique_visitors: string;
          unique_sessions: string;
        }>
      >,
      queryAnalyticsEngine(c.env, topPagesSql) as Promise<
        Array<{ host: string; page: string; views: string; unique_visitors: string }>
      >,
      queryAnalyticsEngine(c.env, trendSql) as Promise<
        Array<{ host: string; date: string; views: string }>
      >,
    ]);

    // Categorize pages into sections based on path prefix
    type SectionName = 'landing' | 'blog' | 'docs' | 'presentations' | 'other';
    function classifyPage(page: string): SectionName {
      if (page.startsWith('/blog')) return 'blog';
      if (page.startsWith('/docs')) return 'docs';
      if (page.startsWith('/presentations')) return 'presentations';
      if (page === '/' || page === '') return 'landing';
      return 'other';
    }

    // Build per-host section breakdowns from top pages data
    const hostSections = new Map<
      string,
      Map<
        SectionName,
        {
          views: number;
          unique_visitors: number;
          pages: Array<{ page: string; views: number; unique_visitors: number }>;
        }
      >
    >();

    for (const row of topPagesData) {
      let sections = hostSections.get(row.host);
      if (!sections) {
        sections = new Map();
        hostSections.set(row.host, sections);
      }
      const section = classifyPage(row.page);

      let s = sections.get(section);
      if (!s) {
        s = { views: 0, unique_visitors: 0, pages: [] };
        sections.set(section, s);
      }
      s.views += Number(row.views);
      s.unique_visitors += Number(row.unique_visitors);
      if (s.pages.length < topPagesLimit) {
        s.pages.push({
          page: row.page,
          views: Number(row.views),
          unique_visitors: Number(row.unique_visitors),
        });
      }
    }

    // Build response
    const hosts = hostTotals.map((ht) => {
      const sections = hostSections.get(ht.host);
      const sectionList: Array<{
        name: SectionName;
        views: number;
        unique_visitors: number;
        topPages: Array<{ page: string; views: number; unique_visitors: number }>;
      }> = [];

      if (sections) {
        for (const [name, data] of sections.entries()) {
          sectionList.push({
            name,
            views: data.views,
            unique_visitors: data.unique_visitors,
            topPages: data.pages,
          });
        }
        sectionList.sort((a, b) => b.views - a.views);
      }

      return {
        host: ht.host,
        totalViews: Number(ht.total_views),
        uniqueVisitors: Number(ht.unique_visitors),
        uniqueSessions: Number(ht.unique_sessions),
        sections: sectionList,
      };
    });

    const trend = (trendData as Array<{ host: string; date: string; views: string }>).map(
      (row) => ({
        host: row.host,
        date: row.date,
        views: Number(row.views),
      })
    );

    return c.json({ hosts, trend, period });
  });

  /**
   * GET /api/admin/analytics/forward-status — Forwarding configuration and cursor state
   */
}
