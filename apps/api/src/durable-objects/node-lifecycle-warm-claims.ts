/**
 * Warm-node claim bookkeeping on D1 `tasks`, used by NodeLifecycle's serialized
 * claim/release transitions. One conditional write both proves live recovery
 * authority and records the exact node claim.
 */
import {
  isSessionRecoveryTaskAuthorized,
  type SessionRecoverySourceTaskGuard,
  sourceProjectMemberAuthoritySql,
} from '../services/session-recovery-authority';
import type { NodeLifecycleEnv } from './node-lifecycle-types';

export async function persistWarmNodeClaim(
  env: NodeLifecycleEnv,
  nodeId: string,
  taskId: string,
  sourceTaskGuard?: SessionRecoverySourceTaskGuard
): Promise<'claimed' | 'unavailable' | 'source_task_revoked'> {
  const now = new Date().toISOString();
  const guarded = sourceTaskGuard ? 1 : 0;
  const result = await env.DATABASE.prepare(
    `UPDATE tasks AS recovery
        SET claimed_warm_node_at = CASE
              WHEN recovery.claimed_warm_node_id = ?
               AND recovery.claimed_warm_node_at IS NOT NULL
                THEN recovery.claimed_warm_node_at
              ELSE ?
            END,
            claimed_warm_node_id = ?, updated_at = ?
      WHERE recovery.id = ?
        AND recovery.status NOT IN ('completed', 'failed', 'cancelled')
        AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND status = 'running')
        AND NOT EXISTS (
          SELECT 1 FROM tasks incumbent
           WHERE incumbent.claimed_warm_node_id = ?
             AND incumbent.id != recovery.id
             AND incumbent.status NOT IN ('completed', 'failed', 'cancelled')
        )
        AND (
          ? = 0
          OR (
            recovery.recovery_source_task_id = ?
            AND recovery.project_id = ?
            AND recovery.chat_session_id = ?
            AND recovery.triggered_by = 'session-recovery'
            AND EXISTS (
              SELECT 1 FROM tasks source
               WHERE source.id = ?
                 AND source.project_id = recovery.project_id
                 ${sourceTaskGuard?.projectEventWake ? sourceProjectMemberAuthoritySql() : ''}
                 ${
                   sourceTaskGuard?.requiredProjectMemberId
                     ? `AND EXISTS (
                   SELECT 1 FROM project_members scheduled_member
                     JOIN users scheduled_user ON scheduled_user.id = scheduled_member.user_id
                   WHERE scheduled_member.project_id = recovery.project_id
                     AND scheduled_member.user_id = ?
                     AND scheduled_member.status = 'active' AND scheduled_user.status = 'active'
                     AND scheduled_member.role IN ('owner','admin','maintainer')
                 )`
                     : ''
                 }
                 AND (
                   source.status NOT IN ('completed', 'failed', 'cancelled')
                   OR (
                     source.status = 'cancelled'
                     AND source.superseded_by_task_id = recovery.id
                   )
                 )
            )
            AND EXISTS (
              SELECT 1 FROM session_snapshots snapshot
               WHERE snapshot.chat_session_id = recovery.chat_session_id
                 AND snapshot.project_id = recovery.project_id
                 AND snapshot.recovery_task_id = recovery.id
                 AND snapshot.recovery_status IN ('waking', 'restored')
            )
          )
        )`
  )
    .bind(
      nodeId,
      now,
      nodeId,
      now,
      taskId,
      nodeId,
      nodeId,
      guarded,
      sourceTaskGuard?.taskId ?? '',
      sourceTaskGuard?.projectId ?? '',
      sourceTaskGuard?.chatSessionId ?? '',
      sourceTaskGuard?.taskId ?? '',
      ...(sourceTaskGuard?.requiredProjectMemberId ? [sourceTaskGuard.requiredProjectMemberId] : [])
    )
    .run();
  if ((result.meta.changes ?? 0) > 0) return 'claimed';
  if (!sourceTaskGuard) return 'unavailable';
  const authorized = await isSessionRecoveryTaskAuthorized(env.DATABASE, {
    recoveryTaskId: taskId,
    sourceTaskId: sourceTaskGuard.taskId,
    projectId: sourceTaskGuard.projectId,
    chatSessionId: sourceTaskGuard.chatSessionId,
    projectEventWake: sourceTaskGuard.projectEventWake,
    requiredProjectMemberId: sourceTaskGuard.requiredProjectMemberId,
  });
  return authorized ? 'unavailable' : 'source_task_revoked';
}

export async function clearWarmNodeClaim(
  env: NodeLifecycleEnv,
  taskId: string,
  nodeId: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE tasks
        SET claimed_warm_node_id = NULL, claimed_warm_node_at = NULL, updated_at = ?
      WHERE id = ? AND claimed_warm_node_id = ?`
  )
    .bind(new Date().toISOString(), taskId, nodeId)
    .run();
}
