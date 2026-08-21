/**
 * Deterministic D1 race tests for VM admission control.
 *
 * These exercise the production D1 statements that serialize cold-start
 * provisioning claims and preserve existing-node packing invariants. Provider
 * calls are not made; provider/account-capacity is tested at the typed error
 * classification boundary.
 */
import { ProviderError } from '@simple-agent-manager/providers';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { findNodeWithCapacity } from '../../src/durable-objects/task-runner/node-selection';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner/types';
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

function placement(workspaceId: string, nodeId: string): WorkspacePlacementInput {
  return {
    id: workspaceId,
    nodeId,
    projectId: PROJECT_ID,
    userId: USER_ID,
    installationId: INSTALLATION_ID,
    name: `Workspace ${workspaceId}`,
    displayName: `Workspace ${workspaceId}`,
    normalizedDisplayName: workspaceId,
    repository: 'test-org/vm-admission-races',
    branch: 'main',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    createdAt: new Date().toISOString(),
  };
}

function taskState(userId: string, vmSize: 'small' | 'medium' | 'large'): TaskRunnerState {
  const now = Date.now();
  return {
    version: 1,
    taskId: `task-selector-${userId}-${vmSize}`,
    projectId: PROJECT_ID,
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
      repository: 'test-org/vm-admission-races',
      installationId: INSTALLATION_ID,
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
  vmSize: 'small' | 'medium' | 'large'
): Promise<void> {
  const now = new Date().toISOString();
  await seedNode(nodeId, userId, { vmSize, vmLocation: 'nbg1', status: 'running' });
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
    expect(
      await releaseVmProvisioningLease(env, scopeKey, taskA, firstGrant.fencingToken)
    ).toBe(false);
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
    expect(await findNodeWithCapacity(taskState(USER_ID, 'large'), rc)).toBe(largeNode);
    expect(await findNodeWithCapacity(taskState(OTHER_USER_ID, 'large'), rc)).toBe(otherUserNode);

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
    expect(await findNodeWithCapacity(taskState(USER_ID, 'medium'), rc)).toBe(largeNode);
    expect(await findNodeWithCapacity(taskState(USER_ID, 'large'), rc)).toBe(largeNode);
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
