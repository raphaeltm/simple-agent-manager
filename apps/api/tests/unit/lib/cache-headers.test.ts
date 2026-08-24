import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  applyCacheHeaders,
  type CacheHeaderEnv,
  type CachePolicyName,
  resolveCachePolicy,
} from '../../../src/lib/cache-headers';

const ALL_POLICIES: CachePolicyName[] = ['public-config', 'model-catalog', 'project-reference'];

/** Policies applied to endpoints that sit behind requireAuth(). */
const AUTHENTICATED_POLICIES: CachePolicyName[] = ['model-catalog', 'project-reference'];

function parseDirectives(header: string): Map<string, string | true> {
  return new Map(
    header.split(',').map((part) => {
      const [name, value] = part.trim().split('=');
      return [name.toLowerCase(), value ?? true] as const;
    })
  );
}

describe('resolveCachePolicy', () => {
  it('emits the shipped defaults for public config', () => {
    expect(resolveCachePolicy('public-config', {})).toEqual({
      cacheControl: 'public, max-age=60, stale-while-revalidate=300',
    });
  });

  it('emits the shipped defaults for the model catalog', () => {
    expect(resolveCachePolicy('model-catalog', {})).toEqual({
      cacheControl: 'private, max-age=60, stale-while-revalidate=300',
      vary: 'Cookie',
    });
  });

  it('emits always-revalidate SWR for per-user project reference data', () => {
    // max-age=0 means a user's own edit is masked for at most one request.
    expect(resolveCachePolicy('project-reference', {})).toEqual({
      cacheControl: 'private, max-age=0, stale-while-revalidate=30',
      vary: 'Cookie',
    });
  });

  describe('cross-tenant safety invariants', () => {
    it.each(AUTHENTICATED_POLICIES)('%s is never public', (policy) => {
      // The API runs CORS with credentials:true. A `public` directive on a
      // credentialed response lets a shared cache (CF edge, corporate proxy)
      // serve one user's body to another.
      const { cacheControl } = resolveCachePolicy(policy, {});
      expect(cacheControl).toMatch(/^private,/);
      expect(cacheControl).not.toContain('public');
    });

    it.each(AUTHENTICATED_POLICIES)('%s varies on Cookie', (policy) => {
      // `private` alone is not enough: the browser HTTP cache is keyed per
      // browser profile, not per login, so without Vary a second account in the
      // same browser could be served the first account's entry.
      expect(resolveCachePolicy(policy, {}).vary).toBe('Cookie');
    });

    it('stays private even when an operator tries to widen it via env', () => {
      // There is no env knob that can flip an authenticated policy to public —
      // the split is structural, not configuration.
      const hostile = {
        MODEL_CATALOG_CACHE_MAX_AGE_SECONDS: '86400',
        PROJECT_REFERENCE_CACHE_MAX_AGE_SECONDS: '86400',
      } satisfies CacheHeaderEnv;
      for (const policy of AUTHENTICATED_POLICIES) {
        expect(resolveCachePolicy(policy, hostile).cacheControl).toMatch(/^private,/);
      }
    });

    it.each(ALL_POLICIES)('%s never emits no-store or no-cache', (policy) => {
      // Guards against a future edit accidentally turning a cache policy into a
      // no-cache policy, which would silently remove the whole optimisation.
      const directives = parseDirectives(resolveCachePolicy(policy, {}).cacheControl);
      expect(directives.has('no-store')).toBe(false);
      expect(directives.has('no-cache')).toBe(false);
    });
  });

  describe('env overrides', () => {
    it('applies operator-supplied TTLs', () => {
      expect(
        resolveCachePolicy('public-config', {
          PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS: '15',
          PUBLIC_CONFIG_CACHE_SWR_SECONDS: '45',
        }).cacheControl
      ).toBe('public, max-age=15, stale-while-revalidate=45');
    });

    it('accepts 0 as a real value rather than treating it as unset', () => {
      // `0` is falsy — a naive `Number(raw) || fallback` would silently ignore an
      // operator explicitly disabling freshness.
      expect(
        resolveCachePolicy('model-catalog', {
          MODEL_CATALOG_CACHE_MAX_AGE_SECONDS: '0',
          MODEL_CATALOG_CACHE_SWR_SECONDS: '0',
        }).cacheControl
      ).toBe('private, max-age=0, stale-while-revalidate=0');
    });

    it('clamps an excessive value to 24h rather than caching indefinitely', () => {
      expect(
        resolveCachePolicy('public-config', {
          PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS: '99999999',
        }).cacheControl
      ).toContain('max-age=86400');
    });

    it.each([
      ['negative', '-1'],
      ['fractional', '30.5'],
      ['non-numeric', 'forever'],
      ['empty', '   '],
    ])('falls back to the default for a %s value', (_label, raw) => {
      // A fat-fingered env value must degrade to the shipped policy, never to
      // "cache forever".
      expect(
        resolveCachePolicy('public-config', { PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS: raw })
          .cacheControl
      ).toBe('public, max-age=60, stale-while-revalidate=300');
    });

    it('falls back to defaults when env is entirely absent', () => {
      expect(resolveCachePolicy('public-config', undefined).cacheControl).toBe(
        'public, max-age=60, stale-while-revalidate=300'
      );
    });
  });
});

describe('applyCacheHeaders', () => {
  function appFor(policy: CachePolicyName) {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/probe', (c) => {
      applyCacheHeaders(c, policy);
      return c.json({ ok: true });
    });
    return app;
  }

  it('sets Cache-Control and Vary on the real response', async () => {
    const res = await appFor('project-reference').request('/probe', {}, {} as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=0, stale-while-revalidate=30');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('omits Vary for public policies so shared caches are not fragmented', async () => {
    const res = await appFor('public-config').request('/probe', {}, {} as Env);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.headers.get('vary')).toBeNull();
  });

  it('coexists with the CORS Vary: Origin instead of clobbering it', async () => {
    // The global CORS middleware (src/index.ts) sets `Vary: Origin` AFTER the
    // handler runs. If it used `.set()` rather than `.append()`, it would silently
    // erase our `Vary: Cookie` and with it the cross-account protection — a change
    // that would leave every other test in this file green. Pin the real
    // interaction so a Hono upgrade cannot regress it unnoticed.
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', cors({ origin: () => 'https://app.example.com', credentials: true }));
    app.get('/probe', (c) => {
      applyCacheHeaders(c, 'project-reference');
      return c.json({ ok: true });
    });

    const res = await app.request(
      '/probe',
      { headers: { Origin: 'https://app.example.com' } },
      {} as Env
    );

    const vary = res.headers.get('vary') ?? '';
    const values = vary.split(',').map((v) => v.trim());
    expect(values).toContain('Cookie');
    expect(values).toContain('Origin');
  });

  it('honours env overrides through the Hono context', async () => {
    const res = await appFor('model-catalog').request('/probe', {}, {
      MODEL_CATALOG_CACHE_MAX_AGE_SECONDS: '5',
      MODEL_CATALOG_CACHE_SWR_SECONDS: '10',
    } as Env);
    expect(res.headers.get('cache-control')).toBe('private, max-age=5, stale-while-revalidate=10');
  });
});
