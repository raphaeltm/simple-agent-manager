/**
 * Session State Mirror — persists VM agent session state in DO SQLite.
 *
 * Transforms the DO from a pass-through mailbox to a durable mirror of the
 * VM agent's current session state. Enables:
 * - Correct activity state on page load (no waiting for next broadcast)
 * - Plan button restoration in project chat
 * - Probe-backed reconciliation for stale working states
 */
import type {
  SessionActivitySource,
  SessionActivityTerminalReason,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { WORKING_ACTIVITIES } from './session-state-prompt';
import {
  type ActivityReportOutcome,
  isSameTurnRereport,
  keepReportedTurnStart,
  readPriorActivityForWorkClock,
} from './session-work-clock';

const log = createModuleLogger('project_data.session_state');

export const DEFAULT_SESSION_ACTIVITY_STALE_THRESHOLD_MS = 5 * 60 * 1000;

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
  /** Whether the loaded adapter can steer. Absent (older agents) keeps the stored value. */
  steeringSupported?: boolean;
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
): ActivityReportOutcome {
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
  // Harness progress is reported on the VM's clock. A value ahead of receipt would pin the
  // work clock and the harness lease into the future, and the monotonic guards would keep
  // it there, so it is clamped to the time this report is applied.
  const runtimeWorkProgressAt =
    typeof update.runtimeWorkProgressAt === 'number'
      ? Math.min(update.runtimeWorkProgressAt, now)
      : update.runtimeWorkProgressAt;
  // Read before the write: no await separates the two, so the DO cannot interleave.
  // The RAW reported turn start: a report without one must not look like a new turn.
  const reportedPromptStartedAt = update.promptStartedAt ?? null;
  const sameTurnRereport = isSameTurnRereport(readPriorActivityForWorkClock(sql, sessionId), {
    activity: update.activity,
    promptStartedAt: reportedPromptStartedAt,
    hasRuntimeWorkUpdate,
    runtimeWorkState: update.runtimeWorkState,
    runtimeWorkCount: update.runtimeWorkCount,
    runtimeWorkProgressAt,
  });

  const cursor = sql.exec(
    `INSERT INTO session_state (
       session_id, activity, activity_at, prompt_started_at, prompt_epoch,
       agent_type, restart_count, status_error,
       activity_source, activity_reason, activity_probe_attempts,
       runtime_work_state, runtime_work_count, runtime_work_source,
       runtime_work_updated_at, runtime_work_progress_at, work_at, reported_prompt_started_at,
       steering_supported
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
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
       steering_supported = COALESCE(excluded.steering_supported, session_state.steering_supported),
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
		       THEN excluded.runtime_work_progress_at ELSE session_state.runtime_work_progress_at END,
		   work_at = CASE WHEN ? = 1 THEN session_state.work_at
		     ELSE MAX(COALESCE(session_state.work_at, 0), excluded.work_at) END,
		   reported_prompt_started_at = MAX(
		     COALESCE(excluded.reported_prompt_started_at, 0),
		     COALESCE(session_state.reported_prompt_started_at, 0)
		   )
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
    hasRuntimeWorkUpdate ? (runtimeWorkProgressAt ?? null) : null,
    activityAt,
    reportedPromptStartedAt,
    update.steeringSupported === undefined ? null : update.steeringSupported ? 1 : 0,
    ...Array(5).fill(hasRuntimeWorkUpdate ? 1 : 0),
    sameTurnRereport ? 1 : 0
  );
  if (cursor.rowsWritten === 0) {
    // A stale-ordered report still carries the VM's evidence of a new turn.
    keepReportedTurnStart(sql, sessionId, reportedPromptStartedAt);
    return false;
  }
  return sameTurnRereport ? 'same_turn_rereport' : 'work_edge';
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
export function recordTurnEnd(sql: SqlStorage, sessionId: string, input: TurnEndInput): boolean {
  return recordTurnEndFromActivities(sql, sessionId, input, WORKING_ACTIVITIES, false);
}

/**
 * Probe-only terminal transition that also admits a stale `error` mirror.
 * Preserve its diagnostic text after returning the activity gate to `idle` so
 * reconciliation releases downstream consumers without erasing user-visible
 * error context.
 */
export function recordProbeReconciledTurnEnd(
  sql: SqlStorage,
  sessionId: string,
  input: TurnEndInput
): boolean {
  return recordTurnEndFromActivities(sql, sessionId, input, [...WORKING_ACTIVITIES, 'error'], true);
}

function recordTurnEndFromActivities(
  sql: SqlStorage,
  sessionId: string,
  input: TurnEndInput,
  expectedActivities: readonly string[],
  preserveErrorContext: boolean
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
  const placeholders = expectedActivities.map(() => '?').join(', ');
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
  const before = sql
    .exec(`SELECT activity FROM session_state WHERE session_id = ?`, sessionId)
    .toArray()[0];
  if (
    !before ||
    typeof before.activity !== 'string' ||
    !expectedActivities.includes(before.activity)
  ) {
    return false;
  }

  const updated = sql.exec(
    `UPDATE session_state
     SET activity = 'idle',
         activity_at = ?,
         work_at = ?,
         activity_source = ?,
         activity_reason = ?,
         prompt_started_at = NULL,
         prompt_epoch = NULL,
         status_error = CASE WHEN ? = 1 AND activity = 'error' THEN status_error ELSE NULL END,
         activity_probe_attempts = 0,
         activity_probe_at = NULL
     WHERE ${whereClause}`,
    now,
    now,
    input.source,
    input.reason,
    preserveErrorContext ? 1 : 0,
    sessionId,
    ...expectedActivities,
    input.observedAt
  );

  const changed = updated.rowsWritten > 0;
  if (changed) {
    log.info('session_state.turn_end_recorded', {
      sessionId,
      reason: input.reason,
      source: input.source,
    });
  }
  return changed;
}

export {
  getPromptEpoch,
  listSessionStateIdsForChatSession,
  markPromptAccepted,
  refreshWorkingActivityForChatSession,
  resolveActivityChatSessionId,
  terminalizeChatSessionActivity,
  updateCurrentPlan,
  WORKING_ACTIVITIES,
} from './session-state-prompt';
export {
  getLatestPersistedPlan,
  getSessionState,
  type PersistedPlanSnapshot,
} from './session-state-read';
