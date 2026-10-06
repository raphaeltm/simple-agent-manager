import type { Env } from '../env';
import { ensureSessionRecovery, type SessionRecoveryResult } from './session-recovery';

export interface WorkspaceEvictionRecoveryIdentity {
  projectId: string;
  workspaceId: string;
  chatSessionId: string;
  nodeId: string;
  generation: string | null;
}

/**
 * Turn a completed resource eviction into the ordinary durable wake flow.
 * The snapshot update is fenced by workspace/node/generation, so a stale VM
 * callback cannot put a successor runtime back to sleep. Recovery itself uses
 * the snapshot's existing task claim, making callback replay idempotent.
 */
export async function recoverWorkspaceAfterEviction(
  env: Env,
  identity: WorkspaceEvictionRecoveryIdentity
): Promise<SessionRecoveryResult> {
  const now = new Date().toISOString();
  const sleeping = await env.DATABASE.prepare(
    `UPDATE session_snapshots
        SET sleeping_at = COALESCE(sleeping_at, ?),
            recovery_status = CASE WHEN sleeping_at IS NULL THEN NULL ELSE recovery_status END,
            recovery_error = CASE WHEN sleeping_at IS NULL THEN NULL ELSE recovery_error END,
            recovery_attempts = CASE WHEN sleeping_at IS NULL THEN 0 ELSE recovery_attempts END,
            recovery_failed_at = CASE WHEN sleeping_at IS NULL THEN NULL ELSE recovery_failed_at END,
            eviction_recovery_workspace_id = ?, eviction_recovery_node_id = ?,
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
        )`
  )
    .bind(
      now,
      identity.workspaceId,
      identity.nodeId,
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
      identity.generation
    )
    .run();

  if ((sleeping.meta.changes ?? 0) === 0) {
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

  return ensureSessionRecovery(env, identity.projectId, identity.chatSessionId, undefined, {
    excludedNodeId: identity.nodeId,
    evictionFence: {
      workspaceId: identity.workspaceId,
      nodeId: identity.nodeId,
      generation: identity.generation,
    },
  });
}
