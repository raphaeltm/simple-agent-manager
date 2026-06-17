/**
 * Runtime Always-Proxy — Unit Tests
 *
 * Tests that runtime.ts:POST /:id/agent-key returns proxy inferenceConfig
 * when AI proxy is enabled and the selected credential can be forwarded to
 * the upstream provider.
 *
 * Two modes:
 * - Claude/Codex user has upstream-compatible credential → passthrough proxy
 * - Claude/Codex explicit SAM provider or OpenCode explicit platform provider
 *   with no user credential → platform proxy
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock dependencies ---

const mockDbLimit = vi.fn();
const mockKvGet = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbLimit(),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
  };
});

vi.mock('../../src/db/schema', () => ({
  workspaces: { id: 'id', userId: 'userId', projectId: 'projectId' },
  tasks: { id: 'id', workspaceId: 'workspaceId' },
  credentials: {},
  agentSettings: {},
}));

vi.mock('../../src/lib/logger', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: () => 'test-key',
}));

vi.mock('../../src/lib/ulid', () => ({
  ulid: () => 'test-ulid',
}));

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn(),
  requireApproved: () => vi.fn(),
}));

vi.mock('../../src/middleware/error', () => ({
  errors: {
    notFound: (msg: string) => {
      const err = new Error(msg) as Error & { statusCode: number; error: string };
      err.statusCode = 404;
      err.error = 'NOT_FOUND';
      return err;
    },
    badRequest: (msg: string) => {
      const err = new Error(msg) as Error & { statusCode: number; error: string };
      err.statusCode = 400;
      err.error = 'BAD_REQUEST';
      return err;
    },
  },
}));

const mockGetDecryptedAgentKey = vi.fn();
vi.mock('../../src/routes/credentials', () => ({
  getDecryptedAgentKey: (...args: unknown[]) => mockGetDecryptedAgentKey(...args),
  getDecryptedCredential: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/schemas', () => ({
  AgentTypeBodySchema: {},
  AgentCredentialSyncSchema: {},
  BootLogEntrySchema: {},
  MessageBatchSchema: {},
  jsonValidator:
    () =>
    async (
      c: {
        req: {
          json: () => Promise<unknown>;
          addValidatedData: (target: string, data: unknown) => void;
        };
      },
      next: () => Promise<void>
    ) => {
      const body = await c.req.json();
      c.req.addValidatedData('json', body);
      await next();
    },
}));

vi.mock('../../src/routes/workspaces/_helpers', () => ({
  verifyWorkspaceCallbackAuth: vi.fn().mockResolvedValue(undefined),
  getWorkspaceRuntimeAssets: vi.fn(),
  safeParseJson: vi.fn(),
}));

vi.mock('../../src/services/boot-log', () => ({
  appendBootLog: vi.fn(),
}));

vi.mock('../../src/services/encryption', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('../../src/services/github-app', () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn(),
}));

vi.mock('../../src/services/project-agent-defaults', () => ({
  resolveProjectAgentDefault: vi.fn().mockReturnValue({ model: null, permissionMode: null }),
}));

vi.mock('../../src/services/project-data', () => ({
  persistMessageBatch: vi.fn(),
}));

vi.mock('../../src/services/provider-credentials', () => ({
  extractScalewaySecretKey: vi.fn(),
}));

vi.mock('../../src/services/trial/bridge', () => ({
  bridgeAgentActivity: vi.fn(),
}));

vi.mock('../../src/lib/route-helpers', () => ({
  parsePositiveInt: (val: string | undefined, def: number) => {
    if (!val) return def;
    const n = parseInt(val, 10);
    return isNaN(n) || n <= 0 ? def : n;
  },
}));

import type { Env } from '../../src/env';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';

// Wrap subrouter in parent app for correct env binding
const testApp = new Hono<{ Bindings: Env }>();
testApp.onError((err, c) => {
  const appError = err as { statusCode?: number; error?: string; message?: string };
  if (typeof appError.statusCode === 'number') {
    return c.json({ error: appError.error, message: appError.message }, appError.statusCode as 400);
  }
  return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
});
testApp.route('/ws', runtimeRoutes);

const mockEnv = {
  DATABASE: {} as D1Database,
  KV: { get: (...args: unknown[]) => mockKvGet(...args), put: vi.fn() },
  AI_PROXY_ENABLED: 'true',
  BASE_DOMAIN: 'example.com',
  JWT_PUBLIC_KEY: 'key',
  ENCRYPTION_KEY: 'test-key',
  CALLBACK_TOKEN_AUDIENCE: 'test-audience',
  CALLBACK_TOKEN_ISSUER: 'test-issuer',
} as unknown as Env;

function postAgentKey(agentType: string, envOverrides?: Partial<Env>) {
  return testApp.request(
    '/ws/test-workspace/agent-key',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-callback-token',
      },
      body: JSON.stringify({ agentType }),
    },
    envOverrides ? ({ ...mockEnv, ...envOverrides } as Env) : mockEnv
  );
}

function mockWorkspaceOnly() {
  mockDbLimit.mockImplementation(() => {
    queryCount++;
    if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }];
    return [];
  });
}

async function readAgentKey(agentType: string) {
  const res = await postAgentKey(agentType);
  const json = (await res.json()) as {
    apiKey?: string;
    credentialKind?: string;
    inferenceConfig?: unknown;
    message?: string;
  };
  return { res, json };
}

// Track query count across DB calls
let queryCount = 0;

beforeEach(() => {
  vi.clearAllMocks();
  queryCount = 0;
  mockKvGet.mockResolvedValue(null);
});

describe('runtime.ts always-proxy', () => {
  it('preserves passthrough inferenceConfig outputs for Claude/Codex agents', async () => {
    const outputs: Record<string, unknown> = {};

    for (const agentType of ['claude-code', 'openai-codex']) {
      vi.clearAllMocks();
      queryCount = 0;
      mockKvGet.mockResolvedValue(null);
      mockDbLimit.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }];
        if (queryCount === 2) return [];
        return [];
      });
      mockGetDecryptedAgentKey.mockResolvedValueOnce({
        credential: `sk-${agentType}`,
        credentialKind: 'api-key',
        credentialSource: 'user',
        baseUrl: agentType === 'claude-code'
          ? 'https://anthropic-alt.example/anthropic'
          : 'https://custom-openai.example/v1',
        providerDialect: agentType === 'claude-code' ? 'anthropic' : 'openai-compatible',
      });

      const response = await postAgentKey(agentType);
      const json = await response.json() as { inferenceConfig?: unknown };
      expect(response.status).toBe(200);
      outputs[agentType] = json.inferenceConfig;
    }

    expect(outputs).toMatchInlineSnapshot(`
      {
        "claude-code": {
          "apiKeySource": "callback-token",
          "baseURL": "https://api.example.com/ai/proxy/{wstoken}/anthropic",
          "model": "claude-sonnet-4-6",
          "provider": "anthropic-passthrough",
        },
        "openai-codex": {
          "apiKeySource": "callback-token",
          "baseURL": "https://api.example.com/ai/proxy/{wstoken}/openai/v1",
          "model": "gpt-4.1",
          "provider": "openai-passthrough",
        },
      }
    `);
  });

  it('preserves platform inferenceConfig outputs for explicit platform selections by agent type', async () => {
    const outputs: Record<string, unknown> = {};

    for (const agentType of ['claude-code', 'openai-codex', 'opencode']) {
      vi.clearAllMocks();
      queryCount = 0;
      mockKvGet.mockResolvedValue(null);
      mockDbLimit.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }];
        if (queryCount === 2 && agentType === 'opencode') return [{ opencodeProvider: 'platform' }];
        if (queryCount === 2) return [{ providerMode: 'sam' }];
        return [];
      });
      if (agentType !== 'opencode') {
        mockGetDecryptedAgentKey.mockResolvedValueOnce(null);
      }

      const response = await postAgentKey(agentType);
      const json = await response.json() as { inferenceConfig?: unknown };
      expect(response.status).toBe(200);
      outputs[agentType] = json.inferenceConfig;
    }

    expect(outputs).toMatchInlineSnapshot(`
      {
        "claude-code": {
          "apiKeySource": "callback-token",
          "baseURL": "https://api.example.com/ai/anthropic",
          "model": "claude-sonnet-4-6",
          "provider": "anthropic-proxy",
        },
        "openai-codex": {
          "apiKeySource": "callback-token",
          "baseURL": "https://api.example.com/ai/v1",
          "model": "gpt-4.1",
          "provider": "openai-proxy",
        },
        "opencode": {
          "apiKeySource": "callback-token",
          "baseURL": "https://api.example.com/ai/v1",
          "model": "@cf/meta/llama-4-scout-17b-16e-instruct",
          "provider": "openai-compatible",
        },
      }
    `);
  });

  it('returns passthrough proxy config when user has claude-code credential and proxy enabled', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }]; // workspace
      if (queryCount === 2) return []; // tasks (no active task)
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: 'sk-ant-user-key',
      credentialKind: 'api-key',
      credentialSource: 'user',
      baseUrl: 'https://anthropic-alt.example/anthropic',
      providerDialect: 'anthropic',
    });

    const res = await postAgentKey('claude-code');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      apiKey: string;
      credentialKind: string;
      inferenceConfig: { provider: string; baseURL: string; apiKeySource: string };
    };
    expect(json.apiKey).toBe('__sam_proxy__');
    expect(json.credentialKind).toBe('api-key');
    expect(json.inferenceConfig).toBeDefined();
    expect(json.inferenceConfig.provider).toBe('anthropic-passthrough');
    expect(json.inferenceConfig.apiKeySource).toBe('callback-token');
    expect(json.inferenceConfig.baseURL).toContain('/ai/proxy/{wstoken}/anthropic');
  });

  it('returns direct credential when user has claude-code OAuth token and proxy enabled', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }]; // workspace
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: 'claude-oauth-token',
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });

    const res = await postAgentKey('claude-code');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      apiKey: string;
      credentialKind: string;
      inferenceConfig?: unknown;
    };
    expect(json.apiKey).toBe('claude-oauth-token');
    expect(json.credentialKind).toBe('oauth-token');
    expect(json.inferenceConfig).toBeUndefined();
  });

  it('returns platform proxy config when user has no credential, proxy enabled, and SAM provider selected', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }]; // workspace
      if (queryCount === 2) return [{ providerMode: 'sam' }]; // agent settings
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce(null);

    const res = await postAgentKey('claude-code');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      apiKey: string;
      credentialSource: string;
      inferenceConfig: { provider: string; apiKeySource: string };
    };
    expect(json.apiKey).toBe('__platform_proxy__');
    expect(json.credentialSource).toBe('platform');
    expect(json.inferenceConfig.provider).toBe('anthropic-proxy');
    expect(json.inferenceConfig.apiKeySource).toBe('callback-token');
  });

  it('returns direct credential when proxy is disabled', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }]; // workspace
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: 'sk-ant-user-key',
      credentialKind: 'api-key',
      credentialSource: 'user',
    });

    const res = await postAgentKey('claude-code', { AI_PROXY_ENABLED: 'false' } as Partial<Env>);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      apiKey: string;
      inferenceConfig?: unknown;
    };
    expect(json.apiKey).toBe('sk-ant-user-key');
    expect(json.inferenceConfig).toBeUndefined();
  });

  it('returns direct Amp credential without AI proxy config', async () => {
    mockWorkspaceOnly();
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: 'sgamp-user-key',
      credentialKind: 'api-key',
      credentialSource: 'user',
    });

    const { res, json } = await readAgentKey('amp');

    expect(res.status).toBe(200);
    expect(json.apiKey).toBe('sgamp-user-key');
    expect(json.credentialKind).toBe('api-key');
    expect(json.inferenceConfig).toBeUndefined();
  });

  it('does not fall back to platform proxy for Amp without a credential', async () => {
    mockWorkspaceOnly();
    mockGetDecryptedAgentKey.mockResolvedValueOnce(null);

    const { res, json } = await readAgentKey('amp');

    expect(res.status).toBe(404);
    expect(json.message).toBe('Agent credential');
  });

  it('returns passthrough proxy config for codex with user credential', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }]; // workspace
      if (queryCount === 2) return []; // tasks
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: 'sk-openai-user-key',
      credentialKind: 'api-key',
      credentialSource: 'user',
      baseUrl: 'https://custom-openai.example/v1',
      providerDialect: 'openai-compatible',
    });

    const res = await postAgentKey('openai-codex');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      apiKey: string;
      inferenceConfig: { provider: string; baseURL: string; apiKeySource: string; upstreamBaseURL?: string };
    };
    expect(json.apiKey).toBe('__sam_proxy__');
    expect(json.inferenceConfig.provider).toBe('openai-passthrough');
    expect(json.inferenceConfig.apiKeySource).toBe('callback-token');
    expect(json.inferenceConfig.baseURL).toContain('/ai/proxy/{wstoken}/openai/v1');
    expect(json.inferenceConfig.upstreamBaseURL).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('https://custom-openai.example/v1');
  });

  it('returns direct credential when codex has auth-file OAuth credential', async () => {
    mockWorkspaceOnly();
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: '{"tokens":{"access_token":"codex-access-token"}}',
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });

    const { res, json } = await readAgentKey('openai-codex');

    expect(res.status).toBe(200);
    expect(json.apiKey).toContain('codex-access-token');
    expect(json.credentialKind).toBe('oauth-token');
    expect(json.inferenceConfig).toBeUndefined();
  });

  it('fails closed instead of injecting an incompatible baseURL-backed credential', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }];
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: 'sk-openai-user-key',
      credentialKind: 'api-key',
      credentialSource: 'user',
      baseUrl: 'https://custom-openai.example/v1',
      providerDialect: 'openai-compatible',
    });

    const res = await postAgentKey('claude-code');
    const json = await res.json() as { message?: string; apiKey?: string };

    expect(res.status).toBe(404);
    expect(json.message).toBe('Agent credential');
    expect(json.apiKey).toBeUndefined();
  });

  it('returns direct auth-file credential for Codex oauth-token without passthrough proxy', async () => {
    mockWorkspaceOnly();
    mockGetDecryptedAgentKey.mockResolvedValueOnce({
      credential: '{"tokens":{"access_token":"codex-access"}}',
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });

    const { res, json } = await readAgentKey('openai-codex');

    expect(res.status).toBe(200);
    expect(json.apiKey).toBe('{"tokens":{"access_token":"codex-access"}}');
    expect(json.credentialKind).toBe('oauth-token');
    expect(json.inferenceConfig).toBeUndefined();
  });
});
