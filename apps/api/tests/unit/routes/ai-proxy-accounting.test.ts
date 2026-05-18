import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();
const mockIncrementTokenUsage = vi.fn();
const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/ai-proxy-shared', () => ({
  verifyAIProxyAuth: (...args: unknown[]) => mockVerifyAIProxyAuth(...args),
  extractCallbackToken: (authorization?: string) => authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null,
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
  isAnthropicModel: (id: string) => id.startsWith('claude-'),
}));
vi.mock('../../../src/middleware/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitKey: (prefix: string, userId: string, window: number) => `${prefix}:${userId}:${window}`,
  getCurrentWindowStart: () => 1000,
}));
vi.mock('../../../src/services/ai-token-budget', () => ({
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
  incrementTokenUsage: (...args: unknown[]) => mockIncrementTokenUsage(...args),
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn(),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { aiProxyRoutes } from '../../../src/routes/ai-proxy';

type TestEnv = {
  DATABASE: Record<string, never>;
  KV: { get: ReturnType<typeof vi.fn> };
  AI_PROXY_ENABLED: string;
  AI_PROXY_ALLOWED_MODELS: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
};

const app = new Hono<{ Bindings: TestEnv }>();
app.route('/ai/v1', aiProxyRoutes);

function makeEnv(): TestEnv {
  return {
    DATABASE: {},
    KV: { get: vi.fn().mockResolvedValue(null) },
    AI_PROXY_ENABLED: 'true',
    AI_PROXY_ALLOWED_MODELS: '@cf/test/model',
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
  };
}

function postChat(body: Record<string, unknown>) {
  return app.request('/ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ws-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, makeEnv());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenAI-compatible AI proxy token accounting', () => {
  it('increments token usage after a successful Workers AI response', async () => {
    mockVerifyAIProxyAuth.mockResolvedValueOnce({
      userId: 'user1',
      workspaceId: 'ws1',
      projectId: 'proj1',
    });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
    mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
    mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 10, outputTokens: 4 });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-1',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const res = await postChat({
      model: '@cf/test/model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
      expect.anything(),
      'user1',
      10,
      4,
      expect.objectContaining({ AI_PROXY_ENABLED: 'true' }),
    );
  });
});
