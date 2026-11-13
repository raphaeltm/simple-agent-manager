/**
 * `excludedSourceIds` (accounts a person switched off in a compute pool) through the real
 * PATCH routes, on a real SQLite engine (rule 28).
 *
 * Covered here: request validation (duplicate / non-array / over-limit / unknown id), clearing with
 * `[]` and `null`, an `excludedSourceIds`-only body, and the foreign-source attacks. Every attack
 * case sits beside an owner-path control built from the same fixture, so "nothing was written"
 * cannot also mean "the endpoint is broken".
 */
import {
  type CredentialProvider,
  MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedProjectWithMember as seedProjectMember,
  seedUser,
} from './capacity-pool-test-seeds';

const authState = vi.hoisted(() => ({ userId: 'user-1', role: 'user' }));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: any, next: any) => next(),
  requireApproved: () => async (_c: any, next: any) => next(),
  getUserId: () => authState.userId,
  getAuth: () => ({
    user: {
      id: authState.userId,
      email: `${authState.userId}@example.com`,
      name: authState.userId,
      avatarUrl: null,
      role: authState.role,
      status: 'active',
    },
    session: { id: 'session-1', token: null, expiresAt: new Date() },
  }),
}));

vi.mock('../../../src/services/provider-catalogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/provider-catalogs')>();
  return {
    ...actual,
    buildProviderCatalogForCredential: vi.fn(
      async (input: { seed: { provider: CredentialProvider } }) => ({
        offerings: actual.getStaticProviderCatalogOfferings(input.seed.provider),
        refreshStatus: {
          succeeded: true,
          origin: 'static',
          complete: false,
          reason: 'static-catalog',
        },
      })
    ),
  };
});

const { capacityPoolsRoutes } = await import('../../../src/routes/capacity-pools');
const { capacityPoolRoutes } = await import('../../../src/routes/projects/capacity-pools');

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/capacity-pools', capacityPoolsRoutes);
  app.route('/api/projects', capacityPoolRoutes);
  return app;
}

function createEnv() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectMembers,
    schema.credentials,
    schema.platformCredentials,
    schema.ccCredentials,
    schema.ccConfigurations,
    schema.ccAttachments,
    schema.platformSettings,
    schema.capacitySources,
    schema.capacityPools,
    schema.capacityPoolCandidates,
  ]);
  return { sqlite, env: { DATABASE: createSqliteD1(sqlite) } as Env };
}

/** The two PATCH surfaces share one body contract; each gets the same assertions. */
interface Surface {
  name: string;
  /** Seeds owner `user-1`'s credentials for this surface and returns the ids of its sources. */
  seed(sqlite: Database.Database, env: Env): Promise<{ a: string; b: string }>;
  patch(env: Env, body: unknown): Promise<Response>;
  /** The excluded column of the pool under test. */
  column(sqlite: Database.Database): string | null;
  /** The pool summary's excluded ids from a 200 body. */
  excludedFrom(body: any): string[];
}

async function sourcesFor(sqlite: Database.Database, where: string, ...args: string[]) {
  const rows = sqlite
    .prepare(`SELECT id FROM capacity_sources WHERE ${where} ORDER BY credential_id`)
    .all(...args) as Array<{ id: string }>;
  expect(rows.length).toBeGreaterThanOrEqual(2);
  return { a: rows[0]!.id, b: rows[1]!.id };
}

const userSurface: Surface = {
  name: 'user route',
  async seed(sqlite, env) {
    seedUser(sqlite, 'user-1');
    seedCloudCredential(sqlite, { id: 'cloud-a', userId: 'user-1', provider: 'hetzner' });
    seedCloudCredential(sqlite, { id: 'cloud-b', userId: 'user-1', provider: 'hetzner' });
    const res = await createApp().request(
      '/api/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(res.status).toBe(200);
    return sourcesFor(sqlite, "scope = 'user' AND owner_user_id = ?", 'user-1');
  },
  patch: (env, body) =>
    createApp().request(
      '/api/capacity-pools/defaults',
      { method: 'PATCH', body: JSON.stringify(body) },
      env
    ),
  column: (sqlite) =>
    (
      sqlite
        .prepare("SELECT excluded_source_ids_json AS v FROM capacity_pools WHERE scope = 'user'")
        .get() as { v: string | null }
    ).v,
  excludedFrom: (body) => body.effective.pool.excludedSourceIds,
};

const projectSurface: Surface = {
  name: 'project route',
  async seed(sqlite, env) {
    seedUser(sqlite, 'user-1');
    seedProjectMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'cloud-a',
      userId: 'user-1',
      projectId: 'project-1',
      provider: 'hetzner',
    });
    seedCloudCredential(sqlite, {
      id: 'cloud-b',
      userId: 'user-1',
      projectId: 'project-1',
      provider: 'hetzner',
    });
    const res = await createApp().request(
      '/api/projects/project-1/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(res.status).toBe(200);
    return sourcesFor(sqlite, "scope = 'project' AND owner_project_id = ?", 'project-1');
  },
  patch: (env, body) =>
    createApp().request(
      '/api/projects/project-1/capacity-pools/defaults',
      { method: 'PATCH', body: JSON.stringify(body) },
      env
    ),
  column: (sqlite) =>
    (
      sqlite
        .prepare("SELECT excluded_source_ids_json AS v FROM capacity_pools WHERE scope = 'project'")
        .get() as { v: string | null }
    ).v,
  excludedFrom: (body) => body.effective.pool.excludedSourceIds,
};

beforeEach(() => {
  authState.userId = 'user-1';
  authState.role = 'user';
});

describe.each([userSurface, projectSurface])('excludedSourceIds through the $name', (surface) => {
  it('switches an own account off with a body that carries only excludedSourceIds', async () => {
    const { sqlite, env } = createEnv();
    const { a, b } = await surface.seed(sqlite, env);
    expect(surface.column(sqlite)).toBeNull();

    const res = await surface.patch(env, { excludedSourceIds: [a] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(surface.excludedFrom(body)).toEqual([a]);
    expect(surface.column(sqlite)).toBe(JSON.stringify([a]));
    // Liveness: the other account is still a source of the pool and is not excluded.
    expect(surface.excludedFrom(body)).not.toContain(b);
    expect(
      body.effective.candidates.some((c: { capacitySourceId: string }) => c.capacitySourceId === b)
    ).toBe(true);
  });

  it('rejects a duplicate id with 400 and writes nothing', async () => {
    const { sqlite, env } = createEnv();
    const { a } = await surface.seed(sqlite, env);

    const res = await surface.patch(env, { excludedSourceIds: [a, a] });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      message: 'excludedSourceIds must not list a capacity source twice',
    });
    expect(surface.column(sqlite)).toBeNull();
    // Control: the same id listed once is accepted.
    expect((await surface.patch(env, { excludedSourceIds: [a] })).status).toBe(200);
  });

  it.each([
    ['a string', 'source-1'],
    ['an object', { id: 'x' }],
    ['a number', 3],
  ])('rejects %s instead of an array with 400', async (_label, value) => {
    const { sqlite, env } = createEnv();
    const { a } = await surface.seed(sqlite, env);

    const res = await surface.patch(env, { excludedSourceIds: value });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      message: 'excludedSourceIds must be an array of capacity source ids or null',
    });
    expect(surface.column(sqlite)).toBeNull();
    expect((await surface.patch(env, { excludedSourceIds: [a] })).status).toBe(200);
  });

  it('rejects more ids than MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH with 400', async () => {
    const { sqlite, env } = createEnv();
    const { a } = await surface.seed(sqlite, env);
    const tooMany = Array.from(
      { length: MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH + 1 },
      (_, index) => `source-${index}`
    );

    const res = await surface.patch(env, { excludedSourceIds: tooMany });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      message: `excludedSourceIds may list at most ${MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH} capacity sources`,
    });
    expect(surface.column(sqlite)).toBeNull();
    expect((await surface.patch(env, { excludedSourceIds: [a] })).status).toBe(200);
  });

  it('rejects an unknown id with 400 and names it in missingSourceIds', async () => {
    const { sqlite, env } = createEnv();
    const { a } = await surface.seed(sqlite, env);

    const res = await surface.patch(env, { excludedSourceIds: [a, 'no-such-source'] });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      details: { missingSourceIds: ['no-such-source'] },
    });
    // The valid id in the same body was not applied either: the edit is all or nothing.
    expect(surface.column(sqlite)).toBeNull();
  });

  it.each([[[]], [null]])('switches every account back on when sent %j', async (cleared) => {
    const { sqlite, env } = createEnv();
    const { a, b } = await surface.seed(sqlite, env);
    const off = await surface.patch(env, { excludedSourceIds: [a, b] });
    expect(off.status).toBe(200);
    expect(surface.column(sqlite)).toBe(JSON.stringify([a, b]));

    const res = await surface.patch(env, { excludedSourceIds: cleared });

    expect(res.status).toBe(200);
    expect(surface.excludedFrom(await res.json())).toEqual([]);
    expect(surface.column(sqlite)).toBeNull();
  });
});

describe('foreign sources are refused (user route)', () => {
  async function twoOwners() {
    const { sqlite, env } = createEnv();
    seedUser(sqlite, 'user-2');
    const own = await userSurface.seed(sqlite, env);
    seedCloudCredential(sqlite, { id: 'cloud-u2', userId: 'user-2', provider: 'hetzner' });
    authState.userId = 'user-2';
    const reconciled = await createApp().request(
      '/api/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(reconciled.status).toBe(200);
    authState.userId = 'user-1';
    const foreign = (
      sqlite
        .prepare(
          "SELECT id FROM capacity_sources WHERE scope = 'user' AND owner_user_id = 'user-2'"
        )
        .get() as { id: string }
    ).id;
    return { sqlite, env, own, foreign };
  }

  function columnOf(sqlite: Database.Database, userId: string) {
    return (
      sqlite
        .prepare(
          "SELECT excluded_source_ids_json AS v FROM capacity_pools WHERE scope = 'user' AND owner_user_id = ?"
        )
        .get(userId) as { v: string | null }
    ).v;
  }

  it("refuses another user's capacity source id, and leaves both pools untouched", async () => {
    const { sqlite, env, own, foreign } = await twoOwners();

    const attack = await userSurface.patch(env, { excludedSourceIds: [foreign] });

    expect(attack.status).toBe(400);
    await expect(attack.json()).resolves.toMatchObject({
      details: { missingSourceIds: [foreign] },
    });
    expect(columnOf(sqlite, 'user-1')).toBeNull();
    expect(columnOf(sqlite, 'user-2')).toBeNull();
    // The same foreign id is also refused as a provider order entry.
    const order = await userSurface.patch(env, { sourceOrder: [foreign] });
    expect(order.status).toBe(400);

    // Owner-path control from the same fixture: the caller's own source is accepted.
    const control = await userSurface.patch(env, { excludedSourceIds: [own.a] });
    expect(control.status).toBe(200);
    expect(columnOf(sqlite, 'user-1')).toBe(JSON.stringify([own.a]));
    expect(columnOf(sqlite, 'user-2')).toBeNull();
  });

  it('refuses a foreign source even when a corrupt candidate row points the caller pool at it', async () => {
    const { sqlite, env, own, foreign } = await twoOwners();
    // Defence in depth: the pool predicate alone would accept this, only the owner scope refuses.
    sqlite.exec(`
      INSERT INTO capacity_pool_candidates
        (id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
         machine_class, provider_instance_type, catalog_availability, status, priority,
         candidate_order, created_at, updated_at)
      SELECT 'corrupt-candidate', pool_id, '${foreign}', provider, location, workload_role,
             runtime, machine_class, provider_instance_type, catalog_availability, status,
             priority, candidate_order, created_at, updated_at
      FROM capacity_pool_candidates
      WHERE capacity_source_id = '${own.a}' LIMIT 1;
    `);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM capacity_pool_candidates WHERE id = 'corrupt-candidate'"
        )
        .get()
    ).toEqual({ n: 1 });

    const attack = await userSurface.patch(env, { excludedSourceIds: [foreign] });

    expect(attack.status).toBe(400);
    expect(columnOf(sqlite, 'user-1')).toBeNull();
    expect((await userSurface.patch(env, { excludedSourceIds: [own.b] })).status).toBe(200);
  });

  it('refuses a same-owner source that only serves a different pool of the same owner', async () => {
    const { sqlite, env, own } = await twoOwners();
    const copyRow = (table: string, where: string, overrides: Record<string, unknown>) => {
      const row = sqlite.prepare(`SELECT * FROM ${table} WHERE ${where}`).get() as Record<
        string,
        unknown
      >;
      const next = { ...row, ...overrides };
      const columns = Object.keys(next);
      sqlite
        .prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        )
        .run(...columns.map((column) => next[column] as never));
    };
    // The same person's non-default pool, served by a source that is theirs but not in the default pool.
    copyRow('capacity_pools', "scope = 'user' AND owner_user_id = 'user-1'", {
      id: 'pool-other',
      is_default: 0,
      name: 'Other pool',
    });
    copyRow('capacity_sources', `id = '${own.a}'`, {
      id: 'source-other',
      credential_id: 'cloud-a',
      external_source_ref: 'other',
    });
    copyRow('capacity_pool_candidates', `capacity_source_id = '${own.a}'`, {
      id: 'candidate-other',
      pool_id: 'pool-other',
      capacity_source_id: 'source-other',
    });

    const attack = await userSurface.patch(env, { excludedSourceIds: ['source-other'] });

    expect(attack.status).toBe(400);
    await expect(attack.json()).resolves.toMatchObject({
      details: { missingSourceIds: ['source-other'] },
    });
    expect(columnOf(sqlite, 'user-1')).toBeNull();
    // Control: the default pool's own source is accepted.
    expect((await userSurface.patch(env, { excludedSourceIds: [own.b] })).status).toBe(200);
  });

  it('refuses a same-owner source whose only candidates in this pool are deleted', async () => {
    const { sqlite, env, own } = await twoOwners();
    // The person removed every machine of account A from the pool.
    sqlite
      .prepare(
        "UPDATE capacity_pool_candidates SET status = 'deleted' WHERE capacity_source_id = ?"
      )
      .run(own.a);

    const attack = await userSurface.patch(env, { excludedSourceIds: [own.a] });

    expect(attack.status).toBe(400);
    await expect(attack.json()).resolves.toMatchObject({ details: { missingSourceIds: [own.a] } });
    expect(columnOf(sqlite, 'user-1')).toBeNull();
    // Control: account B still has live candidates and can be switched off.
    expect((await userSurface.patch(env, { excludedSourceIds: [own.b] })).status).toBe(200);
    expect(columnOf(sqlite, 'user-1')).toBe(JSON.stringify([own.b]));
  });
});

describe('foreign sources are refused (project route)', () => {
  it("refuses another project's source id, and leaves both project pools untouched", async () => {
    const { sqlite, env } = createEnv();
    const own = await projectSurface.seed(sqlite, env);
    // The same person owns a second project with its own project-scoped credential.
    seedProjectMember(sqlite, { projectId: 'project-2', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, {
      id: 'cloud-p2',
      userId: 'user-1',
      projectId: 'project-2',
      provider: 'hetzner',
    });
    const reconciled = await createApp().request(
      '/api/projects/project-2/capacity-pools/defaults/reconcile',
      { method: 'POST' },
      env
    );
    expect(reconciled.status).toBe(200);
    const foreign = (
      sqlite
        .prepare(
          "SELECT id FROM capacity_sources WHERE scope = 'project' AND owner_project_id = 'project-2'"
        )
        .get() as { id: string }
    ).id;
    const column = (projectId: string) =>
      (
        sqlite
          .prepare(
            "SELECT excluded_source_ids_json AS v FROM capacity_pools WHERE scope = 'project' AND owner_project_id = ?"
          )
          .get(projectId) as { v: string | null }
      ).v;

    const attack = await projectSurface.patch(env, { excludedSourceIds: [foreign] });

    expect(attack.status).toBe(400);
    await expect(attack.json()).resolves.toMatchObject({
      details: { missingSourceIds: [foreign] },
    });
    expect(column('project-1')).toBeNull();
    expect(column('project-2')).toBeNull();

    // Owner-path control: project-1's own source is accepted in the same fixture.
    const control = await projectSurface.patch(env, { excludedSourceIds: [own.a] });
    expect(control.status).toBe(200);
    expect(column('project-1')).toBe(JSON.stringify([own.a]));
    expect(column('project-2')).toBeNull();
  });
});
