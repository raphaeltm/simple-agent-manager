/**
 * Workspace Callback Auth Routing — Behavioral Tests
 *
 * Regression test for the middleware leak bug where crudRoutes.use('/*', requireAuth())
 * intercepted callback-authenticated endpoints (ready, provisioning-failed, agent-key, etc.)
 * causing all VM→API callbacks to return 401.
 *
 * These tests verify auth routing through the COMBINED workspacesRoutes app,
 * not individual subrouters — because the bug only manifests when subrouters
 * are mounted together at the same base path.
 *
 * See docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { AppError } from '../../src/middleware/error';

// Mock better-auth before any route imports
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
          limit: () => Promise.resolve([{ id: 'ws-test', status: 'creating', nodeId: 'node-test' }]),
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

// Mock JWT verification to accept any token
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn().mockResolvedValue({ workspace: 'ws-test' }),
  signCallbackToken: vi.fn().mockResolvedValue('mock-token'),
}));

// Mock task-runner-do service
vi.mock('../../src/services/task-runner-do', () => ({
  advanceTaskRunnerWorkspaceReady: vi.fn().mockResolvedValue(undefined),
}));

// Mock boot-log service
vi.mock('../../src/services/boot-log', () => ({
  appendBootLog: vi.fn().mockResolvedValue(undefined),
  writeBootLogs: vi.fn().mockResolvedValue(undefined),
  getBootLogs: vi.fn().mockResolvedValue([]),
}));

// Mock encryption service
vi.mock('../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ encrypted: '', iv: '' }),
  decrypt: vi.fn().mockResolvedValue(''),
}));

// Mock github-app service
vi.mock('../../src/services/github-app', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('mock-gh-token'),
}));

// Mock node-agent service
vi.mock('../../src/services/node-agent', () => ({
  createWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  deleteWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  waitForNodeAgentReady: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  restartWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  rebuildWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  createAgentSessionOnNode: vi.fn().mockResolvedValue(undefined),
  stopAgentSessionOnNode: vi.fn().mockResolvedValue(undefined),
  suspendAgentSessionOnNode: vi.fn().mockResolvedValue(undefined),
  resumeAgentSessionOnNode: vi.fn().mockResolvedValue(undefined),
}));

// Mock observability
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

// Mock project-data service
vi.mock('../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue('session-id'),
}));

// Mock credentials route helper
vi.mock('../../src/routes/credentials', () => ({
  getDecryptedAgentKey: vi.fn().mockResolvedValue(null),
}));

/**
 * Creates a test Hono app with the combined workspace routes and proper error handling.
 */
async function createTestApp(): Promise<Hono> {
  const { workspacesRoutes } = await import('../../src/routes/workspaces/index');

  const app = new Hono();
  app.route('/api/workspaces', workspacesRoutes);

  // Mirror the real app's error handler (uses AppError)
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  return app;
}

describe('workspace callback auth routing (regression)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestApp();
  });

  // =========================================================================
  // CRITICAL: Callback-authenticated endpoints must NOT be blocked by session auth
  // These are the regression tests — they would have caught the original bug.
  // =========================================================================

  it('POST /:id/provisioning-failed with Bearer token is NOT blocked by session auth', async () => {
    const res = await app.request('/api/workspaces/ws-test/provisioning-failed', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ errorMessage: 'devcontainer build failed' }),
    });

    // MUST NOT be 401 "Authentication required" from requireAuth().
    // This was the exact production failure — crudRoutes middleware intercepted this.
    expect(res.status).not.toBe(401);
  });

  it('POST /:id/ready with Bearer token is NOT blocked by session auth', async () => {
    const res = await app.request('/api/workspaces/ws-test/ready', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'running' }),
    });

    expect(res.status).not.toBe(401);
  });

  it('POST /:id/agent-key with Bearer token is NOT blocked by session auth', async () => {
    const res = await app.request('/api/workspaces/ws-test/agent-key', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentType: 'claude-code' }),
    });

    expect(res.status).not.toBe(401);
  });

  // =========================================================================
  // Callback endpoints must reject requests without valid Bearer token
  // =========================================================================

  it('POST /:id/provisioning-failed without Bearer token does NOT return session auth error', async () => {
    const res = await app.request('/api/workspaces/ws-test/provisioning-failed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ errorMessage: 'test' }),
    });

    // The key invariant: the request was NOT intercepted by session auth middleware.
    // It reaches the lifecycle handler (which may fail due to missing env bindings in test,
    // but the error will be something other than "Authentication required").
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');
  });

  it('POST /:id/ready without Bearer token does NOT return session auth error', async () => {
    const res = await app.request('/api/workspaces/ws-test/ready', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'running' }),
    });

    // Same invariant: NOT blocked by session auth
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');
  });

  // =========================================================================
  // CRUD endpoints must still require session auth
  // =========================================================================

  it('GET /:id without session returns 401 "Authentication required"', async () => {
    const res = await app.request('/api/workspaces/some-id', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Authentication required');
  });

  it('DELETE /:id without session returns 401 "Authentication required"', async () => {
    const res = await app.request('/api/workspaces/some-id', {
      method: 'DELETE',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Authentication required');
  });
});
