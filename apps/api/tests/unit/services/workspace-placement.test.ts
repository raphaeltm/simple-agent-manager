import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { reserveWorkspacePlacement } from '../../../src/services/workspace-placement';
import type { WorkspaceAdmissionPolicy } from '../../../src/services/workspace-resource-capacity';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

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
    observed_hardware_source: 'provider-create',
    last_heartbeat_at: new Date().toISOString(),
    last_metrics: JSON.stringify({ version: 1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
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
    maxCoTenants: 4,
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

function admissionPolicy(
  overrides: Partial<WorkspaceAdmissionPolicy> = {}
): WorkspaceAdmissionPolicy {
  return {
    maxWorkspaces: 4,
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
  it('persists concrete provider offering and authority metadata on the workspace row', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();

    await expect(reserveWorkspacePlacement(database, reserveInput(snapshot), 5)).resolves.toBe(
      true
    );

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
    ['removed membership', `UPDATE project_members SET status = 'removed', removed_at = '${new Date().toISOString()}'`],
    ['pool revision changed', `UPDATE capacity_pools SET revision = 99`],
    ['pool disabled', `UPDATE capacity_pools SET status = 'disabled'`],
    ['pool owned by another project', `UPDATE capacity_pools SET owner_project_id = 'project-2'`],
    ['source disabled', `UPDATE capacity_sources SET status = 'disabled'`],
    ['source generation changed', `UPDATE capacity_sources SET updated_at = '2023-11-14T22:13:21.000Z'`],
    ['source owned by another project', `UPDATE capacity_sources SET owner_project_id = 'project-2'`],
    ['source credential detached', `UPDATE capacity_sources SET credential_id = NULL`],
    ['credential disabled', `UPDATE credentials SET is_active = 0 WHERE id = 'project-cloud'`],
    ['credential rotated', `UPDATE credentials SET updated_at = '2023-11-14T22:13:21.000Z' WHERE id = 'project-cloud'`],
    ['candidate deleted', `UPDATE capacity_pool_candidates SET status = 'deleted'`],
    [
      'candidate unavailable',
      `UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable'`,
    ],
    ['candidate provider changed', `UPDATE capacity_pool_candidates SET provider = 'gcp'`],
    ['candidate location changed', `UPDATE capacity_pool_candidates SET location = 'nbg1'`],
    ['candidate role changed', `UPDATE capacity_pool_candidates SET workload_role = 'deployment'`],
    ['node lifecycle changed', `UPDATE nodes SET status = 'destroying' WHERE id = 'node-1'`],
    ['node native image changed', `UPDATE nodes SET provider_instance_image = 'other-image' WHERE id = 'node-1'`],
  ])('rejects non-current final authority: %s', async (_name, mutation) => {
    const database = createDb();
    seedNode();
    sqlite?.exec(mutation);

    await expect(
      reserveWorkspacePlacement(database, reserveInput(capacitySnapshot()), admissionPolicy())
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
      reserveWorkspacePlacement(database, reserveInput(capacitySnapshot()), 5)
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
    seedActiveWorkspace('workspace-existing-cpu-a', JSON.stringify(reservation({ cpuMillis: 4000 })));
    seedActiveWorkspace('workspace-existing-cpu-b', JSON.stringify(reservation({ cpuMillis: 4000 })));

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

  it('accepts diskMb zero in v1 and v2 reservations consistently with the JS validator', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace(
      'workspace-existing-zero-disk',
      JSON.stringify(reservation({ diskMb: 0 }))
    );

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
      last_metrics: JSON.stringify({ version: 1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 95 }),
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
      ['workspace-version-zero', JSON.stringify({ version: 0, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 })],
      ['workspace-version-minus-one', JSON.stringify({ version: -1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 })],
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

  it('vetoes final placement when fresh measured pressure changes after selection', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace('workspace-existing-pressure');

    for (const [workspaceId, metrics] of [
      ['workspace-cpu-pressure', { version: 1, cpuLoadAvg1: 8, memoryPercent: 10, diskPercent: 10 }],
      ['workspace-memory-pressure', { version: 1, cpuLoadAvg1: 0.2, memoryPercent: 99, diskPercent: 10 }],
      [
        'workspace-creating-pressure',
        { version: 1, cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10, creatingWorkspaces: 1 },
      ],
    ] as const) {
      sqlite
        ?.prepare(`UPDATE nodes SET last_metrics = ?, last_heartbeat_at = ? WHERE id = 'node-1'`)
        .run(JSON.stringify(metrics), new Date().toISOString());
      await expect(
        reserveWorkspacePlacement(
          database,
          { ...reserveInput(snapshot), id: workspaceId },
          admissionPolicy({ cpuThresholdPercent: 90, memoryThresholdPercent: 90 })
        )
      ).resolves.toBe(false);
    }
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
});
