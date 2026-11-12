/** Exact committed wake activation and delivery scheduling; prompt admission remains authoritative. */
import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { buildSessionLifecycleEventInput } from '../../services/project-lifecycle-event-inputs';
import { nudgePromptDeliveriesForTarget } from './prompt-delivery';
import {
  beginSessionWakeActivation,
  commitSessionWakeActivation,
} from './session-wake-activation-guard';

export interface SessionWakeReadyInput {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  agentSessionId: string;
  /** Producer timestamp immediately after the committed runtime-ready transition. */
  runtimeReadyAt?: number;
  /** Resolver capture; legacy producers can validate the current committed runtime directly. */
  expectedRuntime?: { nodeId: string; workspaceCallbackGeneration: string | null };
  fence:
    | { runtime: 'vm'; taskId: string; recoveryAttemptId: string }
    | { runtime: 'cf-container'; nodeId: string; runtimeIncarnationId: string };
}

export { isSessionWakeReadyCurrent } from '../../services/session-wake-ready-authority';

/** Capture before D1 I/O: a concurrent stop, relink or later sleep must win. */
export function captureSessionWakeActivation(
  sql: SqlStorage,
  input: SessionWakeReadyInput
): string | null {
  if (input.fence.runtime !== 'vm') return null;
  return beginSessionWakeActivation(
    sql,
    input.chatSessionId,
    input.workspaceId,
    JSON.stringify(input.fence)
  );
}

/** Exact D1 handoff already checked; the local lifecycle still has to match its capture. */
export function activateSessionWakeReady(
  sql: SqlStorage,
  input: SessionWakeReadyInput,
  guard: string | null,
  now: number
): boolean {
  return commitSessionWakeActivation(sql, input.chatSessionId, input.workspaceId, guard, now);
}

/** A successful transport must not turn rejected local lifecycle authority into readiness. */
export function isSessionWakeReadyLocallyAccepted(
  sql: SqlStorage,
  input: SessionWakeReadyInput
): boolean {
  const row = sql
    .exec('SELECT status, workspace_id FROM chat_sessions WHERE id = ?', input.chatSessionId)
    .toArray()[0];
  return (
    row?.workspace_id === input.workspaceId &&
    (row.status === 'active' ||
      (row.status === 'sleeping' && input.fence.runtime === 'cf-container'))
  );
}

/** Preserve the existing lifecycle event at activation rather than workspace linkage. */
export async function recordSessionWakeActivation(
  input: SessionWakeReadyInput,
  now: number,
  admit: (event: AdmitProjectEventInput) => unknown
): Promise<void> {
  try {
    admit(
      await buildSessionLifecycleEventInput({
        projectId: input.projectId,
        sessionId: input.chatSessionId,
        lifecycle: 'woke',
        status: 'active',
        taskId: input.fence.runtime === 'vm' ? input.fence.taskId : null,
        workspaceId: input.workspaceId,
        source: 'project_data.snapshot_recovery_wake_session',
        occurredAt: now,
      })
    );
  } catch (error) {
    log.warn('project_data.session_lifecycle_event_failed', {
      projectId: input.projectId,
      sessionId: input.chatSessionId,
      lifecycle: 'woke',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Synchronous after authority read: dedup + attempt marker + deadline update share one transaction. */
export function applySessionWakeReady(
  sql: SqlStorage,
  input: SessionWakeReadyInput,
  now: number
): number {
  if (!isSessionWakeReadyLocallyAccepted(sql, input)) return 0;
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
