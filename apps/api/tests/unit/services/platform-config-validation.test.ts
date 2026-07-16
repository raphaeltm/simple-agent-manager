import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { validatePlatformIntegrationInput } from '../../../src/services/platform-config-validation';

// GitLab-only inputs never trigger the GitHub/Google OAuth pings (those only
// fire when both a clientId AND clientSecret are present for that provider),
// so no fetch mocking is required here.
const env = { BASE_DOMAIN: 'example.com' } as Env;

describe('validatePlatformIntegrationInput — GitLab host', () => {
  it('accepts a plain https host', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: { host: 'https://gitlab.example.com' },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('accepts an https host with a trailing slash', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: { host: 'https://gitlab.example.com/' },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('allows http for localhost self-hosted development', async () => {
    for (const host of ['http://localhost:8080', 'http://127.0.0.1:8080']) {
      const result = await validatePlatformIntegrationInput(env, { gitlab: { host } });
      expect(result, host).toEqual({ ok: true, errors: [] });
    }
  });

  it('rejects http for non-localhost hosts', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: { host: 'http://gitlab.example.com' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('GitLab host must use HTTPS unless it points to localhost');
  });

  it('rejects a host containing a path', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: { host: 'https://gitlab.example.com/some/path' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'GitLab host must not include credentials, a path, query string, or fragment'
    );
  });

  it('rejects a host containing credentials, query, or fragment', async () => {
    for (const host of [
      'https://user:pass@gitlab.example.com',
      'https://gitlab.example.com/?x=1',
      'https://gitlab.example.com/#frag',
    ]) {
      const result = await validatePlatformIntegrationInput(env, { gitlab: { host } });
      expect(result.ok, host).toBe(false);
      expect(result.errors, host).toContain(
        'GitLab host must not include credentials, a path, query string, or fragment'
      );
    }
  });

  it('rejects a value that is not a URL', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: { host: 'not a url' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('GitLab host must be a valid URL');
  });
});

describe('validatePlatformIntegrationInput — GitLab client credentials', () => {
  it('rejects a too-short client id and secret', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: { clientId: 'abc', clientSecret: 'short' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('GitLab OAuth client id is too short');
    expect(result.errors).toContain('GitLab OAuth client secret is too short');
  });

  it('accepts a complete valid GitLab configuration', async () => {
    const result = await validatePlatformIntegrationInput(env, {
      gitlab: {
        host: 'https://gitlab.example.com',
        clientId: 'gitlab-client-id',
        clientSecret: 'gitlab-client-secret',
      },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });
});


afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validatePlatformIntegrationInput — Google infrastructure OAuth', () => {
  it('rejects half-configured and ambiguous removal payloads', async () => {
    await expect(validatePlatformIntegrationInput(env, {
      googleInfrastructure: { clientId: 'infra-client-id' },
    })).resolves.toMatchObject({
      ok: false,
      errors: ['Google infrastructure OAuth client id and secret must be provided together'],
    });

    const removal = await validatePlatformIntegrationInput(env, {
      googleInfrastructure: {
        remove: true,
        clientId: 'infra-client-id',
        clientSecret: 'infra-client-secret',
      },
    });
    expect(removal.ok).toBe(false);
    expect(removal.errors).toContain(
      'Google infrastructure OAuth removal cannot include replacement values',
    );
  });

  it('validates the pair against the static infrastructure callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(validatePlatformIntegrationInput(env, {
      googleInfrastructure: {
        clientId: 'infra-client-id',
        clientSecret: 'infra-client-secret',
      },
    })).resolves.toEqual({ ok: true, errors: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get('redirect_uri')).toBe('https://api.example.com/auth/google/callback');
  });
});
