/**
 * Session State Mirror read operations. Split out of `session-state.ts`
 * (`.claude/rules/18-file-size-limits.md`); re-exported from there.
 */
import type {
  PlanEntry,
  SessionActivitySource,
  SessionActivityTerminalReason,
  SessionStateSnapshot,
} from '@simple-agent-manager/shared';

import { WORKING_ACTIVITIES } from './session-state-prompt';

/**
 * A chat's activity, resolved the way the chat view resolves it (`resolveChatAgentState` in
 * apps/api `routes/chat-agent-state.ts`): the newest ACP session's state row, else the row
 * keyed by the chat itself. Over `cs` = chat_sessions. "Newest" is `created_at DESC, id DESC`,
 * the same order `listAcpSessions` (`acp-sessions.ts`) uses, so a same-millisecond tie resolves
 * to the same session in both.
 */
const CHAT_ACTIVITY_SQL = `COALESCE(
    (SELECT s.activity FROM session_state s
      WHERE s.session_id = (SELECT a.id FROM acp_sessions a
                             WHERE a.chat_session_id = cs.id
                             ORDER BY a.created_at DESC, a.id DESC LIMIT 1)),
    (SELECT s.activity FROM session_state s WHERE s.session_id = cs.id))`;

/**
 * Awake chats whose agent is mid-turn: the activity mirror says a prompt is in flight
 * (`WORKING_ACTIVITIES`). This is the Project Overview's "Running now" signal. It replaced a
 * predicate on `tasks.execution_step` and `chat_sessions.agent_completed_at`: the step latches
 * at `awaiting_followup` after the first turn and nothing writes `agent_completed_at`, so that
 * predicate meant "still on its first turn" (rule 74).
 *
 * Bounded by `status = 'active'`: each awake chat holds a live runtime, so the set is the
 * project's running agents, not its history (`idx_chat_sessions_status`).
 */
export function listWorkingChatSessionIds(sql: SqlStorage): string[] {
  // Assembled only from module constants; every value is bound. Named `whereClause` because
  // `scripts/quality/ast-checks.ts` allowlists that identifier for exactly this shape.
  const whereClause = `cs.status = 'active' AND ${CHAT_ACTIVITY_SQL} IN (${WORKING_ACTIVITIES.map(() => '?').join(', ')})`;
  const rows = sql
    .exec(
      `SELECT cs.id FROM chat_sessions cs WHERE ${whereClause} ORDER BY cs.id`,
      ...WORKING_ACTIVITIES
    )
    .toArray();
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function getSessionState(sql: SqlStorage, sessionId: string): SessionStateSnapshot | null {
  const rows = sql
    .exec(
      `SELECT activity, activity_at, status_error, current_plan_json, plan_updated_at,
              prompt_started_at, last_stop_reason, agent_type,
              activity_source, activity_reason,
              runtime_work_state, runtime_work_count, runtime_work_source,
              runtime_work_updated_at, runtime_work_progress_at, work_at, reported_prompt_started_at,
              steering_supported
       FROM session_state WHERE session_id = ?`,
      sessionId
    )
    .toArray();

  const row = rows[0];
  if (!row) return null;

  let currentPlan = null;
  if (row.current_plan_json && typeof row.current_plan_json === 'string') {
    try {
      currentPlan = JSON.parse(row.current_plan_json);
    } catch {
      // Corrupted plan JSON — treat as no plan
    }
  }

  return {
    activity: (row.activity as SessionStateSnapshot['activity']) || 'idle',
    activityAt: (row.activity_at as number) || 0,
    statusError: (row.status_error as string) || null,
    currentPlan,
    planUpdatedAt: (row.plan_updated_at as number) || null,
    promptStartedAt: (row.prompt_started_at as number) || null,
    lastStopReason: (row.last_stop_reason as string) || null,
    agentType: (row.agent_type as string) || null,
    activitySource: (row.activity_source as SessionActivitySource) || null,
    activityReason: (row.activity_reason as SessionActivityTerminalReason) || null,
    runtimeWorkState: (row.runtime_work_state as SessionStateSnapshot['runtimeWorkState']) || null,
    runtimeWorkCount: typeof row.runtime_work_count === 'number' ? row.runtime_work_count : null,
    runtimeWorkSource: (row.runtime_work_source as string) || null,
    runtimeWorkUpdatedAt:
      typeof row.runtime_work_updated_at === 'number' ? row.runtime_work_updated_at : null,
    runtimeWorkProgressAt:
      typeof row.runtime_work_progress_at === 'number' ? row.runtime_work_progress_at : null,
    workAt: typeof row.work_at === 'number' ? row.work_at : null,
    reportedPromptStartedAt:
      typeof row.reported_prompt_started_at === 'number' && row.reported_prompt_started_at > 0
        ? row.reported_prompt_started_at
        : null,
    steeringSupported:
      typeof row.steering_supported === 'number' ? row.steering_supported === 1 : null,
  };
}

export interface PersistedPlanSnapshot {
  currentPlan: PlanEntry[] | null;
  planUpdatedAt: number | null;
}

export function getLatestPersistedPlan(
  sql: SqlStorage,
  sessionId: string
): PersistedPlanSnapshot | null {
  const row = sql
    .exec(
      `SELECT content, created_at
       FROM chat_messages
       WHERE session_id = ? AND role = 'plan'
       ORDER BY created_at DESC, sequence DESC
       LIMIT 1`,
      sessionId
    )
    .toArray()[0];

  if (!row || typeof row.content !== 'string') return null;

  try {
    const parsed = JSON.parse(row.content);
    if (!Array.isArray(parsed)) return null;
    return {
      currentPlan: parsed as PlanEntry[],
      planUpdatedAt: (row.created_at as number) || null,
    };
  } catch {
    return null;
  }
}
