/**
 * Session State Mirror — persists VM agent session state in DO SQLite.
 *
 * Transforms the DO from a pass-through mailbox to a durable mirror of the
 * VM agent's current session state. Enables:
 * - Correct activity state on page load (no waiting for next broadcast)
 * - Plan button restoration in project chat
 * - Staleness auto-heal for stuck "prompting" states
 */
import type {
  PlanEntry,
  SessionActivitySource,
  SessionActivityTerminalReason,
  SessionStateSnapshot,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('project_data.session_state');

export const DEFAULT_SESSION_ACTIVITY_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Activity values that mean "a prompt turn is believed to be in flight".
 *
 * These are the only states the reconciler may terminalize, and the only
 * states that suppress idle scheduling / delivery for their session.
 *
 * `error` is deliberately EXCLUDED: clearing it would erase user-visible error
 * context, which is a product decision rather than a reliability fix. A wedged
 * `error` activity therefore still suppresses idle scheduling. Tracked in
 * `tasks/backlog/2026-08-16-probe-reconcile-wedged-error-activity.md`
 * (`.claude/rules/42`).
 */
export const WORKING_ACTIVITIES = ['prompting', 'recovering'] as const;

export function parseActivityStaleThreshold(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SESSION_ACTIVITY_STALE_THRESHOLD_MS;
}

// --- Write Operations ---

export interface ActivityUpdate {
  activity: string;
  promptStartedAt?: number | null;
  agentType?: string | null;
  restartCount?: number | null;
  statusError?: string | null;
  now?: number;
  /** Which end produced this value. Defaults to the VM agent's own report. */
  source?: SessionActivitySource;
  /** Terminal-transition identity when this write ends a working state. */
  reason?: SessionActivityTerminalReason | null;
}

function isWorkingActivity(activity: string): boolean {
  return (WORKING_ACTIVITIES as readonly string[]).includes(activity);
}

export function upsertActivityState(
  sql: SqlStorage,
  sessionId: string,
  update: ActivityUpdate,
): void {
  const now = update.now ?? Date.now();
  const promptStartedAt = update.activity === 'prompting' || update.activity === 'recovering'
    ? (update.promptStartedAt ?? now)
    : null;
  const source: SessionActivitySource = update.source ?? 'vm_report';
  // A fresh authoritative report is its own evidence — a session that just
  // reported is no longer an unproven probe candidate.
  const reason: SessionActivityTerminalReason | null = isWorkingActivity(update.activity)
    ? null
    : (update.reason ?? (update.activity === 'idle' ? 'completed' : null));

  sql.exec(
    `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, prompt_epoch, agent_type, restart_count, status_error, activity_source, activity_reason, activity_probe_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(session_id) DO UPDATE SET
       activity_source = excluded.activity_source,
       activity_reason = excluded.activity_reason,
       activity_probe_attempts = 0,
       activity_probe_at = NULL,
       activity = excluded.activity,
       activity_at = excluded.activity_at,
       prompt_started_at = CASE
         WHEN excluded.activity NOT IN ('prompting', 'recovering', 'error') THEN NULL
         WHEN session_state.activity IN ('prompting', 'recovering', 'error')
           AND session_state.prompt_started_at IS NOT NULL
           THEN session_state.prompt_started_at
         ELSE excluded.prompt_started_at
       END,
       prompt_epoch = CASE
         WHEN excluded.activity NOT IN ('prompting', 'recovering', 'error') THEN NULL
         WHEN session_state.activity IN ('prompting', 'recovering', 'error')
           AND session_state.prompt_epoch IS NOT NULL
           THEN session_state.prompt_epoch
         ELSE excluded.prompt_epoch
       END,
       agent_type = COALESCE(excluded.agent_type, session_state.agent_type),
       restart_count = COALESCE(excluded.restart_count, session_state.restart_count),
       status_error = excluded.status_error`,
    sessionId,
    update.activity,
    now,
    promptStartedAt,
    promptStartedAt,
    update.agentType ?? null,
    update.restartCount ?? 0,
    update.statusError ?? null,
    source,
    reason,
  );
}

export interface TurnEndInput {
  reason: SessionActivityTerminalReason;
  source: SessionActivitySource;
  /**
   * When the turn-end evidence was OBSERVED, captured before any long async
   * call (.claude/rules/49). A working state that started after this instant
   * belongs to a newer prompt and is never stomped.
   */
  observedAt: number;
  now?: number;
}

/**
 * Record an explicit terminal transition out of a working state.
 *
 * The intended single write path for every turn ending — normal completion,
 * user cancel, force-stop, dead target, and probe-driven reconciliation — so
 * all three consumers (status UI, durable-message delivery, idle scheduling)
 * observe the same authoritative value regardless of which end noticed first.
 *
 * NOT YET UNIVERSAL: `reconciliation.ts:cancelStalledPrompt` (task-mode 409
 * stale-mirror repair) still writes `idle` via `upsertActivityState` plus a
 * manual broadcast, so it records no provenance and skips the delivery nudge
 * and the idle re-arm. That is pre-existing behaviour rather than a regression
 * from this change, and migrating it alters task-mode reconciliation semantics,
 * so it is tracked separately in
 * `tasks/backlog/2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end.md`
 * (`.claude/rules/42`).
 *
 * Compare-and-set: only a row still in a working state whose activity is not
 * newer than the observation is flipped. Returns true when the row changed.
 */
export function recordTurnEnd(
  sql: SqlStorage,
  sessionId: string,
  input: TurnEndInput,
): boolean {
  const now = input.now ?? Date.now();
  const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');
  const before = sql.exec(
    `SELECT activity FROM session_state WHERE session_id = ?`,
    sessionId,
  ).toArray()[0];
  if (!before || typeof before.activity !== 'string' || !isWorkingActivity(before.activity)) {
    return false;
  }

  sql.exec(
    `UPDATE session_state
     SET activity = 'idle',
         activity_at = ?,
         activity_source = ?,
         activity_reason = ?,
         prompt_started_at = NULL,
         prompt_epoch = NULL,
         status_error = NULL,
         activity_probe_attempts = 0,
         activity_probe_at = NULL
     WHERE session_id = ?
       AND activity IN (${placeholders})
       AND activity_at <= ?`,
    now,
    input.source,
    input.reason,
    sessionId,
    ...WORKING_ACTIVITIES,
    input.observedAt,
  );

  const after = sql.exec(
    `SELECT activity FROM session_state WHERE session_id = ?`,
    sessionId,
  ).toArray()[0];
  const changed = after?.activity === 'idle';
  if (changed) {
    log.info('session_state.turn_end_recorded', {
      sessionId,
      reason: input.reason,
      source: input.source,
    });
  }
  return changed;
}

/**
 * Establish a new prompt epoch only after the delivery owner has positive
 * acceptance evidence. Activity rereports never call this function.
 */
export function markPromptAccepted(
  sql: SqlStorage,
  sessionId: string,
  promptEpoch: number,
  now = Date.now(),
): boolean {
  const existing = sql.exec(
    'SELECT prompt_epoch FROM session_state WHERE session_id = ?',
    sessionId,
  ).toArray()[0];
  const existingEpoch = typeof existing?.prompt_epoch === 'number'
    ? existing.prompt_epoch
    : null;
  if (existingEpoch !== null && promptEpoch <= existingEpoch) return false;

  sql.exec(
    `INSERT INTO session_state
       (session_id, activity, activity_at, prompt_started_at, prompt_epoch, restart_count)
     VALUES (?, 'prompting', ?, ?, ?, 0)
     ON CONFLICT(session_id) DO UPDATE SET
       activity = 'prompting',
       activity_at = excluded.activity_at,
       prompt_started_at = excluded.prompt_started_at,
       prompt_epoch = excluded.prompt_epoch,
       status_error = NULL,
       activity_source = 'control_plane',
       activity_reason = NULL,
       activity_probe_attempts = 0,
       activity_probe_at = NULL`,
    sessionId,
    now,
    promptEpoch,
    promptEpoch,
  );
  return true;
}

export function getPromptEpoch(sql: SqlStorage, sessionId: string): number | null {
  const row = sql.exec(
    'SELECT prompt_epoch FROM session_state WHERE session_id = ?',
    sessionId,
  ).toArray()[0];
  return typeof row?.prompt_epoch === 'number' ? row.prompt_epoch : null;
}

export function refreshWorkingActivityForChatSession(
  sql: SqlStorage,
  chatSessionId: string,
  now = Date.now(),
): void {
  sql.exec(
    `UPDATE session_state
     SET activity_at = ?
     WHERE activity IN ('prompting', 'recovering')
       AND session_id IN (
         SELECT id FROM acp_sessions WHERE chat_session_id = ?
         UNION SELECT ?
       )`,
    now,
    chatSessionId,
    chatSessionId,
  );
}

export function resolveActivityChatSessionId(sql: SqlStorage, sessionId: string): string {
  const row = sql.exec(
    'SELECT chat_session_id FROM acp_sessions WHERE id = ?',
    sessionId,
  ).toArray()[0];
  return (row?.chat_session_id as string | undefined) ?? sessionId;
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
    `UPDATE session_state
     SET activity = 'stopped', activity_at = ?, last_stop_reason = ?,
         prompt_started_at = NULL, prompt_epoch = NULL
     WHERE session_id = ?`,
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
              prompt_started_at, last_stop_reason, agent_type,
              activity_source, activity_reason
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
    activitySource: (row.activity_source as SessionActivitySource) || null,
    activityReason: (row.activity_reason as SessionActivityTerminalReason) || null,
  };
}

export interface PersistedPlanSnapshot {
  currentPlan: PlanEntry[] | null;
  planUpdatedAt: number | null;
}

export function getLatestPersistedPlan(
  sql: SqlStorage,
  sessionId: string,
): PersistedPlanSnapshot | null {
  const row = sql
    .exec(
      `SELECT content, created_at
       FROM chat_messages
       WHERE session_id = ? AND role = 'plan'
       ORDER BY created_at DESC, sequence DESC
       LIMIT 1`,
      sessionId,
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

// --- Staleness Reconciliation ---

/**
 * Auto-heal stuck working states only with positive dead-session evidence:
 * activity is stale, no messages arrived after activity_at, and no linked ACP
 * session is still running/started with recent heartbeat/update evidence.
 *
 * Message persistence refreshes activity_at to the latest message timestamp
 * while a prompt is working, so equality is the refresh point itself rather
 * than new liveness evidence.
 *
 * Returns session IDs that were auto-healed (for broadcasting).
 */
export function reconcileStaleActivity(
  sql: SqlStorage,
  thresholdMs?: number,
): string[] {
  const threshold = thresholdMs ?? DEFAULT_SESSION_ACTIVITY_STALE_THRESHOLD_MS;
  const cutoff = Date.now() - threshold;
  const now = Date.now();

  const staleRows = sql
    .exec(
      `SELECT session_id FROM session_state
       WHERE activity IN ('prompting', 'recovering', 'error')
         AND activity_at < ?
         AND NOT EXISTS (
           SELECT 1
           FROM acp_sessions acp
           JOIN chat_messages msg ON msg.session_id = acp.chat_session_id
           WHERE acp.id = session_state.session_id
             AND msg.created_at > session_state.activity_at
           UNION
           SELECT 1
           FROM chat_messages msg
           WHERE msg.session_id = session_state.session_id
             AND msg.created_at > session_state.activity_at
         )
         AND NOT EXISTS (
           SELECT 1
           FROM acp_sessions acp
           WHERE acp.id = session_state.session_id
             AND acp.status IN ('running', 'started')
             AND COALESCE(acp.last_heartbeat_at, acp.updated_at, acp.started_at, acp.created_at, 0) >= ?
         )`,
      cutoff,
      cutoff,
    )
    .toArray();

  if (staleRows.length === 0) return [];

  const healedSessionIds: string[] = [];
  for (const row of staleRows) {
    const sessionId = row.session_id as string;
    sql.exec(
      `UPDATE session_state
       SET activity = 'idle', activity_at = ?,
           prompt_started_at = NULL, prompt_epoch = NULL,
           activity_source = 'control_plane',
           activity_reason = 'stale_no_evidence',
           activity_probe_attempts = 0, activity_probe_at = NULL
       WHERE session_id = ?`,
      now,
      sessionId,
    );
    healedSessionIds.push(sessionId);
    log.warn('session_state.stale_activity_healed', { sessionId, staleSince: cutoff });
  }

  return healedSessionIds;
}
