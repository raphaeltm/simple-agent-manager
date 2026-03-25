/**
 * Deployment Identity Token Auth Routing — Behavioral Tests
 *
 * Regression test for the middleware leak bug where projectsRoutes.use('/*', requireAuth())
 * intercepted the deployment-identity-token endpoint (which uses MCP Bearer token auth),
 * causing GCP client libraries to get 401 "Authentication required".
 *
 * These tests verify auth routing through the COMBINED app routes,
 * not individual subrouters — because the bug only manifests when subrouters
 * are mounted together at the same base path.
 *
 * See docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md
 * See docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md (same bug class)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { AppError } from '../../src/middleware/error';

// Mock better-auth before any route imports — returns null session (unauthenticated)
vi.mock('../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  }),
}));

// Mock drizzle to prevent D1 binding errors
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 'cred-1',
            projectId: 'proj-test',
            provider: 'gcp',
            gcpProjectId: 'my-gcp-project',
            gcpProjectNumber: '123456',
            serviceAccountEmail: 'sa@test.iam.gserviceaccount.com',
            wifPoolId: 'sam-pool',
            wifProviderId: 'sam-provider',
          }]),
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve(),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  }),
}));

// Mock MCP token validation — accepts any token and returns valid data
vi.mock('../../src/services/mcp-token', () => ({
  validateMcpToken: vi.fn().mockResolvedValue({
    taskId: 'task-test',
    projectId: 'proj-test',
    userId: 'user-test',
    workspaceId: 'ws-test',
    createdAt: new Date().toISOString(),
  }),
}));

// Mock JWT signing for identity token
vi.mock('../../src/services/jwt', () => ({
  signIdentityToken: vi.fn().mockResolvedValue('mock-identity-token-jwt'),
  verifyCallbackToken: vi.fn().mockResolvedValue(null),
  signCallbackToken: vi.fn().mockResolvedValue('mock-token'),
}));

// Mock rate limiter to always allow
vi.mock('../../src/middleware/rate-limit', async () => {
  const actual = await vi.importActual('../../src/middleware/rate-limit');
  return {
    ...actual,
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetAt: Math.floor(Date.now() / 1000) + 60 }),
  };
});

// Mock observability
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

// Mock project-data service
vi.mock('../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue('session-id'),
}));

// Mock encryption service
vi.mock('../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ encrypted: '', iv: '' }),
  decrypt: vi.fn().mockResolvedValue(''),
}));

// Mock GCP services
vi.mock('../../src/services/gcp-setup', () => ({
  listGcpProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/gcp-deploy-setup', () => ({
  runGcpDeploySetup: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/services/gcp-errors', () => ({
  toSanitizedAppError: vi.fn((err: Error) => err),
}));

/**
 * Creates a test Hono app that mirrors the REAL app's route mounting order.
 * The bug only manifests when projectsRoutes and deploymentIdentityTokenRoute
 * are mounted at the same base path in the combined app.
 */
async function createTestApp(): Promise<Hono> {
  const { projectsRoutes } = await import('../../src/routes/projects/index');
  const { deploymentIdentityTokenRoute, projectDeploymentRoutes } = await import('../../src/routes/project-deployment');

  const app = new Hono();

  // Mirror the real index.ts mount order:
  // deploymentIdentityTokenRoute BEFORE projectsRoutes (the fix)
  app.route('/api/projects', deploymentIdentityTokenRoute);
  app.route('/api/projects', projectsRoutes);
  app.route('/api/projects', projectDeploymentRoutes);

  // Mirror the real app's error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  return app;
}

describe('deployment-identity-token auth routing (regression)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestApp();
  });

  // =========================================================================
  // CRITICAL: Identity token endpoint must NOT be blocked by session auth
  // This is the regression test — it would have caught the original bug.
  // =========================================================================

  it('GET /:id/deployment-identity-token with MCP Bearer token is NOT blocked by session auth', async () => {
    const res = await app.request('/api/projects/proj-test/deployment-identity-token', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer valid-mcp-token',
      },
    });

    // MUST NOT be 401 "Authentication required" from projectsRoutes requireAuth().
    // This was the exact production failure — projectsRoutes middleware intercepted this.
    expect(res.status).not.toBe(401);

    // Verify the response body does not contain the session auth error message
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');
  });

  it('GET /:id/deployment-identity-token with MCP Bearer token reaches endpoint handler (not blocked)', async () => {
    const res = await app.request('/api/projects/proj-test/deployment-identity-token', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer valid-mcp-token',
      },
    });

    // The handler reaches the MCP auth code and tries to use env bindings (KV, DATABASE)
    // which are undefined in unit tests. But the critical assertion is that we got past
    // the session auth middleware — a 500 from missing env bindings is acceptable here.
    // A 401 "Authentication required" would mean the middleware leak is still present.
    const body = await res.json();
    if (res.status !== 200) {
      // If we got a non-200, it should be from missing env bindings, NOT session auth
      expect(body.message).not.toBe('Authentication required');
    }
  });

  it('GET /:id/deployment-identity-token without Bearer token is NOT intercepted by session auth', async () => {
    const res = await app.request('/api/projects/proj-test/deployment-identity-token', {
      method: 'GET',
      // No Authorization header
    });

    // The key invariant: the request was NOT intercepted by session auth middleware.
    // It reaches the identity token handler which either returns its own auth error
    // or fails on missing env bindings — but NOT "Authentication required" from requireAuth().
    // NOTE: Cannot assert status=401 because drizzle(c.env.DATABASE) is called before the
    // auth check and c.env.DATABASE is undefined in unit tests, causing a 500.
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');
  });

  // =========================================================================
  // Session-auth routes must still require session auth
  // =========================================================================

  it('GET /:id (project CRUD) without session returns 401 "Authentication required"', async () => {
    const res = await app.request('/api/projects/some-id', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Authentication required');
  });

  it('GET /:id/deployment/gcp without session returns 401 "Authentication required"', async () => {
    const res = await app.request('/api/projects/some-id/deployment/gcp', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Authentication required');
  });
});
