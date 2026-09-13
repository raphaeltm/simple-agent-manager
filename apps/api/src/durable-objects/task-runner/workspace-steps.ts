/** Workspace creation and VM dispatch steps; readiness and attachment handlers are re-exported below. */
/**
 * Workspace-related step handlers for the TaskRunner DO.
 *
 * Handles workspace_creation, workspace_dispatch, workspace_ready, and attachment_transfer steps.
 */
import {
  type CredentialSource,
  DEFAULT_WORKSPACE_PROFILE,
  type ResolvedResourceReservation,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import type { DevcontainerCacheCredentials } from '../../services/devcontainer-cache';
import { SessionRecoveryAuthorityRevokedError } from '../../services/session-recovery-authority';
import {
  markVmAdmissionPlaced,
  releaseVmProvisioningLease,
} from '../../services/vm-admission-control';
import { reserveWorkspacePlacement } from '../../services/workspace-placement';
import {
  isResolvedResourceReservation,
  resolveWorkspaceAdmissionPolicy,
} from '../../services/workspace-resource-capacity';
import { computeBackoffMs, getRecoverySourceTaskGuard, isTransientError } from './helpers';
import { persistPlacementDiagnostics, updatePlacementDiagnostics } from './placement-diagnostics';
import { ensureSessionLinked } from './state-machine';
import type { TaskRunnerContext, TaskRunnerState } from './types';
import { ensureBranchExistsOnRemote } from './workspace-branch';
import {
  claimWorkspaceAllocationForTask,
  recoverWorkspaceFromD1,
} from './workspace-reserved-allocation';

export { ensureBranchExistsOnRemote } from './workspace-branch';
export { handleAttachmentTransfer, handleWorkspaceReady } from './workspace-ready-steps';

// =========================================================================
// Step Handlers
// =========================================================================

export async function handleWorkspaceCreation(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'workspace_creation');

  if (!state.stepResults.nodeId) {
    throw new Error('No nodeId in state — cannot create workspace');
  }

  await recoverWorkspaceFromD1(state, rc);

  if (state.stepResults.workspaceId) {
    const workspaceId = state.stepResults.workspaceId;
    if (await isTaskDelegatedToWorkspace(state, rc, workspaceId)) {
      // TDF-6: Ensure session linking on crash recovery — the DO may have crashed
      // after creating the workspace but before linking the session. Dispatch
      // must still be checked separately; D1 workspace linkage is not VM-agent
      // acknowledgement.
      await ensureWorkspaceBookkeeping(state, rc, workspaceId);
      await finalizeVmAdmissionPlacement(state, rc);
      await rc.advanceToStep(state, 'workspace_dispatch');
      return;
    }
    // If still queued, the DO recovered after workspace row creation but before
    // the task-link or delegation transition. Re-run the same guarded task-link
    // CAS used by the first-start path before any ProjectData link or dispatch
    // bookkeeping.
    await claimWorkspaceAllocationForTask(state, rc, workspaceId, new Date().toISOString());
    await ensureWorkspaceBookkeeping(state, rc, workspaceId);
    await finalizeVmAdmissionPlacement(state, rc);
  } else {
    const created = await createAndProvisionWorkspace(state, rc);
    if (!created) return;
  }

  // Transition task: queued → delegated (optimistic locking)
  await rc.assertRecoveryAuthority(state);
  const now = new Date().toISOString();
  const result = await rc.env.DATABASE.prepare(
    `UPDATE tasks SET status = 'delegated', updated_at = ? WHERE id = ? AND status = 'queued'`
  )
    .bind(now, state.taskId)
    .run();

  if (!result.meta.changes || result.meta.changes === 0) {
    if (await convergeLostDelegationTransition(state, rc)) {
      return;
    }
    // Task was already failed/cancelled by recovery — abort gracefully
    log.warn('task_runner_do.aborted_by_recovery', {
      taskId: state.taskId,
      step: 'delegated_transition',
    });
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    return;
  }

  // Record status event
  const { ulid } = await import('../../lib/ulid');
  await rc.env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, 'queued', 'delegated', 'system', NULL, ?, ?)`
  )
    .bind(
      ulid(),
      state.taskId,
      `Delegated to workspace ${state.stepResults.workspaceId} on node ${state.stepResults.nodeId}`,
      now
    )
    .run();

  await rc.advanceToStep(state, 'workspace_dispatch');
}

async function isTaskDelegatedToWorkspace(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string
): Promise<boolean> {
  const task = await rc.env.DATABASE.prepare(
    `SELECT status, workspace_id AS workspaceId FROM tasks WHERE id = ?`
  )
    .bind(state.taskId)
    .first<{ status: string; workspaceId: string | null }>();

  return task?.status === 'delegated' && task.workspaceId === workspaceId;
}

async function convergeLostDelegationTransition(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  const task = await rc.env.DATABASE.prepare(
    `SELECT status, workspace_id AS workspaceId FROM tasks WHERE id = ?`
  )
    .bind(state.taskId)
    .first<{ status: string; workspaceId: string | null }>();
  if (task?.status !== 'delegated' || !task.workspaceId) {
    return false;
  }

  state.stepResults.workspaceId = task.workspaceId;
  await rc.ctx.storage.put('state', state);
  await ensureWorkspaceBookkeeping(state, rc, task.workspaceId);
  await finalizeVmAdmissionPlacement(state, rc);
  await rc.advanceToStep(state, 'workspace_dispatch');
  log.warn('task_runner_do.delegated_transition_lost_to_winner', {
    taskId: state.taskId,
    workspaceId: task.workspaceId,
  });
  return true;
}

async function createAndProvisionWorkspace(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  const { ulid } = await import('../../lib/ulid');
  const { resolveUniqueWorkspaceDisplayName } = await import('../../services/workspace-names');
  const { drizzle } = await import('drizzle-orm/d1');
  const schema = await import('../../db/schema');

  const db = drizzle(rc.env.DATABASE, { schema });
  const nodeId = state.stepResults.nodeId;
  if (!nodeId) {
    throw new Error('No nodeId in state — cannot create workspace');
  }
  const workspaceId = ulid();
  const workspaceName = `Task: ${state.config.taskTitle.slice(0, 50)}`;
  const uniqueName = await resolveUniqueWorkspaceDisplayName(db, nodeId, workspaceName);
  const now = new Date().toISOString();
  const chatSessionId = state.stepResults.chatSessionId ?? state.config.chatSessionId ?? null;

  // Recovery authority is revalidated immediately before the physical
  // workspace-row allocation (.claude/rules/49): a parent that terminalized
  // while we resolved the unique display name must not allocate compute.
  await rc.assertRecoveryAuthority(state);
  const resolvedReservation = getWorkspaceReservationForState(state);
  if (state.config.resolvedReservation !== resolvedReservation) {
    state.config.resolvedReservation = resolvedReservation;
    await rc.ctx.storage.put('state', state);
  }
  const admissionPolicy = resolveWorkspaceAdmissionPolicy(rc.env, state.config.projectScaling);
  updatePlacementDiagnostics(state, { queue: {} });
  const placementReserved = await reserveWorkspacePlacement(
    rc.env.DATABASE,
    {
      id: workspaceId,
      nodeId,
      projectId: state.projectId,
      userId: state.userId,
      installationId: state.config.installationId,
      name: workspaceName,
      displayName: uniqueName.displayName,
      normalizedDisplayName: uniqueName.normalizedDisplayName,
      repository: state.config.repository,
      branch: state.config.branch,
      chatSessionId,
      vmSize: state.config.vmSize,
      vmLocation: state.config.vmLocation,
      workspaceProfile: state.config.workspaceProfile ?? DEFAULT_WORKSPACE_PROFILE,
      devcontainerConfigName: state.config.devcontainerConfigName ?? null,
      agentProfileHint: state.config.agentProfileHint ?? null,
      resourceRequirementsJson: state.config.resourceRequirements
        ? JSON.stringify(state.config.resourceRequirements)
        : null,
      capacityPlacementSnapshot: state.stepResults.capacityPlacementSnapshot ?? null,
      taskLifecycleGuard: {
        taskId: state.taskId,
        projectId: state.projectId,
        userId: state.userId,
        chatSessionId: state.stepResults.chatSessionId ?? state.config.chatSessionId ?? null,
        requireChatSessionMatch: state.config.startGuard?.kind === 'reserved_submission',
        reservedIntentFingerprint:
          state.config.startGuard?.kind === 'reserved_submission'
            ? state.config.startGuard.intentFingerprint
            : null,
      },
      resolvedReservation,
      createdAt: now,
    },
    admissionPolicy
  );

  if (!placementReserved) {
    await rc.assertRecoveryAuthority(state);
    await persistPlacementDiagnostics(state, rc, {
      selectedNodeId: null,
      revalidatedAgainstCurrentAuthority: false,
      notes: ['Host capacity or placement authority changed before reservation'],
    });
    log.warn('task_runner_do.workspace_placement_lost', {
      taskId: state.taskId,
      nodeId,
      maxWorkspaces: admissionPolicy.maxWorkspaces,
      cpuShareBudgetPercent: admissionPolicy.cpuShareBudgetPercent,
      hostMemoryReserveMb: admissionPolicy.hostMemoryReserveMb,
      diskPressureThresholdPercent: admissionPolicy.diskPressureThresholdPercent,
      preferredNode: state.config.preferredNodeId === nodeId,
    });
    if (state.config.preferredNodeId === nodeId) {
      throw Object.assign(
        new Error('Specified node lost capacity or became unavailable before workspace creation'),
        { permanent: true }
      );
    }
    state.stepResults.nodeId = null;
    state.stepResults.autoProvisioned = false;
    state.stepResults.provisionedVmSize = null;
    state.stepResults.capacityPlacementSnapshot = null;
    await releaseVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken,
      'workspace_placement_lost'
    );
    state.admissionScopeKey = null;
    state.admissionLeaseToken = null;
    await rc.advanceToStep(state, 'node_selection');
    return false;
  }

  await persistPlacementDiagnostics(state, rc, {
    revalidatedAgainstCurrentAuthority: true,
    queue: {},
  });
  await rc.env.DATABASE.prepare(
    `UPDATE workspaces SET placement_explanation_json = ? WHERE id = ? AND user_id = ?`
  )
    .bind(
      state.stepResults.capacityPlacementSnapshot?.placementExplanationJson ??
        JSON.stringify({ diagnostics: state.stepResults.placementDiagnostics }),
      workspaceId,
      state.userId
    )
    .run();
  state.stepResults.workspaceId = workspaceId;
  await rc.ctx.storage.put('state', state);
  await claimWorkspaceAllocationForTask(state, rc, workspaceId, now);
  await finalizeVmAdmissionPlacement(state, rc);
  await startComputeTrackingBestEffort(state, rc, db, workspaceId, nodeId);
  await ensureWorkspaceBookkeeping(state, rc, workspaceId, now);
  await rc.ctx.storage.put('state', state);
  return true;
}

function getWorkspaceReservationForState(state: TaskRunnerState): ResolvedResourceReservation {
  if (isResolvedResourceReservation(state.config.resolvedReservation)) {
    return state.config.resolvedReservation;
  }

  return resolveResourceReservation(
    { task: state.config.resourceRequirements ?? undefined },
    {
      taskId: state.taskId,
      projectId: state.projectId,
      userId: state.userId,
    }
  );
}

async function finalizeVmAdmissionPlacement(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  if (!state.stepResults.nodeId || !state.stepResults.workspaceId) return;
  await markVmAdmissionPlaced(rc.env, {
    taskId: state.taskId,
    nodeId: state.stepResults.nodeId,
    scopeKey: state.admissionScopeKey,
    fencingToken: state.admissionLeaseToken,
  });
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
  await rc.ctx.storage.put('state', state);
}

async function ensureWorkspaceBookkeeping(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  now = new Date().toISOString()
): Promise<void> {
  await rc.assertRecoveryAuthority(state);
  await ensureSessionLinked(state, workspaceId, rc);
  await setOutputBranch(state, rc, now);
  await ensureBranchExistsOnRemote(state, rc);
}

async function startComputeTrackingBestEffort(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  db: unknown,
  workspaceId: string,
  nodeId: string
): Promise<void> {
  try {
    const { startComputeTracking } = await import('../../services/compute-usage');
    const nodeRow = await rc.env.DATABASE.prepare(
      `SELECT
         cloud_provider,
         credential_source,
         provider_instance_type,
         provider_instance_vcpu_count,
         provider_instance_memory_mb,
         provider_instance_disk_gb,
         provider_instance_boot_disk_size_gb,
         provider_instance_image,
         provider_instance_architecture,
         provider_instance_price_display,
         provider_instance_price_currency,
         provider_instance_price_monthly_cents,
         provider_instance_price_hourly_micros,
         observed_provider_instance_type,
         observed_provider_instance_vcpu_count,
         observed_provider_instance_memory_mb,
         observed_provider_instance_disk_gb,
         observed_hardware_json,
         observed_hardware_source
       FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<{
        cloud_provider: string | null;
        credential_source: string | null;
        provider_instance_type: string | null;
        provider_instance_vcpu_count: number | null;
        provider_instance_memory_mb: number | null;
        provider_instance_disk_gb: number | null;
        provider_instance_boot_disk_size_gb: number | null;
        provider_instance_image: string | null;
        provider_instance_architecture: string | null;
        provider_instance_price_display: string | null;
        provider_instance_price_currency: string | null;
        provider_instance_price_monthly_cents: number | null;
        provider_instance_price_hourly_micros: number | null;
        observed_provider_instance_type: string | null;
        observed_provider_instance_vcpu_count: number | null;
        observed_provider_instance_memory_mb: number | null;
        observed_provider_instance_disk_gb: number | null;
        observed_hardware_json: string | null;
        observed_hardware_source: string | null;
      }>();

    await startComputeTracking(db as Parameters<typeof startComputeTracking>[0], {
      userId: state.userId,
      workspaceId,
      nodeId,
      vmSize: state.config.vmSize,
      cloudProvider: nodeRow?.cloud_provider,
      providerInstanceType: nodeRow?.provider_instance_type,
      providerInstanceVcpuCount: nodeRow?.provider_instance_vcpu_count,
      providerInstanceMemoryMb: nodeRow?.provider_instance_memory_mb,
      providerInstanceDiskGb: nodeRow?.provider_instance_disk_gb,
      providerInstanceBootDiskSizeGb: nodeRow?.provider_instance_boot_disk_size_gb,
      providerInstanceImage: nodeRow?.provider_instance_image,
      providerInstanceArchitecture: nodeRow?.provider_instance_architecture,
      providerInstancePriceDisplay: nodeRow?.provider_instance_price_display,
      providerInstancePriceCurrency: nodeRow?.provider_instance_price_currency,
      providerInstancePriceMonthlyCents: nodeRow?.provider_instance_price_monthly_cents,
      providerInstancePriceHourlyMicros: nodeRow?.provider_instance_price_hourly_micros,
      observedProviderInstanceType: nodeRow?.observed_provider_instance_type,
      observedProviderInstanceVcpuCount: nodeRow?.observed_provider_instance_vcpu_count,
      observedProviderInstanceMemoryMb: nodeRow?.observed_provider_instance_memory_mb,
      observedProviderInstanceDiskGb: nodeRow?.observed_provider_instance_disk_gb,
      observedHardwareJson: nodeRow?.observed_hardware_json,
      observedHardwareSource: nodeRow?.observed_hardware_source,
      credentialSource: (nodeRow?.credential_source as CredentialSource | null) ?? 'user',
    });
  } catch (err) {
    log.error('task_runner_do.compute_tracking_start_failed', {
      taskId: state.taskId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function setOutputBranch(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  now: string
): Promise<void> {
  const outputBranch = state.config.outputBranch || `task/${state.taskId}`;
  await rc.env.DATABASE.prepare(`UPDATE tasks SET output_branch = ?, updated_at = ? WHERE id = ?`)
    .bind(outputBranch, now, state.taskId)
    .run();
}

type TaskRunnerProjectRepo = {
  repoProvider: string | null;
};

async function loadTaskRunnerProjectRepo(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<TaskRunnerProjectRepo | null> {
  return rc.env.DATABASE.prepare(`SELECT repo_provider AS repoProvider FROM projects WHERE id = ?`)
    .bind(state.projectId)
    .first<TaskRunnerProjectRepo>();
}

async function createWorkspaceOnVmAgent(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  nodeId: string
): Promise<void> {
  const { signCallbackToken } = await import('../../services/jwt');
  const { createWorkspaceOnNode } = await import('../../services/node-agent');
  const { resolveWorkspaceGitSource } = await import('../../services/workspace-git-source');
  const callbackToken = await signCallbackToken(workspaceId, rc.env);
  const projectRepo = await loadTaskRunnerProjectRepo(state, rc);
  const { drizzle } = await import('drizzle-orm/d1');
  const schema = await import('../../db/schema');
  const gitSource = await resolveWorkspaceGitSource(drizzle(rc.env.DATABASE, { schema }), {
    id: state.projectId,
    repoProvider: projectRepo?.repoProvider ?? 'github',
  });
  const checkoutBranch = state.config.outputBranch || state.config.branch;
  const baseBranch =
    checkoutBranch === state.config.branch ? state.config.defaultBranch : state.config.branch;
  const devcontainerCache = await getDevcontainerCacheForWorkspace(state, rc, workspaceId);
  const sourceTaskGuard = getRecoverySourceTaskGuard(state);
  await rc.assertRecoveryAuthority(state);
  const response = await createWorkspaceOnNode(
    nodeId,
    rc.env,
    state.userId,
    {
      workspaceId,
      repository: state.config.repository,
      branch: checkoutBranch,
      baseBranch,
      defaultBranch: state.config.defaultBranch || 'main',
      repoProvider: gitSource.repoProvider,
      cloneUrl: gitSource.cloneUrl,
      repositoryHost: gitSource.repositoryHost,
      repositoryPath: gitSource.repositoryPath,
      callbackToken,
      gitUserName: state.config.userName,
      gitUserEmail: state.config.userEmail,
      githubId: state.config.githubId,
      lightweight: state.config.workspaceProfile === 'lightweight',
      devcontainerConfigName: state.config.devcontainerConfigName ?? undefined,
      devcontainerCache,
      projectId: state.projectId,
      taskId: state.taskId,
    },
    {
      sourceTaskGuard,
      beforeExternalMutation: async () => {
        await rc.assertRecoveryAuthority(state);
      },
    }
  );
  await rc.assertRecoveryAuthority(state);
  if (!isWorkspaceDispatchAck(response, workspaceId)) {
    throw Object.assign(
      new Error(`Node Agent did not acknowledge workspace dispatch for ${workspaceId}`),
      { permanent: true }
    );
  }
}

function isWorkspaceDispatchAck(response: unknown, workspaceId: string): boolean {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const record = response as Record<string, unknown>;
  return record.workspaceId === workspaceId;
}

export async function handleWorkspaceDispatch(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'workspace_dispatch');

  const nodeId = state.stepResults.nodeId;
  const workspaceId = state.stepResults.workspaceId;
  if (!nodeId || !workspaceId) {
    throw new Error('workspace_dispatch requires nodeId and workspaceId');
  }

  const workspace = await rc.env.DATABASE.prepare(
    `SELECT dispatched_at FROM workspaces WHERE id = ?`
  )
    .bind(workspaceId)
    .first<{ dispatched_at: string | null }>();
  if (!workspace) {
    throw Object.assign(new Error(`Workspace ${workspaceId} not found for dispatch`), {
      permanent: true,
    });
  }

  if (workspace.dispatched_at) {
    state.workspaceDispatchAckedAt ??= Date.now();
    await rc.ctx.storage.put('state', state);
    await rc.advanceToStep(state, 'workspace_ready');
    return;
  }

  const now = Date.now();
  if (!state.workspaceDispatchStartedAt) {
    state.workspaceDispatchStartedAt = now;
  }

  const timeoutMs = rc.getWorkspaceDispatchTimeoutMs();
  const elapsedMs = now - state.workspaceDispatchStartedAt;
  if (elapsedMs > timeoutMs) {
    throw Object.assign(
      new Error(`Workspace dispatch was not acknowledged by node agent within ${timeoutMs}ms`),
      { permanent: true }
    );
  }

  state.workspaceDispatchAttempts += 1;
  state.workspaceDispatchLastAttemptAt = now;
  await rc.ctx.storage.put('state', state);

  try {
    await createWorkspaceOnVmAgent(state, rc, workspaceId, nodeId);
    const dispatchedAt = new Date().toISOString();
    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET dispatched_at = ?, updated_at = ? WHERE id = ?`
    )
      .bind(dispatchedAt, dispatchedAt, workspaceId)
      .run();
    state.workspaceDispatchAckedAt = Date.now();
    state.workspaceDispatchLastError = null;
    await rc.ctx.storage.put('state', state);
    await rc.advanceToStep(state, 'workspace_ready');
  } catch (err) {
    if (err instanceof SessionRecoveryAuthorityRevokedError) throw err;
    const errorMessage = err instanceof Error ? err.message : String(err);
    state.workspaceDispatchLastError = errorMessage;
    await rc.ctx.storage.put('state', state);

    if (!isTransientError(err)) {
      throw Object.assign(new Error(errorMessage), { permanent: true });
    }

    const dispatchStartedAt = state.workspaceDispatchStartedAt ?? Date.now();
    const elapsedAfterAttemptMs = Date.now() - dispatchStartedAt;
    const remainingMs = timeoutMs - elapsedAfterAttemptMs;
    if (remainingMs <= 0) {
      throw Object.assign(
        new Error(
          `Workspace dispatch was not acknowledged by node agent within ${timeoutMs}ms. Last error: ${errorMessage}`
        ),
        { permanent: true }
      );
    }

    const backoffMs = computeBackoffMs(
      state.workspaceDispatchAttempts - 1,
      rc.getWorkspaceDispatchBaseDelayMs(),
      rc.getWorkspaceDispatchMaxDelayMs()
    );
    const nextDelayMs = Math.min(backoffMs, remainingMs);
    await rc.ctx.storage.setAlarm(Date.now() + nextDelayMs);

    log.warn('task_runner_do.workspace_dispatch_retry_scheduled', {
      taskId: state.taskId,
      workspaceId,
      nodeId,
      attempts: state.workspaceDispatchAttempts,
      backoffMs: nextDelayMs,
      error: errorMessage,
    });
  }
}

async function getDevcontainerCacheForWorkspace(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string
): Promise<DevcontainerCacheCredentials | null> {
  if (state.config.workspaceProfile === 'lightweight') {
    return null;
  }

  try {
    const { getDevcontainerCacheCredentials } = await import('../../services/devcontainer-cache');
    return await getDevcontainerCacheCredentials(
      rc.env,
      state.config.repository,
      state.config.devcontainerConfigName
    );
  } catch (err) {
    log.warn('task_runner_do.devcontainer_cache_credentials_failed', {
      taskId: state.taskId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
