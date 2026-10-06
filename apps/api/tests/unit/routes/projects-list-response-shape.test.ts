import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/projects/crud';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

// Regression coverage for the ListProjectsResponse type fix: `projects` is
// declared `ProjectSummary[]`, matching what `toProjectSummaryResponse()`
// actually produces. Before the fix, the route cast each mapped item through
// `as unknown as Project` to satisfy a `Project[]` type the runtime payload
// never matched — a lie the type system could not catch. This test proves the
// live route emits ProjectSummary-shaped JSON (summary-only fields present,
// Project-only required fields absent) so a future re-introduction of that
// mismatch is caught, and that the mapped values are real (not stubbed).

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

const OWNER = 'user-owner';
const PROJECT_ALPHA = 'project-alpha';
const PROJECT_BETA = 'project-beta';

describe('GET /api/projects — ListProjectsResponse.projects shape', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function authContext(): AuthContext {
    return {
      user: {
        id: OWNER,
        email: 'owner@example.test',
        name: 'Project owner',
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: {
        id: 'session-owner',
        expiresAt: new Date('2026-08-10T00:00:00.000Z'),
      },
    };
  }

  function addProject(
    projectId: string,
    opts: { githubRepoId?: number; activeSessionCount?: number } = {}
  ): void {
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name, repo_provider, repository, default_branch, status, github_repo_id, active_session_count, last_activity_at, created_at)
         VALUES (?, ?, ?, 'github', ?, 'main', 'active', ?, ?, '2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
      )
      .run(
        projectId,
        OWNER,
        `Project ${projectId}`,
        `acme/${projectId}`,
        opts.githubRepoId ?? null,
        opts.activeSessionCount ?? 0
      );
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES (?, ?, 'owner', 'active')`
      )
      .run(projectId, OWNER);
  }

  function addWorkspace(workspaceId: string, projectId: string, status: string): void {
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, user_id, name, repository, status, vm_size, vm_location)
         VALUES (?, ?, ?, ?, 'acme/repo', ?, 'small', 'ash')`
      )
      .run(workspaceId, projectId, OWNER, `ws-${workspaceId}`, status);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);

    env = { DATABASE: createSqliteD1(sqlite) } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', authContext());
      await next();
    });
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/projects', crudRoutes);
  });

  afterEach(() => sqlite.close());

  it('returns ProjectSummary-shaped objects, not Project-shaped objects', async () => {
    addProject(PROJECT_ALPHA, { githubRepoId: 42, activeSessionCount: 3 });
    addWorkspace('ws-1', PROJECT_ALPHA, 'running');
    addWorkspace('ws-2', PROJECT_ALPHA, 'running');
    addWorkspace('ws-3', PROJECT_ALPHA, 'stopped'); // must not count toward activeWorkspaceCount

    const response = await app.request('/api/projects', { method: 'GET' }, env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { projects: unknown[]; nextCursor: string | null };
    expect(body.projects).toHaveLength(1);
    const project = body.projects[0] as Record<string, unknown>;

    // ProjectSummary-only fields must be present and correctly computed —
    // proves the mapper's real output reaches the client, not a stub.
    expect(project).toMatchObject({
      id: PROJECT_ALPHA,
      name: `Project ${PROJECT_ALPHA}`,
      githubRepoId: 42,
      activeSessionCount: 3,
      activeWorkspaceCount: 2,
      taskCountsByStatus: {},
      linkedWorkspaces: 0,
    });

    // Project-only required fields must be absent. If the route ever regresses
    // to leaking a full Project row (or a stale cast reintroduces the lie),
    // these keys would appear and this assertion would catch it.
    expect(project).not.toHaveProperty('userId');
    expect(project).not.toHaveProperty('description');
    expect(project).not.toHaveProperty('installationId');
    expect(project).not.toHaveProperty('normalizedName');
  });

  it('computes distinct activeWorkspaceCount per project across multiple rows', async () => {
    addProject(PROJECT_ALPHA);
    addProject(PROJECT_BETA);
    addWorkspace('ws-a1', PROJECT_ALPHA, 'running');
    addWorkspace('ws-b1', PROJECT_BETA, 'running');
    addWorkspace('ws-b2', PROJECT_BETA, 'running');

    const response = await app.request('/api/projects', { method: 'GET' }, env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      projects: Array<{ id: string; activeWorkspaceCount: number }>;
    };
    const byId = new Map(body.projects.map((p) => [p.id, p.activeWorkspaceCount]));
    expect(byId.get(PROJECT_ALPHA)).toBe(1);
    expect(byId.get(PROJECT_BETA)).toBe(2);
  });

  it('returns an empty projects array with no rows (all-empty case is not an error)', async () => {
    const response = await app.request('/api/projects', { method: 'GET' }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [], nextCursor: null });
  });
});
