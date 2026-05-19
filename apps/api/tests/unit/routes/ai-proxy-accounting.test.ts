import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();
const mockCheckMonthlyCostCap = vi.fn();
const mockCheckAiUsageGate = vi.fn();
const mockIncrementTokenUsage = vi.fn();
const mockResolveUpstreamAuth = vi.fn();
const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/ai-proxy-shared', () => {
  class RouteAccountingAuthError extends Error {
    constructor(message: string, readonly statusCode = 401) {
      super(message);
      this.name = 'AIProxyAuthError';
    }
  }

  return {
    verifyAIProxyAuth: (...args: unknown[]) => mockVerifyAIProxyAuth(...args),
    extractCallbackToken: (authorization?: string, apiKey?: string) => (
      authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : apiKey ?? null
    ),
    AIProxyAuthError: RouteAccountingAuthError,
    buildAIGatewayMetadata: () => '{"test":"metadata"}',
    buildAnthropicGatewayUrl: () => 'https://gateway.example.com/anthropic/v1/messages',
    buildAnthropicCountTokensUrl: () => 'https://gateway.example.com/anthropic/v1/messages/count_tokens',
    isAnthropicModel: (id: string) => id.startsWith('claude-'),
  };
});
vi.mock('../../../src/middleware/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitKey: (prefix: string, userId: string, window: number) => `${prefix}:${userId}:${window}`,
  getCurrentWindowStart: () => 1000,
}));
vi.mock('../../../src/services/ai-token-budget', () => ({
  checkAiUsageGate: (...args: unknown[]) => mockCheckAiUsageGate(...args),
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
  checkMonthlyCostCap: (...args: unknown[]) => mockCheckMonthlyCostCap(...args),
  incrementTokenUsage: (...args: unknown[]) => mockIncrementTokenUsage(...args),
}));
vi.mock('../../../src/services/ai-billing', () => ({
  resolveUnifiedBillingToken: () => undefined,
  resolveUpstreamAuth: (...args: unknown[]) => mockResolveUpstreamAuth(...args),
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn(),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { aiProxyRoutes } from '../../../src/routes/ai-proxy';
import { aiProxyAnthropicRoutes } from '../../../src/routes/ai-proxy-anthropic';

type TestEnv = {
  DATABASE: Record<string, never>;
  KV: { get: ReturnType<typeof vi.fn> };
  AI_PROXY_ENABLED: string;
  AI_PROXY_ALLOWED_MODELS: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
};

const app = new Hono<{ Bindings: TestEnv }>();
app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
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

function postAnthropic(path: string, body: Record<string, unknown>) {
  return app.request(`/ai/anthropic/v1${path}`, {
    method: 'POST',
    headers: { 'x-api-key': 'ws-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, makeEnv());
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function allowProxyRequest() {
  mockVerifyAIProxyAuth.mockResolvedValueOnce({
    userId: 'user1',
    workspaceId: 'ws1',
    projectId: 'proj1',
  });
  mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
  mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
}

function allowAnthropicPlatformAuth() {
  mockResolveUpstreamAuth.mockResolvedValueOnce({
    headers: { 'x-api-key': 'platform-key' },
    billingMode: 'platform-key',
  });
}

function expectUsageIncrement(inputTokens: number, outputTokens: number) {
  expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
    expect.anything(),
    'user1',
    inputTokens,
    outputTokens,
    expect.objectContaining({ AI_PROXY_ENABLED: 'true' }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckAiUsageGate.mockResolvedValue({ allowed: true });
  mockCheckMonthlyCostCap.mockResolvedValue({ allowed: true, costUsd: 0, capUsd: null });
});

describe('OpenAI-compatible AI proxy token accounting', () => {
  it('increments token usage after a successful Workers AI response', async () => {
    allowProxyRequest();
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
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toMatchObject({ 'cf-aig-collect-log': 'false' });
    expectUsageIncrement(10, 4);
  });

  it('increments token usage after a successful streaming response', async () => {
    allowProxyRequest();
    const incremented = new Promise<void>((resolve) => {
      mockIncrementTokenUsage.mockImplementationOnce(() => {
        resolve();
        return Promise.resolve({ inputTokens: 11, outputTokens: 5 });
      });
    });
    mockFetch.mockResolvedValueOnce(new Response(streamFromText([
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const res = await postChat({
      model: '@cf/test/model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    await res.text();
    await incremented;
    expectUsageIncrement(11, 5);
  });

  it('does not increment token usage for failed upstream responses', async () => {
    allowProxyRequest();
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'upstream failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));

    const res = await postChat({
      model: '@cf/test/model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(500);
    await res.text();
    expect(mockIncrementTokenUsage).not.toHaveBeenCalled();
  });
});

describe('native Anthropic AI proxy token accounting', () => {
  it('increments token usage after a successful message response', async () => {
    allowProxyRequest();
    allowAnthropicPlatformAuth();
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

    const res = await postAnthropic('/messages', {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    await res.text();
    expectUsageIncrement(18, 5);
  });

  it('does not increment token usage for count_tokens responses', async () => {
    allowProxyRequest();
    allowAnthropicPlatformAuth();
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ input_tokens: 12 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const res = await postAnthropic('/messages/count_tokens', {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    await res.text();
  expect(mockCheckAiUsageGate).toHaveBeenCalledOnce();
    expect(mockIncrementTokenUsage).not.toHaveBeenCalled();
  });
});
