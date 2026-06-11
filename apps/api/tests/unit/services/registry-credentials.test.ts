import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildProjectNamespace,
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
    ...overrides,
  } as Env;
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
      'acct-123/sam-proj-name-with-special',
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

    const result = await mintProjectRegistryCredential(
      makeEnv(),
      'my-project',
      'user-1',
      'task-1',
    );

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
      'task-1',
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
      mintProjectRegistryCredential(makeEnv(), 'proj', 'user-1', 'task-1'),
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
    mockMintCredentials.mockRejectedValue(new Error('Cloudflare registry credential mint failed: rate limited'));

    await expect(
      mintProjectRegistryCredential(makeEnv(), 'proj', 'user-1', 'task-1'),
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
      'task-1',
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
      }),
    );
    expect(limit.maxRequests).toBe(5);
    expect(limit.windowSeconds).toBe(120);
  });

  it('falls back to defaults for invalid env values', () => {
    const limit = getRegistryCredentialRateLimit(
      makeEnv({
        REGISTRY_CREDENTIAL_RATE_LIMIT: 'not-a-number',
        REGISTRY_CREDENTIAL_RATE_WINDOW_SECONDS: '-1',
      }),
    );
    expect(limit.maxRequests).toBe(10);
    expect(limit.windowSeconds).toBe(300);
  });
});
