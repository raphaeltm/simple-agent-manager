import { beforeEach, describe, expect, it, vi } from 'vitest';

const jose = vi.hoisted(() => ({
  importPKCS8: vi.fn().mockResolvedValue('private-key'),
  sign: vi.fn().mockResolvedValue('app-jwt'),
}));

vi.mock('jose', () => ({
  importPKCS8: jose.importPKCS8,
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    sign = jose.sign;
  },
}));

vi.mock('../../../src/services/platform-config', () => ({
  getGitHubAppConfig: vi.fn().mockResolvedValue({
    appId: '123',
    privateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    slug: 'sam',
  }),
}));

import type { Env } from '../../../src/env';
import { getInstallationToken } from '../../../src/services/github-app';

function makeEnv(cached?: unknown): Partial<Env> {
  return {
    GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS: '99',
    KV: {
      get: vi.fn().mockResolvedValue(cached ?? null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getInstallationToken KV cache', () => {
  it('returns cached installation tokens without minting a new token', async () => {
    const env = makeEnv({ token: 'cached-token', expiresAt: '2026-08-19T01:00:00Z' });
    vi.stubGlobal('fetch', vi.fn());

    await expect(getInstallationToken('inst-1', env as Env)).resolves.toEqual({
      token: 'cached-token',
      expiresAt: '2026-08-19T01:00:00Z',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(jose.sign).not.toHaveBeenCalled();
  });

  it('mints and caches installation tokens on cache miss with the configured TTL', async () => {
    const env = makeEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ token: 'fresh-token', expires_at: '2026-08-19T01:00:00Z' })
      )
    );

    await expect(getInstallationToken('inst-1', env as Env)).resolves.toEqual({
      token: 'fresh-token',
      expiresAt: '2026-08-19T01:00:00Z',
    });

    expect(env.KV?.put).toHaveBeenCalledWith(
      'github-installation-token:v1:inst-1:default',
      JSON.stringify({ token: 'fresh-token', expiresAt: '2026-08-19T01:00:00Z' }),
      { expirationTtl: 99 }
    );
  });

  it('does not write installation tokens when the configured cache TTL is zero', async () => {
    const env = makeEnv();
    env.GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS = '0';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ token: 'fresh-token', expires_at: '2026-08-19T01:00:00Z' })
      )
    );

    await getInstallationToken('inst-1', env as Env);

    expect(env.KV?.put).not.toHaveBeenCalled();
  });
});
