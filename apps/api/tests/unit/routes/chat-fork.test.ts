import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import { createMemoryKv } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  getUserId: vi.fn(),
  requireProjectCapability: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  ensureSessionTaskBacked: vi.fn(),
  summarizeSession: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/middleware/auth', () => ({ getUserId: mocks.getUserId }));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-data', () => ({
  getSession: mocks.getSession,
  getMessages: mocks.getMessages,
}));
vi.mock('../../../src/services/session-task-repair', () => ({
  ensureSessionTaskBacked: mocks.ensureSessionTaskBacked,
}));
vi.mock('../../../src/services/session-summarize', () => ({
  getSummarizeConfig: vi.fn(() => ({})),
  summarizeSession: mocks.summarizeSession,
}));

import { chatForkRoutes } from '../../../src/routes/chat-fork';

/**
 * Mounted the way production mounts it: behind a context that carries the authenticated user
 * (`requireAuth` in `chatRoutes`), with the real global error handler.
 */
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: mocks.getUserId(),
        email: null,
        name: null,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  app.route('/api/projects/:projectId/sessions', chatForkRoutes);
  return app;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { DATABASE: {}, KV: createMemoryKv(), ...overrides } as Env;
}

describe('chatForkRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue({});
    mocks.getUserId.mockReturnValue('forking-user');
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      topic: 'Source chat',
      taskId: null,
      createdByUserId: 'source-creator',
    });
    mocks.getMessages.mockResolvedValue({
      messages: [{ role: 'user', content: 'Original prompt', createdAt: 1 }],
    });
    mocks.ensureSessionTaskBacked.mockResolvedValue({
      id: 'parent-task',
      title: 'Source chat',
      description: 'Original prompt',
      outputBranch: 'sam/source',
      outputPrUrl: null,
      outputSummary: null,
    });
    mocks.summarizeSession.mockResolvedValue({ summary: 'Source summary', messageCount: 1 });
  });

  it('prepares a fork for an authorized teammate and preserves source creator attribution', async () => {
    const res = await makeApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/fork-prepare',
      { method: 'POST' },
      makeEnv()
    );

    expect(res.status).toBe(200);
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'forking-user',
      'task:write'
    );
    expect(mocks.ensureSessionTaskBacked).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        fallbackUserId: 'source-creator',
      }
    );
    await expect(res.json()).resolves.toMatchObject({
      parentTaskId: 'parent-task',
      parentSessionId: 'session-1',
      repaired: true,
    });
  });

  it('returns not found without attempting legacy repair for a missing session', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const res = await makeApp().request(
      'https://api.test/api/projects/project-1/sessions/missing/fork-prepare',
      { method: 'POST' },
      makeEnv()
    );

    expect(res.status).toBe(404);
    expect(mocks.ensureSessionTaskBacked).not.toHaveBeenCalled();
  });

  it('summarizes a session for Retry', async () => {
    const res = await makeApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/summarize',
      { method: 'POST' },
      makeEnv()
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ summary: 'Source summary' });
  });
});

describe('session summarization rate limit (fork-prepare + summarize)', () => {
  type Route = 'fork-prepare' | 'summarize';

  function call(app: Hono<{ Bindings: Env }>, env: Env, route: Route) {
    return app.request(
      `https://api.test/api/projects/project-1/sessions/session-1/${route}`,
      { method: 'POST' },
      env
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T10:15:00Z'));
    mocks.drizzle.mockReturnValue({});
    mocks.getUserId.mockReturnValue('user-a');
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      taskId: null,
      createdByUserId: 'user-a',
    });
    mocks.getMessages.mockResolvedValue({
      messages: [{ role: 'user', content: 'Original prompt', createdAt: 1 }],
    });
    mocks.ensureSessionTaskBacked.mockResolvedValue({ id: 'parent-task', title: 'Source chat' });
    mocks.summarizeSession.mockResolvedValue({ summary: 'Source summary', messageCount: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits the default hourly budget across both routes, then rejects without calling Workers AI', async () => {
    // No override: the shipped default decides, resolved through the real `getRateLimit`.
    const app = makeApp();
    const env = makeEnv();
    const budget = DEFAULT_RATE_LIMITS.SESSION_SUMMARIZE;
    expect(budget).toBe(30);

    for (let index = 0; index < budget; index += 1) {
      const res = await call(app, env, index % 2 === 0 ? 'fork-prepare' : 'summarize');
      expect(res.status).toBe(200);
    }
    expect(mocks.summarizeSession).toHaveBeenCalledTimes(budget);

    for (const route of ['fork-prepare', 'summarize'] as const) {
      const rejected = await call(app, env, route);
      expect(rejected.status).toBe(429);
      await expect(rejected.json()).resolves.toMatchObject({ error: 'RATE_LIMIT_EXCEEDED' });
      // 10:15:00 inside the 10:00–11:00 window: 45 minutes until the bucket refills.
      expect(rejected.headers.get('Retry-After')).toBe(String(45 * 60));
      expect(rejected.headers.get('X-RateLimit-Remaining')).toBe('0');
    }
    expect(mocks.summarizeSession).toHaveBeenCalledTimes(budget);
    expect(mocks.ensureSessionTaskBacked).toHaveBeenCalledTimes(budget / 2);
  });

  it('spends one bucket for both routes, so fork-prepare cannot refill what summarize used', async () => {
    const app = makeApp();
    const env = makeEnv({ RATE_LIMIT_SESSION_SUMMARIZE: '2' });

    expect((await call(app, env, 'summarize')).status).toBe(200);
    expect((await call(app, env, 'summarize')).status).toBe(200);
    expect((await call(app, env, 'fork-prepare')).status).toBe(429);
    expect(mocks.ensureSessionTaskBacked).not.toHaveBeenCalled();
  });

  it('limits each user separately', async () => {
    const app = makeApp();
    const env = makeEnv({ RATE_LIMIT_SESSION_SUMMARIZE: '1' });

    expect((await call(app, env, 'fork-prepare')).status).toBe(200);
    expect((await call(app, env, 'fork-prepare')).status).toBe(429);

    mocks.getUserId.mockReturnValue('user-b');
    expect((await call(app, env, 'fork-prepare')).status).toBe(200);
  });

  it('refills the bucket when the next hourly window starts', async () => {
    const app = makeApp();
    const env = makeEnv({ RATE_LIMIT_SESSION_SUMMARIZE: '1' });
    vi.setSystemTime(new Date('2026-09-27T10:59:58Z'));

    expect((await call(app, env, 'summarize')).status).toBe(200);
    expect((await call(app, env, 'summarize')).status).toBe(429);

    vi.setSystemTime(new Date('2026-09-27T11:00:01Z'));
    expect((await call(app, env, 'summarize')).status).toBe(200);
    expect(mocks.summarizeSession).toHaveBeenCalledTimes(2);
  });
});
