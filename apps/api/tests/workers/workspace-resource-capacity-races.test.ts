import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
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
import type { WorkspaceAdmissionPolicy } from '../../src/services/workspace-resource-capacity';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

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
          resolvedReservation: reservationV2({ cpuMillis: 1000, memoryMb: 1024, diskMb: 1024 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-wrc-v2-overbook', nodeId, {
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
