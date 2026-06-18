import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getJWKS, getOidcDiscovery } = vi.hoisted(() => ({
  getJWKS: vi.fn(),
  getOidcDiscovery: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}), { virtual: true });

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {},
}));

vi.mock('../../../src/services/jwt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/jwt')>();
  return {
    ...actual,
    getJWKS,
    getOidcDiscovery,
  };
});

const { createApiApp } = await import('../../../src/app/create-api-app');

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    BASE_DOMAIN: 'example.com',
    DATABASE: {},
    KV: {},
    PROJECT_DATA: {},
    NODE_LIFECYCLE: {},
    TASK_RUNNER: {},
    ...overrides,
  };
}

describe('createApiApp composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJWKS.mockResolvedValue({ keys: [{ kid: 'test-key' }] });
    getOidcDiscovery.mockReturnValue({ issuer: 'https://api.example.com' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('pages')));
  });

  it('registers well-known endpoints with cache and nosniff headers', async () => {
    const app = createApiApp();

    const jwks = await app.request('/.well-known/jwks.json', {}, makeEnv());
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(jwks.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await jwks.json()).toEqual({ keys: [{ kid: 'test-key' }] });

    const discovery = await app.request('/.well-known/openid-configuration', {}, makeEnv());
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ issuer: 'https://api.example.com' });
  });

  it('preserves the API 404 response shape', async () => {
    const app = createApiApp();

    const res = await app.request('/api/does-not-exist', {}, makeEnv());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'NOT_FOUND',
      message: 'Endpoint not found',
    });
  });

  it('keeps browser API CORS credentialed and domain-scoped', async () => {
    const app = createApiApp();

    const res = await app.request('/api/does-not-exist', {
      headers: { Origin: 'https://app.example.com' },
    }, makeEnv());

    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('keeps MCP CORS open for bearer-token clients without credentials', async () => {
    const app = createApiApp();

    const res = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://random-client.example',
        'Access-Control-Request-Method': 'POST',
      },
    }, makeEnv());

    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('passes normal API hosts through proxy middleware and intercepts Pages hosts', async () => {
    const app = createApiApp();

    const apiRes = await app.request('https://api.example.com/health', {}, makeEnv());
    expect(apiRes.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();

    const pagesRes = await app.request('https://app.example.com/', {}, makeEnv());
    expect(await pagesRes.text()).toBe('pages');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
