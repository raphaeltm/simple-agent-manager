/**
 * Vertical-slice tests for the registry proxy: token issuance + /v2 enforcement
 * + upstream proxying with a mocked upstream registry (the system boundary).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import app, { type Env } from '../src/index';
import { signRegistryToken, type RegistryTokenClaims } from '../src/jwt';

const SECRET = 'test-signing-secret';

const ENV: Env = {
  UPSTREAM_REGISTRY_URL: 'https://upstream.local:5000',
  REGISTRY_SERVICE: 'sam-registry-proxy',
  TOKEN_TTL_SECONDS: '1800',
  TOKEN_SIGNING_SECRET: SECRET,
  DEV_PROJECT_TOKENS: JSON.stringify({ 'sam-token-a': 'ProjA', 'sam-token-b': 'projb' }),
  UPSTREAM_USERNAME: 'cf-user',
  UPSTREAM_PASSWORD: 'cf-pass',
};

function basicAuth(token: string): string {
  return `Basic ${btoa(`anything:${token}`)}`;
}

async function issueToken(scopes: string[], samToken = 'sam-token-a'): Promise<string> {
  const qs = scopes.map((s) => `scope=${encodeURIComponent(s)}`).join('&');
  const res = await app.request(`https://proxy.test/token?${qs}`, {
    headers: { Authorization: basicAuth(samToken) },
  }, ENV);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /token', () => {
  it('401s without Basic auth, with a registry-style challenge', async () => {
    const res = await app.request('https://proxy.test/token', {}, ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer realm="https://proxy.test/token"');
    expect(res.headers.get('www-authenticate')).toContain('service="sam-registry-proxy"');
  });

  it('401s for an unknown SAM token', async () => {
    const res = await app.request('https://proxy.test/token', {
      headers: { Authorization: basicAuth('not-a-real-token') },
    }, ENV);
    expect(res.status).toBe(401);
  });

  it('grants push+pull inside the project namespace', async () => {
    const token = await issueToken(['repository:proj-proja/app:push,pull']);
    const payload = JSON.parse(
      atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    ) as RegistryTokenClaims;
    expect(payload.sub).toBe('ProjA');
    expect(payload.access).toEqual([
      { type: 'repository', name: 'proj-proja/app', actions: ['push', 'pull'] },
    ]);
  });

  it('clamps out-of-namespace repositories to an empty action list', async () => {
    const token = await issueToken([
      'repository:proj-projb/other:push,pull',
      'repository:proj-proja/mine:pull',
    ]);
    const payload = JSON.parse(
      atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    ) as RegistryTokenClaims;
    expect(payload.access).toEqual([
      { type: 'repository', name: 'proj-projb/other', actions: [] },
      { type: 'repository', name: 'proj-proja/mine', actions: ['pull'] },
    ]);
  });

  it('filters unknown actions out of the grant', async () => {
    const token = await issueToken(['repository:proj-proja/app:push,pull,delete,*']);
    const payload = JSON.parse(
      atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    ) as RegistryTokenClaims;
    expect(payload.access[0].actions).toEqual(['push', 'pull']);
  });
});

describe('/v2 data path', () => {
  it('401s the version-check ping without a token (docker login flow)', async () => {
    const res = await app.request('https://proxy.test/v2/', {}, ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer realm=');
    expect(res.headers.get('docker-distribution-api-version')).toBe('registry/2.0');
  });

  it('200s the ping with a valid token', async () => {
    const token = await issueToken([]);
    const res = await app.request('https://proxy.test/v2/', {
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);
    expect(res.status).toBe(200);
  });

  it('denies the catalog endpoint even with a valid token', async () => {
    const token = await issueToken(['repository:proj-proja/app:pull']);
    const res = await app.request('https://proxy.test/v2/_catalog', {
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);
    expect(res.status).toBe(403);
  });

  it('403s repositories outside the token project namespace (defense in depth)', async () => {
    // Forge a token whose access list claims another project's repo, but whose
    // sub is ProjA — the namespace check from claims.sub must still reject it.
    const now = Math.floor(Date.now() / 1000);
    const forged = await signRegistryToken(
      {
        sub: 'ProjA',
        iss: 'sam-registry-proxy',
        aud: 'sam-registry-proxy',
        iat: now,
        exp: now + 600,
        access: [{ type: 'repository', name: 'proj-projb/victim', actions: ['pull', 'push'] }],
      },
      SECRET
    );
    const res = await app.request('https://proxy.test/v2/proj-projb/victim/manifests/latest', {
      headers: { Authorization: `Bearer ${forged}` },
    }, ENV);
    expect(res.status).toBe(403);
  });

  it('403s a push attempt with a pull-only grant', async () => {
    const token = await issueToken(['repository:proj-proja/app:pull']);
    const res = await app.request('https://proxy.test/v2/proj-proja/app/blobs/uploads/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);
    expect(res.status).toBe(403);
  });

  it('403s repositories the token has no grant for, even inside the namespace', async () => {
    const token = await issueToken(['repository:proj-proja/app:pull']);
    const res = await app.request('https://proxy.test/v2/proj-proja/other-repo/manifests/latest', {
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);
    expect(res.status).toBe(403);
  });

  it('proxies an authorized pull upstream with the server-side credential', async () => {
    const fetchMock = vi.fn(async (req: Request) =>
      new Response('{"schemaVersion":2}', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.oci.image.manifest.v1+json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await issueToken(['repository:proj-proja/app:pull']);
    const res = await app.request('https://proxy.test/v2/proj-proja/app/manifests/latest', {
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"schemaVersion":2}');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const upstreamReq = fetchMock.mock.calls[0][0] as Request;
    expect(upstreamReq.url).toBe('https://upstream.local:5000/v2/proj-proja/app/manifests/latest');
    expect(upstreamReq.headers.get('authorization')).toBe(`Basic ${btoa('cf-user:cf-pass')}`);
  });

  it('rewrites upstream blob-upload Location headers to the proxy origin', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 202,
        headers: {
          Location: 'https://upstream.local:5000/v2/proj-proja/app/blobs/uploads/uuid-1?_state=xyz',
          'Docker-Upload-UUID': 'uuid-1',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await issueToken(['repository:proj-proja/app:push,pull']);
    const res = await app.request('https://proxy.test/v2/proj-proja/app/blobs/uploads/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);

    expect(res.status).toBe(202);
    expect(res.headers.get('location')).toBe(
      'https://proxy.test/v2/proj-proja/app/blobs/uploads/uuid-1?_state=xyz'
    );
  });

  it('passes through foreign redirect Locations (signed blob storage URLs)', async () => {
    const signed = 'https://r2.example.com/bucket/sha256:abc?X-Amz-Signature=zzz';
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 307, headers: { Location: signed } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await issueToken(['repository:proj-proja/app:pull']);
    const res = await app.request('https://proxy.test/v2/proj-proja/app/blobs/sha256:abc', {
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(signed);
  });

  it('strips the upstream WWW-Authenticate challenge so clients only see the proxy realm', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('denied', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="upstream-registry"' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const token = await issueToken(['repository:proj-proja/app:pull']);
    const res = await app.request('https://proxy.test/v2/proj-proja/app/manifests/latest', {
      headers: { Authorization: `Bearer ${token}` },
    }, ENV);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('healthz', () => {
  it('responds ok', async () => {
    const res = await app.request('https://proxy.test/healthz', {}, ENV);
    expect(res.status).toBe(200);
  });
});
