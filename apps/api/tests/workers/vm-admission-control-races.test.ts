/**
 * Deterministic D1 race tests for VM admission control.
 *
 * These exercise the production D1 statements that serialize cold-start
 * provisioning claims and preserve existing-node packing invariants. Provider
 * calls are not made; provider/account-capacity is tested at the typed error
 * classification boundary.
 */
import { ProviderError } from '@simple-agent-manager/providers';
import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
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
const PROVIDER_DOMAIN = 'hetzner:platform:hetzner:vm-admission-races';
const SCOPE_KEY = `user:${USER_ID}:workspace-vm:${PROVIDER_DOMAIN}`;

beforeAll(async () => {
  await seedUser(USER_ID);
  await seedUser(OTHER_USER_ID);
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
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
    >
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
    createdAt: new Date().toISOString(),
  };
}

function taskState(
  userId: string,
  vmSize: 'small' | 'medium' | 'large',
  overrides: Partial<Pick<TaskRunnerState, 'projectId'>> & {
    installationId?: string;
    repository?: string;
    capacityPoolSelection?: TaskRunnerState['config']['capacityPoolSelection'];
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
      projectScaling: { maxWorkspacesPerNode: 2 },
      resourceRequirements: null,
      resolvedReservation: null,
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
    placementCredentialReference: `test:${input.sourceId}`,
    placementCredentialVersion: 1,
    capacityPoolProjectId: input.scope === 'project' ? (input.projectId ?? PROJECT_ID) : null,
    workloadRole: 'workspace',
    placementExplanationJson: JSON.stringify({
      poolId: input.poolId,
      sourceId: input.sourceId,
      candidateId: input.candidateId,
    }),
  };
}

async function seedCapacityRecords(
  snapshot: CapacityPlacementSnapshot,
  ownerUserId = USER_ID
): Promise<void> {
  if (!snapshot.capacityPoolId || !snapshot.capacityPoolScope || !snapshot.capacitySourceId) {
    throw new Error('snapshot must include pool and source IDs');
  }
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_pools
       (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status, strategy,
        exhaustion_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'active', 'balanced', 'queue', ?, ?)`
  )
    .bind(
      snapshot.capacityPoolId,
      snapshot.capacityPoolScope,
      snapshot.capacityPoolScope === 'user' ? ownerUserId : null,
      snapshot.capacityPoolScope === 'project' ? snapshot.capacityPoolProjectId : null,
      `Pool ${snapshot.capacityPoolId}`,
      snapshot.capacityPoolRevision ?? 1,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO capacity_sources
       (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
        credential_id, platform_credential_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'registered-runner', NULL, NULL, NULL, NULL, 'active', ?, ?)`
  )
    .bind(
      snapshot.capacitySourceId,
      snapshot.capacityPoolScope,
      snapshot.capacityPoolScope === 'user' ? ownerUserId : null,
      snapshot.capacityPoolScope === 'project' ? snapshot.capacityPoolProjectId : null,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
}

async function assignNodeCapacity(
  nodeId: string,
  snapshot: CapacityPlacementSnapshot
): Promise<void> {
  await seedCapacityRecords(snapshot);
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET capacity_pool_id = ?,
         capacity_pool_scope = ?,
         capacity_pool_revision = ?,
         capacity_source_id = ?,
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
      snapshot.capacityPoolCandidateId,
      snapshot.placementCredentialSource,
      snapshot.placementCredentialReference,
      snapshot.placementCredentialVersion,
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
  await seedNode(nodeId, userId, {
    vmSize,
    vmLocation: 'nbg1',
    status: 'running',
    nodeClass: opts.nodeClass ?? 'managed',
  });
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET health_status = 'healthy',
       last_heartbeat_at = ?,
       agent_ready_at = ?,
       agent_version = 'current-sha',
       runtime = 'vm',
       node_role = 'workspace',
       last_metrics = ?
     WHERE id = ?`
  )
    .bind(now, now, JSON.stringify({ cpuLoadAvg1: 5, memoryPercent: 10 }), nodeId)
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

    await reserveWorkspacePlacement(
      env.DATABASE,
      placement('workspace-vm-admission-medium-first', mediumNode),
      2
    );
    const mediumPlacement = await reserveWorkspacePlacement(
      env.DATABASE,
      placement('workspace-vm-admission-medium-second', mediumNode),
      2
    );
    expect(mediumPlacement).toBe(true);
    expect((await findNodeWithCapacity(taskState(USER_ID, 'medium'), rc))?.nodeId).toBe(largeNode);
    expect((await findNodeWithCapacity(taskState(USER_ID, 'large'), rc))?.nodeId).toBe(largeNode);
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
          priority: 1,
          candidateOrder: 0,
          credentialAttributionSource: 'user',
          placementCredentialSource: 'user',
          placementCredentialReference: snapshot.placementCredentialReference,
          placementCredentialVersion: 1,
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
      projectId: PROJECT_ID,
    });
    await makeReadyNode(nodeId, USER_ID, 'large');
    await assignNodeCapacity(nodeId, snapshot);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement(workspaceId, nodeId, { vmSize: 'large' }),
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
      capacity_pool_project_id: PROJECT_ID,
      workload_role: 'workspace',
      placement_explanation_json: snapshot.placementExplanationJson,
    });
  });

  it('handles source-less capacity pool snapshots without SQL truthiness binds', async () => {
    const userLegacyNodeId = 'node-vm-admission-source-less-user';
    const projectLegacyNodeId = 'node-vm-admission-source-less-project';
    await makeReadyNode(userLegacyNodeId, USER_ID, 'medium');
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
      projectId: PROJECT_ID,
    });
    await seedCapacityRecords(userBaseSnapshot);
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

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement('workspace-vm-admission-source-less-user', userLegacyNodeId),
          capacityPlacementSnapshot: sourceLessUserSnapshot,
        },
        2
      )
    ).resolves.toBe(true);

    await expect(
      reserveWorkspacePlacement(
        env.DATABASE,
        {
          ...placement('workspace-vm-admission-source-less-project', projectLegacyNodeId),
          capacityPlacementSnapshot: sourceLessProjectSnapshot,
        },
        2
      )
    ).resolves.toBe(false);

    const projectWorkspace = await env.DATABASE.prepare(
      `SELECT id FROM workspaces WHERE id = ?`
    )
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
      projectId: PROJECT_ID,
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
      projectId: PROJECT_ID,
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
