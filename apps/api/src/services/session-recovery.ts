import { type VMSize } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import {
  assertReplacementDeletionConfirmed,
  WorkspaceDeletionUnconfirmedError,
} from './replacement-deletion-fence';
import {
  failAndRestoreSessionRecoveryHandoff,
  isSessionRecoverySourceTaskGuardValid,
} from './session-recovery-authority';
import { loadRecoveryContext, type RecoveryContext } from './session-recovery-context';
import {
  evictionRecoveryFenceMatches,
  type SessionRecoveryOptions,
} from './session-recovery-eviction';
import {
  asVmSize,
  asWorkspaceProfile,
  type RecoveryPlacementResolution,
  resolveRecoveryPlacement,
  snapshotAgentType,
} from './session-recovery-placement';
import {
  abandonRecoveryHandoff,
  createRecoveryTask,
  SESSION_RECOVERY_INITIAL_PROMPT,
} from './session-recovery-task';
import { SourceTaskNotWakeableError } from './session-recovery-task-guard';
import {
  claimSessionSnapshotRecovery,
  failSessionSnapshotRecovery,
  sessionLifecycleError,
  type SessionRecoverySourceTaskGuard,
} from './session-snapshots';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';

export { SESSION_RECOVERY_INITIAL_PROMPT } from './session-recovery-task';

export type SessionRecoveryResult =
  { status: 'waking'; taskId: string } | { status: 'unavailable'; reason: string };

async function startRecoveryTask(
  env: Env,
  context: RecoveryContext,
  task: schema.Task,
  chatSessionId: string,
  placementResolution: RecoveryPlacementResolution,
  sourceTaskGuard?: SessionRecoverySourceTaskGuard,
  options: SessionRecoveryOptions = {}
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    throw new Error(`Recovery task is already ${task.status}`);
  }
  if (
    sourceTaskGuard &&
    !(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, sourceTaskGuard))
  ) {
    throw new SourceTaskNotWakeableError();
  }
  if (task.status === 'in_progress') return;
  const alreadyStarted = await ensureTaskRunnerStarted(env, task.id);
  if (
    sourceTaskGuard &&
    !(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, sourceTaskGuard))
  ) {
    throw new SourceTaskNotWakeableError();
  }
  if (alreadyStarted) return;

  const profile = task.agentProfileHint
    ? await db
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, task.agentProfileHint))
        .get()
    : null;

  if (
    sourceTaskGuard &&
    !(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, sourceTaskGuard))
  ) {
    throw new SourceTaskNotWakeableError();
  }

  if (options.evictionFence && !(await evictionRecoveryFenceMatches(env, options.evictionFence))) {
    throw Object.assign(new Error('Eviction generation changed before TaskRunner start'), {
      permanent: true,
    });
  }

  await startTaskRunnerDO(env, {
    taskId: task.id,
    projectId: context.project.id,
    userId: context.snapshot.userId,
    vmSize: asVmSize(context.workspace.vmSize),
    vmLocation: placementResolution.placement.vmLocation,
    branch: context.workspace.branch || context.project.defaultBranch,
    defaultBranch: context.project.defaultBranch,
    preferredNodeId: null,
    excludedNodeId: options.excludedNodeId ?? null,
    userName: context.user.name,
    userEmail: context.user.email,
    githubId: context.user.githubId,
    taskTitle: task.title,
    taskDescription: task.description ?? SESSION_RECOVERY_INITIAL_PROMPT,
    repository: context.project.repository,
    installationId: context.project.installationId,
    outputBranch: task.outputBranch,
    projectDefaultVmSize: context.project.defaultVmSize as VMSize | null,
    chatSessionId,
    agentType:
      snapshotAgentType(context.snapshot) ??
      profile?.agentType ??
      context.project.defaultAgentType ??
      null,
    workspaceProfile: asWorkspaceProfile(context.workspace.workspaceProfile),
    devcontainerConfigName: context.workspace.devcontainerConfigName,
    cloudProvider: placementResolution.placement.provider ?? placementResolution.effectiveProvider,
    explicitVmLocation: placementResolution.placement.explicitVmLocation === true,
    credentialAttributionUserId: placementResolution.credentialAttributionUserId,
    credentialAttributionProjectId: placementResolution.credentialAttributionProjectId,
    credentialAttributionSource: placementResolution.credentialAttributionSource,
    taskMode: 'conversation',
    model: profile?.model ?? null,
    effort:
      profile?.effort === 'low' ||
      profile?.effort === 'medium' ||
      profile?.effort === 'high' ||
      profile?.effort === 'auto'
        ? profile.effort
        : null,
    permissionMode: profile?.permissionMode ?? null,
    systemPromptAppend: profile?.systemPromptAppend ?? null,
    agentProfileHint: task.agentProfileHint,
    projectScaling: {
      taskExecutionTimeoutMs: context.project.taskExecutionTimeoutMs,
      maxWorkspacesPerNode: context.project.maxWorkspacesPerNode,
      nodeCpuThresholdPercent: context.project.nodeCpuThresholdPercent,
      nodeMemoryThresholdPercent: context.project.nodeMemoryThresholdPercent,
      warmNodeTimeoutMs: context.project.warmNodeTimeoutMs,
    },
    resolvedReservation: placementResolution.placement.resolvedReservation,
    capacityPoolSelection: placementResolution.capacityPoolSelection,
    vmSizeSource: placementResolution.placement.vmSizeSource,
    resumeSnapshotChatSessionId: chatSessionId,
    evictionFence: options.evictionFence ?? null,
    // Unguarded human wakes intentionally do not carry recoverySourceTaskId:
    // that field grants the live-parent revocable-authority contract. Keep the
    // predecessor deletion lineage separately so every TaskRunner boundary can
    // still revalidate that the old runtime is gone before allocating a node.
    recoverySourceTaskId: sourceTaskGuard?.taskId ?? null,
    retrySourceTaskId: task.recoverySourceTaskId ?? null,
    projectEventWakeGuard: sourceTaskGuard?.projectEventWake ?? null,
    recoveryRequiredProjectMemberId: sourceTaskGuard?.requiredProjectMemberId ?? null,
  });
}

/**
 * Claim and (re)start the one replacement TaskRunner that wakes a sleeping VM
 * conversation. The snapshot row is the durable lock, so alarm retries and
 * concurrent user prompts converge on the same task and workspace.
 */
export async function ensureSessionRecovery(
  env: Env,
  projectId: string,
  chatSessionId: string,
  sourceTaskGuard?: SessionRecoverySourceTaskGuard,
  options: SessionRecoveryOptions = {}
): Promise<SessionRecoveryResult> {
  const db = drizzle(env.DATABASE, { schema });
  const context = await loadRecoveryContext(db, projectId, chatSessionId);
  if (!context) return { status: 'unavailable', reason: 'sleeping_snapshot_missing' };
  if (options.evictionFence && !(await evictionRecoveryFenceMatches(env, options.evictionFence))) {
    return { status: 'unavailable', reason: 'stale_eviction_generation' };
  }
  if (context.snapshot.runtime === 'cf-container') {
    return { status: 'unavailable', reason: 'container_runtime_wakes_in_place' };
  }

  const deletionSourceTaskId =
    sourceTaskGuard?.taskId ??
    context.sourceTask?.recoverySourceTaskId ??
    context.sourceTask?.id ??
    null;
  if (deletionSourceTaskId) {
    try {
      await assertReplacementDeletionConfirmed(env, {
        sourceTaskId: deletionSourceTaskId,
        projectId,
        userId: context.snapshot.userId,
      });
    } catch (error) {
      if (error instanceof WorkspaceDeletionUnconfirmedError) {
        return { status: 'unavailable', reason: 'workspace_deletion_unconfirmed' };
      }
      throw error;
    }
  }

  const recoveryTaskId = ulid();
  let placementResolution: RecoveryPlacementResolution;
  try {
    const resolved = await resolveRecoveryPlacement(db, env, context, recoveryTaskId, options);
    if ('error' in resolved) {
      return { status: 'unavailable', reason: `session_recovery_placement_${resolved.errorKind}` };
    }
    placementResolution = resolved;
  } catch (error) {
    log.warn('session_recovery.placement_resolution_deferred', {
      projectId,
      chatSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable', reason: 'session_recovery_placement_transient' };
  }

  const claim = await claimSessionSnapshotRecovery(db, env, {
    chatSessionId,
    userId: context.snapshot.userId,
    taskId: recoveryTaskId,
    sourceTaskGuard,
  });
  if (claim.status === 'unavailable') return claim;
  if (claim.status === 'waking') return claim;

  if (options.evictionFence && !(await evictionRecoveryFenceMatches(env, options.evictionFence))) {
    await failSessionSnapshotRecovery(
      db,
      env,
      chatSessionId,
      claim.taskId,
      'Eviction generation changed before recovery start'
    );
    return { status: 'unavailable', reason: 'stale_eviction_generation' };
  }

  let recoveryTask: schema.Task | null = null;
  try {
    recoveryTask = await createRecoveryTask(
      env.DATABASE,
      db,
      context,
      chatSessionId,
      claim.taskId,
      placementResolution,
      sourceTaskGuard
    );
    await startRecoveryTask(
      env,
      context,
      recoveryTask,
      chatSessionId,
      placementResolution,
      sourceTaskGuard,
      options
    );
    log.info('session_recovery.waking', {
      projectId,
      chatSessionId,
      taskId: recoveryTask.id,
      claimStatus: claim.status,
    });
    return { status: 'waking', taskId: recoveryTask.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SourceTaskNotWakeableError) {
      if (recoveryTask) {
        await abandonRecoveryHandoff(env.DATABASE, context, recoveryTask, chatSessionId, message);
      }
      await failSessionSnapshotRecovery(db, env, chatSessionId, claim.taskId, message);
      return { status: 'unavailable', reason: 'source_task_not_wakeable' };
    }
    if (await ensureTaskRunnerStarted(env, claim.taskId).catch(() => false)) {
      log.warn('session_recovery.start_response_ambiguous_but_durable', {
        projectId,
        chatSessionId,
        taskId: claim.taskId,
        error: message,
      });
      return { status: 'waking', taskId: claim.taskId };
    }
    const failure = sessionLifecycleError(env, `Session recovery failed: ${message}`);
    await failAndRestoreSessionRecoveryHandoff(env.DATABASE, {
      recoveryTaskId: claim.taskId,
      chatSessionId,
      error: failure,
      statusEventId: ulid(),
    });
    log.error('session_recovery.start_failed', {
      projectId,
      chatSessionId,
      taskId: claim.taskId,
      error: message,
    });
    return { status: 'unavailable', reason: `recovery_start_failed:${message}` };
  }
}
