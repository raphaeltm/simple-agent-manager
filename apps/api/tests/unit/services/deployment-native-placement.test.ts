import {
  D1_MAX_BOUND_PARAMETERS,
  resolveDeploymentManifestReservation,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { insertDeploymentReleaseWhilePlacementUnlocked } from '../../../src/routes/deployment-release-submission';
import {
  claimDeploymentEnvironmentRelocation,
  completeDeploymentEnvironmentRelocation,
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
  restoreDeploymentEnvironmentRelocation,
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
    expectedNodeStatus: 'creating' | 'running' = 'running',
    expectedReservationJson?: string | null
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
      ...(expectedReservationJson !== undefined ? { expectedReservationJson } : {}),
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
  return { sqlite, env, db, placement, link, linkEnvironment, checkPaid };
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

  it('keeps the configured environment count as an additional safety cap', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    setFreshTelemetry(sqlite);
    sqlite
      .prepare(
        'UPDATE deployment_environments SET node_id = ?, resolved_reservation_json = ? WHERE id = ?'
      )
      .run('node', reservationJson({ cpuMillis: 100, memoryMb: 100 }), 'environment');
    sqlite
      .prepare(
        `INSERT INTO deployment_environments
           (id, project_id, status, node_id, resolved_reservation_json)
         VALUES (?, 'project', 'active', 'node', ?), (?, 'project', 'active', NULL, NULL)`
      )
      .run(
        'environment-2',
        reservationJson({ cpuMillis: 100, memoryMb: 100, sourceId: 'environment-2' }),
        'environment-3'
      );
    const request = { ...placement.reservation, sourceId: 'environment-3' };

    expect(
      await findDeploymentNodeWithCapacity(
        env,
        'user',
        { ...placement, reservation: request },
        false
      )
    ).toBeNull();
    expect(await linkEnvironment('environment-3', request)).toBe(false);
  });

  it.each([
    { source: 'unknown' },
    { version: 2, maxCoTenants: null },
    { version: 3, maxCoTenants: 0 },
  ])(
    'fails closed when an occupied reservation violates the canonical contract: %j',
    async (bad) => {
      const { sqlite, env, placement, link } = fixture();
      setFreshTelemetry(sqlite);
      sqlite
        .prepare(
          `INSERT INTO deployment_environments
             (id, project_id, status, node_id, resolved_reservation_json)
           VALUES ('other', 'project', 'active', ?, ?)`
        )
        .run('node', reservationJson(bad as never));

      expect(await findDeploymentNodeWithCapacity(env, 'user', placement, false)).toBeNull();
      expect(await link()).toBe(false);
    }
  );

  it.each([
    ['disk capacity', 'observed_provider_instance_disk_gb = 1'],
    ['stale telemetry', "last_heartbeat_at = '2020-01-01T00:00:00.000Z'"],
    [
      'disk pressure',
      'last_metrics = \'{"version":1,"cpuLoadAvg1":0.1,"memoryPercent":20,"diskPercent":99,"creatingWorkspaces":0}\'',
    ],
    ['untrusted hardware', "observed_hardware_source = 'planned'"],
  ])('rechecks %s at final admission after advisory selection', async (_name, mutation) => {
    const { sqlite, env, placement, link } = fixture();
    setFreshTelemetry(sqlite);
    sqlite
      .prepare(
        `INSERT INTO deployment_environments
           (id, project_id, status, node_id, resolved_reservation_json)
         VALUES ('other', 'project', 'active', ?, ?)`
      )
      .run('node', reservationJson({ cpuMillis: 100, memoryMb: 100, diskMb: 79 * 1_024 }));
    expect(await findDeploymentNodeWithCapacity(env, 'user', placement, false)).not.toBeNull();
    sqlite.exec(`UPDATE nodes SET ${mutation} WHERE id = 'node'`);
    expect(await link()).toBe(false);
  });

  it('validates and persists a new reservation on an existing exclusive volume node', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    sqlite.exec("UPDATE nodes SET node_mode = 'exclusive' WHERE id = 'node'");
    const request = { ...placement.reservation, exclusiveNode: true };
    const previousReservation = reservationJson({
      cpuMillis: 250,
      memoryMb: 256,
      exclusiveNode: true,
    });
    sqlite
      .prepare(
        'UPDATE deployment_environments SET node_id = ?, resolved_reservation_json = ? WHERE id = ?'
      )
      .run('node', previousReservation, 'environment');
    const match = await findDeploymentNodeWithCapacity(
      env,
      'user',
      { ...placement, reservation: request },
      true,
      { nodeId: 'node', excludeEnvironmentId: 'environment', nodeMode: 'exclusive' }
    );

    expect(match?.nodeId).toBe('node');
    expect(await linkEnvironment('environment', request, 'running', previousReservation)).toBe(
      true
    );
    expect(
      sqlite
        .prepare('SELECT resolved_reservation_json FROM deployment_environments WHERE id = ?')
        .get('environment')
    ).toEqual({ resolved_reservation_json: JSON.stringify(request) });
  });

  it('carries a multi-service manifest reservation through real D1 admission', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    const image = {
      registry: 'registry.example.com',
      repository: 'app',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const request = resolveDeploymentManifestReservation(
      {
        version: 1,
        services: {
          api: {
            image,
            env: {},
            volumes: [],
            resources: { cpuLimit: 0.75, memoryLimitMb: 768 },
          },
          worker: {
            image,
            env: {},
            volumes: [],
            resources: { cpuLimit: 0.25, memoryLimitMb: 256 },
          },
        },
        volumes: {},
        routes: [{ service: 'api', port: 8080, mode: 'public' }],
      },
      'environment'
    );

    expect(
      await findDeploymentNodeWithCapacity(
        env,
        'user',
        { ...placement, reservation: request },
        false
      )
    ).not.toBeNull();
    expect(await linkEnvironment('environment', request)).toBe(true);
    expect(
      JSON.parse(
        (
          sqlite
            .prepare('SELECT resolved_reservation_json value FROM deployment_environments')
            .get() as { value: string }
        ).value
      )
    ).toMatchObject({ cpuMillis: 1_000, memoryMb: 1_024, diskMb: 2_048 });
  });

  it('chunks occupied-reservation reads below the D1 bind ceiling', async () => {
    const { sqlite, env, placement } = fixture();
    const insert = sqlite.prepare(`
      INSERT INTO nodes
        (id, user_id, status, health_status, runtime, node_class, node_role, workload_role,
         node_mode, cloud_provider, vm_location, vm_size, provider_instance_type,
         provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
         provider_instance_id, observed_provider_instance_type,
         observed_provider_instance_vcpu_count, observed_provider_instance_memory_mb,
         observed_provider_instance_disk_gb, observed_hardware_source)
      SELECT ?, user_id, status, health_status, runtime, node_class, node_role, workload_role,
             node_mode, cloud_provider, vm_location, vm_size, provider_instance_type,
             provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
             ?, observed_provider_instance_type, observed_provider_instance_vcpu_count,
             observed_provider_instance_memory_mb, observed_provider_instance_disk_gb,
             observed_hardware_source
        FROM nodes WHERE id = 'node'`);
    for (let index = 0; index < D1_MAX_BOUND_PARAMETERS + 1; index += 1) {
      insert.run(`node-${index}`, `provider-node-${index}`);
    }

    await expect(
      findDeploymentNodeWithCapacity(env, 'user', placement, false)
    ).resolves.not.toBeNull();
  });

  it('reuses the tightest fitting compatible pool node and records its candidate authority', async () => {
    const { sqlite, env, placement } = fixture();
    sqlite.exec(`
      UPDATE nodes
         SET id = 'node-medium', provider_instance_id = 'provider-medium',
             provider_instance_type = 'medium-sku', observed_provider_instance_type = 'medium-sku',
             provider_instance_vcpu_count = 4, observed_provider_instance_vcpu_count = 4,
             provider_instance_memory_mb = 8192, observed_provider_instance_memory_mb = 8192,
             capacity_pool_id = 'pool', capacity_pool_scope = 'user', capacity_pool_revision = 7,
             capacity_source_id = 'source', capacity_pool_candidate_id = 'medium',
             placement_credential_source = 'user',
             placement_credential_reference = 'credentials:credential',
             placement_credential_version = 1
       WHERE id = 'node';
      INSERT INTO nodes
        (id, user_id, status, health_status, runtime, node_class, node_role, workload_role,
         node_mode, cloud_provider, vm_location, vm_size, provider_instance_type,
         provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
         provider_instance_id, observed_provider_instance_type,
         observed_provider_instance_vcpu_count, observed_provider_instance_memory_mb,
         observed_provider_instance_disk_gb, observed_hardware_source,
         capacity_pool_id, capacity_pool_scope, capacity_pool_revision, capacity_source_id,
         capacity_pool_candidate_id, placement_credential_source,
         placement_credential_reference, placement_credential_version)
      SELECT 'node-large', user_id, status, health_status, runtime, node_class, node_role,
             workload_role, node_mode, cloud_provider, vm_location, 'large', 'large-sku', 8,
             16384, 160, 'provider-large', 'large-sku', 8, 16384, 160,
             observed_hardware_source, capacity_pool_id, capacity_pool_scope,
             capacity_pool_revision, capacity_source_id, 'large', placement_credential_source,
             placement_credential_reference, placement_credential_version
        FROM nodes WHERE id = 'node-medium';
    `);
    const candidate = (
      id: string,
      providerInstanceType: string,
      providerInstanceVcpuCount: number,
      providerInstanceMemoryMb: number,
      providerInstanceDiskGb: number
    ) => ({
      id,
      poolId: 'pool',
      capacitySourceId: 'source',
      capacitySourceGeneration: 1,
      capacitySourceExternalRef: null,
      provider: 'hetzner' as const,
      location: 'fsn1',
      workloadRole: 'deployment' as const,
      runtime: 'vm',
      machineClass: 'shared-vm',
      machineSize: 'small' as const,
      providerInstanceType,
      providerInstanceVcpuCount,
      providerInstanceMemoryMb,
      providerInstanceDiskGb,
      providerInstancePriceDisplay: null,
      providerInstancePriceCurrency: 'EUR',
      providerInstancePriceMonthlyCents: providerInstanceVcpuCount * 100,
      providerInstancePriceHourlyMicros: null,
      priceComparability: 'known' as const,
      catalogAvailability: 'available' as const,
      priority: 0,
      candidateOrder: 0,
      credentialAttributionSource: 'user' as const,
      placementCredentialSource: 'user' as const,
      placementCredentialReference: 'credentials:credential',
      placementCredentialVersion: 1,
      capacityPoolProjectId: null,
    });
    const selection = {
      poolId: 'pool',
      scope: 'user' as const,
      revision: 7,
      strategy: 'smallest-fit' as const,
      exhaustionPolicy: 'queue' as const,
      maxNodes: 10,
      effectiveState: 'configured-ready' as const,
      selectionSettings: { version: 1, sourceGeneration: 1 },
      capacityPoolProjectId: null,
      workloadRole: 'deployment' as const,
      poolSnapshot: {} as never,
      candidates: [
        candidate('small', 'small-sku', 2, 4096, 40),
        candidate('medium', 'medium-sku', 4, 8192, 80),
        candidate('large', 'large-sku', 8, 16384, 160),
      ],
    } as NonNullable<typeof placement.capacityPoolSelection>;

    const match = await findDeploymentNodeWithCapacity(
      env,
      'user',
      { ...placement, capacityPoolSelection: selection },
      false
    );

    expect(match?.nodeId).toBe('node-medium');
    expect(match?.placement.capacityPlacementSnapshot?.capacityPoolCandidateId).toBe('medium');
  });

  it('fences relocation so a concurrent release cannot overwrite or tear down the winner', async () => {
    const { sqlite, env, placement, linkEnvironment } = fixture();
    const previousReservation = reservationJson({ cpuMillis: 250, memoryMb: 256 });
    sqlite
      .prepare(
        'UPDATE deployment_environments SET node_id = ?, resolved_reservation_json = ? WHERE id = ?'
      )
      .run('node', previousReservation, 'environment');

    const claimJson = await claimDeploymentEnvironmentRelocation({
      env,
      envId: 'environment',
      nodeId: 'node',
      userId: 'user',
      placement,
      expectedReservationJson: previousReservation,
      reservation: placement.reservation,
    });
    expect(claimJson).not.toBeNull();
    await expect(
      claimDeploymentEnvironmentRelocation({
        env,
        envId: 'environment',
        nodeId: 'node',
        userId: 'user',
        placement,
        expectedReservationJson: previousReservation,
        reservation: placement.reservation,
      })
    ).resolves.toBeNull();
    expect(
      await linkEnvironment('environment', placement.reservation, 'running', previousReservation)
    ).toBe(false);
    expect(await linkEnvironment('environment', placement.reservation, 'running', claimJson)).toBe(
      false
    );
    await expect(
      claimDeploymentEnvironmentRelocation({
        env,
        envId: 'environment',
        nodeId: 'node',
        userId: 'user',
        placement,
        expectedReservationJson: claimJson!,
        reservation: placement.reservation,
      })
    ).resolves.toBeNull();
    expect(
      await completeDeploymentEnvironmentRelocation({
        env,
        envId: 'environment',
        nodeId: 'node',
        claimJson: claimJson!,
      })
    ).toBe(true);
    expect(
      sqlite.prepare('SELECT node_id, resolved_reservation_json FROM deployment_environments').get()
    ).toEqual({ node_id: null, resolved_reservation_json: null });
  });

  it('prevents an older release from admitting or relocating after a newer release is recorded', async () => {
    const { sqlite, env, placement, db } = fixture();
    const previousReservation = reservationJson({ cpuMillis: 250, memoryMb: 256 });
    sqlite
      .prepare(
        'UPDATE deployment_environments SET node_id = ?, resolved_reservation_json = ? WHERE id = ?'
      )
      .run('node', previousReservation, 'environment');
    sqlite.exec(`
      INSERT INTO deployment_releases
        (id, environment_id, manifest, version, status, status_updated_at, created_at)
      VALUES
        ('release-a', 'environment', '{}', 1, 'created', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('release-b', 'environment', '{}', 2, 'created', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    await expect(
      linkEnvironmentToNode({
        env,
        db,
        envId: 'environment',
        nodeId: 'node',
        placement,
        userId: 'user',
        expectedNodeStatus: 'running',
        nodeMode: 'shared',
        expectedReservationJson: previousReservation,
        releaseId: 'release-a',
      })
    ).resolves.toBe(false);
    await expect(
      claimDeploymentEnvironmentRelocation({
        env,
        envId: 'environment',
        nodeId: 'node',
        userId: 'user',
        placement,
        expectedReservationJson: previousReservation,
        reservation: placement.reservation,
        releaseId: 'release-a',
      })
    ).resolves.toBeNull();
    await expect(
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
        releaseId: 'release-a',
      })
    ).rejects.toThrow('Deployment provisioning authority is no longer current');
    expect(
      sqlite.prepare('SELECT node_id, resolved_reservation_json FROM deployment_environments').get()
    ).toEqual({ node_id: 'node', resolved_reservation_json: previousReservation });
  });

  it('prevents an older release from completing a relocation claimed before a newer release', async () => {
    const { sqlite, env, placement } = fixture();
    const previousReservation = reservationJson({ cpuMillis: 250, memoryMb: 256 });
    sqlite
      .prepare(
        'UPDATE deployment_environments SET node_id = ?, resolved_reservation_json = ? WHERE id = ?'
      )
      .run('node', previousReservation, 'environment');
    sqlite.exec(`
      INSERT INTO deployment_releases
        (id, environment_id, manifest, version, status, status_updated_at, created_at)
      VALUES ('release-a', 'environment', '{}', 1, 'created', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);
    const claimJson = await claimDeploymentEnvironmentRelocation({
      env,
      envId: 'environment',
      nodeId: 'node',
      userId: 'user',
      placement,
      expectedReservationJson: previousReservation,
      reservation: placement.reservation,
      releaseId: 'release-a',
    });
    expect(claimJson).not.toBeNull();
    sqlite.exec(`
      INSERT INTO deployment_releases
        (id, environment_id, manifest, version, status, status_updated_at, created_at)
      VALUES ('release-b', 'environment', '{}', 2, 'created', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    await expect(
      completeDeploymentEnvironmentRelocation({
        env,
        envId: 'environment',
        nodeId: 'node',
        claimJson: claimJson!,
        releaseId: 'release-a',
      })
    ).resolves.toBe(false);
    expect(
      sqlite.prepare('SELECT node_id, resolved_reservation_json FROM deployment_environments').get()
    ).toEqual({ node_id: 'node', resolved_reservation_json: claimJson });

    await restoreDeploymentEnvironmentRelocation({
      env,
      envId: 'environment',
      nodeId: 'node',
      claimJson: claimJson!,
      reservationJson: previousReservation,
    });
    expect(
      sqlite.prepare('SELECT node_id, resolved_reservation_json FROM deployment_environments').get()
    ).toEqual({ node_id: 'node', resolved_reservation_json: previousReservation });
  });

  it('atomically rejects a newer release while a volume attachment claim is held', async () => {
    const { sqlite, env, db } = fixture();
    const claimJson = reservationJson({
      exclusiveNode: true,
      samRelocationClaim: true,
    } as never);
    sqlite
      .prepare('UPDATE deployment_environments SET resolved_reservation_json = ? WHERE id = ?')
      .run(claimJson, 'environment');
    const values = {
      id: 'release-b',
      environmentId: 'environment',
      manifest: '{}',
      version: 2,
      status: 'created',
      statusUpdatedAt: '2026-09-21T00:00:00.000Z',
      createdBy: 'user',
      createdAt: '2026-09-21T00:00:00.000Z',
    };

    await expect(insertDeploymentReleaseWhilePlacementUnlocked({ db, env, values })).resolves.toBe(
      false
    );
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM deployment_releases').get()).toEqual({
      count: 0,
    });

    sqlite
      .prepare('UPDATE deployment_environments SET resolved_reservation_json = ? WHERE id = ?')
      .run(reservationJson({ exclusiveNode: true }), 'environment');
    await expect(insertDeploymentReleaseWhilePlacementUnlocked({ db, env, values })).resolves.toBe(
      true
    );
  });

  it('refuses a relocation claim after deployment authority is revoked', async () => {
    const { sqlite, env, placement } = fixture();
    const previousReservation = reservationJson();
    sqlite
      .prepare(
        'UPDATE deployment_environments SET node_id = ?, resolved_reservation_json = ? WHERE id = ?'
      )
      .run('node', previousReservation, 'environment');
    sqlite
      .prepare("UPDATE project_members SET status = 'removed', removed_at = ?")
      .run(new Date().toISOString());

    await expect(
      claimDeploymentEnvironmentRelocation({
        env,
        envId: 'environment',
        nodeId: 'node',
        userId: 'user',
        placement,
        expectedReservationJson: previousReservation,
        reservation: placement.reservation,
      })
    ).resolves.toBeNull();
    expect(
      sqlite.prepare('SELECT node_id, resolved_reservation_json FROM deployment_environments').get()
    ).toEqual({ node_id: 'node', resolved_reservation_json: previousReservation });
  });
});
