import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMintConfigFromEnv,
  type CloudflareRegistryMintConfig,
  DEFAULT_CLOUDFLARE_REGISTRY_HOST,
  mintCloudflareRegistryCredentials,
} from '../../../src/services/cf-registry';

function makeConfig(overrides: Partial<CloudflareRegistryMintConfig> = {}): CloudflareRegistryMintConfig {
  return {
    accountId: 'acct-123',
    apiToken: 'tok-secret',
    registryHost: 'registry.cloudflare.com',
    expirationMinutes: 60,
    permissions: ['pull', 'push'],
    timeoutMs: 10_000,
    ...overrides,
  };
}

function mockMintResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        registry_host: 'registry.cloudflare.com',
        username: 'cf-user',
        password: 'cf-pass',
        ...overrides,
      },
    }),
    { status: 200 },
  );
}

describe('mintCloudflareRegistryCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the correct CF API endpoint with auth and body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockMintResponse());
    const config = makeConfig({ accountId: 'my-acct', expirationMinutes: 30 });

    await mintCloudflareRegistryCredentials(config);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { signal?: AbortSignal }];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/my-acct/containers/registries/registry.cloudflare.com/credentials',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      expiration_minutes: 30,
      permissions: ['pull', 'push'],
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-secret');
  });

  it('returns registry, username, and password from CF API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockMintResponse());

    const result = await mintCloudflareRegistryCredentials(makeConfig());

    expect(result).toEqual({
      registry: 'registry.cloudflare.com',
      username: 'cf-user',
      password: 'cf-pass',
    });
  });

  it('throws on non-200 HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'unauthorized' }] }), { status: 403 }),
    );

    await expect(mintCloudflareRegistryCredentials(makeConfig())).rejects.toThrow(
      'Cloudflare registry credential mint failed: unauthorized',
    );
  });

  it('throws on 200 with empty result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: null }), { status: 200 }),
    );

    await expect(mintCloudflareRegistryCredentials(makeConfig())).rejects.toThrow(
      'Cloudflare registry credential mint failed',
    );
  });

  it('throws when response is missing username', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockMintResponse({ username: '', password: 'pass' }),
    );

    await expect(mintCloudflareRegistryCredentials(makeConfig())).rejects.toThrow(
      'missing registry, username, or password',
    );
  });

  it('throws when response is missing password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockMintResponse({ password: '' }),
    );

    await expect(mintCloudflareRegistryCredentials(makeConfig())).rejects.toThrow(
      'missing registry, username, or password',
    );
  });

  it('falls back to config registryHost when response omits registry_host', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockMintResponse({ registry_host: undefined }),
    );

    const result = await mintCloudflareRegistryCredentials(
      makeConfig({ registryHost: 'custom-registry.example.com' }),
    );

    expect(result.registry).toBe('custom-registry.example.com');
  });
});

describe('buildMintConfigFromEnv', () => {
  it('returns null when CF_ACCOUNT_ID is missing', () => {
    expect(buildMintConfigFromEnv({ CF_API_TOKEN: 'tok' })).toBeNull();
  });

  it('returns null when CF_API_TOKEN is missing', () => {
    expect(buildMintConfigFromEnv({ CF_ACCOUNT_ID: 'acct' })).toBeNull();
  });

  it('returns null when both are empty strings', () => {
    expect(buildMintConfigFromEnv({ CF_ACCOUNT_ID: '', CF_API_TOKEN: '' })).toBeNull();
  });

  it('builds config with defaults when no overrides provided', () => {
    const config = buildMintConfigFromEnv({
      CF_ACCOUNT_ID: 'acct-x',
      CF_API_TOKEN: 'tok-x',
    });

    expect(config).toEqual({
      accountId: 'acct-x',
      apiToken: 'tok-x',
      registryHost: DEFAULT_CLOUDFLARE_REGISTRY_HOST,
      expirationMinutes: 60,
      permissions: ['pull', 'push'],
      timeoutMs: expect.any(Number),
    });
  });

  it('applies overrides when provided', () => {
    const config = buildMintConfigFromEnv(
      { CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' },
      {
        registryHost: 'custom.registry.io',
        expirationMinutes: 15,
        permissions: ['pull'],
      },
    );

    expect(config?.registryHost).toBe('custom.registry.io');
    expect(config?.expirationMinutes).toBe(15);
    expect(config?.permissions).toEqual(['pull']);
  });

  it('trims whitespace from account ID and token', () => {
    const config = buildMintConfigFromEnv({
      CF_ACCOUNT_ID: '  acct  ',
      CF_API_TOKEN: '  tok  ',
    });

    expect(config?.accountId).toBe('acct');
    expect(config?.apiToken).toBe('tok');
  });
});
