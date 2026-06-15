/**
 * AI Proxy Passthrough — Unit Tests
 *
 * Tests the URL-path-based proxy auth routes that enable universal usage tracking.
 */
import { Hono } from 'hono';
import { beforeEach,describe, expect, it, vi } from 'vitest';

// --- Mock dependencies ---

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();
const mockCheckMonthlyCostCap = vi.fn();
const mockCheckAiUsageGate = vi.fn();
const mockIncrementTokenUsage = vi.fn();
const mockResolveForConsumer = vi.fn();

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
  checkAiUsageGate: (...args: unknown[]) => mockCheckAiUsageGate(...args),
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
  checkMonthlyCostCap: (...args: unknown[]) => mockCheckMonthlyCostCap(...args),
  incrementTokenUsage: (...args: unknown[]) => mockIncrementTokenUsage(...args),
}));

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: (...args: unknown[]) => mockResolveForConsumer(...args),
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
  mockResolveForConsumer.mockReset();
  // Default: usage gates always allow (tests override when needed)
  mockCheckAiUsageGate.mockResolvedValue({ allowed: true });
  mockCheckMonthlyCostCap.mockResolvedValue({ allowed: true, costUsd: 0, capUsd: null });
  mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) => {
    const agentType = (consumer as { agentType?: string }).agentType;
    if (agentType === 'claude-code') {
      return Promise.resolve({
        consumer,
        configuration: { settings: { baseUrl: 'https://anthropic-alt.example/anthropic' } },
        credential: { secret: { kind: 'api-key', apiKey: 'sk-ant-resolved-key' } },
        source: 'user-attachment',
      });
    }
    return Promise.resolve({
      consumer,
      configuration: { settings: {} },
      credential: {
        secret: {
          kind: 'openai-compatible',
          apiKey: 'sk-resolved-openai',
          baseUrl: 'https://custom-openai.example/v1',
        },
      },
      source: 'user-attachment',
    });
  });
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

    it('returns 401 when no server-side credential resolves', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockResolveForConsumer.mockResolvedValueOnce(null);

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(401);
    });

    it('forwards resolved Anthropic credential to its configured upstream and injects cf-aig-metadata', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockResolveForConsumer.mockResolvedValueOnce({
        consumer: { kind: 'agent', agentType: 'claude-code' },
        configuration: { settings: { baseUrl: 'https://anthropic-alt.example/anthropic' } },
        credential: { secret: { kind: 'api-key', apiKey: 'sk-ant-resolved-key' } },
        source: 'project-attachment',
      });
      mockFetch.mockResolvedValueOnce(new Response('{"id":"msg_1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://anthropic-alt.example/anthropic/v1/messages');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-resolved-key');
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['cf-aig-metadata']).toBeDefined();
    });

    it('increments token usage after a successful Anthropic response', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 13, outputTokens: 8 });
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 13, output_tokens: 8 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'msg_1' });
      expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
        expect.anything(),
        'user1',
        13,
        8,
        expect.objectContaining({ AI_PROXY_ENABLED: 'true' }),
      );
    });

    it('does not increment token usage for Anthropic count_tokens responses', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ input_tokens: 13 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages/count_tokens',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
      );

      expect(res.status).toBe(200);
      await res.text();
      expect(mockCheckAiUsageGate).toHaveBeenCalledOnce();
      expect(mockIncrementTokenUsage).not.toHaveBeenCalled();
    });

    it('applies rate limiting', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 9999 });

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514' },
      );
      expect(res.status).toBe(429);
    });

    it('applies token budget check', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckAiUsageGate.mockResolvedValueOnce({
        allowed: false,
        reason: 'daily-token-budget',
        budget: { allowed: false },
      });

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(429);
    });

    it('returns 503 when AI proxy is disabled', async () => {
      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-4-20250514' },
        {},
        { AI_PROXY_ENABLED: 'false' },
      );
      expect(res.status).toBe(503);
    });

    it('allows non-Claude model names for Anthropic-dialect compatible providers', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockFetch.mockResolvedValueOnce(new Response('{"id":"msg_1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('OpenAI passthrough', () => {
    it('forwards resolved OpenAI-compatible credential to its configured upstream', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'openai-codex',
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
      );
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://custom-openai.example/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-resolved-openai');
      expect(headers['cf-aig-metadata']).toBeDefined();
    });

    it('increments token usage and rejects the next over-budget request', async () => {
      mockVerifyAIProxyAuth
        .mockResolvedValueOnce({ userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'openai-codex' })
        .mockResolvedValueOnce({ userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'openai-codex' });
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 })
        .mockResolvedValueOnce({ allowed: true, remaining: 28, resetAt: 9999 });
      mockCheckTokenBudget
        .mockResolvedValue({ allowed: true });
      mockCheckAiUsageGate
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({
          allowed: false,
          reason: 'daily-token-budget',
          budget: { allowed: false },
        });
      mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 21, outputTokens: 6 });
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-1',
        choices: [],
        usage: { prompt_tokens: 21, completion_tokens: 6 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const first = await postJson(
        '/ai/proxy/valid-token/openai/v1/chat/completions',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(first.status).toBe(200);
      await first.text();

      const second = await postJson(
        '/ai/proxy/valid-token/openai/v1/chat/completions',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi again' }] },
      );

      expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
        expect.anything(),
        'user1',
        21,
        6,
        expect.objectContaining({ AI_PROXY_ENABLED: 'true' }),
      );
      expect(second.status).toBe(429);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns 401 without a resolved server-side credential', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1', workspaceId: 'ws1', projectId: 'proj1', agentType: 'openai-codex',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockResolveForConsumer.mockResolvedValueOnce(null);

      const res = await postJson(
        '/ai/proxy/valid-token/openai/v1/chat/completions',
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      );
      expect(res.status).toBe(401);
    });
  });
});
