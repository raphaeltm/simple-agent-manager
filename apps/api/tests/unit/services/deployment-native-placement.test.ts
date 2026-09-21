import { D1_MAX_BOUND_PARAMETERS } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
} from '../../../src/services/deployment-provisioning';
import { assertDeploymentProvisioningAuthority } from '../../../src/services/provisioning-authority';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];

function reservationJson(
  overrides: Partial<Parameters<typeof findDeploymentNodeWithCapacity>[2]['reservation']> = {}
) {
  return JSON.stringify({
    cpuMillis: 500,
    memoryMb: 512,
    diskMb: 1_024,
    exclusiveNode: false,
    source: 'task',
    sourceId: 'environment',
    version: 3,
    ...overrides,
  });
}

function setFreshTelemetry(sqlite: Database.Database): void {
  sqlite.prepare('UPDATE nodes SET last_metrics = ?, last_heartbeat_at = ? WHERE id = ?').run(
    JSON.stringify({
      version: 1,
      cpuLoadAvg1: 0.1,
      memoryPercent: 20,
      diskPercent: 10,
      creatingWorkspaces: 0,
    }),
    new Date().toISOString(),
    'node'
  );
}

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  const env = {
    DATABASE: createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS),
    MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE: '2',
  } as Env;
  const db = drizzle(env.DATABASE, { schema });
  sqlite.exec(`
    INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('project', 'user', 'maintainer', 'active');
    INSERT INTO nodes
      (id, user_id, status, health_status, runtime, node_class, node_role, workload_role,
       node_mode, cloud_provider, vm_location, vm_size, provider_instance_type,
       provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
       provider_instance_id, observed_provider_instance_type,
       observed_provider_instance_vcpu_count, observed_provider_instance_memory_mb,
       observed_provider_instance_disk_gb, observed_hardware_source)
      VALUES ('node', 'user', 'running', 'healthy', 'vm', 'managed', 'deployment',
              'deployment', 'shared', 'hetzner', 'fsn1', 'large', 'native-sku', 4, 8192, 80,
              'provider-node', 'native-sku', 4, 8192, 80, 'observed');
    INSERT INTO deployment_environments
      (id, project_id, status, provider, location, requires_volumes)
      VALUES ('environment', 'project', 'active', 'hetzner', 'fsn1', 0);
  `);
  const placement: Parameters<typeof findDeploymentNodeWithCapacity>[2] = {
    projectId: 'project',
    provider: 'hetzner',
    location: 'fsn1',
    vmSize: 'small',
    credentialSource: 'user',
    credentialAttributionUserId: 'user',
    credentialAttributionProjectId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    providerInstanceType: 'native-sku',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPlacementSnapshot: null,
    capacityPoolSelection: null,
    reservation: {
      cpuMillis: 500,
      memoryMb: 512,
      diskMb: 1_024,
      exclusiveNode: false,
      source: 'task',
      sourceId: 'environment',
      version: 3,
    },
  };
  const link = () =>
    linkEnvironmentToNode({
      env,
      db,
      envId: 'environment',
      nodeId: 'node',
      placement,
      userId: 'user',
      expectedNodeStatus: 'running',
      nodeMode: 'shared',
    });
  const linkEnvironment = (
    envId: string,
    reservation: typeof placement.reservation,
    expectedNodeStatus: 'creating' | 'running' = 'running'
  ) =>
    linkEnvironmentToNode({
      env,
      db,
      envId,
      nodeId: 'node',
      placement: { ...placement, reservation },
      userId: 'user',
      expectedNodeStatus,
      nodeMode: reservation.exclusiveNode ? 'exclusive' : 'shared',
    });
  const checkPaid = () =>
    assertDeploymentProvisioningAuthority(env, {
      environmentId: 'environment',
      projectId: 'project',
      userId: 'user',
      nodeId: 'node',
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: placement.providerInstanceType,
      providerInstanceBootDiskSizeGb: placement.providerInstanceBootDiskSizeGb,
      providerInstanceImage: placement.providerInstanceImage,
      providerInstanceArchitecture: placement.providerInstanceArchitecture,
      nodeMode: 'shared',
      requiresVolumes: false,
    });
  return { sqlite, env, placement, link, linkEnvironment, checkPaid };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('deployment native placement SQL', () => {
  it('selects and atomically links the same native offering despite a different legacy label', async () => {
    const { env, placement, link, checkPaid } = fixture();
    expect((await findDeploymentNodeWithCapacity(env, 'user', placement, false))?.nodeId).toBe(
      'node'
    );
    expect(await link()).toBe(true);
    await expect(checkPaid()).resolves.toBeUndefined();
  });

  it('rejects a different native offering even when its legacy label matches', async () => {
    const { sqlite, env, placement, link } = fixture();
    sqlite.exec("UPDATE nodes SET vm_size = 'small', provider_instance_type = 'wrong-sku'");
    expect(await findDeploymentNodeWithCapacity(env, 'user', placement, false)).toBeNull();
    expect(await link()).toBe(false);
  });

  it.each([
    "provider_instance_type = 'wrong-sku'",
    "provider_instance_image = 'different-image'",
    "provider_instance_architecture = 'arm64'",
    'provider_instance_boot_disk_size_gb = 100',
  ])('rechecks native placement after advisory selection: %s', async (change) => {
    const { sqlite, env, placement, link } = fixture();
    expect((await findDeploymentNodeWithCapacity(env, 'user', placement, false))?.nodeId).toBe(
      'node'
    );
    sqlite.exec(`UPDATE nodes SET ${change}`);
    expect(await link()).toBe(false);
  });

  it('rechecks project membership at the final link', async () => {
    const { sqlite, env, placement, link } = fixture();
    expect((await findDeploymentNodeWithCapacity(env, 'user', placement, false))?.nodeId).toBe(
      'node'
    );
    sqlite.exec("UPDATE project_members SET status = 'removed'");
    expect(await link()).toBe(false);
  });

  it('rechecks current pool precedence at the final link', async () => {
    const { sqlite, env, placement, link } = fixture();
    expect((await findDeploymentNodeWithCapacity(env, 'user', placement, false))?.nodeId).toBe(
      'node'
    );
    sqlite.exec(
      "INSERT INTO capacity_pools (id, scope, owner_project_id, is_default, status) VALUES ('new-default', 'project', 'project', 1, 'disabled')"
    );
    expect(await link()).toBe(false);
  });

  it('rechecks occupied environment capacity in the atomic link statement', async () => {
    const { sqlite, env, placement, link } = fixture();
    expect((await findDeploymentNodeWithCapacity(env, 'user', placement, false))?.nodeId).toBe(
      'node'
    );
    sqlite.exec(
      "INSERT INTO deployment_environments (id, node_id) VALUES ('other-1', 'node'), ('other-2', 'node')"
    );
    expect(await link()).toBe(false);
  });

  it('rejects role or ownership drift after selection', async () => {
    const { sqlite, env, placement, link } = fixture();
    expect((await findDeploymentNodeWithCapacity(env, 'user', placement, false))?.nodeId).toBe(
      'node'
    );
    sqlite.exec("UPDATE nodes SET node_role = 'workspace', user_id = 'other'");
    expect(await link()).toBe(false);
  });

  it('rechecks native identity at the paid boundary after successful linking', async () => {
    const { sqlite, link, checkPaid } = fixture();
    expect(await link()).toBe(true);
    sqlite.exec("UPDATE nodes SET provider_instance_type = 'wrong-sku'");
    await expect(checkPaid()).rejects.toThrow('authority is no longer current');
  });

  it('reuses a compatible node when aggregate declared reservations fit', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    setFreshTelemetry(sqlite);
    sqlite.exec(`
      UPDATE deployment_environments
         SET node_id = 'node', resolved_reservation_json = '${reservationJson({
           cpuMillis: 1_000,
           memoryMb: 1_024,
         })}'
       WHERE id = 'environment';
      INSERT INTO deployment_environments (id, project_id, status)
      VALUES ('environment-2', 'project', 'active');
    `);
    const request = {
      ...placement.reservation,
      cpuMillis: 2_000,
      memoryMb: 2_048,
      sourceId: 'environment-2',
    };

    expect(
      (
        await findDeploymentNodeWithCapacity(
          env,
          'user',
          { ...placement, reservation: request },
          false
        )
      )?.nodeId
    ).toBe('node');
    expect(await linkEnvironment('environment-2', request)).toBe(true);
    expect(
      sqlite
        .prepare('SELECT resolved_reservation_json FROM deployment_environments WHERE id = ?')
        .get('environment-2')
    ).toEqual({ resolved_reservation_json: JSON.stringify(request) });
  });

  it('rejects malformed occupied reservations and the first overflowing dimension', async () => {
    const { sqlite, env, placement } = fixture();
    setFreshTelemetry(sqlite);
    sqlite.exec(`
      UPDATE deployment_environments
         SET node_id = 'node', resolved_reservation_json = '{"cpuMillis":"unknown"}'
       WHERE id = 'environment';
    `);
    expect(await findDeploymentNodeWithCapacity(env, 'user', placement, false)).toBeNull();

    sqlite
      .prepare('UPDATE deployment_environments SET resolved_reservation_json = ? WHERE id = ?')
      .run(reservationJson({ cpuMillis: 3_750 }), 'environment');
    expect(await findDeploymentNodeWithCapacity(env, 'user', placement, false)).toBeNull();
  });

  it('admits the exact post-reserve memory boundary and rejects one megabyte more', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    setFreshTelemetry(sqlite);
    sqlite
      .prepare(
        `UPDATE deployment_environments
            SET node_id = 'node', resolved_reservation_json = ?
          WHERE id = 'environment'`
      )
      .run(reservationJson({ memoryMb: 7_168 }));
    sqlite.exec(`
      INSERT INTO deployment_environments (id, project_id, status)
      VALUES ('exact-fit', 'project', 'active'), ('overflow', 'project', 'active');
    `);
    const exact = { ...placement.reservation, memoryMb: 512, sourceId: 'exact-fit' };
    expect(
      (
        await findDeploymentNodeWithCapacity(
          env,
          'user',
          { ...placement, reservation: exact },
          false
        )
      )?.nodeId
    ).toBe('node');
    expect(await linkEnvironment('exact-fit', exact)).toBe(true);

    const overflow = { ...placement.reservation, memoryMb: 1, sourceId: 'overflow' };
    expect(
      await findDeploymentNodeWithCapacity(
        env,
        'user',
        { ...placement, reservation: overflow },
        false
      )
    ).toBeNull();
  });

  it('atomically admits only one contender for the final CPU capacity', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    setFreshTelemetry(sqlite);
    sqlite.exec(`
      INSERT INTO deployment_environments (id, project_id, status)
      VALUES ('contender-a', 'project', 'active'), ('contender-b', 'project', 'active');
    `);
    const contenderA = {
      ...placement.reservation,
      cpuMillis: 2_500,
      sourceId: 'contender-a',
    };
    const contenderB = {
      ...placement.reservation,
      cpuMillis: 2_500,
      sourceId: 'contender-b',
    };

    expect(
      await findDeploymentNodeWithCapacity(
        env,
        'user',
        { ...placement, reservation: contenderA },
        false
      )
    ).not.toBeNull();
    expect(
      await findDeploymentNodeWithCapacity(
        env,
        'user',
        { ...placement, reservation: contenderB },
        false
      )
    ).not.toBeNull();
    expect(await linkEnvironment('contender-a', contenderA)).toBe(true);
    expect(await linkEnvironment('contender-b', contenderB)).toBe(false);
  });
});
