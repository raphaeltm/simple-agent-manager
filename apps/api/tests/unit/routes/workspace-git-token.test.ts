import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
import { getInstallationToken } from '../../../src/services/github-app';
import { GitHubCliPolicyError } from '../../../src/services/github-cli-policy';

const mocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
  getGitHubUserAccessTokenForOwner: vi.fn(),
  resolveWorkspaceGitHubTokenOptions: vi.fn(),
  assertRepositoryAccess: vi.fn(),
  verifyWorkspaceCallbackAuth: vi.fn(),
  backfillProjectGithubRepoId: vi.fn(),
  getProjectGitLabRepository: vi.fn(),
  requireGitLabUserAccessTokenResultForOwner: vi.fn(),
  verifyGitLabProjectAccess: vi.fn(),
  and: vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
}));

vi.mock('drizzle-orm/d1');
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    and: mocks.and,
    eq: mocks.eq,
  };
});
vi.mock('../../../src/routes/workspaces/_helpers', async () => {
  const actual = await vi.importActual<typeof import('../../../src/routes/workspaces/_helpers')>(
    '../../../src/routes/workspaces/_helpers'
  );
  return {
    ...actual,
    verifyWorkspaceCallbackAuth: mocks.verifyWorkspaceCallbackAuth,
  };
});
vi.mock('../../../src/services/github-app', () => ({
  getInstallationToken: mocks.getInstallationToken,
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));
vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessTokenForOwner: mocks.getGitHubUserAccessTokenForOwner,
}));
vi.mock('../../../src/routes/projects/_helpers', () => ({
  assertRepositoryAccess: mocks.assertRepositoryAccess,
}));
vi.mock('../../../src/services/github-cli-policy', () => {
  class GitHubCliPolicyError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GitHubCliPolicyError';
    }
  }
  return {
    GitHubCliPolicyError,
    resolveWorkspaceGitHubTokenOptions: mocks.resolveWorkspaceGitHubTokenOptions,
  };
});
vi.mock('../../../src/services/github-repo-id-backfill', () => ({
  backfillProjectGithubRepoId: mocks.backfillProjectGithubRepoId,
}));
vi.mock('../../../src/services/gitlab', () => ({
  getProjectGitLabRepository: mocks.getProjectGitLabRepository,
  requireGitLabUserAccessTokenResultForOwner: mocks.requireGitLabUserAccessTokenResultForOwner,
  verifyGitLabProjectAccess: mocks.verifyGitLabProjectAccess,
}));

describe('workspace git-token GitHub scoping', () => {
  let app: Hono<{ Bindings: Env }>;
  let limitResponses: Array<unknown[] | ((whereClause: unknown) => unknown[])>;
  // Responses for queries that await `.where()` directly without `.limit()`
  // (e.g. resolveAdditionalRepositoryIds). Kept separate from limitResponses so
  // the legacy `.limit(1)` tests are unaffected. Defaults to [] when empty.
  let whereResponses: Array<unknown[] | ((whereClause: unknown) => unknown[])>;
  const mockEnv = {
    DATABASE: {} as D1Database,
  } as Env;

  function columnName(value: unknown): string | null {
    return typeof value === 'object' && value !== null && 'name' in value
      ? String((value as { name: unknown }).name)
      : null;
  }

  function hasEqClause(whereClause: unknown, column: string, expectedValue: unknown): boolean {
    if (typeof whereClause !== 'object' || whereClause === null) {
      return false;
    }
    const clause = whereClause as {
      op?: unknown;
      left?: unknown;
      right?: unknown;
      clauses?: unknown[];
    };
    if (
      clause.op === 'eq' &&
      columnName(clause.left) === column &&
      clause.right === expectedValue
    ) {
      return true;
    }
    return Array.isArray(clause.clauses)
      ? clause.clauses.some((child) => hasEqClause(child, column, expectedValue))
      : false;
  }

  function projectInstallationRows(whereClause: unknown): unknown[] {
    if (!hasEqClause(whereClause, 'id', 'inst-row-111')) {
      return [];
    }
    return [
      {
        installationId: 'user-1:120081765',
        externalInstallationId: '120081765',
        userId: 'user-1',
      },
    ];
  }

  function workspaceRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ws-1',
      installationId: 'inst-row-111',
      projectId: 'proj-1',
      userId: 'user-1',
      ...overrides,
    };
  }

  function githubProjectRow(overrides: Record<string, unknown> = {}) {
    return {
      repoProvider: 'github',
      artifactsRepoId: null,
      githubRepoId: 42,
      repository: 'raph/sam',
      ...overrides,
    };
  }

  function artifactsProjectRow(overrides: Record<string, unknown> = {}) {
    return {
      repoProvider: 'artifacts',
      artifactsRepoId: 'artifacts-repo-1',
      githubRepoId: null,
      repository: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
      ...overrides,
    };
  }

  function queueWorkspaceProjectLookup(
    projectOverrides: Record<string, unknown> = {},
    installationLookup: (whereClause: unknown) => unknown[] = projectInstallationRows
  ) {
    limitResponses.push([workspaceRow()], [githubProjectRow(projectOverrides)], installationLookup);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    whereResponses = [];
    mocks.verifyWorkspaceCallbackAuth.mockResolvedValue(undefined);
    mocks.getGitHubUserAccessTokenForOwner.mockResolvedValue('github-user-oauth-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([]);
    mocks.assertRepositoryAccess.mockResolvedValue({ id: 42, fullName: 'raph/sam' });
    mocks.resolveWorkspaceGitHubTokenOptions.mockResolvedValue(null);
    // Default: self-heal cannot resolve an id (legacy fall-through to name scoping).
    mocks.backfillProjectGithubRepoId.mockResolvedValue({
      status: 'fetch_failed',
      githubRepoId: null,
      githubRepoNodeId: null,
      fullName: null,
    });
    mocks.getInstallationToken.mockResolvedValue({
      token: 'github-installation-token',
      expiresAt: '2026-06-06T19:00:00.000Z',
    });
    mocks.getProjectGitLabRepository.mockResolvedValue({
      userId: 'user-1',
      host: 'gitlab.example.com',
      gitlabProjectId: 123,
      pathWithNamespace: 'group/project',
      webUrl: 'https://gitlab.example.com/group/project',
      httpUrlToRepo: 'https://gitlab.example.com/group/project.git',
      defaultBranch: 'main',
    });
    mocks.requireGitLabUserAccessTokenResultForOwner.mockResolvedValue({
      accessToken: 'gitlab-oauth-token',
      accessTokenExpiresAt: '2026-07-12T12:00:00.000Z',
    });
    mocks.verifyGitLabProjectAccess.mockResolvedValue({
      host: 'gitlab.example.com',
      gitlabProjectId: 123,
      pathWithNamespace: 'group/project',
      webUrl: 'https://gitlab.example.com/group/project',
      httpUrlToRepo: 'https://gitlab.example.com/group/project.git',
      defaultBranch: 'main',
    });

    const makeSelectBuilder = () => {
      let whereClause: unknown = null;
      const resolveQueued = (
        queue: Array<unknown[] | ((whereClause: unknown) => unknown[])>
      ): unknown[] => {
        const response = queue.shift();
        return typeof response === 'function' ? response(whereClause) : (response ?? []);
      };
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn((clause: unknown) => {
          whereClause = clause;
          return builder;
        }),
        limit: vi.fn(() => Promise.resolve(resolveQueued(limitResponses))),
        // Thenable: queries that await `.where()` directly (no `.limit()`) resolve
        // from whereResponses. The `.limit()` chains never trigger this because the
        // builder itself is not awaited — only the Promise returned by `.limit()`.
        then: (
          // NOSONAR - intentional thenable mirroring drizzle's awaitable query builder.
          onFulfilled: (value: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => Promise.resolve(resolveQueued(whereResponses)).then(onFulfilled, onRejected),
      };
      return builder;
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn(() => makeSelectBuilder()),
    });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/ws', runtimeRoutes);
  });

  it('returns host/path-constrained GitLab credentials after re-verifying project access', async () => {
    limitResponses.push(
      [workspaceRow()],
      [
        githubProjectRow({
          repoProvider: 'gitlab',
          githubRepoId: null,
          repository: 'group/project',
        }),
      ]
    );

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      provider: 'gitlab',
      token: 'gitlab-oauth-token',
      expiresAt: '2026-07-12T12:00:00.000Z',
      cloneUrl: 'https://gitlab.example.com/group/project.git',
      host: 'gitlab.example.com',
      username: 'oauth2',
      repositoryPath: 'group/project',
    });
    expect(mocks.verifyGitLabProjectAccess).toHaveBeenCalledWith(
      mockEnv,
      'gitlab-oauth-token',
      123
    );
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it('passes through a null GitLab token expiry when the provider does not report one', async () => {
    limitResponses.push(
      [workspaceRow()],
      [
        githubProjectRow({
          repoProvider: 'gitlab',
          githubRepoId: null,
          repository: 'group/project',
        }),
      ]
    );
    mocks.requireGitLabUserAccessTokenResultForOwner.mockResolvedValue({
      accessToken: 'gitlab-oauth-token',
      accessTokenExpiresAt: null,
    });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      provider: 'gitlab',
      token: 'gitlab-oauth-token',
      expiresAt: null,
    });
  });

  it('rejects GitLab token exchange when the stored repo binding belongs to a different user', async () => {
    limitResponses.push(
      [workspaceRow()],
      [
        githubProjectRow({
          repoProvider: 'gitlab',
          githubRepoId: null,
          repository: 'group/project',
        }),
      ]
    );
    mocks.getProjectGitLabRepository.mockResolvedValue({
      userId: 'user-2',
      host: 'gitlab.example.com',
      gitlabProjectId: 123,
      pathWithNamespace: 'group/project',
      webUrl: 'https://gitlab.example.com/group/project',
      httpUrlToRepo: 'https://gitlab.example.com/group/project.git',
      defaultBranch: 'main',
    });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    // Fail closed BEFORE any token is minted or upstream access re-verified.
    expect(mocks.requireGitLabUserAccessTokenResultForOwner).not.toHaveBeenCalled();
    expect(mocks.verifyGitLabProjectAccess).not.toHaveBeenCalled();
  });

  it('rejects GitLab token exchange when re-verified repository identity drifts', async () => {
    limitResponses.push(
      [workspaceRow()],
      [
        githubProjectRow({
          repoProvider: 'gitlab',
          githubRepoId: null,
          repository: 'group/project',
        }),
      ]
    );
    mocks.verifyGitLabProjectAccess.mockResolvedValue({
      host: 'gitlab.example.com',
      gitlabProjectId: 123,
      pathWithNamespace: 'other/project',
      webUrl: 'https://gitlab.example.com/other/project',
      httpUrlToRepo: 'https://gitlab.example.com/other/project.git',
      defaultBranch: 'main',
    });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it('propagates GITLAB_REAUTH_REQUIRED as 401 when the owner token cannot be resolved', async () => {
    limitResponses.push(
      [workspaceRow()],
      [
        githubProjectRow({
          repoProvider: 'gitlab',
          githubRepoId: null,
          repository: 'group/project',
        }),
      ]
    );
    mocks.requireGitLabUserAccessTokenResultForOwner.mockRejectedValue(
      Object.assign(
        new Error('Your GitLab authorization has expired - please sign out and back in'),
        { statusCode: 401, error: 'GITLAB_REAUTH_REQUIRED' }
      )
    );

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'GITLAB_REAUTH_REQUIRED' });
    // No token exists, so upstream access must never be re-verified.
    expect(mocks.verifyGitLabProjectAccess).not.toHaveBeenCalled();
  });

  it('rejects GitLab token exchange when repository metadata is missing', async () => {
    limitResponses.push(
      [workspaceRow()],
      [
        githubProjectRow({
          repoProvider: 'gitlab',
          githubRepoId: null,
          repository: 'group/project',
        }),
      ]
    );
    mocks.getProjectGitLabRepository.mockResolvedValue(null);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    // Fail closed BEFORE any token is minted.
    expect(mocks.requireGitLabUserAccessTokenResultForOwner).not.toHaveBeenCalled();
    expect(mocks.verifyGitLabProjectAccess).not.toHaveBeenCalled();
  });

  it('returns Artifacts token expiry from camelCase binding shape', async () => {
    const createToken = vi.fn().mockResolvedValue({
      plaintext: 'artifacts-token?expires=ignored',
      expiresAt: '2026-06-06T20:00:00.000Z',
    });
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: {
        get: vi.fn().mockResolvedValue({
          remote: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
          createToken,
        }),
      },
    } as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow()]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, artifactsEnv);

    expect(res.status).toBe(200);
    expect(createToken).toHaveBeenCalledWith('write', 3600);
    await expect(res.json()).resolves.toEqual({
      token: 'artifacts-token',
      expiresAt: '2026-06-06T20:00:00.000Z',
      cloneUrl: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('falls back to Artifacts snake_case token expiry from beta binding shape', async () => {
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: {
        get: vi.fn().mockResolvedValue({
          remote: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
          createToken: vi.fn().mockResolvedValue({
            plaintext: 'artifacts-token',
            expires_at: '2026-06-06T21:00:00.000Z',
          }),
        }),
      },
    } as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow()]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, artifactsEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: 'artifacts-token',
      expiresAt: '2026-06-06T21:00:00.000Z',
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  // Regression: on staging the Artifacts binding's get().remote came back EMPTY
  // (unlike create().remote), so the endpoint returned an empty cloneUrl. The VM
  // agent then defaulted the git credential host to github.com, which never
  // matches the real Artifacts host — so `git fetch`/`push` got no credential
  // (helper returned github creds without host, and 204 when git asked for the
  // Artifacts host). The endpoint must fall back to the stored project.repository,
  // which is `created.remote` captured at project creation and is exactly what the
  // VM agent cloned (so its host is guaranteed to match git's request).
  it('falls back to stored project.repository as cloneUrl when the Artifacts binding returns an empty remote', async () => {
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: {
        get: vi.fn().mockResolvedValue({
          remote: '',
          createToken: vi.fn().mockResolvedValue({
            plaintext: 'artifacts-token',
            expiresAt: '2026-06-06T20:00:00.000Z',
          }),
        }),
      },
    } as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow()]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, artifactsEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      token: 'artifacts-token',
      expiresAt: '2026-06-06T20:00:00.000Z',
      cloneUrl: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('falls back to stored project.repository as cloneUrl when the Artifacts binding omits remote entirely', async () => {
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: {
        get: vi.fn().mockResolvedValue({
          // no `remote` field at all (undefined)
          createToken: vi.fn().mockResolvedValue({
            plaintext: 'artifacts-token',
            expiresAt: '2026-06-06T20:00:00.000Z',
          }),
        }),
      },
    } as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow()]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, artifactsEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      cloneUrl: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
    });
  });

  it('returns 200 with an empty cloneUrl when both binding remote and project.repository are empty', async () => {
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: {
        get: vi.fn().mockResolvedValue({
          remote: '',
          createToken: vi.fn().mockResolvedValue({
            plaintext: 'artifacts-token',
            expiresAt: '2026-06-06T20:00:00.000Z',
          }),
        }),
      },
    } as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow({ repository: null })]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, artifactsEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ token: 'artifacts-token', cloneUrl: '' });
  });

  it('rejects the Artifacts git-token path with 403 when ARTIFACTS_ENABLED is not "true"', async () => {
    // mockEnv has no ARTIFACTS_ENABLED / ARTIFACTS binding.
    limitResponses.push([workspaceRow()], [artifactsProjectRow()]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'FORBIDDEN' });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('returns 500 when an Artifacts project has a null artifactsRepoId', async () => {
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: { get: vi.fn() },
    } as unknown as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow({ artifactsRepoId: null })]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, artifactsEnv);

    expect(res.status).toBe(500);
  });

  it('mints a read-scoped Artifacts token when ?scope=read is requested', async () => {
    const createToken = vi.fn().mockResolvedValue({
      plaintext: 'artifacts-read-token',
      expiresAt: '2026-06-06T20:00:00.000Z',
    });
    const artifactsEnv = {
      ...mockEnv,
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: {
        get: vi.fn().mockResolvedValue({
          remote: 'https://acct123.artifacts.cloudflare.net/git/default/artifacts-repo-1.git',
          createToken,
        }),
      },
    } as Env;
    limitResponses.push([workspaceRow()], [artifactsProjectRow()]);

    const res = await app.request(
      '/ws/ws-1/git-token?scope=read',
      { method: 'POST' },
      artifactsEnv
    );

    expect(res.status).toBe(200);
    expect(createToken).toHaveBeenCalledWith('read', expect.any(Number));
  });

  it('falls back to repository-name scoping for legacy projects without a repo id', async () => {
    queueWorkspaceProjectLookup({ githubRepoId: null });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.getGitHubUserAccessTokenForOwner).toHaveBeenCalledWith(
      mockEnv,
      'user-1',
      'workspace-git-token'
    );
    expect(mocks.assertRepositoryAccess).toHaveBeenCalledWith(
      'github-user-oauth-token',
      '120081765',
      'raph/sam',
      'user-1',
      'project-access'
    );
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
    await expect(res.json()).resolves.toEqual({
      token: 'github-installation-token',
      expiresAt: '2026-06-06T19:00:00.000Z',
    });
  });

  it('rejects GitHub workspaces with neither a repo id nor a repository name', async () => {
    limitResponses.push(
      [workspaceRow()],
      [githubProjectRow({ githubRepoId: null, repository: null })]
    );

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'GitHub repository is not verified for this workspace',
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('mints GitHub installation tokens scoped to the verified repository id', async () => {
    queueWorkspaceProjectLookup();

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
    await expect(res.json()).resolves.toEqual({
      token: 'github-installation-token',
      expiresAt: '2026-06-06T19:00:00.000Z',
    });
  });

  it('denies and does not mint when the workspace owner has no GitHub OAuth token', async () => {
    mocks.getGitHubUserAccessTokenForOwner.mockResolvedValue(null);
    queueWorkspaceProjectLookup();

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'GitHub user token unavailable',
    });
    expect(mocks.assertRepositoryAccess).not.toHaveBeenCalled();
    expect(mocks.backfillProjectGithubRepoId).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('denies and does not mint when user-context repo access no longer includes the repo', async () => {
    mocks.assertRepositoryAccess.mockRejectedValue(
      Object.assign(new Error('Repository is not accessible through the selected installation'), {
        statusCode: 403,
        error: 'FORBIDDEN',
      })
    );
    queueWorkspaceProjectLookup();

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    expect(mocks.backfillProjectGithubRepoId).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('denies and does not mint when user-context repo id drifts from the project binding', async () => {
    mocks.assertRepositoryAccess.mockResolvedValue({ id: 99, fullName: 'raph/sam-renamed' });
    queueWorkspaceProjectLookup();

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'GitHub repository access has changed; repository ID no longer matches',
    });
    expect(mocks.backfillProjectGithubRepoId).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('self-heals a legacy project: persists the numeric id and scopes the token to repositoryIds', async () => {
    mocks.backfillProjectGithubRepoId.mockResolvedValue({
      status: 'backfilled',
      githubRepoId: 42,
      githubRepoNodeId: 'R_42',
      fullName: 'raph/sam',
    });
    queueWorkspaceProjectLookup({ githubRepoId: null });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.backfillProjectGithubRepoId).toHaveBeenCalledWith(expect.anything(), mockEnv, {
      projectId: 'proj-1',
      repository: 'raph/sam',
      externalInstallationId: '120081765',
    });
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
  });

  it('scopes the token by repositoryIds when self-heal resolves the id but skips persistence (collision)', async () => {
    // A concurrent heal already persisted the id, so this UPDATE collides — but the
    // numeric id is still returned so the current mint scopes correctly.
    mocks.backfillProjectGithubRepoId.mockResolvedValue({
      status: 'skipped_collision',
      githubRepoId: 77,
      githubRepoNodeId: 'R_77',
      fullName: 'raph/sam',
    });
    queueWorkspaceProjectLookup({ githubRepoId: null });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [77],
    });
  });

  it('does not 403 under a custom GitHub CLI policy once the id is self-healed before policy resolution', async () => {
    mocks.backfillProjectGithubRepoId.mockResolvedValue({
      status: 'backfilled',
      githubRepoId: 42,
      githubRepoNodeId: 'R_42',
      fullName: 'raph/sam',
    });
    // Custom policy rejects when it has no numeric id; succeeds once self-healed.
    mocks.resolveWorkspaceGitHubTokenOptions.mockImplementation(
      async (_db: unknown, opts: { githubRepoId: number | null }) => {
        if (!opts.githubRepoId) {
          throw new GitHubCliPolicyError('custom policy requires a numeric repo id');
        }
        return null;
      }
    );
    queueWorkspaceProjectLookup({ githubRepoId: null });

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.resolveWorkspaceGitHubTokenOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ githubRepoId: 42 })
    );
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
  });

  it('mints through the project installation row when the running member has repo access', async () => {
    limitResponses.push(
      [workspaceRow({ userId: 'member-user' })],
      [githubProjectRow()],
      (whereClause) => {
        expect(hasEqClause(whereClause, 'id', 'inst-row-111')).toBe(true);
        expect(hasEqClause(whereClause, 'user_id', 'member-user')).toBe(false);
        return [
          {
            installationId: 'owner-user:120081765',
            externalInstallationId: '120081765',
            userId: 'owner-user',
          },
        ];
      }
    );

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.getGitHubUserAccessTokenForOwner).toHaveBeenCalledWith(
      mockEnv,
      'member-user',
      'workspace-git-token'
    );
    expect(mocks.assertRepositoryAccess).toHaveBeenCalledWith(
      'github-user-oauth-token',
      '120081765',
      'raph/sam',
      'member-user',
      'project-access'
    );
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
  });

  it('mints a token scoped to the primary repo plus accessible additional Repository Access repos', async () => {
    queueWorkspaceProjectLookup();
    // Additional Repository Access entries selected in Project Settings.
    whereResponses.push((whereClause) => {
      expect(hasEqClause(whereClause, 'project_id', 'proj-1')).toBe(true);
      expect(hasEqClause(whereClause, 'user_id', 'user-1')).toBe(false);
      return [
        { repository: 'acme/shared-lib', githubRepoId: 7 },
        { repository: 'Acme/Other-Lib', githubRepoId: 8 },
      ];
    });
    // The live user∩app accessible set re-verified at the mint boundary. Note the
    // casing differs from the stored rows to assert case-insensitive matching, and
    // ids differ from the stored githubRepoId to assert the live id wins.
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 42, nodeId: null, fullName: 'raph/sam', private: true, defaultBranch: 'main' },
      { id: 70, nodeId: null, fullName: 'Acme/Shared-Lib', private: true, defaultBranch: 'main' },
      { id: 80, nodeId: null, fullName: 'acme/other-lib', private: true, defaultBranch: 'main' },
    ]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-oauth-token',
      '120081765',
      expect.objectContaining({ flow: 'project-access', userId: 'user-1' })
    );
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42, 70, 80],
    });
  });

  it('excludes additional repos whose access has been revoked from the minted scope', async () => {
    queueWorkspaceProjectLookup();
    whereResponses.push([
      { repository: 'acme/shared-lib', githubRepoId: 7 },
      { repository: 'acme/revoked-lib', githubRepoId: 9 },
    ]);
    // revoked-lib is no longer in the user∩app accessible set → dropped from scope.
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 42, nodeId: null, fullName: 'raph/sam', private: true, defaultBranch: 'main' },
      { id: 70, nodeId: null, fullName: 'acme/shared-lib', private: true, defaultBranch: 'main' },
    ]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42, 70],
    });
  });

  it('degrades to the primary-only scope (never omits scoping) when the accessible set cannot be fetched', async () => {
    queueWorkspaceProjectLookup();
    whereResponses.push([{ repository: 'acme/shared-lib', githubRepoId: 7 }]);
    mocks.getUserInstallationRepositories.mockRejectedValue(new Error('GitHub API unavailable'));

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    // Additional repos degrade to empty; the primary clone scope is preserved and
    // repositoryIds is never omitted.
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
  });

  it('deduplicates an additional repo that resolves to the primary repository id', async () => {
    queueWorkspaceProjectLookup();
    whereResponses.push([{ repository: 'raph/sam', githubRepoId: 42 }]);
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 42, nodeId: null, fullName: 'raph/sam', private: true, defaultBranch: 'main' },
    ]);

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositoryIds: [42],
    });
  });
});
