/**
 * Unit tests for GET /api/usage/ai route.
 *
 * Tests user isolation, missing gateway config, gateway errors,
 * and response shape — pure logic with mocked dependencies.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AIGatewayLogEntry } from '../../src/services/ai-gateway-logs';

// Mock the gateway log service
const mockIterateGatewayLogs = vi.fn();
vi.mock('../../src/services/ai-gateway-logs', async () => {
  const actual = await vi.importActual('../../src/services/ai-gateway-logs');
  return {
    ...actual,
    iterateGatewayLogs: (...args: unknown[]) => mockIterateGatewayLogs(...args),
  };
});

// Mock auth middleware to inject a test userId
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'user-test-1',
}));

import { Hono } from 'hono';

import type { Env } from '../../src/env';

// Lazy import after mocks are set up
const { usageRoutes } = await import('../../src/routes/usage');
const testApp = new Hono<{ Bindings: Env }>();
testApp.route('/api/usage', usageRoutes);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI_GATEWAY_ID: 'test-gateway',
    ...overrides,
  } as Env;
}

function makeEntry(overrides: Partial<AIGatewayLogEntry> = {}): AIGatewayLogEntry {
  return {
    id: 'entry-1',
    model: 'gpt-4o',
    provider: 'openai',
    tokens_in: 100,
    tokens_out: 50,
    cost: 0.01,
    success: true,
    cached: false,
    created_at: '2026-04-15T10:00:00Z',
    duration: 500,
    metadata: { userId: 'user-test-1' },
    ...overrides,
  };
}

describe('GET /api/usage/ai', () => {
  // ---------------------------------------------------------------------------
  // User Isolation
  // ---------------------------------------------------------------------------

  describe('user isolation', () => {
    it('includes entries matching the authenticated userId', async () => {
      mockIterateGatewayLogs.mockImplementation(
        async (_env: unknown, _gw: string, _start: string, cb: (e: AIGatewayLogEntry) => void) => {
          cb(makeEntry({ metadata: { userId: 'user-test-1' }, cost: 0.05, tokens_in: 200 }));
        },
      );

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(data.totalRequests).toBe(1);
      expect(data.totalCostUsd).toBe(0.05);
      expect(data.totalInputTokens).toBe(200);
    });

    it('excludes entries from other users', async () => {
      mockIterateGatewayLogs.mockImplementation(
        async (_env: unknown, _gw: string, _start: string, cb: (e: AIGatewayLogEntry) => void) => {
          cb(makeEntry({ metadata: { userId: 'user-other' }, cost: 0.10 }));
          cb(makeEntry({ metadata: { userId: 'user-test-1' }, cost: 0.05 }));
          cb(makeEntry({ metadata: { userId: 'user-another' }, cost: 0.20 }));
        },
      );

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(data.totalRequests).toBe(1);
      expect(data.totalCostUsd).toBe(0.05);
    });

    it('excludes entries with no metadata userId', async () => {
      mockIterateGatewayLogs.mockImplementation(
        async (_env: unknown, _gw: string, _start: string, cb: (e: AIGatewayLogEntry) => void) => {
          cb(makeEntry({ metadata: undefined }));
          cb(makeEntry({ metadata: {} }));
          cb(makeEntry({ metadata: { userId: 'user-test-1' }, cost: 0.03 }));
        },
      );

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(data.totalRequests).toBe(1);
      expect(data.totalCostUsd).toBe(0.03);
    });
  });

  // ---------------------------------------------------------------------------
  // Missing Gateway Config
  // ---------------------------------------------------------------------------

  describe('missing AI_GATEWAY_ID', () => {
    it('returns empty response when gateway is not configured', async () => {
      const resp = await testApp.request('/api/usage/ai', {}, makeEnv({ AI_GATEWAY_ID: '' }));
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.totalRequests).toBe(0);
      expect(data.totalCostUsd).toBe(0);
      expect(data.byModel).toEqual([]);
      expect(data.byDay).toEqual([]);
      expect(data.period).toBe('current-month');
      expect(data.periodLabel).toBeTruthy();
    });

    it('does not call iterateGatewayLogs when gateway is missing', async () => {
      mockIterateGatewayLogs.mockClear();
      await testApp.request('/api/usage/ai', {}, makeEnv({ AI_GATEWAY_ID: undefined as unknown as string }));
      expect(mockIterateGatewayLogs).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Gateway Error Handling
  // ---------------------------------------------------------------------------

  describe('gateway error handling', () => {
    it('returns empty response on gateway API error', async () => {
      mockIterateGatewayLogs.mockRejectedValue(new Error('Gateway API 500'));

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(resp.status).toBe(200);
      expect(data.totalRequests).toBe(0);
      expect(data.byModel).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Period Parameter
  // ---------------------------------------------------------------------------

  describe('period parameter', () => {
    it('accepts valid period values', async () => {
      mockIterateGatewayLogs.mockImplementation(async () => {});

      for (const period of ['current-month', '7d', '30d', '90d']) {
        const resp = await testApp.request(`/api/usage/ai?period=${period}`, {}, makeEnv());
        const data = await resp.json();
        expect(data.period).toBe(period);
      }
    });

    it('defaults to current-month for invalid period', async () => {
      mockIterateGatewayLogs.mockImplementation(async () => {});

      const resp = await testApp.request('/api/usage/ai?period=invalid', {}, makeEnv());
      const data = await resp.json();
      expect(data.period).toBe('current-month');
    });
  });

  // ---------------------------------------------------------------------------
  // Response Shape
  // ---------------------------------------------------------------------------

  describe('response shape', () => {
    it('returns all required fields', async () => {
      mockIterateGatewayLogs.mockImplementation(
        async (_env: unknown, _gw: string, _start: string, cb: (e: AIGatewayLogEntry) => void) => {
          cb(makeEntry({ cached: true }));
          cb(makeEntry({ success: false }));
        },
      );

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(data).toHaveProperty('totalCostUsd');
      expect(data).toHaveProperty('totalRequests');
      expect(data).toHaveProperty('totalInputTokens');
      expect(data).toHaveProperty('totalOutputTokens');
      expect(data).toHaveProperty('cachedRequests');
      expect(data).toHaveProperty('errorRequests');
      expect(data).toHaveProperty('byModel');
      expect(data).toHaveProperty('byDay');
      expect(data).toHaveProperty('period');
      expect(data).toHaveProperty('periodLabel');
      expect(data.totalRequests).toBe(2);
      expect(data.cachedRequests).toBe(1);
      expect(data.errorRequests).toBe(1);
    });

    it('sorts byModel descending by cost', async () => {
      mockIterateGatewayLogs.mockImplementation(
        async (_env: unknown, _gw: string, _start: string, cb: (e: AIGatewayLogEntry) => void) => {
          cb(makeEntry({ model: 'cheap-model', cost: 0.01, metadata: { userId: 'user-test-1' } }));
          cb(makeEntry({ model: 'expensive-model', cost: 0.50, metadata: { userId: 'user-test-1' } }));
        },
      );

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(data.byModel[0].model).toBe('expensive-model');
      expect(data.byModel[1].model).toBe('cheap-model');
    });

    it('sorts byDay ascending by date', async () => {
      mockIterateGatewayLogs.mockImplementation(
        async (_env: unknown, _gw: string, _start: string, cb: (e: AIGatewayLogEntry) => void) => {
          cb(makeEntry({ created_at: '2026-04-20T10:00:00Z', metadata: { userId: 'user-test-1' } }));
          cb(makeEntry({ created_at: '2026-04-15T10:00:00Z', metadata: { userId: 'user-test-1' } }));
        },
      );

      const resp = await testApp.request('/api/usage/ai', {}, makeEnv());
      const data = await resp.json();

      expect(data.byDay[0].date).toBe('2026-04-15');
      expect(data.byDay[1].date).toBe('2026-04-20');
    });
  });
});
