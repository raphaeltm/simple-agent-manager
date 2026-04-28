import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminCostRoutes } from '../../../src/routes/admin-costs';

// Mock auth middleware — skip auth for unit tests
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Mock node-usage service
vi.mock('../../../src/services/node-usage', () => ({
  getAllUsersNodeUsageSummary: vi.fn().mockResolvedValue({
    period: { start: '2026-04-01T00:00:00Z', end: '2026-04-30T23:59:59Z' },
    users: [
      {
        userId: 'user-1',
        totalNodeHours: 10,
        totalVcpuHours: 40,
        platformNodeHours: 5,
        activeNodes: 1,
      },
    ],
  }),
}));

// Mock drizzle
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));

describe('admin-costs routes', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const CF_ACCOUNT_ID = 'test-account-123';
  const CF_API_TOKEN = 'test-token-abc';
  const AI_GATEWAY_ID = 'sam';

  function makeGatewayResponse(entries: unknown[] = [], totalPages = 1) {
    return new Response(
      JSON.stringify({
        result: entries,
        result_info: {
          page: 1,
          per_page: 50,
          count: entries.length,
          total_count: entries.length,
          total_pages: totalPages,
        },
        success: true,
        errors: [],
      }),
      { status: 200 },
    );
  }

  function makeLogEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'log-1',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      provider: 'workers-ai',
      tokens_in: 100,
      tokens_out: 50,
      cost: 0.001,
      success: true,
      cached: false,
      created_at: '2026-04-15T10:00:00Z',
      duration: 500,
      metadata: { userId: 'user-1', projectId: 'proj-1' },
      ...overrides,
    };
  }

  function createApp(envOverrides: Record<string, unknown> = {}) {
    const app = new Hono();

    app.use('*', async (c, next) => {
      (c.env as Record<string, unknown>) = {
        CF_ACCOUNT_ID,
        CF_API_TOKEN,
        AI_GATEWAY_ID,
        DATABASE: {},
        ...envOverrides,
      };
      await next();
    });

    app.route('/api/admin/costs', adminCostRoutes);
    return app;
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('returns cost summary with LLM and compute data', async () => {
    mockFetch.mockResolvedValue(
      makeGatewayResponse([
        makeLogEntry({ cost: 0.05, tokens_in: 1000, tokens_out: 500 }),
        makeLogEntry({
          id: 'log-2',
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          cost: 0.10,
          tokens_in: 2000,
          tokens_out: 1000,
          metadata: { userId: 'user-2', projectId: 'proj-2' },
        }),
      ]),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');

    expect(res.status).toBe(200);
    const body = await res.json();

    // LLM totals
    expect(body.llm.totalRequests).toBe(2);
    expect(body.llm.totalCostUsd).toBeCloseTo(0.15);
    expect(body.llm.totalInputTokens).toBe(3000);
    expect(body.llm.totalOutputTokens).toBe(1500);

    // By model — sorted by cost desc
    expect(body.llm.byModel).toHaveLength(2);
    expect(body.llm.byModel[0].model).toBe('claude-haiku-4-5-20251001');
    expect(body.llm.byModel[0].costUsd).toBeCloseTo(0.10);

    // By user
    expect(body.llm.byUser).toHaveLength(2);
    expect(body.llm.byUser[0].userId).toBe('user-2'); // higher cost

    // Projection
    expect(body.projection.daysElapsed).toBeGreaterThan(0);
    expect(body.projection.projectedMonthlyCostUsd).toBeGreaterThan(0);

    // Compute
    expect(body.compute.totalNodeHours).toBe(10);
    expect(body.compute.totalVcpuHours).toBe(40);
    expect(body.compute.estimatedCostUsd).toBeCloseTo(40 * 0.003);
    expect(body.compute.activeNodes).toBe(1);

    // Period
    expect(body.period).toBe('current-month');
    expect(body.periodLabel).toBeTruthy();
  });

  it('returns empty data when AI Gateway is not configured', async () => {
    const app = createApp({ AI_GATEWAY_ID: undefined });
    const res = await app.request('/api/admin/costs');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.totalRequests).toBe(0);
    expect(body.llm.totalCostUsd).toBe(0);
    expect(body.llm.byModel).toHaveLength(0);
    expect(body.llm.byUser).toHaveLength(0);
    // Compute data should still be present
    expect(body.compute).toBeDefined();
  });

  it('returns 404 when cost monitoring is disabled', async () => {
    const app = createApp({ COST_MONITORING_ENABLED: 'false' });
    const res = await app.request('/api/admin/costs');
    expect(res.status).toBe(404);
  });

  it('accepts period parameter', async () => {
    mockFetch.mockResolvedValue(makeGatewayResponse([]));

    const app = createApp();
    const res = await app.request('/api/admin/costs?period=30d');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe('30d');
    expect(body.periodLabel).toBe('Last 30 days');
  });

  it('defaults to current-month period', async () => {
    mockFetch.mockResolvedValue(makeGatewayResponse([]));

    const app = createApp();
    const res = await app.request('/api/admin/costs');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe('current-month');
  });

  it('tracks trial costs separately', async () => {
    mockFetch.mockResolvedValue(
      makeGatewayResponse([
        makeLogEntry({ cost: 0.05, metadata: { userId: 'user-1', trialId: 'trial-1' } }),
        makeLogEntry({ id: 'log-2', cost: 0.10, metadata: { userId: 'user-2' } }),
      ]),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');
    const body = await res.json();

    expect(body.llm.trialCostUsd).toBeCloseTo(0.05);
    expect(body.llm.totalCostUsd).toBeCloseTo(0.15);
  });

  it('uses configurable compute vCPU hour cost', async () => {
    mockFetch.mockResolvedValue(makeGatewayResponse([]));

    const app = createApp({ COMPUTE_VCPU_HOUR_COST_USD: '0.01' });
    const res = await app.request('/api/admin/costs');
    const body = await res.json();

    // 40 vCPU-hrs * $0.01 = $0.40
    expect(body.compute.estimatedCostUsd).toBeCloseTo(0.40);
    expect(body.compute.vcpuHourCostUsd).toBe(0.01);
  });

  it('aggregates across multiple pages', async () => {
    const page1Entries = Array.from({ length: 50 }, (_, i) =>
      makeLogEntry({ id: `log-p1-${i}`, cost: 0.01 }),
    );
    const page2Entries = [
      makeLogEntry({ id: 'log-p2-0', cost: 0.05 }),
    ];

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: page1Entries,
            result_info: { page: 1, per_page: 50, count: 50, total_count: 51, total_pages: 2 },
            success: true,
            errors: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: page2Entries,
            result_info: { page: 2, per_page: 50, count: 1, total_count: 51, total_pages: 2 },
            success: true,
            errors: [],
          }),
          { status: 200 },
        ),
      );

    const app = createApp();
    const res = await app.request('/api/admin/costs');
    const body = await res.json();

    expect(body.llm.totalRequests).toBe(51);
    expect(body.llm.totalCostUsd).toBeCloseTo(50 * 0.01 + 0.05);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns 500 when AI Gateway API returns an error', async () => {
    mockFetch.mockResolvedValue(
      new Response('Gateway error', { status: 502 }),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');
    expect(res.status).toBe(500);
  });

  it('returns LLM data even when compute query fails', async () => {
    const { getAllUsersNodeUsageSummary } = await import(
      '../../../src/services/node-usage'
    );
    (getAllUsersNodeUsageSummary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('D1 unavailable'),
    );

    mockFetch.mockResolvedValue(
      makeGatewayResponse([makeLogEntry({ cost: 0.05 })]),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.totalRequests).toBe(1);
    expect(body.llm.totalCostUsd).toBeCloseTo(0.05);
    expect(body.compute.totalNodeHours).toBe(0);
    expect(body.compute.totalVcpuHours).toBe(0);
    expect(body.compute.estimatedCostUsd).toBe(0);
  });

  it('handles entries with null metadata gracefully', async () => {
    mockFetch.mockResolvedValue(
      makeGatewayResponse([
        makeLogEntry({ cost: 0.05, metadata: null }),
        makeLogEntry({ id: 'log-2', cost: 0.10, metadata: {} }),
      ]),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.llm.totalRequests).toBe(2);
    expect(body.llm.totalCostUsd).toBeCloseTo(0.15);
    // Neither entry has userId, so byUser should be empty
    expect(body.llm.byUser).toHaveLength(0);
  });

  it('tracks cached and error request counts', async () => {
    mockFetch.mockResolvedValue(
      makeGatewayResponse([
        makeLogEntry({ cost: 0.01, cached: true }),
        makeLogEntry({ id: 'log-2', cost: 0.02, success: false }),
        makeLogEntry({ id: 'log-3', cost: 0.03 }),
      ]),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');
    const body = await res.json();

    expect(body.llm.cachedRequests).toBe(1);
    expect(body.llm.errorRequests).toBe(1);
  });

  it('aggregates by day correctly', async () => {
    mockFetch.mockResolvedValue(
      makeGatewayResponse([
        makeLogEntry({ cost: 0.05, created_at: '2026-04-15T10:00:00Z' }),
        makeLogEntry({ id: 'log-2', cost: 0.10, created_at: '2026-04-15T14:00:00Z' }),
        makeLogEntry({ id: 'log-3', cost: 0.03, created_at: '2026-04-16T09:00:00Z' }),
      ]),
    );

    const app = createApp();
    const res = await app.request('/api/admin/costs');
    const body = await res.json();

    expect(body.llm.byDay).toHaveLength(2);
    const day15 = body.llm.byDay.find((d: { date: string }) => d.date === '2026-04-15');
    const day16 = body.llm.byDay.find((d: { date: string }) => d.date === '2026-04-16');
    expect(day15.costUsd).toBeCloseTo(0.15);
    expect(day15.requests).toBe(2);
    expect(day16.costUsd).toBeCloseTo(0.03);
    expect(day16.requests).toBe(1);
  });
});
