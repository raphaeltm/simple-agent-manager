import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { isNodePastLifetimeAdmissionCutoff } from '../../../src/services/node-lifetime-admission';
import {
  attachPrecreatedWorkspacePlacement,
  reserveWorkspacePlacement,
  reserveWorkspaceRestart,
} from '../../../src/services/workspace-placement';
import {
  evaluateWorkspaceReservationCapacity,
  loadActiveWorkspaceReservationUsage,
  type PlacementAdmissionPolicy,
  resolveWorkspaceAdmissionPolicy,
} from '../../../src/services/workspace-resource-capacity';
import {
  createAllSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

const AUTHORITY_VERSION = 1_700_000_000_000;
const AUTHORITY_TIMESTAMP = new Date(AUTHORITY_VERSION).toISOString();

let sqlite: Database.Database | null = null;

function createDb() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  return createSqliteD1(sqlite);
}

function capacitySnapshot(
  overrides: Partial<CapacityPlacementSnapshot> = {}
): CapacityPlacementSnapshot {
  return {
    capacityPoolId: 'pool-project',
    capacityPoolScope: 'project',
    capacityPoolRevision: 4,
    capacitySourceId: 'source-project',
    capacitySourceGeneration: AUTHORITY_VERSION,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: 'candidate-cx42',
    placementCredentialSource: 'project',
    placementCredentialReference: 'credentials:project-cloud',
    placementCredentialVersion: AUTHORITY_VERSION,
    capacityPoolProjectId: 'project-1',
    workloadRole: 'workspace',
    providerInstanceType: 'cx42',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16 * 1024,
    providerInstanceDiskGb: 240,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    providerInstancePriceDisplay: '€18.49/mo',
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: 1849,
    providerInstancePriceHourlyMicros: 25329,
    placementExplanationJson: '{"candidate":"candidate-cx42"}',
    ...overrides,
  };
}

function seedAuthority(): void {
  sqlite?.exec(`
    INSERT INTO project_members
      (project_id, user_id, role, status, removed_at, created_at, updated_at)
    VALUES
      ('project-1', 'user-1', 'owner', 'active', NULL, '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO credentials
      (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
    VALUES
      ('project-cloud', 'user-owner', 'project-1', 'hetzner', 'cloud-provider', 1, 'encrypted-token', 'iv', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_pools
      (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
       configuration_state, strategy, exhaustion_policy, migration_state, created_at, updated_at)
    VALUES
      ('pool-project', 'project', NULL, 'project-1', 'Project pool', 1, 4, 'active',
       'configured-ready', 'balanced', 'queue', 'complete', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_sources
      (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
       credential_id, platform_credential_id, credential_reference, credential_version,
       external_source_ref, status, created_at, updated_at)
    VALUES
      ('source-project', 'project', NULL, 'project-1', 'cloud-provider-credential', 'hetzner', 'project',
       'project-cloud', NULL, 'credentials:project-cloud', ${AUTHORITY_VERSION},
       NULL, 'active', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_pool_candidates
      (id, pool_id, capacity_source_id, provider, location, workload_role, provider_instance_type,
       provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
       provider_instance_boot_disk_size_gb, provider_instance_image, provider_instance_architecture,
       catalog_availability, status, priority, candidate_order, created_at, updated_at)
    VALUES
      ('candidate-cx42', 'pool-project', 'source-project', 'hetzner', 'fsn1', 'workspace', 'cx42',
       8, ${16 * 1024}, 240, NULL, NULL, NULL,
       'available', 'active', 0, 0, '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');
  `);
}

function seedNode(overrides: Record<string, unknown> = {}): void {
  seedAuthority();
  insertNodeRow(overrides);
}

/** A node row under the authority `seedAuthority` already created. */
function insertNodeRow(overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'node-1',
    user_id: 'user-1',
    name: 'Concrete node',
    status: 'running',
    runtime: 'vm',
    vm_size: 'large',
    vm_location: 'fsn1',
    cloud_provider: 'hetzner',
    provider_instance_id: 'provider-node-1',
    node_role: 'workspace',
    node_class: 'managed',
    workload_role: 'workspace',
    capacity_pool_id: 'pool-project',
    capacity_pool_scope: 'project',
    capacity_pool_revision: 4,
    capacity_source_id: 'source-project',
    capacity_source_generation: AUTHORITY_VERSION,
    capacity_source_external_ref: null,
    capacity_pool_candidate_id: 'candidate-cx42',
    capacity_pool_project_id: 'project-1',
    placement_credential_source: 'project',
    placement_credential_reference: 'credentials:project-cloud',
    placement_credential_version: AUTHORITY_VERSION,
    provider_instance_type: 'cx42',
    provider_instance_vcpu_count: 8,
    provider_instance_memory_mb: 16 * 1024,
    provider_instance_disk_gb: 240,
    provider_instance_boot_disk_size_gb: null,
    provider_instance_image: null,
    provider_instance_architecture: null,
    observed_provider_instance_type: 'cx42',
    observed_provider_instance_vcpu_count: 8,
    observed_provider_instance_memory_mb: 16 * 1024,
    observed_provider_instance_disk_gb: 240,
    observed_hardware_source: 'observed',
    last_heartbeat_at: new Date().toISOString(),
    last_metrics: JSON.stringify({
      version: 1,
      cpuLoadAvg1: 0.2,
      memoryPercent: 10,
      diskPercent: 10,
    }),
    ...overrides,
  };
  const columns = Object.keys(row);
  sqlite
    ?.prepare(
      `INSERT INTO nodes (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...Object.values(row));
}

function seedUserOwnedNode(overrides: Record<string, unknown> = {}): void {
  seedAuthority();
  const row = {
    id: 'node-1',
    user_id: 'user-1',
    name: 'User-owned node',
    status: 'running',
    runtime: 'vm',
    vm_size: 'large',
    vm_location: 'fsn1',
    cloud_provider: null,
    provider_instance_id: null,
    node_role: 'workspace',
    node_class: 'user-owned',
    workload_role: 'workspace',
    capacity_pool_id: null,
    capacity_pool_scope: null,
    capacity_pool_revision: null,
    capacity_source_id: null,
    capacity_source_generation: null,
    capacity_source_external_ref: null,
    capacity_pool_candidate_id: null,
    capacity_pool_project_id: null,
    placement_credential_source: null,
    placement_credential_reference: null,
    placement_credential_version: null,
    provider_instance_type: null,
    provider_instance_vcpu_count: null,
    provider_instance_memory_mb: null,
    provider_instance_disk_gb: null,
    provider_instance_boot_disk_size_gb: null,
    provider_instance_image: null,
    provider_instance_architecture: null,
    observed_provider_instance_type: 'byo-standard',
    observed_provider_instance_vcpu_count: 8,
    observed_provider_instance_memory_mb: 16 * 1024,
    observed_provider_instance_disk_gb: 240,
    observed_hardware_source: 'observed',
    last_heartbeat_at: new Date().toISOString(),
    last_metrics: JSON.stringify({
      version: 1,
      cpuLoadAvg1: 0.2,
      memoryPercent: 10,
      diskPercent: 10,
    }),
    ...overrides,
  };
  const columns = Object.keys(row);
  sqlite
    ?.prepare(
      `INSERT INTO nodes (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...Object.values(row));
}

function reserveInput(snapshot: CapacityPlacementSnapshot) {
  return {
    id: 'workspace-1',
    nodeId: 'node-1',
    projectId: 'project-1',
    userId: 'user-1',
    installationId: 'installation-1',
    name: 'Task workspace',
    displayName: 'Task workspace',
    normalizedDisplayName: 'task-workspace',
    repository: 'acme/repo',
    branch: 'main',
    vmSize: 'large' as const,
    vmLocation: 'fsn1' as const,
    workspaceProfile: 'full' as const,
    devcontainerConfigName: null,
    agentProfileHint: null,
    capacityPlacementSnapshot: snapshot,
    resolvedReservation: reservation(),
    createdAt: '2026-08-28T00:00:00.000Z',
  };
}

function reservation(
  overrides: Partial<ResolvedResourceReservation> = {}
): ResolvedResourceReservation {
  return {
    cpuMillis: 1000,
    memoryMb: 1024,
    diskMb: 1024,
    exclusiveNode: false,
    source: 'platform',
    sourceId: 'platform',
    version: 1,
    ...overrides,
  };
}

function reservationV2(
  overrides: Partial<ResolvedResourceReservation> = {}
): ResolvedResourceReservation {
  return {
    ...reservation({ version: 2, ...overrides }),
    fieldProvenance: { minVcpu: { source: 'task', sourceId: 'task-1' } },
    diagnostics: { resolver: 'canonical-a' },
  } as ResolvedResourceReservation;
}

function reservationV3(
  overrides: Partial<ResolvedResourceReservation> = {}
): ResolvedResourceReservation {
  return reservation({ version: 3, ...overrides });
}

function admissionPolicy(
  overrides: Partial<PlacementAdmissionPolicy> = {}
): PlacementAdmissionPolicy {
  return {
    lifetimeAdmissionCutoffAgeMs: null,
    cpuShareBudgetPercent: 100,
    hostMemoryReserveMb: 0,
    diskPressureThresholdPercent: 90,
    metricsTtlMs: 180_000,
    cpuThresholdPercent: 90,
    memoryThresholdPercent: 90,
    cpuScoreWeightPercent: 40,
    memoryScoreWeightPercent: 60,
    ...overrides,
  };
}

function seedActiveWorkspace(
  workspaceId: string,
  reservationJson = JSON.stringify(reservation())
): void {
  sqlite
    ?.prepare(
      `INSERT INTO workspaces
       (id, node_id, user_id, project_id, name, repository, branch, status, vm_size, vm_location,
        resolved_reservation_json, created_at, updated_at)
       VALUES (?, 'node-1', 'user-1', 'project-1', ?, 'acme/repo', 'main', 'running', 'large',
        'fsn1', ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`
    )
    .run(workspaceId, workspaceId, reservationJson);
}

function seedPlaceholderWorkspace(workspaceId = 'workspace-attach'): void {
  sqlite
    ?.prepare(
      `INSERT INTO workspaces
       (id, node_id, user_id, project_id, installation_id, name, display_name,
        normalized_display_name, repository, branch, status, vm_size, vm_location,
        created_at, updated_at)
       VALUES (?, NULL, 'user-1', 'project-1', 'installation-1', 'Attach workspace',
        'Attach workspace', 'attach-workspace', 'acme/repo', 'main', 'creating', 'large', 'fsn1',
        '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`
    )
    .run(workspaceId);
}

function countWorkspace(id = 'workspace-1'): number {
  return (
    sqlite?.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?').get(id) as {
      count: number;
    }
  ).count;
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('reserveWorkspacePlacement', () => {
  it('keeps the atomic authority reservation within the D1 bind limit', async () => {
    createDb();
    if (!sqlite) throw new Error('SQLite fixture was not initialized');
    const database = createSqliteD1WithBindLimit(sqlite, 100);
    const snapshot = capacitySnapshot();
    seedNode();

    // With the lifetime cutoff on, as it is by default, which adds a bind.
    await expect(
      reserveWorkspacePlacement(
        database,
        reserveInput(snapshot),
        admissionPolicy({ lifetimeAdmissionCutoffAgeMs: 0.9 * 24 * 60 * 60 * 1000 })
      )
    ).resolves.toBe(true);
  });

  it('persists concrete provider offering and authority metadata on the workspace row', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();

    await expect(
      reserveWorkspacePlacement(database, reserveInput(snapshot), admissionPolicy())
    ).resolves.toBe(true);

    expect(
      sqlite
        ?.prepare(
          `SELECT
             capacity_pool_id,
             capacity_source_generation,
             capacity_source_external_ref,
             capacity_pool_candidate_id,
             provider_instance_type,
             provider_instance_vcpu_count,
             provider_instance_memory_mb,
             provider_instance_price_display
           FROM workspaces
           WHERE id = 'workspace-1'`
        )
        .get()
    ).toMatchObject({
      capacity_pool_id: 'pool-project',
      capacity_source_generation: AUTHORITY_VERSION,
      capacity_source_external_ref: null,
      capacity_pool_candidate_id: 'candidate-cx42',
      provider_instance_type: 'cx42',
      provider_instance_vcpu_count: 8,
      provider_instance_memory_mb: 16 * 1024,
      provider_instance_price_display: '€18.49/mo',
    });
  });

  it.each([
    [
      'removed membership',
      `UPDATE project_members SET status = 'removed', removed_at = '${new Date().toISOString()}'`,
    ],
    ['pool revision changed', `UPDATE capacity_pools SET revision = 99`],
    ['pool disabled', `UPDATE capacity_pools SET status = 'disabled'`],
    ['pool owned by another project', `UPDATE capacity_pools SET owner_project_id = 'project-2'`],
    ['source disabled', `UPDATE capacity_sources SET status = 'disabled'`],
    [
      'source generation changed',
      `UPDATE capacity_sources SET updated_at = '2023-11-14T22:13:21.000Z'`,
    ],
    [
      'source owned by another project',
      `UPDATE capacity_sources SET owner_project_id = 'project-2'`,
    ],
    ['source credential detached', `UPDATE capacity_sources SET credential_id = NULL`],
    ['credential disabled', `UPDATE credentials SET is_active = 0 WHERE id = 'project-cloud'`],
    [
      'credential rotated',
      `UPDATE credentials SET updated_at = '2023-11-14T22:13:21.000Z' WHERE id = 'project-cloud'`,
    ],
    ['candidate deleted', `UPDATE capacity_pool_candidates SET status = 'deleted'`],
    [
      'candidate unavailable',
      `UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable'`,
    ],
    ['candidate provider changed', `UPDATE capacity_pool_candidates SET provider = 'gcp'`],
    ['candidate location changed', `UPDATE capacity_pool_candidates SET location = 'nbg1'`],
    ['candidate role changed', `UPDATE capacity_pool_candidates SET workload_role = 'deployment'`],
    ['node lifecycle changed', `UPDATE nodes SET status = 'destroying' WHERE id = 'node-1'`],
    [
      'node native image changed',
      `UPDATE nodes SET provider_instance_image = 'other-image' WHERE id = 'node-1'`,
    ],
  ])('rejects non-current final authority: %s', async (_name, mutation) => {
    const database = createDb();
    seedNode();
    sqlite?.exec(mutation);

    await expect(
      reserveWorkspacePlacement(database, reserveInput(capacitySnapshot()), admissionPolicy())
    ).resolves.toBe(false);
    expect(countWorkspace()).toBe(0);
  });

  it('rejects project viewers without workspace execution capability in final admission', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    sqlite
      ?.prepare(`UPDATE project_members SET role = 'viewer' WHERE project_id = 'project-1'`)
      .run();

    await expect(
      reserveWorkspacePlacement(database, reserveInput(snapshot), admissionPolicy())
    ).resolves.toBe(false);
    expect(countWorkspace()).toBe(0);
  });

  it('rejects a concrete placement when the final node candidate/SKU no longer matches', async () => {
    const database = createDb();
    seedNode({
      capacity_pool_candidate_id: 'candidate-cx23',
      provider_instance_type: 'cx23',
    });

    await expect(
      reserveWorkspacePlacement(database, reserveInput(capacitySnapshot()), admissionPolicy())
    ).resolves.toBe(false);
    expect(countWorkspace()).toBe(0);
  });

  it('uses observed hardware for final capacity instead of planned provider estimates', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      provider_instance_vcpu_count: 8,
      provider_instance_memory_mb: 16 * 1024,
      provider_instance_disk_gb: 240,
      observed_provider_instance_vcpu_count: 1,
      observed_provider_instance_memory_mb: 1024,
      observed_provider_instance_disk_gb: 10,
    });

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-observed-small',
          resolvedReservation: reservation({ cpuMillis: 4000, memoryMb: 8192, diskMb: 8192 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(false);
    expect(countWorkspace('workspace-observed-small')).toBe(0);
  });

  it('prevents aggregate CPU-share overbooking in the final reservation statement', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace(
      'workspace-existing-cpu-a',
      JSON.stringify(reservation({ cpuMillis: 4000 }))
    );
    seedActiveWorkspace(
      'workspace-existing-cpu-b',
      JSON.stringify(reservation({ cpuMillis: 4000 }))
    );

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-cpu-overbook',
          resolvedReservation: reservation({ cpuMillis: 1000 }),
        },
        admissionPolicy({ cpuShareBudgetPercent: 100 })
      )
    ).resolves.toBe(false);
  });

  it('subtracts host memory reserve before admitting an occupied node', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace(
      'workspace-existing-memory',
      JSON.stringify(reservation({ memoryMb: 15 * 1024 }))
    );

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-memory-headroom',
          resolvedReservation: reservation({ memoryMb: 512 }),
        },
        admissionPolicy({ hostMemoryReserveMb: 1024 })
      )
    ).resolves.toBe(false);
  });

  it('accounts for active v1 and v2 reservations in the final reservation statement', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace(
      'workspace-existing-v1',
      JSON.stringify(reservation({ cpuMillis: 1500, memoryMb: 2048, diskMb: 2048 }))
    );
    seedActiveWorkspace(
      'workspace-existing-v2',
      JSON.stringify(reservationV2({ cpuMillis: 1500, memoryMb: 2048, diskMb: 2048 }))
    );

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-v2-fits',
          resolvedReservation: reservationV2({ cpuMillis: 1000, memoryMb: 1024, diskMb: 1024 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(true);

    sqlite?.prepare(`DELETE FROM workspaces WHERE id = 'workspace-v2-fits'`).run();
    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-v2-overbook',
          resolvedReservation: reservationV2({ cpuMillis: 5100, memoryMb: 1024, diskMb: 1024 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  it('packs past legacy count metadata with v3 reservations that omit maxCoTenants', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      last_metrics: JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0.2,
        memoryPercent: 10,
        diskPercent: 10,
      }),
    });
    seedActiveWorkspace(
      'workspace-legacy-max-a',
      JSON.stringify({
        ...reservation({ cpuMillis: 400, memoryMb: 800, diskMb: 2048 }),
        maxCoTenants: 2,
      })
    );
    seedActiveWorkspace(
      'workspace-legacy-max-b',
      JSON.stringify(reservationV3({ cpuMillis: 400, memoryMb: 800, diskMb: 2048 }))
    );

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-v3-no-max-co-tenants',
          resolvedReservation: reservationV3({ cpuMillis: 400, memoryMb: 800, diskMb: 2048 }),
        },
        admissionPolicy({ memoryThresholdPercent: 1 })
      )
    ).resolves.toBe(true);
  });

  it('accepts diskMb zero in v1 and v2 reservations consistently with the JS validator', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace('workspace-existing-zero-disk', JSON.stringify(reservation({ diskMb: 0 })));

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-zero-disk-v2',
          resolvedReservation: reservationV2({ diskMb: 0 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(true);
  });

  it('vetoes disk pressure and malformed occupied reservations', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      last_metrics: JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0.2,
        memoryPercent: 10,
        diskPercent: 90,
      }),
    });

    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-disk-pressure' },
        admissionPolicy()
      )
    ).resolves.toBe(false);

    sqlite?.prepare(`DELETE FROM workspaces`).run();
    sqlite
      ?.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = 'node-1'`)
      .run(JSON.stringify({ version: 1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }));
    seedActiveWorkspace('workspace-existing-invalid', '{"cpuMillis":"bad"}');

    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-invalid-active' },
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  it('rejects invalid metrics JSON and unsupported version 0/-1 on empty nodes', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();

    for (const [workspaceId, metrics] of [
      ['workspace-invalid-json', '{"cpuLoadAvg1":'],
      [
        'workspace-version-zero',
        JSON.stringify({ version: 0, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
      ],
      [
        'workspace-version-minus-one',
        JSON.stringify({ version: -1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
      ],
    ] as const) {
      sqlite?.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = 'node-1'`).run(metrics);
      await expect(
        reserveWorkspacePlacement(
          database,
          { ...reserveInput(snapshot), id: workspaceId },
          admissionPolicy()
        )
      ).resolves.toBe(false);
      expect(countWorkspace(workspaceId)).toBe(0);
    }
  });

  it('vetoes final placement when fresh measured CPU saturation appears after selection', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace('workspace-existing-pressure');
    sqlite
      ?.prepare(`UPDATE nodes SET last_metrics = ?, last_heartbeat_at = ? WHERE id = 'node-1'`)
      .run(
        JSON.stringify({ version: 1, cpuLoadAvg1: 8, memoryPercent: 10, diskPercent: 10 }),
        new Date().toISOString()
      );
    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-cpu-pressure' },
        admissionPolicy({ cpuThresholdPercent: 90, memoryThresholdPercent: 90 })
      )
    ).resolves.toBe(false);
  });

  it('admits onto a node that is building another workspace but atomically rejects excess reservations', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    sqlite
      ?.prepare(`UPDATE nodes SET last_metrics = ?, last_heartbeat_at = ? WHERE id = 'node-1'`)
      .run(
        JSON.stringify({
          version: 1,
          cpuLoadAvg1: 0.2,
          memoryPercent: 10,
          diskPercent: 10,
          creatingWorkspaces: 1,
        }),
        new Date().toISOString()
      );
    const input = reserveInput(snapshot);
    const reservation = { ...input.resolvedReservation!, cpuMillis: 8000, memoryMb: 8192 };
    const results = await Promise.all(
      ['start-a', 'start-b'].map((id) =>
        reserveWorkspacePlacement(
          database,
          { ...input, id, resolvedReservation: reservation },
          admissionPolicy()
        )
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(countWorkspace('start-a') + countWorkspace('start-b')).toBe(1);
  });

  it('ignores legacy memory percent thresholds when physical headroom fits', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace('workspace-existing-memory-pressure');
    sqlite
      ?.prepare(`UPDATE nodes SET last_metrics = ?, last_heartbeat_at = ? WHERE id = 'node-1'`)
      .run(
        JSON.stringify({ version: 1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
        new Date().toISOString()
      );
    await expect(
      reserveWorkspacePlacement(
        database,
        reserveInput(snapshot),
        admissionPolicy({ memoryThresholdPercent: 1 })
      )
    ).resolves.toBe(true);
  });

  it('reserves measured memory headroom atomically across concurrent starts', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    // 16GiB host: 12GiB used, 512MiB reserved for the host. Only one
    // additional 2GiB start fits, even though declared budgets fit both.
    seedNode({
      last_metrics: JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0.2,
        memoryPercent: 75,
        diskPercent: 10,
      }),
    });
    seedActiveWorkspace('observed-tenant', JSON.stringify(reservation({ memoryMb: 1024 })));
    const results = await Promise.all(
      ['pressure-a', 'pressure-b'].map((id) =>
        reserveWorkspacePlacement(
          database,
          {
            ...reserveInput(snapshot),
            id,
            resolvedReservation: reservation({ memoryMb: 2048 }),
          },
          admissionPolicy()
        )
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(countWorkspace('pressure-a') + countWorkspace('pressure-b')).toBe(1);
  });

  it('rejects a live overusing tenant even when declared memory budgets fit', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      last_metrics: JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0.2,
        memoryPercent: 90,
        diskPercent: 10,
      }),
    });
    seedActiveWorkspace('overusing-tenant');
    await expect(
      reserveWorkspacePlacement(database, reserveInput(snapshot), admissionPolicy())
    ).resolves.toBe(false);
    expect(countWorkspace('workspace-1')).toBe(0);
  });

  it.each([
    ['fresh matching running container', 'running', 'valid', true],
    ['missing container observations', 'running', 'missing', false],
    ['duplicate identity', 'running', 'duplicate', false],
    ['different workspace', 'running', 'foreign', false],
    ['old lifecycle', 'running', 'old-lifecycle', false],
    ['stale observation', 'running', 'stale', false],
    ['future observation', 'running', 'future', false],
    ['malformed observation', 'running', 'malformed', false],
    ['creating workspace', 'creating', 'valid', false],
    ['recovery workspace', 'recovery', 'valid', false],
  ])('credits observed memory safely: %s', async (_name, status, variant, admitted) => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    const heartbeat = new Date().toISOString();
    const collectedAt =
      variant === 'old-lifecycle'
        ? '2026-08-27T00:00:00.000Z'
        : variant === 'stale'
          ? new Date(Date.now() - 60_000).toISOString()
          : variant === 'future'
            ? new Date(Date.now() + 60_000).toISOString()
            : heartbeat;
    const observation = {
      workspaceId: variant === 'foreign' ? 'another-workspace' : 'observed-tenant',
      memoryUsageBytes: 3 * 1024 * 1024 * 1024,
      collectedAt,
    };
    const workspaceMemory =
      variant === 'missing'
        ? undefined
        : variant === 'duplicate'
          ? [observation, observation]
          : variant === 'malformed'
            ? ['bad', { ...observation, memoryUsageBytes: 'lots' }]
            : [observation];
    const lastMetrics = JSON.stringify({
      version: 1,
      cpuLoadAvg1: 0.2,
      memoryPercent: 75,
      diskPercent: 10,
      workspaceMemory,
    });
    seedNode({ last_metrics: lastMetrics, last_heartbeat_at: heartbeat });
    seedActiveWorkspace('observed-tenant', JSON.stringify(reservation({ memoryMb: 3072 })));
    sqlite?.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, 'observed-tenant');
    const policy = admissionPolicy({ metricsTtlMs: 30_000 });
    const request = reservation({ memoryMb: 2048 });
    const usage = (await loadActiveWorkspaceReservationUsage(database, ['node-1'])).get('node-1');
    const advisory = evaluateWorkspaceReservationCapacity(
      {
        id: 'node-1',
        providerInstanceId: 'server-1',
        observedHardwareSource: 'observed',
        observedProviderInstanceVcpuCount: 8,
        observedProviderInstanceMemoryMb: 16384,
        observedProviderInstanceDiskGb: 240,
        lastMetrics,
        lastHeartbeatAt: heartbeat,
      },
      usage,
      request,
      policy
    );
    expect(advisory.admitted).toBe(admitted);
    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          resolvedReservation: request,
        },
        policy
      )
    ).resolves.toBe(admitted);
  });

  it('rejects malformed, future, stale, and incomplete telemetry in final placement', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace('workspace-existing-telemetry');

    for (const [workspaceId, metrics, heartbeat] of [
      ['workspace-bad-telemetry', '{"cpuLoadAvg1":"bad"}', new Date().toISOString()],
      [
        'workspace-future-telemetry',
        JSON.stringify({ version: 2, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
        new Date().toISOString(),
      ],
      [
        'workspace-stale-telemetry',
        JSON.stringify({ version: 1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
        '2026-08-27T23:00:00.000Z',
      ],
      [
        'workspace-incomplete-telemetry',
        JSON.stringify({ version: 1, cpuLoadAvg1: 0.2, diskPercent: 10 }),
        new Date().toISOString(),
      ],
      ['workspace-missing-telemetry', null, new Date().toISOString()],
    ] as const) {
      sqlite
        ?.prepare(`UPDATE nodes SET last_metrics = ?, last_heartbeat_at = ? WHERE id = 'node-1'`)
        .run(metrics, heartbeat);
      await expect(
        reserveWorkspacePlacement(
          database,
          { ...reserveInput(snapshot), id: workspaceId },
          admissionPolicy()
        )
      ).resolves.toBe(false);
    }
  });

  it('rejects unknown observed hardware instead of admitting planned estimates', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      observed_provider_instance_vcpu_count: null,
      observed_provider_instance_memory_mb: null,
      observed_provider_instance_disk_gb: null,
      last_metrics: null,
    });

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-empty-unknown-compatible',
          resolvedReservation: reservation({ memoryMb: 4096, diskMb: 40960 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(false);

    sqlite
      ?.prepare(
        `UPDATE nodes
         SET observed_provider_instance_vcpu_count = 0,
             observed_provider_instance_memory_mb = 8192,
             observed_provider_instance_disk_gb = 80
         WHERE id = 'node-1'`
      )
      .run();

    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-invalid-hardware' },
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  it('admits a user-owned direct node only through verified observed capacity and project access', async () => {
    const database = createDb();
    seedUserOwnedNode();

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(capacitySnapshot()),
          capacityPlacementSnapshot: null,
          authorityNodeClass: 'user-owned',
        },
        admissionPolicy()
      )
    ).resolves.toBe(true);

    sqlite?.prepare(`DELETE FROM workspaces WHERE id = 'workspace-1'`).run();
    sqlite
      ?.prepare(
        `UPDATE nodes
         SET observed_hardware_source = NULL
         WHERE id = 'node-1'`
      )
      .run();

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(capacitySnapshot()),
          id: 'workspace-byo-unverified',
          capacityPlacementSnapshot: null,
          authorityNodeClass: 'user-owned',
        },
        admissionPolicy()
      )
    ).resolves.toBe(false);
    expect(countWorkspace('workspace-byo-unverified')).toBe(0);
  });
});

/**
 * The atomic SQL twin of `measuredHostOverheadMb`, at the default reserve resolved through the real
 * resolver. A fresh 4 GB node reporting 14% (573 MB, the production idle average) must admit an
 * exact-fit 3072 MB request: the old SQL charged 573 + 1024 on top of it and refused.
 */
describe('shared host-overhead accounting in the atomic claim', () => {
  const defaultPolicy = (): PlacementAdmissionPolicy => ({
    ...resolveWorkspaceAdmissionPolicy({}),
    lifetimeAdmissionCutoffAgeMs: null,
  });

  function seedFreshCx23(memoryPercent: number): void {
    seedNode({
      observed_provider_instance_type: 'cx23',
      observed_provider_instance_vcpu_count: 2,
      observed_provider_instance_memory_mb: 4096,
      observed_provider_instance_disk_gb: 40,
      last_metrics: JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0,
        memoryPercent,
        diskPercent: 19.5,
        creatingWorkspaces: 0,
      }),
    });
  }

  it.each([
    ['exact fit at the reserve, host use below it', 14, 3072, true],
    ['one MB over the declared budget', 14, 3073, false],
    ['host use above the reserve by less than the slack', 30, 2048, true],
    ['host use above the reserve leaves no room', 60, 3072, false],
  ])('%s', async (_name, memoryPercent, memoryMb, admitted) => {
    const database = createDb();
    seedFreshCx23(memoryPercent);
    const request = reservation({ cpuMillis: 2000, memoryMb, diskMb: 10_240, exclusiveNode: true });
    const reserved = await reserveWorkspacePlacement(
      database,
      { ...reserveInput(capacitySnapshot()), resolvedReservation: request },
      defaultPolicy()
    );
    expect(reserved).toBe(admitted);
    expect(countWorkspace('workspace-1')).toBe(admitted ? 1 : 0);

    // The advisory evaluator must reach the same verdict from the same rows.
    const node = sqlite
      ?.prepare(
        `SELECT id, node_role AS nodeRole, provider_instance_id AS providerInstanceId,
           observed_provider_instance_vcpu_count AS observedProviderInstanceVcpuCount,
           observed_provider_instance_memory_mb AS observedProviderInstanceMemoryMb,
           observed_provider_instance_disk_gb AS observedProviderInstanceDiskGb,
           observed_hardware_source AS observedHardwareSource,
           last_metrics AS lastMetrics, last_heartbeat_at AS lastHeartbeatAt
         FROM nodes WHERE id = 'node-1'`
      )
      .get() as Parameters<typeof evaluateWorkspaceReservationCapacity>[0];
    const advisory = evaluateWorkspaceReservationCapacity(
      node,
      undefined,
      request,
      defaultPolicy()
    );
    expect(advisory.admitted, advisory.reasons.join('; ')).toBe(admitted);
  });

  it('still charges a co-tenant running past its reservation', async () => {
    const database = createDb();
    // 16 GB host using 75% (12 GB) while its one tenant declared 1 GB: about 11 GB is unattributed.
    seedNode({
      last_metrics: JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0.2,
        memoryPercent: 75,
        diskPercent: 10,
      }),
    });
    seedActiveWorkspace('overrunning-tenant', JSON.stringify(reservation({ memoryMb: 1024 })));
    const policy = defaultPolicy();
    const fits = reservation({ memoryMb: 3072 });
    const overflows = reservation({ memoryMb: 4096 });
    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(capacitySnapshot()), id: 'overflow', resolvedReservation: overflows },
        policy
      )
    ).resolves.toBe(false);
    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(capacitySnapshot()), id: 'fits', resolvedReservation: fits },
        policy
      )
    ).resolves.toBe(true);
  });
});

describe('startup backlog fairness guard in the atomic reservation', () => {
  const BUILDING_METRICS = JSON.stringify({
    version: 1,
    cpuLoadAvg1: 0.2,
    memoryPercent: 10,
    diskPercent: 10,
    creatingWorkspaces: 1,
  });

  function seedStartingWorkspace(id: string, nodeId = 'node-1', status = 'creating'): void {
    sqlite
      ?.prepare(
        `INSERT INTO workspaces
         (id, node_id, user_id, project_id, name, repository, branch, status, vm_size, vm_location,
          resolved_reservation_json, created_at, updated_at)
         VALUES (?, ?, 'user-1', 'project-1', ?, 'acme/repo', 'main', ?, 'large', 'fsn1', ?,
          '2026-11-08T22:00:00.000Z', '2026-11-08T22:00:00.000Z')`
      )
      .run(id, nodeId, id, status, JSON.stringify(reservation()));
  }

  function seedTwoNodes(): void {
    seedNode();
    insertNodeRow({ id: 'node-2', name: 'Second node', provider_instance_id: 'provider-node-2' });
  }

  it('refuses a reservation whose node gained a queued start after ranking, and admits the control', async () => {
    const database = createDb();
    seedNode();
    seedStartingWorkspace('queued-after-ranking');
    const input = reserveInput(capacitySnapshot());

    await expect(
      reserveWorkspacePlacement(
        database,
        { ...input, id: 'ranked-at-zero', maxStartupBacklog: 0 },
        admissionPolicy()
      )
    ).resolves.toBe(false);
    expect(countWorkspace('ranked-at-zero')).toBe(0);

    // Owner-path controls: the same node admits when the observed backlog still holds, and when
    // the caller carries no guard at all.
    await expect(
      reserveWorkspacePlacement(
        database,
        { ...input, id: 'ranked-at-one', maxStartupBacklog: 1 },
        admissionPolicy()
      )
    ).resolves.toBe(true);
    await expect(
      reserveWorkspacePlacement(
        database,
        { ...input, id: 'unguarded', maxStartupBacklog: null },
        admissionPolicy()
      )
    ).resolves.toBe(true);
  });

  it('admits when the backlog shrank since ranking, and counts only creating rows', async () => {
    const database = createDb();
    seedNode();
    seedStartingWorkspace('finished-build', 'node-1', 'running');
    seedStartingWorkspace('recovering', 'node-1', 'recovery');
    // A start that was cancelled or failed leaves the queue.
    seedStartingWorkspace('cancelled-start', 'node-1', 'stopped');
    seedStartingWorkspace('failed-start', 'node-1', 'error');
    const input = reserveInput(capacitySnapshot());

    await expect(
      reserveWorkspacePlacement(
        database,
        { ...input, id: 'ranked-before-finish', maxStartupBacklog: 0 },
        admissionPolicy()
      )
    ).resolves.toBe(true);
  });

  it('never lets a missing guard bypass a capacity check', async () => {
    const database = createDb();
    seedNode();
    const input = reserveInput(capacitySnapshot());
    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...input,
          maxStartupBacklog: null,
          resolvedReservation: reservation({ cpuMillis: 9_000 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  /**
   * K starts that observe the same backlog counts at the same moment, rank the shortest queue
   * first (node id breaks ties, as the strategy would), and race the real reservation. Losers
   * re-read the counts and rank again: the TaskRunner's replan, minus the mocks.
   */
  async function placeBurst(
    database: D1Database,
    starts: number,
    nodeIds: string[],
    { guard }: { guard: boolean }
  ): Promise<{ placedOn: Map<string, string>; rounds: number }> {
    const placedOn = new Map<string, string>();
    let remaining = Array.from({ length: starts }, (_, index) => `burst-${index}`);
    let rounds = 0;
    while (remaining.length > 0 && rounds <= starts) {
      rounds += 1;
      const usage = await loadActiveWorkspaceReservationUsage(database, nodeIds);
      const backlog = (id: string) => usage.get(id)?.startupBacklog ?? 0;
      const [target] = [...nodeIds].sort((a, b) => backlog(a) - backlog(b) || a.localeCompare(b));
      const outcomes = await Promise.all(
        remaining.map(async (id) => ({
          id,
          placed: await reserveWorkspacePlacement(
            database,
            {
              ...reserveInput(capacitySnapshot()),
              id,
              nodeId: target,
              maxStartupBacklog: guard && nodeIds.length > 1 ? backlog(target) : null,
            },
            admissionPolicy()
          ),
        }))
      );
      for (const outcome of outcomes) if (outcome.placed) placedOn.set(outcome.id, target);
      remaining = outcomes.filter((outcome) => !outcome.placed).map((outcome) => outcome.id);
    }
    return { placedOn, rounds };
  }

  function countOn(placedOn: Map<string, string>, nodeId: string): number {
    return [...placedOn.values()].filter((id) => id === nodeId).length;
  }

  it('spreads a simultaneous burst across two building nodes instead of queueing it on one', async () => {
    const database = createDb();
    seedTwoNodes();
    sqlite?.prepare('UPDATE nodes SET last_metrics = ?').run(BUILDING_METRICS);

    const { placedOn, rounds } = await placeBurst(database, 5, ['node-1', 'node-2'], {
      guard: true,
    });

    expect(placedOn.size).toBe(5);
    expect(countOn(placedOn, 'node-1')).toBe(3);
    expect(countOn(placedOn, 'node-2')).toBe(2);
    // One reservation wins per round, so a burst of K converges in K rounds.
    expect(rounds).toBe(5);
  });

  it('queues the same burst on one node when the guard is absent (the incident shape)', async () => {
    const database = createDb();
    seedTwoNodes();

    const { placedOn } = await placeBurst(database, 5, ['node-1', 'node-2'], { guard: false });

    expect(countOn(placedOn, 'node-1')).toBe(5);
    expect(countOn(placedOn, 'node-2')).toBe(0);
  });

  it('places a whole burst on the only eligible node in one round', async () => {
    const database = createDb();
    seedNode({ last_metrics: BUILDING_METRICS });

    const { placedOn, rounds } = await placeBurst(database, 4, ['node-1'], { guard: true });

    expect(countOn(placedOn, 'node-1')).toBe(4);
    expect(rounds).toBe(1);
  });

  it('restarts a workspace on its node while that node is building another one', async () => {
    const database = createDb();
    seedNode({ last_metrics: BUILDING_METRICS });
    seedActiveWorkspace('workspace-1');
    sqlite
      ?.prepare(
        "UPDATE workspaces SET status = 'stopped', chat_session_id = 'chat-1' WHERE id = 'workspace-1'"
      )
      .run();
    const restart = {
      ...reserveInput(capacitySnapshot()),
      chatSessionId: 'chat-1',
      evictionGeneration: 'restart-generation',
      expectedEvictionGeneration: null,
      expectedStatus: 'stopped' as const,
    };

    expect(await reserveWorkspaceRestart(database, restart, admissionPolicy())).toBe(true);

    // Control: a real resource veto on the same building node still refuses the restart.
    sqlite?.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = 'workspace-1'").run();
    sqlite
      ?.prepare("UPDATE nodes SET last_metrics = ? WHERE id = 'node-1'")
      .run(JSON.stringify({ ...JSON.parse(BUILDING_METRICS), diskPercent: 95 }));
    expect(await reserveWorkspaceRestart(database, restart, admissionPolicy())).toBe(false);
  });
});

describe('attachPrecreatedWorkspacePlacement', () => {
  it('atomically attaches a placeholder workspace and writes final authority metadata', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedPlaceholderWorkspace();

    await expect(
      attachPrecreatedWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-attach',
          resourceRequirementsJson: '{"minDiskGb":0}',
        },
        admissionPolicy()
      )
    ).resolves.toBe(true);

    expect(
      sqlite
        ?.prepare(
          `SELECT node_id, status, resource_requirements_json, resolved_reservation_json,
                  capacity_pool_id, capacity_source_generation, capacity_pool_candidate_id,
                  provider_instance_type
             FROM workspaces
            WHERE id = 'workspace-attach'`
        )
        .get()
    ).toMatchObject({
      node_id: 'node-1',
      status: 'creating',
      resource_requirements_json: '{"minDiskGb":0}',
      capacity_pool_id: 'pool-project',
      capacity_source_generation: AUTHORITY_VERSION,
      capacity_pool_candidate_id: 'candidate-cx42',
      provider_instance_type: 'cx42',
    });
  });

  it('rejects a placeholder attach when current project membership was removed', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedPlaceholderWorkspace();
    sqlite?.exec(
      `UPDATE project_members SET status = 'removed', removed_at = '${new Date().toISOString()}'`
    );

    await expect(
      attachPrecreatedWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-attach' },
        admissionPolicy()
      )
    ).resolves.toBe(false);

    expect(
      sqlite?.prepare(`SELECT node_id FROM workspaces WHERE id = 'workspace-attach'`).get()
    ).toMatchObject({ node_id: null });
  });

  it('rejects a placeholder attach when observed hardware is smaller than planned', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      provider_instance_vcpu_count: 8,
      provider_instance_memory_mb: 16 * 1024,
      provider_instance_disk_gb: 240,
      observed_provider_instance_vcpu_count: 1,
      observed_provider_instance_memory_mb: 1024,
      observed_provider_instance_disk_gb: 10,
    });
    seedPlaceholderWorkspace();

    await expect(
      attachPrecreatedWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-attach',
          resolvedReservation: reservation({ cpuMillis: 4000, memoryMb: 8192, diskMb: 8192 }),
        },
        admissionPolicy()
      )
    ).resolves.toBe(false);

    expect(
      sqlite?.prepare(`SELECT node_id FROM workspaces WHERE id = 'workspace-attach'`).get()
    ).toMatchObject({ node_id: null });
  });

  it('attaches a placeholder past the legacy workspace count when resources fit', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedPlaceholderWorkspace();
    seedActiveWorkspace('workspace-existing-slot');

    await expect(
      attachPrecreatedWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-attach' },
        admissionPolicy()
      )
    ).resolves.toBe(true);

    expect(
      sqlite?.prepare(`SELECT node_id FROM workspaces WHERE id = 'workspace-attach'`).get()
    ).toMatchObject({ node_id: 'node-1' });
  });
});

describe('reserveWorkspaceRestart', () => {
  function seedEvicted(id = 'workspace-1') {
    seedActiveWorkspace(id);
    sqlite
      ?.prepare(
        "UPDATE workspaces SET status = 'evicted', chat_session_id = 'chat-1', eviction_finalized_at = '2026-09-13T00:00:00.000Z' WHERE id = ?"
      )
      .run(id);
    return {
      ...reserveInput(capacitySnapshot()),
      id,
      chatSessionId: 'chat-1',
      evictionGeneration: 'next-generation',
      expectedEvictionGeneration: null,
    };
  }

  it('reacquires capacity on the same node without replacing the workspace or snapshot', async () => {
    const database = createDb();
    seedNode();
    const input = seedEvicted();
    sqlite?.exec(
      "INSERT INTO session_snapshots (id, workspace_id) VALUES ('snapshot', 'workspace-1')"
    );
    expect(await reserveWorkspaceRestart(database, input, admissionPolicy())).toBe(true);
    expect(
      sqlite
        ?.prepare("SELECT status, chat_session_id FROM workspaces WHERE id = 'workspace-1'")
        .get()
    ).toEqual({ status: 'creating', chat_session_id: 'chat-1' });
    expect(sqlite?.prepare('SELECT id FROM session_snapshots').all()).toEqual([{ id: 'snapshot' }]);
    expect(await reserveWorkspaceRestart(database, input, admissionPolicy())).toBe(false);
  });

  it('allows only one restart to take the last reservation slot', async () => {
    const database = createDb();
    seedNode();
    const first = seedEvicted('first');
    const second = seedEvicted('second');
    const lastSlotReservation = reservation({ cpuMillis: 8000 });
    sqlite
      ?.prepare(
        "UPDATE workspaces SET resolved_reservation_json = ? WHERE id IN ('first', 'second')"
      )
      .run(JSON.stringify(lastSlotReservation));
    const results = await Promise.all(
      [first, second].map((input) =>
        reserveWorkspaceRestart(
          database,
          { ...input, resolvedReservation: lastSlotReservation },
          admissionPolicy()
        )
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      sqlite?.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE status = 'creating'").get()
    ).toEqual({ count: 1 });
  });

  it.each([
    'UPDATE workspaces SET eviction_finalized_at = NULL',
    "UPDATE workspaces SET eviction_generation = 'another-generation'",
    "UPDATE nodes SET status = 'destroying'",
    'UPDATE nodes SET observed_provider_instance_memory_mb = 1500',
    "UPDATE project_members SET status = 'removed'",
    'UPDATE credentials SET is_active = 0',
    "UPDATE workspaces SET chat_session_id = 'replacement'",
    "UPDATE workspaces SET runtime_deletion_confirmed_at = '2026-09-13'",
  ])(
    'refuses revoked authority, insufficient reserve, or changed identity: %s',
    async (mutation) => {
      const database = createDb();
      seedNode();
      const input = seedEvicted();
      sqlite?.exec(mutation);
      expect(
        await reserveWorkspaceRestart(
          database,
          input,
          admissionPolicy({ hostMemoryReserveMb: 768 })
        )
      ).toBe(false);
      expect(
        sqlite?.prepare("SELECT status FROM workspaces WHERE id = 'workspace-1'").get()
      ).toEqual({ status: 'evicted' });
    }
  );
});

describe('80 percent disk default at every workspace atomic admission', () => {
  it.each(['insert', 'attach', 'restart'] as const)(
    'checks %s without changing running siblings',
    async (path) => {
      const database = createDb();
      seedNode();
      seedActiveWorkspace('sibling');
      const before = sqlite?.prepare("SELECT * FROM workspaces WHERE id = 'sibling'").get();
      const input = reserveInput(capacitySnapshot());
      if (path === 'attach') seedPlaceholderWorkspace(input.id);
      if (path === 'restart') {
        seedActiveWorkspace(input.id);
        sqlite?.exec(
          "UPDATE workspaces SET status = 'evicted', chat_session_id = 'chat-1', eviction_finalized_at = '2026-09-13T00:00:00.000Z' WHERE id = 'workspace-1'"
        );
      }
      const admit = () =>
        path === 'insert'
          ? reserveWorkspacePlacement(database, input, resolveWorkspaceAdmissionPolicy({}))
          : path === 'attach'
            ? attachPrecreatedWorkspacePlacement(
                database,
                input,
                resolveWorkspaceAdmissionPolicy({})
              )
            : reserveWorkspaceRestart(
                database,
                {
                  ...input,
                  chatSessionId: 'chat-1',
                  evictionGeneration: 'next',
                  expectedEvictionGeneration: null,
                },
                resolveWorkspaceAdmissionPolicy({})
              );
      for (const diskPercent of [80, 92]) {
        sqlite
          ?.prepare("UPDATE nodes SET last_metrics = json_set(last_metrics, '$.diskPercent', ?)")
          .run(diskPercent);
        expect(await admit()).toBe(false);
        expect(sqlite?.prepare("SELECT * FROM workspaces WHERE id = 'sibling'").get()).toEqual(
          before
        );
      }
      sqlite
        ?.prepare("UPDATE nodes SET last_metrics = json_set(last_metrics, '$.diskPercent', ?)")
        .run(79.99);
      expect(await admit()).toBe(true);
    }
  );
});

describe('lifetime admission cutoff at every new-placement atomic admission (policy a3780107)', () => {
  const HOUR = 60 * 60 * 1000;
  // 90% of the 24h absolute lifetime: the default 10% cutoff.
  const CUTOFF_AGE_MS = 0.9 * 24 * HOUR;
  const policy = () => admissionPolicy({ lifetimeAdmissionCutoffAgeMs: CUTOFF_AGE_MS });

  function ageNode(ageMs: number) {
    sqlite
      ?.prepare("UPDATE nodes SET created_at = ? WHERE id = 'node-1'")
      .run(new Date(Date.now() - ageMs).toISOString());
  }

  /** The lifetime sweep only reaps nodes a task auto-provisioned (`sweepMaxLifetimeNodes`). */
  function autoProvision() {
    sqlite
      ?.prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, auto_provisioned_node_id,
           created_at, updated_at)
         VALUES ('task-provisioner', 'project-1', 'user-1', 'Provisioner', 'completed', 'node-1',
           '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`
      )
      .run();
  }

  function admitter(database: ReturnType<typeof createDb>, path: 'insert' | 'attach') {
    const input = reserveInput(capacitySnapshot());
    if (path === 'attach') seedPlaceholderWorkspace(input.id);
    return () =>
      path === 'insert'
        ? reserveWorkspacePlacement(database, input, policy())
        : attachPrecreatedWorkspacePlacement(database, input, policy());
  }

  it.each(['insert', 'attach'] as const)(
    'refuses %s onto an auto-provisioned node past the cutoff, and admits it before',
    async (path) => {
      const database = createDb();
      seedNode();
      autoProvision();
      const admit = admitter(database, path);

      ageNode(CUTOFF_AGE_MS + HOUR);
      expect(await admit()).toBe(false);
      expect(
        sqlite?.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE node_id = 'node-1'").get()
      ).toEqual({ count: 0 });

      // Convergence control: the same node one hour younger than the cutoff is admitted.
      ageNode(CUTOFF_AGE_MS - HOUR);
      expect(await admit()).toBe(true);
    }
  );

  it('admits an old node the lifetime sweep never reaps (no task auto-provisioned it)', async () => {
    const database = createDb();
    seedNode();
    ageNode(48 * HOUR);
    expect(await admitter(database, 'insert')()).toBe(true);
  });

  it('names the cutoff as the refusal reason only for a node past it', async () => {
    const database = createDb();
    seedNode();
    autoProvision();
    ageNode(CUTOFF_AGE_MS + HOUR);
    await expect(
      isNodePastLifetimeAdmissionCutoff(database, 'node-1', CUTOFF_AGE_MS)
    ).resolves.toBe(true);
    ageNode(CUTOFF_AGE_MS - HOUR);
    await expect(
      isNodePastLifetimeAdmissionCutoff(database, 'node-1', CUTOFF_AGE_MS)
    ).resolves.toBe(false);
    await expect(isNodePastLifetimeAdmissionCutoff(database, 'node-1', null)).resolves.toBe(false);
  });

  it('admits past the cutoff when the cutoff is disabled', async () => {
    const database = createDb();
    seedNode();
    autoProvision();
    ageNode(CUTOFF_AGE_MS + HOUR);
    const input = reserveInput(capacitySnapshot());
    expect(await reserveWorkspacePlacement(database, input, admissionPolicy())).toBe(true);
  });

  it('still restarts a workspace on its own node past the cutoff', async () => {
    const database = createDb();
    seedNode();
    autoProvision();
    ageNode(CUTOFF_AGE_MS + HOUR);
    seedActiveWorkspace('workspace-1');
    sqlite?.exec(
      "UPDATE workspaces SET status = 'evicted', chat_session_id = 'chat-1', eviction_finalized_at = '2026-09-13T00:00:00.000Z' WHERE id = 'workspace-1'"
    );
    expect(
      await reserveWorkspaceRestart(
        database,
        {
          ...reserveInput(capacitySnapshot()),
          chatSessionId: 'chat-1',
          evictionGeneration: 'next',
          expectedEvictionGeneration: null,
        },
        policy()
      )
    ).toBe(true);
  });
});
