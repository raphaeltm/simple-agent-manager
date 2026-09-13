/**
 * One auth pass per request.
 *
 * `projectsRoutes` registers `use('/*', requireAuth(), requireApproved())`, which Hono
 * compiles to a middleware at `/api/projects/*`. That pattern ALSO matches the separately
 * mounted `/api/projects/:projectId/{tasks,sessions,library,…}` routers, and those register
 * auth again — so the whole auth stack ran repeatedly on every project sub-route request.
 * Measured against the real routers it is entered FOUR times, not the two a reading of the
 * mounting suggests, because routers composed inside `projectsRoutes` register auth of their
 * own as well. Each
 * pass costs a `getSession` (2 sequential D1 queries) plus a signup-approval read, and
 * SAM's D1 primary is ~140 ms away from the Worker.
 *
 * The first test pins the PREMISE (the layers really are entered — this is not something
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
  /* How many times each middleware was ENTERED — memoisation lives inside, so these keep
   * counting registrations while `getSessionCalls` counts actual D1 work. */
  authLayerEntries: 0,
  approvedLayerEntries: 0,
  session: null as unknown,
}));

/*
 * Wrap the two middleware factories so entry is observable without changing behaviour. The
 * real `requireAuth()`/`requireApproved()` closures are what actually run; this only counts
 * how many times production routing enters them.
 */
vi.mock('../../../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      const middleware = actual.requireAuth();
      return async (
        c: Parameters<typeof middleware>[0],
        next: Parameters<typeof middleware>[1]
      ) => {
        probe.authLayerEntries += 1;
        return middleware(c, next);
      };
    },
    requireApproved: () => {
      const middleware = actual.requireApproved();
      return async (
        c: Parameters<typeof middleware>[0],
        next: Parameters<typeof middleware>[1]
      ) => {
        probe.approvedLayerEntries += 1;
        return middleware(c, next);
      };
    },
  };
});

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

/**
 * `buildApp` above MIRRORS the production mounting so the layer trace is observable. A mirror
 * is only worth anything while it stays faithful, so this block drops the mirror entirely and
 * drives the REAL routers — `projectsRoutes`, `tasksRoutes` and `chatRoutes` — mounted exactly
 * as `src/index.ts` mounts them.
 *
 * An earlier cut of this asserted the registration shapes by reading the router sources and
 * matching substrings. That is the source-contract pattern `.claude/rules/02` bans (CI's
 * `quality:source-contract-tests` rejects it), and it was worse than this on the merits: it
 * pinned the SPELLING of three lines, so reformatting would have failed it while a genuine
 * routing change made through a different expression would have sailed past. Importing the
 * real routers turned out to be cheap — the assumption that it "pulls in most of the app" was
 * never measured, and is wrong.
 */
describe('the REAL production routers, mounted as index.ts mounts them', () => {
  /** `src/index.ts:816-819`, the three mounts that produce the overlap. */
  async function buildRealApp(): Promise<Hono<{ Bindings: Env }>> {
    const [{ projectsRoutes }, { tasksRoutes }, { chatRoutes }] = await Promise.all([
      import('../../../src/routes/projects/index'),
      import('../../../src/routes/tasks'),
      import('../../../src/routes/chat'),
    ]);

    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/projects', projectsRoutes);
    app.route('/api/projects/:projectId/tasks', tasksRoutes);
    app.route('/api/projects/:projectId/sessions', chatRoutes);
    return app;
  }

  beforeEach(() => {
    probe.getSessionCalls = 0;
    probe.approvalReads = 0;
    probe.authLayerEntries = 0;
    probe.approvedLayerEntries = 0;
    probe.session = ACTIVE_SESSION;
  });

  it('PREMISE: a project sub-route enters the auth stack FOUR times', async () => {
    const app = await buildRealApp();
    await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);

    // This is the defect, observed through production routing rather than asserted from
    // Hono's docs or from a mirror. If it ever reads 1, the duplication has gone away by
    // some other means and the memoisation below has stopped being load-bearing.
    // FOUR, not two. The hand-written mirror above models two layers, which is what a
    // reading of the mounting suggests; production actually enters the stack four times
    // because routers composed INSIDE projectsRoutes register auth of their own on top of
    // its `use('/*')` and the sub-router's. This number is the reason the mirror could not
    // be trusted to stand in for the real thing.
    expect(probe.authLayerEntries).toBe(4);
    expect(probe.approvedLayerEntries).toBe(4);
  });

  it('THE FIX: those two layers resolve the session exactly once', async () => {
    const app = await buildRealApp();
    await app.request('http://api.example.test/api/projects/p1/tasks', {}, env);

    expect(probe.getSessionCalls).toBe(1);
    expect(probe.approvalReads).toBe(1);
  });

  it('and the same holds for the chat sub-router, which registers auth as a wildcard', async () => {
    const app = await buildRealApp();
    await app.request('http://api.example.test/api/projects/p1/sessions/s1', {}, env);

    expect(probe.authLayerEntries).toBe(4);
    expect(probe.getSessionCalls).toBe(1);
  });

  it('CONTROL: a bare /api/projects route enters ONE layer and still resolves once', async () => {
    // Without this, "exactly once" would also pass on an app whose sub-router mounting was
    // broken outright — the count would be 1 because only one layer ever ran.
    const app = await buildRealApp();
    await app.request('http://api.example.test/api/projects', {}, env);

    expect(probe.authLayerEntries).toBe(1);
    expect(probe.getSessionCalls).toBe(1);
  });
});

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

  it('PREMISE: the mirrored mounting enters both of ITS auth layers', async () => {
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
