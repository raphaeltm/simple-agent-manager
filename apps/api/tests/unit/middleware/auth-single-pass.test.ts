/**
 * One auth pass per request.
 *
 * `projectsRoutes` registers `use('/*', requireAuth(), requireApproved())`, which Hono
 * compiles to a middleware at `/api/projects/*`. That pattern ALSO matches the separately
 * mounted `/api/projects/:projectId/{tasks,sessions,library,…}` routers, and those register
 * auth again — so the whole auth stack ran twice on every project sub-route request. Each
 * pass costs a `getSession` (2 sequential D1 queries) plus a signup-approval read, and
 * SAM's D1 primary is ~140 ms away from the Worker.
 *
 * The first test pins the PREMISE (both layers really are entered — this is not something
 * to take from Hono's docs), the rest pin the FIX.
 *
 * The fix is memoisation inside the middleware rather than deleting the duplicate
 * registrations: a route that loses its only auth registration is a security hole, and the
 * mounting order is what keeps VM-agent callback routes on callback-JWT auth
 * (`.claude/rules/34`). `tests/workers/d1-request-session.test.ts` carries the matching
 * real-trigger control pair through the actual app.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  getSessionCalls: 0,
  approvalReads: 0,
  session: null as unknown,
}));

vi.mock('../../../src/auth', () => ({
  createAuth: async () => ({
    api: {
      getSession: async () => {
        probe.getSessionCalls += 1;
        return probe.session;
      },
    },
  }),
}));

vi.mock('../../../src/services/signup-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/signup-approval')>();
  return {
    ...actual,
    isSignupApprovalRequired: async () => {
      probe.approvalReads += 1;
      return false;
    },
  };
});

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { getUserId, requireApproved, requireAuth } from '../../../src/middleware/auth';

const ACTIVE_SESSION = {
  user: {
    id: 'user-1',
    email: 'user-1@example.com',
    name: 'User One',
    image: null,
    role: 'user',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  session: {
    id: 'sess-1',
    token: 'token-1',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  },
};

/**
 * The production mounting shape, verbatim: a `/api/projects` router carrying a `use('/*')`
 * auth middleware, plus sibling routers mounted under `/api/projects/:projectId/...` that
 * register auth of their own (per-handler in `tasks/crud.ts`, `use('/*')` in `chat.ts`).
 */
function buildApp(layerLog: string[]): Hono<{ Bindings: Env }> {
  const trace = (tag: string) => async (_c: unknown, next: () => Promise<void>) => {
    layerLog.push(tag);
    await next();
  };

  const projectsRoutes = new Hono<{ Bindings: Env }>();
  projectsRoutes.use('/*', trace('projectsRoutes:/*'), requireAuth(), requireApproved());
  projectsRoutes.get('/:projectId', (c) => c.json({ scope: 'project', userId: getUserId(c) }));

  // tasks/crud.ts — auth registered per handler.
  const tasksRoutes = new Hono<{ Bindings: Env }>();
  tasksRoutes.get('/', trace('tasks:handler'), requireAuth(), requireApproved(), (c) =>
    c.json({ scope: 'tasks', userId: getUserId(c) })
  );

  // chat.ts — auth registered as its own wildcard middleware.
  const chatRoutes = new Hono<{ Bindings: Env }>();
  chatRoutes.use('/*', trace('chat:/*'), requireAuth(), requireApproved());
  chatRoutes.get('/:sessionId', (c) => c.json({ scope: 'session', userId: getUserId(c) }));

  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects', projectsRoutes);
  app.route('/api/projects/:projectId/tasks', tasksRoutes);
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

const env = { BASE_DOMAIN: 'example.test' } as unknown as Env;

describe('auth middleware runs once per request', () => {
  let layerLog: string[];
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    probe.getSessionCalls = 0;
    probe.approvalReads = 0;
    probe.session = ACTIVE_SESSION;
    layerLog = [];
    app = buildApp(layerLog);
  });

  it('PREMISE: the production mounting enters BOTH auth layers on a project sub-route', async () => {
    const res = await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);

    expect(res.status).toBe(200);
    // If this ever records a single layer, the duplicate-auth problem has gone away by
    // some other means and the memoisation below is no longer load-bearing.
    expect(layerLog).toEqual(['projectsRoutes:/*', 'tasks:handler']);
  });

  it.each([
    ['tasks list', 'http://api.example.test/api/projects/p1/tasks', 'tasks'],
    ['chat session', 'http://api.example.test/api/projects/p1/sessions/s1', 'session'],
  ])(
    'resolves the session exactly once for %s despite two registrations',
    async (_label, url, scope) => {
      const res = await app.request(url, {}, env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ scope, userId: 'user-1' });
      expect(probe.getSessionCalls).toBe(1);
      expect(probe.approvalReads).toBe(1);
    }
  );

  it('still resolves exactly once on a route with a single registration', async () => {
    const res = await app.request('http://api.example.test/api/projects/p1', {}, env);

    expect(res.status).toBe(200);
    expect(probe.getSessionCalls).toBe(1);
    expect(probe.approvalReads).toBe(1);
  });

  it('rejects an unauthenticated request and does not reach the handler', async () => {
    probe.session = null;

    const res = await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);

    expect(res.status).toBe(401);
    // Liveness beside the absence assertion: the first layer really was entered, so the 401
    // is a rejection rather than a route that never matched.
    expect(layerLog).toEqual(['projectsRoutes:/*']);
  });

  it('rejects a suspended account before any handler runs', async () => {
    probe.session = {
      ...ACTIVE_SESSION,
      user: { ...ACTIVE_SESSION.user, status: 'suspended' },
    };

    const res = await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);

    expect(res.status).toBe(403);
    expect(probe.getSessionCalls).toBe(1);
  });

  it('does not leak the memo across requests', async () => {
    await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);
    expect(probe.getSessionCalls).toBe(1);

    await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);
    expect(probe.getSessionCalls).toBe(2);
    expect(probe.approvalReads).toBe(2);
  });

  it('re-reads approval on the next request so a flipped gate takes effect immediately', async () => {
    const first = await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);
    expect(first.status).toBe(200);
    expect(probe.approvalReads).toBe(1);

    // An admin turns signup approval on; the user is pending, so the very next request is
    // denied. A per-isolate cache would have kept them in for the TTL
    // (`.claude/rules/02` — Unconditional Account-Denial Gates).
    const signupApproval = await import('../../../src/services/signup-approval');
    vi.spyOn(signupApproval, 'isSignupApprovalRequired').mockResolvedValue(true);
    probe.session = {
      ...ACTIVE_SESSION,
      user: { ...ACTIVE_SESSION.user, status: 'pending' },
    };

    const second = await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);
    expect(second.status).toBe(403);
    vi.restoreAllMocks();
  });
});
