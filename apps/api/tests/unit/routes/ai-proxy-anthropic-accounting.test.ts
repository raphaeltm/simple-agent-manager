import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();
const mockIncrementTokenUsage = vi.fn();
const mockResolveUpstreamAuth = vi.fn();
const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/ai-proxy-shared', () => ({
  verifyAIProxyAuth: (...args: unknown[]) => mockVerifyAIProxyAuth(...args),
  extractCallbackToken: (_authorization?: string, apiKey?: string) => apiKey ?? null,
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
vi.mock('../../../src/middleware/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitKey: (prefix: string, userId: string, window: number) => `${prefix}:${userId}:${window}`,
  getCurrentWindowStart: () => 1000,
}));
vi.mock('../../../src/services/ai-billing', () => ({
  resolveUpstreamAuth: (...args: unknown[]) => mockResolveUpstreamAuth(...args),
}));
vi.mock('../../../src/services/ai-token-budget', () => ({
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
  incrementTokenUsage: (...args: unknown[]) => mockIncrementTokenUsage(...args),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { aiProxyAnthropicRoutes } from '../../../src/routes/ai-proxy-anthropic';

type TestEnv = {
  DATABASE: Record<string, never>;
  KV: Record<string, never>;
  AI_PROXY_ENABLED: string;
};

const app = new Hono<{ Bindings: TestEnv }>();
app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);

function postMessage(body: Record<string, unknown>) {
  return app.request('/ai/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'ws-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { DATABASE: {}, KV: {}, AI_PROXY_ENABLED: 'true' });
}

function postCountTokens(body: Record<string, unknown>) {
  return app.request('/ai/anthropic/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'x-api-key': 'ws-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { DATABASE: {}, KV: {}, AI_PROXY_ENABLED: 'true' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('native Anthropic AI proxy token accounting', () => {
  it('increments token usage after a successful message response', async () => {
    mockVerifyAIProxyAuth.mockResolvedValueOnce({
      userId: 'user1',
      workspaceId: 'ws1',
      projectId: 'proj1',
    });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
    mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
    mockResolveUpstreamAuth.mockResolvedValueOnce({
      headers: { 'x-api-key': 'platform-key' },
      billingMode: 'platform-key',
    });
    mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 18, outputTokens: 5 });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 18, output_tokens: 5 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const res = await postMessage({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
      expect.anything(),
      'user1',
      18,
      5,
      expect.objectContaining({ AI_PROXY_ENABLED: 'true' }),
    );
  });

  it('does not increment token usage for count_tokens responses', async () => {
    mockVerifyAIProxyAuth.mockResolvedValueOnce({
      userId: 'user1',
      workspaceId: 'ws1',
      projectId: 'proj1',
    });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
    mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
    mockResolveUpstreamAuth.mockResolvedValueOnce({
      headers: { 'x-api-key': 'platform-key' },
      billingMode: 'platform-key',
    });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ input_tokens: 12 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const res = await postCountTokens({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(mockCheckTokenBudget).toHaveBeenCalledOnce();
    expect(mockIncrementTokenUsage).not.toHaveBeenCalled();
  });
});
