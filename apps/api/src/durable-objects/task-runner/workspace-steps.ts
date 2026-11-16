/** Workspace creation step; dispatch, readiness and attachment handlers are re-exported below. */
/**
 * Workspace-related step handlers for the TaskRunner DO.
 *
 * Handles workspace_creation; workspace_dispatch, workspace_ready and attachment_transfer live in
 * sibling modules and are re-exported here so the DO's step table keeps one import site.
 */
import {
  isResolvedResourceReservation,
} from '@simple-agent-manager/scheduler-core';
import {
  type CredentialSource,
  DEFAULT_WORKSPACE_PROFILE,
  type ResolvedResourceReservation,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { resolvePlacementAdmissionPolicy } from '../../services/node-lifetime-admission';
import { markVmAdmissionPlaced } from '../../services/vm-admission-control';
import { reserveWorkspacePlacement } from '../../services/workspace-placement';
import { persistPlacementDiagnostics, updatePlacementDiagnostics } from './placement-diagnostics';
import { ensureSessionLinked } from './state-machine';
import type { TaskRunnerContext, TaskRunnerState } from './types';
import { ensureBranchExistsOnRemote } from './workspace-branch';
import {
  handleWorkspacePlacementRefused,
  resolveStartupBacklogGuard,
} from './workspace-placement-rejection';
import {
  claimWorkspaceAllocationForTask,
  recoverWorkspaceFromD1,
} from './workspace-reserved-allocation';

export { ensureBranchExistsOnRemote } from './workspace-branch';
export { handleWorkspaceDispatch } from './workspace-dispatch-step';
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
  const admissionPolicy = await resolvePlacementAdmissionPolicy(
    rc.env,
    state.config.projectScaling
  );
  const maxStartupBacklog = await resolveStartupBacklogGuard(state, rc, nodeId);
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
      maxStartupBacklog,
      createdAt: now,
    },
    admissionPolicy
  );

  if (!placementReserved) {
    await handleWorkspacePlacementRefused(state, rc, nodeId, admissionPolicy, maxStartupBacklog);
    return false;
  }

  // A reservation that succeeds ends the refusal episode (rule 61).
  state.workspacePlacementRejections = 0;
  state.startupBacklogConflicts = 0;
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
