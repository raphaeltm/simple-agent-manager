vi.mock('../../src/services/outbound-fetch-settings', () => ({
  resolveOutboundMaxRedirects: async () => 3,
}));
/** URL-path-based proxy auth routes and usage tracking. */
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route protocol tests mock D1; real pin enforcement is covered by provider-limit-platform-attribution.test.ts.
vi.mock('../../src/services/provider-limit-credential-pin', () => ({
  assertProviderLimitCredentialPin: vi.fn(async () => {}),
}));

// L13 tests turn on direct upstream (no gateway); every other test keeps the real availability.
const proxyEnabledOverride = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
vi.mock('../../src/services/ai-proxy-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ai-proxy-availability')>();
  return {
    ...actual,
    isAiProxyEnabled: async (env: Parameters<typeof actual.isAiProxyEnabled>[0]) =>
      proxyEnabledOverride.value ?? actual.isAiProxyEnabled(env),
  };
});

// --- Mock dependencies ---

const mockVerifyAIProxyAuth = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckTokenBudget = vi.fn();
const mockCheckMonthlyCostCap = vi.fn();
const mockCheckAiUsageGate = vi.fn();
const mockIncrementTokenUsage = vi.fn();
const mockIncrementProviderUsage = vi.fn();
const mockResolveForConsumer = vi.fn();
const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
const mockUpdateAIProxyAgentCredentialAttribution = vi.fn();
const mockRecordProxyCredentialLimitObservationsFromHeaders = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

vi.mock('../../src/db/schema', () => ({}));

vi.mock('../../src/services/ai-proxy-shared', () => ({
  verifyAIProxyAuth: (...args: unknown[]) => mockVerifyAIProxyAuth(...args),
  updateAIProxyAgentCredentialAttribution: (...args: unknown[]) =>
    mockUpdateAIProxyAgentCredentialAttribution(...args),
  AIProxyAuthError: class extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.name = 'AIProxyAuthError';
    }
  },
  buildAIGatewayMetadata: (opts: unknown) => JSON.stringify(opts),
  buildAnthropicGatewayUrl: () => 'https://gateway.example.com/anthropic/v1/messages',
  buildAnthropicCountTokensUrl: () =>
    'https://gateway.example.com/anthropic/v1/messages/count_tokens',
  isAnthropicModel: (id: string) => id.startsWith('claude-'),
}));

vi.mock('../../src/services/credential-limit-events', () => ({
  copyCredentialLimitHeaders: (source: Headers, target: Headers) => {
    source.forEach((value, name) => {
      if (name.includes('ratelimit') || name === 'retry-after') {
        target.set(name, value);
      }
    });
  },
  recordProxyCredentialLimitObservationsFromHeaders: (...args: unknown[]) =>
    mockRecordProxyCredentialLimitObservationsFromHeaders(...args),
}));

vi.mock('../../src/middleware/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitKey: (prefix: string, userId: string, window: number) =>
    `${prefix}:${userId}:${window}`,
  getCurrentWindowStart: () => 1000,
}));

// The package's accounting calls these from inside the package; mock its module, not the
// worker re-export (worker modularization W5).
vi.mock('@simple-agent-manager/ai-proxy/internal/ai-token-budget', () => ({
  checkAiUsageGate: (...args: unknown[]) => mockCheckAiUsageGate(...args),
  checkTokenBudget: (...args: unknown[]) => mockCheckTokenBudget(...args),
  checkMonthlyCostCap: (...args: unknown[]) => mockCheckMonthlyCostCap(...args),
  incrementTokenUsage: (...args: unknown[]) => mockIncrementTokenUsage(...args),
  incrementProviderUsage: (...args: unknown[]) => mockIncrementProviderUsage(...args),
}));

vi.mock('../../src/lib/logger', () => ({
  log: {
    info: vi.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));

vi.mock('../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-encryption-key',
}));

vi.mock('../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: (...args: unknown[]) => mockResolveForConsumer(...args),
  explainForConsumer: async (...args: unknown[]) => ({
    resolved: await mockResolveForConsumer(...args),
    halted: false,
    steps: [],
  }),
}));

// Profile pins are covered by tests/integration/profile-account-pins-capability.test.ts.
vi.mock('../../src/services/composable-credentials/profile-context', () => ({
  resolveProfileCredentialContext: vi.fn(async () => null),
  resolveSessionProfileCredentialContext: vi.fn(async () => null),
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
  AI_PROXY_REQUEST_BODY_MAX_BYTES?: string;
};

const app = new Hono<{ Bindings: TestEnv }>();
app.route('/ai/proxy', aiProxyPassthroughRoutes);

const ANTHROPIC_MESSAGES_PATH = '/ai/proxy/valid-token/anthropic/v1/messages';
const OPENAI_CHAT_COMPLETIONS_PATH = '/ai/proxy/valid-token/openai/v1/chat/completions';

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
  env?: Partial<TestEnv>
) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    makeEnv(env)
  );
}

function anthropicMessagesBody(model = 'claude-sonnet-5'): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: 'hi' }] };
}

function openaiChatBody(model = 'gpt-4o'): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: 'hi' }] };
}

function mockWorkspaceAuth(agentType: string): void {
  mockVerifyAIProxyAuth.mockResolvedValueOnce({
    userId: 'user1',
    workspaceId: 'ws1',
    projectId: 'proj1',
    agentType,
  });
}

function mockAllowedRateLimit(): void {
  mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
}

function mockSuccessfulFetch(body: string): void {
  mockFetch.mockResolvedValueOnce(
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function expectNoSAMMetadataHeaders(headers: Record<string, string>): void {
  expect(headers['cf-aig-metadata']).toBeUndefined();
  const serializedHeaders = JSON.stringify(headers);
  expect(serializedHeaders).not.toContain('user1');
  expect(serializedHeaders).not.toContain('ws1');
  expect(serializedHeaders).not.toContain('proj1');
}

async function expectNoResponseOrLogLeakage(res: Response, leakedValues: string[]): Promise<void> {
  const responseText = await res.text();
  const logs = JSON.stringify(mockLogError.mock.calls);
  for (const leakedValue of leakedValues) {
    expect(responseText).not.toContain(leakedValue);
    expect(logs).not.toContain(leakedValue);
  }
}

beforeEach(() => {
  // An assertion before a second request must not leak queued auth/gate/fetch
  // responses into the next scenario.
  vi.resetAllMocks();
  // Default: usage gates always allow (tests override when needed)
  mockCheckAiUsageGate.mockResolvedValue({ allowed: true });
  mockCheckMonthlyCostCap.mockResolvedValue({ allowed: true, costUsd: 0, capUsd: null });
  mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) => {
    const agentType = (consumer as { agentType?: string }).agentType;
    if (agentType === 'claude-code') {
      return Promise.resolve({
        consumer,
        configuration: {
          settings: { baseUrl: 'https://anthropic-alt.example/anthropic', dialect: 'anthropic' },
        },
        credential: {
          id: 'cred-anthropic-default',
          secret: { kind: 'api-key', apiKey: 'sk-ant-resolved-key' },
        },
        source: 'user-attachment',
      });
    }
    return Promise.resolve({
      consumer,
      configuration: { settings: { providerId: 'custom-openai', providerName: 'Custom OpenAI' } },
      credential: {
        id: 'cred-openai-default',
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
  it('rejects oversized Anthropic passthrough bodies before credential resolution', async () => {
    mockWorkspaceAuth('claude-code');
    mockAllowedRateLimit();

    const res = await postJson(
      ANTHROPIC_MESSAGES_PATH,
      { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x'.repeat(256) }] },
      {},
      { AI_PROXY_REQUEST_BODY_MAX_BYTES: '128' }
    );

    expect(res.status).toBe(413);
    expect(mockResolveForConsumer).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects oversized OpenAI passthrough bodies before credential resolution', async () => {
    mockWorkspaceAuth('openai-codex');
    mockAllowedRateLimit();

    const res = await postJson(
      OPENAI_CHAT_COMPLETIONS_PATH,
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'x'.repeat(256) }] },
      {},
      { AI_PROXY_REQUEST_BODY_MAX_BYTES: '128' }
    );

    expect(res.status).toBe(413);
    expect(mockResolveForConsumer).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('Anthropic passthrough', () => {
    it('returns 401 when wstoken is invalid', async () => {
      mockVerifyAIProxyAuth.mockRejectedValueOnce(new Error('invalid'));

      const res = await postJson(
        '/ai/proxy/bad-token/anthropic/v1/messages',
        { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-api-key': 'sk-user' }
      );
      expect(res.status).toBe(401);
    });

    it('returns 401 when no server-side credential resolves', async () => {
      mockWorkspaceAuth('claude-code');
      mockAllowedRateLimit();
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockResolveForConsumer.mockResolvedValueOnce(null);

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());
      expect(res.status).toBe(401);
    });

    it('forwards resolved Anthropic credential without leaking SAM metadata headers', async () => {
      mockWorkspaceAuth('claude-code');
      mockAllowedRateLimit();
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockResolveForConsumer.mockResolvedValueOnce({
        consumer: { kind: 'agent', agentType: 'claude-code' },
        configuration: {
          settings: { baseUrl: 'https://anthropic-alt.example/anthropic', dialect: 'anthropic' },
        },
        credential: {
          id: 'cred-project-anthropic',
          secret: { kind: 'api-key', apiKey: 'sk-ant-resolved-key' },
        },
        source: 'project-attachment',
      });
      mockSuccessfulFetch('{"id":"msg_1"}');

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://anthropic-alt.example/anthropic/v1/messages');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-resolved-key');
      expect(headers['Authorization']).toBeUndefined();
      expectNoSAMMetadataHeaders(headers);
    });

    it('records provider limit headers against the resolved credential and agent session', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
        chatSessionId: 'chat1',
        agentType: 'claude-code',
        agentSessionId: 'agent-session-1',
      });
      mockAllowedRateLimit();
      mockResolveForConsumer.mockResolvedValueOnce({
        consumer: { kind: 'agent', agentType: 'claude-code' },
        configuration: {
          settings: { baseUrl: 'https://anthropic-alt.example/anthropic', dialect: 'anthropic' },
        },
        credential: {
          id: 'cred-project-anthropic',
          secret: { kind: 'api-key', apiKey: 'sk-ant-resolved-key' },
        },
        source: 'project-attachment',
      });
      mockFetch.mockResolvedValueOnce(
        new Response('{"id":"msg_1"}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'anthropic-ratelimit-tokens-limit': '1000',
            'anthropic-ratelimit-tokens-remaining': '100',
            'anthropic-ratelimit-tokens-reset': '2026-09-07T12:00:00Z',
          },
        })
      );

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());
      expect(res.status).toBe(200);
      expect(res.headers.get('anthropic-ratelimit-tokens-remaining')).toBe('100');

      expect(mockUpdateAIProxyAgentCredentialAttribution).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'user1',
          workspaceId: 'ws1',
          agentSessionId: 'agent-session-1',
          agentType: 'claude-code',
        }),
        expect.objectContaining({
          credentialReference: 'cc_credentials:cred-project-anthropic',
          credentialSource: 'project',
          credentialProvider: 'anthropic',
          providerMode: 'proxy-passthrough',
        })
      );
      expect(mockRecordProxyCredentialLimitObservationsFromHeaders).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Headers),
        expect.objectContaining({
          projectId: 'proj1',
          userId: 'user1',
          workspaceId: 'ws1',
          chatSessionId: 'chat1',
          agentSessionId: 'agent-session-1',
          agentType: 'claude-code',
          credentialReference: 'cc_credentials:cred-project-anthropic',
          credentialSource: 'project',
          provider: 'anthropic',
          providerMode: 'proxy-passthrough',
          source: 'ai-proxy-passthrough.anthropic.messages',
          responseStatus: 200,
        })
      );
    });

    it('preserves allowlisted Anthropic 429 limit headers on sanitized upstream errors', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
        agentType: 'claude-code',
      });
      mockAllowedRateLimit();
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'sk-leaked-upstream-diagnostic' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'retry-after': '30',
            'anthropic-ratelimit-requests-reset': '2026-09-07T12:00:00Z',
            'x-credential-debug': 'do-not-copy',
          },
        })
      );

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(res.headers.get('anthropic-ratelimit-requests-reset')).toBe('2026-09-07T12:00:00Z');
      expect(res.headers.get('x-credential-debug')).toBeNull();
      expect(await res.text()).not.toContain('sk-leaked-upstream-diagnostic');
    });

    it('accounts successful Anthropic responses when advisory credential telemetry persistence fails', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
        agentType: 'claude-code',
        agentSessionId: 'agent-session-1',
        agentCredentialGeneration: 7,
      });
      mockAllowedRateLimit();
      mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 13, outputTokens: 8 });
      mockUpdateAIProxyAgentCredentialAttribution.mockRejectedValueOnce(
        new Error('d1 unavailable')
      );
      mockRecordProxyCredentialLimitObservationsFromHeaders.mockRejectedValueOnce(
        new Error('telemetry unavailable')
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 13, output_tokens: 8 },
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'anthropic-ratelimit-tokens-remaining': '100',
            },
          }
        )
      );

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'msg_1' });
      expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
        expect.anything(),
        'user1',
        13,
        8,
        expect.objectContaining({ AI_PROXY_ENABLED: 'true' })
      );
      await vi.waitFor(() => {
        expect(mockRecordProxyCredentialLimitObservationsFromHeaders).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(Headers),
          expect.objectContaining({
            agentSessionId: 'agent-session-1',
            credentialReference: 'cc_credentials:cred-anthropic-default',
            responseStatus: 200,
          })
        );
      });
    });

    it('increments token usage after a successful Anthropic response', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
        agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 13, outputTokens: 8 });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 13, output_tokens: 8 },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const res = await postJson('/ai/proxy/valid-token/anthropic/v1/messages', {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'msg_1' });
      expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
        expect.anything(),
        'user1',
        13,
        8,
        expect.objectContaining({ AI_PROXY_ENABLED: 'true' })
      );
      expect(mockIncrementProviderUsage).toHaveBeenCalledWith(
        expect.anything(),
        'user1',
        expect.objectContaining({
          providerId: 'anthropic-alt-example',
          providerName: 'Anthropic Alt Example',
          dialect: 'anthropic',
        }),
        13,
        8,
        expect.objectContaining({ AI_PROXY_ENABLED: 'true' })
      );
    });

    it('does not increment token usage for Anthropic count_tokens responses', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
        agentType: 'claude-code',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ input_tokens: 13 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await postJson('/ai/proxy/valid-token/anthropic/v1/messages/count_tokens', {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(res.status).toBe(200);
      await res.text();
      expect(mockCheckAiUsageGate).toHaveBeenCalledOnce();
      expect(mockIncrementTokenUsage).not.toHaveBeenCalled();
    });

    it('applies rate limiting', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 9999 });

      const res = await postJson('/ai/proxy/valid-token/anthropic/v1/messages', {
        model: 'claude-sonnet-5',
      });
      expect(res.status).toBe(429);
    });

    it('applies token budget check', async () => {
      mockVerifyAIProxyAuth.mockResolvedValueOnce({
        userId: 'user1',
        workspaceId: 'ws1',
        projectId: 'proj1',
      });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
      mockCheckAiUsageGate.mockResolvedValueOnce({
        allowed: false,
        reason: 'daily-token-budget',
        budget: { allowed: false },
      });

      const res = await postJson('/ai/proxy/valid-token/anthropic/v1/messages', {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(429);
    });

    it('returns 503 when AI proxy is disabled', async () => {
      const res = await postJson(
        '/ai/proxy/valid-token/anthropic/v1/messages',
        { model: 'claude-sonnet-5' },
        {},
        { AI_PROXY_ENABLED: 'false' }
      );
      expect(res.status).toBe(503);
    });

    it('allows non-Claude model names for Anthropic-dialect compatible providers', async () => {
      mockWorkspaceAuth('claude-code');
      mockAllowedRateLimit();
      mockSuccessfulFetch('{"id":"msg_1"}');

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody('gpt-4o'));
      expect(res.status).toBe(200);
    });

    it('does not expose upstream Anthropic error bodies to clients or logs', async () => {
      mockWorkspaceAuth('claude-code');
      mockAllowedRateLimit();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid api key sk-leaked-upstream-diagnostic',
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());

      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('sk-leaked-upstream-diagnostic');
      expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(
        'sk-leaked-upstream-diagnostic'
      );
    });

    it('does not log upstream Anthropic URL or credential from fetch failures', async () => {
      mockWorkspaceAuth('claude-code');
      mockAllowedRateLimit();
      mockFetch.mockRejectedValueOnce(
        new TypeError(
          'connect failed for https://anthropic-alt.example/anthropic/v1/messages using sk-ant-resolved-key'
        )
      );

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());

      expect(res.status).toBe(502);
      await expectNoResponseOrLogLeakage(res, ['anthropic-alt.example', 'sk-ant-resolved-key']);
      expect(JSON.stringify(mockLogError.mock.calls)).toContain('TypeError');
    });

    it('does not resolve an OpenAI-compatible credential for the Anthropic route', async () => {
      mockWorkspaceAuth('claude-code');
      mockAllowedRateLimit();
      mockResolveForConsumer.mockResolvedValueOnce({
        consumer: { kind: 'agent', agentType: 'claude-code' },
        configuration: { settings: {} },
        credential: {
          secret: {
            kind: 'openai-compatible',
            apiKey: 'sk-openai-resolved-key',
            baseUrl: 'https://custom-openai.example/v1',
          },
        },
        source: 'user-attachment',
      });

      const res = await postJson(ANTHROPIC_MESSAGES_PATH, anthropicMessagesBody());

      expect(res.status).toBe(401);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('OpenAI passthrough', () => {
    it('forwards resolved OpenAI-compatible credential to its configured upstream', async () => {
      mockWorkspaceAuth('openai-codex');
      mockAllowedRateLimit();
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockSuccessfulFetch('{"id":"chatcmpl-1"}');

      const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, openaiChatBody());
      expect(res.status).toBe(200);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://custom-openai.example/v1/chat/completions');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-resolved-openai');
      expectNoSAMMetadataHeaders(headers);
    });

    it('increments token usage and rejects the next over-budget request', async () => {
      mockVerifyAIProxyAuth
        .mockResolvedValueOnce({
          userId: 'user1',
          workspaceId: 'ws1',
          projectId: 'proj1',
          agentType: 'openai-codex',
        })
        .mockResolvedValueOnce({
          userId: 'user1',
          workspaceId: 'ws1',
          projectId: 'proj1',
          agentType: 'openai-codex',
        });
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 })
        .mockResolvedValueOnce({ allowed: true, remaining: 28, resetAt: 9999 });
      mockCheckTokenBudget.mockResolvedValue({ allowed: true });
      mockCheckAiUsageGate.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({
        allowed: false,
        reason: 'daily-token-budget',
        budget: { allowed: false },
      });
      mockIncrementTokenUsage.mockResolvedValueOnce({ inputTokens: 21, outputTokens: 6 });
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            choices: [],
            usage: { prompt_tokens: 21, completion_tokens: 6 },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const first = await postJson('/ai/proxy/valid-token/openai/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(first.status).toBe(200);
      await first.text();

      const second = await postJson('/ai/proxy/valid-token/openai/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi again' }],
      });

      expect(mockIncrementTokenUsage).toHaveBeenCalledWith(
        expect.anything(),
        'user1',
        21,
        6,
        expect.objectContaining({ AI_PROXY_ENABLED: 'true' })
      );
      expect(second.status).toBe(429);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns 401 without a resolved server-side credential', async () => {
      mockWorkspaceAuth('openai-codex');
      mockAllowedRateLimit();
      mockCheckTokenBudget.mockResolvedValueOnce({ allowed: true });
      mockResolveForConsumer.mockResolvedValueOnce(null);

      const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, openaiChatBody());
      expect(res.status).toBe(401);
    });

    it('does not expose upstream OpenAI-compatible error bodies to clients or logs', async () => {
      mockWorkspaceAuth('openai-codex');
      mockAllowedRateLimit();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'authorization failed for sk-leaked-openai-diagnostic' },
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, openaiChatBody());

      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('sk-leaked-openai-diagnostic');
      expect(JSON.stringify(mockLogError.mock.calls)).not.toContain('sk-leaked-openai-diagnostic');
    });

    it('does not log upstream OpenAI-compatible URL or credential from fetch failures', async () => {
      mockWorkspaceAuth('openai-codex');
      mockAllowedRateLimit();
      mockFetch.mockRejectedValueOnce(
        new TypeError(
          'connect failed for https://custom-openai.example/v1/chat/completions using sk-resolved-openai'
        )
      );

      const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, openaiChatBody());

      expect(res.status).toBe(502);
      await expectNoResponseOrLogLeakage(res, ['custom-openai.example', 'sk-resolved-openai']);
      expect(JSON.stringify(mockLogError.mock.calls)).toContain('TypeError');
    });
  });
});

// A stored credential whose base URL names a private, loopback or metadata host is never called
// (outbound-fetch guard, landing slice L5a). Credentials saved before the save-time check
// (routes/composable-credentials.ts) can still hold such a URL; resolveProxyUpstream skips them,
// logs ai_proxy_passthrough.upstream_refused and tries the next candidate, so the request gets
// the designed 401 instead of reaching the host or turning into a 500 (rule 41).
function chatBody(model: string): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: 'hi' }] };
}

function allowRequest(agentType: string): void {
  mockVerifyAIProxyAuth.mockResolvedValueOnce({
    userId: 'user1',
    workspaceId: 'ws1',
    projectId: 'proj1',
    agentType,
  });
  mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
  mockCheckTokenBudget.mockResolvedValue({ allowed: true });
}

/** An openai-compatible credential whose base URL lives in its (encrypted) secret. */
function openAiCredential(baseUrl: string): void {
  mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) =>
    Promise.resolve({
      consumer,
      configuration: { settings: {} },
      credential: {
        id: 'cred-openai',
        secret: { kind: 'openai-compatible', apiKey: 'sk-own', baseUrl },
      },
      source: 'user-attachment',
    })
  );
}

/** An api-key credential whose base URL lives on the configuration (Anthropic dialect). */
function anthropicConfiguration(baseUrl: string): void {
  mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) =>
    Promise.resolve({
      consumer,
      configuration: { settings: { baseUrl, dialect: 'anthropic' } },
      credential: { id: 'cred-anthropic', secret: { kind: 'api-key', apiKey: 'sk-ant-own' } },
      source: 'user-attachment',
    })
  );
}

const REFUSED_BASE_URLS: Array<[string, string]> = [
  ['loopback literal', 'https://127.0.0.1:8443/v1'],
  ['loopback as one decimal number', 'https://2130706433/v1'],
  ['localhost name', 'https://localhost/v1'],
  ['RFC 1918', 'https://10.0.0.5/v1'],
  ['cloud metadata address', 'https://169.254.169.254/v1'],
  ['cloud metadata name', 'https://metadata.google.internal/v1'],
  ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/v1'],
  ['plain HTTP to a public host', 'http://llm.example.com/v1'],
];

describe('stored credential with a refused base URL (OpenAI passthrough)', () => {
  it.each(REFUSED_BASE_URLS)(
    '%s: never calls %s and answers the designed 401',
    async (_name, url) => {
      allowRequest('openai-codex');
      openAiCredential(url);

      const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, chatBody('gpt-4o'));

      expect(res.status).toBe(401);
      expect(mockFetch).not.toHaveBeenCalled();
      // Liveness: the credential really was resolved, so the refusal is the guard's doing.
      expect(mockResolveForConsumer).toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'ai_proxy_passthrough.upstream_refused',
        expect.objectContaining({ credentialId: 'cred-openai' })
      );
      // The log names the credential and the reason, never the URL.
      expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain(new URL(url).hostname);
    }
  );

  it('control: a public HTTPS base URL is still called', async () => {
    allowRequest('openai-codex');
    openAiCredential('https://llm.example.com/v1');
    mockFetch.mockResolvedValueOnce(
      new Response('{"id":"chatcmpl-1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, chatBody('gpt-4o'));

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://llm.example.com/v1/chat/completions');
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      'ai_proxy_passthrough.upstream_refused',
      expect.anything()
    );
  });
});

describe('a refused credential is skipped, not fatal: the next candidate serves the request', () => {
  it('with no agent type, a private codex credential is skipped and the opencode one is used', async () => {
    // Unknown agent type: every harness that speaks the dialect is a candidate (openai-codex,
    // then opencode), so the skip must move on to the next one rather than stop.
    mockVerifyAIProxyAuth.mockResolvedValueOnce({
      userId: 'user1',
      workspaceId: 'ws1',
      projectId: 'proj1',
      agentType: null,
    });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: 9999 });
    mockCheckTokenBudget.mockResolvedValue({ allowed: true });
    mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) => {
      const agentType = (consumer as { agentType?: string }).agentType;
      const baseUrl =
        agentType === 'openai-codex' ? 'https://10.0.0.5/v1' : 'https://llm.example.com/v1';
      return Promise.resolve({
        consumer,
        configuration: { settings: {} },
        credential: {
          id: `cred-${agentType}`,
          secret: { kind: 'openai-compatible', apiKey: `sk-${agentType}`, baseUrl },
        },
        source: 'user-attachment',
      });
    });
    mockFetch.mockResolvedValueOnce(
      new Response('{"id":"chatcmpl-1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await postJson(OPENAI_CHAT_COMPLETIONS_PATH, chatBody('gpt-4o'));

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://llm.example.com/v1/chat/completions');
    const refusals = mockLogWarn.mock.calls.filter(
      ([event]) => event === 'ai_proxy_passthrough.upstream_refused'
    );
    expect(refusals).toEqual([
      [
        'ai_proxy_passthrough.upstream_refused',
        { credentialId: 'cred-openai-codex', reason: 'host' },
      ],
    ]);
  });
});

describe('stored configuration with a refused base URL (Anthropic passthrough)', () => {
  it('a metadata base URL on the configuration is never called', async () => {
    allowRequest('claude-code');
    anthropicConfiguration('https://169.254.169.254/anthropic');

    const res = await postJson(ANTHROPIC_MESSAGES_PATH, chatBody('claude-sonnet-5'));

    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith('ai_proxy_passthrough.upstream_refused', {
      credentialId: 'cred-anthropic',
      reason: 'host',
    });
  });

  it('control: a public base URL on the configuration is still called', async () => {
    allowRequest('claude-code');
    anthropicConfiguration('https://anthropic-alt.example/anthropic');
    mockFetch.mockResolvedValueOnce(
      new Response('{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":1}}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await postJson(ANTHROPIC_MESSAGES_PATH, chatBody('claude-sonnet-5'));

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('https://anthropic-alt.example/');
  });
});

describe('L12 guarded redirects at every passthrough fetch site', () => {
  const cases = [
    ['anthropic messages', ANTHROPIC_MESSAGES_PATH, 'claude-code', 'sk-ant-resolved-key'],
    [
      'anthropic count_tokens',
      '/ai/proxy/valid-token/anthropic/v1/messages/count_tokens',
      'claude-code',
      'sk-ant-resolved-key',
    ],
    ['OpenAI chat', OPENAI_CHAT_COMPLETIONS_PATH, 'openai-codex', 'sk-resolved-openai'],
  ] as const;
  it.each(cases)(
    '%s follows same-origin redirects, retaining the credential only there',
    async (_name, path, agentType, key) => {
      mockWorkspaceAuth(agentType);
      mockAllowedRateLimit();
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { Location: '/same-origin' } })
      );
      mockSuccessfulFetch('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
      const response = await postJson(path, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'private prompt' }],
      });
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [first, second] = mockFetch.mock.calls as [string, RequestInit][];
      expect(new URL(second[0]).origin).toBe(new URL(first[0]).origin);
      expect([...new Headers(second[1].headers).values()].join(' ')).toContain(key);
      expect(second[1].body).toBe(first[1].body);
      expect(second[1].redirect).toBe('manual');
    }
  );
  it.each(cases)(
    '%s refuses private/metadata hops and cross-origin body replay',
    async (_name, path, agentType) => {
      for (const [location, status] of [
        ['http://127.0.0.1/private', 302],
        ['https://169.254.169.254/latest/meta-data', 302],
        ['https://attacker.example.org/collect', 307],
      ] as const) {
        mockFetch.mockReset();
        mockWorkspaceAuth(agentType);
        mockAllowedRateLimit();
        mockFetch.mockResolvedValueOnce(
          new Response(null, { status, headers: { Location: location } })
        );
        const response = await postJson(path, {
          model: 'test-model',
          messages: [{ role: 'user', content: 'private prompt' }],
        });
        expect(response.status).toBe(502);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(await response.text()).not.toContain('private prompt');
      }
    }
  );
  it.each(cases)(
    '%s strips credential headers on a cross-origin GET redirect',
    async (_name, path, agentType, key) => {
      mockWorkspaceAuth(agentType);
      mockAllowedRateLimit();
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { Location: 'https://other.example.org/result' },
        })
      );
      mockSuccessfulFetch('{"choices":[]}');
      const response = await postJson(path, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'private prompt' }],
      });
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(JSON.stringify(init.headers)).not.toContain(key);
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
      expect(new Headers(init.headers).has('x-api-key')).toBe(false);
    }
  );
});

describe('L13: platform-owned passthrough credentials count toward the monthly cap and ceiling', () => {
  const PRICED = PLATFORM_AI_MODELS.find(
    (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
  )!;
  // No addressable gateway: SAM prices platform-billed spend itself.
  const NO_GATEWAY = { AI_GATEWAY_ID: '', CF_ACCOUNT_ID: '' };
  beforeEach(() => {
    proxyEnabledOverride.value = true; // aiProxy.directUpstreamEnabled
    return () => {
      proxyEnabledOverride.value = undefined;
    };
  });

  async function callWithSource(
    source: string,
    options: {
      model?: string;
      anthropic?: boolean;
      stream?: boolean;
      missingUsage?: boolean;
      gateway?: boolean;
      requestBody?: Record<string, unknown>;
    } = {}
  ) {
    const model = options.model ?? PRICED.id;
    mockWorkspaceAuth(options.anthropic ? 'claude-code' : 'openai-codex');
    mockAllowedRateLimit();
    mockCheckTokenBudget.mockResolvedValue({ allowed: true });
    mockResolveForConsumer.mockImplementation((_db, _userId, _key, consumer) =>
      Promise.resolve({
        consumer,
        configuration: {
          settings: options.anthropic
            ? { baseUrl: 'https://anthropic-alt.example', dialect: 'anthropic' }
            : { providerId: 'openai', providerName: 'OpenAI' },
        },
        credential: {
          id: 'cred-test',
          secret: options.anthropic
            ? { kind: 'api-key', apiKey: 'sk-test' }
            : {
                kind: 'openai-compatible',
                apiKey: 'sk-test',
                baseUrl: 'https://custom-openai.example/v1',
              },
        },
        source,
      })
    );
    const text = 'This generated output must be counted even without provider usage.';
    const payload = options.anthropic
      ? { content: [{ type: 'text', text }] }
      : { choices: [{ message: { content: text } }] };
    const usage = options.anthropic
      ? { input_tokens: 1000, output_tokens: 1000 }
      : { prompt_tokens: 1000, completion_tokens: 1000 };
    const responseBody = options.stream
      ? options.anthropic
        ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify(options.missingUsage ? payload : { ...payload, usage });
    mockFetch.mockResolvedValueOnce(
      new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': options.stream ? 'text/event-stream' : 'application/json' },
      })
    );
    const res = await postJson(
      options.anthropic ? ANTHROPIC_MESSAGES_PATH : OPENAI_CHAT_COMPLETIONS_PATH,
      {
        ...(options.anthropic ? anthropicMessagesBody(model) : openaiChatBody(model)),
        stream: options.stream ?? false,
        ...options.requestBody,
      },
      {},
      options.gateway ? {} : NO_GATEWAY
    );
    const copy = res.clone();
    await res.text();
    return copy;
  }

  it.each(['user-attachment', 'project-attachment', 'platform'])(
    'passes resolved billing ownership to the gate: %s',
    async (source) => {
      const res = await callWithSource(source);
      expect(res.status).toBe(200);
      expect(mockCheckAiUsageGate.mock.calls[0]?.[4]).toEqual({
        platformBilled: source === 'platform',
      });
    }
  );

  it('refuses an unpriced locally funded model before upstream fetch', async () => {
    const res = await callWithSource('platform', { model: 'custom-unpriced-model' });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['user-attachment', 'project-attachment'])(
    'keeps custom models for own-funded %s',
    async (source) => {
      expect((await callWithSource(source, { model: 'custom-unpriced-model' })).status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps the gateway platform path unchanged for custom models', async () => {
    expect(
      (await callWithSource('platform', { model: 'custom-unpriced-model', gateway: true })).status
    ).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('estimates missing platform output, anthropic=%s stream=%s', async (anthropic, stream) => {
    const model = anthropic
      ? PLATFORM_AI_MODELS.find((m) => m.provider === 'anthropic')!.id
      : PRICED.id;
    expect(
      (await callWithSource('platform', { model, anthropic, stream, missingUsage: true })).status
    ).toBe(200);
    expect(mockIncrementProviderUsage).toHaveBeenCalledTimes(1);
    const args = mockIncrementProviderUsage.mock.calls[0]!;
    expect(args[3]).toBeGreaterThan(0);
    expect(args[4]).toBeGreaterThan(0);
    expect(args[6]).toBeGreaterThan(0);
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('includes tool schemas and structured history in input fallback, anthropic=%s stream=%s', async (anthropic, stream) => {
    const description = 'Detailed schema information. '.repeat(200);
    const argumentsJson = JSON.stringify({ query: 'long historical tool input '.repeat(200) });
    const requestBody = anthropic
      ? {
          system: description,
          tools: [{ name: 'lookup', description, input_schema: { type: 'object' } }],
          messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'lookup', input: { query: argumentsJson } }] }],
        }
      : {
          tools: [{ type: 'function', function: { name: 'lookup', description, parameters: { type: 'object' } } }],
          messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: argumentsJson } }] }],
        };
    const model = anthropic
      ? PLATFORM_AI_MODELS.find((m) => m.provider === 'anthropic')!.id
      : PRICED.id;
    expect((await callWithSource('platform', { model, anthropic, stream, missingUsage: true, requestBody })).status).toBe(200);
    const usage = mockIncrementProviderUsage.mock.calls[0]!;
    expect(usage[3]).toBeGreaterThanOrEqual(Math.ceil(JSON.stringify(requestBody).length / 4));
  });

  it.each(['user-attachment', 'project-attachment', 'gateway'])(
    'preserves previous streaming input estimation for %s', async (source) => {
      await callWithSource(source === 'gateway' ? 'platform' : source, {
        gateway: source === 'gateway', stream: true, missingUsage: true,
        requestBody: { tools: [{ description: 'large tool schema '.repeat(200) }] },
      });
      expect(mockIncrementProviderUsage.mock.calls[0]?.[3]).toBe(1);
    }
  );

  it('keeps measured input authoritative even with a larger tool schema', async () => {
    await callWithSource('platform', {
      requestBody: { tools: [{ description: 'large tool schema '.repeat(1000) }] },
    });
    expect(mockIncrementProviderUsage.mock.calls[0]?.[3]).toBe(1000);
  });

  it('prices a call served by a platform credential, with its catalog model', async () => {
    await callWithSource('platform');
    expect(mockIncrementProviderUsage).toHaveBeenCalledTimes(1);
    const args = mockIncrementProviderUsage.mock.calls[0]!;
    expect(args[6]).toBeGreaterThan(0);
    expect(args[7]).toBe(PRICED.id);
  });

  it("does not price a user's own credential (their own spend; control)", async () => {
    await callWithSource('user-attachment');
    expect(mockIncrementProviderUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementProviderUsage.mock.calls[0]).toHaveLength(6);
  });
});

describe('installation ceiling denial recovery through passthrough routes', () => {
  it.each([
    [ANTHROPIC_MESSAGES_PATH, 'claude-code', anthropicMessagesBody()],
    [OPENAI_CHAT_COMPLETIONS_PATH, 'openai-codex', openaiChatBody()],
  ])('names administrator recovery for %s', async (path, agentType, body) => {
    mockWorkspaceAuth(agentType as string);
    mockAllowedRateLimit();
    mockCheckAiUsageGate.mockResolvedValue({
      allowed: false,
      reason: 'monthly-cost-cap',
      monthlyCap: { allowed: false, costUsd: 50, capUsd: 50, limitSource: 'administrator' },
    });
    const response = await postJson(path as string, body as Record<string, unknown>);
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).toContain('Contact your administrator');
    expect(text).not.toContain('Adjust your cap');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
