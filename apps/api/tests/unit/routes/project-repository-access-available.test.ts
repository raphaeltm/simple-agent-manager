import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { repositoryAccessRoutes } from '../../../src/routes/projects/repository-access';
import { getUserInstallationRepositories } from '../../../src/services/github-app';

/**
 * Vertical-slice tests for GET /:id/repository-access/available (rule 35 —
 * boundaries mocked, the real route handler + real requireOwnedInstallation /
 * requireGitHubUserAccessToken helpers run). They prove the live user∩app
 * intersection is returned MINUS the primary repository and MINUS repositories
 * already added to the project's repository-access set, sorted by full name.
 */

const mocks = vi.hoisted(() => ({
  getUserInstallationRepositories: vi.fn(),
  getGitHubUserAccessToken: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
  // getRepositoryGitmodules is imported by the route module but unused here.
  getRepositoryGitmodules: vi.fn(),
}));
vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessToken: mocks.getGitHubUserAccessToken,
}));

const INSTALLATION_ROW = {
  id: 'inst-row-111',
  userId: 'user-1',
  installationId: 'user-1:120081765',
  externalInstallationId: '120081765',
  accountType: 'organization',
  accountName: 'acme',
};

const PROJECT = {
  id: 'proj-1',
  userId: 'user-1',
  name: 'Project One',
  repoProvider: 'github',
  installationId: 'inst-row-111',
  repository: 'acme/primary',
  defaultBranch: 'main',
  githubRepoId: 1,
};

function repo(id: number, fullName: string, isPrivate = true, nodeId: string | null = null) {
  return { id, nodeId, fullName, private: isPrivate, defaultBranch: 'main' };
}

describe('GET /:id/repository-access/available', () => {
  let limitResponses: unknown[][];
  let whereResponses: unknown[][];
  const mockEnv = { DATABASE: {} as D1Database, BASE_DOMAIN: 'sammy.party' } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    whereResponses = [];

    const makeSelectBuilder = () => {
      const fromBuilder = {
        where: vi.fn(() =>
          Object.assign(Promise.resolve(whereResponses.shift() ?? []), {
            limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
          })
        ),
      };
      return { from: vi.fn(() => fromBuilder) };
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn(() => makeSelectBuilder()),
    });

    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.requireProjectAccess.mockResolvedValue(PROJECT);
  });

  function buildApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const e = err as { statusCode?: number; error?: string; message?: string };
      if (typeof e.statusCode === 'number' && typeof e.error === 'string') {
        return c.json({ error: e.error, message: e.message }, e.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', repositoryAccessRoutes);
    return app;
  }

  function get(): Promise<Response> {
    return buildApp().request('/api/projects/proj-1/repository-access/available', {}, mockEnv);
  }

  it('returns the intersection minus primary and already-added repos, sorted by name', async () => {
    limitResponses.push([INSTALLATION_ROW]); // requireOwnedInstallation (.where().limit)
    whereResponses.push([]); // absorbs requireOwnedInstallation's eager .where() shift
    whereResponses.push([{ repository: 'acme/already-added' }]); // already-added rows
    mocks.getUserInstallationRepositories.mockResolvedValue([
      repo(5, 'acme/zeta'),
      repo(1, 'acme/primary'), // primary — excluded
      repo(9, 'acme/already-added'), // already added — excluded
      repo(3, 'acme/alpha', false, 'R_alpha'),
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repositories: Array<{ repository: string; githubRepoId: number; private: boolean }>;
    };

    expect(body.repositories.map((r) => r.repository)).toEqual(['acme/alpha', 'acme/zeta']);
    expect(body.repositories[0]).toEqual({
      repository: 'acme/alpha',
      githubRepoId: 3,
      githubRepoNodeId: 'R_alpha',
      private: false,
    });
  });

  it('consults the live user∩app intersection with the external installation id', async () => {
    limitResponses.push([INSTALLATION_ROW]);
    whereResponses.push([]);
    mocks.getUserInstallationRepositories.mockResolvedValue([repo(2, 'acme/lib')]);

    await get();

    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      expect.objectContaining({
        flow: 'project-access',
        userId: 'user-1',
        installationId: '120081765',
        repository: 'acme/primary',
      })
    );
  });

  it('excludes the primary repository case-insensitively', async () => {
    limitResponses.push([INSTALLATION_ROW]);
    whereResponses.push([]);
    mocks.getUserInstallationRepositories.mockResolvedValue([
      repo(1, 'Acme/Primary'), // same as primary, different case — excluded
      repo(4, 'acme/other'),
    ]);

    const res = await get();
    const body = (await res.json()) as { repositories: Array<{ repository: string }> };
    expect(body.repositories.map((r) => r.repository)).toEqual(['acme/other']);
  });

  it('rejects non-GitHub projects with 400', async () => {
    mocks.requireProjectAccess.mockResolvedValue({ ...PROJECT, repoProvider: 'artifacts' });

    const res = await get();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      message: 'Repository access is only supported for GitHub-backed projects',
    });
    expect(getUserInstallationRepositories).not.toHaveBeenCalled();
  });
});
