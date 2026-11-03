/**
 * Work clock for `session_state.work_at`.
 *
 * `activity_at` is a last-REPORT clock. The VM agent re-reports `prompting` every
 * `ACTIVITY_REREPORT_INTERVAL` (60 s) while a prompt is open, and every applied report
 * rewrites `activity_at`, so a turn that never returns keeps it fresh forever. Idleness
 * built on it could never fire for such a turn (.claude/rules/53): completed tasks kept
 * their workspace, and their node, alive for days.
 *
 * `work_at` moves only on evidence of real work:
 * - an activity edge (first report, activity changed, a newer turn, harness work changed);
 * - a persisted message (`refreshWorkingActivityForChatSession`);
 * - a control-plane turn transition (`markPromptAccepted`, `recordTurnEnd`, terminalize).
 * A same-turn re-report keeps it. Readers are `classifySessionIdleness` (drain anchor) and
 * `idlenessStateChanged` (sleep abort check).
 */

/** Outcome of `upsertActivityState`. `false` keeps the historical stale-report meaning. */
export type ActivityReportOutcome = false | 'work_edge' | 'same_turn_rereport';

export interface PriorActivityForWorkClock {
  activity: string;
  /** The VM's last reported turn start, not the control plane's accept time. */
  reportedPromptStartedAt: number | null;
  runtimeWorkState: string | null;
  runtimeWorkCount: number | null;
  runtimeWorkProgressAt: number | null;
}

export interface WorkClockUpdate {
  activity: string;
  /** The raw reported turn start; absent when the reporter did not send one. */
  promptStartedAt: number | null;
  hasRuntimeWorkUpdate: boolean;
  runtimeWorkState?: string;
  runtimeWorkCount?: number;
  runtimeWorkProgressAt?: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readPriorActivityForWorkClock(
  sql: SqlStorage,
  sessionId: string
): PriorActivityForWorkClock | null {
  const row = sql
    .exec(
      `SELECT activity, reported_prompt_started_at, runtime_work_state, runtime_work_count,
              runtime_work_progress_at
       FROM session_state WHERE session_id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!row || typeof row.activity !== 'string') return null;
  return {
    activity: row.activity,
    reportedPromptStartedAt: numberOrNull(row.reported_prompt_started_at),
    runtimeWorkState: typeof row.runtime_work_state === 'string' ? row.runtime_work_state : null,
    runtimeWorkCount: numberOrNull(row.runtime_work_count),
    runtimeWorkProgressAt: numberOrNull(row.runtime_work_progress_at),
  };
}

/**
 * Mirrors the `upsertActivityState` guard on the runtime-work columns: they are written only
 * when the stored progress is NULL or the reported progress is not older. A runtime-work
 * difference the upsert would not write must not count as an edge, or a stale report would
 * move the clock on every re-report.
 */
function runtimeWorkUpdateApplies(
  prior: PriorActivityForWorkClock,
  update: WorkClockUpdate
): boolean {
  if (prior.runtimeWorkProgressAt === null) return true;
  const progressAt = update.runtimeWorkProgressAt ?? null;
  return progressAt !== null && progressAt >= prior.runtimeWorkProgressAt;
}

/**
 * A report that only repeats the stored turn: same activity, no newer turn start, and no
 * change in harness work. Anything else is a work edge.
 */
export function isSameTurnRereport(
  prior: PriorActivityForWorkClock | null,
  update: WorkClockUpdate
): boolean {
  if (!prior) return false;
  if (prior.activity !== update.activity) return false;
  // A new turn is judged against the VM's own previous report. `prompt_started_at`
  // cannot be used: `markPromptAccepted` stores the control plane's accept time there,
  // which is earlier than the VM's turn start, so every re-report would look newer.
  // The VM repeats one turn's start unchanged, so any different value is another turn.
  if (update.promptStartedAt !== null && update.promptStartedAt !== prior.reportedPromptStartedAt) {
    return false;
  }
  if (update.hasRuntimeWorkUpdate && runtimeWorkUpdateApplies(prior, update)) {
    if ((update.runtimeWorkState ?? null) !== prior.runtimeWorkState) return false;
    if ((update.runtimeWorkCount ?? 0) !== (prior.runtimeWorkCount ?? 0)) return false;
    const progressAt = update.runtimeWorkProgressAt ?? null;
    if (
      progressAt !== null &&
      (prior.runtimeWorkProgressAt === null || progressAt > prior.runtimeWorkProgressAt)
    ) {
      return false;
    }
  }
  return true;
}
