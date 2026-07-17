import {
  DEFAULT_GCP_COMPUTE_API_BASE_URL,
  DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL,
  DEFAULT_GCP_STS_SCOPE,
  GCP_CREDENTIAL_VERSION,
  type GcpOidcCredential,
} from '@simple-agent-manager/shared';
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { GcpApiError } from '../../../src/services/gcp-errors';
import {
  exchangeGcpServiceAccountAccessToken,
  parseGcpServiceAccountJson,
  verifyGcpServiceAccountAccess,
} from '../../../src/services/gcp-service-account';
import {
  clearGcpAccessTokenCache,
  getGcpAccessToken,
  getGcpAccessTokenCacheKey,
} from '../../../src/services/gcp-sts';

let privateKey: string;

function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'sam-test-project',
    private_key_id: 'key-id-123',
    private_key: privateKey,
    client_email: 'sam-vm@sam-test-project.iam.gserviceaccount.com',
    token_uri: 'https://attacker.invalid/steal',
    ...overrides,
  });
}

function createKv() {
  const values = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  return {
    values,
    puts,
    namespace: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        values.set(key, value);
        puts.push({ key, ttl: options?.expirationTtl });
      }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
      list: vi.fn(async (options: { prefix?: string }) => ({
        keys: Array.from(values.keys())
          .filter((name) => !options.prefix || name.startsWith(options.prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: '',
        cacheStatus: null,
      })),
    } as unknown as KVNamespace,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('parseGcpServiceAccountJson', () => {
  it('imports a PKCS#8 key and ignores uploaded token_uri', async () => {
    const credential = await parseGcpServiceAccountJson(
      serviceAccountJson(),
      'us-central1-a',
    );

    expect(credential).toMatchObject({
      version: 1,
      provider: 'gcp',
      authType: 'service-account-key',
      gcpProjectId: 'sam-test-project',
      privateKeyId: 'key-id-123',
      defaultZone: 'us-central1-a',
    });
    expect(credential).not.toHaveProperty('token_uri');
    expect(JSON.stringify(credential)).not.toContain('attacker.invalid');
  });

  it.each([
    ['malformed JSON', '{', 'malformed'],
    ['wrong type', serviceAccountJson({ type: 'authorized_user' }), 'service_account'],
    ['bad email', serviceAccountJson({ client_email: 'not-an-email' }), 'client_email'],
    ['bad project', serviceAccountJson({ project_id: '../project' }), 'project_id'],
    ['bad key', serviceAccountJson({ private_key: 'not-a-key' }), 'PKCS#8'],
  ])('rejects %s without echoing secrets', async (_label, input, expected) => {
    await expect(parseGcpServiceAccountJson(input, 'us-central1-a')).rejects.toThrow(expected);
  });
});

describe('service-account JWT exchange contract', () => {
  it('posts a form-encoded RS256 assertion only to the fixed Google endpoint', async () => {
    const credential = await parseGcpServiceAccountJson(serviceAccountJson(), 'us-central1-a');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'short-lived-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeGcpServiceAccountAccessToken(credential, {} as Env)).resolves.toEqual({
      accessToken: 'short-lived-token',
      expiresInSeconds: 3600,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL);
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = body.get('assertion');
    expect(assertion).toBeTruthy();
    expect(decodeProtectedHeader(assertion!)).toMatchObject({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'key-id-123',
    });
    expect(decodeJwt(assertion!)).toMatchObject({
      iss: 'sam-vm@sam-test-project.iam.gserviceaccount.com',
      aud: DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL,
      scope: DEFAULT_GCP_STS_SCOPE,
    });
  });

  it('does not retain the assertion or response body on token rejection', async () => {
    const credential = await parseGcpServiceAccountJson(serviceAccountJson(), 'us-central1-a');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_grant', assertion: 'echoed-secret' }),
      { status: 400 },
    )));

    let caught: unknown;
    try {
      await exchangeGcpServiceAccountAccessToken(credential, {} as Env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GcpApiError);
    expect((caught as GcpApiError).rawBody).toBeUndefined();
    expect(String(caught)).not.toContain('echoed-secret');
    expect(String(caught)).not.toContain(credential.privateKey);
  });
});

describe('service-account verification and caching', () => {
  it('checks the selected Compute zone with a bearer token', async () => {
    const credential = await parseGcpServiceAccountJson(serviceAccountJson(), 'us-central1-a');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyGcpServiceAccountAccess(credential, 'access-token', {} as Env);

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_GCP_COMPUTE_API_BASE_URL}/projects/sam-test-project/zones/us-central1-a`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });

  it('isolates derivative tokens by project and key id, then clears every project', async () => {
    const credential = await parseGcpServiceAccountJson(serviceAccountJson(), 'us-central1-a');
    const rotated = { ...credential, privateKeyId: 'key-id-rotated' };
    const kv = createKv();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'short-lived-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { KV: kv.namespace } as Env;

    await expect(getGcpAccessToken('user-1', 'project-a', credential, env))
      .resolves.toBe('short-lived-token');
    await expect(getGcpAccessToken('user-1', 'project-a', credential, env))
      .resolves.toBe('short-lived-token');
    await expect(getGcpAccessToken('user-1', 'project-b', credential, env))
      .resolves.toBe('short-lived-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kv.puts.every(({ ttl }) => ttl === 3300)).toBe(true);
    const firstKey = getGcpAccessTokenCacheKey('user-1', 'project-a', credential);
    const secondKey = getGcpAccessTokenCacheKey('user-1', 'project-b', credential);
    expect(firstKey).not.toBe(secondKey);
    expect(kv.values.get(firstKey)).toBe('short-lived-token');
    expect(kv.values.get(secondKey)).toBe('short-lived-token');
    expect(getGcpAccessTokenCacheKey('user-1', 'project-a', rotated)).not.toBe(firstKey);
    expect(JSON.stringify(Array.from(kv.values.values()))).not.toContain(privateKey);

    await clearGcpAccessTokenCache(env, 'user-1', credential);
    expect(kv.values.size).toBe(0);
  });

  it('isolates WIF tokens by impersonated service account and clears legacy cache keys', async () => {
    const credential: GcpOidcCredential = {
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType: 'workload-identity',
      gcpProjectId: 'sam-test-project',
      gcpProjectNumber: '123456789',
      serviceAccountEmail: 'first@sam-test-project.iam.gserviceaccount.com',
      wifPoolId: 'sam-pool',
      wifProviderId: 'sam-provider',
      defaultZone: 'us-central1-a',
    };
    const otherServiceAccount = {
      ...credential,
      serviceAccountEmail: 'second@sam-test-project.iam.gserviceaccount.com',
    };
    expect(getGcpAccessTokenCacheKey('user-1', 'project-a', otherServiceAccount))
      .not.toBe(getGcpAccessTokenCacheKey('user-1', 'project-a', credential));

    const kv = createKv();
    await clearGcpAccessTokenCache({ KV: kv.namespace } as Env, 'user-1', credential);

    expect(kv.namespace.delete).toHaveBeenCalledWith(
      'gcp-token:v2:user-1:sam-test-project:workload-identity:123456789:sam-pool:sam-provider',
    );
  });
});
