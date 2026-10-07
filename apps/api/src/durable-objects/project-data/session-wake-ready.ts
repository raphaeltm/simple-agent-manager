/** Scheduling hint from a committed wake; delivery admission remains authoritative. */
import type { Env } from '../../env';
import { nudgePromptDeliveriesForTarget } from './prompt-delivery';

export interface SessionWakeReadyInput {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  agentSessionId: string;
  /** Producer timestamp immediately after the committed runtime-ready transition. */
  runtimeReadyAt?: number;
  fence:
    | { runtime: 'vm'; taskId: string; recoveryAttemptId: string }
    | { runtime: 'cf-container'; nodeId: string; runtimeIncarnationId: string };
}

/** Validate the exact committed recovery, never infer readiness from a browser delta. */
export async function isSessionWakeReadyCurrent(
  env: Pick<Env, 'DATABASE'>,
  input: SessionWakeReadyInput
): Promise<boolean> {
  const common = `SELECT 1 AS ready FROM workspaces w
    JOIN nodes n ON n.id = w.node_id
    JOIN agent_sessions a ON a.workspace_id = w.id
    WHERE w.id = ? AND w.project_id = ? AND w.chat_session_id = ?
      AND a.id = ? AND a.status = 'running' AND w.status = 'running'
      AND n.status = 'running' AND w.runtime_deletion_confirmed_at IS NULL`;
  const values = [input.workspaceId, input.projectId, input.chatSessionId, input.agentSessionId];
  const fence = input.fence;
  const query =
    fence.runtime === 'vm'
      ? env.DATABASE.prepare(
          `${common} AND n.runtime = 'vm'
        AND EXISTS (SELECT 1 FROM session_snapshots s JOIN tasks t ON t.id = s.recovery_task_id
          WHERE s.chat_session_id = w.chat_session_id AND s.project_id = w.project_id
            AND s.recovery_status = 'restored' AND s.recovery_workspace_id = w.id
            AND s.recovery_task_id = ? AND s.recovery_attempt_id = ?
            AND t.project_id = w.project_id AND t.chat_session_id = w.chat_session_id
            AND t.status IN ('in_progress', 'awaiting_followup'))`
        ).bind(...values, fence.taskId, fence.recoveryAttemptId)
      : env.DATABASE.prepare(
          `${common} AND n.runtime = 'cf-container'
        AND n.id = ? AND n.runtime_incarnation_id = ?`
        ).bind(...values, fence.nodeId, fence.runtimeIncarnationId);
  return (await query.first<{ ready: number }>())?.ready === 1;
}

/** Synchronous after authority read: dedup + attempt marker + deadline update share one transaction. */
export function applySessionWakeReady(
  sql: SqlStorage,
  input: SessionWakeReadyInput,
  now: number
): number {
  const session = sql
    .exec('SELECT status, workspace_id FROM chat_sessions WHERE id = ?', input.chatSessionId)
    .toArray()[0];
  if (
    !(
      session?.status === 'active' ||
      (session?.status === 'sleeping' && input.fence.runtime === 'cf-container')
    ) ||
    session.workspace_id !== input.workspaceId
  )
    return 0;
  const token = JSON.stringify(input.fence);
  const previous = sql
    .exec('SELECT fence FROM session_wake_readiness WHERE session_id = ?', input.chatSessionId)
    .toArray()[0];
  if (previous?.fence === token) return 0;
  sql.exec(
    `INSERT INTO session_wake_readiness (session_id, fence, ready_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET fence = excluded.fence, ready_at = excluded.ready_at`,
    input.chatSessionId,
    token,
    input.runtimeReadyAt ?? now
  );
  // A preparing claim can time out after readiness. Only this exact pre-send attempt gets one
  // immediate retry; submitting/receipt-reconciliation claims are never released or replayed.
  const preparing = sql.exec(
    `UPDATE session_inbox SET wake_ready_attempt_id = attempt_id
    WHERE target_session_id = ? AND delivery_state = 'delivering'
      AND prompt_delivery_phase = 'preparing' AND expires_at > ?`,
    input.chatSessionId,
    now
  ).rowsWritten;
  return preparing + nudgePromptDeliveriesForTarget(sql, input.chatSessionId, now);
}
