import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  GCP_CREDENTIAL_VERSION,
  type GcpServiceAccountKeyCredential,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { gcpRoutes } from '../../../src/routes/gcp';
import { makeCredentialDbMock } from './credential-route-test-helpers';

const mocks = vi.hoisted(() => ({
  enforceMutationLimit: vi.fn(),
  getGoogleInfraOAuthConfig: vi.fn(),
  getGcpAccessToken: vi.fn(),
  listGcpProjects: vi.fn(),
  clearGcpAccessTokenCache: vi.fn(),
  parseServiceAccountJson: vi.fn(),
  replaceUserGcpCredential: vi.fn(),
  runGcpSetup: vi.fn(),
  verifyServiceAccountAccess: vi.fn(),
  verifyGcpOidcSetup: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/services/credential-mutation-rate-limit', () => ({
  enforceCredentialMutationRateLimit: mocks.enforceMutationLimit,
}));
vi.mock('../../../src/services/gcp-credential-store', () => ({
  replaceUserGcpCredential: mocks.replaceUserGcpCredential,
}));
vi.mock('../../../src/services/gcp-service-account', () => ({
  parseGcpServiceAccountJson: mocks.parseServiceAccountJson,
  verifyGcpServiceAccountAccess: mocks.verifyServiceAccountAccess,
}));
vi.mock('../../../src/services/gcp-setup', () => ({
  listGcpProjects: mocks.listGcpProjects,
  runGcpSetup: mocks.runGcpSetup,
}));
vi.mock('../../../src/services/gcp-sts', () => ({
  getGcpAccessToken: mocks.getGcpAccessToken,
  clearGcpAccessTokenCache: mocks.clearGcpAccessTokenCache,
  verifyGcpOidcSetup: mocks.verifyGcpOidcSetup,
}));
vi.mock('../../../src/services/platform-config', () => ({
  getGoogleInfraOAuthConfig: mocks.getGoogleInfraOAuthConfig,
}));

const wifCredential = {
  version: GCP_CREDENTIAL_VERSION,
  provider: 'gcp' as const,
  authType: 'workload-identity' as const,
  gcpProjectId: 'gcp-project-1',
  gcpProjectNumber: '123456789',
  serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
  wifPoolId: 'sam-pool',
  wifProviderId: 'sam-provider',
  defaultZone: 'us-central1-a',
};

const serviceAccountCredential: GcpServiceAccountKeyCredential = {
  version: GCP_CREDENTIAL_VERSION,
  provider: 'gcp',
  authType: 'service-account-key',
  gcpProjectId: 'gcp-project-1',
  serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
  privateKeyId: 'key-id-safe-metadata',
  privateKey: '-----BEGIN PRIVATE KEY-----\nnever-return-this\n-----END PRIVATE KEY-----',
  defaultZone: 'us-central1-a',
};

function createGcpTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as {
      statusCode?: number;
      error?: string;
      message?: string;
    };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/gcp', gcpRoutes);
  return app;
}

function makeTestEnv(): Env {
  const kv = {
    get: vi.fn().mockResolvedValue('oauth-token'),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    DATABASE: {
      prepare: vi.fn(),
      batch: vi.fn(),
    } as unknown as Env['DATABASE'],
    ENCRYPTION_KEY: 'test-key',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    KV: kv as unknown as Env['KV'],
  } as Env;
}

function setupRequest() {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oauthHandle: 'oauth-handle',
      gcpProjectId: 'gcp-project-1',
      defaultZone: 'us-central1-a',
    }),
  };
}

describe('GCP routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createGcpTestApp();
    env = makeTestEnv();
    const mockDB = makeCredentialDbMock();
    mockDB.limit.mockResolvedValue([]);
    vi.mocked(drizzle).mockReturnValue(mockDB as never);

    mocks.enforceMutationLimit.mockResolvedValue(undefined);
    mocks.getGoogleInfraOAuthConfig.mockResolvedValue({
      clientId: 'infra-client',
      clientSecret: 'infra-secret',
    });
    mocks.getGcpAccessToken.mockResolvedValue('short-lived-access-token');
    mocks.listGcpProjects.mockResolvedValue([]);
    mocks.clearGcpAccessTokenCache.mockResolvedValue(undefined);
    mocks.parseServiceAccountJson.mockResolvedValue(serviceAccountCredential);
    mocks.replaceUserGcpCredential.mockResolvedValue({
      id: 'stored-credential-id',
      createdAt: '2026-07-16T00:00:00.000Z',
    });
    mocks.runGcpSetup.mockResolvedValue(wifCredential);
    mocks.verifyServiceAccountAccess.mockResolvedValue(undefined);
    mocks.verifyGcpOidcSetup.mockResolvedValue(undefined);
  });

  it('stores new WIF writes with the explicit versioned authentication variant', async () => {
    const res = await app.request('/api/gcp/setup', setupRequest(), env);

    expect(res.status).toBe(200);
    expect(mocks.replaceUserGcpCredential).toHaveBeenCalledWith(env, 'test-user-id', wifCredential);
    expect(mocks.verifyGcpOidcSetup).toHaveBeenCalledWith(
      'test-user-id',
      'setup-verification',
      wifCredential,
      env
    );
    expect(await res.json()).toMatchObject({
      success: true,
      verified: true,
      credential: {
        gcpProjectId: 'gcp-project-1',
        serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
      },
    });
  });

  it('verifies a service-account credential before replacement and returns safe metadata only', async () => {
    const uploadedJson = '{"private_key":"uploaded-secret-material"}';
    const res = await app.request(
      '/api/gcp/service-account',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceAccountJson: uploadedJson,
          defaultZone: 'us-central1-a',
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(mocks.enforceMutationLimit).toHaveBeenCalledWith(
      env,
      'test-user-id',
      'gcp-service-account'
    );
    expect(mocks.parseServiceAccountJson).toHaveBeenCalledWith(uploadedJson, 'us-central1-a');
    expect(mocks.getGcpAccessToken).toHaveBeenCalledWith(
      'test-user-id',
      'service-account-setup',
      serviceAccountCredential,
      env
    );
    expect(mocks.verifyServiceAccountAccess).toHaveBeenCalledWith(
      serviceAccountCredential,
      'short-lived-access-token',
      env
    );
    expect(mocks.replaceUserGcpCredential).toHaveBeenCalledWith(
      env,
      'test-user-id',
      serviceAccountCredential
    );
    expect(mocks.verifyServiceAccountAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replaceUserGcpCredential.mock.invocationCallOrder[0]!
    );

    const responseText = await res.text();
    expect(responseText).not.toContain('uploaded-secret-material');
    expect(responseText).not.toContain('never-return-this');
    expect(responseText).not.toContain('short-lived-access-token');
    expect(JSON.parse(responseText)).toEqual({
      success: true,
      credential: {
        id: 'stored-credential-id',
        provider: 'gcp',
        connected: true,
        createdAt: '2026-07-16T00:00:00.000Z',
        gcp: {
          authType: 'service-account-key',
          gcpProjectId: 'gcp-project-1',
          serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
          defaultZone: 'us-central1-a',
          privateKeyId: 'key-id-safe-metadata',
        },
      },
    });
  });

  it('leaves the stored credential untouched when Compute verification fails', async () => {
    mocks.verifyServiceAccountAccess.mockRejectedValue(
      new Error('upstream rejected never-return-this')
    );

    const res = await app.request(
      '/api/gcp/service-account',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceAccountJson: '{"private_key":"uploaded-secret-material"}',
          defaultZone: 'us-central1-a',
        }),
      },
      env
    );

    expect(res.status).toBe(502);
    expect(mocks.replaceUserGcpCredential).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain('never-return-this');
  });

  it('uses the default timeout when the configured project-list timeout is invalid', async () => {
    env.GCP_API_TIMEOUT_MS = 'not-a-positive-number';

    const res = await app.request('/api/gcp/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oauthHandle: 'oauth-handle' }),
    }, env);

    expect(res.status).toBe(200);
    expect(mocks.listGcpProjects).toHaveBeenCalledWith(
      'oauth-token',
      DEFAULT_GCP_API_TIMEOUT_MS,
    );
  });

  it('reports service-account persistence failures as internal errors', async () => {
    mocks.replaceUserGcpCredential.mockRejectedValue(new Error('database unavailable'));

    const res = await app.request('/api/gcp/service-account', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceAccountJson: '{"private_key":"uploaded-secret-material"}',
        defaultZone: 'us-central1-a',
      }),
    }, env);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'INTERNAL_ERROR' });
  });

  it('reports WIF persistence failures as internal errors', async () => {
    mocks.replaceUserGcpCredential.mockRejectedValue(new Error('database unavailable'));

    const res = await app.request('/api/gcp/setup', setupRequest(), env);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'INTERNAL_ERROR' });
  });

  it('rejects unsupported zones before parsing or storing the uploaded credential', async () => {
    const res = await app.request(
      '/api/gcp/service-account',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceAccountJson: '{"private_key":"uploaded-secret-material"}',
          defaultZone: 'not-a-gcp-zone',
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(mocks.parseServiceAccountJson).not.toHaveBeenCalled();
    expect(mocks.replaceUserGcpCredential).not.toHaveBeenCalled();
  });

  it('does not start WIF setup when the independent infrastructure OAuth client is absent', async () => {
    mocks.getGoogleInfraOAuthConfig.mockResolvedValue(null);

    const res = await app.request('/api/gcp/setup', setupRequest(), env);

    expect(res.status).toBe(400);
    expect(mocks.runGcpSetup).not.toHaveBeenCalled();
    expect(mocks.replaceUserGcpCredential).not.toHaveBeenCalled();
  });
});
