/**
 * Deterministic D1 race tests for VM admission control.
 *
 * These exercise the production D1 statements that serialize cold-start
 * provisioning claims and preserve existing-node packing invariants. Provider
 * calls are not made; provider/account-capacity is tested at the typed error
 * classification boundary.
 */
import { ProviderError } from '@simple-agent-manager/providers';
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
import type { TaskStartCapacityPoolSelection } from '../../src/services/placement-resolver';
import {
  assertVmProvisioningLease,
  markVmProvisioningLeaseInflightNode,
  recordVmProviderCapacityFailure,
  releaseVmProvisioningLease,
  tryAcquireVmProvisioningLease,
  type VmTaskAdmissionIdentity,
  waitForVmAdmissionCapacity,
} from '../../src/services/vm-admission-control';
import {
  reserveWorkspacePlacement,
  type WorkspacePlacementInput,
} from '../../src/services/workspace-placement';
import type { WorkspaceAdmissionPolicy } from '../../src/services/workspace-resource-capacity';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const USER_ID = 'user-vm-admission-races';
const OTHER_USER_ID = 'user-vm-admission-races-other';
const INSTALLATION_ID = 'installation-vm-admission-races';
const PROJECT_ID = 'project-vm-admission-races';
/**
 * Separate project for capacity-pool cases. A default project pool is the
 * authoritative effective pool for its project, so a pooled fixture sharing
 * PROJECT_ID would (correctly) refuse every legacy unpooled placement in this
 * file's shared D1.
 */
const POOL_PROJECT_ID = 'project-vm-admission-races-pooled';
/** Same reasoning as POOL_PROJECT_ID, for user-scope pools. */
const POOL_USER_ID = 'user-vm-admission-races-pooled';
const PROVIDER_DOMAIN = 'hetzner:platform:hetzner:vm-admission-races';
const SCOPE_KEY = `user:${USER_ID}:workspace-vm:${PROVIDER_DOMAIN}`;

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedUser(OTHER_USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
  await seedProject(POOL_PROJECT_ID, USER_ID, INSTALLATION_ID, {
    repository: 'test-org/vm-admission-races-pooled',
  });
  await seedUser(POOL_USER_ID);
});

function admission(
  taskId: string,
  overrides: Partial<VmTaskAdmissionIdentity> = {}
): VmTaskAdmissionIdentity {
  return {
    taskId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    provider: 'hetzner',
    credentialSource: 'platform',
    credentialDomainKey: 'platform:hetzner:vm-admission-races',
    providerDomainKey: PROVIDER_DOMAIN,
    scopeKey: SCOPE_KEY,
    requestedVmSize: 'medium',
    requestedVmLocation: 'nbg1',
    preferredNodeId: null,
    ...overrides,
  };
}

async function seedQueuedTask(taskId: string, userId = USER_ID): Promise<void> {
  await seedTask(taskId, PROJECT_ID, userId, {
    status: 'queued',
    executionStep: 'node_provisioning',
  });
}

async function leaseRow(scopeKey = SCOPE_KEY): Promise<{
  owner_task_id: string;
  fencing_token: number;
  inflight_node_id: string | null;
} | null> {
  return env.DATABASE.prepare(
    `SELECT owner_task_id, fencing_token, inflight_node_id
     FROM vm_provisioning_leases
     WHERE scope_key = ?`
  )
    .bind(scopeKey)
    .first<{
      owner_task_id: string;
      fencing_token: number;
      inflight_node_id: string | null;
    }>();
}

function placement(
  workspaceId: string,
  nodeId: string,
  overrides: Partial<
    Pick<
      WorkspacePlacementInput,
      'projectId' | 'userId' | 'installationId' | 'repository' | 'vmSize' | 'vmLocation'
    > & { resolvedReservation?: ResolvedResourceReservation }
  > = {}
): WorkspacePlacementInput {
  return {
    id: workspaceId,
    nodeId,
    projectId: overrides.projectId ?? PROJECT_ID,
    userId: overrides.userId ?? USER_ID,
    installationId: overrides.installationId ?? INSTALLATION_ID,
    name: `Workspace ${workspaceId}`,
    displayName: `Workspace ${workspaceId}`,
    normalizedDisplayName: workspaceId,
    repository: overrides.repository ?? 'test-org/vm-admission-races',
    branch: 'main',
    vmSize: overrides.vmSize ?? 'medium',
    vmLocation: overrides.vmLocation ?? 'nbg1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    resolvedReservation: overrides.resolvedReservation,
    createdAt: new Date().toISOString(),
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

function taskState(
  userId: string,
  vmSize: 'small' | 'medium' | 'large',
  overrides: Partial<Pick<TaskRunnerState, 'projectId'>> & {
    installationId?: string;
    repository?: string;
    capacityPoolSelection?: TaskRunnerState['config']['capacityPoolSelection'];
    projectScaling?: TaskRunnerState['config']['projectScaling'];
    resolvedReservation?: ResolvedResourceReservation;
  } = {}
): TaskRunnerState {
  const now = Date.now();
  return {
    version: 1,
    taskId: `task-selector-${userId}-${vmSize}`,
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
    },
    config: {
      vmSize,
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'selector packing',
      taskDescription: null,
      repository: overrides.repository ?? 'test-org/vm-admission-races',
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
      projectScaling: overrides.projectScaling ?? { maxWorkspacesPerNode: 2 },
      resourceRequirements: null,
      resolvedReservation: overrides.resolvedReservation ?? null,
      capacityPoolSelection: overrides.capacityPoolSelection ?? null,
      vmSizeSource: null,
      resumeSnapshotChatSessionId: null,
      recoverySourceTaskId: null,
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

/** Fixed timestamp so credential/source generations are computable and stable. */
const AUTHORITY_TIMESTAMP = '2026-09-07 06:00:00.123';

function credentialIdForScope(scope: 'project' | 'user' | 'installation'): string {
  return `capacity-credential-${scope}`;
}

function credentialReferenceForScope(scope: 'project' | 'user' | 'installation'): string {
  return scope === 'installation'
    ? `platform_credentials:${credentialIdForScope(scope)}`
    : `credentials:${credentialIdForScope(scope)}`;
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

function capacitySnapshot(input: {
  poolId: string;
  sourceId: string;
  candidateId: string;
  scope: 'project' | 'user' | 'installation';
  projectId?: string | null;
}): CapacityPlacementSnapshot {
  return {
    capacityPoolId: input.poolId,
    capacityPoolScope: input.scope,
    capacityPoolRevision: 1,
    capacitySourceId: input.sourceId,
    capacityPoolCandidateId: input.candidateId,
    placementCredentialSource: input.scope === 'installation' ? 'platform' : input.scope,
    placementCredentialReference: credentialReferenceForScope(input.scope),
    placementCredentialVersion: 0,
    capacityPoolProjectId: input.scope === 'project' ? (input.projectId ?? PROJECT_ID) : null,
    workloadRole: 'workspace',
    placementExplanationJson: JSON.stringify({
      poolId: input.poolId,
      sourceId: input.sourceId,
      candidateId: input.candidateId,
    }),
  };
}

/**
 * Seed a COMPLETE, currently-valid authority chain for `snapshot`: the underlying
 * cloud-provider credential, an active cloud-provider-credential source, a matching
 * available candidate, and the pool as the CURRENT DEFAULT of its scope.
 *
 * Final admission verifies every one of those relationships in one statement, so a
 * fixture that seeds only pool+source rows cannot exercise the pooled path at all —
 * it models a pool with no candidates, which is correctly refused.
 */
async function seedCapacityRecords(
  snapshot: CapacityPlacementSnapshot,
  ownerUserId = USER_ID,
  node?: {
    provider: string;
    location: string;
    instanceType: string;
    vcpu: number;
    memoryMb: number;
    diskGb: number;
  }
): Promise<void> {
  if (!snapshot.capacityPoolId || !snapshot.capacityPoolScope || !snapshot.capacitySourceId) {
    throw new Error('snapshot must include pool and source IDs');
  }
  const scope = snapshot.capacityPoolScope;
  const ownerProjectId = scope === 'project' ? snapshot.capacityPoolProjectId : null;
  const poolOwnerUserId = scope === 'user' ? ownerUserId : null;
  const credentialId = credentialIdForScope(scope);
  const version = await sqliteTimestampVersion(AUTHORITY_TIMESTAMP);
  const hardware = node ?? {
    provider: 'hetzner',
    location: 'nbg1',
    instanceType: 'test-large',
    vcpu: 8,
    memoryMb: 16_384,
    diskGb: 160,
  };

  if (scope === 'installation') {
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO platform_credentials
         (id, credential_type, provider, credential_kind, label, encrypted_token, iv,
          is_enabled, created_by, created_at, updated_at)
       VALUES (?, 'cloud-provider', ?, 'api-key', 'Capacity platform credential',
          'encrypted-token', 'iv', 1, ?, ?, ?)`
    )
      .bind(credentialId, hardware.provider, ownerUserId, AUTHORITY_TIMESTAMP, AUTHORITY_TIMESTAMP)
      .run();
  } else {
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO credentials
         (id, user_id, project_id, provider, credential_type, credential_kind, is_active,
          encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'cloud-provider', 'api-key', 1, 'encrypted-token', 'iv', ?, ?)`
    )
      .bind(
        credentialId,
        ownerUserId,
        scope === 'project' ? ownerProjectId : null,
        hardware.provider,
        AUTHORITY_TIMESTAMP,
        AUTHORITY_TIMESTAMP
      )
      .run();
  }

  // Exactly one default pool may exist per scope owner (unique index), and the
  // effective-pool fence requires the claimed pool to BE that default. Retire any
  // previous default for this scope owner before publishing the new one.
  await env.DATABASE.prepare(
    `UPDATE capacity_pools
        SET is_default = 0
      WHERE scope = ?
        AND owner_user_id IS ?
        AND owner_project_id IS ?
        AND id != ?`
  )
    .bind(scope, poolOwnerUserId, ownerProjectId, snapshot.capacityPoolId)
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_pools
       (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
        configuration_state, strategy, exhaustion_policy, migration_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'active', 'configured-ready', 'balanced', 'queue', 'complete', ?, ?)`
  )
    .bind(
      snapshot.capacityPoolId,
      scope,
      poolOwnerUserId,
      ownerProjectId,
      `Pool ${snapshot.capacityPoolId}`,
      snapshot.capacityPoolRevision ?? 1,
      AUTHORITY_TIMESTAMP,
      AUTHORITY_TIMESTAMP
    )
    .run();
  await env.DATABASE.prepare(`UPDATE capacity_pools SET is_default = 1 WHERE id = ?`)
    .bind(snapshot.capacityPoolId)
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_sources
       (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
        credential_id, platform_credential_id, credential_reference, credential_version,
        external_source_ref, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'cloud-provider-credential', ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`
  )
    .bind(
      snapshot.capacitySourceId,
      scope,
      poolOwnerUserId,
      ownerProjectId,
      hardware.provider,
      snapshot.placementCredentialSource,
      scope === 'installation' ? null : credentialId,
      scope === 'installation' ? credentialId : null,
      credentialReferenceForScope(scope),
      version,
      AUTHORITY_TIMESTAMP,
      AUTHORITY_TIMESTAMP
    )
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_pool_candidates
       (id, pool_id, capacity_source_id, provider, location, workload_role,
        provider_instance_type, provider_instance_vcpu_count, provider_instance_memory_mb,
        provider_instance_disk_gb, provider_instance_boot_disk_size_gb, provider_instance_image,
        provider_instance_architecture, catalog_availability, status, priority, candidate_order,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, NULL, NULL, NULL, 'available', 'active', 0, 0, ?, ?)`
  )
    .bind(
      snapshot.capacityPoolCandidateId,
      snapshot.capacityPoolId,
      snapshot.capacitySourceId,
      hardware.provider,
      hardware.location,
      hardware.instanceType,
      hardware.vcpu,
      hardware.memoryMb,
      hardware.diskGb,
      AUTHORITY_TIMESTAMP,
      AUTHORITY_TIMESTAMP
    )
    .run();
}

/**
 * Bind a node to `snapshot` and seed the matching authority chain. The node's own
 * provider-native identity is used as the candidate's, because final admission
 * compares candidate offering against the node columns.
 *
 * Mutates `snapshot` in place with the resolved credential/source generation so
 * callers pass the same object to reserveWorkspacePlacement.
 */
async function assignNodeCapacity(
  nodeId: string,
  snapshot: CapacityPlacementSnapshot
): Promise<void> {
  const nodeRow = await env.DATABASE.prepare(
    `SELECT user_id AS userId, cloud_provider AS provider, vm_location AS location,
            provider_instance_type AS instanceType,
            observed_provider_instance_vcpu_count AS vcpu,
            observed_provider_instance_memory_mb AS memoryMb,
            observed_provider_instance_disk_gb AS diskGb
       FROM nodes WHERE id = ?`
  )
    .bind(nodeId)
    .first<{
      userId: string;
      provider: string | null;
      location: string;
      instanceType: string | null;
      vcpu: number | null;
      memoryMb: number | null;
      diskGb: number | null;
    }>();
  if (!nodeRow?.provider || !nodeRow.instanceType || nodeRow.vcpu === null) {
    throw new Error(`node ${nodeId} must be provisioned before capacity assignment`);
  }

  const version = await sqliteTimestampVersion(AUTHORITY_TIMESTAMP);
  snapshot.capacitySourceGeneration = version;
  snapshot.placementCredentialVersion = version;
  snapshot.providerInstanceType = nodeRow.instanceType;
  snapshot.providerInstanceVcpuCount = nodeRow.vcpu;
  snapshot.providerInstanceMemoryMb = nodeRow.memoryMb;
  snapshot.providerInstanceDiskGb = nodeRow.diskGb;

  // The pool must be owned by the node's own user: a user-scope pool is matched
  // with `p.owner_user_id = n.user_id`, and owning it with a different user would
  // both break this node's authority and make that other user's legacy nodes
  // undrainable in the shared D1.
  await seedCapacityRecords(snapshot, nodeRow.userId, {
    provider: nodeRow.provider,
    location: nodeRow.location,
    instanceType: nodeRow.instanceType,
    vcpu: nodeRow.vcpu,
    memoryMb: nodeRow.memoryMb ?? 0,
    diskGb: nodeRow.diskGb ?? 0,
  });

  await env.DATABASE.prepare(
    `UPDATE nodes
     SET capacity_pool_id = ?,
         capacity_pool_scope = ?,
         capacity_pool_revision = ?,
         capacity_source_id = ?,
         capacity_source_generation = ?,
         capacity_source_external_ref = NULL,
         capacity_pool_candidate_id = ?,
         placement_credential_source = ?,
         placement_credential_reference = ?,
         placement_credential_version = ?,
         capacity_pool_project_id = ?,
         workload_role = ?,
         placement_explanation_json = ?
     WHERE id = ?`
  )
    .bind(
      snapshot.capacityPoolId,
      snapshot.capacityPoolScope,
      snapshot.capacityPoolRevision,
      snapshot.capacitySourceId,
      version,
      snapshot.capacityPoolCandidateId,
      snapshot.placementCredentialSource,
      snapshot.placementCredentialReference,
      version,
      snapshot.capacityPoolProjectId,
      snapshot.workloadRole,
      snapshot.placementExplanationJson,
      nodeId
    )
    .run();
}

function selectorContext(): TaskRunnerContext {
  return {
    env: {
      DATABASE: env.DATABASE,
      MAX_WORKSPACES_PER_NODE: '2',
      TASK_RUN_NODE_CPU_THRESHOLD_PERCENT: '90',
      TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT: '90',
      VM_AGENT_REQUIRED_VERSION: 'current-sha',
    },
  } as unknown as TaskRunnerContext;
}

async function makeReadyNode(
  nodeId: string,
  userId: string,
  vmSize: 'small' | 'medium' | 'large',
  opts: { nodeClass?: 'managed' | 'user-owned' } = {}
): Promise<void> {
  const now = new Date().toISOString();
  const capacity =
    vmSize === 'large'
      ? { vcpu: 8, memoryMb: 16384, diskGb: 160 }
      : vmSize === 'medium'
        ? { vcpu: 4, memoryMb: 8192, diskGb: 80 }
        : { vcpu: 2, memoryMb: 4096, diskGb: 40 };
  await seedNode(nodeId, userId, {
    vmSize,
    vmLocation: 'nbg1',
    status: 'running',
    nodeClass: opts.nodeClass ?? 'managed',
  });
  // A provisioned node has a provider runtime identity AND provider-observed
  // hardware. Both advisory selection and the final admission SQL derive usable
  // capacity from the observed columns only, so a fixture that sets just the
  // planned columns models a node with no trusted capacity and is refused.
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET health_status = 'healthy',
       last_heartbeat_at = ?,
       agent_ready_at = ?,
       agent_version = 'current-sha',
       runtime = 'vm',
       node_role = 'workspace',
       workload_role = 'workspace',
       cloud_provider = 'hetzner',
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
      now,
      JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 10 }),
      `server-${nodeId}`,
      `test-${vmSize}`,
      capacity.vcpu,
      capacity.memoryMb,
      capacity.diskGb,
      `test-${vmSize}`,
      capacity.vcpu,
      capacity.memoryMb,
      capacity.diskGb,
      nodeId
    )
    .run();
}

describe('VM admission control D1 races', () => {
  it('serializes simultaneous cold-start provisioning claims for one user/provider scope', async () => {
    const taskIds = Array.from({ length: 8 }, (_, i) => `task-vm-admission-fanout-${i}`);
    await Promise.all(taskIds.map((taskId) => seedQueuedTask(taskId)));

    const outcomes = await Promise.all(
      taskIds.map((taskId) => tryAcquireVmProvisioningLease(env, admission(taskId)))
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'granted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'waiting')).toHaveLength(
      taskIds.length - 1
    );
    expect(await leaseRow()).toMatchObject({ fencing_token: 1 });

    const waitingRows = await env.DATABASE.prepare(
      `SELECT COUNT(*) AS c
       FROM vm_task_admissions
       WHERE scope_key = ? AND state = 'waiting'`
    )
      .bind(SCOPE_KEY)
      .first<{ c: number }>();
    expect(waitingRows?.c).toBe(taskIds.length - 1);
  });

  it('shares one provisioning lease across mixed requests then packs them onto one native host', async () => {
    const userId = 'mixed-request-burst-user';
    await seedUser(userId);
    const scopeKey = `${SCOPE_KEY}:mixed-requests`;
    const providerDomainKey = `${PROVIDER_DOMAIN}:mixed-requests`;
    const requests = (['small', 'medium', 'large'] as const).map((vmSize, index) => ({
      taskId: `mixed-request-burst-${index}`,
      vmSize,
      reservation: reservation({ cpuMillis: 1000 + index * 500, memoryMb: 1024 + index * 512 }),
    }));
    await Promise.all(requests.map((request) => seedQueuedTask(request.taskId, userId)));
    const claims = await Promise.all(
      requests.map((request) =>
        tryAcquireVmProvisioningLease(
          env,
          admission(request.taskId, {
            userId,
            scopeKey,
            providerDomainKey,
            requestedVmSize: request.vmSize,
          })
        )
      )
    );
    expect(claims.filter((claim) => claim.kind === 'granted')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'waiting')).toHaveLength(2);
    // Model the one paid provisioner returning a concrete host. Different legacy
    // labels must not make the waiting requests start another VM when it fits.
    const nodeId = 'mixed-request-burst-native-host';
    await makeReadyNode(nodeId, userId, 'large');
    await env.DATABASE.prepare(
      `UPDATE nodes SET vm_size = 'small',
      provider_instance_type = 'arbitrary-native-sku', observed_provider_instance_type = 'arbitrary-native-sku'
      WHERE id = ?`
    )
      .bind(nodeId)
      .run();
    for (const [index, request] of requests.entries()) {
      const state = taskState(userId, request.vmSize, {
        resolvedReservation: request.reservation,
        projectScaling: { maxWorkspacesPerNode: 4 },
      });
      const selected = await findNodeWithCapacity(state, selectorContext());
      expect(selected?.nodeId).toBe(nodeId);
      expect(
        await reserveWorkspacePlacement(
          env.DATABASE,
          placement(`mixed-request-workspace-${index}`, nodeId, {
            userId,
            vmSize: request.vmSize,
            resolvedReservation: request.reservation,
          }),
          admissionPolicy()
        )
      ).toBe(true);
    }
    const count = await env.DATABASE.prepare(
      'SELECT COUNT(DISTINCT node_id) AS hosts, COUNT(*) AS workspaces FROM workspaces WHERE user_id = ?'
    )
      .bind(userId)
      .first<{ hosts: number; workspaces: number }>();
    expect(count).toEqual({ hosts: 1, workspaces: 3 });
  });

  it('fences lease expiry recovery and rejects stale owners', async () => {
    const scopeKey = `${SCOPE_KEY}:expiry`;
    const providerDomainKey = `${PROVIDER_DOMAIN}:expiry`;
    const taskA = 'task-vm-admission-expiry-a';
    const taskB = 'task-vm-admission-expiry-b';
    const nodeId = 'node-vm-admission-expiry-live';
    await seedQueuedTask(taskA);
    await seedQueuedTask(taskB);
    await seedNode(nodeId, USER_ID, { status: 'creating' });

    const firstGrant = await tryAcquireVmProvisioningLease(
      env,
      admission(taskA, { scopeKey, providerDomainKey })
    );
    expect(firstGrant.kind).toBe('granted');
    if (firstGrant.kind !== 'granted') throw new Error('expected first grant');
    expect(
      await markVmProvisioningLeaseInflightNode(
        env,
        scopeKey,
        taskA,
        firstGrant.fencingToken,
        nodeId
      )
    ).toBe(true);

    await env.DATABASE.prepare(
      `UPDATE vm_provisioning_leases SET expires_at = ? WHERE scope_key = ?`
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), scopeKey)
      .run();

    const liveInflightAttempt = await tryAcquireVmProvisioningLease(
      env,
      admission(taskB, { scopeKey, providerDomainKey })
    );
    expect(liveInflightAttempt.kind).toBe('waiting');
    expect(await leaseRow(scopeKey)).toMatchObject({
      owner_task_id: taskA,
      fencing_token: firstGrant.fencingToken,
      inflight_node_id: nodeId,
    });

    await env.DATABASE.prepare(`UPDATE nodes SET status = 'deleted' WHERE id = ?`)
      .bind(nodeId)
      .run();
    await env.DATABASE.prepare(
      `UPDATE vm_provisioning_leases SET expires_at = ? WHERE scope_key = ?`
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), scopeKey)
      .run();

    const recovered = await tryAcquireVmProvisioningLease(
      env,
      admission(taskB, { scopeKey, providerDomainKey })
    );
    expect(recovered.kind).toBe('granted');
    if (recovered.kind !== 'granted') throw new Error('expected recovered grant');
    expect(recovered.fencingToken).toBeGreaterThan(firstGrant.fencingToken);
    await expect(
      assertVmProvisioningLease(env, scopeKey, taskA, firstGrant.fencingToken)
    ).rejects.toThrow('VM provisioning lease lost');
    expect(await releaseVmProvisioningLease(env, scopeKey, taskA, firstGrant.fencingToken)).toBe(
      false
    );
    expect(await leaseRow(scopeKey)).toMatchObject({
      owner_task_id: taskB,
      fencing_token: recovered.fencingToken,
    });
  });

  it('records Hetzner server limits as provider-account capacity and queues retry', async () => {
    const scopeKey = `${SCOPE_KEY}:server-limit`;
    const providerDomainKey = `${PROVIDER_DOMAIN}:server-limit`;
    const taskA = 'task-vm-admission-server-limit-a';
    const taskB = 'task-vm-admission-server-limit-b';
    await seedQueuedTask(taskA);
    await seedQueuedTask(taskB);
    const taskAAdmission = admission(taskA, { scopeKey, providerDomainKey });
    const grant = await tryAcquireVmProvisioningLease(env, taskAAdmission);
    expect(grant.kind).toBe('granted');
    if (grant.kind !== 'granted') throw new Error('expected grant');

    const providerInfo = await recordVmProviderCapacityFailure(env, {
      scope: taskAAdmission,
      error: new ProviderError('hetzner', 403, 'server_limit_exceeded: server limit reached', {
        providerCode: 'server_limit_exceeded',
        category: 'quota_exceeded',
      }),
    });
    expect(providerInfo).toMatchObject({
      providerCode: 'server_limit_exceeded',
      providerStatusCode: 403,
    });
    await releaseVmProvisioningLease(env, scopeKey, taskA, grant.fencingToken);

    const queued = await tryAcquireVmProvisioningLease(
      env,
      admission(taskB, { scopeKey, providerDomainKey })
    );
    expect(queued.kind).toBe('waiting');
    if (queued.kind !== 'waiting') throw new Error('expected provider-capacity wait');
    expect(queued.reason).toBe('provider_account_capacity');

    const taskMirror = await env.DATABASE.prepare(
      `SELECT execution_step, admission_state, admission_reason
       FROM tasks
       WHERE id = ?`
    )
      .bind(taskB)
      .first<{
        execution_step: string | null;
        admission_state: string | null;
        admission_reason: string | null;
      }>();
    expect(taskMirror).toEqual({
      execution_step: 'waiting_for_node_capacity',
      admission_state: 'waiting',
      admission_reason: 'provider_account_capacity',
    });
  });

  it('preserves existing-node packing with same-user isolation and VM-size compatibility', async () => {
    const mediumNode = 'node-vm-admission-medium';
    const largeNode = 'node-vm-admission-large';
    const otherUserNode = 'node-vm-admission-other-user-large';
    await makeReadyNode(mediumNode, USER_ID, 'medium');
    await makeReadyNode(largeNode, USER_ID, 'large');
    await makeReadyNode(otherUserNode, OTHER_USER_ID, 'large');
    await seedWorkspace('workspace-vm-admission-large-occupant', largeNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
    });

    const rc = selectorContext();
    expect((await findNodeWithCapacity(taskState(USER_ID, 'large'), rc))?.nodeId).toBe(largeNode);
    expect((await findNodeWithCapacity(taskState(OTHER_USER_ID, 'large'), rc))?.nodeId).toBe(
      otherUserNode
    );

    // Explicit policy with no host memory reserve: this case is about packing,
    // same-user isolation and size compatibility. The 512 MB default reserve is
    // exercised by the dedicated host-reserve test, and applying it here would
    // make an 8 GB medium node refuse its second 4 GB workspace for an unrelated
    // reason.
    const packingPolicy = admissionPolicy({ maxWorkspaces: 2 });
    const firstPlacement = await reserveWorkspacePlacement(
      env.DATABASE,
      placement('workspace-vm-admission-medium-first', mediumNode),
      packingPolicy
    );
    expect(firstPlacement).toBe(true);
    const mediumPlacement = await reserveWorkspacePlacement(
      env.DATABASE,
      placement('workspace-vm-admission-medium-second', mediumNode),
      packingPolicy
    );
    expect(mediumPlacement).toBe(true);
    expect((await findNodeWithCapacity(taskState(USER_ID, 'medium'), rc))?.nodeId).toBe(largeNode);
    expect((await findNodeWithCapacity(taskState(USER_ID, 'large'), rc))?.nodeId).toBe(largeNode);
  });

  it('normalizes load average by vCPU count during advisory selection', async () => {
    const userId = 'user-vm-admission-normalized-load';
    const installationId = 'installation-vm-admission-normalized-load';
    const projectId = 'project-vm-admission-normalized-load';
    const smallBusyNode = 'node-vm-admission-normalized-load-small';
    const largeAvailableNode = 'node-vm-admission-normalized-load-large';
    await seedUser(userId);
    await seedInstallation(installationId, userId);
    await seedProject(projectId, userId, installationId);
    await makeReadyNode(smallBusyNode, userId, 'small');
    await makeReadyNode(largeAvailableNode, userId, 'large');
    await env.DATABASE.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = ?`)
      .bind(JSON.stringify({ cpuLoadAvg1: 1.5, memoryPercent: 10, diskPercent: 10 }), smallBusyNode)
      .run();
    await env.DATABASE.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = ?`)
      .bind(
        JSON.stringify({ cpuLoadAvg1: 1.5, memoryPercent: 10, diskPercent: 10 }),
        largeAvailableNode
      )
      .run();

    const rc = selectorContext();
    const selected = await findNodeWithCapacity(
      taskState(userId, 'small', {
        projectId,
        installationId,
        projectScaling: {
          maxWorkspacesPerNode: 2,
          nodeCpuThresholdPercent: 70,
          nodeMemoryThresholdPercent: 90,
        },
        resolvedReservation: reservation(),
      }),
      rc
    );

    expect(selected?.nodeId).toBe(largeAvailableNode);
  });

  it('vetoes high disk pressure during advisory existing-node selection', async () => {
    const userId = 'user-vm-admission-selection-disk';
    const installationId = 'installation-vm-admission-selection-disk';
    const projectId = 'project-vm-admission-selection-disk';
    const pressureNode = 'node-vm-admission-selection-disk-pressure';
    const availableNode = 'node-vm-admission-selection-disk-available';
    await seedUser(userId);
    await seedInstallation(installationId, userId);
    await seedProject(projectId, userId, installationId);
    await makeReadyNode(pressureNode, userId, 'medium');
    await makeReadyNode(availableNode, userId, 'medium');
    await env.DATABASE.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = ?`)
      .bind(JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 95 }), pressureNode)
      .run();

    const rc = selectorContext();
    const selected = await findNodeWithCapacity(
      taskState(userId, 'medium', {
        projectId,
        installationId,
        resolvedReservation: reservation(),
      }),
      rc
    );

    expect(selected?.nodeId).toBe(availableNode);
  });

  it('preserves same-user cross-project packing on user-scope workspace nodes', async () => {
    const userId = 'user-vm-admission-cross-project';
    const installationId = 'installation-vm-admission-cross-project';
    const firstProjectId = 'project-vm-admission-cross-project-first';
    const secondProjectId = 'project-vm-admission-cross-project-second';
    const firstRepository = 'test-org/vm-admission-cross-project-first';
    const secondRepository = 'test-org/vm-admission-cross-project-second';
    const crossProjectNode = 'node-vm-admission-cross-project-user-scope';
    await seedUser(userId);
    await seedInstallation(installationId, userId, {
      installationIdValue: 'inst-vm-admission-cross-project',
      accountName: 'vm-admission-cross-project',
    });
    await seedProject(firstProjectId, userId, installationId, { repository: firstRepository });
    await seedProject(secondProjectId, userId, installationId, { repository: secondRepository });
    // Today there is no project-pool discriminator on reusable workspace nodes:
    // `nodes.user_id` is the effective user-scope boundary.
    await makeReadyNode(crossProjectNode, userId, 'medium');
    await seedWorkspace('workspace-vm-admission-cross-project-first', crossProjectNode, userId, {
      projectId: firstProjectId,
      status: 'running',
    });

    // Exercise the user-scope capacity-pool path across projects: the node and
    // both reservations share one user-scope pool, and cross-project reuse must
    // still pack onto the same node.
    const snapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-cross-project-user',
      sourceId: 'source-vm-admission-cross-project-user',
      candidateId: 'candidate-vm-admission-cross-project-user',
      scope: 'user',
    });
    await assignNodeCapacity(crossProjectNode, snapshot);

    const selection: TaskStartCapacityPoolSelection = {
      poolId: snapshot.capacityPoolId,
      scope: 'user',
      revision: 1,
      strategy: 'balanced',
      capacityPoolProjectId: null,
      workloadRole: 'workspace',
      poolSnapshot: snapshot,
      candidates: [
        {
          id: snapshot.capacityPoolCandidateId,
          poolId: snapshot.capacityPoolId,
          capacitySourceId: snapshot.capacitySourceId,
          provider: 'hetzner',
          location: 'nbg1',
          workloadRole: 'workspace',
          runtime: 'vm',
          machineClass: 'shared-vm',
          machineSize: 'medium',
          // The node carries a concrete provider-native offering, so the candidate
          // must name the same one — legacy machineSize matching only applies to
          // nodes with no provider_instance_type.
          providerInstanceType: snapshot.providerInstanceType,
          providerInstanceVcpuCount: snapshot.providerInstanceVcpuCount,
          providerInstanceMemoryMb: snapshot.providerInstanceMemoryMb,
          providerInstanceDiskGb: snapshot.providerInstanceDiskGb,
          priority: 1,
          candidateOrder: 0,
          credentialAttributionSource: 'user',
          placementCredentialSource: 'user',
          placementCredentialReference: snapshot.placementCredentialReference,
          // Resolved by assignNodeCapacity from the seeded credential's timestamp;
          // a literal here would not match the node's persisted authority.
          placementCredentialVersion: snapshot.placementCredentialVersion,
          capacityPoolProjectId: null,
          snapshot,
        },
      ],
    };

    const rc = selectorContext();
    const selectedForSecondProject = await findNodeWithCapacity(
      taskState(userId, 'medium', {
        projectId: secondProjectId,
        installationId,
        repository: secondRepository,
        capacityPoolSelection: selection,
      }),
      rc
    );

    expect(selectedForSecondProject?.nodeId).toBe(crossProjectNode);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement('workspace-vm-admission-cross-project-second', crossProjectNode, {
            projectId: secondProjectId,
            userId,
            installationId,
            repository: secondRepository,
          }),
          capacityPlacementSnapshot: snapshot,
        },
        2
      )
    ).resolves.toBe(true);

    const packedProjects = await env.DATABASE.prepare(
      `SELECT project_id
       FROM workspaces
       WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')
       ORDER BY project_id`
    )
      .bind(crossProjectNode)
      .all<{ project_id: string | null }>();
    expect(packedProjects.results.map((row) => row.project_id)).toEqual([
      firstProjectId,
      secondProjectId,
    ]);
  });

  it('persists capacity snapshots during final workspace reservation', async () => {
    const nodeId = 'node-vm-admission-capacity-snapshot';
    const workspaceId = 'workspace-vm-admission-capacity-snapshot';
    const snapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-project',
      sourceId: 'source-vm-admission-project',
      candidateId: 'candidate-vm-admission-project',
      scope: 'project',
      projectId: POOL_PROJECT_ID,
    });
    await makeReadyNode(nodeId, USER_ID, 'large');
    await assignNodeCapacity(nodeId, snapshot);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement(workspaceId, nodeId, { vmSize: 'large', projectId: POOL_PROJECT_ID }),
          capacityPlacementSnapshot: snapshot,
        },
        2
      )
    ).resolves.toBe(true);

    const row = await env.DATABASE.prepare(
      `SELECT capacity_pool_id, capacity_pool_scope, capacity_source_id,
              capacity_pool_candidate_id, capacity_pool_project_id, workload_role,
              placement_explanation_json
       FROM workspaces
       WHERE id = ?`
    )
      .bind(workspaceId)
      .first<{
        capacity_pool_id: string | null;
        capacity_pool_scope: string | null;
        capacity_source_id: string | null;
        capacity_pool_candidate_id: string | null;
        capacity_pool_project_id: string | null;
        workload_role: string | null;
        placement_explanation_json: string | null;
      }>();

    expect(row).toMatchObject({
      capacity_pool_id: snapshot.capacityPoolId,
      capacity_pool_scope: 'project',
      capacity_source_id: snapshot.capacitySourceId,
      capacity_pool_candidate_id: snapshot.capacityPoolCandidateId,
      capacity_pool_project_id: POOL_PROJECT_ID,
      workload_role: 'workspace',
      placement_explanation_json: snapshot.placementExplanationJson,
    });
  });

  it('handles source-less capacity pool snapshots without SQL truthiness binds', async () => {
    const userLegacyNodeId = 'node-vm-admission-source-less-user';
    const projectLegacyNodeId = 'node-vm-admission-source-less-project';
    await makeReadyNode(userLegacyNodeId, POOL_USER_ID, 'medium');
    await makeReadyNode(projectLegacyNodeId, USER_ID, 'medium');

    const userBaseSnapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-source-less-user',
      sourceId: 'source-vm-admission-source-less-user',
      candidateId: 'candidate-vm-admission-source-less-user',
      scope: 'user',
    });
    const projectBaseSnapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-source-less-project',
      sourceId: 'source-vm-admission-source-less-project',
      candidateId: 'candidate-vm-admission-source-less-project',
      scope: 'project',
      projectId: POOL_PROJECT_ID,
    });
    await seedCapacityRecords(userBaseSnapshot, POOL_USER_ID);
    await seedCapacityRecords(projectBaseSnapshot);

    const sourceLessUserSnapshot: CapacityPlacementSnapshot = {
      ...userBaseSnapshot,
      capacitySourceId: null,
      capacityPoolCandidateId: null,
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
    };
    const sourceLessProjectSnapshot: CapacityPlacementSnapshot = {
      ...projectBaseSnapshot,
      capacitySourceId: null,
      capacityPoolCandidateId: null,
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
    };

    // A snapshot that names a pool but carries no source or candidate cannot be
    // verified against anything current, so it is refused at BOTH scopes. It must
    // be refused cleanly — SQLite treats a NULL bind in an `= ?` comparison as
    // unknown rather than false, so the guard has to be structural, not truthiness.
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement('workspace-vm-admission-source-less-user', userLegacyNodeId, {
            userId: POOL_USER_ID,
          }),
          capacityPlacementSnapshot: sourceLessUserSnapshot,
        },
        2
      )
    ).resolves.toBe(false);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement('workspace-vm-admission-source-less-project', projectLegacyNodeId, {
            projectId: POOL_PROJECT_ID,
          }),
          capacityPlacementSnapshot: sourceLessProjectSnapshot,
        },
        2
      )
    ).resolves.toBe(false);

    const userWorkspace = await env.DATABASE.prepare(`SELECT id FROM workspaces WHERE id = ?`)
      .bind('workspace-vm-admission-source-less-user')
      .first<{ id: string }>();
    expect(userWorkspace).toBeNull();

    const projectWorkspace = await env.DATABASE.prepare(`SELECT id FROM workspaces WHERE id = ?`)
      .bind('workspace-vm-admission-source-less-project')
      .first<{ id: string }>();
    expect(projectWorkspace).toBeNull();
  });

  it('rejects final reservation when the selected project pool does not match the node', async () => {
    const nodeId = 'node-vm-admission-project-pool-mismatch';
    const nodeSnapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-project-owned',
      sourceId: 'source-vm-admission-project-owned',
      candidateId: 'candidate-vm-admission-project-owned',
      scope: 'project',
      projectId: POOL_PROJECT_ID,
    });
    const otherSnapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-project-other',
      sourceId: 'source-vm-admission-project-other',
      candidateId: 'candidate-vm-admission-project-other',
      scope: 'project',
      projectId: 'project-vm-admission-other-pool',
    });
    await seedProject('project-vm-admission-other-pool', USER_ID, INSTALLATION_ID, {
      repository: 'test-org/vm-admission-other-pool',
    });
    await makeReadyNode(nodeId, USER_ID, 'large');
    await assignNodeCapacity(nodeId, nodeSnapshot);
    await seedCapacityRecords(otherSnapshot);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement('workspace-vm-admission-project-pool-mismatch', nodeId, {
            vmSize: 'large',
          }),
          capacityPlacementSnapshot: otherSnapshot,
        },
        2
      )
    ).resolves.toBe(false);
  });

  it('rejects final reservation on project-pool nodes without a selected pool snapshot', async () => {
    const nodeId = 'node-vm-admission-project-pool-no-snapshot';
    const nodeSnapshot = capacitySnapshot({
      poolId: 'pool-vm-admission-project-no-snapshot',
      sourceId: 'source-vm-admission-project-no-snapshot',
      candidateId: 'candidate-vm-admission-project-no-snapshot',
      scope: 'project',
      projectId: POOL_PROJECT_ID,
    });
    await makeReadyNode(nodeId, USER_ID, 'large');
    await assignNodeCapacity(nodeId, nodeSnapshot);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-project-pool-no-snapshot', nodeId, {
          vmSize: 'large',
        }),
        2
      )
    ).resolves.toBe(false);
  });

  it('prevents different users from selecting or reserving the same workspace node', async () => {
    const ownerUserId = 'user-vm-admission-share-owner';
    const otherUserId = 'user-vm-admission-share-other';
    const ownerInstallationId = 'installation-vm-admission-share-owner';
    const otherInstallationId = 'installation-vm-admission-share-other';
    const ownerProjectId = 'project-vm-admission-share-owner';
    const otherProjectId = 'project-vm-admission-share-other';
    const otherRepository = 'test-org/vm-admission-share-other';
    const ownerNode = 'node-vm-admission-share-owner';
    await seedUser(ownerUserId);
    await seedUser(otherUserId);
    await seedInstallation(ownerInstallationId, ownerUserId, {
      installationIdValue: 'inst-vm-admission-share-owner',
      accountName: 'vm-admission-share-owner',
    });
    await seedInstallation(otherInstallationId, otherUserId, {
      installationIdValue: 'inst-vm-admission-share-other',
      accountName: 'vm-admission-share-other',
    });
    await seedProject(ownerProjectId, ownerUserId, ownerInstallationId);
    await seedProject(otherProjectId, otherUserId, otherInstallationId, {
      repository: otherRepository,
    });
    await makeReadyNode(ownerNode, ownerUserId, 'medium', { nodeClass: 'user-owned' });
    await seedWorkspace('workspace-vm-admission-share-owner', ownerNode, ownerUserId, {
      projectId: ownerProjectId,
      status: 'running',
    });

    const rc = selectorContext();

    expect(
      await findNodeWithCapacity(
        taskState(otherUserId, 'medium', { projectId: otherProjectId }),
        rc
      )
    ).toBeNull();
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-share-other', ownerNode, {
          projectId: otherProjectId,
          userId: otherUserId,
          installationId: otherInstallationId,
          repository: otherRepository,
        }),
        2
      )
    ).resolves.toBe(false);
  });

  it('atomically grants only one final reservation for the last workspace slot', async () => {
    const nodeId = 'node-vm-admission-last-slot';
    await makeReadyNode(nodeId, USER_ID, 'medium');

    const outcomes = await Promise.all([
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-last-slot-a', nodeId),
        1
      ),
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-last-slot-b', nodeId),
        1
      ),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const count = await env.DATABASE.prepare(
      `SELECT COUNT(*) AS c
       FROM workspaces
       WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
    )
      .bind(nodeId)
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it('atomically admits only reservations that fit the remaining CPU-share budget', async () => {
    const nodeId = 'node-vm-admission-cpu-share-budget';
    await makeReadyNode(nodeId, USER_ID, 'medium');
    await seedWorkspace('workspace-vm-admission-cpu-share-active', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(reservation({ cpuMillis: 3000 })),
    });

    const outcomes = await Promise.all([
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-cpu-share-small', nodeId, {
          resolvedReservation: reservation({ cpuMillis: 1000 }),
        }),
        admissionPolicy({ cpuShareBudgetPercent: 100 })
      ),
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-cpu-share-large', nodeId, {
          resolvedReservation: reservation({ cpuMillis: 1500 }),
        }),
        admissionPolicy({ cpuShareBudgetPercent: 100 })
      ),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const usage = await env.DATABASE.prepare(
      `SELECT SUM(CAST(json_extract(resolved_reservation_json, '$.cpuMillis') AS INTEGER)) AS cpuMillis
       FROM workspaces
       WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
    )
      .bind(nodeId)
      .first<{ cpuMillis: number }>();
    expect(usage?.cpuMillis).toBeLessThanOrEqual(4000);
  });

  it('applies host memory reserve before admitting occupied-node co-tenancy', async () => {
    const nodeId = 'node-vm-admission-host-headroom';
    await makeReadyNode(nodeId, USER_ID, 'medium');
    await seedWorkspace('workspace-vm-admission-host-headroom-active', nodeId, USER_ID, {
      projectId: PROJECT_ID,
      status: 'running',
      resolvedReservationJson: JSON.stringify(reservation({ memoryMb: 6000 })),
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-host-headroom-denied', nodeId, {
          resolvedReservation: reservation({ memoryMb: 2048 }),
        }),
        admissionPolicy({ hostMemoryReserveMb: 512 })
      )
    ).resolves.toBe(false);
  });

  it('vetoes final placement when fresh disk telemetry reports pressure', async () => {
    const nodeId = 'node-vm-admission-disk-pressure';
    await makeReadyNode(nodeId, USER_ID, 'medium');
    await env.DATABASE.prepare(`UPDATE nodes SET last_metrics = ? WHERE id = ?`)
      .bind(JSON.stringify({ cpuLoadAvg1: 0.2, memoryPercent: 10, diskPercent: 95 }), nodeId)
      .run();

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-disk-pressure-denied', nodeId, {
          resolvedReservation: reservation(),
        }),
        admissionPolicy({ diskPressureThresholdPercent: 90 })
      )
    ).resolves.toBe(false);
  });

  it('fails closed on malformed occupied reservations but preserves empty unknown-capacity placement', async () => {
    const occupiedNode = 'node-vm-admission-invalid-reservation-occupied';
    const emptyUnknownNode = 'node-vm-admission-unknown-empty';
    await makeReadyNode(occupiedNode, USER_ID, 'medium');
    await seedWorkspace(
      'workspace-vm-admission-invalid-reservation-active',
      occupiedNode,
      USER_ID,
      {
        projectId: PROJECT_ID,
        status: 'running',
        resolvedReservationJson: '{"cpuMillis":"bad"}',
      }
    );
    await seedNode(emptyUnknownNode, USER_ID, {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      status: 'running',
      healthStatus: 'healthy',
    });
    const now = new Date().toISOString();
    await env.DATABASE.prepare(
      `UPDATE nodes
       SET last_heartbeat_at = ?, agent_ready_at = ?, agent_version = 'current-sha',
           runtime = 'vm', node_role = 'workspace'
       WHERE id = ?`
    )
      .bind(now, now, emptyUnknownNode)
      .run();

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-invalid-reservation-denied', occupiedNode, {
          resolvedReservation: reservation(),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);
    // A node with no provider runtime identity and no provider-observed hardware
    // has no TRUSTED capacity, so final admission refuses it even when it is empty:
    // planned estimates never become observations, and such a node drains rather
    // than taking new work. It becomes admissible once the agent reports hardware.
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-unknown-empty-denied', emptyUnknownNode, {
          resolvedReservation: reservation({ memoryMb: 4096, diskMb: 40960 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(false);

    await env.DATABASE.prepare(
      `UPDATE nodes
       SET provider_instance_id = ?,
           observed_provider_instance_vcpu_count = 4,
           observed_provider_instance_memory_mb = 8192,
           observed_provider_instance_disk_gb = 80,
           observed_hardware_source = 'observed'
       WHERE id = ?`
    )
      .bind(`server-${emptyUnknownNode}`, emptyUnknownNode)
      .run();

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-unknown-empty-allowed', emptyUnknownNode, {
          resolvedReservation: reservation({ memoryMb: 4096, diskMb: 40960 }),
        }),
        admissionPolicy()
      )
    ).resolves.toBe(true);
  });

  it('vetoes final reservations when selected node state changed before insert', async () => {
    const cases: Array<{
      name: string;
      nodeId: string;
      mutate: (nodeId: string) => Promise<void>;
    }> = [
      {
        name: 'status',
        nodeId: 'node-vm-admission-veto-status',
        mutate: async (nodeId) => {
          await env.DATABASE.prepare(`UPDATE nodes SET status = 'deleting' WHERE id = ?`)
            .bind(nodeId)
            .run();
        },
      },
      {
        name: 'owner',
        nodeId: 'node-vm-admission-veto-owner',
        mutate: async (nodeId) => {
          await env.DATABASE.prepare(`UPDATE nodes SET user_id = ? WHERE id = ?`)
            .bind(OTHER_USER_ID, nodeId)
            .run();
        },
      },
      {
        name: 'role',
        nodeId: 'node-vm-admission-veto-role',
        mutate: async (nodeId) => {
          await env.DATABASE.prepare(`UPDATE nodes SET node_role = 'deployment' WHERE id = ?`)
            .bind(nodeId)
            .run();
        },
      },
    ];

    for (const testCase of cases) {
      await makeReadyNode(testCase.nodeId, USER_ID, 'medium');
      await testCase.mutate(testCase.nodeId);

      await expect(
        reserveWorkspacePlacement(
          env.DATABASE,
          placement(`workspace-vm-admission-veto-${testCase.name}`, testCase.nodeId),
          2
        )
      ).resolves.toBe(false);
    }
  });

  it('counts creating and recovery workspaces against final reservation capacity', async () => {
    const creatingNode = 'node-vm-admission-capacity-creating';
    const recoveryNode = 'node-vm-admission-capacity-recovery';
    const stoppedNode = 'node-vm-admission-capacity-stopped';
    await makeReadyNode(creatingNode, USER_ID, 'medium');
    await makeReadyNode(recoveryNode, USER_ID, 'medium');
    await makeReadyNode(stoppedNode, USER_ID, 'medium');
    await seedWorkspace('workspace-vm-admission-capacity-creating', creatingNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'creating',
    });
    await seedWorkspace('workspace-vm-admission-capacity-recovery', recoveryNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'recovery',
    });
    await seedWorkspace('workspace-vm-admission-capacity-stopped', stoppedNode, USER_ID, {
      projectId: PROJECT_ID,
      status: 'stopped',
    });

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-capacity-creating-denied', creatingNode),
        1
      )
    ).resolves.toBe(false);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-capacity-recovery-denied', recoveryNode),
        1
      )
    ).resolves.toBe(false);
    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        placement('workspace-vm-admission-capacity-stopped-allowed', stoppedNode),
        1
      )
    ).resolves.toBe(true);
  });

  it('expires admission waits only after the explicit wait deadline', async () => {
    const taskId = 'task-vm-admission-wait-deadline';
    await seedQueuedTask(taskId);
    const wait = await waitForVmAdmissionCapacity(
      env,
      admission(taskId, {
        scopeKey: `${SCOPE_KEY}:deadline`,
        providerDomainKey: `${PROVIDER_DOMAIN}:deadline`,
      }),
      'compatible_node_provisioning'
    );
    expect(wait.kind).toBe('waiting');

    await env.DATABASE.prepare(
      `UPDATE vm_task_admissions SET wait_deadline_at = ? WHERE task_id = ?`
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), taskId)
      .run();

    const expired = await waitForVmAdmissionCapacity(
      env,
      admission(taskId, {
        scopeKey: `${SCOPE_KEY}:deadline`,
        providerDomainKey: `${PROVIDER_DOMAIN}:deadline`,
      }),
      'compatible_node_provisioning'
    );
    expect(expired.kind).toBe('expired');
  });
});
