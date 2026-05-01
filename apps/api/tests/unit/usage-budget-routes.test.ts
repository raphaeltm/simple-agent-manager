/**
 * Route-level tests for GET/PUT/DELETE /api/usage/ai/budget.
 *
 * Tests the route handlers' behavior: response shapes, error handling,
 * utilization calculation, and validation error forwarding.
 */
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock KV
// ---------------------------------------------------------------------------
const kvStore = new Map<string, string>();
const mockKV = {
  get: vi.fn(async (key: string, format?: string) => {
    const val = kvStore.get(key) ?? null;
    if (val && format === 'json') return JSON.parse(val);
    return val;
  }),
  put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
  delete: vi.fn(async (key: string) => { kvStore.delete(key); }),
};

// ---------------------------------------------------------------------------
// Mock AI Gateway logs (for budget route's monthCostUsd calculation)
// ---------------------------------------------------------------------------
const mockIterateGatewayLogs = vi.fn();
vi.mock('../../src/services/ai-gateway-logs', async () => {
  const actual = await vi.importActual('../../src/services/ai-gateway-logs');
  return {
    ...actual,
    iterateGatewayLogs: (...args: unknown[]) => mockIterateGatewayLogs(...args),
  };
});

// Mock auth
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'user-budget-1',
}));

// Mock logger
vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { Hono } from 'hono';

import type { Env } from '../../src/env';

const { usageRoutes } = await import('../../src/routes/usage');
const testApp = new Hono<{ Bindings: Env }>();
testApp.route('/api/usage', usageRoutes);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    KV: mockKV as unknown as KVNamespace,
    AI_GATEWAY_ID: 'test-gw',
    AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '',
    AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: '',
    ...overrides,
  } as Env;
}

describe('GET /api/usage/ai/budget', () => {
  beforeEach(() => {
    kvStore.clear();
    mockIterateGatewayLogs.mockReset();
    vi.clearAllMocks();
  });

  it('returns platform defaults when user has no custom settings', async () => {
    mockIterateGatewayLogs.mockResolvedValue(undefined);

    const resp = await testApp.request('/api/usage/ai/budget', {}, makeEnv());
    expect(resp.status).toBe(200);

    const data = await resp.json();
    expect(data.isCustom).toBe(false);
    expect(data.settings.dailyInputTokenLimit).toBeNull();
    expect(data.settings.dailyOutputTokenLimit).toBeNull();
    expect(data.settings.monthlyCostCapUsd).toBeNull();
    expect(data.exceeded).toBe(false);
    expect(data.effectiveLimits).toBeDefined();
    expect(data.utilization).toBeDefined();
  });

  it('returns custom settings when user has saved budget', async () => {
    mockIterateGatewayLogs.mockResolvedValue(undefined);

    const settings = {
      dailyInputTokenLimit: 100_000,
      dailyOutputTokenLimit: 50_000,
      monthlyCostCapUsd: 10,
      alertThresholdPercent: 70,
    };
    kvStore.set('ai-budget-settings:user-budget-1', JSON.stringify(settings));

    const resp = await testApp.request('/api/usage/ai/budget', {}, makeEnv());
    const data = await resp.json();

    expect(data.isCustom).toBe(true);
    expect(data.settings.dailyInputTokenLimit).toBe(100_000);
    expect(data.settings.monthlyCostCapUsd).toBe(10);
  });

  it('calculates utilization percentages correctly', async () => {
    mockIterateGatewayLogs.mockResolvedValue(undefined);

    // Set daily usage via KV
    const today = new Date().toISOString().split('T')[0];
    kvStore.set(`ai-budget:user-budget-1:${today}`, JSON.stringify({ inputTokens: 250_000, outputTokens: 100_000 }));

    const resp = await testApp.request('/api/usage/ai/budget', {}, makeEnv());
    const data = await resp.json();

    // Default limits: 500k input, 200k output
    expect(data.utilization.dailyInputPercent).toBe(50);
    expect(data.utilization.dailyOutputPercent).toBe(50);
  });

  it('marks exceeded when daily usage >= limit', async () => {
    mockIterateGatewayLogs.mockResolvedValue(undefined);

    const today = new Date().toISOString().split('T')[0];
    kvStore.set(`ai-budget:user-budget-1:${today}`, JSON.stringify({ inputTokens: 600_000, outputTokens: 10 }));

    const resp = await testApp.request('/api/usage/ai/budget', {}, makeEnv());
    const data = await resp.json();

    expect(data.exceeded).toBe(true);
    expect(data.utilization.dailyInputPercent).toBe(100);
  });

  it('aggregates monthly cost from gateway logs', async () => {
    // Simulate gateway returning cost entries for the authenticated user
    mockIterateGatewayLogs.mockImplementation(
      async (_env: unknown, _gw: string, _start: string, cb: (e: unknown) => void) => {
        cb({ metadata: { userId: 'user-budget-1' }, cost: 1.50 });
        cb({ metadata: { userId: 'user-budget-1' }, cost: 0.75 });
        cb({ metadata: { userId: 'other-user' }, cost: 5.00 }); // different user, excluded
      },
    );

    const resp = await testApp.request('/api/usage/ai/budget', {}, makeEnv());
    const data = await resp.json();

    expect(data.monthCostUsd).toBeCloseTo(2.25, 2);
  });

  it('returns zero month cost when gateway is not configured', async () => {
    const resp = await testApp.request('/api/usage/ai/budget', {}, makeEnv({ AI_GATEWAY_ID: '' }));
    const data = await resp.json();

    expect(data.monthCostUsd).toBe(0);
  });
});

describe('PUT /api/usage/ai/budget', () => {
  beforeEach(() => {
    kvStore.clear();
    vi.clearAllMocks();
  });

  it('saves valid budget settings and returns success', async () => {
    const body = {
      dailyInputTokenLimit: 200_000,
      dailyOutputTokenLimit: 100_000,
      monthlyCostCapUsd: 25,
      alertThresholdPercent: 90,
    };

    const resp = await testApp.request('/api/usage/ai/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, makeEnv());

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.success).toBe(true);

    // Verify KV was written
    expect(mockKV.put).toHaveBeenCalledWith(
      'ai-budget-settings:user-budget-1',
      expect.any(String),
    );
  });

  it('returns 400 for invalid JSON', async () => {
    const resp = await testApp.request('/api/usage/ai/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    }, makeEnv());

    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toBe('INVALID_JSON');
  });

  it('returns 400 for invalid budget values', async () => {
    const body = {
      dailyInputTokenLimit: -500, // negative
      alertThresholdPercent: 80,
    };

    const resp = await testApp.request('/api/usage/ai/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, makeEnv());

    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toBe('VALIDATION_ERROR');
  });

  it('accepts null values to clear individual limits', async () => {
    const body = {
      dailyInputTokenLimit: null,
      dailyOutputTokenLimit: null,
      monthlyCostCapUsd: null,
      alertThresholdPercent: 80,
    };

    const resp = await testApp.request('/api/usage/ai/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, makeEnv());

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.success).toBe(true);
  });
});

describe('DELETE /api/usage/ai/budget', () => {
  beforeEach(() => {
    kvStore.clear();
    vi.clearAllMocks();
  });

  it('deletes user budget settings and returns success', async () => {
    kvStore.set('ai-budget-settings:user-budget-1', JSON.stringify({ dailyInputTokenLimit: 100_000 }));

    const resp = await testApp.request('/api/usage/ai/budget', {
      method: 'DELETE',
    }, makeEnv());

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.success).toBe(true);
    expect(mockKV.delete).toHaveBeenCalledWith('ai-budget-settings:user-budget-1');
  });

  it('succeeds even when no settings exist (idempotent)', async () => {
    const resp = await testApp.request('/api/usage/ai/budget', {
      method: 'DELETE',
    }, makeEnv());

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.success).toBe(true);
  });
});
