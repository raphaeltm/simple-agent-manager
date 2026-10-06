import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const CACHE_KEY = 'github-installation-token:v1:inst-1:default';
const MINTED_TOKEN = { token: 'fresh-token', expiresAt: '2026-08-19T01:00:00Z' };

function stubGitHubMint(): void {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ token: MINTED_TOKEN.token, expires_at: MINTED_TOKEN.expiresAt })
      )
  );
}

describe('getInstallationToken KV cache', () => {
  // The clock is frozen at 00:00Z. GitHub installation tokens live for one hour;
  // the default refresh margin is 5 minutes and any margin is capped at 30.
  it.each([
    {
      name: 'reuses a cached token outside the default refresh margin',
      expiresAt: '2026-08-19T01:00:00Z',
      margin: undefined,
      mints: false,
    },
    {
      name: 'refreshes a cached token that has already expired',
      expiresAt: '2026-08-18T23:59:00.000Z',
      margin: undefined,
      mints: true,
    },
    {
      name: 'refreshes a cached token inside the default refresh margin',
      expiresAt: '2026-08-19T00:04:59.000Z',
      margin: undefined,
      mints: true,
    },
    {
      name: 'honours a configured refresh margin',
      expiresAt: '2026-08-19T00:02:00.000Z',
      margin: '60',
      mints: false,
    },
    {
      // Uncapped, a margin of the full lifetime would mint on every exchange.
      name: 'caps an oversized refresh margin so cached tokens are still reused',
      expiresAt: '2026-08-19T00:40:00.000Z',
      margin: '3600',
      mints: false,
    },
    {
      name: 'still refreshes inside the capped refresh margin',
      expiresAt: '2026-08-19T00:29:00.000Z',
      margin: '3600',
      mints: true,
    },
  ])('$name', async ({ expiresAt, margin, mints }) => {
    const cached = { token: 'cached-token', expiresAt };
    const env = makeEnv(cached);
    env.GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS = margin;
    stubGitHubMint();

    await expect(getInstallationToken('inst-1', env as Env)).resolves.toEqual(
      mints ? MINTED_TOKEN : cached
    );

    expect(fetch).toHaveBeenCalledTimes(mints ? 1 : 0);
    expect(jose.sign).toHaveBeenCalledTimes(mints ? 1 : 0);
    expect(vi.mocked(env.KV!.put).mock.calls).toEqual(
      mints ? [[CACHE_KEY, JSON.stringify(MINTED_TOKEN), { expirationTtl: 99 }]] : []
    );
  });

  it('mints and caches installation tokens on cache miss with the configured TTL', async () => {
    const env = makeEnv();
    stubGitHubMint();

    await expect(getInstallationToken('inst-1', env as Env)).resolves.toEqual(MINTED_TOKEN);

    expect(env.KV?.put).toHaveBeenCalledWith(CACHE_KEY, JSON.stringify(MINTED_TOKEN), {
      expirationTtl: 99,
    });
  });

  it('does not write installation tokens when the configured cache TTL is zero', async () => {
    const env = makeEnv();
    env.GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS = '0';
    stubGitHubMint();

    await getInstallationToken('inst-1', env as Env);

    expect(env.KV?.put).not.toHaveBeenCalled();
  });
});
