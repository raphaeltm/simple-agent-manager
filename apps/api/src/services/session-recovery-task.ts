import { type VMSize } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { isSessionRecoverySourceTaskGuardValid } from './session-recovery-authority';
import type { RecoveryContext } from './session-recovery-context';
import {
  evictionRecoveryFenceMatches,
  type SessionRecoveryOptions,
} from './session-recovery-eviction';
import {
  asVmSize,
  asWorkspaceProfile,
  type RecoveryPlacementResolution,
  snapshotAgentType,
} from './session-recovery-request';
import { SourceTaskNotWakeableError } from './session-recovery-task-guard';
import type { SessionRecoverySourceTaskGuard } from './session-snapshots';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';

export const SESSION_RECOVERY_INITIAL_PROMPT =
  'Resume this sleeping conversation from the persisted transcript. Do not repeat prior work; wait for and answer the latest queued follow-up message.';

export async function abandonRecoveryHandoff(
  database: D1Database,
  context: RecoveryContext,
  task: schema.Task,
  chatSessionId: string,
  reason: string
): Promise<void> {
  if (!task.recoverySourceTaskId) return;
  const now = new Date().toISOString();
  const sourceTaskId = task.recoverySourceTaskId;
  const results = await database.batch([
    database
      .prepare(
        `UPDATE tasks
            SET status = 'cancelled', execution_step = NULL, chat_session_id = NULL,
                error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
            AND recovery_source_task_id = ?
            AND status NOT IN ('completed', 'failed', 'cancelled')`
      )
      .bind(reason.slice(0, 2048), now, now, task.id, sourceTaskId),
    database
      .prepare(
        `UPDATE tasks
            SET chat_session_id = ?,
                superseded_by_task_id = NULL,
                updated_at = ?
          WHERE id = ?
            AND project_id = ?
            AND chat_session_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM tasks owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(chatSessionId, now, sourceTaskId, context.project.id, chatSessionId),
    database
      .prepare(
        `UPDATE workspaces
            SET chat_session_id = ?, updated_at = ?
          WHERE id = ?
            AND chat_session_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM workspaces owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(chatSessionId, now, context.workspace.id, chatSessionId),
    database
      .prepare(
        `INSERT INTO task_status_events
           (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, task.id, 'queued', 'cancelled', 'system', NULL, ?, ?
           FROM tasks task
          WHERE task.id = ? AND task.status = 'cancelled'`
      )
      .bind(ulid(), reason.slice(0, 2048), now, task.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) > 0) {
    log.info('session_recovery.handoff_abandoned', {
      projectId: context.project.id,
      chatSessionId,
      taskId: task.id,
      sourceTaskId,
    });
  }
}

export async function startRecoveryTask(
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
