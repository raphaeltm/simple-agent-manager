import { describe, expect, it, vi } from 'vitest';

import { createImageResolver, ImageResolveError } from '../../src/services/image-resolver';

// =============================================================================
// Helpers — realistic mock registry HTTP responses
// =============================================================================

const REALISTIC_DIGEST = 'sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4';

/** Mock a registry that returns digest on HEAD */
function mockRegistryFetch(
  opts: {
    digest?: string;
    status?: number;
    wwwAuth?: string;
    needsTokenExchange?: boolean;
    getDigest?: string;
  } = {}
) {
  const digest = opts.digest ?? REALISTIC_DIGEST;
  const callLog: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let callCount = 0;

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    callCount++;
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v as string])
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
          'WWW-Authenticate':
            opts.wwwAuth ??
            'Bearer realm="https://registry.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
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

    it('wraps the default global fetch so Workers-style host functions keep their receiver', async () => {
      const originalFetch = globalThis.fetch;
      const observedThisValues: unknown[] = [];
      globalThis.fetch = vi.fn(function (this: unknown) {
        observedThisValues.push(this);
        if (this !== globalThis) {
          throw new TypeError('Illegal invocation');
        }
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { 'Docker-Content-Digest': REALISTIC_DIGEST },
          })
        );
      }) as typeof fetch;

      try {
        const resolver = createImageResolver();

        await expect(resolver('ghcr.io', 'org/myapp', 'v1.0')).resolves.toBe(REALISTIC_DIGEST);
        expect(globalThis.fetch).toHaveBeenCalledWith(
          'https://ghcr.io/v2/org/myapp/manifests/v1.0',
          expect.objectContaining({ method: 'HEAD' })
        );
        expect(observedThisValues).toEqual([globalThis]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns 404 → ImageResolveError with statusCode 404', async () => {
      const { fetchFn } = mockRegistryFetch({ status: 404 });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('ghcr.io', 'org/missing', 'v1.0')).rejects.toThrow(ImageResolveError);

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

      await expect(resolver('ghcr.io', 'org/private', 'v1.0')).rejects.toThrow(ImageResolveError);

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

      expect(callLog[0]!.headers['authorization']).toBe(`Basic ${btoa('user:pass')}`);
    });

    it('sends auth when target registry matches authRegistryHost scope', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
        authRegistryHost: 'registry.cloudflare.com',
      });

      await resolver('registry.cloudflare.com', 'acct/sam-proj/app', 'latest');

      expect(callLog[0]!.headers['authorization']).toBe(`Basic ${btoa('user:pass')}`);
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

      expect(callLog[0]!.url).toBe('https://evil.attacker.example/v2/org/app/manifests/latest');
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

    it('does NOT forward scoped auth to a different port on the same host', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
        authRegistryHost: 'registry.cloudflare.com',
      });

      await resolver('registry.cloudflare.com:4443', 'acct/sam-proj/app', 'latest');

      expect(callLog[0]!.url).toBe(
        'https://registry.cloudflare.com:4443/v2/acct/sam-proj/app/manifests/latest'
      );
      expect(callLog[0]!.headers['authorization']).toBeUndefined();
    });

    it('rejects repository and tag path smuggling before credentialed fetch', async () => {
      const { fetchFn } = mockRegistryFetch();
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
        authRegistryHost: 'registry.cloudflare.com',
      });

      await expect(
        resolver('registry.cloudflare.com', 'acct/sam-proj/app/../../_catalog', 'latest?x=1')
      ).rejects.toThrow(/Unsafe image (repository|tag) rejected/);
      expect(fetchFn).not.toHaveBeenCalled();
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
      expect(callLog[1]!.url).toContain('registry.example.com/token');
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
      expect(tokenCall.headers['authorization']).toBe(`Basic ${btoa('myuser:mypass')}`);
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

      await expect(resolver('ghcr.io', 'org/app', 'v1.0')).rejects.toThrow(
        'unsupported digest format'
      );
    });

    it('handles custom public registry with explicit https scheme and port', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({ fetchFn });

      await resolver('https://registry.example.com:5000', 'org/app', 'v1.0');

      expect(callLog[0]!.url).toBe('https://registry.example.com:5000/v2/org/app/manifests/v1.0');
    });

    it('normalizes mixed-case public registry hosts before fetching', async () => {
      const { fetchFn, callLog } = mockRegistryFetch();
      const resolver = createImageResolver({ fetchFn });

      await resolver('GhCr.IO', 'org/app', 'v1.0');

      expect(callLog[0]!.url).toBe('https://ghcr.io/v2/org/app/manifests/v1.0');
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
      await expect(
        resolver(`${insecureScheme}://insecure-registry.internal:5000`, 'org/app', 'v1.0')
      ).rejects.toThrow('Insecure registry URL rejected');
      // The request must never be sent over plaintext.
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([
      ['loopback IPv4', '127.0.0.1'],
      ['encoded loopback IPv4', '%31%32%37.0.0.1'],
      ['octal loopback IPv4', '0177.0.0.1'],
      ['hex loopback IPv4', '0x7f.0.0.1'],
      ['integer loopback IPv4', '2130706433'],
      ['private IPv4', '10.0.0.5'],
      ['link-local metadata IPv4', '169.254.169.254'],
      ['loopback IPv6', '[::1]'],
      ['unique-local IPv6', '[fd00::1]'],
      ['IPv4-mapped loopback IPv6', '[::ffff:127.0.0.1]'],
      ['localhost name', 'localhost'],
      ['metadata hostname', 'metadata.google.internal'],
      ['internal pseudo-TLD', 'registry.internal'],
      ['local pseudo-TLD', 'registry.local'],
      ['trailing-dot hostname', 'registry.example.com.'],
      ['raw IDN hostname', 'bücher.example'],
      ['userinfo authority', 'https://user:pass@registry.example.com'],
      ['leading-zero port', 'https://registry.example.com:0443'],
    ])('rejects unsafe registry authority: %s', async (_name, registry) => {
      const { fetchFn } = mockRegistryFetch();
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver(registry, 'org/app', 'v1.0')).rejects.toThrow(/Unsafe|Insecure/);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('manually validates redirects and rejects a private-address pivot before following it', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://169.254.169.254/latest/meta-data/' },
          })
      );
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('registry.example.com', 'org/app', 'v1.0')).rejects.toThrow(
        'not a public registry endpoint'
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('strips Authorization when following a validated cross-origin redirect', async () => {
      const callLog: Array<{ url: string; headers: Record<string, string> }> = [];
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        callLog.push({ url, headers });
        if (callLog.length === 1) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: 'https://cdn.example.com/v2/org/app/manifests/v1.0',
            },
          });
        }
        return new Response(null, {
          status: 200,
          headers: { 'Docker-Content-Digest': REALISTIC_DIGEST },
        });
      });
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
      });

      await expect(resolver('registry.example.com', 'org/app', 'v1.0')).resolves.toBe(
        REALISTIC_DIGEST
      );
      expect(callLog[0]!.headers['authorization']).toBe(`Basic ${btoa('user:pass')}`);
      expect(callLog[1]!.url).toBe('https://cdn.example.com/v2/org/app/manifests/v1.0');
      expect(callLog[1]!.headers['authorization']).toBeUndefined();
    });

    it('bounds redirect following', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://registry.example.com/again' },
          })
      );
      const resolver = createImageResolver({ fetchFn, maxRedirects: 0 });

      await expect(resolver('registry.example.com', 'org/app', 'v1.0')).rejects.toThrow(
        'redirect budget'
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('refuses to forward credentials to an untrusted token realm host (exfil guard)', async () => {
      // Malicious registry redirects the token realm to an attacker host.
      const { fetchFn } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth:
          'Bearer realm="https://evil.attacker.com/token",service="registry.example.com",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({
        fetchFn,
        auth: { username: 'user', password: 'pass' },
      });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'untrusted token realm host'
      );
    });

    it('rejects a non-https token realm', async () => {
      const { fetchFn } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth:
          'Bearer realm="http://auth.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'only HTTPS endpoints are allowed'
      );
    });

    it('rejects a private token realm pivot even without credentials', async () => {
      const { fetchFn, callLog } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth:
          'Bearer realm="https://127.0.0.1/token",service="registry.example.com",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'not a public registry endpoint'
      );
      expect(callLog).toHaveLength(1);
    });

    it('rejects an untrusted public token realm pivot even without credentials', async () => {
      const { fetchFn, callLog } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth:
          'Bearer realm="https://api.cloudflare.com/client/v4",service="registry.example.com",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'untrusted token realm host'
      );
      expect(callLog).toHaveLength(1);
    });

    it('rejects a same-parent-domain token realm that is not explicitly trusted', async () => {
      const { fetchFn, callLog } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth:
          'Bearer realm="https://tenant-b.pages.dev/token",service="tenant-a.pages.dev",scope="repository:org/app:pull"',
      });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('tenant-a.pages.dev', 'org/app', 'v2.0')).rejects.toThrow(
        'untrusted token realm host'
      );
      expect(callLog).toHaveLength(1);
    });

    it('rejects a token-realm redirect pivot before fetching the private target', async () => {
      const callLog: Array<{ url: string; method: string }> = [];
      let callCount = 0;
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        callCount += 1;
        callLog.push({ url, method: init?.method ?? 'GET' });
        if (callCount === 1) {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer realm="https://registry.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
            },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data/' },
        });
      });
      const resolver = createImageResolver({ fetchFn });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'not a public registry endpoint'
      );
      expect(callLog).toEqual([
        { url: 'https://registry.example.com/v2/org/app/manifests/v2.0', method: 'HEAD' },
        {
          url: 'https://registry.example.com/token?service=registry.example.com&scope=repository%3Aorg%2Fapp%3Apull',
          method: 'GET',
        },
      ]);
    });

    it('rejects an oversized bearer token response before parsing it', async () => {
      let callCount = 0;
      const fetchFn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('Unauthorized', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer realm="https://registry.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
            },
          });
        }
        return new Response(JSON.stringify({ token: 'x'.repeat(128) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const resolver = createImageResolver({ fetchFn, tokenResponseMaxBytes: 16 });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'Token exchange response exceeded 16 bytes'
      );
    });

    it('bounds total outbound fetch attempts across token fallback work', async () => {
      const { fetchFn } = mockRegistryFetch({ needsTokenExchange: true });
      const resolver = createImageResolver({ fetchFn, maxFetchAttempts: 1 });

      await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
        'fetch attempt budget'
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('bounds total elapsed resolver time across multi-step token work', async () => {
      let now = 1_000;
      const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const fetchFn = vi.fn(async () => {
        now = 2_000;
        return new Response('Unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer realm="https://registry.example.com/token",service="registry.example.com",scope="repository:org/app:pull"',
          },
        });
      });
      const resolver = createImageResolver({
        fetchFn,
        timeoutMs: 1_000,
        totalTimeoutMs: 10,
      });

      try {
        await expect(resolver('registry.example.com', 'org/app', 'v2.0')).rejects.toThrow(
          'total time budget'
        );
        expect(fetchFn).toHaveBeenCalledTimes(1);
      } finally {
        dateNow.mockRestore();
      }
    });

    it('bounds concurrent outbound fetches for a shared resolver instance', async () => {
      let finishFirstFetch: ((response: Response) => void) | undefined;
      const fetchFn = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishFirstFetch = resolve;
          })
      );
      const resolver = createImageResolver({ fetchFn, maxConcurrentFetches: 1 });

      const first = resolver('registry.example.com', 'org/app', 'v1.0');
      await Promise.resolve();

      await expect(resolver('registry.example.com', 'org/other', 'v1.0')).rejects.toThrow(
        'concurrent fetch budget'
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);

      finishFirstFetch?.(
        new Response(null, {
          status: 200,
          headers: { 'Docker-Content-Digest': REALISTIC_DIGEST },
        })
      );
      await expect(first).resolves.toBe(REALISTIC_DIGEST);
    });

    it('aborts a slow outbound fetch through the configured request timeout', async () => {
      const fetchFn = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      );
      const resolver = createImageResolver({ fetchFn, timeoutMs: 1, totalTimeoutMs: 100 });

      await expect(resolver('registry.example.com', 'org/app', 'v1.0')).rejects.toThrow(
        'timed out'
      );
    });

    it('allows a token realm on a sibling subdomain of the registry (docker.io style)', async () => {
      // registry-1.docker.io and auth.docker.io share the docker.io parent domain.
      const { fetchFn } = mockRegistryFetch({
        needsTokenExchange: true,
        wwwAuth:
          'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
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
