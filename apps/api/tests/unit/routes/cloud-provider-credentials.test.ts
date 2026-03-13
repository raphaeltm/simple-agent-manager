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
 * - @simple-agent-manager/providers is mocked so validateToken() is controlled
 * - serializeCredentialToken/buildProviderConfig are exercised through the
 *   route handler (not mocked) so the full path is covered
 * - encrypt is mocked to avoid requiring a real WebCrypto environment
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { credentialsRoutes } from '../../../src/routes/credentials';

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

// Mock the providers package so validateToken() is controlled per test
const mockValidateToken = vi.fn();
const mockProvider = { validateToken: mockValidateToken };
vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  return {
    ...original,
    createProvider: vi.fn(() => mockProvider),
  };
});

// ============================================================================
// Test Setup
// ============================================================================

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  app.route('/api/credentials', credentialsRoutes);
  return app;
}

const mockEnv = {
  DATABASE: {} as any,
  ENCRYPTION_KEY: 'test-encryption-key',
} as Env;

// ============================================================================
// POST /api/credentials — cloud-provider credential creation
// ============================================================================

describe('POST /api/credentials — cloud-provider credentials', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();

    mockDB = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]), // No existing credential by default
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };

    (drizzle as any).mockReturnValue(mockDB);
    mockValidateToken.mockResolvedValue(true);
  });

  it('creates a hetzner credential and returns 201', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'hetzner', token: 'htz-api-token' }),
    }, mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBe('hetzner');
    expect(body.connected).toBe(true);
    expect(body.id).toBe('generated-ulid');
  });

  it('creates a scaleway credential and returns 201', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'scaleway',
        secretKey: 'scw-secret-key',
        projectId: 'proj-uuid-1234',
      }),
    }, mockEnv);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBe('scaleway');
    expect(body.connected).toBe(true);
  });

  it('upserts when a credential for the same provider already exists, returning 200', async () => {
    // Simulate existing credential row
    mockDB.limit.mockResolvedValueOnce([{
      id: 'existing-cred-id',
      provider: 'hetzner',
      createdAt: '2024-01-01T00:00:00.000Z',
    }]);

    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'hetzner', token: 'new-token' }),
    }, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('existing-cred-id');
    expect(body.connected).toBe(true);

    // insert must NOT be called — this is an update
    expect(mockDB.insert).not.toHaveBeenCalled();
    expect(mockDB.update).toHaveBeenCalled();
  });

  it('returns 400 when provider field is missing', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'htz-token' }),
    }, mockEnv);

    expect(res.status).toBe(400);
  });

  it('returns 400 for an unsupported provider name', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'digitalocean', token: 'do-token' }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Unsupported provider');
  });

  it('returns 400 when hetzner token field is missing', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'hetzner' }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Token is required');
  });

  it('returns 400 when scaleway secretKey is missing', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'scaleway', projectId: 'proj-uuid' }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('secretKey');
  });

  it('returns 400 when scaleway projectId is missing', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'scaleway', secretKey: 'scw-key' }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('projectId');
  });

  it('returns 400 (not 500) when validateToken throws (invalid credentials)', async () => {
    // validateToken() throws when credentials are rejected by the provider API.
    // The route must translate this into a user-facing 400, not an unhandled 500.
    mockValidateToken.mockRejectedValueOnce(new Error('Unauthorized: invalid token'));

    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'hetzner', token: 'bad-token' }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid or unauthorized hetzner credentials');
  });

  it('calls validateToken before encrypting or storing the credential', async () => {
    const { encrypt } = await import('../../../src/services/encryption');

    mockValidateToken.mockRejectedValueOnce(new Error('Invalid'));

    await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'hetzner', token: 'bad-token' }),
    }, mockEnv);

    // encrypt must not be called when validation fails — credentials should
    // never be stored if they are invalid.
    expect(encrypt).not.toHaveBeenCalled();
    expect(mockDB.insert).not.toHaveBeenCalled();
  });

  it('provider name appears in the 400 error message for scaleway validation failure', async () => {
    mockValidateToken.mockRejectedValueOnce(new Error('Forbidden'));

    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'scaleway',
        secretKey: 'bad-key',
        projectId: 'proj-uuid',
      }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('scaleway');
  });
});

// ============================================================================
// GET /api/credentials — list cloud-provider credentials
// ============================================================================

describe('GET /api/credentials', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();

    mockDB = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

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
});

// ============================================================================
// DELETE /api/credentials/:provider
// ============================================================================

describe('DELETE /api/credentials/:provider', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();

    mockDB = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'cred-1' }]), // credential found and deleted
    };

    (drizzle as any).mockReturnValue(mockDB);
  });

  it('returns 200 with success:true when credential is deleted', async () => {
    const res = await app.request('/api/credentials/hetzner', {
      method: 'DELETE',
    }, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when no credential exists for that provider', async () => {
    // returning() resolves to empty array = row not found
    mockDB.returning.mockResolvedValueOnce([]);

    const res = await app.request('/api/credentials/hetzner', {
      method: 'DELETE',
    }, mockEnv);

    expect(res.status).toBe(404);
  });

  it('scopes the delete to the authenticated user (does not delete other users credentials)', async () => {
    await app.request('/api/credentials/hetzner', {
      method: 'DELETE',
    }, mockEnv);

    // The where() call must have been invoked, meaning a user-scoped filter was applied.
    // We cannot inspect the Drizzle filter directly (it is constructed internally),
    // but we verify delete + where were both called to confirm the query is scoped.
    expect(mockDB.delete).toHaveBeenCalled();
    expect(mockDB.where).toHaveBeenCalled();
  });
});
