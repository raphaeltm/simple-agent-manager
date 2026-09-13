import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  reserveWorkspacePlacement,
  type WorkspacePlacementInput,
} from '../../src/services/workspace-placement';
import type { WorkspaceAdmissionPolicy } from '../../src/services/workspace-resource-capacity';
import { seedInstallation, seedNode, seedProject, seedUser } from './helpers/seed-d1';

const USER_ID = 'user-c3a-final-admission';
let sequence = 0;

beforeAll(async () => {
  await seedUser(USER_ID);
});

function nextId(label: string): string {
  sequence += 1;
  return `${label}-${Date.now()}-${sequence}`;
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

function placement(
  workspaceId: string,
  fixture: AuthorityFixture,
  overrides: Partial<WorkspacePlacementInput> = {}
): WorkspacePlacementInput {
  return {
    id: workspaceId,
    nodeId: fixture.nodeId,
    projectId: fixture.projectId,
    userId: USER_ID,
    installationId: fixture.installationId,
    name: workspaceId,
    displayName: workspaceId,
    normalizedDisplayName: workspaceId,
    repository: 'test-org/c3a-final-admission',
    branch: 'main',
    vmSize: 'large',
    vmLocation: 'nbg1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    capacityPlacementSnapshot: fixture.snapshot,
    resolvedReservation: reservation(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface AuthorityFixture {
  projectId: string;
  installationId: string;
  nodeId: string;
  snapshot: CapacityPlacementSnapshot;
}

async function sqliteTimestampVersion(timestamp: string): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT (CAST(strftime('%s', ?) AS INTEGER) * 1000
          + CAST(substr(strftime('%f', ?), 4, 3) AS INTEGER)) AS version`
  )
    .bind(timestamp, timestamp)
    .first<{ version: number }>();
  if (!row) throw new Error('failed to compute SQLite timestamp version');
  return row.version;
}

async function seedCurrentAuthorityFixture(
  label: string,
  options: {
    observedVcpuCount?: number;
    observedMemoryMb?: number;
    observedDiskGb?: number;
    candidateVcpuCount?: number;
    candidateMemoryMb?: number;
    candidateDiskGb?: number;
  } = {}
): Promise<AuthorityFixture> {
  const suffix = nextId(label);
  const installationId = `installation-${suffix}`;
  const projectId = `project-${suffix}`;
  const platformCredentialId = `platform-credential-${suffix}`;
  const sourceId = `capacity-source-${suffix}`;
  const poolId = `capacity-pool-${suffix}`;
  const candidateId = `capacity-candidate-${suffix}`;
  const nodeId = `node-${suffix}`;
  const updatedAt = '2026-09-07 06:00:00.123';
  const version = await sqliteTimestampVersion(updatedAt);
  const credentialReference = `platform_credentials:${platformCredentialId}`;
  const candidateVcpuCount = options.candidateVcpuCount ?? 8;
  const candidateMemoryMb = options.candidateMemoryMb ?? 16_384;
  const candidateDiskGb = options.candidateDiskGb ?? 160;

  await seedInstallation(installationId, USER_ID, { installationIdValue: `inst-${suffix}` });
  await seedProject(projectId, USER_ID, installationId, {
    name: `C3a ${suffix}`,
    repository: 'test-org/c3a-final-admission',
  });

  await env.DATABASE.prepare(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, credential_kind, label, encrypted_token, iv,
        is_enabled, created_by, created_at, updated_at)
     VALUES (?, 'cloud-provider', 'hetzner', 'api-key', ?, 'encrypted-token', 'iv', 1, ?, ?, ?)`
  )
    .bind(platformCredentialId, `Platform ${suffix}`, USER_ID, updatedAt, updatedAt)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO capacity_sources
       (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
        credential_id, platform_credential_id, credential_reference, credential_version,
        external_source_ref, status, created_by, created_at, updated_at)
     VALUES (?, 'project', NULL, ?, 'cloud-provider-credential', 'hetzner', 'platform',
        NULL, ?, ?, ?, NULL, 'active', ?, ?, ?)`
  )
    .bind(
      sourceId,
      projectId,
      platformCredentialId,
      credentialReference,
      version,
      USER_ID,
      updatedAt,
      updatedAt
    )
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO capacity_pools
       (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
        configuration_state, strategy, exhaustion_policy, migration_state, created_by,
        created_at, updated_at)
     VALUES (?, 'project', NULL, ?, ?, 1, 7, 'active', 'configured-ready', 'balanced',
        'queue', 'complete', ?, ?, ?)`
  )
    .bind(poolId, projectId, `Pool ${suffix}`, USER_ID, updatedAt, updatedAt)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO capacity_pool_candidates
       (id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
        machine_class, machine_size, provider_instance_type, provider_instance_vcpu_count,
        provider_instance_memory_mb, provider_instance_disk_gb,
        provider_instance_boot_disk_size_gb, provider_instance_image,
        provider_instance_architecture, catalog_availability, status, priority,
        candidate_order, created_at, updated_at)
     VALUES (?, ?, ?, 'hetzner', 'nbg1', 'workspace', 'vm', 'standard', 'large', 'cx-large',
        ?, ?, ?, NULL, NULL, NULL, 'available', 'active', 0, 0, ?, ?)`
  )
    .bind(
      candidateId,
      poolId,
      sourceId,
      candidateVcpuCount,
      candidateMemoryMb,
      candidateDiskGb,
      updatedAt,
      updatedAt
    )
    .run();

  await seedNode(nodeId, USER_ID, {
    vmSize: 'large',
    vmLocation: 'nbg1',
    status: 'running',
    healthStatus: 'healthy',
    lastHeartbeatAt: new Date().toISOString(),
  });
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET cloud_provider = 'hetzner',
         runtime = 'vm',
         node_class = 'managed',
         node_role = 'workspace',
         workload_role = 'workspace',
         provider_instance_id = ?,
         provider_instance_type = 'cx-large',
         provider_instance_vcpu_count = ?,
         provider_instance_memory_mb = ?,
         provider_instance_disk_gb = ?,
         observed_provider_instance_type = 'cx-large',
         observed_provider_instance_vcpu_count = ?,
         observed_provider_instance_memory_mb = ?,
         observed_provider_instance_disk_gb = ?,
         observed_hardware_source = 'observed',
         capacity_pool_id = ?,
         capacity_pool_scope = 'project',
         capacity_pool_revision = 7,
         capacity_source_id = ?,
         capacity_source_generation = ?,
         capacity_source_external_ref = NULL,
         capacity_pool_candidate_id = ?,
         placement_credential_source = 'platform',
         placement_credential_reference = ?,
         placement_credential_version = ?,
         capacity_pool_project_id = ?,
         agent_ready_at = ?,
         agent_version = 'current-sha',
         last_metrics = NULL,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(
      `server-${suffix}`,
      candidateVcpuCount,
      candidateMemoryMb,
      candidateDiskGb,
      options.observedVcpuCount ?? candidateVcpuCount,
      options.observedMemoryMb ?? candidateMemoryMb,
      options.observedDiskGb ?? candidateDiskGb,
      poolId,
      sourceId,
      version,
      candidateId,
      credentialReference,
      version,
      projectId,
      updatedAt,
      updatedAt,
      nodeId
    )
    .run();

  return {
    projectId,
    installationId,
    nodeId,
    snapshot: {
      placementPlanVersion: 1,
      capacityPoolId: poolId,
      capacityPoolScope: 'project',
      capacityPoolRevision: 7,
      capacitySourceId: sourceId,
      capacitySourceGeneration: version,
      capacitySourceExternalRef: null,
      capacityPoolCandidateId: candidateId,
      placementCredentialSource: 'platform',
      placementCredentialReference: credentialReference,
      placementCredentialVersion: version,
      capacityPoolProjectId: projectId,
      workloadRole: 'workspace',
      providerInstanceType: 'cx-large',
      providerInstanceVcpuCount: candidateVcpuCount,
      providerInstanceMemoryMb: candidateMemoryMb,
      providerInstanceDiskGb: candidateDiskGb,
      providerInstanceBootDiskSizeGb: null,
      providerInstanceImage: null,
      providerInstanceArchitecture: null,
      placementExplanationJson: JSON.stringify({ kind: 'worker-c3a-fixture' }),
    },
  };
}

describe('C3a placement authority final admission on real Workers D1', () => {
  it('requires active project membership in the same atomic reservation statement', async () => {
    const fixture = await seedCurrentAuthorityFixture('membership');

    await env.DATABASE.prepare(
      `UPDATE project_members
       SET status = 'removed', removed_at = ?, updated_at = ?
       WHERE project_id = ? AND user_id = ?`
    )
      .bind('2026-09-07 06:01:00', '2026-09-07 06:01:00', fixture.projectId, USER_ID)
      .run();

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement(`workspace-${nextId('revoked-member')}`, fixture),
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  it('uses observed hardware, not planned candidate capacity, for final reservation capacity', async () => {
    const fixture = await seedCurrentAuthorityFixture('observed-small', {
      candidateVcpuCount: 8,
      candidateMemoryMb: 16_384,
      candidateDiskGb: 160,
      observedVcpuCount: 1,
      observedMemoryMb: 1024,
      observedDiskGb: 10,
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement(`workspace-${nextId('observed-too-small')}`, fixture, {
          resolvedReservation: reservation({ cpuMillis: 4000, memoryMb: 8192, diskMb: 1024 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement(`workspace-${nextId('observed-fits')}`, fixture, {
          resolvedReservation: reservation({ cpuMillis: 500, memoryMb: 512, diskMb: 1024 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
  });
});
