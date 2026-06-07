import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
import { getInstallationToken } from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
  resolveWorkspaceGitHubTokenOptions: vi.fn(),
  verifyWorkspaceCallbackAuth: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
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

describe('workspace git-token GitHub scoping', () => {
  let app: Hono<{ Bindings: Env }>;
  let limitResponses: unknown[][];
  const mockEnv = {
    DATABASE: {} as D1Database,
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    mocks.verifyWorkspaceCallbackAuth.mockResolvedValue(undefined);
    mocks.resolveWorkspaceGitHubTokenOptions.mockResolvedValue(null);
    mocks.getInstallationToken.mockResolvedValue({
      token: 'github-installation-token',
      expiresAt: '2026-06-06T19:00:00.000Z',
    });

    const makeSelectBuilder = () => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
    });
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
      [{ installationId: 'user-1:120081765', externalInstallationId: '120081765' }]
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
      [{ installationId: 'user-1:120081765', externalInstallationId: '120081765' }]
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
});
