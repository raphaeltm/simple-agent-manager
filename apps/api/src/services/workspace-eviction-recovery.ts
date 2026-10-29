import type { Env } from '../env';
import { ensureSessionRecovery, type SessionRecoveryResult } from './session-recovery';

export interface WorkspaceEvictionRecoveryIdentity {
  projectId: string;
  workspaceId: string;
  chatSessionId: string;
  nodeId: string;
  generation: string | null;
  interruptedWork?: boolean;
}

/**
 * Turn a completed resource eviction into the ordinary durable wake flow.
 * The snapshot update is fenced by workspace/node/generation, so a stale VM
 * callback cannot put a successor runtime back to sleep. Recovery itself uses
 * the snapshot's existing task claim, making callback replay idempotent.
 */
export function evictedWorkspaceSnapshotSleepStatement(
  database: D1Database,
  identity: WorkspaceEvictionRecoveryIdentity,
  now: string,
  claimedAt: string | null = null
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE session_snapshots
        SET sleeping_at = COALESCE(sleeping_at, ?),
            recovery_status = CASE WHEN sleeping_at IS NULL THEN NULL ELSE recovery_status END,
            recovery_error = CASE WHEN sleeping_at IS NULL THEN NULL ELSE recovery_error END,
            recovery_attempts = CASE WHEN sleeping_at IS NULL THEN 0 ELSE recovery_attempts END,
            recovery_failed_at = CASE WHEN sleeping_at IS NULL THEN NULL ELSE recovery_failed_at END,
            eviction_recovery_workspace_id = ?, eviction_recovery_node_id = ?,
            eviction_recovery_interrupted_work = CASE
              WHEN sleeping_at IS NULL OR eviction_recovery_workspace_id IS NOT ?
                OR eviction_recovery_node_id IS NOT ? OR eviction_recovery_generation IS NOT ?
              THEN ? ELSE eviction_recovery_interrupted_work END,
            eviction_recovery_generation = ?,
            sleep_status = 'sleeping', sleep_after = NULL, sleep_error = NULL,
            sleep_claim_id = NULL, sleep_claimed_at = NULL, updated_at = ?
      WHERE chat_session_id = ?
        AND workspace_id = ?
        AND project_id = ?
        AND status IN ('available', 'degraded')
        AND (
          sleeping_at IS NOT NULL OR recovery_status IS NULL OR recovery_status = ?
          OR eviction_recovery_workspace_id IS NOT ?
          OR eviction_recovery_node_id IS NOT ?
          OR eviction_recovery_generation IS NOT ?
        )
        AND EXISTS (
          SELECT 1 FROM workspaces
           WHERE id = ? AND node_id = ?
             AND eviction_generation IS ? AND status = 'evicted'
             AND (? IS NULL OR (
               updated_at = ? AND user_id = session_snapshots.user_id
               AND project_id = session_snapshots.project_id
               AND chat_session_id = session_snapshots.chat_session_id
             ))
        )`
    )
    .bind(
      now,
      identity.workspaceId,
      identity.nodeId,
      identity.workspaceId,
      identity.nodeId,
      identity.generation,
      identity.interruptedWork === undefined ? null : Number(identity.interruptedWork),
      identity.generation,
      now,
      identity.chatSessionId,
      identity.workspaceId,
      identity.projectId,
      'failed',
      identity.workspaceId,
      identity.nodeId,
      identity.generation,
      identity.workspaceId,
      identity.nodeId,
      identity.generation,
      claimedAt,
      claimedAt
    );
}

export async function markEvictedWorkspaceSnapshotSleeping(
  env: Env,
  identity: WorkspaceEvictionRecoveryIdentity
): Promise<boolean> {
  const sleeping = await evictedWorkspaceSnapshotSleepStatement(
    env.DATABASE,
    identity,
    new Date().toISOString()
  ).run();
  return (sleeping.meta.changes ?? 0) > 0;
}

export async function recoverWorkspaceAfterEviction(
  env: Env,
  identity: WorkspaceEvictionRecoveryIdentity
): Promise<SessionRecoveryResult> {
  const sleeping = await markEvictedWorkspaceSnapshotSleeping(env, identity);
  if (!sleeping) {
    const completed = await env.DATABASE.prepare(
      `SELECT recovery_task_id AS recoveryTaskId
         FROM session_snapshots
        WHERE chat_session_id = ? AND project_id = ?
          AND sleeping_at IS NULL AND recovery_status = 'restored'
          AND recovery_task_id IS NOT NULL
          AND eviction_recovery_workspace_id IS ?
          AND eviction_recovery_node_id IS ?
          AND eviction_recovery_generation IS ?
          AND EXISTS (
            SELECT 1 FROM workspaces
             WHERE id = ? AND node_id = ?
               AND eviction_generation IS ? AND status = 'evicted'
          )`
    )
      .bind(
        identity.chatSessionId,
        identity.projectId,
        identity.workspaceId,
        identity.nodeId,
        identity.generation,
        identity.workspaceId,
        identity.nodeId,
        identity.generation
      )
      .first<{ recoveryTaskId: string }>();
    if (completed?.recoveryTaskId) {
      return { status: 'waking', taskId: completed.recoveryTaskId };
    }
    return { status: 'unavailable', reason: 'eviction_snapshot_missing_or_stale' };
  }

  const evidence = await env.DATABASE.prepare(
    `SELECT eviction_recovery_interrupted_work AS interruptedWork FROM session_snapshots
      WHERE chat_session_id = ? AND project_id = ? AND workspace_id = ?
        AND eviction_recovery_workspace_id = ? AND eviction_recovery_node_id = ?
        AND eviction_recovery_generation IS ?`
  )
    .bind(
      identity.chatSessionId,
      identity.projectId,
      identity.workspaceId,
      identity.workspaceId,
      identity.nodeId,
      identity.generation
    )
    .first<{ interruptedWork: number | null }>();
  if (!evidence) return { status: 'unavailable', reason: 'eviction_snapshot_missing_or_stale' };

  return ensureSessionRecovery(env, identity.projectId, identity.chatSessionId, undefined, {
    excludedNodeId: identity.nodeId,
    evictionFence: {
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      generation: identity.generation,
    },
    // Eviction kills the runtime mid-work; no message is queued for the agent.
    wakeCause: 'runtime_lost',
    interruptedWork: evidence.interruptedWork === null ? undefined : evidence.interruptedWork === 1,
  });
}
