import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import { PlacementResolutionError } from './placement-resolution-error';
import {
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
} from './placement-resolver';
import {
  assertReplacementDeletionConfirmed,
  WorkspaceDeletionUnconfirmedError,
} from './replacement-deletion-fence';
import { loadRecoveryContext, type RecoveryContext } from './session-recovery-context';
import {
  evictionRecoveryFenceMatches,
  type SessionRecoveryOptions,
} from './session-recovery-eviction';
import {
  recordSessionRecoveryRefusal,
  type SessionRecoveryResult,
} from './session-recovery-refusal-report';
import {
  buildRecoveryPlacementInput,
  type RecoveryPlacementResolution,
} from './session-recovery-request';
import { startRecoveryTask } from './session-recovery-task';
import { type Db, SourceTaskNotWakeableError } from './session-recovery-task-guard';
import {
  claimSessionSnapshotRecovery,
  failSessionSnapshotRecovery,
  sessionLifecycleError,
  type SessionRecoverySourceTaskGuard,
} from './session-snapshots';
import { ensureTaskRunnerStarted } from './task-runner-do';

export {
  reportSessionRecoveryRefusal,
  type SessionRecoveryResult,
} from './session-recovery-refusal-report';
export { SESSION_RECOVERY_INITIAL_PROMPT } from './session-recovery-task';

// The node-pool boundary inventory (`scripts/quality/node-pool-boundary/inventory-data.ts`)
// requires the module that holds this tasks-INSERT writer to also call
// `resolveTaskStartPlacement*` and `ensureTaskRunnerStarted`. Keep the writer beside
// `resolveRecoveryPlacement` and `ensureSessionRecovery` when splitting this file.
async function reactivateSleepingTask(
  database: D1Database,
  db: Db,
  context: RecoveryContext,
  chatSessionId: string,
  taskId: string,
  placementResolution: RecoveryPlacementResolution
): Promise<schema.Task> {
  const existing = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!existing || existing.projectId !== context.project.id) {
    throw new SourceTaskNotWakeableError();
  }
  if (existing.chatSessionId !== chatSessionId && existing.workspaceId !== context.snapshot.workspaceId) {
    throw new SourceTaskNotWakeableError();
  }

  const now = new Date().toISOString();
  const capacityPlacementSnapshot = placementResolution.capacityPlacementSnapshot;
  try {
    // D1 batches are transactional. The task update is the parent-state
    // compare-and-set: if the stable task is terminal or no longer owns this
    // conversation when the transaction begins, every later statement is a no-op.
    const results = await database.batch([
      database
        .prepare(
          `UPDATE tasks
              SET status = 'queued',
                  execution_step = 'node_selection',
                  workspace_id = NULL,
                  auto_provisioned_node_id = NULL,
                  claimed_warm_node_id = NULL,
                  claimed_warm_node_at = NULL,
                  requested_vm_size = ?,
                  requested_vm_size_source = COALESCE(requested_vm_size_source, 'session-recovery'),
                  credential_attribution_user_id = ?,
                  credential_attribution_project_id = ?,
                  credential_attribution_source = ?,
                  ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS},
                  updated_at = ?
            WHERE id = ?
              AND project_id = ?
              AND status NOT IN ('completed', 'failed', 'cancelled')
              AND (
                chat_session_id = ?
                OR workspace_id = ?
              )`
        )
        .bind(
          placementResolution.placement.vmSize,
          placementResolution.credentialAttributionUserId,
          placementResolution.credentialAttributionProjectId,
          placementResolution.credentialAttributionSource,
          ...capacityPlacementSnapshotSqlValues(capacityPlacementSnapshot),
          now,
          taskId,
          context.project.id,
          chatSessionId,
          context.snapshot.workspaceId
        ),
      database
        .prepare(
          `UPDATE workspaces
              SET chat_session_id = NULL, updated_at = ?
            WHERE id = ?
              AND chat_session_id = ?
              AND EXISTS (
                SELECT 1 FROM tasks task
                 WHERE task.id = ?
                   AND task.status = 'queued'
              )`
        )
        .bind(now, context.snapshot.workspaceId, chatSessionId, taskId),
      database
        .prepare(
          `INSERT INTO task_status_events
             (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
           SELECT ?, task.id, ?, 'queued', 'system', NULL,
                  'Sleeping conversation wake claimed', ?
             FROM tasks task
            WHERE task.id = ?
              AND task.status = 'queued'`
        )
        .bind(ulid(), existing.status, now, taskId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw new SourceTaskNotWakeableError();
  } catch (error) {
    // A concurrent retry may have observed the claimed task ID and completed
    // this exact reactivation. Re-read before treating the batch error as terminal.
    const winner = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (
      winner?.projectId === context.project.id &&
      winner.chatSessionId === chatSessionId &&
      winner.status === 'queued'
    ) {
      return winner;
    }
    throw error;
  }

  const created = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (
    !created ||
    created.chatSessionId !== chatSessionId ||
    created.status !== 'queued'
  ) {
    throw new Error('Sleeping task was not durably reactivated after its wake batch');
  }
  return created;
}

async function resolveRecoveryPlacement(
  db: Db,
  env: Env,
  context: RecoveryContext,
  taskId: string,
  options: SessionRecoveryOptions = {}
): Promise<RecoveryPlacementResolution | { error: string; reason: string }> {
  const input = await buildRecoveryPlacementInput(db, env, context, taskId, options);
  if ('error' in input) return input;
  let placement;
  try {
    placement = resolveTaskStartPlacement(input);
  } catch (error) {
    if (error instanceof PlacementResolutionError) {
      return { error: error.message, reason: 'placement_unsatisfiable' };
    }
    throw error;
  }

  const resolved = await resolveTaskStartPlacementCredentialAttributionFromPlacement(
    db,
    placement,
    {
      credentialsRequiredMessage:
        'Cloud provider credentials required. Connect an account in Settings or enable a platform credential.',
      env,
    }
  );
  if ('error' in resolved) {
    return {
      error: resolved.error,
      reason:
        resolved.errorKind === 'credentials'
          ? 'placement_credentials_missing'
          : 'placement_unsatisfiable',
    };
  }
  return resolved;
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
  const refuse = (reason: string, detail?: string | null) =>
    recordSessionRecoveryRefusal(db, env, chatSessionId, reason, detail);
  const context = await loadRecoveryContext(db, projectId, chatSessionId);
  if (!context) return refuse('sleeping_snapshot_missing');
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
        return refuse('workspace_deletion_unconfirmed');
      }
      throw error;
    }
  }

  const recoveryTaskId = context.sourceTask?.id ?? sourceTaskGuard?.taskId ?? null;
  if (!recoveryTaskId) {
    return refuse('source_task_not_wakeable');
  }
  let placementResolution: RecoveryPlacementResolution;
  try {
    const resolved = await resolveRecoveryPlacement(db, env, context, recoveryTaskId, options);
    if ('error' in resolved) {
      return refuse(resolved.reason, resolved.error);
    }
    placementResolution = resolved;
  } catch (error) {
    log.warn('session_recovery.placement_resolution_deferred', {
      projectId,
      chatSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return refuse('session_recovery_placement_lookup_failed');
  }

  const claim = await claimSessionSnapshotRecovery(db, env, {
    chatSessionId,
    userId: context.snapshot.userId,
    taskId: recoveryTaskId,
    sourceTaskGuard,
  });
  if (claim.status === 'unavailable') return refuse(claim.reason);
  if (claim.status === 'waking') return claim;
  const claimedTaskId = recoveryTaskId;

  if (options.evictionFence && !(await evictionRecoveryFenceMatches(env, options.evictionFence))) {
    await failSessionSnapshotRecovery(
      db,
      env,
      chatSessionId,
      claimedTaskId,
      'Eviction generation changed before recovery start'
    );
    return { status: 'unavailable', reason: 'stale_eviction_generation' };
  }

  let recoveryTask: schema.Task | null = null;
  try {
    recoveryTask = await reactivateSleepingTask(
      env.DATABASE,
      db,
      context,
      chatSessionId,
      claimedTaskId,
      placementResolution
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
      await failSessionSnapshotRecovery(db, env, chatSessionId, claimedTaskId, message);
      return refuse('source_task_not_wakeable', message);
    }
    if (await ensureTaskRunnerStarted(env, claimedTaskId).catch(() => false)) {
      log.warn('session_recovery.start_response_ambiguous_but_durable', {
        projectId,
        chatSessionId,
        taskId: claimedTaskId,
        error: message,
      });
      return { status: 'waking', taskId: claimedTaskId };
    }
    const failure = sessionLifecycleError(env, `Session recovery failed: ${message}`);
    await failSessionSnapshotRecovery(db, env, chatSessionId, claimedTaskId, failure);
    log.error('session_recovery.start_failed', {
      projectId,
      chatSessionId,
      taskId: claimedTaskId,
      error: message,
    });
    return refuse(`recovery_start_failed:${message}`, message);
  }
}
