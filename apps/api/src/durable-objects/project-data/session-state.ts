/**
 * Session State Mirror — persists VM agent session state in DO SQLite.
 *
 * Transforms the DO from a pass-through mailbox to a durable mirror of the
 * VM agent's current session state. Enables:
 * - Correct activity state on page load (no waiting for next broadcast)
 * - Plan button restoration in project chat
 * - Staleness auto-heal for stuck "prompting" states
 */
import type { SessionStateSnapshot } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('project_data.session_state');

const STALE_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes default

// --- Write Operations ---

export interface ActivityUpdate {
  activity: string;
  promptStartedAt?: number | null;
  agentType?: string | null;
  restartCount?: number | null;
  statusError?: string | null;
}

export function upsertActivityState(
  sql: SqlStorage,
  sessionId: string,
  update: ActivityUpdate,
): void {
  const now = Date.now();
  const promptStartedAt = update.activity === 'prompting'
    ? (update.promptStartedAt ?? now)
    : null;

  sql.exec(
    `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, agent_type, restart_count, status_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       activity = excluded.activity,
       activity_at = excluded.activity_at,
       prompt_started_at = CASE WHEN excluded.activity = 'prompting' THEN excluded.prompt_started_at ELSE session_state.prompt_started_at END,
       agent_type = COALESCE(excluded.agent_type, session_state.agent_type),
       restart_count = COALESCE(excluded.restart_count, session_state.restart_count),
       status_error = excluded.status_error`,
    sessionId,
    update.activity,
    now,
    promptStartedAt,
    update.agentType ?? null,
    update.restartCount ?? 0,
    update.statusError ?? null,
  );
}

export function updateCurrentPlan(
  sql: SqlStorage,
  sessionId: string,
  planJson: string,
): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO session_state (session_id, activity, activity_at, current_plan_json, plan_updated_at)
     VALUES (?, 'idle', ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       current_plan_json = excluded.current_plan_json,
       plan_updated_at = excluded.plan_updated_at`,
    sessionId,
    now,
    planJson,
    now,
  );
}

export function markSessionStopped(
  sql: SqlStorage,
  sessionId: string,
  reason: string,
): void {
  const now = Date.now();
  sql.exec(
    `UPDATE session_state SET activity = 'stopped', activity_at = ?, last_stop_reason = ? WHERE session_id = ?`,
    now,
    reason,
    sessionId,
  );
}

export function markSessionError(
  sql: SqlStorage,
  sessionId: string,
  errorMessage: string,
): void {
  const now = Date.now();
  sql.exec(
    `UPDATE session_state SET activity = 'error', activity_at = ?, status_error = ? WHERE session_id = ?`,
    now,
    errorMessage,
    sessionId,
  );
}

// --- Read Operations ---

export function getSessionState(
  sql: SqlStorage,
  sessionId: string,
): SessionStateSnapshot | null {
  const rows = sql
    .exec(
      `SELECT activity, activity_at, status_error, current_plan_json, plan_updated_at,
              prompt_started_at, last_stop_reason, agent_type
       FROM session_state WHERE session_id = ?`,
      sessionId,
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
  };
}

// --- Staleness Reconciliation ---

/**
 * Auto-heal stuck "prompting" states. If activity_at is older than the
 * staleness threshold and no messages have arrived since, transition to idle.
 *
 * Returns session IDs that were auto-healed (for broadcasting).
 */
export function reconcileStaleActivity(
  sql: SqlStorage,
  thresholdMs?: number,
): string[] {
  const threshold = thresholdMs ?? STALE_ACTIVITY_THRESHOLD_MS;
  const cutoff = Date.now() - threshold;
  const now = Date.now();

  // Identify stale sessions for broadcast notification. Task-linked prompting
  // states are intentionally excluded: task reconciliation uses them to decide
  // whether to defer, observe, or cancel an in-flight prompt.
  const staleRows = sql
    .exec(
      `SELECT session_id FROM session_state
       WHERE activity_at < ?
         AND (
           activity IN ('error', 'recovering')
           OR (
             activity = 'prompting'
             AND NOT EXISTS (
               SELECT 1
               FROM acp_sessions acp
               JOIN chat_sessions cs ON cs.id = acp.chat_session_id
               LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
               WHERE acp.id = session_state.session_id
                 AND acp.status IN ('running', 'started')
                 AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
             )
           )
         )`,
      cutoff,
    )
    .toArray();

  if (staleRows.length === 0) return [];

  // Bulk-heal all stale sessions in a single atomic statement
  sql.exec(
    `UPDATE session_state SET activity = 'idle', activity_at = ?
     WHERE activity_at < ?
       AND (
         activity IN ('error', 'recovering')
         OR (
           activity = 'prompting'
           AND NOT EXISTS (
             SELECT 1
             FROM acp_sessions acp
             JOIN chat_sessions cs ON cs.id = acp.chat_session_id
             LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
             WHERE acp.id = session_state.session_id
               AND acp.status IN ('running', 'started')
               AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
           )
         )
       )`,
    now,
    cutoff,
  );

  const healedSessionIds: string[] = [];
  for (const row of staleRows) {
    const sessionId = row.session_id as string;
    healedSessionIds.push(sessionId);
    log.warn('session_state.stale_activity_healed', { sessionId, staleSince: cutoff });
  }

  return healedSessionIds;
}
