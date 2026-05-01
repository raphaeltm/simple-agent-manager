/**
 * Unit tests for the AI billing mode resolution helper.
 *
 * Tests all billing mode branches: unified, platform-key, auto
 * (with CF_AIG_TOKEN, CF_API_TOKEN fallback, and neither).
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveBillingMode, resolveUnifiedBillingToken, resolveUpstreamAuth } from '../../../src/services/ai-billing';

// =============================================================================
// Mock helpers
// =============================================================================

function mockKV(overrides: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => overrides[key] ?? null),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as KVNamespace;
}

function mockEnv(overrides: Partial<{
  CF_AIG_TOKEN: string;
  CF_API_TOKEN: string;
  AI_PROXY_BILLING_MODE: string;
  ENCRYPTION_KEY: string;
  KV: KVNamespace;
}> = {}) {
  return {
    CF_AIG_TOKEN: overrides.CF_AIG_TOKEN ?? 'test-cf-token',
    CF_API_TOKEN: overrides.CF_API_TOKEN ?? 'test-cf-api-token',
    AI_PROXY_BILLING_MODE: overrides.AI_PROXY_BILLING_MODE,
    ENCRYPTION_KEY: overrides.ENCRYPTION_KEY ?? 'test-key',
    KV: overrides.KV ?? mockKV(),
    DATABASE: {} as D1Database,
  } as Parameters<typeof resolveUpstreamAuth>[0];
}

// Mock the platform-credentials module
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn(),
}));

// Mock the secrets module
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn(() => 'mock-encryption-key'),
}));

import { getPlatformAgentCredential } from '../../../src/services/platform-credentials';

const mockGetPlatformCred = vi.mocked(getPlatformAgentCredential);

// =============================================================================
// resolveUnifiedBillingToken
// =============================================================================

describe('resolveUnifiedBillingToken', () => {
  it('prefers CF_AIG_TOKEN over CF_API_TOKEN', () => {
    const env = mockEnv({ CF_AIG_TOKEN: 'aig-token', CF_API_TOKEN: 'api-token' });
    expect(resolveUnifiedBillingToken(env)).toBe('aig-token');
  });

  it('falls back to CF_API_TOKEN when CF_AIG_TOKEN is absent', () => {
    const env = mockEnv({ CF_API_TOKEN: 'api-token' });
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    expect(resolveUnifiedBillingToken(env)).toBe('api-token');
  });

  it('returns undefined when both tokens are absent', () => {
    const env = mockEnv();
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    (env as Record<string, unknown>).CF_API_TOKEN = undefined;
    expect(resolveUnifiedBillingToken(env)).toBeUndefined();
  });
});

// =============================================================================
// resolveBillingMode
// =============================================================================

describe('resolveBillingMode', () => {
  it('returns default (auto) when no override is set', async () => {
    const env = mockEnv();
    expect(await resolveBillingMode(env)).toBe('auto');
  });

  it('reads billing mode from env var', async () => {
    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'unified' });
    expect(await resolveBillingMode(env)).toBe('unified');
  });

  it('reads billing mode from KV over env var', async () => {
    const kv = mockKV({ 'platform:ai-proxy:billing-mode': 'platform-key' });
    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'unified', KV: kv });
    expect(await resolveBillingMode(env)).toBe('platform-key');
  });

  it('ignores invalid KV value and falls through to env', async () => {
    const kv = mockKV({ 'platform:ai-proxy:billing-mode': 'invalid-value' });
    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'unified', KV: kv });
    expect(await resolveBillingMode(env)).toBe('unified');
  });

  it('ignores invalid env value and returns default', async () => {
    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'bogus' });
    expect(await resolveBillingMode(env)).toBe('auto');
  });
});

// =============================================================================
// resolveUpstreamAuth — unified mode
// =============================================================================

describe('resolveUpstreamAuth — unified mode', () => {
  it('sets cf-aig-authorization header and does NOT set x-api-key', async () => {
    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'unified', CF_AIG_TOKEN: 'my-cf-token' });
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    const result = await resolveUpstreamAuth(env, db);

    expect(result.headers['cf-aig-authorization']).toBe('Bearer my-cf-token');
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.billingMode).toBe('unified');
  });

  it('falls back to CF_API_TOKEN when CF_AIG_TOKEN is missing', async () => {
    const env = mockEnv({
      AI_PROXY_BILLING_MODE: 'unified',
      CF_API_TOKEN: 'my-api-token',
    });
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    const result = await resolveUpstreamAuth(env, db);

    expect(result.headers['cf-aig-authorization']).toBe('Bearer my-api-token');
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.billingMode).toBe('unified');
  });

  it('throws when unified mode is set but no CF token is available', async () => {
    const env = mockEnv({
      AI_PROXY_BILLING_MODE: 'unified',
    });
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    (env as Record<string, unknown>).CF_API_TOKEN = undefined;
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    await expect(resolveUpstreamAuth(env, db)).rejects.toThrow(
      'no CF token is configured',
    );
  });
});

// =============================================================================
// resolveUpstreamAuth — platform-key mode
// =============================================================================

describe('resolveUpstreamAuth — platform-key mode', () => {
  it('sets x-api-key header and does NOT set cf-aig-authorization', async () => {
    mockGetPlatformCred.mockResolvedValueOnce({
      credential: 'sk-ant-test-key',
      credentialKind: 'api-key',
    });

    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'platform-key' });
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    const result = await resolveUpstreamAuth(env, db);

    expect(result.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(result.headers['cf-aig-authorization']).toBeUndefined();
    expect(result.billingMode).toBe('platform-key');
  });

  it('throws when platform-key mode is set but no credential exists', async () => {
    mockGetPlatformCred.mockResolvedValueOnce(null);

    const env = mockEnv({ AI_PROXY_BILLING_MODE: 'platform-key' });
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    await expect(resolveUpstreamAuth(env, db)).rejects.toThrow(
      'No Anthropic API key configured',
    );
  });
});

// =============================================================================
// resolveUpstreamAuth — auto mode
// =============================================================================

describe('resolveUpstreamAuth — auto mode', () => {
  it('uses unified billing when CF_AIG_TOKEN is available', async () => {
    const env = mockEnv({ CF_AIG_TOKEN: 'auto-cf-token' });
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    const result = await resolveUpstreamAuth(env, db);

    expect(result.headers['cf-aig-authorization']).toBe('Bearer auto-cf-token');
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.billingMode).toBe('unified');
  });

  it('uses unified billing via CF_API_TOKEN when CF_AIG_TOKEN is absent', async () => {
    const env = mockEnv({ CF_API_TOKEN: 'auto-api-token' });
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    const result = await resolveUpstreamAuth(env, db);

    expect(result.headers['cf-aig-authorization']).toBe('Bearer auto-api-token');
    expect(result.headers['x-api-key']).toBeUndefined();
    expect(result.billingMode).toBe('unified');
  });

  it('falls back to platform key when no CF token is available', async () => {
    mockGetPlatformCred.mockResolvedValueOnce({
      credential: 'sk-ant-fallback-key',
      credentialKind: 'api-key',
    });

    const env = mockEnv();
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    (env as Record<string, unknown>).CF_API_TOKEN = undefined;
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    const result = await resolveUpstreamAuth(env, db);

    expect(result.headers['x-api-key']).toBe('sk-ant-fallback-key');
    expect(result.headers['cf-aig-authorization']).toBeUndefined();
    expect(result.billingMode).toBe('platform-key');
  });

  it('throws when no CF token and no platform credential are available', async () => {
    mockGetPlatformCred.mockResolvedValueOnce(null);

    const env = mockEnv();
    (env as Record<string, unknown>).CF_AIG_TOKEN = undefined;
    (env as Record<string, unknown>).CF_API_TOKEN = undefined;
    const db = {} as Parameters<typeof resolveUpstreamAuth>[1];

    await expect(resolveUpstreamAuth(env, db)).rejects.toThrow(
      'No Anthropic API key configured',
    );
  });
});
