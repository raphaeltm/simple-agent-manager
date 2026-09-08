import { DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS } from '@simple-agent-manager/shared';

import { parsePositiveInt } from '../../lib/route-helpers';
import { classifySessionIdleness, parseHarnessWorkConfig } from '../../services/session-idleness';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from '../../services/session-snapshot-artifacts';
import { getSessionState } from './session-state';
import type { Env } from './types';

/** Local, bounded safety check immediately before automatic ledger closure. */
export function isCompletingSessionProtected(
  sql: SqlStorage,
  env: Env,
  session: { id: string; workspaceId: string | null },
  task: { status: string; completed_at: string | null; updated_at: string | null },
  now: Date
): boolean {
  if (task.status !== 'completed') return false;
  const idleAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const completedAt = Date.parse(task.completed_at ?? task.updated_at ?? '');
  // Completion happens inside the prompt. Its activity transition can predate
  // completion by hours, or the activity mirror may not have arrived yet. Give
  // that finishing turn a bounded drain interval anchored to completion itself.
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
