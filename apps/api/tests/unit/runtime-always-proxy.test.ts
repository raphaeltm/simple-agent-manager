/**
 * Runtime Always-Proxy — Unit Tests
 *
 * Tests that runtime.ts:POST /:id/agent-key returns proxy inferenceConfig
 * when AI proxy is enabled and the selected credential can be forwarded to
 * the upstream provider.
 *
 * Two modes:
 * - User has upstream-compatible credential → apiKeySource: 'user-credential' (passthrough proxy)
 * - No user credential → apiKeySource: 'callback-token' (platform proxy, existing)
 */
import { Hono } from 'hono';
import { beforeEach,describe, expect, it, vi } from 'vitest';

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
  jsonValidator: () => async (c: { req: { json: () => Promise<unknown>; addValidatedData: (target: string, data: unknown) => void }}, next: () => Promise<void>) => {
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
  return testApp.request('/ws/test-workspace/agent-key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-callback-token',
    },
    body: JSON.stringify({ agentType }),
  }, envOverrides ? { ...mockEnv, ...envOverrides } as Env : mockEnv);
}

// Track query count across DB calls
let queryCount = 0;

beforeEach(() => {
  vi.clearAllMocks();
  queryCount = 0;
  mockKvGet.mockResolvedValue(null);
});

describe('runtime.ts always-proxy', () => {
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
    });

    const res = await postAgentKey('claude-code');

    expect(res.status).toBe(200);
    const json = await res.json() as {
      apiKey: string;
      credentialKind: string;
      inferenceConfig: { provider: string; baseURL: string; apiKeySource: string };
    };
    expect(json.apiKey).toBe('sk-ant-user-key');
    expect(json.credentialKind).toBe('api-key');
    expect(json.inferenceConfig).toBeDefined();
    expect(json.inferenceConfig.provider).toBe('anthropic-passthrough');
    expect(json.inferenceConfig.apiKeySource).toBe('user-credential');
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
    const json = await res.json() as {
      apiKey: string;
      credentialKind: string;
      inferenceConfig?: unknown;
    };
    expect(json.apiKey).toBe('claude-oauth-token');
    expect(json.credentialKind).toBe('oauth-token');
    expect(json.inferenceConfig).toBeUndefined();
  });

  it('returns platform proxy config when user has no credential and proxy enabled', async () => {
    mockDbLimit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ userId: 'user1', projectId: 'proj1' }]; // workspace
      if (queryCount === 2) return []; // tasks
      return [];
    });
    mockGetDecryptedAgentKey.mockResolvedValueOnce(null);

    const res = await postAgentKey('claude-code');

    expect(res.status).toBe(200);
    const json = await res.json() as {
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
    const json = await res.json() as {
      apiKey: string;
      inferenceConfig?: unknown;
    };
    expect(json.apiKey).toBe('sk-ant-user-key');
    expect(json.inferenceConfig).toBeUndefined();
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
    });

    const res = await postAgentKey('openai-codex');

    expect(res.status).toBe(200);
    const json = await res.json() as {
      apiKey: string;
      inferenceConfig: { provider: string; baseURL: string; apiKeySource: string };
    };
    expect(json.apiKey).toBe('sk-openai-user-key');
    expect(json.inferenceConfig.provider).toBe('openai-passthrough');
    expect(json.inferenceConfig.apiKeySource).toBe('user-credential');
    expect(json.inferenceConfig.baseURL).toContain('/ai/proxy/{wstoken}/openai/v1');
  });
});
