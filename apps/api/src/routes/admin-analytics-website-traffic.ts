import { type Hono } from 'hono';

import type { Env } from '../env';
import { getAnalyticsDataset } from '../lib/analytics-config';
import {
  DEFAULT_WEBSITE_TRAFFIC_TOP_PAGES_LIMIT,
  parsePeriod,
  parsePositiveInt,
  periodToInterval,
  queryAnalyticsEngine,
} from './admin-analytics-query';
export function registerAdminWebsiteTrafficRoutes(adminAnalyticsRoutes: Hono<{ Bindings: Env }>) {
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
}
