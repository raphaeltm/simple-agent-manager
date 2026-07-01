import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { projectsRoutes } from '../../../src/routes/projects';
import { getUserInstallationRepositories } from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  createOwnerProjectMembership: vi.fn(),
  getGitHubUserAccessToken: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
  requireOwnedProject: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  createOwnerProjectMembership: mocks.createOwnerProjectMembership,
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessToken: mocks.getGitHubUserAccessToken,
}));
vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));

describe('project GitHub repository authorization routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let whereResponses: unknown[][];
  let limitResponses: unknown[][];
  let insertedRows: unknown[];
  let updateCalls: unknown[];
  const mockEnv = {
    DATABASE: {} as D1Database,
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    limitResponses = [];
    insertedRows = [];
    updateCalls = [];

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

    const mockDB = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn(() => ({
        values: vi.fn((row: unknown) => {
          insertedRows.push(row);
          return Promise.resolve(undefined);
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((row: unknown) => {
          updateCalls.push(row);
          return {
            where: vi.fn(() => Promise.resolve(undefined)),
          };
        }),
      })),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([
      {
        id: 42,
        nodeId: 'R_kgDOAllowed',
        fullName: 'acme/allowed-private',
        private: true,
        defaultBranch: 'main',
      },
    ]);
    mocks.requireOwnedProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      name: 'Project One',
      normalizedName: 'project one',
      description: null,
      installationId: 'inst-row-111',
      repository: 'acme/allowed-private',
      defaultBranch: 'main',
      defaultVmSize: null,
      defaultAgentType: null,
      defaultWorkspaceProfile: null,
      defaultDevcontainerConfigName: null,
      defaultProvider: null,
      defaultLocation: null,
      agentDefaults: null,
      workspaceIdleTimeoutMs: null,
      nodeIdleTimeoutMs: null,
      taskExecutionTimeoutMs: null,
      maxConcurrentTasks: null,
      maxDispatchDepth: null,
      maxSubTasksPerTask: null,
      warmNodeTimeoutMs: null,
      maxWorkspacesPerNode: null,
      nodeCpuThresholdPercent: null,
      nodeMemoryThresholdPercent: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      updatedAt: '2026-06-06T00:00:00.000Z',
    });

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

  it('rejects project creation when client-supplied GitHub repo id does not match the authorized repo', async () => {
    whereResponses.push([{ count: 0 }]);
    limitResponses.push(
      [],
      [{
        id: 'inst-row-111',
        userId: 'user-1',
        installationId: 'user-1:120081765',
        externalInstallationId: '120081765',
        accountType: 'organization',
        accountName: 'acme',
      }]
    );

    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Project One',
        installationId: 'inst-row-111',
        repository: 'acme/allowed-private',
        defaultBranch: 'main',
        githubRepoId: 999,
      }),
    }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'GitHub repository ID does not match the selected repository',
    });
    expect(insertedRows).toHaveLength(0);
  });

  it('stores the verified GitHub repo id from user-context repository access', async () => {
    whereResponses.push([{ count: 0 }]);
    limitResponses.push(
      [],
      [{
        id: 'inst-row-111',
        userId: 'user-1',
        installationId: 'user-1:120081765',
        externalInstallationId: '120081765',
        accountType: 'organization',
        accountName: 'acme',
      }],
      [],
      [],
      [{
        id: 'proj-1',
        userId: 'user-1',
        name: 'Project One',
        normalizedName: 'project one',
        description: null,
        installationId: 'inst-row-111',
        repository: 'acme/allowed-private',
        defaultBranch: 'main',
        repoProvider: 'github',
        githubRepoId: 42,
        githubRepoNodeId: 'R_kgDOAllowed',
        createdBy: 'user-1',
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
      }]
    );

    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Project One',
        installationId: 'inst-row-111',
        repository: 'acme/allowed-private',
        defaultBranch: 'main',
      }),
    }, mockEnv);

    expect(res.status).toBe(201);
    expect(insertedRows[0]).toMatchObject({
      userId: 'user-1',
      installationId: 'inst-row-111',
      repository: 'acme/allowed-private',
      githubRepoId: 42,
      githubRepoNodeId: 'R_kgDOAllowed',
    });
  });

  it('rejects project updates when the existing repo is no longer visible to the GitHub user', async () => {
    limitResponses.push([{
      id: 'inst-row-111',
      userId: 'user-1',
      installationId: 'user-1:120081765',
      externalInstallationId: '120081765',
      accountType: 'organization',
      accountName: 'acme',
    }]);
    mocks.getUserInstallationRepositories.mockResolvedValue([
      {
        id: 7,
        nodeId: 'R_kgDOOther',
        fullName: 'acme/other-private',
        private: true,
        defaultBranch: 'main',
      },
    ]);

    const res = await app.request('/api/projects/proj-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Project' }),
    }, mockEnv);

    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
    expect(getUserInstallationRepositories).toHaveBeenCalledWith('github-user-token', '120081765', {
      flow: 'project-access',
      userId: 'user-1',
      installationId: '120081765',
      repository: 'acme/allowed-private',
    });
  });
});
