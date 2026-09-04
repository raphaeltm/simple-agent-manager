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
  /**
   * When the reporter observed this activity state. Defaults to `now` for direct
   * writes. Delayed/coalesced flushes must pass their original observation time
   * so older cross-isolate reports cannot overwrite newer terminal state.
   */
  observedAt?: number | null;
  promptStartedAt?: number | null;
  agentType?: string | null;
  restartCount?: number | null;
  statusError?: string | null;
  runtimeWorkState?: 'inactive' | 'active' | 'settling';
  runtimeWorkCount?: number;
  runtimeWorkSource?: string;
  runtimeWorkProgressAt?: number | null;
  now?: number;
  /** Which end produced this value. Defaults to the VM agent's own report. */
  source?: SessionActivitySource;
  /** Terminal-transition identity when this write ends a working state. */
  reason?: SessionActivityTerminalReason | null;
}

function isWorkingActivity(activity: string): boolean {
  return (WORKING_ACTIVITIES as readonly string[]).includes(activity);
}

function normalizeActivityObservedAt(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

export function upsertActivityState(
  sql: SqlStorage,
  sessionId: string,
  update: ActivityUpdate
): boolean {
  const now = update.now ?? Date.now();
  const activityAt = normalizeActivityObservedAt(update.observedAt, now);
  const promptStartedAt =
    update.activity === 'prompting' || update.activity === 'recovering'
      ? (update.promptStartedAt ?? activityAt)
      : null;
  const source: SessionActivitySource = update.source ?? 'vm_report';
  // A fresh authoritative report is its own evidence — a session that just
  // reported is no longer an unproven probe candidate.
  const reason: SessionActivityTerminalReason | null = isWorkingActivity(update.activity)
    ? null
    : (update.reason ?? (update.activity === 'idle' ? 'completed' : null));
  const hasRuntimeWorkUpdate = update.runtimeWorkState !== undefined;

  const cursor = sql.exec(
    `INSERT INTO session_state (
       session_id, activity, activity_at, prompt_started_at, prompt_epoch,
       agent_type, restart_count, status_error,
       activity_source, activity_reason, activity_probe_attempts,
       runtime_work_state, runtime_work_count, runtime_work_source,
       runtime_work_updated_at, runtime_work_progress_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
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
		   status_error = excluded.status_error,
		   runtime_work_state = CASE
		     WHEN ? = 1 AND (session_state.runtime_work_progress_at IS NULL OR excluded.runtime_work_progress_at >= session_state.runtime_work_progress_at)
		       THEN excluded.runtime_work_state ELSE session_state.runtime_work_state END,
		   runtime_work_count = CASE
		     WHEN ? = 1 AND (session_state.runtime_work_progress_at IS NULL OR excluded.runtime_work_progress_at >= session_state.runtime_work_progress_at)
		       THEN excluded.runtime_work_count ELSE session_state.runtime_work_count END,
		   runtime_work_source = CASE
		     WHEN ? = 1 AND (session_state.runtime_work_progress_at IS NULL OR excluded.runtime_work_progress_at >= session_state.runtime_work_progress_at)
		       THEN excluded.runtime_work_source ELSE session_state.runtime_work_source END,
		   runtime_work_updated_at = CASE
		     WHEN ? = 1 AND (session_state.runtime_work_progress_at IS NULL OR excluded.runtime_work_progress_at >= session_state.runtime_work_progress_at)
		       THEN excluded.runtime_work_updated_at ELSE session_state.runtime_work_updated_at END,
		   runtime_work_progress_at = CASE
		     WHEN ? = 1 AND (session_state.runtime_work_progress_at IS NULL OR excluded.runtime_work_progress_at >= session_state.runtime_work_progress_at)
		       THEN excluded.runtime_work_progress_at ELSE session_state.runtime_work_progress_at END
	     WHERE session_state.activity_at IS NULL
	        OR session_state.activity_at < excluded.activity_at
	        OR (
	          session_state.activity_at = excluded.activity_at
	          AND CASE excluded.activity
	                WHEN 'error' THEN 3
	                WHEN 'idle' THEN 2
	                WHEN 'stopped' THEN 2
	                WHEN 'prompting' THEN 1
	                WHEN 'recovering' THEN 1
	                ELSE 0
	              END >= CASE session_state.activity
	                WHEN 'error' THEN 3
	                WHEN 'idle' THEN 2
	                WHEN 'stopped' THEN 2
	                WHEN 'prompting' THEN 1
	                WHEN 'recovering' THEN 1
	                ELSE 0
	              END
	        )`,
    sessionId,
    update.activity,
    activityAt,
    promptStartedAt,
    promptStartedAt,
    update.agentType ?? null,
    update.restartCount ?? 0,
    update.statusError ?? null,
    source,
    reason,
    hasRuntimeWorkUpdate ? update.runtimeWorkState : null,
    hasRuntimeWorkUpdate ? (update.runtimeWorkCount ?? 0) : null,
    hasRuntimeWorkUpdate ? (update.runtimeWorkSource ?? null) : null,
    hasRuntimeWorkUpdate ? activityAt : null,
    hasRuntimeWorkUpdate ? (update.runtimeWorkProgressAt ?? null) : null,
    ...Array(5).fill(hasRuntimeWorkUpdate ? 1 : 0)
  );
  return cursor.rowsWritten > 0;
}

/**
 * Which clock `observedAt` is measured against. The two callers of
 * `recordTurnEnd` ask genuinely different questions, so the predicate is an
 * explicit argument rather than a shared default — a new caller must choose,
 * and neither meaning can be widened into the other by accident
 * (.claude/rules/67).
 *
 * - `turn_start` — "has a NEW turn begun since I observed the turn-end
 *   evidence?" Used by control-plane observations (cancel, force-stop, dead
 *   target) whose `observedAt` is a wall-clock instant captured BEFORE a slow
 *   VM call (.claude/rules/49). Compares `prompt_started_at`, which is written
 *   once when a turn begins and is explicitly PRESERVED across same-turn
 *   re-reports by `upsertActivityState`, so it is stable for the life of a turn.
 *
 *   It must NOT compare `activity_at`, which is a LAST-REPORT clock:
 *   `refreshWorkingActivityForChatSession` rewrites it to `now` on EVERY
 *   persisted message while a session is working (`message-persistence.ts`,
 *   both the single and batch paths). Guarding a cancel on `activity_at` meant
 *   any message flushing inside the cancel's VM round-trip pushed it past
 *   `observedAt` and silently voided the cancel — the turn stayed "working",
 *   `publishTurnEnd` never ran, and the stop button, durable delivery and idle
 *   scheduling all wedged together (.claude/rules/57).
 *
 * - `row_unchanged` — "has this row changed at all since I selected it?"
 *   Optimistic concurrency for the probe sweep, whose `observedAt` is the
 *   `activity_at` it read at candidate-selection time rather than a wall-clock
 *   observation. Compares `activity_at` so that ANY fresh report — including a
 *   new message arriving mid-probe — withdraws the probe's stale verdict.
 */
export type TurnEndGuard = 'turn_start' | 'row_unchanged';

const TURN_END_GUARD_SQL: Record<TurnEndGuard, string> = {
  // COALESCE falls back to the last-report clock so a working row that never
  // recorded a prompt start behaves exactly as it did before this guard existed.
  turn_start: 'COALESCE(prompt_started_at, activity_at)',
  row_unchanged: 'activity_at',
};

export interface TurnEndInput {
  reason: SessionActivityTerminalReason;
  source: SessionActivitySource;
  /**
   * When the turn-end evidence was OBSERVED, captured before any long async
   * call (.claude/rules/49). A working state that started after this instant
   * belongs to a newer prompt and is never stomped.
   */
  observedAt: number;
  /** Which clock `observedAt` is compared against. See {@link TurnEndGuard}. */
  guard: TurnEndGuard;
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
  // The guard selects a SQL FRAGMENT, so its closedness must be enforced at
  // runtime and not left to the TypeScript union alone (.claude/rules/51). Both
  // current callers pass a literal, but a future caller deserializing this from
  // an RPC/JSON boundary would otherwise reopen a SQL-construction hole with no
  // compile error to catch it.
  const guardSql = Object.prototype.hasOwnProperty.call(TURN_END_GUARD_SQL, input.guard)
    ? TURN_END_GUARD_SQL[input.guard]
    : undefined;
  if (!guardSql) {
    throw new Error(`recordTurnEnd: unknown turn-end guard`);
  }
  const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');
  // Assembled outside the `sql.exec` template and named `whereClause`
  // deliberately: `scripts/quality/ast-checks.ts` allowlists exactly that
  // identifier for a dynamic WHERE built from parameterized conditions, which is
  // what this is — both interpolated parts are compile-time constants (a `?`
  // expansion over a const array, and a lookup into a frozen fragment map that
  // the runtime check above has already proven closed). No caller value reaches
  // the SQL text; every caller value is bound.
  const whereClause = `session_id = ?
       AND activity IN (${placeholders})
       AND ${guardSql} <= ?`;
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
     WHERE ${whereClause}`,
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
  now = Date.now()
): boolean {
  const existing = sql
    .exec('SELECT prompt_epoch FROM session_state WHERE session_id = ?', sessionId)
    .toArray()[0];
  const existingEpoch = typeof existing?.prompt_epoch === 'number' ? existing.prompt_epoch : null;
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
    promptEpoch
  );
  return true;
}

export function getPromptEpoch(sql: SqlStorage, sessionId: string): number | null {
  const row = sql
    .exec('SELECT prompt_epoch FROM session_state WHERE session_id = ?', sessionId)
    .toArray()[0];
  return typeof row?.prompt_epoch === 'number' ? row.prompt_epoch : null;
}

/**
 * Every `session_state` key belonging to one chat session: the chat-session id
 * itself plus every linked ACP-session id.
 *
 * Both keyings exist in production — the VM's activity callbacks are keyed by
 * ACP session id, the browser-facing state by chat session id — so any operation
 * over "this conversation's activity mirror" must span both. Defined once here
 * and shared by every reader/writer so the keying scheme cannot drift between
 * them. NOTE: `archive-sharding.ts` encodes the same invariant as a LEFT JOIN +
 * OR; keep the two in step if the keying ever changes.
 *
 * Takes two bind parameters, both the chat session id.
 */
const CHAT_SESSION_STATE_IDS_SQL = `SELECT id FROM acp_sessions WHERE chat_session_id = ?
   UNION SELECT ?`;

/**
 * `WHERE` restricting `session_state` to one chat session's rows. Named
 * `whereClause` at every use site because `scripts/quality/ast-checks.ts`
 * allowlists that identifier for a dynamic WHERE assembled from constants —
 * which this is: the only interpolated value is the module constant above, and
 * both of its parameters are bound.
 */
const CHAT_SESSION_STATE_WHERE = `session_id IN (${CHAT_SESSION_STATE_IDS_SQL})`;

export function refreshWorkingActivityForChatSession(
  sql: SqlStorage,
  chatSessionId: string,
  now = Date.now()
): void {
  const whereClause = `activity IN ('prompting', 'recovering') AND ${CHAT_SESSION_STATE_WHERE}`;
  sql.exec(
    `UPDATE session_state
     SET activity_at = ?
     WHERE ${whereClause}`,
    now,
    chatSessionId,
    chatSessionId
  );
}

export function resolveActivityChatSessionId(sql: SqlStorage, sessionId: string): string {
  const row = sql
    .exec('SELECT chat_session_id FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  return (row?.chat_session_id as string | undefined) ?? sessionId;
}

export function updateCurrentPlan(sql: SqlStorage, sessionId: string, planJson: string): void {
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
    now
  );
}

/**
 * Terminalize the activity mirror for a chat session that has ENDED.
 *
 * `stopSession`/`failSession` used to write only `chat_sessions.status`, leaving
 * a mid-turn row reporting `prompting` forever — so the stop button kept showing
 * "working", queued durable messages stayed parked behind a turn that had ended,
 * and the probe sweep kept selecting a session that no longer exists
 * (.claude/rules/57).
 *
 * ONE statement rather than a row-per-id loop, because a long-lived conversation
 * accumulates an ACP session per resume and this runs inside sweeps that
 * terminalize many sessions per alarm tick (.claude/rules/47).
 *
 * Scope is deliberately asymmetric:
 * - the chat-session-keyed row ALWAYS updates — that is the row the UI reads, so
 *   it must carry the terminal state and (for a failure) the error context;
 * - an ACP-session-keyed row updates only while it is still in a WORKING state.
 *   Those are the wedged rows this fix exists to clear. Rewriting historical ACP
 *   rows from turns that ended normally would destroy their per-turn provenance
 *   for no benefit.
 *
 * Clearing the probe accounting is what removes the row from the sweep's
 * candidate set by construction: `selectStaleActivityProbeCandidates` matches
 * only `WORKING_ACTIVITIES`, and neither `stopped` nor `error` is one.
 *
 * Returns the number of rows written.
 */
export function terminalizeChatSessionActivity(
  sql: SqlStorage,
  chatSessionId: string,
  outcome:
    | { activity: 'stopped'; reason: string }
    | { activity: 'error'; statusError: string },
  now = Date.now()
): number {
  const placeholders = WORKING_ACTIVITIES.map(() => '?').join(', ');
  // See CHAT_SESSION_STATE_WHERE for why this identifier is named `whereClause`.
  const whereClause = `${CHAT_SESSION_STATE_WHERE}
       AND (session_id = ? OR activity IN (${placeholders}))`;
  const stopped = outcome.activity === 'stopped';
  const cursor = sql.exec(
    `UPDATE session_state
     SET activity = ?,
         activity_at = ?,
         last_stop_reason = ?,
         status_error = ?,
         activity_source = 'control_plane',
         activity_reason = ?,
         prompt_started_at = NULL,
         prompt_epoch = NULL,
         activity_probe_attempts = 0,
         activity_probe_at = NULL,
         runtime_work_state = 'inactive',
         runtime_work_count = 0,
         runtime_work_updated_at = ?
     WHERE ${whereClause}`,
    outcome.activity,
    now,
    stopped ? outcome.reason : null,
    // A failure keeps its user-visible context; a stop clears any stale error.
    stopped ? null : outcome.statusError,
    stopped ? 'force_stopped' : 'dead',
    now,
    chatSessionId,
    chatSessionId,
    chatSessionId,
    ...WORKING_ACTIVITIES
  );
  return cursor.rowsWritten;
}

/**
 * Materialize {@link CHAT_SESSION_STATE_IDS_SQL} for callers that need the ids
 * in TypeScript rather than as a subquery. A terminal transition that cleared
 * only one keying would leave the other still reporting a turn that has ended.
 */
export function listSessionStateIdsForChatSession(
  sql: SqlStorage,
  chatSessionId: string
): string[] {
  const rows = sql
    .exec(CHAT_SESSION_STATE_IDS_SQL, chatSessionId, chatSessionId)
    .toArray();
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

// --- Read Operations ---

export function getSessionState(sql: SqlStorage, sessionId: string): SessionStateSnapshot | null {
  const rows = sql
    .exec(
      `SELECT activity, activity_at, status_error, current_plan_json, plan_updated_at,
              prompt_started_at, last_stop_reason, agent_type,
              activity_source, activity_reason,
              runtime_work_state, runtime_work_count, runtime_work_source,
              runtime_work_updated_at, runtime_work_progress_at
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
export function reconcileStaleActivity(sql: SqlStorage, thresholdMs?: number): string[] {
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
      cutoff
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
      sessionId
    );
    healedSessionIds.push(sessionId);
    log.warn('session_state.stale_activity_healed', { sessionId, staleSince: cutoff });
  }

  return healedSessionIds;
}
