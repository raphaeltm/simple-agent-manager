/**
 * Self-hosted (celld) deployments bind the apps/web build as `ASSETS` and serve
 * app.${BASE_DOMAIN} from it; Cloudflare deployments have no ASSETS binding and proxy
 * app.* to Pages. These tests drive the real Worker entry (`src/index.ts` default export)
 * through the real middleware chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePagesProxyTarget } from '../../src/lib/pages-proxy';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }), {
  virtual: true,
});
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  switchPort: vi.fn((request: Request) => request),
}));

const worker = await import('../../src/index');

const BASE_DOMAIN = 'sam.example.com';
const WORKSPACE_ID = '01kr1000000000000000000001';

function assetsBinding() {
  return {
    fetch: vi.fn(
      async (request: Request) =>
        new Response(`spa:${new URL(request.url).pathname}`, {
          status: 200,
          headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' },
        })
    ),
  };
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

function call(url: string, env: Record<string, unknown>, init?: RequestInit) {
  return worker.default.fetch(new Request(url, init), env as never, ctx);
}

describe('web UI host dispatch', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('from-pages', { status: 200 }))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('with an ASSETS binding (self-hosted)', () => {
    it('serves app.${BASE_DOMAIN} deep links from ASSETS and never calls Pages', async () => {
      const ASSETS = assetsBinding();
      const response = await call(`https://app.${BASE_DOMAIN}/projects/abc/chat`, {
        BASE_DOMAIN,
        ASSETS,
        PAGES_PROJECT_NAME: 'would-be-ignored',
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('spa:/projects/abc/chat');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(ASSETS.fetch).toHaveBeenCalledTimes(1);
      expect(ASSETS.fetch.mock.calls[0]![0].url).toBe(
        `https://app.${BASE_DOMAIN}/projects/abc/chat`
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('keeps api.${BASE_DOMAIN} on the Worker', async () => {
      const ASSETS = assetsBinding();
      const response = await call(`https://api.${BASE_DOMAIN}/index.html`, { BASE_DOMAIN, ASSETS });

      expect(ASSETS.fetch).not.toHaveBeenCalled();
      // The Worker's own 404, not the SPA shell.
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'NOT_FOUND' });
    });

    it('keeps ws-* hosts on the workspace proxy', async () => {
      const ASSETS = assetsBinding();
      const response = await call(`https://ws-${WORKSPACE_ID}.${BASE_DOMAIN}/index.html`, {
        BASE_DOMAIN,
        ASSETS,
        DATABASE: {},
      });

      expect(ASSETS.fetch).not.toHaveBeenCalled();
      // Reached the workspace proxy (which fails here on the unmocked auth stack), not the SPA.
      const body = await response.text();
      expect(body).not.toContain('spa:');
      expect(response.headers.get('content-type')).toContain('application/json');
    });
  });

  describe('without an ASSETS binding (Cloudflare)', () => {
    it('proxies app.${BASE_DOMAIN} to the Pages project exactly as before', async () => {
      const response = await call(`https://app.${BASE_DOMAIN}/projects/abc/chat`, {
        BASE_DOMAIN,
        PAGES_PROJECT_NAME: 'sam-web-prod',
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('from-pages');
      const pagesRequest = vi.mocked(globalThis.fetch).mock.calls[0]![0] as Request;
      expect(new URL(pagesRequest.url).hostname).toBe('sam-web-prod.pages.dev');
      expect(new URL(pagesRequest.url).pathname).toBe('/projects/abc/chat');
    });

    it('still fails visibly when the Pages project is not configured', async () => {
      const response = await call(`https://app.${BASE_DOMAIN}/`, { BASE_DOMAIN });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('PAGES_PROJECT_NAME is not configured');
    });
  });
});

describe('resolvePagesProxyTarget with web assets', () => {
  it('routes only the app host to assets', () => {
    const config = { baseDomain: BASE_DOMAIN, hasWebAssets: true, wwwPagesProjectName: 'www' };
    expect(resolvePagesProxyTarget(`app.${BASE_DOMAIN}`, config)).toEqual({ type: 'assets' });
    expect(resolvePagesProxyTarget(`api.${BASE_DOMAIN}`, config)).toEqual({ type: 'none' });
    expect(resolvePagesProxyTarget(`www.${BASE_DOMAIN}`, config)).toEqual({
      type: 'proxy',
      hostname: 'www.pages.dev',
    });
  });

  it('is unchanged when hasWebAssets is false or absent', () => {
    for (const hasWebAssets of [false, undefined]) {
      expect(
        resolvePagesProxyTarget(`app.${BASE_DOMAIN}`, {
          baseDomain: BASE_DOMAIN,
          appPagesProjectName: 'p',
          hasWebAssets,
        })
      ).toEqual({ type: 'proxy', hostname: 'p.pages.dev' });
    }
  });
});
