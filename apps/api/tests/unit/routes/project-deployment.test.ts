import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/index';

/**
 * Behavioral tests for project-deployment routes.
 *
 * Covers: identity token endpoint, OAuth callback, GET/DELETE credential,
 * and the setup route's DB upsert.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockDelete = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: mockSelect,
    delete: mockDelete,
    insert: mockInsert,
    update: mockUpdate,
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));

vi.mock('../../../src/db/schema', () => ({
  projectDeploymentCredentials: {
    projectId: 'projectId',
    provider: 'provider',
  },
  workspaces: { id: 'id', projectId: 'projectId', userId: 'userId' },
  projects: { id: 'id' },
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'generated-ulid',
}));

const mockValidateMcpToken = vi.fn();
vi.mock('../../../src/services/mcp-token', () => ({
  validateMcpToken: (...args: unknown[]) => mockValidateMcpToken(...args),
}));

// verifyCallbackToken mock kept as a canary — the identity token endpoint must NOT
// import or call verifyCallbackToken. If a future change re-adds the import, this
// mock will intercept it and tests can assert it was never called.
const mockVerifyCallbackToken = vi.fn();
const mockSignIdentityToken = vi.fn();
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: unknown[]) => mockVerifyCallbackToken(...args),
  signIdentityToken: (...args: unknown[]) => mockSignIdentityToken(...args),
}));

const mockRunGcpDeploySetup = vi.fn();
vi.mock('../../../src/services/gcp-deploy-setup', () => ({
  runGcpDeploySetup: (...args: unknown[]) => mockRunGcpDeploySetup(...args),
}));

vi.mock('../../../src/services/gcp-setup', () => ({
  listGcpProjects: vi.fn().mockResolvedValue([]),
}));

const { projectDeploymentRoutes, gcpDeployCallbackRoute } = await import(
  '../../../src/routes/project-deployment'
);

// ─── Test Setup ─────────────────────────────────────────────────────────

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', projectDeploymentRoutes);
  app.route('/api/deployment', gcpDeployCallbackRoute);
  return app;
}

const mockKvGet = vi.fn();
const mockKvPut = vi.fn();
const mockKvDelete = vi.fn();

const mockEnv = {
  DATABASE: {} as any,
  KV: { get: mockKvGet, put: mockKvPut, delete: mockKvDelete } as any,
  BASE_DOMAIN: 'example.com',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
} as unknown as Env;

function chainMocks() {
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  // where() returns an object with limit() and is also thenable (for DELETE)
  const whereResult = {
    limit: mockLimit,
    then: (resolve: any) => resolve(undefined),
  };
  mockWhere.mockReturnValue(whereResult);
  mockDelete.mockReturnValue({ where: mockWhere });
  mockInsert.mockReturnValue({ values: mockValues });
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockLimit.mockResolvedValue([]);
  mockValues.mockResolvedValue(undefined);
}

const CRED_ROW = {
  id: 'cred-1',
  projectId: 'proj-1',
  provider: 'gcp',
  gcpProjectId: 'my-gcp-project',
  gcpProjectNumber: '123456',
  serviceAccountEmail: 'sa@my-gcp-project.iam.gserviceaccount.com',
  wifPoolId: 'sam-deploy-pool',
  wifProviderId: 'sam-oidc',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ─── Identity Token Endpoint Tests ──────────────────────────────────────

describe('GET /:id/deployment-identity-token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET' },
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Basic abc' } },
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when MCP token project does not match', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'other-project',
      userId: 'u1',
      workspaceId: 'ws-1',
    });

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when no deployment credential exists (MCP auth)', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    mockLimit.mockResolvedValue([]); // No credential

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(404);
  });

  it('returns signed identity token for valid MCP token', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    mockLimit.mockResolvedValue([CRED_ROW]);
    mockSignIdentityToken.mockResolvedValue('signed-jwt-123');

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: 'signed-jwt-123' });

    // Verify signIdentityToken was called with correct audience
    expect(mockSignIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        audience: expect.stringContaining('123456'),
      }),
      mockEnv,
      expect.any(Number),
    );
  });

  it('rejects non-MCP tokens with 403 and does not sign identity token', async () => {
    // MCP validation returns null for non-MCP tokens (including callback tokens)
    mockValidateMcpToken.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer callback-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain('MCP token');

    // Identity token must NOT be signed for non-MCP tokens
    expect(mockSignIdentityToken).not.toHaveBeenCalled();
  });

  it('rejects any random bearer token with 403', async () => {
    mockValidateMcpToken.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer random-invalid-token' } },
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it('returns 401 when Bearer token value is empty', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer ' } },
      mockEnv,
    );
    // 'Bearer ' without a token value fails the startsWith check
    expect(res.status).toBe(401);
    expect(mockSignIdentityToken).not.toHaveBeenCalled();
  });

  it('returns 500 when validateMcpToken throws (KV unavailable)', async () => {
    mockValidateMcpToken.mockRejectedValue(new Error('KV connection failed'));

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer any-token' } },
      mockEnv,
    );
    expect(res.status).toBe(500);
    expect(mockSignIdentityToken).not.toHaveBeenCalled();
  });

  it('returns 500 when signIdentityToken throws', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    mockLimit.mockResolvedValue([CRED_ROW]);
    mockSignIdentityToken.mockRejectedValue(new Error('JWT signing failed'));

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(500);
  });
});

// ─── Identity Token Rate Limiting & Caching ─────────────────────────────

describe('GET /:id/deployment-identity-token — rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });

    // Simulate an existing rate limit entry that has reached the limit
    // Default IDENTITY_TOKEN limit is 60
    mockKvGet.mockImplementation(async (key: string, format?: string) => {
      if (typeof key === 'string' && key.startsWith('ratelimit:identity-token:')) {
        if (format === 'json') {
          return { count: 60, windowStart: Math.floor(Date.now() / 1000 / 3600) * 3600 };
        }
      }
      return null;
    });

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('sets rate limit headers on successful requests', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    // No existing rate limit entry (first request) and no cached token
    mockKvGet.mockResolvedValue(null);
    mockLimit.mockResolvedValue([CRED_ROW]);
    mockSignIdentityToken.mockResolvedValue('signed-jwt-rl');

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('allows requests under the rate limit', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    // Simulate 5 previous requests in current window
    mockKvGet.mockImplementation(async (key: string, format?: string) => {
      if (typeof key === 'string' && key.startsWith('ratelimit:identity-token:')) {
        if (format === 'json') {
          return { count: 5, windowStart: Math.floor(Date.now() / 1000 / 3600) * 3600 };
        }
      }
      return null;
    });
    mockLimit.mockResolvedValue([CRED_ROW]);
    mockSignIdentityToken.mockResolvedValue('signed-jwt-ok');

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('54');
  });
});

describe('GET /:id/deployment-identity-token — token caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('returns cached token without signing when cache hit', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    // Rate limit check returns null (first request), cache returns a token
    mockKvGet.mockImplementation(async (key: string, _format?: string) => {
      if (typeof key === 'string' && key.startsWith('identity-token-cache:')) {
        return 'cached-jwt-token';
      }
      return null;
    });
    mockLimit.mockResolvedValue([CRED_ROW]);

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: 'cached-jwt-token' });
    // signIdentityToken should NOT have been called
    expect(mockSignIdentityToken).not.toHaveBeenCalled();
  });

  it('signs and caches token on cache miss', async () => {
    mockValidateMcpToken.mockResolvedValue({
      projectId: 'proj-1',
      userId: 'u1',
      workspaceId: 'ws-1',
    });
    // No rate limit entry, no cached token
    mockKvGet.mockResolvedValue(null);
    mockLimit.mockResolvedValue([CRED_ROW]);
    mockSignIdentityToken.mockResolvedValue('fresh-signed-jwt');

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment-identity-token',
      { method: 'GET', headers: { Authorization: 'Bearer mcp-token-1' } },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ token: 'fresh-signed-jwt' });
    expect(mockSignIdentityToken).toHaveBeenCalled();

    // Verify the token was cached in KV
    expect(mockKvPut).toHaveBeenCalledWith(
      expect.stringContaining('identity-token-cache:ws-1:'),
      'fresh-signed-jwt',
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });
});

// ─── GET credential ─────────────────────────────────────────────────────

describe('GET /:id/deployment/gcp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('returns { connected: false } when no credential exists', async () => {
    mockLimit.mockResolvedValue([]);

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment/gcp',
      { method: 'GET' },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ connected: false });
  });

  it('returns credential data when connected', async () => {
    mockLimit.mockResolvedValue([CRED_ROW]);

    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment/gcp',
      { method: 'GET' },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.provider).toBe('gcp');
    expect(body.gcpProjectId).toBe('my-gcp-project');
    expect(body.serviceAccountEmail).toBe('sa@my-gcp-project.iam.gserviceaccount.com');
  });
});

// ─── DELETE credential ──────────────────────────────────────────────────

describe('DELETE /:id/deployment/gcp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('returns success after deleting credential', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment/gcp',
      { method: 'DELETE' },
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalled();
  });
});

// ─── OAuth authorize ────────────────────────────────────────────────────

describe('GET /:id/deployment/gcp/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('redirects to Google OAuth with correct params and static redirect URI', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/projects/proj-1/deployment/gcp/authorize',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('accounts.google.com/o/oauth2');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform');
    expect(location).toContain('access_type=online');

    // Redirect URI must be static (no project ID) so a single URI works for all projects
    const redirectUri = encodeURIComponent('https://api.example.com/api/deployment/gcp/callback');
    expect(location).toContain(`redirect_uri=${redirectUri}`);

    // Should have stored state in KV
    expect(mockKvPut).toHaveBeenCalledWith(
      expect.stringContaining('gcp-deploy-oauth-state:'),
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });
});

// ─── OAuth callback ─────────────────────────────────────────────────────

describe('GET /api/deployment/gcp/callback (static URI)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainMocks();
  });

  it('redirects with error when Google returns error param', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/deployment/gcp/callback?error=access_denied',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('gcp_deploy_error=access_denied');
  });

  it('redirects with error when code or state is missing', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/deployment/gcp/callback?code=abc',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('gcp_deploy_error=');
  });

  it('redirects with error when state is not a valid UUID', async () => {
    const app = createTestApp();
    const res = await app.request(
      '/api/deployment/gcp/callback?code=abc&state=not-a-uuid',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('gcp_deploy_error=');
    // KV should never be queried with an invalid state format
    expect(mockKvGet).not.toHaveBeenCalled();
  });

  it('redirects with error when KV state is expired/missing', async () => {
    mockKvGet.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request(
      '/api/deployment/gcp/callback?code=abc&state=00000000-0000-0000-0000-000000000000',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('gcp_deploy_error=');
  });

  it('redirects with error when state userId does not match session and preserves state token', async () => {
    // KV returns state with a different userId than the session (test-user-id)
    mockKvGet.mockResolvedValue(
      JSON.stringify({ projectId: 'proj-1', userId: 'different-user' }),
    );

    const app = createTestApp();
    const res = await app.request(
      '/api/deployment/gcp/callback?code=abc&state=11111111-1111-1111-1111-111111111111',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('gcp_deploy_error=');
    expect(location).toContain('user%20mismatch');

    // State token must NOT be deleted on user mismatch — the legitimate user can still retry
    expect(mockKvDelete).not.toHaveBeenCalled();
  });

  it('redirects to correct project settings using projectId from KV state', async () => {
    // KV state has projectId — this is the ONLY source of project context
    mockKvGet.mockResolvedValue(
      JSON.stringify({ projectId: 'proj-from-state', userId: 'test-user-id' }),
    );

    // Mock successful token exchange
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'gcp-token-123' }), { status: 200 }),
    );

    const app = createTestApp();
    const res = await app.request(
      '/api/deployment/gcp/callback?code=abc&state=11111111-1111-1111-1111-111111111111',
      { method: 'GET', redirect: 'manual' },
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;

    // Redirect goes to the project from KV state, not from URL
    expect(location).toContain('/projects/proj-from-state/settings');
    expect(location).toContain('gcp_deploy_setup=');

    // Token exchange uses the static redirect URI
    const fetchCall = mockFetch.mock.calls[0]!;
    const body = fetchCall[1]!.body as URLSearchParams;
    expect(body.get('redirect_uri')).toBe('https://api.example.com/api/deployment/gcp/callback');

    mockFetch.mockRestore();
  });
});
