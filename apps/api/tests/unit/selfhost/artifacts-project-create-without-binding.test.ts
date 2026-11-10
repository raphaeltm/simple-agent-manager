/**
 * POST /api/projects with repoProvider "artifacts" through the real project CRUD routes, real
 * request validation, real SQLite and the real global error handler.
 *
 * ARTIFACTS_ENABLED="true" with no ARTIFACTS binding used to be a 500 ("binding is not
 * configured"): the installation cannot serve the request, which is not a server fault. It is
 * now a designed 404 FEATURE_UNAVAILABLE for `artifacts`. The Cloudflare path (flag and binding
 * both present) must still create the repository and the project.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import type { AuthContext } from '../../../src/middleware/auth';
import { crudRoutes } from '../../../src/routes/projects/crud';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const seedReadme = vi.hoisted(() => vi.fn());

// The README seed is a git push over HTTPS to the Artifacts remote: an external boundary.
vi.mock('../../../src/services/artifacts/seed-readme', () => ({ seedArtifactsReadme: seedReadme }));

const OWNER = 'user-owner';

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
    session: { id: 'session-owner', expiresAt: new Date('2027-01-01T00:00:00.000Z') },
  };
}

describe('POST /api/projects (repoProvider: artifacts)', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;
  let artifactsCreate: ReturnType<typeof vi.fn>;

  const projectCount = () =>
    (sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;

  const env = (overrides: Record<string, unknown> = {}): Env =>
    ({ DATABASE: createSqliteD1(sqlite), ...overrides }) as unknown as Env;

  const create = (testEnv: Env) =>
    app.request(
      '/api/projects',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Self Hosted Notes', repoProvider: 'artifacts' }),
      },
      testEnv
    );

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedReadme.mockReset().mockResolvedValue(undefined);
    artifactsCreate = vi.fn(async (name: string) => ({
      name,
      remote: `https://artifacts.example.test/git/${name}.git`,
      token: 'art_v1_fixture',
    }));
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', authContext());
      await next();
    });
    app.onError(handleAppError);
    app.route('/api/projects', crudRoutes);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('with the flag and the binding creates the repository, seeds it and stores the project (Cloudflare behaviour)', async () => {
    const res = await create(
      env({ ARTIFACTS_ENABLED: 'true', ARTIFACTS: { create: artifactsCreate, delete: vi.fn() } })
    );

    expect(res.status).toBe(201);
    expect(artifactsCreate).toHaveBeenCalledTimes(1);
    expect(seedReadme).toHaveBeenCalledTimes(1);
    const row = sqlite
      .prepare('SELECT repo_provider, artifacts_repo_id, repository FROM projects')
      .get() as { repo_provider: string; artifacts_repo_id: string; repository: string };
    expect(row.repo_provider).toBe('artifacts');
    expect(row.repository).toBe(`https://artifacts.example.test/git/${row.artifacts_repo_id}.git`);
  });

  it('with the flag but no binding answers 404 FEATURE_UNAVAILABLE for artifacts, not a 500', async () => {
    const res = await create(env({ ARTIFACTS_ENABLED: 'true' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'FEATURE_UNAVAILABLE',
      message: 'SAM-native Git repositories are not available on this installation',
      details: { feature: 'artifacts' },
    });
    // Nothing was created or seeded for an installation that cannot serve the request.
    expect(artifactsCreate).not.toHaveBeenCalled();
    expect(seedReadme).not.toHaveBeenCalled();
    expect(projectCount()).toBe(0);
  });

  it('keeps the existing 400 when the flag is off, with or without the binding', async () => {
    const withoutBinding = await create(env());
    const withBinding = await create(
      env({ ARTIFACTS: { create: artifactsCreate, delete: vi.fn() } })
    );

    expect(withoutBinding.status).toBe(400);
    expect(withBinding.status).toBe(400);
    expect(artifactsCreate).not.toHaveBeenCalled();
    expect(projectCount()).toBe(0);
  });
});
