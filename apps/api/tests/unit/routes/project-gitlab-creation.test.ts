import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { projectsRoutes } from '../../../src/routes/projects';

/**
 * Behavioral tests for the GitLab branch of `POST /api/projects` in
 * `src/routes/projects/crud.ts`. These exercise the real Hono route (mounted via
 * projectsRoutes) with the GitLab service boundary and D1 mocked, covering the
 * full creation flow, its input/access guards, and the sidecar-insert rollback.
 */

const mocks = vi.hoisted(() => ({
  createOwnerProjectMembership: vi.fn(),
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(),
  requireGitLabUserAccessToken: vi.fn(),
  verifyGitLabProjectAccess: vi.fn(),
  listGitLabBranches: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  createOwnerProjectMembership: mocks.createOwnerProjectMembership,
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/gitlab', () => ({
  requireGitLabUserAccessToken: mocks.requireGitLabUserAccessToken,
  verifyGitLabProjectAccess: mocks.verifyGitLabProjectAccess,
  listGitLabBranches: mocks.listGitLabBranches,
}));

const GITLAB_METADATA = {
  host: 'gitlab.example.com',
  gitlabProjectId: 123,
  pathWithNamespace: 'group/project',
  webUrl: 'https://gitlab.example.com/group/project',
  httpUrlToRepo: 'https://gitlab.example.com/group/project.git',
  defaultBranch: 'main',
};

// Row returned by the route's final load-and-respond select after a successful insert.
const CREATED_PROJECT_ROW = {
  id: 'proj-1',
  userId: 'user-1',
  name: 'GitLab Project',
  normalizedName: 'gitlab project',
  description: null,
  installationId: 'system_anonymous_trials_installation',
  repository: 'group/project',
  defaultBranch: 'main',
  repoProvider: 'gitlab',
  githubRepoId: null,
  githubRepoNodeId: null,
  artifactsRepoId: null,
  createdBy: 'user-1',
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

describe('POST /api/projects — GitLab provider', () => {
  let app: Hono<{ Bindings: Env }>;
  let whereResponses: unknown[][];
  let limitResponses: unknown[][];
  let insertedRows: unknown[];
  let deletedProjectIds: unknown[];
  let failSidecarInsert: boolean;
  const mockEnv = { DATABASE: {} as D1Database } as Env;

  const createGitLabProject = (
    body: Record<string, unknown> = { name: 'GitLab Project', repoProvider: 'gitlab', gitlabProjectId: 123 }
  ) =>
    app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      mockEnv
    );

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    limitResponses = [];
    insertedRows = [];
    deletedProjectIds = [];
    failSidecarInsert = false;

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

    let insertCall = 0;
    const mockDB = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn(() => ({
        values: vi.fn((row: unknown) => {
          insertCall += 1;
          insertedRows.push(row);
          // The second insert in the GitLab path is the projectGitlabRepositories
          // sidecar — used to exercise the rollback branch.
          if (failSidecarInsert && insertCall === 2) {
            return Promise.reject(new Error('sidecar insert failed'));
          }
          return Promise.resolve(undefined);
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn((predicate: unknown) => {
          deletedProjectIds.push(predicate);
          return Promise.resolve(undefined);
        }),
      })),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    mocks.requireGitLabUserAccessToken.mockResolvedValue('gl_token');
    mocks.verifyGitLabProjectAccess.mockResolvedValue(GITLAB_METADATA);
    mocks.listGitLabBranches.mockResolvedValue([{ name: 'main', isDefault: true }]);
    mocks.createOwnerProjectMembership.mockResolvedValue(undefined);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectsRoutes);
  });

  it('creates a GitLab project and persists provider identity to the sidecar', async () => {
    // dup-name empty, dup-repo empty, final load returns the created row.
    limitResponses.push([], [], [CREATED_PROJECT_ROW]);

    const res = await createGitLabProject();

    expect(res.status).toBe(201);
    expect(mocks.verifyGitLabProjectAccess).toHaveBeenCalledWith(mockEnv, 'gl_token', 123);
    // First insert = projects row (repoProvider gitlab, verified path as repository).
    expect(insertedRows[0]).toMatchObject({
      userId: 'user-1',
      repoProvider: 'gitlab',
      repository: 'group/project',
      defaultBranch: 'main',
    });
    // Second insert = project_gitlab_repositories sidecar with the verified identity.
    expect(insertedRows[1]).toMatchObject({
      userId: 'user-1',
      host: 'gitlab.example.com',
      gitlabProjectId: 123,
      pathWithNamespace: 'group/project',
      httpUrlToRepo: 'https://gitlab.example.com/group/project.git',
      defaultBranch: 'main',
    });
    expect(mocks.createOwnerProjectMembership).toHaveBeenCalledTimes(1);
  });

  it('rejects creation when gitlabProjectId is missing', async () => {
    const res = await createGitLabProject({ name: 'No ID', repoProvider: 'gitlab' });

    expect(res.status).toBe(400);
    expect(mocks.verifyGitLabProjectAccess).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it('propagates 401 when the user has no live GitLab token', async () => {
    mocks.requireGitLabUserAccessToken.mockRejectedValue(
      Object.assign(new Error('reauth'), { statusCode: 401, error: 'GITLAB_REAUTH_REQUIRED' })
    );

    const res = await createGitLabProject();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'GITLAB_REAUTH_REQUIRED' });
    expect(insertedRows).toHaveLength(0);
  });

  it('propagates 403 when GitLab access is insufficient', async () => {
    mocks.verifyGitLabProjectAccess.mockRejectedValue(
      Object.assign(new Error('forbidden'), { statusCode: 403, error: 'FORBIDDEN' })
    );

    const res = await createGitLabProject();

    expect(res.status).toBe(403);
    expect(insertedRows).toHaveLength(0);
  });

  it('propagates 404 when the GitLab project is not found', async () => {
    mocks.verifyGitLabProjectAccess.mockRejectedValue(
      Object.assign(new Error('not found'), { statusCode: 404, error: 'NOT_FOUND' })
    );

    const res = await createGitLabProject();

    expect(res.status).toBe(404);
    expect(insertedRows).toHaveLength(0);
  });

  it('accepts a non-default branch that exists on the remote', async () => {
    mocks.listGitLabBranches.mockResolvedValue([
      { name: 'main', isDefault: true },
      { name: 'feature/x', isDefault: false },
    ]);
    limitResponses.push([], [], [{ ...CREATED_PROJECT_ROW, defaultBranch: 'feature/x' }]);

    const res = await createGitLabProject({
      name: 'Feature Branch',
      repoProvider: 'gitlab',
      gitlabProjectId: 123,
      defaultBranch: 'feature/x',
    });

    expect(res.status).toBe(201);
    expect(mocks.listGitLabBranches).toHaveBeenCalledWith(mockEnv, 'gl_token', 123);
    expect(insertedRows[0]).toMatchObject({ defaultBranch: 'feature/x' });
  });

  it('rejects a non-default branch that does not exist on the remote', async () => {
    mocks.listGitLabBranches.mockResolvedValue([{ name: 'main', isDefault: true }]);

    const res = await createGitLabProject({
      name: 'Bad Branch',
      repoProvider: 'gitlab',
      gitlabProjectId: 123,
      defaultBranch: 'does-not-exist',
    });

    expect(res.status).toBe(400);
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects a duplicate GitLab repository for the same user', async () => {
    // The duplicate-repo lookup (.where().limit(1)) returns an existing sidecar row.
    limitResponses.push([], [{ id: 'existing-pgr' }]);

    const res = await createGitLabProject();

    expect(res.status).toBe(409);
    expect(insertedRows).toHaveLength(0);
  });

  it('rolls back the project row when the sidecar insert fails', async () => {
    failSidecarInsert = true;

    const res = await createGitLabProject();

    expect(res.status).not.toBe(201);
    // The projects row was inserted, then deleted on sidecar failure.
    expect(insertedRows).toHaveLength(2);
    expect(deletedProjectIds).toHaveLength(1);
    expect(mocks.createOwnerProjectMembership).not.toHaveBeenCalled();
  });
});
