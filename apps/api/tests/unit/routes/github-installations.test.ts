import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { githubRoutes } from '../../../src/routes/github';
import { getUserAccessibleInstallations } from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getUserAccessibleInstallations: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
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
  optionalAuth: () => vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', role: 'user', status: 'active', email: 'u@example.com', name: 'User', avatarUrl: null },
      session: { id: 'sess-1', expiresAt: new Date() },
    });
    return next();
  }),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/services/github-app', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/github-app')>(
    '../../../src/services/github-app'
  );
  return {
    ...actual,
    getUserAccessibleInstallations: mocks.getUserAccessibleInstallations,
    getInstallationRepositories: vi.fn(),
    getRepositoryBranches: vi.fn(),
    verifyWebhookSignature: vi.fn(),
  };
});

describe('GitHub App installation sharing', () => {
  let app: Hono<{ Bindings: Env }>;
  let whereResponses: unknown[][];
  let limitResponses: unknown[][];
  let insertedRows: unknown[];
  const mockEnv = {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'example.com',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_APP_ID: 'app-id',
    GITHUB_APP_PRIVATE_KEY: 'key',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    limitResponses = [];
    insertedRows = [];
    mocks.getAccessToken.mockResolvedValue({ accessToken: 'github-user-token' });

    const makeSelectBuilder = () => {
      const fromBuilder = {
        where: vi.fn(() =>
          Object.assign(Promise.resolve(whereResponses.shift() ?? []), {
            limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
          })
        ),
      };
      return {
        from: vi.fn(() => fromBuilder),
      };
    };

    const makeInsertBuilder = () => ({
      values: vi.fn((row: unknown) => {
        insertedRows.push(row);
        return {
          onConflictDoNothing: vi.fn(() => Promise.resolve(undefined)),
        };
      }),
    });

    const mockDB = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn(() => makeInsertBuilder()),
    };

    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    app = new Hono<{ Bindings: Env }>();
    app.route('/api/github', githubRoutes);
  });

  it('stores callback installation only when the GitHub user can access it', async () => {
    limitResponses.push([]);
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 123, account: { login: 'acme', type: 'Organization' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example.com/settings?github_app=installed');
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      userId: 'user-1',
      installationId: '123',
      accountType: 'organization',
      accountName: 'acme',
    });
    expect(getUserAccessibleInstallations).toHaveBeenCalledWith('github-user-token');
  });

  it('rejects spoofed callback installation IDs not accessible to the GitHub user', async () => {
    limitResponses.push([]);
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 456, account: { login: 'other-org', type: 'Organization' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=installation_not_accessible'
    );
    expect(insertedRows).toHaveLength(0);
  });

  it('syncs missing per-user installation rows from user-context GitHub access', async () => {
    whereResponses.push(
      [{ installationId: '111' }],
      [
        {
          id: 'inst-row-111',
          userId: 'user-1',
          installationId: '111',
          accountType: 'organization',
          accountName: 'existing',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
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
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 111, account: { login: 'existing', type: 'Organization' } },
      { id: 222, account: { login: 'acme', type: 'Organization' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      userId: 'user-1',
      installationId: '222',
      accountType: 'organization',
      accountName: 'acme',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
      expect.objectContaining({ installationId: '222' }),
    ]);
  });
});
