import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { gcpRoutes } from '../../../src/routes/gcp';
import { makeCredentialDbMock } from './credential-route-test-helpers';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'test-ulid',
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'encrypted-gcp', iv: 'iv-gcp' }),
}));
vi.mock('../../../src/services/gcp-setup', () => ({
  listGcpProjects: vi.fn(),
  runGcpSetup: vi.fn().mockResolvedValue({
    gcpProjectId: 'gcp-project-1',
    gcpProjectNumber: '123456789',
    serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
    wifPoolId: 'sam-pool',
    wifProviderId: 'sam-provider',
    defaultZone: 'us-central1-a',
  }),
}));
vi.mock('../../../src/services/gcp-sts', () => ({
  verifyGcpOidcSetup: vi.fn().mockResolvedValue(undefined),
}));

function createGcpTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
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
  const preparedStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const database = {
    prepare: vi.fn().mockReturnValue(preparedStmt),
    batch: vi.fn().mockResolvedValue([
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ]),
  };
  return {
    DATABASE: database as unknown as Env['DATABASE'],
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

describe('GCP Routes - cloud provider dual-write', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: ReturnType<typeof makeCredentialDbMock>;

  beforeEach(() => {
    app = createGcpTestApp();
    mockDB = makeCredentialDbMock();
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);
  });

  it('creates a GCP legacy cloud credential and mirrors it to compute CC rows', async () => {
    mockDB.limit.mockResolvedValueOnce([]);
    const env = makeTestEnv();

    const res = await app.request('/api/gcp/setup', setupRequest(), env);

    expect(res.status).toBe(200);
    expect(mockDB.insert).toHaveBeenCalled();
    expect(mockDB.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        provider: 'gcp',
        credentialType: 'cloud-provider',
        encryptedToken: 'encrypted-gcp',
        iv: 'iv-gcp',
      })
    );

    const database = env.DATABASE as unknown as {
      prepare: ReturnType<typeof vi.fn>;
      batch: ReturnType<typeof vi.fn>;
    };
    const prepareCalls = database.prepare.mock.calls.map((c) => c[0] as string);
    expect(prepareCalls.some((sql) => sql.includes('DELETE FROM cc_attachments'))).toBe(true);
    expect(prepareCalls.some((sql) => sql.includes('INSERT INTO cc_credentials'))).toBe(true);
    expect(prepareCalls.some((sql) => sql.includes('INSERT INTO cc_configurations'))).toBe(true);
    expect(prepareCalls.some((sql) => sql.includes('INSERT INTO cc_attachments'))).toBe(true);
    expect(database.batch).toHaveBeenCalled();
  });

  it('updates a GCP legacy cloud credential and mirrors replacement CC rows', async () => {
    mockDB.limit.mockResolvedValueOnce([{ id: 'legacy-gcp' }]);
    const env = makeTestEnv();

    const res = await app.request('/api/gcp/setup', setupRequest(), env);

    expect(res.status).toBe(200);
    expect(mockDB.update).toHaveBeenCalled();
    expect(mockDB.set).toHaveBeenCalledWith(
      expect.objectContaining({ encryptedToken: 'encrypted-gcp', iv: 'iv-gcp' })
    );

    const database = env.DATABASE as unknown as {
      prepare: ReturnType<typeof vi.fn>;
      batch: ReturnType<typeof vi.fn>;
    };
    const prepareCalls = database.prepare.mock.calls.map((c) => c[0] as string);
    expect(prepareCalls.some((sql) => sql.includes('DELETE FROM cc_attachments'))).toBe(true);
    expect(prepareCalls.some((sql) => sql.includes('INSERT INTO cc_credentials'))).toBe(true);
    expect(database.batch).toHaveBeenCalled();
  });
});
