import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { capacityPlacementAuthorityGeneration } from '../../src/services/capacity-pool-authority';
import { resolveCapacityPoolPlacementSettings } from '../../src/services/capacity-pool-placement-settings';
import { assertNodeAllocationPlanCurrent } from '../../src/services/nodes';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

let sqlite: Database.Database | null = null;

function makeEnv(): Env {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.nodes,
    schema.capacityPools,
    schema.capacitySources,
    schema.capacityPoolCandidates,
    schema.platformSettings,
  ]);
  return { DATABASE: createSqliteD1(sqlite) } as Env;
}

function seedCurrentPlan(
  overrides: { node?: string; pool?: string; source?: string; candidate?: string } = {}
) {
  sqlite?.exec(`
    INSERT INTO capacity_pools
      (id, scope, owner_project_id, name, is_default, revision, status, configuration_state)
    VALUES
      ('pool-1', 'project', 'project-1', 'Project pool', 1, 7, 'active', 'configured-ready');

    INSERT INTO capacity_sources
      (id, scope, owner_project_id, source_kind, provider, credential_source, credential_reference, credential_version, status)
    VALUES
      ('source-1', 'project', 'project-1', 'cloud-provider-credential', 'hetzner', 'project', 'credentials:cred-1', 3, 'active');

    INSERT INTO capacity_pool_candidates
      (id, pool_id, capacity_source_id, provider, location, workload_role, provider_instance_type, catalog_availability, status)
    VALUES
      ('candidate-1', 'pool-1', 'source-1', 'hetzner', 'fsn1', 'workspace', 'cx42', 'available', 'active');

    INSERT INTO nodes
      (
        id, user_id, name, status, capacity_pool_id, capacity_pool_scope, capacity_pool_revision,
        capacity_source_id, capacity_pool_candidate_id, capacity_pool_project_id,
        placement_credential_reference, placement_credential_version, provider_instance_type
      )
    VALUES
      (
        'node-1', 'user-1', 'node-1', 'creating', 'pool-1', 'project', 7,
        'source-1', 'candidate-1', 'project-1', 'credentials:cred-1', 3, 'cx42'
      );
  `);

  for (const sql of Object.values(overrides)) sqlite?.exec(sql);
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('node allocation plan guard', () => {
  it('allows a current project-pool plan and legacy unpooled nodes', async () => {
    const env = makeEnv();
    seedCurrentPlan();

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).resolves.toBeUndefined();

    sqlite?.exec(`
      INSERT INTO nodes (id, user_id, name, status)
      VALUES ('legacy-node', 'user-1', 'legacy-node', 'running')
    `);
    await expect(
      assertNodeAllocationPlanCurrent(env, 'legacy-node', 'user-1', 'project-1')
    ).resolves.toBeUndefined();
  });

  it('rejects explicit node placement for the wrong user or project', async () => {
    const env = makeEnv();
    seedCurrentPlan();

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-2', 'project-1')
    ).rejects.toThrow('Node allocation user changed before provider allocation');
    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-2')
    ).rejects.toThrow('Selected project capacity pool no longer matches this allocation');
  });

  it.each([
    [
      'pool revision changed',
      `UPDATE capacity_pools SET revision = 8`,
      'Selected capacity pool changed after placement was planned',
    ],
    [
      'pool disabled',
      `UPDATE capacity_pools SET status = 'disabled'`,
      'Selected capacity pool is not currently usable',
    ],
    [
      'source disabled',
      `UPDATE capacity_sources SET status = 'disabled'`,
      'Selected capacity source is not currently active',
    ],
    [
      'candidate disabled',
      `UPDATE capacity_pool_candidates SET status = 'disabled'`,
      'Selected capacity candidate is not currently active',
    ],
    [
      'candidate unavailable',
      `UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable'`,
      'Selected capacity candidate is no longer available in the provider catalog',
    ],
    [
      'credential rotated',
      `UPDATE capacity_sources SET credential_reference = 'credentials:cred-2'`,
      'Selected capacity source credential reference changed after placement',
    ],
    [
      'node deleted',
      `UPDATE nodes SET status = 'deleted'`,
      'Node allocation lifecycle is no longer active',
    ],
  ])('rejects stale plan: %s', async (_name, mutation, message) => {
    const env = makeEnv();
    seedCurrentPlan({ node: mutation });

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).rejects.toThrow(message);
  });

  it('rejects when current semantic capacity authority no longer matches the planned snapshot', async () => {
    const env = makeEnv();
    seedCurrentPlan();
    sqlite?.exec(`
      UPDATE capacity_sources SET authority_generation = 101 WHERE id = 'source-1';
      UPDATE capacity_pool_candidates SET authority_generation = 202 WHERE id = 'candidate-1';
    `);
    const settings = await resolveCapacityPoolPlacementSettings(
      drizzle(env.DATABASE, { schema }),
      env
    );
    const plannedAuthority = capacityPlacementAuthorityGeneration({
      poolRevision: 7,
      selectionSettingsGeneration: settings.placementSettings.sourceGeneration,
      sourceAuthorityGeneration: 101,
      candidateAuthorityGeneration: 202,
    });
    sqlite
      ?.prepare(
        `
        UPDATE nodes
        SET selection_settings_version = ?, capacity_authority_generation = ?
        WHERE id = 'node-1'
      `
      )
      .run(settings.placementSettings.sourceGeneration, plannedAuthority);

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).resolves.toBeUndefined();

    sqlite?.exec('UPDATE capacity_pool_candidates SET authority_generation = 303');

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).rejects.toThrow('Selected capacity authority changed after placement');
  });
});
