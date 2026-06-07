import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runRoutes } from '../../../src/routes/tasks/run';
import { submitRoutes } from '../../../src/routes/tasks/submit';
import { crudRoutes } from '../../../src/routes/workspaces/crud';
import { getUserInstallationRepositories } from '../../../src/services/github-app';

/**
 * Vertical-slice tests for the fail-fast user∩app GitHub repo-access gate at the
 * three spawn entry points (workspace create, task submit, task run). These
 * exercise the REAL requireRepositoryUserAccess helper through the route (rule
 * 35 — boundaries are mocked, internal helpers are not) and assert that when the
 * user's GitHub access to the bound repository is revoked, the route returns 403
 * AND no node/runner provisioning is reached (rule 11 fail-fast).
 */

const mocks = vi.hoisted(() => ({
  getGitHubUserAccessToken: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
  requireOwnedProject: vi.fn(),
  requireOwnedTask: vi.fn(),
  createNodeRecord: vi.fn(),
  provisionNode: vi.fn(),
  startTaskRunnerDO: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getAuth: () => ({ user: { id: 'user-1' } }),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
  requireOwnedTask: mocks.requireOwnedTask,
}));
vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessToken: mocks.getGitHubUserAccessToken,
}));
vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: mocks.createNodeRecord,
  provisionNode: mocks.provisionNode,
}));
vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

const INSTALLATION_ROW = {
  id: 'inst-row-111',
  userId: 'user-1',
  installationId: 'user-1:120081765',
  externalInstallationId: '120081765',
  accountType: 'organization',
  accountName: 'acme',
};

const VISIBLE_REPO = {
  id: 42,
  nodeId: 'R_kgDOAllowed',
  fullName: 'acme/allowed-private',
  private: true,
  defaultBranch: 'main',
};

const OTHER_REPO = {
  id: 7,
  nodeId: 'R_kgDOOther',
  fullName: 'acme/other-private',
  private: true,
  defaultBranch: 'main',
};

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'user-1',
    name: 'Project One',
    repoProvider: 'github',
    installationId: 'inst-row-111',
    repository: 'acme/allowed-private',
    defaultBranch: 'main',
    githubRepoId: 42,
    ...overrides,
  } as schema.Project;
}

describe('spawn entry points enforce the user∩app repo-access gate (fail-fast)', () => {
  let whereResponses: unknown[][];
  let limitResponses: unknown[][];
  const mockEnv = {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'sammy.party',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    limitResponses = [];

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

    const mockDB = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })),
      })),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.requireOwnedProject.mockResolvedValue(makeProject());
    mocks.requireOwnedTask.mockResolvedValue({ id: 'task-1', status: 'ready' });
    mocks.createNodeRecord.mockResolvedValue({ id: 'node-1' });
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
  });

  function buildApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/workspaces', crudRoutes);
    app.route('/api/projects/:projectId/tasks', runRoutes);
    app.route('/api/projects/:projectId/tasks', submitRoutes);
    return app;
  }

  // ---------------------------------------------------------------------------
  // Workspace create: POST /api/workspaces
  // ---------------------------------------------------------------------------

  it('workspace create: returns 403 and does NOT provision a node when access is revoked', async () => {
    // Installation is still owned, but the user can no longer see the bound repo.
    limitResponses.push([INSTALLATION_ROW]);
    mocks.getUserInstallationRepositories.mockResolvedValue([OTHER_REPO]);

    const res = await buildApp().request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WS One', projectId: 'proj-1' }),
    }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
      message: 'Repository is not accessible through the selected installation',
    });
    // Fail-fast: no node was ever created.
    expect(mocks.createNodeRecord).not.toHaveBeenCalled();
  });

  it('workspace create: gate passes and node provisioning is reached when access is intact', async () => {
    limitResponses.push([INSTALLATION_ROW]);
    whereResponses.push([{ count: 0 }]); // user node count
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    await buildApp().request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WS One', projectId: 'proj-1' }),
    }, mockEnv);

    // Gate allowed the request through to provisioning.
    expect(mocks.createNodeRecord).toHaveBeenCalled();
    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      expect.objectContaining({ flow: 'project-access', userId: 'user-1', repository: 'acme/allowed-private' })
    );
  });

  // ---------------------------------------------------------------------------
  // Task submit: POST /api/projects/:projectId/tasks/submit
  // ---------------------------------------------------------------------------

  it('task submit: returns 403 and does NOT start the Task Runner when access is revoked', async () => {
    limitResponses.push([INSTALLATION_ROW]);
    mocks.getUserInstallationRepositories.mockResolvedValue([OTHER_REPO]);

    const res = await buildApp().request('/api/projects/proj-1/tasks/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Do the thing' }),
    }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
      message: 'Repository is not accessible through the selected installation',
    });
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Task run: POST /api/projects/:projectId/tasks/:taskId/run
  // ---------------------------------------------------------------------------

  it('task run: returns 403 and does NOT start the Task Runner when access is revoked', async () => {
    // run.ts pre-gate db sequence: dependencies (.where, no limit) -> credentials
    // (.limit) -> project load (.limit) -> installation lookup (.limit).
    whereResponses.push([]); // no task dependencies
    limitResponses.push([{ id: 'cred-1' }]); // cloud-provider credential present
    limitResponses.push([makeProject()]); // project load
    limitResponses.push([INSTALLATION_ROW]); // installation lookup (gate)
    mocks.getUserInstallationRepositories.mockResolvedValue([OTHER_REPO]);

    const res = await buildApp().request('/api/projects/proj-1/tasks/task-1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
      message: 'Repository is not accessible through the selected installation',
    });
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('task run: rejects with 403 when the repository id has drifted, before provisioning', async () => {
    whereResponses.push([]);
    limitResponses.push([{ id: 'cred-1' }]);
    limitResponses.push([makeProject({ githubRepoId: 42 })]);
    limitResponses.push([INSTALLATION_ROW]);
    // User can still see a repo with the bound full name, but a DIFFERENT id.
    mocks.getUserInstallationRepositories.mockResolvedValue([{ ...VISIBLE_REPO, id: 999 }]);

    const res = await buildApp().request('/api/projects/proj-1/tasks/task-1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, mockEnv);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'FORBIDDEN',
      message: 'GitHub repository access has changed; repository ID no longer matches',
    });
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });
});
