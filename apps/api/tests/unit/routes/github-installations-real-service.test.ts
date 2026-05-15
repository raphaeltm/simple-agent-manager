import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { githubRoutes } from '../../../src/routes/github';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
}));
vi.mock('../../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getAccessToken: mocks.getAccessToken,
    },
  }),
}));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', role: 'user', status: 'active', email: 'u@example.com', name: 'User', avatarUrl: null },
      session: { id: 'sess-1', expiresAt: new Date() },
    });
    return next();
  }),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  optionalAuth: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));

describe('GitHub installation sync diagnostics through GitHub service', () => {
  const mockEnv = {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'example.com',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_APP_ID: 'app-id',
    GITHUB_APP_PRIVATE_KEY: 'key',
  } as Env;

  let app: Hono<{ Bindings: Env }>;
  let whereResponses: unknown[][];

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    mocks.getAccessToken.mockResolvedValue({ accessToken: 'github-user-token' });

    const makeSelectBuilder = () => {
      const fromBuilder = {
        where: vi.fn(() => Promise.resolve(whereResponses.shift() ?? [])),
      };
      return {
        from: vi.fn(() => fromBuilder),
      };
    };

    const makeInsertBuilder = () => ({
      values: vi.fn(() => Promise.resolve(undefined)),
    });

    const mockDB = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn(() => makeInsertBuilder()),
    };

    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    app = new Hono<{ Bindings: Env }>();
    app.route('/api/github', githubRoutes);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs GitHub API response status and count through the sync route', async () => {
    whereResponses.push(
      [],
      [
        {
          id: 'inst-row-222',
          userId: 'user-1',
          installationId: '222',
          accountType: 'organization',
          accountName: 'acme',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ]
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({
        installations: [
          { id: 222, account: { login: 'acme', type: 'Organization' } },
        ],
      }))
    );

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.log.info).toHaveBeenCalledWith('github.user_accessible_installations.response', {
      flow: 'sync',
      userId: 'user-1',
      installationId: undefined,
      page: 1,
      status: 200,
      ok: true,
      installationCount: 1,
    });
    expect(JSON.stringify([
      mocks.log.debug.mock.calls,
      mocks.log.info.mock.calls,
      mocks.log.warn.mock.calls,
      mocks.log.error.mock.calls,
    ])).not.toContain('github-user-token');
  });
});
