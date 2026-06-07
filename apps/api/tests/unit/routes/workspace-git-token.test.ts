import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
import { getInstallationToken } from '../../../src/services/github-app';
import { GitHubCliPolicyError } from '../../../src/services/github-cli-policy';

const mocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  resolveWorkspaceGitHubTokenOptions: vi.fn(),
  verifyWorkspaceCallbackAuth: vi.fn(),
  backfillProjectGithubRepoId: vi.fn(),
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

describe('workspace git-token GitHub scoping', () => {
  let app: Hono<{ Bindings: Env }>;
  let limitResponses: Array<unknown[] | ((whereClause: unknown) => unknown[])>;
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
    const clause = whereClause as { op?: unknown; left?: unknown; right?: unknown; clauses?: unknown[] };
    if (clause.op === 'eq' && columnName(clause.left) === column && clause.right === expectedValue) {
      return true;
    }
    return Array.isArray(clause.clauses)
      ? clause.clauses.some((child) => hasEqClause(child, column, expectedValue))
      : false;
  }

  function installationRowsOnlyWhenOwnerScoped(whereClause: unknown): unknown[] {
    if (
      !hasEqClause(whereClause, 'id', 'inst-row-111') ||
      !hasEqClause(whereClause, 'user_id', 'user-1')
    ) {
      return [];
    }
    return [{ installationId: 'user-1:120081765', externalInstallationId: '120081765' }];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    mocks.verifyWorkspaceCallbackAuth.mockResolvedValue(undefined);
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

    const makeSelectBuilder = () => {
      let whereClause: unknown = null;
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn((clause: unknown) => {
          whereClause = clause;
          return builder;
        }),
        limit: vi.fn(() => {
          const response = limitResponses.shift();
          return Promise.resolve(typeof response === 'function' ? response(whereClause) : (response ?? []));
        }),
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

  it('falls back to repository-name scoping for legacy projects without a repo id', async () => {
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: null, repository: 'raph/sam' }],
      installationRowsOnlyWhenOwnerScoped
    );

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(200);
    expect(getInstallationToken).toHaveBeenCalledWith('120081765', mockEnv, {
      repositories: ['sam'],
    });
    await expect(res.json()).resolves.toEqual({
      token: 'github-installation-token',
      expiresAt: '2026-06-06T19:00:00.000Z',
    });
  });

  it('rejects GitHub workspaces with neither a repo id nor a repository name', async () => {
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: null, repository: null }]
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
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: 42 }],
      installationRowsOnlyWhenOwnerScoped
    );

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

  it('self-heals a legacy project: persists the numeric id and scopes the token to repositoryIds', async () => {
    mocks.backfillProjectGithubRepoId.mockResolvedValue({
      status: 'backfilled',
      githubRepoId: 42,
      githubRepoNodeId: 'R_42',
      fullName: 'raph/sam',
    });
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: null, repository: 'raph/sam' }],
      installationRowsOnlyWhenOwnerScoped
    );

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
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: null, repository: 'raph/sam' }],
      installationRowsOnlyWhenOwnerScoped
    );

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
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: null, repository: 'raph/sam' }],
      installationRowsOnlyWhenOwnerScoped
    );

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

  it('rejects a workspace installation row that is not owned by the workspace user', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    limitResponses.push(
      [{ id: 'ws-1', installationId: 'inst-row-111', projectId: 'proj-1', userId: 'user-1' }],
      [{ repoProvider: 'github', artifactsRepoId: null, githubRepoId: 42, repository: 'raph/sam' }],
      (whereClause) => {
        expect(hasEqClause(whereClause, 'id', 'inst-row-111')).toBe(true);
        expect(hasEqClause(whereClause, 'user_id', 'user-1')).toBe(true);
        return [];
      }
    );

    const res = await app.request('/ws/ws-1/git-token', { method: 'POST' }, mockEnv);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'NOT_FOUND',
      message: 'GitHub installation not found',
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('workspace_git_token_installation_owner_mismatch')
    );
    warnSpy.mockRestore();
  });
});
