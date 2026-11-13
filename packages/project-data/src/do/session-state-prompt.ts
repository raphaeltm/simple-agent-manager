/**
 * Session State Mirror: prompt-epoch, plan and chat-session helpers. Split out of
 * `session-state.ts` (`.claude/rules/18-file-size-limits.md`), which re-exports them.
 */
/**
 * Activity values that mean "a prompt turn is believed to be in flight".
 *
 * These are the states interpreted as positive in-flight work throughout the
 * control plane, and the states that suppress idle scheduling / delivery for
 * their session.
 *
 * `error` is deliberately EXCLUDED from positive working evidence. The
 * SessionHost-backed reconciler probes stale error mirrors separately and may
 * end them only when the exact runtime session authoritatively reports that no
 * turn is in flight.
 */
export const WORKING_ACTIVITIES = ['prompting', 'recovering'] as const;

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
       (session_id, activity, activity_at, prompt_started_at, prompt_epoch, restart_count, work_at)
     VALUES (?, 'prompting', ?, ?, ?, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       activity = 'prompting',
       activity_at = excluded.activity_at,
       work_at = MAX(COALESCE(session_state.work_at, 0), excluded.work_at),
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
    now
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

/**
 * A persisted message is work. `now` stamps the last-report clock (callers may pass the
 * message time); `workAt` stamps the work clock on the DO's own clock and never moves it
 * backwards, so a delayed outbox batch or a skewed VM clock cannot shorten a drain.
 */
export function refreshWorkingActivityForChatSession(
  sql: SqlStorage,
  chatSessionId: string,
  now = Date.now(),
  workAt = Date.now()
): void {
  const whereClause = `activity IN ('prompting', 'recovering') AND ${CHAT_SESSION_STATE_WHERE}`;
  sql.exec(
    `UPDATE session_state
     SET activity_at = ?, work_at = MAX(COALESCE(work_at, 0), ?)
     WHERE ${whereClause}`,
    now,
    workAt,
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
  outcome: { activity: 'stopped'; reason: string } | { activity: 'error'; statusError: string },
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
         work_at = ?,
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
  const rows = sql.exec(CHAT_SESSION_STATE_IDS_SQL, chatSessionId, chatSessionId).toArray();
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
