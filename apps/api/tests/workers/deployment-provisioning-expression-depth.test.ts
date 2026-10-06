import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { linkEnvironmentToNode } from '../../src/services/deployment-provisioning';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const USER_ID = 'user-deploy-expression-depth';
let sequence = 0;

beforeAll(async () => {
  await seedUser(USER_ID);
});

function nextId(label: string): string {
  sequence += 1;
  return `${label}-${Date.now()}-${sequence}`;
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

interface DeploymentPlacementFixture {
  environmentId: string;
  nodeId: string;
  projectId: string;
  snapshot: CapacityPlacementSnapshot;
}

async function seedDeploymentPlacementFixture(
  label: string,
  options: { occupied?: boolean } = {}
): Promise<DeploymentPlacementFixture> {
  const suffix = nextId(label);
  const installationId = `installation-${suffix}`;
  const projectId = `project-${suffix}`;
  const platformCredentialId = `platform-credential-${suffix}`;
  const sourceId = `capacity-source-${suffix}`;
  const poolId = `capacity-pool-${suffix}`;
  const candidateId = `capacity-candidate-${suffix}`;
  const nodeId = `node-${suffix}`;
  const environmentId = `environment-${suffix}`;
  const occupiedEnvironmentId = `occupied-environment-${suffix}`;
  const updatedAt = '2026-09-19 12:00:00.123';
  const heartbeatAt = new Date().toISOString();
  const version = await sqliteTimestampVersion(updatedAt);
  const credentialReference = `platform_credentials:${platformCredentialId}`;

  await seedInstallation(installationId, USER_ID, { installationIdValue: `inst-${suffix}` });
  await seedProject(projectId, USER_ID, installationId, {
    name: `Deployment ${suffix}`,
    repository: 'test-org/deployment-expression-depth',
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
     VALUES (?, 'installation', NULL, NULL, 'cloud-provider-credential', 'hetzner', 'platform',
        NULL, ?, ?, ?, NULL, 'active', ?, ?, ?)`
  )
    .bind(
      sourceId,
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
     VALUES (?, 'installation', NULL, NULL, ?, 1, 7, 'active', 'configured-ready', 'balanced',
        'queue', 'complete', ?, ?, ?)`
  )
    .bind(poolId, `Pool ${suffix}`, USER_ID, updatedAt, updatedAt)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO capacity_pool_candidates
       (id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
        machine_class, machine_size, provider_instance_type, provider_instance_vcpu_count,
        provider_instance_memory_mb, provider_instance_disk_gb,
        provider_instance_boot_disk_size_gb, provider_instance_image,
        provider_instance_architecture, catalog_availability, status, priority,
        candidate_order, created_at, updated_at)
     VALUES (?, ?, ?, 'hetzner', 'fsn1', 'deployment', 'vm', 'standard', 'small', 'cx23',
        2, 4096, 40, NULL, NULL, NULL, 'available', 'active', 0, 0, ?, ?)`
  )
    .bind(candidateId, poolId, sourceId, updatedAt, updatedAt)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO nodes
       (id, user_id, name, status, health_status, runtime, node_class, node_role, workload_role,
        node_mode, cloud_provider, vm_location, vm_size, provider_instance_id,
        provider_instance_type, provider_instance_vcpu_count, provider_instance_memory_mb,
       provider_instance_disk_gb, capacity_pool_id, capacity_pool_scope, capacity_pool_revision,
       capacity_source_id, capacity_source_generation, capacity_source_external_ref,
       capacity_pool_candidate_id, capacity_pool_project_id, placement_credential_source,
        placement_credential_reference, placement_credential_version,
        observed_provider_instance_type, observed_provider_instance_vcpu_count,
        observed_provider_instance_memory_mb, observed_provider_instance_disk_gb,
        observed_hardware_source, last_metrics, last_heartbeat_at, agent_ready_at,
        agent_version, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'healthy', 'vm', 'managed', 'deployment', 'deployment',
        'shared', 'hetzner', 'fsn1', 'small', ?, 'cx23', 2, 4096, 40, ?, 'installation', 7,
        ?, ?, NULL, ?, NULL, 'platform', ?, ?, 'cx23', 2, 4096, 40, 'observed', ?, ?, ?,
        'current-sha', ?, ?)`
  )
    .bind(
      nodeId,
      USER_ID,
      `deployment-node-${suffix}`,
      `server-${suffix}`,
      poolId,
      sourceId,
      version,
      candidateId,
      credentialReference,
      version,
      JSON.stringify({
        version: 1,
        cpuLoadAvg1: 0.1,
        memoryPercent: 10,
        diskPercent: 10,
        creatingWorkspaces: 0,
      }),
      heartbeatAt,
      updatedAt,
      updatedAt,
      updatedAt
    )
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO deployment_environments
       (id, project_id, name, status, node_id, requires_volumes, created_by_user_id,
        created_at, updated_at)
     VALUES (?, ?, 'production', 'active', NULL, 0, ?, ?, ?)`
  )
    .bind(environmentId, projectId, USER_ID, updatedAt, updatedAt)
    .run();

  if (options.occupied) {
    await env.DATABASE.prepare(
      `INSERT INTO deployment_environments
         (id, project_id, name, status, node_id, provider, location, requires_volumes,
          resolved_reservation_json, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'preview', 'active', ?, 'hetzner', 'fsn1', 0, ?, ?, ?, ?)`
    )
      .bind(
        occupiedEnvironmentId,
        projectId,
        nodeId,
        JSON.stringify({
          cpuMillis: 250,
          memoryMb: 128,
          diskMb: 1024,
          exclusiveNode: false,
          source: 'task',
          sourceId: `release-${suffix}`,
          version: 3,
        }),
        USER_ID,
        updatedAt,
        updatedAt
      )
      .run();
  }

  return {
    environmentId,
    nodeId,
    projectId,
    snapshot: {
      placementPlanVersion: 1,
      capacityPoolId: poolId,
      capacityPoolScope: 'installation',
      capacityPoolRevision: 7,
      capacitySourceId: sourceId,
      capacitySourceGeneration: version,
      capacitySourceExternalRef: null,
      capacityPoolCandidateId: candidateId,
      placementCredentialSource: 'platform',
      placementCredentialReference: credentialReference,
      placementCredentialVersion: version,
      capacityPoolProjectId: null,
      workloadRole: 'deployment',
      providerInstanceType: 'cx23',
      providerInstanceVcpuCount: 2,
      providerInstanceMemoryMb: 4096,
      providerInstanceDiskGb: 40,
      providerInstanceBootDiskSizeGb: null,
      providerInstanceImage: null,
      providerInstanceArchitecture: null,
      placementExplanationJson: JSON.stringify({ kind: 'deployment-expression-depth-fixture' }),
    },
  };
}

describe('deployment provisioning placement on real Workers D1', () => {
  it('links a second environment through installation authority within SQLite limits', async () => {
    const fixture = await seedDeploymentPlacementFixture('reuse', { occupied: true });
    const linked = await linkEnvironmentToNode({
      env,
      db: drizzle(env.DATABASE, { schema }),
      envId: fixture.environmentId,
      nodeId: fixture.nodeId,
      placement: {
        projectId: fixture.projectId,
        provider: 'hetzner',
        location: 'fsn1',
        vmSize: 'small',
        credentialSource: 'platform',
        credentialAttributionUserId: USER_ID,
        credentialAttributionProjectId: fixture.projectId,
        placementCredentialSource: 'platform',
        placementCredentialReference: fixture.snapshot.placementCredentialReference,
        placementCredentialVersion: fixture.snapshot.placementCredentialVersion,
        providerInstanceType: fixture.snapshot.providerInstanceType,
        providerInstanceBootDiskSizeGb: fixture.snapshot.providerInstanceBootDiskSizeGb,
        providerInstanceImage: fixture.snapshot.providerInstanceImage,
        providerInstanceArchitecture: fixture.snapshot.providerInstanceArchitecture,
        capacityPlacementSnapshot: fixture.snapshot,
        capacityPoolSelection: null,
        reservation: {
          cpuMillis: 250,
          memoryMb: 128,
          diskMb: 1024,
          exclusiveNode: false,
          source: 'task',
          sourceId: `release-${fixture.environmentId}`,
          version: 3,
        },
      },
      userId: USER_ID,
      expectedNodeStatus: 'running',
      nodeMode: 'shared',
    });

    expect(linked).toBe(true);
    await expect(
      env.DATABASE.prepare(`SELECT node_id FROM deployment_environments WHERE id = ?`)
        .bind(fixture.environmentId)
        .first<{ node_id: string }>()
    ).resolves.toEqual({ node_id: fixture.nodeId });
  });
});
