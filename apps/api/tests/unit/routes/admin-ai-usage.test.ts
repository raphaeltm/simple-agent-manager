import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminAiUsageRoutes } from '../../../src/routes/admin-ai-usage';

// Mock auth middleware: skip auth for unit tests (as admin-costs.test.ts does).
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

describe('GET /admin/ai-usage gateway availability', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const CF_ACCOUNT_ID = 'test-account-123';
  const CF_API_TOKEN = 'test-token-abc';
  const AI_GATEWAY_ID = 'sa379a6';

  function gatewayResponse(entries: unknown[]) {
    return new Response(
      JSON.stringify({
        result: entries,
        result_info: {
          page: 1,
          per_page: 50,
          count: entries.length,
          total_count: entries.length,
          total_pages: 1,
        },
        success: true,
        errors: [],
      }),
      { status: 200 }
    );
  }

  function logEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'log-1',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      tokens_in: 100,
      tokens_out: 50,
      cost: 0.002,
      success: true,
      cached: false,
      created_at: new Date().toISOString(),
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
    app.route('/api/admin/analytics/ai-usage', adminAiUsageRoutes);
    return app;
  }

  const EMPTY_SUMMARY = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    cachedRequests: 0,
    errorRequests: 0,
    byModel: [],
    byDay: [],
  };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('with a gateway id and a Cloudflare account aggregates the gateway logs (Cloudflare behaviour)', async () => {
    mockFetch.mockResolvedValue(
      gatewayResponse([
        logEntry({ cost: 0.01, tokens_in: 1000, tokens_out: 500 }),
        logEntry({ id: 'log-2', cost: 0.02, tokens_in: 2000, tokens_out: 1000, cached: true }),
        logEntry({ id: 'log-3', success: false, model: '@cf/meta/llama-4-scout-17b-16e-instruct' }),
      ])
    );

    const res = await createApp().request('/api/admin/analytics/ai-usage?period=24h');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      period: '24h',
      totalRequests: 3,
      totalInputTokens: 3100,
      totalOutputTokens: 1550,
      cachedRequests: 1,
      errorRequests: 1,
    });
    expect(body.totalCostUsd).toBeCloseTo(0.032);
    expect(body.byModel).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls[0]![0] as string).toContain(
      `/accounts/${CF_ACCOUNT_ID}/ai-gateway/gateways/${AI_GATEWAY_ID}/logs`
    );
  });

  it('with a gateway id but no Cloudflare account answers 200 with an empty summary and never calls the gateway', async () => {
    // Same logs available upstream as in the control above; the absence of an account is the only change.
    mockFetch.mockResolvedValue(gatewayResponse([logEntry()]));

    const res = await createApp({ CF_ACCOUNT_ID: undefined }).request(
      '/api/admin/analytics/ai-usage?period=30d'
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...EMPTY_SUMMARY, period: '30d' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats a blank account id like a missing one', async () => {
    mockFetch.mockResolvedValue(gatewayResponse([logEntry()]));

    const res = await createApp({ CF_ACCOUNT_ID: '  ' }).request('/api/admin/analytics/ai-usage');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...EMPTY_SUMMARY, period: '7d' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('with no gateway id answers the same empty summary without a gateway call', async () => {
    mockFetch.mockResolvedValue(gatewayResponse([logEntry()]));

    const res = await createApp({ AI_GATEWAY_ID: undefined }).request(
      '/api/admin/analytics/ai-usage'
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...EMPTY_SUMMARY, period: '7d' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
