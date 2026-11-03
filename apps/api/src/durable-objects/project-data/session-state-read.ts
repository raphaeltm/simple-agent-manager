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

export function getSessionState(sql: SqlStorage, sessionId: string): SessionStateSnapshot | null {
  const rows = sql
    .exec(
      `SELECT activity, activity_at, status_error, current_plan_json, plan_updated_at,
              prompt_started_at, last_stop_reason, agent_type,
              activity_source, activity_reason,
              runtime_work_state, runtime_work_count, runtime_work_source,
              runtime_work_updated_at, runtime_work_progress_at, work_at, reported_prompt_started_at
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
