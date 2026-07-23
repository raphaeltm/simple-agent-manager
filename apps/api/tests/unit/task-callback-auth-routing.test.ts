/**
 * Task Callback Auth Routing — Behavioral Tests
 *
 * Regression test for the middleware leak bug where projectsRoutes.use('/*', requireAuth())
 * intercepted the task callback endpoint (POST /:projectId/tasks/:taskId/status/callback)
 * causing all VM agent task callbacks to return 401 "Authentication required".
 *
 * These tests verify auth routing through the COMBINED app routes, not individual
 * subrouters — because the bug only manifests when subrouters are mounted together
 * at the same base path.
 *
 * See docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md
 * See .claude/rules/06-api-patterns.md (Hono middleware scoping)
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../src/lib/logger';
import { AppError } from '../../src/middleware/error';
import { verifyCallbackToken } from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';

// Mock better-auth before any route imports
vi.mock('../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  }),
}));

// Mock drizzle to return a task with the expected workspaceId
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: 'task-test',
                projectId: 'proj-test',
                userId: 'user-test',
                workspaceId: 'ws-test',
                status: 'running',
                title: 'Test task',
                taskMode: 'task',
              },
            ]),
          orderBy: () => Promise.resolve([]),
          // node-acp-heartbeat binds a workspace-scoped token to its node via this lookup:
          // workspace 'ws-test' lives on node 'node-test', so it may heartbeat 'node-test'.
          get: () => Promise.resolve({ nodeId: 'node-test' }),
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

// Mock JWT verification to accept any token (workspace-scoped) by default
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-test', type: 'callback', scope: 'workspace' }),
  signCallbackToken: vi.fn().mockResolvedValue('mock-token'),
  signNodeCallbackToken: vi.fn().mockResolvedValue('mock-node-token'),
}));

vi.mock('../../src/lib/logger', () => ({
  createModuleLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock project-data service
vi.mock('../../src/services/project-data', () => ({
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue('session-id'),
  stopSession: vi.fn().mockResolvedValue(undefined),
  markAgentCompleted: vi.fn().mockResolvedValue(undefined),
  scheduleIdleCleanup: vi.fn().mockResolvedValue(undefined),
  updateNodeHeartbeats: vi.fn().mockResolvedValue(0),
  getSessionsForIdea: vi.fn().mockResolvedValue([]),
}));

// Mock notification service
vi.mock('../../src/services/notification', () => ({
  getProjectName: vi.fn().mockResolvedValue('Test Project'),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  notifyTaskFailed: vi.fn().mockResolvedValue(undefined),
  notifySessionEnded: vi.fn().mockResolvedValue(undefined),
  notifyPrCreated: vi.fn().mockResolvedValue(undefined),
}));

// Mock task-runner
vi.mock('../../src/services/task-runner', () => ({
  cleanupTaskRun: vi.fn().mockResolvedValue(undefined),
}));

// Mock task status helpers
vi.mock('../../src/services/task-status', () => ({
  canTransitionTaskStatus: vi.fn().mockReturnValue(true),
  getAllowedTaskTransitions: vi.fn().mockReturnValue(['completed', 'failed']),
  isTaskStatus: vi.fn().mockReturnValue(true),
  isExecutableTaskStatus: vi.fn().mockReturnValue(true),
}));

// Mock observability
vi.mock('../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));

// Mock encryption service
vi.mock('../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ encrypted: '', iv: '' }),
  decrypt: vi.fn().mockResolvedValue(''),
}));

// Mock task graph
vi.mock('../../src/services/task-graph', () => ({
  wouldCreateTaskDependencyCycle: vi.fn().mockResolvedValue(false),
}));

// Mock boot-log
vi.mock('../../src/services/boot-log', () => ({
  appendBootLog: vi.fn().mockResolvedValue(undefined),
  writeBootLogs: vi.fn().mockResolvedValue(undefined),
  getBootLogs: vi.fn().mockResolvedValue([]),
}));

// Mock github-app
vi.mock('../../src/services/github-app', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('mock-gh-token'),
}));

// Mock node-agent
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

// Mock credentials route helper
vi.mock('../../src/routes/credentials', () => ({
  getDecryptedAgentKey: vi.fn().mockResolvedValue(null),
}));

// Mock task-runner-do
vi.mock('../../src/services/task-runner-do', () => ({
  advanceTaskRunnerWorkspaceReady: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Creates a test app with the COMBINED routes including both projectsRoutes
 * (which has the leaking middleware) and the extracted taskCallbackRoute.
 * The bug only manifests when mounted together.
 */
async function createTestApp(): Promise<Hono> {
  const { projectsRoutes } = await import('../../src/routes/projects/index');
  const { taskCallbackRoute, tasksRoutes } = await import('../../src/routes/tasks/index');
  const { nodeAcpHeartbeatRoute } = await import('../../src/routes/projects/node-acp-heartbeat');

  const app = new Hono();

  // Mirror the real mounting order from apps/api/src/index.ts
  // Callback-auth routes MUST come BEFORE projectsRoutes
  app.route('/api/projects', nodeAcpHeartbeatRoute);
  app.route('/api/projects', taskCallbackRoute);
  app.route('/api/projects', projectsRoutes);
  app.route('/api/projects/:projectId/tasks', tasksRoutes);

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  return app;
}

describe('task callback auth routing (regression)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestApp();
  });

  // =========================================================================
  // CRITICAL: Task callback endpoint must NOT be blocked by session auth
  // This is the exact regression test for the middleware leak bug.
  // =========================================================================

  it('POST /api/projects/:projectId/tasks/:taskId/status/callback with Bearer token is NOT blocked by session auth', async () => {
    const res = await app.request('/api/projects/proj-test/tasks/task-test/status/callback', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ toStatus: 'completed' }),
    });

    // MUST NOT be 401 "Authentication required" from requireAuth().
    // This was the exact production failure — projectsRoutes.use('/*', requireAuth())
    // leaked to the task callback route and rejected the VM agent's Bearer token.
    expect(res.status).not.toBe(401);
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');
  });

  it('POST callback without Bearer token does NOT return session auth error', async () => {
    const res = await app.request('/api/projects/proj-test/tasks/task-test/status/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ toStatus: 'completed' }),
    });

    // Key invariant: the request was NOT intercepted by session auth middleware.
    // It reaches the callback route handler (which may fail with missing Bearer token
    // or missing env bindings, but the error will NOT be "Authentication required").
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');
  });

  // =========================================================================
  // Session-auth endpoints must still require session auth
  // =========================================================================

  it('GET /api/projects without session returns 401 "Authentication required"', async () => {
    const res = await app.request('/api/projects', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe('Authentication required');
  });

  it('POST node ACP heartbeat logs project and node when the update fails', async () => {
    vi.mocked(projectDataService.updateNodeHeartbeats).mockRejectedValueOnce(
      new Error('Durable Object reset because its code was updated.')
    );

    const res = await app.request(
      '/api/projects/proj-test/node-acp-heartbeat',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-callback-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nodeId: 'node-test' }),
      },
      { DATABASE: {}, SESSIONS: {}, PROJECT_DATA: { idFromName: vi.fn() } }
    );

    expect(res.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith('acp_heartbeat.update_failed', {
      projectId: 'proj-test',
      nodeId: 'node-test',
      errorName: 'Error',
      errorMessage: 'Durable Object reset because its code was updated.',
    });
  });

  // =========================================================================
  // Callback's own auth gate: invalid Bearer token and workspace mismatch
  // =========================================================================

  it('POST callback with invalid Bearer token is handled by callback auth (not session auth)', async () => {
    // Override verifyCallbackToken to reject (simulating invalid JWT).
    // Use mockRejectedValue (not Once) to ensure it persists for this test's request.
    vi.mocked(verifyCallbackToken).mockRejectedValue(new AppError('Invalid callback token', 401));

    const res = await app.request(
      '/api/projects/proj-test/tasks/task-test/status/callback',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bad-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ toStatus: 'completed' }),
      },
      // Provide env bindings so c.env.DATABASE doesn't throw
      { DATABASE: {}, SESSIONS: {}, PROJECT_DATA: { idFromName: vi.fn() } }
    );

    // Key invariant: the error is NOT "Authentication required" from session auth.
    // The callback route's own JWT verification handles the invalid token.
    const body = await res.json();
    expect(body.message).not.toBe('Authentication required');

    // Restore default mock for other tests
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'ws-test',
      type: 'callback',
      scope: 'workspace',
    });
  });

  it('POST callback with workspace mismatch returns 403', async () => {
    // Token claims workspace 'ws-other' but the task is linked to 'ws-test'
    vi.mocked(verifyCallbackToken).mockResolvedValueOnce({
      workspace: 'ws-other',
      type: 'callback',
      scope: 'workspace',
    });

    const res = await app.request(
      '/api/projects/proj-test/tasks/task-test/status/callback',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-but-wrong-workspace',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ toStatus: 'completed' }),
      },
      // Provide env bindings so c.env.DATABASE doesn't throw
      { DATABASE: {}, SESSIONS: {}, PROJECT_DATA: { idFromName: vi.fn() } }
    );

    // The workspace mismatch check in callback.ts throws errors.forbidden()
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toBe('Token workspace mismatch');
  });
});
