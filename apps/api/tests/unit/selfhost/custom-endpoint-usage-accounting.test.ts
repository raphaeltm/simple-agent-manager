/**
 * /ai/v1 usage accounting when the Workers AI route is served by an admin-configured
 * OpenAI-compatible endpoint, through the real route: a streamed request asks the endpoint for
 * its usage chunk, and a response that still reports no usage is charged an estimate (the
 * operator path's estimator) instead of zero output tokens. The Cloudflare route is the control:
 * same request, same response, no `stream_options` added and no estimate.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();
const mockCheckMonthlyCostCap = vi.fn();
const mockCheckAiUsageGate = vi.fn();
const mockIncrementTokenUsage = vi.fn();
const mockIncrementProviderUsage = vi.fn();
const mockResolveUpstreamAuth = vi.fn();
const mockGetPlatformAgentCredential = vi.fn();
const mockFetch = vi.fn();
const mockUpdateAIProxyAgentCredentialAttribution = vi.fn();

vi.stubGlobal('fetch', mockFetch);

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));
vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/ai-proxy-shared', () => {
  class RouteAccountingAuthError extends Error {
    constructor(
      message: string,
      readonly statusCode = 401
    ) {
      super(message);
      this.name = 'AIProxyAuthError';
    }
  }

  return {
    verifyAIProxyAuth: (...args: unknown[]) => mockVerifyAIProxyAuth(...args),
    updateAIProxyAgentCredentialAttribution: (...args: unknown[]) =>
      mockUpdateAIProxyAgentCredentialAttribution(...args),
    extractCallbackToken: (authorization?: string, apiKey?: string) =>
      authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : (apiKey ?? null),
    AIProxyAuthError: RouteAccountingAuthError,
    buildAIGatewayMetadata: () => '{"test":"metadata"}',
    buildAnthropicGatewayUrl: () => 'https://gateway.example.com/anthropic/v1/messages',
    buildAnthropicCountTokensUrl: () =>
      'https://gateway.example.com/anthropic/v1/messages/count_tokens',
    isAnthropicModel: (id: string) => id.startsWith('claude-'),
    upstreamErrorLogFields: async () => ({}),
  };
});
vi.mock('../../../src/middleware/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitKey: (prefix: string, userId: string, window: number) =>
    `${prefix}:${userId}:${window}`,
  getCurrentWindowStart: () => 1000,
}));
vi.mock('../../../src/services/ai-token-budget', () => ({
  // No admin allowance: the model-tier gate allows every tier (covered in ai-proxy-model-tiers.test.ts).
  getAdminAiAllowance: async () => null,
  checkAiUsageGate: (...args: unknown[]) => mockCheckAiUsageGate(...args),
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
  checkMonthlyCostCap: (...args: unknown[]) => mockCheckMonthlyCostCap(...args),
  incrementTokenUsage: (...args: unknown[]) => mockIncrementTokenUsage(...args),
  incrementProviderUsage: (...args: unknown[]) => mockIncrementProviderUsage(...args),
}));
vi.mock('../../../src/services/ai-billing', () => ({
  resolveUnifiedBillingToken: () => undefined,
  resolveUpstreamAuth: (...args: unknown[]) => mockResolveUpstreamAuth(...args),
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: (...args: unknown[]) => mockGetPlatformAgentCredential(...args),
}));
/** The admin settings the LLM endpoint resolver reads (`llm.openAICompatible.*`). */
const endpointSettings = new Map<string, string | null>();
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSettingDetailsMany: async (_env: unknown, names: string[]) =>
    names.map((name) => ({ name, value: endpointSettings.get(name) ?? null })),
}));
const mockLogWarn = vi.fn();
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: (...args: unknown[]) => mockLogWarn(...args) },
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { aiProxyRoutes } from '../../../src/routes/ai-proxy';
import { estimateTokensFromText } from '../../../src/services/ai-token-usage-accounting';

type TestEnv = {
  DATABASE: Record<string, never>;
  KV: { get: ReturnType<typeof vi.fn> };
  AI_PROXY_ENABLED: string;
  AI_PROXY_ALLOWED_MODELS?: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AI_GATEWAY_ID: string;
};

const app = new Hono<{ Bindings: TestEnv }>();
app.route('/ai/v1', aiProxyRoutes);

const ENDPOINT = 'https://llm.example.com/v1';
const OUTPUT = 'hello from the operator endpoint';

function postChat(body: Record<string, unknown>) {
  return app.request(
    '/ai/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ws-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: '@cf/test/model',
        messages: [{ role: 'user', content: 'hi' }],
        ...body,
      }),
    },
    {
      DATABASE: {},
      KV: { get: vi.fn().mockResolvedValue(null) },
      AI_PROXY_ENABLED: 'true',
      AI_PROXY_ALLOWED_MODELS: '@cf/test/model',
      CF_ACCOUNT_ID: 'acct',
      CF_API_TOKEN: 'cf-token',
      AI_GATEWAY_ID: 'sam',
    }
  );
}

function sse(events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** A streamed completion whose deltas carry OUTPUT and that reports no usage. */
function streamWithoutUsage(): Response {
  return sse([
    JSON.stringify({ choices: [{ index: 0, delta: { content: OUTPUT.slice(0, 10) } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { content: OUTPUT.slice(10) } }] }),
    '[DONE]',
  ]);
}

function sentBody(): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentUrl(): string {
  return String((mockFetch.mock.calls[0] as [string])[0]);
}

/** Resolves with the (input, output) the route charged once accounting has run. */
function nextIncrement(): Promise<[number, number]> {
  return new Promise((resolve) => {
    mockIncrementTokenUsage.mockImplementationOnce((_kv, _user, input: number, output: number) => {
      resolve([input, output]);
      return Promise.resolve({ inputTokens: input, outputTokens: output });
    });
  });
}

function allowProxyRequest() {
  mockVerifyAIProxyAuth.mockResolvedValueOnce({
    userId: 'user1',
    workspaceId: 'ws1',
    projectId: 'proj1',
  });
  mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
}

beforeEach(() => {
  vi.clearAllMocks();
  endpointSettings.clear();
  mockCheckAiUsageGate.mockResolvedValue({ allowed: true });
  allowProxyRequest();
});

function configureEndpoint() {
  endpointSettings.set('llm.openAICompatible.baseUrl', ENDPOINT);
  endpointSettings.set('llm.openAICompatible.apiKey', 'sk-endpoint');
  endpointSettings.set('llm.openAICompatible.model', 'endpoint-model');
}

describe('/ai/v1 through an OpenAI-compatible endpoint', () => {
  it('asks the endpoint for its usage chunk on a streamed request, keeping client stream options', async () => {
    configureEndpoint();
    const charged = nextIncrement();
    mockFetch.mockResolvedValueOnce(streamWithoutUsage());

    const res = await postChat({ stream: true, stream_options: { custom: 'kept' } });
    await res.text();
    await charged;

    expect(sentUrl()).toBe(`${ENDPOINT}/chat/completions`);
    expect(sentBody()).toMatchObject({
      model: 'endpoint-model',
      stream: true,
      stream_options: { custom: 'kept', include_usage: true },
    });
  });

  it('charges the reported counts when the endpoint sends its usage chunk', async () => {
    configureEndpoint();
    const charged = nextIncrement();
    mockFetch.mockResolvedValueOnce(
      sse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: OUTPUT } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } }),
        '[DONE]',
      ])
    );

    const res = await postChat({ stream: true });
    await res.text();

    expect(await charged).toEqual([21, 9]);
    expect(mockLogWarn).not.toHaveBeenCalledWith('ai_proxy.usage_estimated', expect.anything());
  });

  it('estimates output (operator estimator) when a streamed response still reports no usage', async () => {
    configureEndpoint();
    const charged = nextIncrement();
    mockFetch.mockResolvedValueOnce(streamWithoutUsage());

    const res = await postChat({ stream: true });
    // The client still receives the endpoint's stream untouched.
    expect(await res.text()).toContain(OUTPUT.slice(10));

    const [input, output] = await charged;
    expect(output).toBe(estimateTokensFromText(OUTPUT));
    expect(output).toBeGreaterThan(0);
    expect(input).toBeGreaterThan(0);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'ai_proxy.usage_estimated',
      expect.objectContaining({ outputReported: false, output })
    );
  });

  it('estimates output and input for a non-streamed response without usage', async () => {
    configureEndpoint();
    const charged = nextIncrement();
    mockFetch.mockResolvedValueOnce(
      Response.json({
        id: 'chatcmpl-1',
        choices: [{ index: 0, message: { role: 'assistant', content: OUTPUT } }],
      })
    );

    const res = await postChat({});
    await res.text();

    const [input, output] = await charged;
    expect(output).toBe(estimateTokensFromText(OUTPUT));
    expect(input).toBeGreaterThan(0);
    expect(sentBody()).not.toHaveProperty('stream_options');
  });
  it('estimates a tool-call-only and reasoning turn from what the endpoint generated', async () => {
    configureEndpoint();
    const charged = nextIncrement();
    const toolCalls = [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
      },
    ];
    mockFetch.mockResolvedValueOnce(
      sse([
        JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking hard' } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] }),
        '[DONE]',
      ])
    );

    const res = await postChat({ stream: true });
    await res.text();

    const [, output] = await charged;
    // 13 bytes of reasoning plus the serialized tool calls, at bytes/3 rounded up.
    const bytes = 'thinking hard'.length + JSON.stringify(toolCalls).length;
    expect(output).toBe(Math.ceil(bytes / 3));
    expect(output).toBeGreaterThan(20);
  });

  it('pins the estimator: 32 bytes of output is 11 tokens', async () => {
    configureEndpoint();
    const charged = nextIncrement();
    expect(OUTPUT).toHaveLength(32);
    mockFetch.mockResolvedValueOnce(streamWithoutUsage());

    const res = await postChat({ stream: true });
    await res.text();

    expect((await charged)[1]).toBe(11);
  });
});

describe('/ai/v1 through the Cloudflare AI Gateway (unchanged)', () => {
  it('sends the request without stream_options and charges no estimate for a missing usage chunk', async () => {
    const charged = nextIncrement();
    mockFetch.mockResolvedValueOnce(
      sse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: OUTPUT } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3 } }),
        '[DONE]',
      ])
    );

    const res = await postChat({ stream: true });
    await res.text();

    expect(sentUrl()).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/sam/workers-ai/v1/chat/completions'
    );
    expect(sentBody()).not.toHaveProperty('stream_options');
    expect(await charged).toEqual([3, 0]);
    expect(mockLogWarn).not.toHaveBeenCalledWith('ai_proxy.usage_estimated', expect.anything());
  });

  it('charges nothing for a non-streamed response without usage, and drops the request estimate', async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({
        id: 'chatcmpl-1',
        choices: [{ index: 0, message: { role: 'assistant', content: OUTPUT } }],
      })
    );

    const res = await postChat({});
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sentUrl()).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/sam/workers-ai/v1/chat/completions'
    );
    // Liveness: the response reached the client.
    expect(res.status).toBe(200);
    expect(mockIncrementTokenUsage).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalledWith('ai_proxy.usage_estimated', expect.anything());
  });
});
