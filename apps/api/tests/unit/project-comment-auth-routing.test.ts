/**
 * Project comment auth routing.
 *
 * `projectCommentRoutes` intentionally relies on the `/api/projects` auth
 * middleware mounted by `projectsRoutes` before it. This test exercises that
 * combined routing shape: a valid BetterAuth session must be projected onto the
 * Hono context before the project comments handler calls `getUserId`.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';

const harness = vi.hoisted(() => ({
  getSession: vi.fn(),
  requireProjectCapability: vi.fn(),
  listProjectCommentInbox: vi.fn(),
}));

vi.mock('../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: harness.getSession,
    },
  }),
}));

vi.mock(
  'cloudflare:workers',
  () => ({
    DurableObject: class DurableObject {},
  }),
  { virtual: true }
);

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
}));

vi.mock('@cloudflare/containers', () => ({
  Container: class Container {},
  switchPort: vi.fn((request: Request) => request),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(),
}));

vi.mock('../../src/services/signup-approval', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/signup-approval')>(
    '../../src/services/signup-approval'
  );
  return {
    ...actual,
    isSignupApprovalRequired: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../../src/middleware/project-auth', async () => {
  const actual = await vi.importActual<typeof import('../../src/middleware/project-auth')>(
    '../../src/middleware/project-auth'
  );
  return {
    ...actual,
    requireProjectCapability: harness.requireProjectCapability,
  };
});

vi.mock('../../src/services/project-data', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/project-data')>(
    '../../src/services/project-data'
  );
  return {
    ...actual,
    listProjectCommentInbox: harness.listProjectCommentInbox,
  };
});

import { projectCommentRoutes } from '../../src/routes/project-comments';
import { projectsRoutes } from '../../src/routes/projects';

const worker = await import('../../src/index');

function createCombinedApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  // Mirror the production-relevant mount order from apps/api/src/index.ts.
  app.route('/api/projects', projectsRoutes);
  app.route('/api/projects/:projectId/comments', projectCommentRoutes);
  return app;
}

describe('project comment auth routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getSession.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'ada@example.test',
        name: 'Ada',
        image: null,
        role: 'user',
        status: 'active',
      },
      session: {
        id: 'session-1',
        token: 'session-token',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    harness.requireProjectCapability.mockResolvedValue({ id: 'project-a' });
    harness.listProjectCommentInbox.mockResolvedValue({
      messageThreads: [],
      fileThreads: [],
      sessions: [],
      hasMore: false,
      totalCount: 0,
    });
    vi.mocked(drizzle).mockReturnValue({
      query: {
        projectFiles: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
    } as never);
  });

  it('inherits session auth from projectsRoutes in the combined app', async () => {
    const app = createCombinedApp();

    const response = await app.request('/api/projects/project-a/comments', { method: 'GET' }, {
      DATABASE: {},
    } as Env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      messageThreads: [],
      fileThreads: [],
      totalCount: 0,
      hasMore: false,
    });
    expect(harness.getSession).toHaveBeenCalled();
    expect(harness.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-a',
      'user-1',
      'task:read'
    );
    expect(harness.listProjectCommentInbox).toHaveBeenCalledWith(
      expect.anything(),
      'project-a',
      expect.any(Object)
    );
  });

  it('keeps the real worker mount order that makes auth inheritance work', async () => {
    harness.getSession.mockResolvedValueOnce(null);

    const unauthenticated = await worker.default.fetch(
      new Request('https://api.example.test/api/projects/project-a/comments'),
      { DATABASE: {} } as Env
    );

    expect(unauthenticated.status).toBe(401);
    expect(harness.requireProjectCapability).not.toHaveBeenCalled();
    expect(harness.listProjectCommentInbox).not.toHaveBeenCalled();

    const authenticated = await worker.default.fetch(
      new Request('https://api.example.test/api/projects/project-a/comments'),
      { DATABASE: {} } as Env
    );

    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({
      messageThreads: [],
      fileThreads: [],
      totalCount: 0,
      hasMore: false,
    });
    expect(harness.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-a',
      'user-1',
      'task:read'
    );
    expect(harness.listProjectCommentInbox).toHaveBeenCalledWith(
      expect.anything(),
      'project-a',
      expect.any(Object)
    );
  });
});
