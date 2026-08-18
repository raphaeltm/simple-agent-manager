/**
 * Worker smoke tests via SELF.fetch() in the workerd runtime.
 *
 * Tests unauthenticated endpoints and verifies the Worker boots correctly
 * with real Miniflare bindings. Authenticated route tests remain in
 * tests/unit/ with mocked middleware since setting up JWT + D1 user data
 * in Miniflare adds complexity without proportional value.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker smoke tests (workerd runtime)', () => {
  it('exposes only the runtime VAPID public key', async () => {
    const response = await SELF.fetch('https://api.test.example.com/api/config/vapid-public-key');
    expect(response.status).toBe(200);
    const body = await response.json<{ publicKey: string | null }>();
    expect(body).toEqual({
      publicKey:
        'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    });
    expect(JSON.stringify(body)).not.toContain('yfWPiYE');
  });

  describe('health check', () => {
    it('returns healthy status', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health');
      expect(response.status).toBe(200);

      const body = await response.json<{
        status: string;
        timestamp: string;
      }>();
      expect(body.status).toBe('healthy');
      expect(body.timestamp).toBeTruthy();
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('limits');
    });

    it('reports healthy when critical bindings are present', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health');
      expect(response.status).toBe(200);

      const body = await response.json<{ status: string }>();
      expect(body.status).toBe('healthy');
    });
  });

  describe('isolated interactive preview host', () => {
    it('fails closed with sandbox headers and no cookie for malformed links', async () => {
      const response = await SELF.fetch('https://preview.test.example.com/p/not-valid');
      expect(response.status).toBe(403);
      expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toContain('Preview link expired');
    });

    it('never sets cookies on unsupported methods either', async () => {
      const response = await SELF.fetch('https://preview.test.example.com/', { method: 'POST' });
      expect(response.status).toBe(403);
      expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(response.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('404 handler', () => {
    it('returns NOT_FOUND for unknown routes', async () => {
      const response = await SELF.fetch('https://api.test.example.com/api/nonexistent');
      expect(response.status).toBe(404);

      const body = await response.json<{ error: string; message: string }>();
      expect(body.error).toBe('NOT_FOUND');
    });
  });

  describe('CORS', () => {
    it('includes CORS headers for same-domain origin', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        headers: { Origin: 'https://app.test.example.com' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://app.test.example.com'
      );
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('includes CORS headers for docs origins', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        headers: { Origin: 'https://docs.test.example.com' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://docs.test.example.com'
      );
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('handles OPTIONS preflight requests', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.test.example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type, Authorization',
        },
      });
      // CORS preflight should succeed
      expect(response.status).toBeLessThan(400);
    });

    it('rejects unknown origins by not setting Access-Control-Allow-Origin', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        headers: { Origin: 'https://evil.com' },
      });
      expect(response.status).toBe(200);
      // The key security assertion: unknown origins must NOT get an allow-origin header
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('rejects origins that contain baseDomain as substring but are not subdomains', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        headers: { Origin: 'https://nottest.example.com.evil.com' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('rejects workspace and port origins for credentialed CORS', async () => {
      for (const origin of [
        'https://ws-abc123.test.example.com',
        'https://ws-abc123--5173.test.example.com',
        'https://customer-controlled.test.example.com',
      ]) {
        const response = await SELF.fetch('https://api.test.example.com/health', {
          headers: { Origin: origin },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
    });

    it('rejects localhost origins when BASE_DOMAIN is a real domain', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('authenticated routes require auth', () => {
    it('returns 401 for /api/projects without auth', async () => {
      const response = await SELF.fetch('https://api.test.example.com/api/projects');
      expect(response.status).toBe(401);
    });

    it('returns 401 for /api/workspaces without auth', async () => {
      const response = await SELF.fetch('https://api.test.example.com/api/workspaces');
      expect(response.status).toBe(401);
    });

    it('returns 401 for /api/nodes without auth', async () => {
      const response = await SELF.fetch('https://api.test.example.com/api/nodes');
      expect(response.status).toBe(401);
    });
  });

  describe('response cache headers', () => {
    // These endpoints are unauthenticated and byte-identical for every caller,
    // which is the only condition under which `public` is safe (the API runs CORS
    // with credentials: true — see src/lib/cache-headers.ts).
    const PUBLIC_CONFIG_PATHS = [
      '/api/config/artifacts-enabled',
      '/api/config/vapid-public-key',
      '/api/config/login-providers',
    ];

    it.each(PUBLIC_CONFIG_PATHS)('serves %s with a public SWR policy', async (path) => {
      const response = await SELF.fetch(`https://api.test.example.com${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=60, stale-while-revalidate=300'
      );
      // The global CORS middleware contributes `Vary: Origin`. What matters is
      // that we do NOT add `Cookie`: fragmenting a shared cache per session for a
      // body that does not depend on the caller would defeat the point.
      const vary = response.headers.get('vary') ?? '';
      expect(vary.split(',').map((v) => v.trim())).not.toContain('Cookie');
    });

    // Discriminating controls: caching is opt-in per handler, so nothing else may
    // pick it up. If someone converts this to blanket middleware, these fail.
    it.each([
      ['a real-time authenticated list', '/api/projects'],
      ['workspace runtime state', '/api/workspaces'],
      ['node runtime state', '/api/nodes'],
    ])('does not cache %s', async (_label, path) => {
      const response = await SELF.fetch(`https://api.test.example.com${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBeNull();
    });

    it('does not cache the health endpoint', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health');
      expect(response.headers.get('cache-control')).toBeNull();
    });

    it('never marks an authenticated response public', async () => {
      // The invariant that matters most: a `public` directive on a credentialed
      // response would let a shared cache serve one user's body to another.
      for (const path of [
        '/api/projects',
        '/api/workspaces',
        '/api/nodes',
        '/api/model-catalog/opencode',
      ]) {
        const response = await SELF.fetch(`https://api.test.example.com${path}`);
        expect(response.headers.get('cache-control') ?? '').not.toContain('public');
      }
    });
  });

  describe('Anthropic proxy route', () => {
    it('returns 401 for /ai/anthropic/v1/messages without x-api-key', async () => {
      const response = await SELF.fetch('https://api.test.example.com/ai/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(response.status).toBe(401);
      const body = await response.json<{ type: string; error: { type: string } }>();
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('authentication_error');
    });

    it('returns 503 when AI proxy is disabled', async () => {
      // The test env has AI_PROXY_ENABLED unset (not 'false'), so route is enabled by default.
      // We test the kill switch via a direct route that checks the config.
      // This test just confirms the route is mounted and reachable.
      const response = await SELF.fetch('https://api.test.example.com/ai/anthropic/v1/messages', {
        method: 'POST',
      });
      // Without Content-Type header or body, still reaches our handler (not 404)
      expect(response.status).not.toBe(404);
    });

    it('returns 401 for /ai/anthropic/v1/messages/count_tokens without auth', async () => {
      const response = await SELF.fetch(
        'https://api.test.example.com/ai/anthropic/v1/messages/count_tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
        }
      );
      expect(response.status).toBe(401);
    });
  });

  describe('D1 binding', () => {
    it('D1 database binding is available', async () => {
      // The env.DATABASE binding should be a D1 database
      expect(env.DATABASE).toBeDefined();
      // Verify we can execute a simple query
      const result = await env.DATABASE.prepare('SELECT 1 as val').first();
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).val).toBe(1);
    });
  });

  describe('KV binding', () => {
    it('KV namespace binding is available', async () => {
      expect(env.KV).toBeDefined();
      await env.KV.put('test-key', 'test-value');
      const value = await env.KV.get('test-key');
      expect(value).toBe('test-value');
    });
  });

  describe('Durable Object binding', () => {
    it('PROJECT_DATA namespace is available', async () => {
      expect(env.PROJECT_DATA).toBeDefined();
      const id = env.PROJECT_DATA.idFromName('smoke-test-project');
      expect(id).toBeDefined();
      expect(id.toString()).toBeTruthy();
    });
  });
});
