/**
 * Behavioral tests for the cloud-provider credential routes.
 *
 * POST /api/credentials   — create/update a cloud-provider credential
 * GET  /api/credentials   — list cloud-provider credentials
 * DELETE /api/credentials/:provider — remove a cloud-provider credential
 *
 * The existing credentials.test.ts covers agent API key/OAuth routes only.
 * This file covers the entirely separate cloud-provider path introduced by
 * the multi-provider generalization (provider-credentials.ts).
 *
 * Mocking strategy:
 * - drizzle-orm/d1 is mocked so DB calls are controlled per test
 * - global fetch is mocked so upstream validation responses are controlled
 * - serializeCredentialToken/buildProviderConfig are exercised through the
 *   route handler (not mocked) so the full path is covered
 * - encrypt is mocked to avoid requiring a real WebCrypto environment
 */
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createCredentialsTestApp, makeCredentialDbMock } from './credential-route-test-helpers';

vi.mock('drizzle-orm/d1');

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'generated-ulid',
}));

vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'encrypted-token', iv: 'test-iv' }),
  decrypt: vi.fn().mockResolvedValue('decrypted-value'),
}));

// ============================================================================
// Test Setup
// ============================================================================

const preparedStmt = {
  bind: vi.fn().mockReturnThis(),
  run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
};

const mockEnv = {
  DATABASE: {
    prepare: vi.fn().mockReturnValue(preparedStmt),
    batch: vi.fn().mockResolvedValue([
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ]),
  } as unknown as Env['DATABASE'],
  ENCRYPTION_KEY: 'test-encryption-key',
} as Env;

async function expectCredentialValidationFailure(
  app: Hono<{ Bindings: Env }>,
  path: string,
  body: unknown,
  expectedProvider: string
) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'bad key' }), { status: 401, statusText: 'Unauthorized' })
  );

  const res = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    mockEnv
  );

  expect(res.status).toBe(400);
  const responseBody = await res.json();
  expect(responseBody.message).toContain(
    `Token rejected by ${expectedProvider} API (401 Unauthorized)`
  );
}

// ============================================================================
// POST /api/credentials — cloud-provider credential creation
// ============================================================================

describe('POST /api/credentials — cloud-provider credentials', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createCredentialsTestApp();
    vi.clearAllMocks();

    mockDB = makeCredentialDbMock();
    mockDB.limit.mockResolvedValue([]);

    (drizzle as any).mockReturnValue(mockDB);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ servers: [] }), { status: 200 }))
    );
  });

  it('creates a hetzner credential and returns 201', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'hetzner', token: 'htz-api-token' }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBe('hetzner');
    expect(body.connected).toBe(true);
    expect(body.id).toBe('generated-ulid');
  });

  it('creates a scaleway credential and returns 201', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'scaleway',
          secretKey: 'scw-secret-key',
          projectId: 'proj-uuid-1234',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBe('scaleway');
    expect(body.connected).toBe(true);
  });

  it('upserts when a credential for the same provider already exists, returning 200', async () => {
    // Simulate existing credential row
    mockDB.limit.mockResolvedValueOnce([
      {
        id: 'existing-cred-id',
        provider: 'hetzner',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'hetzner', token: 'new-token' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('existing-cred-id');
    expect(body.connected).toBe(true);

    // insert must NOT be called — this is an update
    expect(mockDB.insert).not.toHaveBeenCalled();
    expect(mockDB.update).toHaveBeenCalled();
  });

  it('returns 400 when provider field is missing', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'htz-token' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for an unsupported provider name', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'digitalocean', token: 'do-token' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('provider');
  });

  it('returns 400 when hetzner token field is missing', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'hetzner' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('token');
  });

  it('returns 400 when scaleway secretKey is missing', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'scaleway', projectId: 'proj-uuid' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('secretKey');
  });

  it('returns 400 when scaleway projectId is missing', async () => {
    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'scaleway', secretKey: 'scw-key' }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('projectId');
  });

  it('saves and returns a validation warning when Hetzner rejects the token', async () => {
    const { encrypt } = await import('../../../src/services/encryption');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad key' }), {
        status: 401,
        statusText: 'Unauthorized',
      })
    );

    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'hetzner', token: 'bad-token' }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.validation.valid).toBe(false);
    expect(body.validation.error).toContain('Token rejected by Hetzner API (401 Unauthorized)');
    expect(encrypt).toHaveBeenCalled();
    expect(mockDB.insert).toHaveBeenCalled();
  });

  it('saves and returns provider-specific validation warning for Scaleway failure', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, statusText: 'Forbidden' })
    );

    const res = await app.request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'scaleway',
          secretKey: 'bad-key',
          projectId: 'proj-uuid',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.validation.valid).toBe(false);
    expect(body.validation.error).toContain('Token rejected by Scaleway API (403 Forbidden)');
  });
});

describe('POST /api/credentials/validate — cloud-provider validation', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    app = createCredentialsTestApp();
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ servers: [] }), { status: 200 }))
    );
  });

  it('validates a Hetzner token without encrypting or storing it', async () => {
    const { encrypt } = await import('../../../src/services/encryption');

    const res = await app.request(
      '/api/credentials/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'hetzner', token: 'htz-api-token' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.provider).toBe('hetzner');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer htz-api-token' }),
      })
    );
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('returns 400 when validation rejects the credential', async () => {
    await expectCredentialValidationFailure(
      app,
      '/api/credentials/validate',
      { provider: 'hetzner', token: 'bad-token' },
      'Hetzner'
    );
  });
});

// ============================================================================
// GET /api/credentials — list cloud-provider credentials
// ============================================================================

describe('GET /api/credentials', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createCredentialsTestApp();
    vi.clearAllMocks();

    mockDB = makeCredentialDbMock();

    (drizzle as any).mockReturnValue(mockDB);
  });

  it('returns 200 with an empty array when no credentials exist', async () => {
    mockDB.where.mockResolvedValueOnce([]);

    const res = await app.request('/api/credentials', { method: 'GET' }, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('returns credentials with provider, id, createdAt, and connected=true', async () => {
    mockDB.where.mockResolvedValueOnce([
      {
        id: 'cred-1',
        provider: 'hetzner',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request('/api/credentials', { method: 'GET' }, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: 'cred-1',
      provider: 'hetzner',
      connected: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('returns multiple credentials from different providers', async () => {
    mockDB.where.mockResolvedValueOnce([
      { id: 'cred-1', provider: 'hetzner', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'cred-2', provider: 'scaleway', createdAt: '2024-01-02T00:00:00.000Z' },
    ]);

    const res = await app.request('/api/credentials', { method: 'GET' }, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.map((c: any) => c.provider)).toContain('hetzner');
    expect(body.map((c: any) => c.provider)).toContain('scaleway');
  });

  it('does not expose encryptedToken or iv in the response', async () => {
    mockDB.where.mockResolvedValueOnce([
      {
        id: 'cred-1',
        provider: 'hetzner',
        createdAt: '2024-01-01T00:00:00.000Z',
        encryptedToken: 'should-not-leak',
        iv: 'should-not-leak',
      },
    ]);

    const res = await app.request('/api/credentials', { method: 'GET' }, mockEnv);
    const body = await res.json();

    expect(body[0].encryptedToken).toBeUndefined();
    expect(body[0].iv).toBeUndefined();
  });

  it('returns safe GCP metadata while isolating a malformed encrypted row', async () => {
    const { decrypt } = await import('../../../src/services/encryption');
    mockDB.where.mockResolvedValueOnce([
      {
        id: 'gcp-good',
        provider: 'gcp',
        encryptedToken: 'encrypted-good',
        iv: 'iv-good',
        createdAt: '2026-07-16T00:00:00.000Z',
      },
      {
        id: 'gcp-bad',
        provider: 'gcp',
        encryptedToken: 'encrypted-bad',
        iv: 'iv-bad',
        createdAt: '2026-07-16T00:01:00.000Z',
      },
      {
        id: 'hetzner-good',
        provider: 'hetzner',
        encryptedToken: 'encrypted-hetzner',
        iv: 'iv-hetzner',
        createdAt: '2026-07-16T00:02:00.000Z',
      },
    ]);
    vi.mocked(decrypt)
      .mockResolvedValueOnce(
        JSON.stringify({
          version: 1,
          provider: 'gcp',
          authType: 'service-account-key',
          gcpProjectId: 'gcp-project-1',
          serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
          privateKeyId: 'safe-key-id',
          privateKey: 'never-return-private-key',
          defaultZone: 'us-central1-a',
        })
      )
      .mockRejectedValueOnce(new Error('malformed encrypted row'));

    const res = await app.request('/api/credentials', { method: 'GET' }, mockEnv);

    expect(res.status).toBe(200);
    const responseText = await res.text();
    expect(responseText).not.toContain('never-return-private-key');
    const body = JSON.parse(responseText);
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({
      id: 'gcp-good',
      connected: true,
      gcp: {
        authType: 'service-account-key',
        gcpProjectId: 'gcp-project-1',
        serviceAccountEmail: 'sam-agent@gcp-project-1.iam.gserviceaccount.com',
        privateKeyId: 'safe-key-id',
        defaultZone: 'us-central1-a',
      },
    });
    expect(body[1]).toEqual({
      id: 'gcp-bad',
      provider: 'gcp',
      connected: true,
      createdAt: '2026-07-16T00:01:00.000Z',
    });
    expect(body[2]).toMatchObject({
      id: 'hetzner-good',
      provider: 'hetzner',
      connected: true,
    });
  });
});

// ============================================================================
// DELETE /api/credentials/:provider
// ============================================================================

describe('DELETE /api/credentials/:provider', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createCredentialsTestApp();
    vi.clearAllMocks();

    mockDB = makeCredentialDbMock();
    mockDB.returning.mockResolvedValue([{ id: 'cred-1' }]);

    (drizzle as any).mockReturnValue(mockDB);
  });

  it('returns 200 with success:true when credential is deleted', async () => {
    const res = await app.request(
      '/api/credentials/hetzner',
      {
        method: 'DELETE',
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when no credential exists for that provider', async () => {
    // returning() resolves to empty array = row not found
    mockDB.returning.mockResolvedValueOnce([]);

    const res = await app.request(
      '/api/credentials/hetzner',
      {
        method: 'DELETE',
      },
      mockEnv
    );

    expect(res.status).toBe(404);
  });

  it('scopes the delete to the authenticated user (does not delete other users credentials)', async () => {
    await app.request(
      '/api/credentials/hetzner',
      {
        method: 'DELETE',
      },
      mockEnv
    );

    // The where() call must have been invoked, meaning a user-scoped filter was applied.
    // We cannot inspect the Drizzle filter directly (it is constructed internally),
    // but we verify delete + where were both called to confirm the query is scoped.
    expect(mockDB.delete).toHaveBeenCalled();
    expect(mockDB.where).toHaveBeenCalled();
  });
});
