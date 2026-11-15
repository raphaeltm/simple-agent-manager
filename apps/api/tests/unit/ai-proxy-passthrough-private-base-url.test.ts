/**
 * A stored credential whose base URL names a private, loopback or metadata host is never called
 * (outbound-fetch guard, landing slice L5a). Credentials saved before the save-time check
 * (routes/composable-credentials.ts) can still hold such a URL; `resolveProxyUpstream` skips them
 * and logs `ai_proxy_passthrough.upstream_refused`, so the request gets the designed 401 "no
 * compatible credential" instead of reaching the host or turning into a 500 (rule 41).
 *
 * Enters through the real passthrough routes; only credential resolution and the network are faked.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route protocol tests mock D1; real pin enforcement is covered by provider-limit-platform-attribution.test.ts.
vi.mock('../../src/services/provider-limit-credential-pin', () => ({
  assertProviderLimitCredentialPin: vi.fn(async () => {}),
}));

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

beforeEach(() => {
  vi.resetAllMocks();
  mockCheckAiUsageGate.mockResolvedValue({ allowed: true });
  mockCheckMonthlyCostCap.mockResolvedValue({ allowed: true, costUsd: 0, capUsd: null });
});

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
