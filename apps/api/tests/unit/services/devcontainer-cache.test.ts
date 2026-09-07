import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildCloudflareDevcontainerCacheRef,
  getDevcontainerCacheCredentials,
} from '../../../src/services/devcontainer-cache';

function env(overrides: Partial<Env> = {}): Env {
  return {
    DEVCONTAINER_CACHE_ENABLED: 'true',
    CF_ACCOUNT_ID: 'acct-123',
    CF_API_TOKEN: 'cf-token',
    ...overrides,
  } as Env;
}

describe('devcontainer-cache service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when cache config is absent', async () => {
    const credentials = await getDevcontainerCacheCredentials(
      env({ DEVCONTAINER_CACHE_ENABLED: 'false' }),
      'octo/repo'
    );

    expect(credentials).toBeNull();
  });

  it('builds Cloudflare managed registry cache refs from repository metadata', () => {
    const ref = buildCloudflareDevcontainerCacheRef(
      'registry.cloudflare.com',
      'acct-123',
      'sam-',
      'https://github.com/Octo/Hello World.git',
      'node:20'
    );

    expect(ref).toBe('registry.cloudflare.com/acct-123/sam-octo-hello-world:devcontainer-cache-node-20');
  });

  it('mints short-lived pull and push credentials with configurable TTL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            registry_host: 'registry.cloudflare.com',
            username: 'user',
            password: 'secret-password',
          },
        }),
        { status: 200 }
      )
    );

    const credentials = await getDevcontainerCacheCredentials(
      env({
        DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID: 'cache-account',
        DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN: 'cache-token',
        DEVCONTAINER_CACHE_CREDENTIAL_EXPIRATION_MINUTES: '45',
      }),
      'octo/repo'
    );

    expect(credentials).toEqual({
      registry: 'registry.cloudflare.com',
      username: 'user',
      password: 'secret-password',
      ref: 'registry.cloudflare.com/cache-account/octo-repo:devcontainer-cache',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/cache-account/containers/registries/registry.cloudflare.com/credentials',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expiration_minutes: 45,
          permissions: ['pull', 'push'],
        }),
      })
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer cache-token');
  });

  it('rejects malformed credential responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { username: 'user' } }), { status: 200 })
    );

    await expect(getDevcontainerCacheCredentials(env(), 'octo/repo')).rejects.toThrow(
      'missing registry, username, or password'
    );
  });
});
