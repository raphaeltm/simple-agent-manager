import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildProjectNamespace,
  consumeRegistryCredentialRateLimit,
  getRegistryCredentialRateLimit,
  mintProjectRegistryCredential,
} from '../../../src/services/registry-credentials';

// Mock the cf-registry module to avoid real HTTP calls
vi.mock('../../../src/services/cf-registry', () => ({
  DEFAULT_CLOUDFLARE_REGISTRY_HOST: 'registry.cloudflare.com',
  buildMintConfigFromEnv: vi.fn(),
  mintCloudflareRegistryCredentials: vi.fn(),
}));

import {
  buildMintConfigFromEnv,
  mintCloudflareRegistryCredentials,
} from '../../../src/services/cf-registry';

const mockBuildMintConfig = vi.mocked(buildMintConfigFromEnv);
const mockMintCredentials = vi.mocked(mintCloudflareRegistryCredentials);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_ACCOUNT_ID: 'acct-123',
    CF_API_TOKEN: 'tok-secret',
    DATABASE: makeRateLimitDb({ request_count: 1 }).db,
    ...overrides,
  } as Env;
}

function makeRateLimitDb(returnedRow: { request_count: number } | null) {
  const upsertBinds: unknown[][] = [];
  const cleanupBinds: unknown[][] = [];
  const first = vi.fn(async () => returnedRow);
  const run = vi.fn(async () => ({ success: true, meta: { changes: 0 } }));
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('INSERT INTO registry_credential_rate_limits')) {
      return {
        bind: vi.fn((...args: unknown[]) => {
          upsertBinds.push(args);
          return { first };
        }),
      };
    }
    return {
      bind: vi.fn((...args: unknown[]) => {
        cleanupBinds.push(args);
        return { run };
      }),
    };
  });
  return { db: { prepare }, prepare, first, run, upsertBinds, cleanupBinds };
}

describe('buildProjectNamespace', () => {
  it('builds namespace with account ID and sanitized project ID', () => {
    expect(buildProjectNamespace('acct-123', 'my-project')).toBe('acct-123/sam-my-project');
  });

  it('lowercases the project ID', () => {
    expect(buildProjectNamespace('acct-123', 'My-Project')).toBe('acct-123/sam-my-project');
  });

  it('replaces non-alphanumeric characters with hyphens', () => {
    expect(buildProjectNamespace('acct-123', 'proj@name!with#special')).toBe(
      'acct-123/sam-proj-name-with-special'
    );
  });

  it('preserves hyphens and digits', () => {
    expect(buildProjectNamespace('acct-123', 'proj-42-test')).toBe('acct-123/sam-proj-42-test');
  });

  it('handles empty project ID', () => {
    expect(buildProjectNamespace('acct-123', '')).toBe('acct-123/sam-');
  });
});

describe('mintProjectRegistryCredential', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('mints credential and returns result with namespace and expiry', async () => {
    mockBuildMintConfig.mockReturnValue({
      accountId: 'acct-123',
      apiToken: 'tok-secret',
      registryHost: 'registry.cloudflare.com',
      expirationMinutes: 60,
      permissions: ['pull', 'push'],
      timeoutMs: 10_000,
    });
    mockMintCredentials.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'cf-user',
      password: 'cf-pass',
    });

    const result = await mintProjectRegistryCredential(makeEnv(), 'my-project', 'user-1', 'task-1');

    expect(result.registry).toBe('registry.cloudflare.com');
    expect(result.username).toBe('cf-user');
    expect(result.password).toBe('cf-pass');
    expect(result.namespace).toBe('acct-123/sam-my-project');
    expect(result.expiresAt).toBeDefined();
    // Expiry should be roughly 60 minutes from now
    const expiresAt = new Date(result.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAt).toBeGreaterThan(now + 59 * 60_000);
    expect(expiresAt).toBeLessThan(now + 61 * 60_000);
  });

  it('passes configured expiration minutes to mint config', async () => {
    mockBuildMintConfig.mockReturnValue({
      accountId: 'acct-123',
      apiToken: 'tok-secret',
      registryHost: 'registry.cloudflare.com',
      expirationMinutes: 30,
      permissions: ['pull', 'push'],
      timeoutMs: 10_000,
    });
    mockMintCredentials.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'u',
      password: 'p',
    });

    const result = await mintProjectRegistryCredential(
      makeEnv({ REGISTRY_CREDENTIAL_EXPIRATION_MINUTES: '30' }),
      'proj',
      'user-1',
      'task-1'
    );

    // Expiry should reflect 30 min TTL
    const expiresAt = new Date(result.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAt).toBeGreaterThan(now + 29 * 60_000);
    expect(expiresAt).toBeLessThan(now + 31 * 60_000);
  });

  it('throws when mint config is unavailable (missing CF credentials)', async () => {
    mockBuildMintConfig.mockReturnValue(null);

    await expect(
      mintProjectRegistryCredential(makeEnv(), 'proj', 'user-1', 'task-1')
    ).rejects.toThrow('CF_ACCOUNT_ID and CF_API_TOKEN must be configured');
  });

  it('propagates errors from the CF mint API', async () => {
    mockBuildMintConfig.mockReturnValue({
      accountId: 'acct-123',
      apiToken: 'tok',
      registryHost: 'registry.cloudflare.com',
      expirationMinutes: 60,
      permissions: ['pull', 'push'],
      timeoutMs: 10_000,
    });
    mockMintCredentials.mockRejectedValue(
      new Error('Cloudflare registry credential mint failed: rate limited')
    );

    await expect(
      mintProjectRegistryCredential(makeEnv(), 'proj', 'user-1', 'task-1')
    ).rejects.toThrow('rate limited');
  });

  it('does not include credential values in the audit log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    mockBuildMintConfig.mockReturnValue({
      accountId: 'acct-123',
      apiToken: 'tok',
      registryHost: 'registry.cloudflare.com',
      expirationMinutes: 60,
      permissions: ['pull', 'push'],
      timeoutMs: 10_000,
    });
    mockMintCredentials.mockResolvedValue({
      registry: 'registry.cloudflare.com',
      username: 'secret-user',
      password: 'secret-pass',
    });

    await mintProjectRegistryCredential(makeEnv(), 'proj', 'user-1', 'task-1');

    // Verify no console output contains credential values
    const allCalls = [...logSpy.mock.calls, ...infoSpy.mock.calls];
    for (const call of allCalls) {
      const output = JSON.stringify(call);
      expect(output).not.toContain('secret-user');
      expect(output).not.toContain('secret-pass');
    }

    logSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('uses custom registry host from env', async () => {
    mockBuildMintConfig.mockReturnValue({
      accountId: 'acct-123',
      apiToken: 'tok',
      registryHost: 'custom.registry.io',
      expirationMinutes: 60,
      permissions: ['pull', 'push'],
      timeoutMs: 10_000,
    });
    mockMintCredentials.mockResolvedValue({
      registry: 'custom.registry.io',
      username: 'u',
      password: 'p',
    });

    const result = await mintProjectRegistryCredential(
      makeEnv({ REGISTRY_HOST: 'custom.registry.io' }),
      'proj',
      'user-1',
      'task-1'
    );

    expect(result.registry).toBe('custom.registry.io');
  });
});

describe('getRegistryCredentialRateLimit', () => {
  it('returns defaults when env vars are not set', () => {
    const limit = getRegistryCredentialRateLimit(makeEnv());
    expect(limit.maxRequests).toBe(10);
    expect(limit.windowSeconds).toBe(300);
  });

  it('uses env var overrides', () => {
    const limit = getRegistryCredentialRateLimit(
      makeEnv({
        REGISTRY_CREDENTIAL_RATE_LIMIT: '5',
        REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS: '120',
      })
    );
    expect(limit.maxRequests).toBe(5);
    expect(limit.windowSeconds).toBe(120);
  });

  it('falls back to defaults for invalid env values', () => {
    const limit = getRegistryCredentialRateLimit(
      makeEnv({
        REGISTRY_CREDENTIAL_RATE_LIMIT: 'not-a-number',
        REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS: '-1',
      })
    );
    expect(limit.maxRequests).toBe(10);
    expect(limit.windowSeconds).toBe(300);
  });
});

describe('consumeRegistryCredentialRateLimit', () => {
  it('consumes one quota slot with an atomic D1 upsert', async () => {
    const db = makeRateLimitDb({ request_count: 2 });
    const env = makeEnv({
      DATABASE: db.db as unknown as D1Database,
      REGISTRY_CREDENTIAL_RATE_LIMIT: '5',
      REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS: '120',
    });
    const nowMs = Date.UTC(2026, 5, 21, 12, 3, 45);

    const result = await consumeRegistryCredentialRateLimit(env, 'proj-1', nowMs);

    expect(result).toMatchObject({
      allowed: true,
      maxRequests: 5,
      windowSeconds: 120,
      count: 2,
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT(rate_key)'));
    expect(db.upsertBinds[0]).toEqual([
      'registry-cred-rate:proj-1:1782043320',
      'proj-1',
      1782043320,
      '2026-06-21T12:05:00.000Z',
      '2026-06-21T12:03:45.000Z',
      5,
    ]);
    expect(db.cleanupBinds[0]).toEqual(['2026-06-21T12:03:45.000Z']);
  });

  it('returns a denied result when the guarded upsert returns no row', async () => {
    const db = makeRateLimitDb(null);
    const env = makeEnv({ DATABASE: db.db as unknown as D1Database });

    const result = await consumeRegistryCredentialRateLimit(
      env,
      'proj-1',
      Date.UTC(2026, 5, 21, 12, 0, 0)
    );

    expect(result.allowed).toBe(false);
    expect(result.count).toBeNull();
    expect(result.maxRequests).toBe(10);
    expect(result.windowSeconds).toBe(300);
  });
});
