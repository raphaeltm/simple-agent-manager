/** Durable, bounded D1 publication episodes. Ingest only enqueues when bookkeeping folds. */
import type { MessageMergeConfig } from './message-stream-ingest';

export const DEFAULT_BOOKKEEPING_SUMMARY_RETRY = {
  bookkeepingSummaryRetryMs: 5_000,
  bookkeepingSummaryMaxAttempts: 12,
  bookkeepingSummaryMaxResidenceMs: 15 * 60_000,
} as const;

type RetryConfig = Pick<
  MessageMergeConfig,
  'bookkeepingSummaryRetryMs' | 'bookkeepingSummaryMaxAttempts' | 'bookkeepingSummaryMaxResidenceMs'
>;

export interface BookkeepingSummaryClaim {
  sessionId: string;
  version: number;
  attempts: number;
  firstQueuedAt: number;
}
export interface TerminalBookkeepingSummary extends BookkeepingSummaryClaim {
  reason: 'attempts_exhausted' | 'residence_exhausted';
}

/** Never renew an unresolved episode's age, attempts, eligibility, or terminal state. */
export function enqueueBookkeepingSummary(sql: SqlStorage, sessionId: string, now: number): void {
  sql.exec(
    `INSERT INTO message_bookkeeping_summary_queue
      (session_id, first_queued_at, attempts, next_attempt_at, terminal_at, version)
      VALUES (?, ?, 0, ?, NULL, 1)
      ON CONFLICT(session_id) DO UPDATE SET version = version + 1`,
    sessionId,
    now,
    now
  );
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Claims persist retry eligibility BEFORE the caller awaits D1. Process further pages until
 * the caller's overall deadline. A poisoned page cannot stay at the head of the eligible set.
 * Return terminal rows to the caller for existing operator-visible observability alerts.
 */
export function claimBookkeepingSummaries(
  sql: SqlStorage,
  config: RetryConfig,
  limit: number,
  now: number
): { claimed: BookkeepingSummaryClaim[]; terminal: TerminalBookkeepingSummary[] } {
  const retryMs = positive(
    config.bookkeepingSummaryRetryMs,
    DEFAULT_BOOKKEEPING_SUMMARY_RETRY.bookkeepingSummaryRetryMs
  );
  const maxAttempts = positive(
    config.bookkeepingSummaryMaxAttempts,
    DEFAULT_BOOKKEEPING_SUMMARY_RETRY.bookkeepingSummaryMaxAttempts
  );
  const maxResidenceMs = positive(
    config.bookkeepingSummaryMaxResidenceMs,
    DEFAULT_BOOKKEEPING_SUMMARY_RETRY.bookkeepingSummaryMaxResidenceMs
  );
  const rows = sql
    .exec(
      `SELECT session_id, version, attempts, first_queued_at
     FROM message_bookkeeping_summary_queue
     WHERE terminal_at IS NULL AND next_attempt_at <= ?
     ORDER BY next_attempt_at, session_id LIMIT ?`,
      now,
      limit
    )
    .toArray();
  const claimed: BookkeepingSummaryClaim[] = [];
  const terminal: TerminalBookkeepingSummary[] = [];
  for (const row of rows) {
    const claim = {
      sessionId: String(row.session_id),
      version: Number(row.version),
      attempts: Number(row.attempts),
      firstQueuedAt: Number(row.first_queued_at),
    };
    const reason =
      now - claim.firstQueuedAt >= maxResidenceMs
        ? 'residence_exhausted'
        : claim.attempts >= maxAttempts
          ? 'attempts_exhausted'
          : null;
    if (reason) {
      sql.exec(
        `UPDATE message_bookkeeping_summary_queue SET terminal_at = ?
         WHERE session_id = ? AND version = ? AND terminal_at IS NULL`,
        now,
        claim.sessionId,
        claim.version
      );
      terminal.push({ ...claim, reason });
      continue;
    }
    claim.attempts++;
    sql.exec(
      `UPDATE message_bookkeeping_summary_queue SET attempts = ?, next_attempt_at = ?
       WHERE session_id = ? AND version = ? AND terminal_at IS NULL`,
      claim.attempts,
      Math.min(now + retryMs, claim.firstQueuedAt + maxResidenceMs),
      claim.sessionId,
      claim.version
    );
    claimed.push(claim);
  }
  return { claimed, terminal };
}

/** Call ONLY after the claimed snapshot was published successfully, including coverage, and
 * the caller's transcript snapshot CAS succeeded. A renewed fold has a different version.
 */
export function acknowledgeBookkeepingSummary(
  sql: SqlStorage,
  claim: BookkeepingSummaryClaim
): boolean {
  return (
    sql
      .exec(
        `DELETE FROM message_bookkeeping_summary_queue
     WHERE session_id = ? AND version = ? AND attempts = ? AND first_queued_at = ? AND terminal_at IS NULL RETURNING session_id`,
        claim.sessionId,
        claim.version,
        claim.attempts,
        claim.firstQueuedAt
      )
      .toArray().length > 0
  );
}

/** A proven successful publication ends the old failure episode even if a newer fold arrived.
 * Call only after D1 and coverage succeeded; ingest itself must never call this operation.
 * Attempt fencing prevents an older completion from resetting a newer owner's episode.
 */
export function rebasePublishedBookkeepingSummary(
  sql: SqlStorage,
  claim: BookkeepingSummaryClaim,
  now: number
): boolean {
  return (
    sql
      .exec(
        `UPDATE message_bookkeeping_summary_queue
     SET first_queued_at = ?, attempts = 0, next_attempt_at = ?
     WHERE session_id = ? AND version > ? AND attempts = ? AND first_queued_at = ? AND terminal_at IS NULL
     RETURNING session_id`,
        now,
        now,
        claim.sessionId,
        claim.version,
        claim.attempts,
        claim.firstQueuedAt
      )
      .toArray().length > 0
  );
}

/** Explicit operator repair only. No public mutation endpoint is introduced here. */
export function repairBookkeepingSummary(sql: SqlStorage, sessionId: string, now: number): boolean {
  return (
    sql
      .exec(
        `UPDATE message_bookkeeping_summary_queue
     SET first_queued_at = ?, attempts = 0, next_attempt_at = ?, terminal_at = NULL, version = version + 1
     WHERE session_id = ? RETURNING session_id`,
        now,
        now,
        sessionId
      )
      .toArray().length > 0
  );
}

/** Same eligibility record as claim; terminal episodes never re-arm the alarm. */
export function computeBookkeepingSummaryQueueAlarmTime(sql: SqlStorage): number | null {
  const row = sql
    .exec(
      `SELECT MIN(next_attempt_at) AS due FROM message_bookkeeping_summary_queue WHERE terminal_at IS NULL`
    )
    .toArray()[0];
  return typeof row?.due === 'number' ? row.due : null;
}
