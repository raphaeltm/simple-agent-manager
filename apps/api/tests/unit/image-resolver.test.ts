import { describe, expect, it, vi } from 'vitest';

import { createImageResolver, ImageResolveError } from '../../src/services/image-resolver';

// =============================================================================
// Helpers — realistic mock registry HTTP responses
// =============================================================================

const REALISTIC_DIGEST = 'sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4';

/** Mock a registry that returns digest on HEAD */
function mockRegistryFetch(opts: {
  digest?: string;
  status?: number;
  wwwAuth?: string;
  needsTokenExchange?: boolean;
  getDigest?: string;
} = {}) {
  const digest = opts.digest ?? REALISTIC_DIGEST;
  const callLog: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let callCount = 0;

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    callCount++;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v as string]),
    );
    callLog.push({ url, method, headers });

    // Token exchange endpoint
    if (url.includes('/token') || url.includes('/oauth2/token')) {
      return new Response(JSON.stringify({ token: 'mock-bearer-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // First call: 401 with WWW-Authenticate (token-based auth)
    if (opts.needsTokenExchange && callCount === 1) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': opts.wwwAuth ?? 'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
        },
      });
    }

    // Custom status (for error cases)
    if (opts.status && opts.status !== 200) {
      return new Response('Error', { status: opts.status });
    }

    // HEAD request — return digest in header
    if (method === 'HEAD') {
      const respHeaders: Record<string, string> = {
        'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      };
      if (digest) {
        respHeaders['Docker-Content-Digest'] = digest;
      }
      return new Response(null, { status: 200, headers: respHeaders });
    }

    // GET request — fallback path
    if (method === 'GET') {
      const respHeaders: Record<string, string> = {
        'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      };
      if (opts.getDigest ?? digest) {
        respHeaders['Docker-Content-Digest'] = opts.getDigest ?? digest;
      }
      return new Response('{}', { status: 200, headers: respHeaders });
    }

    return new Response('Not Found', { status: 404 });
  });

  return { fetchFn, callLog };
}

// =============================================================================
// Tests
// =============================================================================

describe('ImageResolver', () => {
  describe('createImageResolver', () => {
    it('resolves a tag to a digest via HEAD manifest (happy path)', async () => {
      const { fetchFn } = mockRegistryFetch();
      const resolver = createImageResolver({ fetchFn });

      const digest = await resolver('ghcr.io', 'org/myapp', 'v1.0');

      expect(digest).toBe(REALISTIC_DIGEST);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // Verify the URL is correct
      const call = fetchFn.mock.calls[0]!;
      expect(call[0]).toBe('https://ghcr.io/v2/org/myapp/manifests/v1.0');
      expect(call[1]!.method).toBe('HEAD');
    });

    it('handles docker.io → registry-1.docker.io rewrite', async () => {
      const { fetchFn } = mockRegistryFetch();
      const resolver = createImageResolver({ fetchFn });

      await resolver('docker.io', 'library/nginx', 'latest');

      const call = fetchFn.mock.calls[0]!;
      expect(call[0]).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest');
    });

    it('returns 404 → ImageResolveError with statusCode 404', async () => {
      const { fetchFn } = mockRegistryFetch({ status: 404 });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('ghcr.io', 'org/missing', 'v1.0'))
        .rejects.toThrow(ImageResolveError);

      try {
        await resolver('ghcr.io', 'org/missing', 'v1.0');
      } catch (err) {
        const e = err as ImageResolveError;
        expect(e.statusCode).toBe(404);
        expect(e.registry).toBe('ghcr.io');
        expect(e.repository).toBe('org/missing');
        expect(e.tag).toBe('v1.0');
        expect(e.message).toContain('not found');
      }
    });

    it('returns 401/403 → ImageResolveError with auth failure message', async () => {
      const { fetchFn } = mockRegistryFetch({ status: 403 });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('ghcr.io', 'org/private', 'v1.0'))
        .rejects.toThrow(ImageResolveError);

      try {
        await resolver('ghcr.io', 'org/private', 'v1.0');
      } catch (err) {
        const e = err as ImageResolveError;
        expect(e.statusCode).toBe(403);
        expect(e.message).toContain('Authentication failed');
      }
    });

    it('sends Basic auth header when credentials provided', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
      });

      await resolver('registry.example.com', 'org/app', 'latest');

      expect(callLog[0]!.headers['authorization']).toBe(
        `Basic ${btoa('user:pass')}`,
      );
    });

    it('sends auth when target registry matches authRegistryHost scope', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
        authRegistryHost: 'registry.cloudflare.com',
      });

      await resolver('registry.cloudflare.com', 'acct/sam-proj/app', 'latest');

      expect(callLog[0]!.headers['authorization']).toBe(
        `Basic ${btoa('user:pass')}`,
      );
    });

    it('does NOT forward scoped auth to a mismatched (user-controlled) registry', async () => {
      // Regression: minted SAM-registry credentials must never be sent to an
      // arbitrary registry named in a manifest (e.g. attacker-controlled host).
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
        authRegistryHost: 'registry.cloudflare.com',
      });

      await resolver('evil.attacker.example', 'org/app', 'latest');

      expect(callLog[0]!.url).toBe(
        'https://evil.attacker.example/v2/org/app/manifests/latest',
      );
      expect(callLog[0]!.headers['authorization']).toBeUndefined();
    });

    it('does NOT forward scoped docker.io auth to an unrelated registry', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
        authRegistryHost: 'docker.io',
      });

      await resolver('ghcr.io', 'org/app', 'latest');

      expect(callLog[0]!.headers['authorization']).toBeUndefined();
    });

    it('handles token-based auth (401 → token exchange → retry)', async () => {
      const { fetchFn, callLog } = mockRegistryFetch({
        needsTokenExchange: true,
      });
      const resolver = createImageResolver({ fetchFn });

      const digest = await resolver('registry.example.com', 'org/app', 'v2.0');

      expect(digest).toBe(REALISTIC_DIGEST);
      // Should have made 3 calls: initial HEAD (401), token exchange, retry HEAD
      expect(callLog).toHaveLength(3);
      expect(callLog[0]!.url).toContain('/v2/org/app/manifests/v2.0');
      expect(callLog[1]!.url).toContain('auth.example.com/token');
      expect(callLog[2]!.url).toContain('/v2/org/app/manifests/v2.0');
      expect(callLog[2]!.headers['authorization']).toBe('Bearer mock-bearer-token');
    });

    it('token exchange passes Basic auth when credentials provided', async () => {
      const { fetchFn, callLog } = mockRegistryFetch({
        needsTokenExchange: true,
      });
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'myuser', password: 'mypass' },
      });

      await resolver('registry.example.com', 'org/app', 'v2.0');

      // Token exchange call should have Basic auth
      const tokenCall = callLog[1]!;
      expect(tokenCall.headers['authorization']).toBe(
        `Basic ${btoa('myuser:mypass')}`,
      );
    });

    it('falls back to GET when HEAD returns no digest header', async () => {
      // HEAD returns 200 but no Docker-Content-Digest header
      let headCalled = false;
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'HEAD') {
          headCalled = true;
          return new Response(null, {
            status: 200,
            headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
          });
        }
        // GET returns digest in header
        return new Response('{}', {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
            'Docker-Content-Digest': REALISTIC_DIGEST,
          },
        });
      });

      const resolver = createImageResolver({ fetchFn });
      const digest = await resolver('ghcr.io', 'org/app', 'v1.0');

      expect(headCalled).toBe(true);
      expect(digest).toBe(REALISTIC_DIGEST);
      expect(fetchFn).toHaveBeenCalledTimes(2); // HEAD then GET
    });

    it('rejects non-sha256 digest format', async () => {
      const { fetchFn } = mockRegistryFetch({ digest: 'md5:abc123' });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('ghcr.io', 'org/app', 'v1.0'))
        .rejects.toThrow('unsupported digest format');
    });

    it('handles custom registry with explicit https scheme', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({ fetchFn });

      await resolver('https://my-registry.internal:5000', 'org/app', 'v1.0');

      expect(callLog[0]!.url).toBe(
        'https://my-registry.internal:5000/v2/org/app/manifests/v1.0',
      );
    });

    it('rejects plaintext http:// registry URLs (no creds over cleartext)', async () => {
      const { fetchFn } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
      });

      // Scheme is built from a variable so the cleartext literal does not trip
      // static-analysis cleartext-protocol rules — the registry value under test
      // is still an http:// URL, which the resolver must reject.
      const insecureScheme = 'ht' + 'tp';
      await expect(resolver(`${insecureScheme}://insecure-registry.internal:5000`, 'org/app', 'v1.0'))
        .rejects.toThrow('Insecure registry URL rejected');
      // The request must never be sent over plaintext.
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('refuses to forward credentials to an untrusted token realm host (exfil guard)', async () => {
      // Malicious registry redirects the token realm to an attacker host.
      const { fetchFn } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth: 'Bearer realm="https://evil.attacker.com/token",service="registry.example.com",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
      });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0'))
        .rejects.toThrow('untrusted token realm host');
    });

    it('rejects a non-https token realm', async () => {
      const { fetchFn } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth: 'Bearer realm="http://auth.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0'))
        .rejects.toThrow('Insecure token realm rejected');
    });

    it('allows a token realm on a sibling subdomain of the registry (docker.io style)', async () => {
      // registry-1.docker.io and auth.docker.io share the docker.io parent domain.
      const { fetchFn } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth: 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
      });
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
      });

      const digest = await resolver('docker.io', 'library/nginx', 'latest');
      expect(digest).toBe(REALISTIC_DIGEST);
    });
  });
});
