import { Hono } from 'hono';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { adminAnalyticsRoutes } from '../../../src/routes/admin-analytics';

// Mock auth middleware — skip auth for unit tests
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

describe('admin-analytics routes', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const CF_ACCOUNT_ID = 'test-account-123';
  const CF_API_TOKEN = 'test-token-abc';

  function createApp(envOverrides: Record<string, unknown> = {}) {
    const app = new Hono();

    app.use('*', async (c, next) => {
      (c.env as Record<string, unknown>) = {
        CF_ACCOUNT_ID,
        CF_API_TOKEN,
        ...envOverrides,
      };
      await next();
    });

    app.route('/api/admin/analytics', adminAnalyticsRoutes);
    return app;
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('GET /dau queries Analytics Engine with correct SQL', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/dau');

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain(`${CF_ACCOUNT_ID}/analytics_engine/sql`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${CF_API_TOKEN}`);
    expect(opts.body).toContain('count(DISTINCT index1)');
    expect(opts.body).toContain('sam_analytics');
  });

  it('GET /events accepts period query param', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/events?period=24h');

    expect(res.status).toBe(200);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain("INTERVAL '1' DAY");
  });

  it('GET /events defaults to 7d period', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    await app.request('/api/admin/analytics/events');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain("INTERVAL '7' DAY");
  });

  it('GET /funnel queries for conversion events', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/funnel');

    expect(res.status).toBe(200);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain('signup');
    expect(opts.body).toContain('project_created');
    expect(opts.body).toContain('task_submitted');
  });

  it('returns 500 when CF_ACCOUNT_ID is missing', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp({ CF_ACCOUNT_ID: '' });

    // The route should throw an error that gets caught by the error handler
    const res = await app.request('/api/admin/analytics/dau');
    // Without an error handler, Hono returns 500 on unhandled throws
    expect(res.status).toBe(500);
  });

  it('returns 500 when Analytics Engine API returns error', async () => {
    mockFetch.mockResolvedValue(new Response('Bad request', { status: 400 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/dau');
    expect(res.status).toBe(500);
  });

  it('uses custom dataset name from env', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp({ ANALYTICS_DATASET: 'custom_dataset' });
    await app.request('/api/admin/analytics/dau');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain('custom_dataset');
    expect(opts.body).not.toContain('sam_analytics');
  });

  it('uses custom SQL API URL from env', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp({ ANALYTICS_SQL_API_URL: 'https://custom.api.example.com/accounts' });
    await app.request('/api/admin/analytics/dau');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('custom.api.example.com');
  });

  it('GET /events?period=30d uses 30 day interval', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    await app.request('/api/admin/analytics/events?period=30d');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain("INTERVAL '30' DAY");
  });

  it('GET /dau returns correct JSON shape with data array', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ date: '2026-03-27', unique_users: 5 }] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/dau');
    const json = await res.json() as { dau: unknown[]; periodDays: number };

    expect(json).toHaveProperty('dau');
    expect(json).toHaveProperty('periodDays');
    expect(Array.isArray(json.dau)).toBe(true);
    expect(json.dau).toHaveLength(1);
  });

  it('GET /events returns correct JSON shape with data array', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/events');
    const json = await res.json() as { events: unknown[]; period: string };

    expect(json).toHaveProperty('events');
    expect(json).toHaveProperty('period');
    expect(Array.isArray(json.events)).toBe(true);
  });

  it('GET /funnel returns correct JSON shape with data array', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/funnel');
    const json = await res.json() as { funnel: unknown[]; periodDays: number };

    expect(json).toHaveProperty('funnel');
    expect(json).toHaveProperty('periodDays');
    expect(Array.isArray(json.funnel)).toBe(true);
  });

  it('returns 500 when fetch rejects (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/dau');
    expect(res.status).toBe(500);
  });

  it('uses custom ANALYTICS_TOP_EVENTS_LIMIT from env', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp({ ANALYTICS_TOP_EVENTS_LIMIT: '25' });
    await app.request('/api/admin/analytics/events');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain('LIMIT 25');
  });

  // -------------------------------------------------------------------------
  // Numeric conversion: Analytics Engine returns strings, API must convert
  // -------------------------------------------------------------------------

  describe('numeric conversion from Analytics Engine string values', () => {
    it('GET /dau converts unique_users from string to number', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({
        data: [
          { date: '2026-03-27', unique_users: '5' },
          { date: '2026-03-28', unique_users: '12' },
        ],
      }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/dau');
      const json = await res.json() as { dau: Array<{ unique_users: number }> };

      expect(typeof json.dau[0].unique_users).toBe('number');
      expect(json.dau[0].unique_users).toBe(5);
      expect(json.dau[1].unique_users).toBe(12);
    });

    it('GET /events converts count, unique_users, avg_response_ms from string to number', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({
        data: [
          { event_name: 'signup', count: '100', unique_users: '42', avg_response_ms: '123.456' },
          { event_name: 'login', count: '200', unique_users: '38', avg_response_ms: '89.1' },
        ],
      }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/events');
      const json = await res.json() as { events: Array<{ count: number; unique_users: number; avg_response_ms: number }> };

      expect(typeof json.events[0].count).toBe('number');
      expect(json.events[0].count).toBe(100);
      expect(json.events[0].unique_users).toBe(42);
      expect(json.events[0].avg_response_ms).toBeCloseTo(123.456);

      // Verify summing works (this was the original bug — string concatenation)
      const total = json.events.reduce((s, e) => s + e.count, 0);
      expect(total).toBe(300); // not "100200"
    });

    it('GET /funnel converts unique_users from string to number', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({
        data: [
          { event_name: 'signup', unique_users: '50' },
          { event_name: 'task_submitted', unique_users: '10' },
        ],
      }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/funnel');
      const json = await res.json() as { funnel: Array<{ unique_users: number }> };

      expect(typeof json.funnel[0].unique_users).toBe('number');
      expect(json.funnel[0].unique_users).toBe(50);
      // Verify division works (would be NaN or wrong with strings)
      const rate = Math.round((json.funnel[1].unique_users / json.funnel[0].unique_users) * 100);
      expect(rate).toBe(20);
    });

    it('GET /feature-adoption converts count and unique_users from string to number', async () => {
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const sql = (init as { body?: string }).body ?? '';
        const data = sql.includes('toDate(timestamp)')
          ? [{ event_name: 'task_submitted', date: '2026-03-25', count: '15' }]
          : [{ event_name: 'task_submitted', count: '42', unique_users: '10' }];
        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/feature-adoption');
      const json = await res.json() as {
        totals: Array<{ count: number; unique_users: number }>;
        trend: Array<{ count: number }>;
      };

      expect(typeof json.totals[0].count).toBe('number');
      expect(json.totals[0].count).toBe(42);
      expect(json.totals[0].unique_users).toBe(10);
      expect(typeof json.trend[0].count).toBe('number');
      expect(json.trend[0].count).toBe(15);
    });

    it('GET /geo converts event_count and unique_users from string to number', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({
        data: [
          { country: 'US', event_count: '100', unique_users: '20' },
          { country: 'DE', event_count: '50', unique_users: '10' },
        ],
      }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/geo');
      const json = await res.json() as { geo: Array<{ event_count: number; unique_users: number }> };

      expect(typeof json.geo[0].event_count).toBe('number');
      expect(json.geo[0].event_count).toBe(100);
      expect(json.geo[0].unique_users).toBe(20);
    });

    it('GET /website-traffic converts host totals and trend views from string to number', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        callCount++;
        const sql = (init as { body?: string }).body ?? '';
        if (sql.includes('toDate(timestamp)')) {
          // trend query
          return new Response(JSON.stringify({
            data: [{ host: 'example.com', date: '2026-03-28', views: '55' }],
          }), { status: 200 });
        } else if (sql.includes('blob3 AS page')) {
          // top pages query
          return new Response(JSON.stringify({
            data: [{ host: 'example.com', page: '/', views: '30', unique_visitors: '10' }],
          }), { status: 200 });
        } else {
          // sections (host totals) query
          return new Response(JSON.stringify({
            data: [{ host: 'example.com', total_views: '80', unique_visitors: '25', unique_sessions: '18' }],
          }), { status: 200 });
        }
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/website-traffic');
      expect(res.status).toBe(200);

      const json = await res.json() as {
        hosts: Array<{ totalViews: number; uniqueVisitors: number; uniqueSessions: number }>;
        trend: Array<{ views: number }>;
      };

      // Host totals converted from strings
      expect(typeof json.hosts[0].totalViews).toBe('number');
      expect(json.hosts[0].totalViews).toBe(80);
      expect(json.hosts[0].uniqueVisitors).toBe(25);
      expect(json.hosts[0].uniqueSessions).toBe(18);

      // Trend converted from strings
      expect(typeof json.trend[0].views).toBe('number');
      expect(json.trend[0].views).toBe(55);

      expect(callCount).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3: Feature Adoption
  // -------------------------------------------------------------------------

  describe('GET /api/admin/analytics/feature-adoption', () => {
    it('returns totals and trend data with default 30d period', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        callCount++;
        const sql = (init as { body?: string }).body ?? '';
        const data = sql.includes('toDate(timestamp)')
          ? [{ event_name: 'task_submitted', date: '2026-03-25', count: 5 }]
          : [{ event_name: 'task_submitted', count: 42, unique_users: 10 }];
        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/feature-adoption');
      expect(res.status).toBe(200);

      const body = await res.json() as { totals: unknown[]; trend: unknown[]; period: string };
      expect(body.period).toBe('30d');
      expect(body.totals).toHaveLength(1);
      expect(body.trend).toHaveLength(1);
      expect(callCount).toBe(2);
    });

    it('passes custom period to SQL queries', async () => {
      const capturedSql: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSql.push((init as { body?: string }).body ?? '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/feature-adoption?period=7d');
      const body = await res.json() as { period: string };
      expect(body.period).toBe('7d');
      expect(capturedSql.every((sql) => sql.includes("INTERVAL '7' DAY"))).toBe(true);
    });

    it('only queries known feature events', async () => {
      const capturedSql: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSql.push((init as { body?: string }).body ?? '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      await app.request('/api/admin/analytics/feature-adoption');

      for (const sql of capturedSql) {
        expect(sql).toContain("'task_submitted'");
        expect(sql).toContain("'project_created'");
        expect(sql).not.toContain("'page_view'");
        expect(sql).not.toContain("'login'");
      }
    });

    it('issues exactly two parallel SQL queries (totals + trend)', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      await app.request('/api/admin/analytics/feature-adoption');
      expect(callCount).toBe(2);
    });

    it('returns 500 when CF API fails for either sub-query', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        // Fail on the second call (trend query)
        if (callCount === 2) {
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/feature-adoption');
      expect(res.status).toBe(500);
    });

    it('returns empty totals and trend for no matching data', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const app = createApp();
      const res = await app.request('/api/admin/analytics/feature-adoption');
      const body = await res.json() as { totals: unknown[]; trend: unknown[] };
      expect(body.totals).toEqual([]);
      expect(body.trend).toEqual([]);
    });

    it('queries all FEATURE_EVENTS in the IN clause', async () => {
      const capturedSql: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSql.push((init as { body?: string }).body ?? '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      await app.request('/api/admin/analytics/feature-adoption');

      const expectedEvents = [
        'workspace_created', 'workspace_started', 'workspace_stopped',
        'task_completed', 'task_failed',
        'node_created', 'node_deleted',
        'credential_saved', 'session_created', 'settings_changed',
      ];
      for (const event of expectedEvents) {
        for (const sql of capturedSql) {
          expect(sql).toContain(`'${event}'`);
        }
      }
    });

    it('accepts 90d period', async () => {
      const capturedSql: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSql.push((init as { body?: string }).body ?? '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/feature-adoption?period=90d');
      const body = await res.json() as { period: string };
      expect(body.period).toBe('90d');
      expect(capturedSql.every((sql) => sql.includes("INTERVAL '90' DAY"))).toBe(true);
    });

    it('excludes anonymous users from both queries', async () => {
      const capturedSql: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSql.push((init as { body?: string }).body ?? '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      await app.request('/api/admin/analytics/feature-adoption');

      for (const sql of capturedSql) {
        expect(sql).toContain("index1 != 'anonymous'");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3: Geographic Distribution
  // -------------------------------------------------------------------------

  describe('GET /api/admin/analytics/geo', () => {
    it('returns country distribution data', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({
        data: [
          { country: 'US', event_count: 100, unique_users: 20 },
          { country: 'DE', event_count: 50, unique_users: 10 },
        ],
      }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/geo');
      expect(res.status).toBe(200);

      const body = await res.json() as { geo: Array<{ country: string; unique_users: number }>; period: string };
      expect(body.period).toBe('30d');
      expect(body.geo).toHaveLength(2);
      expect(body.geo[0].country).toBe('US');
    });

    it('uses custom geo limit from env', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp({ ANALYTICS_GEO_LIMIT: '10' });
      await app.request('/api/admin/analytics/geo');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain('LIMIT 10');
    });

    it('excludes anonymous users and empty countries', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp();
      await app.request('/api/admin/analytics/geo');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain("blob10 != ''");
      expect(opts.body).toContain("index1 != 'anonymous'");
    });

    it('accepts period query param', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/geo?period=7d');
      const body = await res.json() as { period: string };
      expect(body.period).toBe('7d');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain("INTERVAL '7' DAY");
    });

    it('returns empty geo array when no data', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/geo');
      const body = await res.json() as { geo: unknown[] };
      expect(body.geo).toEqual([]);
    });

    it('default geo limit of 50 is applied when env var not set', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp();
      await app.request('/api/admin/analytics/geo');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain('LIMIT 50');
    });

    it('orders results by unique_users DESC', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp();
      await app.request('/api/admin/analytics/geo');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain('ORDER BY unique_users DESC');
    });

    it('returns 500 when CF API returns error', async () => {
      mockFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));

      const app = createApp();
      const res = await app.request('/api/admin/analytics/geo');
      expect(res.status).toBe(500);
    });

    it('ignores non-positive ANALYTICS_GEO_LIMIT and falls back to default 50', async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const app = createApp({ ANALYTICS_GEO_LIMIT: '0' });
      await app.request('/api/admin/analytics/geo');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain('LIMIT 50');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3: Retention Cohorts
  // -------------------------------------------------------------------------

  describe('GET /api/admin/analytics/retention', () => {
    it('computes cohort retention matrix from raw query data', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        callCount++;
        const sql = (init as { body?: string }).body ?? '';
        let data: unknown[];

        if (sql.includes('min(toStartOfInterval')) {
          data = [
            { user_id: 'user-1', cohort_week: '2026-03-10' },
            { user_id: 'user-2', cohort_week: '2026-03-10' },
            { user_id: 'user-3', cohort_week: '2026-03-17' },
          ];
        } else {
          data = [
            { user_id: 'user-1', active_week: '2026-03-10' },
            { user_id: 'user-1', active_week: '2026-03-17' },
            { user_id: 'user-2', active_week: '2026-03-10' },
            { user_id: 'user-3', active_week: '2026-03-17' },
            { user_id: 'user-3', active_week: '2026-03-24' },
          ];
        }

        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        weeks: number;
        retention: Array<{
          cohortWeek: string;
          cohortSize: number;
          weeks: Array<{ week: number; users: number; rate: number }>;
        }>;
      };
      expect(body.weeks).toBe(12);
      expect(body.retention).toHaveLength(2);

      // Cohort 2026-03-10: 2 users in W0, 1 in W1
      expect(body.retention[0].cohortWeek).toBe('2026-03-10');
      expect(body.retention[0].cohortSize).toBe(2);
      expect(body.retention[0].weeks[0]).toEqual({ week: 0, users: 2, rate: 100 });
      expect(body.retention[0].weeks[1]).toEqual({ week: 1, users: 1, rate: 50 });

      // Cohort 2026-03-17: 1 user in W0, 1 in W1
      expect(body.retention[1].cohortWeek).toBe('2026-03-17');
      expect(body.retention[1].cohortSize).toBe(1);
      expect(callCount).toBe(2);
    });

    it('uses custom weeks from query param', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention?weeks=8');
      const body = await res.json() as { weeks: number };
      expect(body.weeks).toBe(8);

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain("INTERVAL '56' DAY"); // 8 * 7
    });

    it('uses env var for default retention weeks', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const app = createApp({ ANALYTICS_RETENTION_WEEKS: '6' });
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as { weeks: number };
      expect(body.weeks).toBe(6);
    });

    it('returns empty retention for no data', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as { retention: unknown[] };
      expect(body.retention).toEqual([]);
    });

    it('cohort W0 rate is always 100% when cohort has at least one user', async () => {
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const sql = (init as { body?: string }).body ?? '';
        const data = sql.includes('min(toStartOfInterval')
          ? [{ user_id: 'user-1', cohort_week: '2026-03-10' }]
          : [{ user_id: 'user-1', active_week: '2026-03-10' }];
        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as {
        retention: Array<{ cohortSize: number; weeks: Array<{ week: number; rate: number }> }>;
      };
      expect(body.retention[0].cohortSize).toBe(1);
      expect(body.retention[0].weeks[0]).toEqual({ week: 0, users: 1, rate: 100 });
    });

    it('discards activity rows for users with no cohort entry', async () => {
      // user-orphan has activity but no cohort entry — should be silently excluded
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const sql = (init as { body?: string }).body ?? '';
        const data = sql.includes('min(toStartOfInterval')
          ? [{ user_id: 'user-1', cohort_week: '2026-03-10' }]
          : [
              { user_id: 'user-1', active_week: '2026-03-10' },
              { user_id: 'user-orphan', active_week: '2026-03-10' }, // no cohort row
            ];
        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as {
        retention: Array<{ cohortSize: number }>;
      };
      // Only user-1 cohort, size 1 — orphan is not double-counted
      expect(body.retention).toHaveLength(1);
      expect(body.retention[0].cohortSize).toBe(1);
    });

    it('cohorts are returned sorted by cohort week ascending', async () => {
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const sql = (init as { body?: string }).body ?? '';
        // Intentionally return cohorts in reverse chronological order to verify sort
        const data = sql.includes('min(toStartOfInterval')
          ? [
              { user_id: 'user-b', cohort_week: '2026-03-24' },
              { user_id: 'user-a', cohort_week: '2026-03-10' },
            ]
          : [
              { user_id: 'user-b', active_week: '2026-03-24' },
              { user_id: 'user-a', active_week: '2026-03-10' },
            ];
        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as {
        retention: Array<{ cohortWeek: string }>;
      };
      expect(body.retention[0].cohortWeek).toBe('2026-03-10');
      expect(body.retention[1].cohortWeek).toBe('2026-03-24');
    });

    it('clamps activity that falls outside the valid week window', async () => {
      // user-1 has an active_week that precedes their cohort_week by 1 week (weekOffset = -1)
      // and another that is beyond the `weeks` param (weekOffset = 100)
      // Neither should appear in the output
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const sql = (init as { body?: string }).body ?? '';
        const data = sql.includes('min(toStartOfInterval')
          ? [{ user_id: 'user-1', cohort_week: '2026-03-17' }]
          : [
              { user_id: 'user-1', active_week: '2026-03-17' }, // W0 — valid
              { user_id: 'user-1', active_week: '2026-03-10' }, // W-1 — negative offset, excluded
              { user_id: 'user-1', active_week: '2028-03-17' }, // way in the future, > weeks, excluded
            ];
        return new Response(JSON.stringify({ data }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention?weeks=4');
      const body = await res.json() as {
        retention: Array<{ cohortWeek: string; weeks: Array<{ week: number }> }>;
      };
      expect(body.retention).toHaveLength(1);
      // Only W0 should be present (the negative and far-future offsets were dropped)
      expect(body.retention[0].weeks.map((w) => w.week)).toEqual([0]);
    });

    it('default weeks is 12 when env var is absent', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as { weeks: number };
      expect(body.weeks).toBe(12);

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toContain("INTERVAL '84' DAY"); // 12 * 7
    });

    it('ignores non-positive ANALYTICS_RETENTION_WEEKS and falls back to 12', async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const app = createApp({ ANALYTICS_RETENTION_WEEKS: '-5' });
      const res = await app.request('/api/admin/analytics/retention');
      const body = await res.json() as { weeks: number };
      expect(body.weeks).toBe(12);
    });

    it('issues exactly two SQL queries (cohort + activity)', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      await app.request('/api/admin/analytics/retention');
      expect(callCount).toBe(2);
    });

    it('returns 500 when CF API fails for the cohort query', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('Service unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      const res = await app.request('/api/admin/analytics/retention');
      expect(res.status).toBe(500);
    });

    it('includes a LIMIT clause in both cohort and activity queries to guard against truncation', async () => {
      const capturedSql: string[] = [];
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedSql.push((init as { body?: string }).body ?? '');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const app = createApp();
      await app.request('/api/admin/analytics/retention');

      expect(capturedSql).toHaveLength(2);
      for (const sql of capturedSql) {
        expect(sql).toMatch(/LIMIT \d+/);
      }
    });
  });
});
