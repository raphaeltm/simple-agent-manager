/**
 * The compute pool, not a project or agent-profile setting, decides which provider and location
 * a VM uses.
 *
 * Projects and agent profiles used to carry a default provider and location. The provider was a
 * hard filter on the pool (`normalizeCapacityCandidate()`), so a project with
 * `default_provider = 'hetzner'` could not use a Scaleway offering its own pool allowed, and failed
 * with "no eligible offering" when that was the only one. The columns are kept for history but are
 * no longer read.
 *
 * Every case runs on a real SQLite engine with rows that still hold the retired values, and the
 * allocation cases go through the real allocation entry point (`resolveCanonicalVmAllocationPlan`).
 */
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/projects/crud';
import { resolveAgentProfile } from '../../../src/services/agent-profiles';
import {
  placementProjectDefaultsFromRow,
  resolveCanonicalVmAllocationPlan,
} from '../../../src/services/canonical-vm-allocation';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { baseProfileInsertValues } from '../../../src/services/profile-fields';
import { offering } from '../../helpers/capacity-pool-offerings';
import {
  createAllSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedProjectWithMember,
  seedUser,
} from '../routes/capacity-pool-test-seeds';

const PROJECT_ID = 'project-1';
const USER_ID = 'user-1';

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

/**
 * A project pool with a Hetzner and a Scaleway account, each offering one machine. The project
 * row is seeded with the retired `default_provider = 'hetzner'` / `default_location = 'fsn1'`
 * (`seedProjectWithMember`), which is exactly the state an existing project is in.
 */
async function twoProviderProjectPool() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, USER_ID);
  seedProjectWithMember(sqlite, { projectId: PROJECT_ID, userId: USER_ID, role: 'owner' });
  seedCloudCredential(sqlite, {
    id: 'cloud-hetzner',
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'hetzner',
  });
  seedCloudCredential(sqlite, {
    id: 'cloud-scaleway',
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'scaleway',
  });

  const database = createSqliteD1WithBindLimit(sqlite, 100);
  const d1 = drizzle(database, { schema });
  const env = { DATABASE: database } as unknown as Env;
  await ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
    userId: USER_ID,
    projectId: PROJECT_ID,
    includeInstallation: false,
    candidatePublishBatchSize: 1000,
    offeringResolver: async (seed) =>
      seed.provider === 'scaleway'
        ? [offering('scaleway', 'fr-par-1', 'PRO2-S', { currency: 'EUR' })]
        : [offering('hetzner', 'fsn1', 'cx33', { currency: 'EUR' })],
  });
  const poolScope = { scope: 'project', ownerUserId: null, ownerProjectId: PROJECT_ID } as const;
  const picked = await updateDefaultCapacityPool(d1 as never, {
    ...poolScope,
    candidates: (
      sqlite
        .prepare("SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace'")
        .all() as Array<{ id: string }>
    ).map(({ id }) => ({ id, status: 'active' as const })),
  });
  expect(picked.conflict).toBe(false);

  const sourceIdFor = (provider: string) =>
    (
      sqlite!
        .prepare('SELECT id FROM capacity_sources WHERE scope = ? AND provider = ?')
        .get('project', provider) as { id: string }
    ).id;

  // Production callers read the full project row and hand it to the placement mapper.
  const [projectRow] = await d1
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, PROJECT_ID));
  expect(projectRow).toMatchObject({ defaultProvider: 'hetzner', defaultLocation: 'fsn1' });

  const allocate = (explicit?: { provider?: 'hetzner' | 'scaleway'; vmLocation?: string }) =>
    resolveCanonicalVmAllocationPlan(d1 as never, env, {
      entryPoint: 'task-submit',
      taskId: 'task-pool-decides',
      userId: USER_ID,
      projectId: PROJECT_ID,
      project: placementProjectDefaultsFromRow(projectRow!),
      explicit,
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'task',
      workloadRole: 'workspace',
      capacityPoolEnsure: false,
    });
  const switchOff = (provider: string) =>
    updateDefaultCapacityPool(d1 as never, {
      ...poolScope,
      excludedSourceIds: [sourceIdFor(provider)],
    });

  return { allocate, switchOff };
}

function eligibleProviders(plan: Awaited<ReturnType<typeof resolveCanonicalVmAllocationPlan>>) {
  if ('error' in plan) throw new Error(`allocation failed: ${plan.error}`);
  return [...new Set(plan.eligibleCapacityPoolSelection?.candidates.map((c) => c.provider))].sort();
}

describe('the compute pool decides the provider, not the project row', () => {
  it('places on the only provider the pool allows even though the project row still says hetzner', async () => {
    const { allocate, switchOff } = await twoProviderProjectPool();
    const off = await switchOff('hetzner');
    expect(off.conflict).toBe(false);

    const plan = await allocate();

    // Before the change the stored default_provider dropped the Scaleway offering and this
    // returned { error: 'No eligible compute-pool offering ...', errorKind: 'placement' }.
    expect(plan).not.toHaveProperty('error');
    expect(plan).toMatchObject({
      effectiveProvider: 'scaleway',
      vmLocation: 'fr-par-1',
      providerInstanceType: 'PRO2-S',
    });
  });

  it('keeps every provider in the pool eligible when the pool allows several', async () => {
    const { allocate } = await twoProviderProjectPool();

    const plan = await allocate();

    // Before the change only hetzner survived the project's stored default.
    expect(eligibleProviders(plan)).toEqual(['hetzner', 'scaleway']);
  });

  it('still narrows to a provider requested explicitly for one piece of work (control)', async () => {
    const { allocate } = await twoProviderProjectPool();

    const scalewayOnly = await allocate({ provider: 'scaleway' });
    expect(eligibleProviders(scalewayOnly)).toEqual(['scaleway']);
    expect(scalewayOnly).toMatchObject({ effectiveProvider: 'scaleway' });

    const hetznerOnly = await allocate({ provider: 'hetzner', vmLocation: 'fsn1' });
    expect(eligibleProviders(hetznerOnly)).toEqual(['hetzner']);
    expect(hetznerOnly).toMatchObject({ effectiveProvider: 'hetzner', vmLocation: 'fsn1' });
  });
});

describe('agent profiles carry no provider or location', () => {
  it('ignores a provider and location still stored on a profile row when resolving it', async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, USER_ID);
    seedProjectWithMember(sqlite, { projectId: PROJECT_ID, userId: USER_ID, role: 'owner' });
    const now = '2026-11-14T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO agent_profiles
           (id, project_id, user_id, name, agent_type, provider, vm_location, created_at, updated_at)
         VALUES ('profile-legacy', ?, ?, 'Legacy placement', 'claude-code', 'hetzner', 'fsn1', ?, ?)`
      )
      .run(PROJECT_ID, USER_ID, now, now);
    const database = createSqliteD1(sqlite);
    const d1 = drizzle(database, { schema });

    const resolved = await resolveAgentProfile(d1 as never, PROJECT_ID, 'profile-legacy', USER_ID, {
      DATABASE: database,
    } as unknown as Env);

    // Liveness: the profile row was found and resolved.
    expect(resolved).toMatchObject({ profileId: 'profile-legacy', agentType: 'claude-code' });
    expect(resolved).not.toHaveProperty('provider');
    expect(resolved).not.toHaveProperty('vmLocation');
  });

  it('never writes a provider or location for a new profile or skill', () => {
    const values = baseProfileInsertValues(
      // An old client may still send the retired fields.
      { model: 'opus', provider: 'hetzner', vmLocation: 'fsn1' } as never,
      { DEFAULT_TASK_AGENT_TYPE: 'claude-code' }
    );

    expect(values).toMatchObject({ model: 'opus', agentType: 'claude-code' });
    expect(values).not.toHaveProperty('provider');
    expect(values).not.toHaveProperty('vmLocation');
  });
});

describe('PATCH /api/projects/:id no longer accepts a default provider or location', () => {
  const OWNER = 'user-owner';
  const PATCH_PROJECT_ID = 'project-patch';

  function app(db: Database.Database) {
    const env = { DATABASE: createSqliteD1(db) } as Env;
    const router = new Hono<{ Bindings: Env }>();
    router.use('*', async (c, next) => {
      c.set('auth', {
        user: {
          id: OWNER,
          email: 'owner@example.test',
          name: 'Project owner',
          avatarUrl: null,
          role: 'user',
          status: 'active',
        },
        session: { id: 'session-owner', expiresAt: new Date('2027-01-01T00:00:00.000Z') },
      } satisfies AuthContext);
      await next();
    });
    router.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    router.route('/api/projects', crudRoutes);
    return (body: Record<string, unknown>) =>
      router.request(
        `/api/projects/${PATCH_PROJECT_ID}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env
      );
  }

  // installation_id stays NULL so the PATCH handler skips its GitHub repository-access recheck.
  function seed(): Database.Database {
    const db = new Database(':memory:');
    createAllSchemaTables(db, schema);
    const now = '2026-11-14T00:00:00.000Z';
    db.prepare(
      `INSERT INTO projects
         (id, user_id, name, normalized_name, repository, default_branch, repo_provider, status,
          default_provider, default_location, created_by, created_at, updated_at)
       VALUES (?, ?, 'Patch Project', 'patch project', 'acme/repo', 'main', 'github', 'active',
          'hetzner', 'fsn1', ?, ?, ?)`
    ).run(PATCH_PROJECT_ID, OWNER, OWNER, now, now);
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, 'owner', 'active', ?, ?)`
    ).run(PATCH_PROJECT_ID, OWNER, now, now);
    return db;
  }

  function stored(db: Database.Database) {
    return db
      .prepare('SELECT description, default_provider, default_location FROM projects WHERE id = ?')
      .get(PATCH_PROJECT_ID) as {
      description: string | null;
      default_provider: string | null;
      default_location: string | null;
    };
  }

  it('treats a body with only the retired fields as empty', async () => {
    sqlite = seed();
    const patch = app(sqlite);

    const response = await patch({ defaultProvider: 'scaleway', defaultLocation: 'fr-par-1' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/at least one field/i);
    expect(stored(sqlite)).toMatchObject({ default_provider: 'hetzner', default_location: 'fsn1' });
  });

  it('applies the other fields, ignores the retired ones, and omits them from the response', async () => {
    sqlite = seed();
    const patch = app(sqlite);

    const response = await patch({ description: 'updated', defaultProvider: 'scaleway' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.description).toBe('updated');
    expect(body).not.toHaveProperty('defaultProvider');
    expect(body).not.toHaveProperty('defaultLocation');
    expect(stored(sqlite)).toMatchObject({ description: 'updated', default_provider: 'hetzner' });
  });
});
