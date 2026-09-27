import { DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS } from '@simple-agent-manager/shared';

import { parsePositiveInt } from '../../lib/route-helpers';
import { classifySessionIdleness, parseHarnessWorkConfig } from '../../services/session-idleness';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from '../../services/session-snapshot-artifacts';
import { isSleepPreservedTerminalTaskStatus } from '../../services/sleep-preserved-task-status';
import { getSessionState } from './session-state';
import type { Env } from './types';

/**
 * Local, bounded safety check immediately before automatic ledger closure.
 *
 * Applies to every terminal status whose conversation is kept by sleep
 * (`SLEEP_PRESERVED_TERMINAL_TASK_STATUSES`): a completed task's final turn, and
 * a failed task's work-preservation window, belong to the sleep lifecycle until
 * it has had a bounded chance to run. A `cancelled` task is not protected.
 */
export function isCompletingSessionProtected(
  sql: SqlStorage,
  env: Env,
  session: { id: string; workspaceId: string | null },
  task: { status: string; completed_at: string | null; updated_at: string | null },
  now: Date
): boolean {
  if (!isSleepPreservedTerminalTaskStatus(task.status)) return false;
  const idleAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const completedAt = Date.parse(task.completed_at ?? task.updated_at ?? '');
  // Completion happens inside the prompt. Its activity transition can predate
  // completion by hours, or the activity mirror may not have arrived yet. Give
  // that finishing turn a bounded drain interval anchored to completion itself.
  // A failure is anchored the same way, on the moment the task went terminal.
  if (Number.isFinite(completedAt) && completedAt + idleAfterMs > now.getTime()) return true;

  const sessions = sql
    .exec<{ id: string }>(
      `SELECT id FROM acp_sessions
      WHERE chat_session_id = ? AND workspace_id IS ?
        AND status IN ('assigned', 'running')
      ORDER BY created_at DESC, id DESC LIMIT ?`,
      session.id,
      session.workspaceId,
      parsePositiveInt(env.TASK_LIVENESS_MAX_ACP_SESSIONS, DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS)
    )
    .toArray();
  for (const acp of sessions) {
    const state = getSessionState(sql, acp.id);
    if (!state) continue;
    const idleness = classifySessionIdleness({
      taskStatus: task.status,
      taskCompletedAt: task.completed_at ?? task.updated_at,
      state,
      now,
      idleAfterMs,
      harnessWorkConfig: parseHarnessWorkConfig(env),
      policy: 'prompt-turn-ended',
    });
    // Unknown/absent state cannot pin an old completed task forever. Recent
    // completion is protected above; stale known work uses the canonical leases.
    if (!idleness.idle && idleness.conclusive) return true;
  }
  return false;
}
