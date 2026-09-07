import {
  type AgentProfileRuntime,
  type CredentialSource,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  VALID_WORKSPACE_PROFILES,
  type VMSize,
  type WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { and, desc, eq, exists, notInArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import {
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
  type TaskStartPlacementWithCredential,
} from './placement-resolver';
import {
  assertReplacementDeletionConfirmed,
  WorkspaceDeletionUnconfirmedError,
} from './replacement-deletion-fence';
import { failAndRestoreSessionRecoveryHandoff } from './session-recovery-authority';
import {
  claimSessionSnapshotRecovery,
  failSessionSnapshotRecovery,
  sessionLifecycleError,
  type SessionRecoverySourceTaskGuard,
} from './session-snapshots';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type SessionRecoveryResult =
  | { status: 'waking'; taskId: string }
  | { status: 'unavailable'; reason: string };

type RecoveryContext = {
  snapshot: schema.SessionSnapshot;
  project: schema.Project;
  workspace: schema.Workspace;
  user: schema.User;
  sourceTask: schema.Task | null;
};

type RecoveryPlacementResolution = TaskStartPlacementWithCredential;

class SourceTaskNotWakeableError extends Error {
  constructor() {
    super('source task is no longer wakeable');
    this.name = 'SourceTaskNotWakeableError';
  }
}

async function sourceTaskGuardIsWakeable(
  db: Db,
  guard: SessionRecoverySourceTaskGuard | undefined
): Promise<boolean> {
  if (!guard) return true;
  const recoveryOwner = alias(schema.tasks, 'recovery_owner');
  const markedSuccessor = alias(schema.tasks, 'recovery_marked_successor');
  const terminalStatuses = ['completed', 'failed', 'cancelled'];
  const sourceIsWakeable = or(
    notInArray(schema.tasks.status, terminalStatuses),
    and(
      eq(schema.tasks.status, 'cancelled'),
      exists(
        db
          .select({ id: markedSuccessor.id })
          .from(markedSuccessor)
          .where(
            and(
              eq(markedSuccessor.id, schema.tasks.supersededByTaskId),
              eq(markedSuccessor.projectId, guard.projectId),
              eq(markedSuccessor.chatSessionId, guard.chatSessionId),
              eq(markedSuccessor.triggeredBy, 'session-recovery'),
              notInArray(markedSuccessor.status, terminalStatuses)
            )
          )
      )
    )
  );
  const task = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, guard.taskId),
        eq(schema.tasks.projectId, guard.projectId),
        sourceIsWakeable,
        or(
          eq(schema.tasks.chatSessionId, guard.chatSessionId),
          exists(
            db
              .select({ id: recoveryOwner.id })
              .from(recoveryOwner)
              .where(
                and(
                  eq(recoveryOwner.recoverySourceTaskId, guard.taskId),
                  eq(recoveryOwner.projectId, guard.projectId),
                  eq(recoveryOwner.chatSessionId, guard.chatSessionId),
                  eq(recoveryOwner.triggeredBy, 'session-recovery'),
                  notInArray(recoveryOwner.status, ['completed', 'failed', 'cancelled'])
                )
              )
          )
        )
      )
    )
    .get();
  return Boolean(task);
}

export const SESSION_RECOVERY_INITIAL_PROMPT =
  'Resume this sleeping conversation from the persisted transcript. Do not repeat prior work; wait for and answer the latest queued follow-up message.';

function asVmSize(value: string | null | undefined): VMSize {
  return value === 'small' || value === 'medium' || value === 'large' ? value : DEFAULT_VM_SIZE;
}

function asWorkspaceProfile(value: string | null | undefined): WorkspaceProfile {
  return (VALID_WORKSPACE_PROFILES as readonly string[]).includes(value ?? '')
    ? (value as WorkspaceProfile)
    : DEFAULT_WORKSPACE_PROFILE;
}

function asCredentialSource(value: string | null | undefined): CredentialSource {
  return value === 'project' || value === 'platform' || value === 'self-hosted' ? value : 'user';
}

function asAgentProfileRuntime(value: string | null | undefined): AgentProfileRuntime | null {
  return value === 'vm' || value === 'cf-container' ? value : null;
}

function snapshotAgentType(snapshot: schema.SessionSnapshot): string | null {
  if (!snapshot.manifestJson) return null;
  try {
    const manifest = expectJsonRecord(
      JSON.parse(snapshot.manifestJson),
      'session_recovery.snapshot_manifest'
    );
    return typeof manifest.agentType === 'string' && manifest.agentType.trim()
      ? manifest.agentType.trim()
      : null;
  } catch {
    return null;
  }
}

async function loadRecoveryContext(
  db: Db,
  projectId: string,
  chatSessionId: string
): Promise<RecoveryContext | null> {
  const snapshot = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!snapshot?.workspaceId || snapshot.projectId !== projectId || !snapshot.sleepingAt) {
    return null;
  }

  const [project, workspace, user] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get(),
    db.select().from(schema.workspaces).where(eq(schema.workspaces.id, snapshot.workspaceId)).get(),
    db.select().from(schema.users).where(eq(schema.users.id, snapshot.userId)).get(),
  ]);
  if (!project || !workspace || !user || workspace.userId !== snapshot.userId) return null;

  const sourceTask = await db
    .select()
    .from(schema.tasks)
    .where(
      or(
        eq(schema.tasks.chatSessionId, chatSessionId),
        eq(schema.tasks.workspaceId, snapshot.workspaceId)
      )
    )
    .orderBy(desc(schema.tasks.updatedAt))
    .get();
  return { snapshot, project, workspace, user, sourceTask: sourceTask ?? null };
}

async function createRecoveryTask(
  database: D1Database,
  db: Db,
  context: RecoveryContext,
  chatSessionId: string,
  taskId: string,
  placementResolution: RecoveryPlacementResolution,
  sourceTaskGuard?: SessionRecoverySourceTaskGuard
): Promise<schema.Task> {
  const sourceTaskId =
    sourceTaskGuard?.taskId ??
    context.sourceTask?.recoverySourceTaskId ??
    context.sourceTask?.id ??
    null;
  if (!sourceTaskId) throw new SourceTaskNotWakeableError();
  const requiresLiveSource = sourceTaskGuard ? 1 : 0;

  const existing = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (existing) {
    if (
      existing.projectId === context.project.id &&
      existing.recoverySourceTaskId === sourceTaskId &&
      existing.chatSessionId === chatSessionId &&
      existing.triggeredBy === 'session-recovery'
    ) {
      return existing;
    }
    throw new Error('Recovery task ID is already bound to different work');
  }

  const now = new Date().toISOString();
  const capacityPlacementSnapshot = placementResolution.capacityPlacementSnapshot;
  try {
    // D1 batches are transactional. The INSERT ... SELECT is the parent-state
    // compare-and-set: if the source is terminal or no longer owns this
    // conversation when the transaction begins, every later statement is a
    // no-op because it is conditioned on that insert having succeeded.
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO tasks
             (id, project_id, user_id, chat_session_id, recovery_source_task_id,
              title, description, status, execution_step, priority,
              agent_profile_hint, skill_id, skill_hint, task_mode, output_branch,
              requested_vm_size, requested_vm_size_source,
              resource_requirements_json, resource_requirements_source,
              resolved_reservation_json, credential_attribution_user_id,
              credential_attribution_project_id, credential_attribution_source,
              ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
              triggered_by, created_by, created_at, updated_at)
           SELECT ?, source.project_id, ?, NULL, source.id,
                  COALESCE(NULLIF(source.title, ''), 'Resume conversation'), ?,
                  'queued', 'node_selection', COALESCE(source.priority, 0),
                  COALESCE(source.agent_profile_hint, ?), source.skill_id,
                  source.skill_hint, 'conversation', source.output_branch, ?,
                  COALESCE(source.requested_vm_size_source, 'session-recovery'),
                  source.resource_requirements_json, source.resource_requirements_source,
                  source.resolved_reservation_json,
                  ?,
                  ?,
                  ?,
                  ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
                  'session-recovery', ?, ?, ?
             FROM tasks source
            WHERE source.id = ?
              AND source.project_id = ?
              AND (
                ? = 0
                OR source.status NOT IN ('completed', 'failed', 'cancelled')
                OR (
                  source.status = 'cancelled'
                  AND source.superseded_by_task_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM tasks marked_successor
                     WHERE marked_successor.id = source.superseded_by_task_id
                       AND marked_successor.project_id = source.project_id
                       AND marked_successor.chat_session_id = ?
                       AND marked_successor.triggered_by = 'session-recovery'
                       AND marked_successor.status NOT IN ('completed', 'failed', 'cancelled')
                  )
                )
              )
              AND (
                source.chat_session_id = ?
                OR EXISTS (
                  SELECT 1 FROM tasks owner
                   WHERE owner.recovery_source_task_id = source.id
                     AND owner.project_id = source.project_id
                     AND owner.chat_session_id = ?
                     AND owner.triggered_by = 'session-recovery'
                )
              )
              AND NOT EXISTS (SELECT 1 FROM tasks duplicate WHERE duplicate.id = ?)`
        )
        .bind(
          taskId,
          context.snapshot.userId,
          SESSION_RECOVERY_INITIAL_PROMPT,
          context.workspace.agentProfileHint,
          placementResolution.placement.vmSize,
          placementResolution.credentialAttributionUserId,
          placementResolution.credentialAttributionProjectId,
          placementResolution.credentialAttributionSource,
          ...capacityPlacementSnapshotSqlValues(capacityPlacementSnapshot),
          context.snapshot.userId,
          now,
          now,
          sourceTaskId,
          context.project.id,
          requiresLiveSource,
          chatSessionId,
          chatSessionId,
          chatSessionId,
          taskId
        ),
      database
        .prepare(
          `UPDATE tasks
              SET chat_session_id = NULL,
                  superseded_by_task_id = ?,
                  updated_at = ?
            WHERE chat_session_id = ?
              AND (id = ? OR recovery_source_task_id = ?)
              AND EXISTS (
                SELECT 1 FROM tasks recovery
                 WHERE recovery.id = ?
                   AND recovery.recovery_source_task_id = ?
                   AND recovery.chat_session_id IS NULL
              )`
        )
        .bind(taskId, now, chatSessionId, sourceTaskId, sourceTaskId, taskId, sourceTaskId),
      database
        .prepare(
          `UPDATE workspaces
              SET chat_session_id = NULL, updated_at = ?
            WHERE chat_session_id = ?
              AND EXISTS (
                SELECT 1 FROM tasks recovery
                 WHERE recovery.id = ?
                   AND recovery.recovery_source_task_id = ?
                   AND recovery.chat_session_id IS NULL
              )`
        )
        .bind(now, chatSessionId, taskId, sourceTaskId),
      database
        .prepare(
          `UPDATE tasks
              SET chat_session_id = ?, updated_at = ?
            WHERE id = ?
              AND recovery_source_task_id = ?
              AND chat_session_id IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks source
                 WHERE source.id = ?
                   AND source.project_id = ?
                   AND (
                     ? = 0
                     OR source.status NOT IN ('completed', 'failed', 'cancelled')
                     OR (
                       source.status = 'cancelled'
                       AND source.superseded_by_task_id IS NOT NULL
                       AND EXISTS (
                         SELECT 1 FROM tasks marked_successor
                          WHERE marked_successor.id = source.superseded_by_task_id
                            AND marked_successor.project_id = source.project_id
                            AND marked_successor.chat_session_id = ?
                            AND marked_successor.triggered_by = 'session-recovery'
                            AND marked_successor.status NOT IN ('completed', 'failed', 'cancelled')
                       )
                     )
                   )
              )`
        )
        .bind(
          chatSessionId,
          now,
          taskId,
          sourceTaskId,
          sourceTaskId,
          context.project.id,
          requiresLiveSource,
          chatSessionId
        ),
      database
        .prepare(
          `INSERT INTO task_status_events
             (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
           SELECT ?, recovery.id, NULL, 'queued', 'system', NULL,
                  'Sleeping conversation wake claimed', ?
             FROM tasks recovery
            WHERE recovery.id = ?
              AND recovery.recovery_source_task_id = ?
              AND recovery.chat_session_id = ?`
        )
        .bind(ulid(), now, taskId, sourceTaskId, chatSessionId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw new SourceTaskNotWakeableError();
  } catch (error) {
    // A concurrent retry may have observed the claimed task ID and completed
    // this exact insert. Re-read before treating the batch error as terminal.
    const winner = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (
      winner?.projectId === context.project.id &&
      winner.recoverySourceTaskId === sourceTaskId &&
      winner.chatSessionId === chatSessionId &&
      winner.triggeredBy === 'session-recovery'
    ) {
      return winner;
    }
    throw error;
  }

  const created = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (
    !created ||
    created.recoverySourceTaskId !== sourceTaskId ||
    created.chatSessionId !== chatSessionId
  ) {
    throw new Error('Recovery task was not durably bound after its creation batch');
  }
  return created;
}

async function abandonRecoveryHandoff(
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

async function startRecoveryTask(
  env: Env,
  context: RecoveryContext,
  task: schema.Task,
  chatSessionId: string,
  placementResolution: RecoveryPlacementResolution,
  sourceTaskGuard?: SessionRecoverySourceTaskGuard
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    throw new Error(`Recovery task is already ${task.status}`);
  }
  if (sourceTaskGuard && !(await sourceTaskGuardIsWakeable(db, sourceTaskGuard))) {
    throw new SourceTaskNotWakeableError();
  }
  if (task.status === 'in_progress') return;
  const alreadyStarted = await ensureTaskRunnerStarted(env, task.id);
  if (sourceTaskGuard && !(await sourceTaskGuardIsWakeable(db, sourceTaskGuard))) {
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

  if (sourceTaskGuard && !(await sourceTaskGuardIsWakeable(db, sourceTaskGuard))) {
    throw new SourceTaskNotWakeableError();
  }

  await startTaskRunnerDO(env, {
    taskId: task.id,
    projectId: context.project.id,
    userId: context.snapshot.userId,
    vmSize: asVmSize(context.workspace.vmSize),
    vmLocation:
      context.workspace.vmLocation || context.project.defaultLocation || DEFAULT_VM_LOCATION,
    branch: context.workspace.branch || context.project.defaultBranch,
    defaultBranch: context.project.defaultBranch,
    preferredNodeId: null,
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
    // Unguarded human wakes intentionally do not carry recoverySourceTaskId:
    // that field grants the live-parent revocable-authority contract. Keep the
    // predecessor deletion lineage separately so every TaskRunner boundary can
    // still revalidate that the old runtime is gone before allocating a node.
    recoverySourceTaskId: sourceTaskGuard?.taskId ?? null,
    retrySourceTaskId: task.recoverySourceTaskId ?? null,
  });
}

async function resolveRecoveryPlacement(
  db: Db,
  env: Env,
  context: RecoveryContext,
  taskId: string
): Promise<
  RecoveryPlacementResolution | { error: string; errorKind: 'placement' | 'credentials' }
> {
  const profile = context.workspace.agentProfileHint
    ? await db
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, context.workspace.agentProfileHint))
        .get()
    : null;
  const sourceTask = context.sourceTask;
  const placement = resolveTaskStartPlacement({
    entryPoint: 'session-recovery',
    taskId,
    projectId: context.project.id,
    userId: context.snapshot.userId,
    project: context.project,
    profile: profile
      ? {
          profileId: profile.id,
          agentType: profile.agentType,
          vmSizeOverride: profile.vmSizeOverride,
          provider: profile.provider,
          vmLocation: profile.vmLocation,
          workspaceProfile: profile.workspaceProfile,
          runtime: asAgentProfileRuntime(profile.runtime),
          devcontainerConfigName: profile.devcontainerConfigName,
          taskMode: profile.taskMode,
        }
      : null,
    explicit: {
      vmSize: asVmSize(context.workspace.vmSize),
      vmSizeSource: 'task',
      provider: null,
      vmLocation: context.workspace.vmLocation,
      workspaceProfile: asWorkspaceProfile(context.workspace.workspaceProfile),
      devcontainerConfigName: context.workspace.devcontainerConfigName,
      taskMode: 'conversation',
      agentType: snapshotAgentType(context.snapshot),
      runtime: 'vm',
    },
    inheritedCredentialAttribution: {
      userId: sourceTask?.credentialAttributionUserId ?? context.snapshot.userId,
      projectId: sourceTask?.credentialAttributionProjectId ?? null,
      source: asCredentialSource(sourceTask?.credentialAttributionSource),
    },
    credentialProjectPolicy: 'current-project-unless-inherited',
    taskModeDefault: 'workspace-profile',
    resourceRequirements: {
      task: sourceTask?.resourceRequirementsJson
        ? JSON.parse(sourceTask.resourceRequirementsJson)
        : undefined,
    },
  });

  return resolveTaskStartPlacementCredentialAttributionFromPlacement(db, placement, {
    credentialsRequiredMessage:
      'Cloud provider credentials required. Connect an account in Settings or enable a platform credential.',
    env,
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
  sourceTaskGuard?: SessionRecoverySourceTaskGuard
): Promise<SessionRecoveryResult> {
  const db = drizzle(env.DATABASE, { schema });
  const context = await loadRecoveryContext(db, projectId, chatSessionId);
  if (!context) return { status: 'unavailable', reason: 'sleeping_snapshot_missing' };
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
    const resolved = await resolveRecoveryPlacement(db, env, context, recoveryTaskId);
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
      sourceTaskGuard
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
