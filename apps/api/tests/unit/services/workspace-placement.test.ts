import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { reserveWorkspacePlacement } from '../../../src/services/workspace-placement';
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
    provider_instance_vcpu_count: 8,
    provider_instance_memory_mb: 16 * 1024,
    provider_instance_disk_gb: 240,
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
    resolvedReservation: {
      cpuMillis: 2_000,
      memoryMb: 4_096,
      diskMb: 40_960,
      exclusiveNode: false,
      maxCoTenants: 4,
      source: 'platform' as const,
      sourceId: 'platform',
      version: 1,
    },
    capacityPlacementSnapshot: snapshot,
    createdAt: '2026-08-28T00:00:00.000Z',
  };
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

  it('rejects a request that exceeds known capacity on an empty node', async () => {
    const database = createDb();
    const snapshot = capacitySnapshot({
      capacityPoolCandidateId: 'candidate-cx23',
      providerInstanceType: 'cx23',
      providerInstanceVcpuCount: 2,
      providerInstanceMemoryMb: 4_096,
      providerInstanceDiskGb: 40,
    });
    seedNode({
      capacity_pool_candidate_id: 'candidate-cx23',
      provider_instance_type: 'cx23',
      provider_instance_vcpu_count: 2,
      provider_instance_memory_mb: 4_096,
      provider_instance_disk_gb: 40,
    });

    await expect(
      reserveWorkspacePlacement(
        database,
        {
          ...reserveInput(snapshot),
          resolvedReservation: {
            ...reserveInput(snapshot).resolvedReservation,
            cpuMillis: 3_000,
          },
        },
        5
      )
    ).resolves.toBe(false);
  });
});
