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
  // Downstream submit/run boundaries — mocked so the happy-path tests can prove
  // the gate passes THROUGH to provisioning (rule 35 vertical slice: mock at
  // system boundaries, exercise the real route + real gate helper).
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  stopSession: vi.fn(),
  resolveCredentialSource: vi.fn(),
  generateTaskTitle: vi.fn(),
  getTaskTitleConfig: vi.fn(),
  enrichMessageWithMentions: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getAuth: () => ({ user: { id: 'user-1', name: 'User One', email: 'user-1@example.com' } }),
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
vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  recordActivityEvent: mocks.recordActivityEvent,
  stopSession: mocks.stopSession,
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
}));
vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: mocks.getTaskTitleConfig,
}));
vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: mocks.enrichMessageWithMentions,
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
    // `prepare` backs the optimistic-lock UPDATE in tasks/run.ts (line 191),
    // which bypasses Drizzle and hits the raw D1 binding. The run happy-path
    // test needs `meta.changes === 1` so the task transition is accepted.
    DATABASE: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run: vi.fn(() => Promise.resolve({ meta: { changes: 1 } })) })),
      })),
    } as unknown as D1Database,
    BASE_DOMAIN: 'sammy.party',
  } as Env;

  // ExecutionContext stub — submit.ts records a best-effort activity event via
  // `c.executionCtx.waitUntil` (line 399), so the happy-path request must carry one.
  const mockExecutionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

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
    mocks.requireOwnedTask.mockResolvedValue({
      id: 'task-1',
      status: 'ready',
      title: 'Task One',
      description: 'do the work',
    });
    mocks.createNodeRecord.mockResolvedValue({ id: 'node-1' });
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);

    // Downstream submit/run boundaries — default to success so the happy-path
    // tests reach provisioning. Each is mocked at its system boundary (rule 35).
    mocks.resolveCredentialSource.mockResolvedValue({ credentialSource: 'user' });
    mocks.getTaskTitleConfig.mockReturnValue({});
    mocks.generateTaskTitle.mockResolvedValue('Task title');
    mocks.enrichMessageWithMentions.mockResolvedValue({ enrichedMessage: 'Do the thing' });
    mocks.createSession.mockResolvedValue('sess-1');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.recordActivityEvent.mockResolvedValue(undefined);
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

  // Shared test helpers — collapse the repeated request/assertion boilerplate so
  // each test asserts only what is unique to its entry point.
  const REPO_NOT_ACCESSIBLE = 'Repository is not accessible through the selected installation';

  function post(path: string, body: unknown, ctx?: ExecutionContext): Promise<Response> {
    return buildApp().request(
      path,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      mockEnv,
      ctx
    );
  }

  async function expectForbidden(res: Response, message: string): Promise<void> {
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'FORBIDDEN', message });
  }

  // The gate always consults the user's OAuth token + the installation's EXTERNAL
  // id for the bound repository — assert that invariant from the happy-path tests.
  function expectGateRan(): void {
    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      expect.objectContaining({
        flow: 'project-access',
        userId: 'user-1',
        repository: 'acme/allowed-private',
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Workspace create: POST /api/workspaces
  // ---------------------------------------------------------------------------

  it('workspace create: returns 403 and does NOT provision a node when access is revoked', async () => {
    // Installation is still owned, but the user can no longer see the bound repo.
    limitResponses.push([INSTALLATION_ROW]);
    mocks.getUserInstallationRepositories.mockResolvedValue([OTHER_REPO]);

    const res = await post('/api/workspaces', { name: 'WS One', projectId: 'proj-1' });

    await expectForbidden(res, REPO_NOT_ACCESSIBLE);
    // Fail-fast: no node was ever created.
    expect(mocks.createNodeRecord).not.toHaveBeenCalled();
  });

  it('workspace create: gate passes and node provisioning is reached when access is intact', async () => {
    limitResponses.push([INSTALLATION_ROW]);
    whereResponses.push([{ count: 0 }]); // user node count
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    await post('/api/workspaces', { name: 'WS One', projectId: 'proj-1' });

    // Gate allowed the request through to provisioning.
    expect(mocks.createNodeRecord).toHaveBeenCalled();
    expectGateRan();
  });

  // ---------------------------------------------------------------------------
  // Task submit: POST /api/projects/:projectId/tasks/submit
  // ---------------------------------------------------------------------------

  it('task submit: returns 403 and does NOT start the Task Runner when access is revoked', async () => {
    limitResponses.push([INSTALLATION_ROW]);
    mocks.getUserInstallationRepositories.mockResolvedValue([OTHER_REPO]);

    const res = await post('/api/projects/proj-1/tasks/submit', { message: 'Do the thing' });

    await expectForbidden(res, REPO_NOT_ACCESSIBLE);
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('task submit: gate passes and the Task Runner is started when access is intact', async () => {
    // submit.ts post-gate db sequence: installation lookup (.limit, gate) ->
    // user githubId lookup (.limit). Downstream submission boundaries are mocked
    // (rule 35) so the request reaches startTaskRunnerDO.
    limitResponses.push([INSTALLATION_ROW]); // installation lookup (gate)
    limitResponses.push([{ githubId: null }]); // user githubId fallback lookup
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    await post('/api/projects/proj-1/tasks/submit', { message: 'Do the thing' }, mockExecutionCtx);

    // Gate ran (user OAuth token + external installation id) BEFORE provisioning.
    expectGateRan();
    // Gate allowed the request through to Task Runner provisioning.
    expect(mocks.startTaskRunnerDO).toHaveBeenCalled();
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

    const res = await post('/api/projects/proj-1/tasks/task-1/run', {});

    await expectForbidden(res, REPO_NOT_ACCESSIBLE);
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('task run: rejects with 403 when the repository id has drifted, before provisioning', async () => {
    whereResponses.push([]);
    limitResponses.push([{ id: 'cred-1' }]);
    limitResponses.push([makeProject({ githubRepoId: 42 })]);
    limitResponses.push([INSTALLATION_ROW]);
    // User can still see a repo with the bound full name, but a DIFFERENT id.
    mocks.getUserInstallationRepositories.mockResolvedValue([{ ...VISIBLE_REPO, id: 999 }]);

    const res = await post('/api/projects/proj-1/tasks/task-1/run', {});

    await expectForbidden(res, 'GitHub repository access has changed; repository ID no longer matches');
    expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  });

  it('task run: gate passes and the Task Runner is started when access is intact', async () => {
    // run.ts post-gate db sequence adds the user githubId lookup (.limit) after
    // the installation lookup. The optimistic-lock UPDATE goes through the raw
    // DATABASE.prepare mock (meta.changes === 1). createSession + startTaskRunnerDO
    // are mocked at their boundaries (rule 35) so the request reaches provisioning.
    whereResponses.push([]); // no task dependencies
    limitResponses.push([{ id: 'cred-1' }]); // cloud-provider credential present
    limitResponses.push([makeProject()]); // project load
    limitResponses.push([INSTALLATION_ROW]); // installation lookup (gate)
    limitResponses.push([{ githubId: null }]); // user githubId fallback lookup
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    const res = await post('/api/projects/proj-1/tasks/task-1/run', {});

    expect(res.status).toBe(202);
    // Gate ran (user OAuth token + external installation id) BEFORE provisioning.
    expectGateRan();
    // Gate allowed the request through to Task Runner provisioning.
    expect(mocks.startTaskRunnerDO).toHaveBeenCalled();
  });
});
