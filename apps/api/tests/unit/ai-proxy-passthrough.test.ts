/**
 * AI Proxy Passthrough — Unit Tests
 *
 * Tests the URL-path-based proxy auth routes that enable universal usage tracking.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Mock dependencies ---

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

vi.mock('../../src/db/schema', () => ({}));

vi.mock('../../src/services/ai-proxy-shared', () => ({
  verifyAIProxyAuth: (...args: unknown[]) => mockVerifyAIProxyAuth(...args),
  AIProxyAuthError: class extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'AIProxyAuthError';
    }
  },
  buildAIGatewayMetadata: () => '{"test":"metadata"}',
  buildAnthropicGatewayUrl: () => 'https://gateway.example.com/anthropic/v1/messages',
  buildAnthropicCountTokensUrl: () => 'https://gateway.example.com/anthropic/v1/messages/count_tokens',
  isAnthropicModel: (id: string) => id.startsWith('claude-'),
}));

vi.mock('../../src/middleware/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitKey: (prefix: string, userId: string, window: number) => `${prefix}:${userId}:${window}`,
  getCurrentWindowStart: () => 1000,
}));

vi.mock('../../src/services/ai-token-budget', () => ({
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
}));

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { aiProxyPassthroughRoutes } from '../../src/routes/ai-proxy-passthrough';

type TestEnv = {
  DATABASE: Record<string, never>;
  KV: Record<string, never>;
  AI_PROXY_ENABLED: string;
  AI_GATEWAY_ID: string;
  CF_ACCOUNT_ID: string;
};

const app = new Hono<{ Bindings: TestEnv }>();
app.route('/ai/proxy', aiProxyPassthroughRoutes);

function makeEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    DATABASE: {},
    KV: {},
    AI_PROXY_ENABLED: 'true',
    AI_GATEWAY_ID: 'test-gw',
    CF_ACCOUNT_ID: 'test-acct',
    ...overrides,
  };
}

function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  env?: Partial<TestEnv>,
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, makeEnv(env));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI Proxy Passthrough Routes', () => {
  describe('Anthropic passthrough', () => {
    it('returns 401 when wstoken is invalid', async () => {
      mockVerifyAIProxyAuth.mockRejectedValueOnce(new Error('invalid'));

      const res = await postJson(
        '/ai/proxy/bad-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-api-key': 'sk-user' },
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 when no user credential in headers', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(401);
    });

    it('forwards user x-api-key to upstream and injects cf-aig-metadata', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockFetch.mockResolvedValueOnce(new Response('{"id":"msg_1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-api-key': 'sk-ant-user-key-123' },
      );
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://gateway.example.com/anthropic/v1/messages');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-user-key-123');
      expect(headers['cf-aig-metadata']).toBeDefined();
    });

    it('applies rate limiting', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 9999 });

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514' },
        { 'x-api-key': 'sk-test' },
      );
      expect(res.status).toBe(429);
    });

    it('applies token budget check', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: false });

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-api-key': 'sk-test' },
      );
      expect(res.status).toBe(429);
    });

    it('returns 503 when AI proxy is disabled', async () => {
      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514' },
        { 'x-api-key': 'sk-test' },
        { AI_PROXY_ENABLED: 'false' },
      );
      expect(res.status).toBe(503);
    });

    it('rejects non-Anthropic models', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-api-key': 'sk-test' },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('OpenAI passthrough', () => {
    it('forwards user Authorization header to upstream', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockFetch.mockResolvedValueOnce(new Response('{"id":"chatcmpl-1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const res = await postJson(
        '/ai/proxy/valid-token/openai/v1/chat/completions',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { 'Authorization': 'Bearer sk-openai-key-123' },
      );
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('openai');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-openai-key-123');
      expect(headers['cf-aig-metadata']).toBeDefined();
    });

    it('returns 401 without Authorization header', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });

      const res = await postJson(
        '/ai/proxy/valid-token/openai/v1/chat/completions',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(401);
    });
  });
});
