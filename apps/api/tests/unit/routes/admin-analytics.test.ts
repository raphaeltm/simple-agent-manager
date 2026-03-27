import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
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
    expect(opts.body).toContain('uniq(index1)');
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

  it('GET /dau returns correct JSON shape', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ date: '2026-03-27', unique_users: 5 }] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/dau');
    const json = await res.json() as Record<string, unknown>;

    expect(json).toHaveProperty('dau');
    expect(json).toHaveProperty('periodDays');
  });

  it('GET /events returns correct JSON shape', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/events');
    const json = await res.json() as Record<string, unknown>;

    expect(json).toHaveProperty('events');
    expect(json).toHaveProperty('period');
  });

  it('GET /funnel returns correct JSON shape', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const app = createApp();
    const res = await app.request('/api/admin/analytics/funnel');
    const json = await res.json() as Record<string, unknown>;

    expect(json).toHaveProperty('funnel');
    expect(json).toHaveProperty('periodDays');
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
});
