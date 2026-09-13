import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { findNodeWithCapacity } from '../../src/durable-objects/task-runner/node-selection';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
import {
  reserveWorkspacePlacement,
  type WorkspacePlacementInput,
} from '../../src/services/workspace-placement';
import {
  aggregateWorkspaceReservationRows,
  type WorkspaceAdmissionPolicy,
} from '../../src/services/workspace-resource-capacity';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { NodeLifecycleTestDouble } from './support/expected-error-doubles';

const USER_ID = 'user-workspace-resource-capacity';
const INSTALLATION_ID = 'installation-workspace-resource-capacity';
const PROJECT_ID = 'project-workspace-resource-capacity';

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
});

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

function placement(
  workspaceId: string,
  nodeId: string,
  overrides: Partial<WorkspacePlacementInput> = {}
): WorkspacePlacementInput {
  return {
    id: workspaceId,
    nodeId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    installationId: INSTALLATION_ID,
    name: workspaceId,
    displayName: workspaceId,
    normalizedDisplayName: workspaceId,
    repository: 'test-org/workspace-resource-capacity',
    branch: 'main',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    resolvedReservation: reservation(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function makeReadyNode(
  nodeId: string,
  userId = USER_ID,
  size: 'small' | 'medium' | 'large' = 'medium',
  overrides: Partial<{
    lastMetrics: string | null;
    lastHeartbeatAt: string | null;
    providerInstanceVcpuCount: number | null;
    providerInstanceMemoryMb: number | null;
    providerInstanceDiskGb: number | null;
  }> = {}
): Promise<void> {
  const now = new Date().toISOString();
  const capacity =
    size === 'large'
      ? { vcpu: 8, memoryMb: 16384, diskGb: 160 }
      : size === 'small'
        ? { vcpu: 2, memoryMb: 4096, diskGb: 40 }
        : { vcpu: 4, memoryMb: 8192, diskGb: 80 };
  const providerInstanceVcpuCount =
    'providerInstanceVcpuCount' in overrides ? overrides.providerInstanceVcpuCount : capacity.vcpu;
  const providerInstanceMemoryMb =
    'providerInstanceMemoryMb' in overrides
      ? overrides.providerInstanceMemoryMb
      : capacity.memoryMb;
  const providerInstanceDiskGb =
    'providerInstanceDiskGb' in overrides ? overrides.providerInstanceDiskGb : capacity.diskGb;
  await seedNode(nodeId, userId, {
    vmSize: size,
    vmLocation: 'nbg1',
    status: 'running',
    healthStatus: 'healthy',
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
  });
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET agent_ready_at = ?,
         agent_version = 'current-sha',
         runtime = 'vm',
         node_role = 'workspace',
         last_metrics = ?,
         provider_instance_id = ?,
         provider_instance_type = ?,
         provider_instance_vcpu_count = ?,
         provider_instance_memory_mb = ?,
         provider_instance_disk_gb = ?,
         observed_provider_instance_type = ?,
         observed_provider_instance_vcpu_count = ?,
         observed_provider_instance_memory_mb = ?,
         observed_provider_instance_disk_gb = ?,
         observed_hardware_source = 'observed'
     WHERE id = ?`
  )
    .bind(
      now,
      overrides.lastMetrics ??
        JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
      `server-${nodeId}`,
      `test-${size}`,
      providerInstanceVcpuCount,
      providerInstanceMemoryMb,
      providerInstanceDiskGb,
      `test-${size}`,
      providerInstanceVcpuCount,
      providerInstanceMemoryMb,
      providerInstanceDiskGb,
      nodeId
    )
    .run();
}

function providerCapacityForSize(size: 'small' | 'medium' | 'large'): {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
} {
  if (size === 'large') return { vcpu: 8, memoryMb: 16_384, diskGb: 160 };
  if (size === 'small') return { vcpu: 2, memoryMb: 4096, diskGb: 40 };
  return { vcpu: 4, memoryMb: 8192, diskGb: 80 };
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

async function seedCurrentAuthorityForNode(input: {
  nodeId: string;
  userId: string;
  projectId: string;
  label: string;
  size?: 'small' | 'medium' | 'large';
}): Promise<CapacityPlacementSnapshot> {
  const size = input.size ?? 'medium';
  const capacity = providerCapacityForSize(size);
  const updatedAt = '2026-09-07 07:00:00.123';
  const version = await sqliteTimestampVersion(updatedAt);
  const suffix = `${input.label}-${input.nodeId}`;
  const platformCredentialId = `platform-wrc-${suffix}`;
  const sourceId = `source-wrc-${suffix}`;
  const poolId = `pool-wrc-${suffix}`;
  const candidateId = `candidate-wrc-${suffix}`;
  const providerInstanceType = `test-${size}`;
  const credentialReference = `platform_credentials:${platformCredentialId}`;

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_credentials
       (id, credential_type, provider, credential_kind, label, encrypted_token, iv,
        is_enabled, created_by, created_at, updated_at)
     VALUES (?, 'cloud-provider', 'hetzner', 'api-key', ?, 'encrypted-token', 'iv',
        1, ?, ?, ?)`
  )
    .bind(platformCredentialId, `WRC ${suffix}`, input.userId, updatedAt, updatedAt)
    .run();

  // Only one default pool may exist per project (unique index), and final
  // admission requires the claimed pool to BE the current default. Retire the
  // previous default before publishing this one — an INSERT OR IGNORE that lost
  // that race used to be silently skipped, and the candidate insert then failed
  // its pool foreign key.
  await env.DATABASE.prepare(
    `UPDATE capacity_pools
        SET is_default = 0
      WHERE scope = 'project' AND owner_project_id = ? AND id != ?`
  )
    .bind(input.projectId, poolId)
    .run();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_pools
       (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
        configuration_state, strategy, exhaustion_policy, migration_state, created_by,
        created_at, updated_at)
     VALUES (?, 'project', NULL, ?, ?, 1, 7, 'active', 'configured-ready', 'balanced',
        'queue', 'complete', ?, ?, ?)`
  )
    .bind(poolId, input.projectId, `Pool ${suffix}`, input.userId, updatedAt, updatedAt)
    .run();
  await env.DATABASE.prepare(`UPDATE capacity_pools SET is_default = 1 WHERE id = ?`)
    .bind(poolId)
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_sources
       (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
        credential_id, platform_credential_id, credential_reference, credential_version,
        external_source_ref, status, created_by, created_at, updated_at)
     VALUES (?, 'project', NULL, ?, 'cloud-provider-credential', 'hetzner', 'platform',
        NULL, ?, ?, ?, NULL, 'active', ?, ?, ?)`
  )
    .bind(
      sourceId,
      input.projectId,
      platformCredentialId,
      credentialReference,
      version,
      input.userId,
      updatedAt,
      updatedAt
    )
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_pool_candidates
       (id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
        machine_class, machine_size, provider_instance_type, provider_instance_vcpu_count,
        provider_instance_memory_mb, provider_instance_disk_gb,
        provider_instance_boot_disk_size_gb, provider_instance_image,
        provider_instance_architecture, catalog_availability, status, priority,
        candidate_order, created_at, updated_at)
     VALUES (?, ?, ?, 'hetzner', 'nbg1', 'workspace', 'vm', 'standard', ?, ?,
        ?, ?, ?, NULL, NULL, NULL, 'available', 'active', 0, 0, ?, ?)`
  )
    .bind(
      candidateId,
      poolId,
      sourceId,
      size,
      providerInstanceType,
      capacity.vcpu,
      capacity.memoryMb,
      capacity.diskGb,
      updatedAt,
      updatedAt
    )
    .run();

  await env.DATABASE.prepare(
    `UPDATE nodes
     SET cloud_provider = 'hetzner',
         vm_location = 'nbg1',
         vm_size = ?,
         provider_instance_type = ?,
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
         workload_role = 'workspace',
         updated_at = ?
     WHERE id = ?`
  )
    .bind(
      size,
      providerInstanceType,
      poolId,
      sourceId,
      version,
      candidateId,
      credentialReference,
      version,
      input.projectId,
      updatedAt,
      input.nodeId
    )
    .run();

  return {
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
    capacityPoolProjectId: input.projectId,
    workloadRole: 'workspace',
    providerInstanceType,
    providerInstanceVcpuCount: capacity.vcpu,
    providerInstanceMemoryMb: capacity.memoryMb,
    providerInstanceDiskGb: capacity.diskGb,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    placementExplanationJson: JSON.stringify({ kind: 'workspace-resource-capacity-race' }),
  };
}

function taskState(
  userId: string,
  size: 'small' | 'medium' | 'large',
  overrides: Partial<{
    projectId: string;
    installationId: string;
    resolvedReservation: ResolvedResourceReservation;
    projectScaling: TaskRunnerState['config']['projectScaling'];
    capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
  }> = {}
): TaskRunnerState {
  const now = Date.now();
  return {
    version: 1,
    taskId: `task-workspace-resource-capacity-${userId}-${size}`,
    projectId: overrides.projectId ?? PROJECT_ID,
    userId,
    currentStep: 'node_selection',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      claimedWarmNodeId: null,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
      capacityPlacementSnapshot: overrides.capacityPlacementSnapshot,
    },
    config: {
      vmSize: size,
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'workspace resource capacity',
      taskDescription: null,
      repository: 'test-org/workspace-resource-capacity',
      installationId: overrides.installationId ?? INSTALLATION_ID,
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'openai-codex',
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      cloudProvider: 'hetzner',
      credentialAttributionUserId: userId,
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: overrides.projectScaling ?? { maxWorkspacesPerNode: 4 },
      resourceRequirements: null,
      resolvedReservation: overrides.resolvedReservation ?? reservation(),
      capacityPoolSelection: null,
      vmSizeSource: null,
      resumeSnapshotChatSessionId: null,
      recoverySourceTaskId: null,
      retrySourceTaskId: null,
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: now,
    lastStepAt: now,
    provisioningStartedAt: null,
    admissionScopeKey: null,
    admissionLeaseToken: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: null,
    completed: false,
  };
}

function selectorContext(): TaskRunnerContext {
  return {
    env: {
      DATABASE: env.DATABASE,
      MAX_WORKSPACES_PER_NODE: '4',
      TASK_RUN_NODE_CPU_THRESHOLD_PERCENT: '90',
      TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT: '90',
      TASK_RUN_NODE_DISK_PRESSURE_THRESHOLD_PERCENT: '90',
      VM_AGENT_REQUIRED_VERSION: 'current-sha',
    },
  } as unknown as TaskRunnerContext;
}

describe('workspace resource capacity final reservation CAS', () => {
  it.each(['admission-first', 'shutdown-first', 'concurrent'] as const)(
    'orders workspace admission against stale warm shutdown (%s)', async (ordering) => {
      const nodeId = `node-wrc-shutdown-${ordering}`;
      await makeReadyNode(nodeId);
      const snapshot = await seedCurrentAuthorityForNode({
        nodeId, userId: USER_ID, projectId: PROJECT_ID, label: `shutdown-${ordering}`,
      });
      const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(nodeId)) as DurableObjectStub<NodeLifecycleTestDouble>;
      await runInDurableObject(stub, async (instance) => {
        await instance.ctx.storage.put('state', {
          nodeId, userId: USER_ID, status: 'warm', warmSince: Date.now() - 600_000,
          claimedByTask: null,
        });
      });
      const admit = () => reserveWorkspacePlacement(env.DATABASE,
        placement(`ws-wrc-shutdown-${ordering}`, nodeId, { capacityPlacementSnapshot: snapshot }),
        admissionPolicy());
      const shutdown = () => runInDurableObject(stub, async (instance) => instance.alarm());
      let admitted: boolean;
      if (ordering === 'admission-first') {
        admitted = await admit();
        expect(admitted).toBe(true);
        await shutdown();
      } else if (ordering === 'shutdown-first') {
        await shutdown();
        admitted = await admit();
        expect(admitted).toBe(false);
      } else {
        [admitted] = await Promise.all([admit(), shutdown()]);
      }
      const node = await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?').bind(nodeId).first<{status: string}>();
      const workspace = await env.DATABASE.prepare('SELECT status FROM workspaces WHERE node_id = ?').bind(nodeId).first<{status: string}>();
      expect(node?.status).toBe(admitted ? 'running' : 'stopped');
      expect(workspace).toEqual(admitted ? { status: 'creating' } : null);
    }
  );

  it('atomically admits only the varied reservation that fits the remaining CPU-share budget', async () => {
    const nodeId = 'node-wrc-cpu-share-budget';
    await makeReadyNode(nodeId);
    const snapshot = await seedCurrentAuthorityForNode({
      nodeId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'cpu-share',
    });
    await seedWorkspace('workspace-wrc-cpu-active', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(reservation({ cpuMillis: 3000 })),
    });

    const outcomes = await Promise.all([
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-cpu-small', nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: reservation({ cpuMillis: 1000 }),
        }),
        admissionPolicy()
      ),
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-cpu-large', nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: reservation({ cpuMillis: 1500 }),
        }),
        admissionPolicy()
      ),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const total = await env.DATABASE.prepare(
      `SELECT SUM(CAST(json_extract(resolved_reservation_json, '$.cpuMillis') AS INTEGER)) AS cpuMillis
       FROM workspaces
       WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
    )
      .bind(nodeId)
      .first<{ cpuMillis: number }>();
    expect(total?.cpuMillis).toBeLessThanOrEqual(4000);
  });

  it('applies host memory reserve and disk pressure as final admission vetoes', async () => {
    const memoryNode = 'node-wrc-host-headroom';
    const diskNode = 'node-wrc-disk-pressure';
    await makeReadyNode(memoryNode);
    await makeReadyNode(diskNode, USER_ID, 'medium', {
      lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 95 }),
    });
    const memorySnapshot = await seedCurrentAuthorityForNode({
      nodeId: memoryNode,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'memory',
    });
    const diskSnapshot = await seedCurrentAuthorityForNode({
      nodeId: diskNode,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'disk',
    });
    await seedWorkspace('workspace-wrc-memory-active', memoryNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(reservation({ memoryMb: 6000 })),
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-memory-denied', memoryNode, {
          capacityPlacementSnapshot: memorySnapshot,
          resolvedReservation: reservation({ memoryMb: 2048 }),
        }),
        admissionPolicy({ hostMemoryReserveMb: 512 })
      )
    ).resolves.toBe(false);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-disk-denied', diskNode, {
          capacityPlacementSnapshot: diskSnapshot,
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  it('accounts for active v1 and v2 reservation snapshots in real D1 final CAS', async () => {
    const nodeId = 'node-wrc-v2-reservations';
    await makeReadyNode(nodeId, USER_ID, 'medium');
    // Current authority like every other node in this file: a default project pool
    // exists for PROJECT_ID here, so an unpooled node would be refused before the
    // reservation arithmetic this case is about.
    const snapshot = await seedCurrentAuthorityForNode({
      nodeId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'v2-reservations',
    });
    await seedWorkspace('workspace-wrc-v2-active-v1', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(
        reservation({ cpuMillis: 1500, memoryMb: 2048, diskMb: 2048 })
      ),
    });
    await seedWorkspace('workspace-wrc-v2-active-v2', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(
        reservationV2({ cpuMillis: 1500, memoryMb: 2048, diskMb: 2048 })
      ),
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-v2-fits', nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: reservationV2({ cpuMillis: 1000, memoryMb: 1024, diskMb: 1024 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-v2-overbook', nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: reservationV2({ cpuMillis: 1100, memoryMb: 1024, diskMb: 1024 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });

  it('vetoes final reservations when selected node metrics change to unsafe pressure', async () => {
    const cases: Array<{
      name: string;
      metrics: Record<string, number>;
    }> = [
      { name: 'cpu', metrics: { cpuLoadAvg1: 8, memoryPercent: 10, diskPercent: 10 } },
      { name: 'memory', metrics: { cpuLoadAvg1: 0.2, memoryPercent: 99, diskPercent: 10 } },
      {
        name: 'creating',
        metrics: { cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10, creatingWorkspaces: 1 },
      },
    ];

    for (const testCase of cases) {
      const userId = `user-wrc-pressure-change-${testCase.name}`;
      const installationId = `installation-wrc-pressure-change-${testCase.name}`;
      const projectId = `project-wrc-pressure-change-${testCase.name}`;
      const nodeId = `node-wrc-pressure-change-${testCase.name}`;
      await seedUser(userId);
      await seedInstallation(installationId, userId, {
        installationIdValue: `inst-wrc-pressure-change-${testCase.name}`,
        accountName: `test-user-wrc-pressure-change-${testCase.name}`,
      });
      await seedProject(projectId, userId, installationId);
      await makeReadyNode(nodeId, userId, 'medium');
      await seedWorkspace(`workspace-wrc-pressure-active-${testCase.name}`, nodeId, userId, {
        projectId,
        status: 'running',
        resolvedReservationJson: JSON.stringify(reservation()),
      });

      const selected = await findNodeWithCapacity(
        taskState(userId, 'medium', {
          projectId,
          installationId,
          projectScaling: {
            maxWorkspacesPerNode: 4,
            nodeCpuThresholdPercent: 90,
            nodeMemoryThresholdPercent: 90,
          },
          resolvedReservation: reservation(),
        }),
        selectorContext()
      );
      expect(selected?.nodeId).toBe(nodeId);

      await env.DATABASE.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = ?`)
        .bind(JSON.stringify(testCase.metrics), nodeId)
        .run();

      await expect(
        reserveWorkspacePlacement(
          env.DATABASE,
          placement(`workspace-wrc-pressure-denied-${testCase.name}`, nodeId, {
            userId,
            projectId,
            installationId,
          }),
          admissionPolicy({ cpuThresholdPercent: 90, memoryThresholdPercent: 90 })
        )
      ).resolves.toBe(false);
    }
  });

  it('fails closed for malformed active snapshots and unknown observed hardware', async () => {
    const occupiedNode = 'node-wrc-invalid-active';
    const unknownNode = 'node-wrc-empty-unknown';
    await makeReadyNode(occupiedNode);
    await makeReadyNode(unknownNode, USER_ID, 'medium', {
      providerInstanceVcpuCount: null,
      providerInstanceMemoryMb: null,
      providerInstanceDiskGb: null,
      lastMetrics: null,
    });
    await seedWorkspace('workspace-wrc-invalid-active', occupiedNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: '{"cpuMillis":"bad"}',
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-invalid-denied', occupiedNode),
        admissionPolicy()
      )
    ).resolves.toBe(false);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-empty-unknown-denied', unknownNode, {
          resolvedReservation: reservation({ memoryMb: 4096, diskMb: 40960 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);
  });
});

describe('workspace resource capacity advisory selection', () => {
  it('normalizes load average and vetoes disk pressure before choosing an existing node', async () => {
    const userId = 'user-wrc-selection';
    const installationId = 'installation-wrc-selection';
    const projectId = 'project-wrc-selection';
    const smallBusyNode = 'node-wrc-selection-small-busy';
    const diskPressureNode = 'node-wrc-selection-disk-pressure';
    const largeAvailableNode = 'node-wrc-selection-large-available';
    await seedUser(userId);
    await seedInstallation(installationId, userId, {
      installationIdValue: 'inst-wrc-selection',
      accountName: 'test-user-wrc-selection',
    });
    await seedProject(projectId, userId, installationId);
    await makeReadyNode(smallBusyNode, userId, 'small', {
      lastMetrics: JSON.stringify({ cpuLoadAvg1: 1.5, memoryPercent: 10, diskPercent: 10 }),
    });
    await makeReadyNode(diskPressureNode, userId, 'large', {
      lastMetrics: JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 95 }),
    });
    await makeReadyNode(largeAvailableNode, userId, 'large', {
      lastMetrics: JSON.stringify({ cpuLoadAvg1: 1.5, memoryPercent: 10, diskPercent: 10 }),
    });

    const selected = await findNodeWithCapacity(
      taskState(userId, 'small', {
        projectId,
        installationId,
        projectScaling: {
          maxWorkspacesPerNode: 4,
          nodeCpuThresholdPercent: 70,
          nodeMemoryThresholdPercent: 90,
        },
        resolvedReservation: reservation(),
      }),
      selectorContext()
    );

    expect(selected?.nodeId).toBe(largeAvailableNode);
  });
});

// Preserve upstream mutation calibration against the canonical authority-bearing SQL.
function interceptDatabase(
  statements: string[],
  options: {
    transformSql?: (sql: string) => string;
    transformBinds?: (values: unknown[]) => unknown[];
  } = {}
): D1Database {
  return {
    prepare(sql: string) {
      statements.push(sql);
      const statement = env.DATABASE.prepare(options.transformSql?.(sql) ?? sql);
      return {
        bind(...values: unknown[]) {
          return statement.bind(...(options.transformBinds?.(values) ?? values));
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}

function removeAggregateResourcePredicates(sql: string): string {
  const patterns = [
    /\(\(active\.cpu_millis\s*\+\s*requested\.cpu_millis\)\s*<=\s*\(n\.trusted_provider_instance_vcpu_count\s*\*\s*1000\s*\*\s*policy\.cpu_share_budget_percent\)\s*\/\s*100\)/,
    /\(\(active\.memory_mb\s*\+\s*requested\.memory_mb\)\s*<=\s*n\.trusted_provider_instance_memory_mb\s*-\s*policy\.host_memory_reserve_mb\)/,
    /\(\(active\.disk_mb\s*\+\s*requested\.disk_mb\)\s*<=\s*n\.trusted_provider_instance_disk_gb\s*\*\s*1024\)/,
  ];
  let mutated = sql;
  for (const pattern of patterns) {
    if (!pattern.test(mutated)) throw new Error(`mutation target not found: ${pattern.source}`);
    mutated = mutated.replace(pattern, '1 = 1');
  }
  return mutated;
}

function assertExactReservationSnapshot(
  actual: string | null | undefined,
  expected: ResolvedResourceReservation
): void {
  if (actual !== JSON.stringify(expected)) {
    throw new Error('persisted reservation changed after placement resolution');
  }
}

function assertUsageWithinSmallNode(rows: Array<{ resolvedReservationJson: string | null }>): void {
  const usage = aggregateWorkspaceReservationRows(rows);
  if (usage.cpuMillis > 2000) throw new Error('CPU overcommit detected');
  if (usage.memoryMb > 4096) throw new Error('memory overcommit detected');
  if (usage.diskMb > 40960) throw new Error('disk overcommit detected');
}

describe('native final reservation mutation calibration', () => {
  it('uses one final D1 statement and persists exact authority and reservation snapshots', async () => {
    const nodeId = 'node-wrc-exact-snapshot';
    const workspaceId = 'workspace-wrc-exact-snapshot';
    await makeReadyNode(nodeId, USER_ID, 'large');
    const snapshot = await seedCurrentAuthorityForNode({
      nodeId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'exact',
      size: 'large',
    });
    const exact = reservationV2({
      cpuMillis: 3000,
      memoryMb: 6144,
      source: 'task',
      sourceId: 'task-exact',
    });
    const statements: string[] = [];
    await expect(
      reserveWorkspacePlacement(
        interceptDatabase(statements),
        placement(workspaceId, nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: exact,
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('INSERT INTO workspaces');
    const row = await env.DATABASE.prepare(
      `SELECT capacity_pool_id, capacity_pool_revision,
      capacity_source_id, placement_credential_reference, placement_credential_version,
      placement_explanation_json, resolved_reservation_json FROM workspaces WHERE id = ?`
    )
      .bind(workspaceId)
      .first<Record<string, string | number | null>>();
    expect(row).toMatchObject({
      capacity_pool_id: snapshot.capacityPoolId,
      capacity_pool_revision: snapshot.capacityPoolRevision,
      capacity_source_id: snapshot.capacitySourceId,
      placement_credential_reference: snapshot.placementCredentialReference,
      placement_credential_version: snapshot.placementCredentialVersion,
      placement_explanation_json: snapshot.placementExplanationJson,
    });
    assertExactReservationSnapshot(row?.resolved_reservation_json as string | null, exact);
  });

  it('calibrates exact snapshot preservation against a final bind mutation', async () => {
    const nodeId = 'node-wrc-mutated-snapshot';
    const workspaceId = 'workspace-wrc-mutated-snapshot';
    await makeReadyNode(nodeId);
    const snapshot = await seedCurrentAuthorityForNode({
      nodeId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'mutated-snapshot',
    });
    const exact = reservation({ source: 'task', sourceId: 'task-exact-before-async-work' });
    const expectedJson = JSON.stringify(exact);
    const mutatedJson = JSON.stringify({ ...exact, sourceId: 're-resolved-too-late' });
    await expect(
      reserveWorkspacePlacement(
        interceptDatabase([], {
          transformBinds: (values) =>
            values.map((value) => (value === expectedJson ? mutatedJson : value)),
        }),
        placement(workspaceId, nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: exact,
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
    const row = await env.DATABASE.prepare(
      'SELECT resolved_reservation_json AS reservationJson FROM workspaces WHERE id = ?'
    )
      .bind(workspaceId)
      .first<{ reservationJson: string | null }>();
    expect(() => assertExactReservationSnapshot(row?.reservationJson, exact)).toThrow(
      /changed after placement resolution/
    );
  });

  it('calibrates the aggregate invariant against removal of the native resource CAS predicates', async () => {
    const nodeId = 'node-wrc-mutated-resource-cas';
    await makeReadyNode(nodeId, USER_ID, 'small');
    const snapshot = await seedCurrentAuthorityForNode({
      nodeId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'mutated-cas',
      size: 'small',
    });
    const request = reservation({ cpuMillis: 2000, memoryMb: 4096, diskMb: 40960 });
    const input = { capacityPlacementSnapshot: snapshot, resolvedReservation: request };
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-mutated-existing', nodeId, input),
        admissionPolicy()
      )
    ).resolves.toBe(true);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-unmutated-overflow', nodeId, input),
        admissionPolicy()
      )
    ).resolves.toBe(false);
    const statements: string[] = [];
    await expect(
      reserveWorkspacePlacement(
        interceptDatabase(statements, { transformSql: removeAggregateResourcePredicates }),
        placement('workspace-wrc-mutated-overflow', nodeId, input),
        admissionPolicy()
      )
    ).resolves.toBe(true);
    expect(statements).toHaveLength(1);
    const rows = await env.DATABASE.prepare(
      `SELECT resolved_reservation_json AS resolvedReservationJson
      FROM workspaces WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
    )
      .bind(nodeId)
      .all<{ resolvedReservationJson: string | null }>();
    expect(() => assertUsageWithinSmallNode(rows.results)).toThrow(/overcommit detected/);
  });
});

describe('native exclusive reservation admission', () => {
  it('rejects exclusive co-tenancy in final CAS while admitting an empty node', async () => {
    const nodeId = 'node-wrc-exclusive';
    await makeReadyNode(nodeId);
    const snapshot = await seedCurrentAuthorityForNode({
      nodeId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      label: 'exclusive',
    });
    const workspaceId = 'workspace-wrc-exclusive-occupant';
    await seedWorkspace(workspaceId, nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(reservation()),
    });
    const exclusive = reservation({ exclusiveNode: true, maxCoTenants: 1 });
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-exclusive-denied', nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: exclusive,
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);
    await env.DATABASE.prepare('UPDATE workspaces SET resolved_reservation_json = ? WHERE id = ?')
      .bind(JSON.stringify(exclusive), workspaceId)
      .run();
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-after-exclusive-denied', nodeId, {
          capacityPlacementSnapshot: snapshot,
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);
    await env.DATABASE.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = ?")
      .bind(workspaceId)
      .run();
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-exclusive-empty-allowed', nodeId, {
          capacityPlacementSnapshot: snapshot,
          resolvedReservation: exclusive,
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
  });
});
