import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { capacityPlacementAuthorityGeneration } from '../../src/services/capacity-pool-authority';
import { resolveCapacityPoolPlacementSettings } from '../../src/services/capacity-pool-placement-settings';
import { assertNodeAllocationPlanCurrent } from '../../src/services/nodes';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const AUTHORITY_VERSION = 1_700_000_000_000;
const AUTHORITY_TIMESTAMP = new Date(AUTHORITY_VERSION).toISOString();

let sqlite: Database.Database | null = null;

function makeEnv(): Env {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return { DATABASE: createSqliteD1(sqlite) } as Env;
}

function seedCurrentPlan(overrides: string[] = []) {
  sqlite?.exec(`
    INSERT INTO project_members
      (project_id, user_id, role, status, removed_at, created_at, updated_at)
    VALUES
      ('project-1', 'user-1', 'owner', 'active', NULL, '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO credentials
      (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
    VALUES
      ('cred-1', 'project-owner', 'project-1', 'hetzner', 'cloud-provider', 1, 'encrypted-token', 'iv', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_pools
      (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
       configuration_state, strategy, exhaustion_policy, migration_state, created_at, updated_at)
    VALUES
      ('pool-1', 'project', NULL, 'project-1', 'Project pool', 1, 7, 'active',
       'configured-ready', 'balanced', 'queue', 'complete', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_sources
      (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
       credential_id, platform_credential_id, credential_reference, credential_version,
       external_source_ref, status, created_at, updated_at)
    VALUES
      ('source-1', 'project', NULL, 'project-1', 'cloud-provider-credential', 'hetzner', 'project',
       'cred-1', NULL, 'credentials:cred-1', ${AUTHORITY_VERSION},
       NULL, 'active', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_pool_candidates
      (id, pool_id, capacity_source_id, provider, location, workload_role, provider_instance_type,
       provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
       provider_instance_boot_disk_size_gb, provider_instance_image, provider_instance_architecture,
       catalog_availability, status, priority, candidate_order, created_at, updated_at)
    VALUES
      ('candidate-1', 'pool-1', 'source-1', 'hetzner', 'fsn1', 'workspace', 'cx42',
       8, 16384, 240, 80, 'ubuntu-24.04', 'x86_64',
       'available', 'active', 0, 0, '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO nodes
      (
        id, user_id, name, status, runtime, node_class, node_role, workload_role, cloud_provider,
        vm_location, capacity_pool_id, capacity_pool_scope, capacity_pool_revision,
        capacity_source_id, capacity_source_generation, capacity_source_external_ref,
        capacity_pool_candidate_id, capacity_pool_project_id,
        placement_credential_source, placement_credential_reference, placement_credential_version,
        provider_instance_type, provider_instance_vcpu_count, provider_instance_memory_mb,
        provider_instance_disk_gb, provider_instance_boot_disk_size_gb,
        provider_instance_image, provider_instance_architecture
      )
    VALUES
      (
        'node-1', 'user-1', 'node-1', 'creating', 'vm', 'managed', 'workspace', 'workspace', 'hetzner',
        'fsn1', 'pool-1', 'project', 7,
        'source-1', ${AUTHORITY_VERSION}, NULL,
        'candidate-1', 'project-1',
        'project', 'credentials:cred-1', ${AUTHORITY_VERSION},
        'cx42', 8, 16384, 240, 80, 'ubuntu-24.04', 'x86_64'
      );
  `);

  for (const sql of overrides) sqlite?.exec(sql);
}

function seedLegacyUnpooledNode(): void {
  sqlite?.exec(`
    INSERT INTO project_members
      (project_id, user_id, role, status, removed_at, created_at, updated_at)
    VALUES
      ('project-1', 'user-1', 'owner', 'active', NULL, '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO nodes
      (id, user_id, name, status, runtime, node_class, node_role, workload_role, cloud_provider, vm_location)
    VALUES
      ('legacy-node', 'user-1', 'legacy-node', 'running', 'vm', 'managed', 'workspace', 'workspace', 'hetzner', 'fsn1')
  `);
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('node allocation plan guard', () => {
  it('allows a current project-pool plan', async () => {
    const env = makeEnv();
    seedCurrentPlan();

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).resolves.toBeUndefined();
  });

  it('fails closed when the D1 boundary does not provide prepare()', async () => {
    await expect(
      assertNodeAllocationPlanCurrent({ DATABASE: {} } as Env, 'node-1', 'user-1', 'project-1')
    ).rejects.toThrow('Node allocation authority database is unavailable');
  });

  it('allows legacy unpooled nodes only while no configured pool claims the placement scope', async () => {
    const env = makeEnv();
    seedLegacyUnpooledNode();

    await expect(
      assertNodeAllocationPlanCurrent(env, 'legacy-node', 'user-1', 'project-1')
    ).resolves.toBeUndefined();

    sqlite?.exec(`
      INSERT INTO capacity_pools
        (id, scope, owner_project_id, name, is_default, revision, status, configuration_state)
      VALUES
        ('blocking-project-pool', 'project', 'project-1', 'Project pool', 1, 1, 'active', 'configured-ready')
    `);

    await expect(
      assertNodeAllocationPlanCurrent(env, 'legacy-node', 'user-1', 'project-1')
    ).rejects.toThrow('Node allocation plan is no longer current');
  });

  it('rejects explicit node placement for the wrong user or project', async () => {
    const env = makeEnv();
    seedCurrentPlan();

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-2', 'project-1')
    ).rejects.toThrow('Node allocation user changed before provider allocation');
    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-2')
    ).rejects.toThrow('Node allocation plan is no longer current');
  });

  it.each([
    [
      'membership removed',
      `UPDATE project_members SET status = 'removed', removed_at = '${AUTHORITY_TIMESTAMP}'`,
    ],
    ['project membership missing', `DELETE FROM project_members`],
    ['underlying credential missing', `DELETE FROM credentials WHERE id = 'cred-1'`],
    ['credential disabled', `UPDATE credentials SET is_active = 0 WHERE id = 'cred-1'`],
    [
      'credential generation rotated',
      `UPDATE credentials SET updated_at = '2023-11-14T22:13:21.000Z' WHERE id = 'cred-1'`,
    ],
    ['pool revision changed', `UPDATE capacity_pools SET revision = 8`],
    ['pool disabled', `UPDATE capacity_pools SET status = 'disabled'`],
    [
      'pool configuration empty',
      `UPDATE capacity_pools SET configuration_state = 'configured-empty'`,
    ],
    ['pool owned by another project', `UPDATE capacity_pools SET owner_project_id = 'project-2'`],
    ['source disabled', `UPDATE capacity_sources SET status = 'disabled'`],
    [
      'source generation changed',
      `UPDATE capacity_sources SET updated_at = '2023-11-14T22:13:21.000Z'`,
    ],
    [
      'source credential reference cleared',
      `UPDATE capacity_sources SET credential_reference = NULL`,
    ],
    ['source credential version cleared', `UPDATE capacity_sources SET credential_version = NULL`],
    ['source credential detached', `UPDATE capacity_sources SET credential_id = NULL`],
    [
      'source owned by another project',
      `UPDATE capacity_sources SET owner_project_id = 'project-2'`,
    ],
    ['candidate disabled', `UPDATE capacity_pool_candidates SET status = 'disabled'`],
    [
      'candidate unavailable',
      `UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable'`,
    ],
    [
      'candidate attached to another pool',
      `UPDATE capacity_pool_candidates SET pool_id = 'pool-2'`,
    ],
    [
      'candidate attached to another source',
      `UPDATE capacity_pool_candidates SET capacity_source_id = 'source-2'`,
    ],
    ['candidate provider changed', `UPDATE capacity_pool_candidates SET provider = 'gcp'`],
    ['candidate location changed', `UPDATE capacity_pool_candidates SET location = 'nbg1'`],
    ['candidate role changed', `UPDATE capacity_pool_candidates SET workload_role = 'deployment'`],
    [
      'candidate native type changed',
      `UPDATE capacity_pool_candidates SET provider_instance_type = 'cx22'`,
    ],
    [
      'candidate native image changed',
      `UPDATE capacity_pool_candidates SET provider_instance_image = 'debian-12'`,
    ],
    ['node source id cleared', `UPDATE nodes SET capacity_source_id = NULL WHERE id = 'node-1'`],
    [
      'node credential version cleared',
      `UPDATE nodes SET placement_credential_version = NULL WHERE id = 'node-1'`,
    ],
    ['node provider mismatch', `UPDATE nodes SET cloud_provider = 'gcp' WHERE id = 'node-1'`],
    ['node location mismatch', `UPDATE nodes SET vm_location = 'nbg1' WHERE id = 'node-1'`],
    ['node role mismatch', `UPDATE nodes SET workload_role = 'deployment' WHERE id = 'node-1'`],
    ['node status destroying', `UPDATE nodes SET status = 'destroying' WHERE id = 'node-1'`],
  ])('rejects stale plan: %s', async (_name, mutation) => {
    const env = makeEnv();
    seedCurrentPlan([mutation]);

    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).rejects.toThrow('Node allocation plan is no longer current');
  });

  it('keeps semantic source authority stable across a catalog refresh', async () => {
    const env = makeEnv();
    seedCurrentPlan();
    sqlite?.exec(`
      UPDATE capacity_sources SET authority_generation = 101 WHERE id = 'source-1';
      UPDATE nodes SET capacity_source_generation = 101 WHERE id = 'node-1';
    `);
    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).resolves.toBeUndefined();
    sqlite?.exec(
      "UPDATE capacity_sources SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id = 'source-1'"
    );
    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).resolves.toBeUndefined();
    sqlite?.exec("UPDATE capacity_sources SET authority_generation = 102 WHERE id = 'source-1'");
    await expect(
      assertNodeAllocationPlanCurrent(env, 'node-1', 'user-1', 'project-1')
    ).rejects.toThrow('Node allocation plan is no longer current');
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
        SET capacity_source_generation = 101, selection_settings_version = ?, capacity_authority_generation = ?
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
