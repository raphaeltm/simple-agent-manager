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
    capacityPoolCandidateId: 'candidate-cx42',
    placementCredentialSource: 'project',
    placementCredentialReference: 'credentials:project-cloud',
    placementCredentialVersion: 1700000000000,
    capacityPoolProjectId: 'project-1',
    workloadRole: 'workspace',
    providerInstanceType: 'cx42',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16 * 1024,
    providerInstanceDiskGb: 240,
    providerInstancePriceDisplay: '€18.49/mo',
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: 1849,
    providerInstancePriceHourlyMicros: 25329,
    placementExplanationJson: '{"candidate":"candidate-cx42"}',
    ...overrides,
  };
}

function seedNode(overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'node-1',
    user_id: 'user-1',
    name: 'Concrete node',
    status: 'running',
    vm_size: 'large',
    vm_location: 'fsn1',
    node_role: 'workspace',
    node_class: 'managed',
    capacity_pool_id: 'pool-project',
    capacity_pool_scope: 'project',
    capacity_pool_revision: 4,
    capacity_source_id: 'source-project',
    capacity_pool_candidate_id: 'candidate-cx42',
    capacity_pool_project_id: 'project-1',
    provider_instance_type: 'cx42',
    provider_instance_vcpu_count: 4,
    provider_instance_memory_mb: 8192,
    provider_instance_disk_gb: 80,
    last_heartbeat_at: '2026-08-28T00:00:00.000Z',
    last_metrics: JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
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

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('reserveWorkspacePlacement', () => {
  it('persists concrete provider offering metadata on the workspace row', async () => {
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
      capacity_pool_candidate_id: 'candidate-cx42',
      provider_instance_type: 'cx42',
      provider_instance_vcpu_count: 8,
      provider_instance_memory_mb: 16 * 1024,
      provider_instance_price_display: '€18.49/mo',
    });
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
    expect(
      sqlite?.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = 'workspace-1'").get()
    ).toEqual({ count: 0 });
  });

  it('prevents aggregate CPU-share overbooking in the final reservation statement', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode();
    seedActiveWorkspace('workspace-existing-cpu', JSON.stringify(reservation({ cpuMillis: 3500 })));

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
      JSON.stringify(reservation({ memoryMb: 6000 }))
    );

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          id: 'workspace-memory-headroom',
          resolvedReservation: reservation({ memoryMb: 2048 }),
        },
        admissionPolicy({ hostMemoryReserveMb: 512 })
      )
    ).resolves.toBe(false);
  });

  it('vetoes disk pressure and malformed occupied reservations', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot();
    seedNode({
      last_metrics: JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 95 }),
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
      .run(JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }));
    seedActiveWorkspace('workspace-existing-invalid', '{"cpuMillis":"bad"}');

    await expect(
      reserveWorkspacePlacement(
        database,
        { ...reserveInput(snapshot), id: 'workspace-invalid-active' },
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });
});
