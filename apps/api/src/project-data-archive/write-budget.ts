import type { Env } from '../env';

export const ARCHIVE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ARCHIVE_DEFAULT_DAILY_WRITE_BUDGET = 250_000;
export const ARCHIVE_DEFAULT_WRITE_FACTOR = 32;
export const ARCHIVE_WRITE_FIXED_RESERVATION = 1_000;
/**
 * Percentage by which a session's write estimate exceeds its
 * `session_summaries.message_count`. The estimate counts archived tool payloads, grouped
 * rows and FTS units on top of the raw `chat_messages` rows that `message_count` reports,
 * so any candidate ceiling derived from `message_count` must leave room for them.
 *
 * 100 (i.e. units <= 2x message_count) is the conservative side of the only production
 * measurement available: the single compact migration published on 2026-09-08 reserved
 * 2216 writes for a 20-message session, which is 38 units, or 1.9x. This is a scheduling
 * heuristic, not a guarantee — a candidate whose real overhead exceeds it is still refused
 * by `reserveArchiveWrites` and the sweep descends to the next candidate.
 */
export const ARCHIVE_DEFAULT_SWEEP_UNIT_OVERHEAD_PERCENT = 100;
export const ARCHIVE_MAX_SWEEP_UNIT_OVERHEAD_PERCENT = 10_000;
const FTS_BYTES_PER_UNIT = 512;
const DEFAULT_UNUSED_RESERVATION_RETENTION_MS = 7 * ARCHIVE_BUDGET_WINDOW_MS;
const DEFAULT_UNUSED_RESERVATION_CLEANUP_LIMIT = 100;

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error('Invalid archive write budget configuration');
  return n;
}
export function archiveWriteBudgetConfig(
  env: Pick<
    Env,
    'PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET' | 'PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR'
  >
) {
  return {
    allowance: positive(
      env.PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET,
      ARCHIVE_DEFAULT_DAILY_WRITE_BUDGET
    ),
    factor: Math.max(
      1,
      positive(env.PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR, ARCHIVE_DEFAULT_WRITE_FACTOR)
    ),
  };
}
export type ArchiveWriteReservation = {
  reservationId?: string;
  estimatedWrites: number;
  factor: number;
  maxMessages: number;
};

/**
 * Largest per-session write estimate the allowance can EVER admit, in estimate units
 * (`estimateArchiveWrites` charges `ARCHIVE_WRITE_FIXED_RESERVATION + factor * units`).
 *
 * This is the ceiling every candidate selector must respect. Selecting above it produces a
 * candidate `reserveArchiveWrites` refuses on every attempt for as long as the allowance
 * stands — which, with a largest-first selector, is a permanent deadlock rather than a
 * deferral. Deriving both ceilings from this one function is what keeps them from drifting
 * apart the way `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` drifted from
 * `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` on 2026-09-08.
 */
export function archiveAffordableWriteUnits(allowance: number, factor: number): number {
  if (!Number.isFinite(allowance) || !Number.isFinite(factor)) return 0;
  return Math.max(
    0,
    Math.floor((allowance - ARCHIVE_WRITE_FIXED_RESERVATION) / Math.max(1, factor))
  );
}

/**
 * Largest `session_summaries.message_count` a candidate may carry and still be expected to
 * fit under the allowance, once `overheadPercent` worth of tool-payload, grouped and FTS
 * units are allowed for on top of the raw message rows.
 *
 * Returns 0 when the allowance cannot afford any session at all, which correctly selects
 * nothing rather than fencing a candidate that can never be reserved.
 */
export function archiveAffordableMessageCeiling(
  allowance: number,
  factor: number,
  overheadPercent: number = ARCHIVE_DEFAULT_SWEEP_UNIT_OVERHEAD_PERCENT
): number {
  const units = archiveAffordableWriteUnits(allowance, factor);
  const overhead = Number.isFinite(overheadPercent) ? Math.max(0, overheadPercent) : 0;
  return Math.floor(units / (1 + overhead / 100));
}

/**
 * Why a reservation was refused. The two refusals are NOT interchangeable and a caller
 * that collapses them cannot choose a recovery action (`.claude/rules/72`):
 *
 * - `exceeds_allowance` — this session costs more than the entire daily pool, so no amount
 *   of waiting helps. Recovery: descend to a smaller candidate, and lower the selection
 *   ceiling (or raise the allowance) if every candidate is refused this way.
 * - `window_exhausted` — today's pool is spent. Recovery: nothing; the next UTC window
 *   refills it. This is normal backpressure and happens on most ticks of a day once the
 *   budget has been consumed, so it must never raise an alert.
 * - `invalid_estimate` — the estimate is not a usable positive integer. Recovery: treat as
 *   a defect in the estimator or its inputs.
 */
export type ArchiveWriteRefusalReason =
  | 'invalid_estimate'
  | 'exceeds_allowance'
  | 'window_exhausted';

export type ArchiveWriteReservationOutcome =
  | { reserved: true }
  | { reserved: false; reason: ArchiveWriteRefusalReason };

/** Indexed, session-scoped, capped inventory. Includes FTS text size as well as row count.
 * This is a conservative scheduling estimate, NOT a Cloudflare invoice ceiling.
 */
export function estimateArchiveWrites(
  sql: SqlStorage,
  sessionId: string,
  factor: number,
  maxMessages: number
): number {
  const countQueries = {
    chat_messages:
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM chat_messages WHERE session_id = ? LIMIT ?)',
    tool_payload_archives:
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM tool_payload_archives WHERE session_id = ? LIMIT ?)',
  } as const;
  const count = (table: keyof typeof countQueries) =>
    Number(sql.exec(countQueries[table], sessionId, maxMessages + 1).toArray()[0]?.n ?? 0);
  const raw = count('chat_messages');
  const tools = count('tool_payload_archives');
  const grouped = sql
    .exec(
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM
    (SELECT length(CAST(content AS BLOB)) AS bytes FROM chat_messages_grouped WHERE session_id = ? LIMIT ?)`,
      sessionId,
      maxMessages + 1
    )
    .toArray()[0];
  if (raw > maxMessages || tools > maxMessages || Number(grouped?.n) > maxMessages)
    return Number.MAX_SAFE_INTEGER;
  return (
    ARCHIVE_WRITE_FIXED_RESERVATION +
    factor *
      (raw +
        tools +
        Number(grouped?.n ?? 0) +
        Math.ceil(Number(grouped?.bytes ?? 0) / FTS_BYTES_PER_UNIT))
  );
}

/** One installation-wide atomic reservation, shared by cron, canaries and retries. Never refund an attempted migration:
 * an interrupted attempt may already have written data. A restart cannot refill today's pool.
 */
export async function reserveArchiveWrites(
  db: D1Database,
  estimatedWrites: number,
  allowance: number,
  now: number
): Promise<ArchiveWriteReservationOutcome> {
  if (!Number.isSafeInteger(estimatedWrites) || estimatedWrites <= 0)
    return { reserved: false, reason: 'invalid_estimate' };
  // Returning before the upsert is deliberate — an estimate above the whole allowance can
  // never be satisfied, so charging the window for it would be wrong. It does mean this
  // branch never rolls the window forward, which is why the caller must be able to tell
  // this refusal apart from an exhausted pool and descend instead of ending the tick.
  if (estimatedWrites > allowance) return { reserved: false, reason: 'exceeds_allowance' };
  const window = Math.floor(now / ARCHIVE_BUDGET_WINDOW_MS) * ARCHIVE_BUDGET_WINDOW_MS;
  const row = await db
    .prepare(
      `INSERT INTO project_data_archive_write_budget (id, window_started_at, reserved_writes)
    VALUES ('global', ?, ?)
    ON CONFLICT(id) DO UPDATE SET window_started_at = excluded.window_started_at,
      reserved_writes = CASE WHEN project_data_archive_write_budget.window_started_at < excluded.window_started_at
        THEN excluded.reserved_writes ELSE project_data_archive_write_budget.reserved_writes + excluded.reserved_writes END
    WHERE project_data_archive_write_budget.window_started_at <= excluded.window_started_at
      AND (CASE WHEN project_data_archive_write_budget.window_started_at < excluded.window_started_at
        THEN 0 ELSE project_data_archive_write_budget.reserved_writes END) + excluded.reserved_writes <= ?
    RETURNING reserved_writes`
    )
    .bind(window, estimatedWrites, allowance)
    .first();
  return row !== null ? { reserved: true } : { reserved: false, reason: 'window_exhausted' };
}

/** Call ONLY after a definite journal/lease loss, before any archive RPC began.
 * A failed/ambiguous archive attempt is never eligible. Atomic receipts prevent a
 * duplicated release from subtracting somebody else's allowance; rollover cannot
 * subtract an old reservation from the new day's pool.
 */
export async function releaseUnusedArchiveReservation(
  db: D1Database,
  reservationId: string,
  estimatedWrites: number,
  reservedAt: number,
  env: Pick<
    Env,
    | 'PROJECT_DATA_ARCHIVE_BUDGET_RECEIPT_RETENTION_MS'
    | 'PROJECT_DATA_ARCHIVE_BUDGET_RECEIPT_CLEANUP_LIMIT'
  > = {}
): Promise<void> {
  // Keep receipts at least through their UTC budget window; otherwise a duplicate
  // release could subtract the same reservation again before the window closes.
  const retentionMs = Math.max(
    ARCHIVE_BUDGET_WINDOW_MS,
    positive(
      env.PROJECT_DATA_ARCHIVE_BUDGET_RECEIPT_RETENTION_MS,
      DEFAULT_UNUSED_RESERVATION_RETENTION_MS
    )
  );
  const cleanupLimit = positive(
    env.PROJECT_DATA_ARCHIVE_BUDGET_RECEIPT_CLEANUP_LIMIT,
    DEFAULT_UNUSED_RESERVATION_CLEANUP_LIMIT
  );
  const window = Math.floor(reservedAt / ARCHIVE_BUDGET_WINDOW_MS) * ARCHIVE_BUDGET_WINDOW_MS;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO project_data_archive_unused_reservations
      (reservation_id, window_started_at, estimated_writes, released) VALUES (?, ?, ?, 0)`
      )
      .bind(reservationId, window, estimatedWrites),
    db
      .prepare(
        `UPDATE project_data_archive_write_budget SET reserved_writes = reserved_writes - ?
      WHERE id = 'global' AND window_started_at = ? AND reserved_writes >= ?
      AND EXISTS (SELECT 1 FROM project_data_archive_unused_reservations WHERE reservation_id = ?
        AND window_started_at = ? AND estimated_writes = ? AND released = 0)`
      )
      .bind(estimatedWrites, window, estimatedWrites, reservationId, window, estimatedWrites),
    db
      .prepare(
        'UPDATE project_data_archive_unused_reservations SET released = 1 WHERE reservation_id = ?'
      )
      .bind(reservationId),
    // Indexed bounded retention; old-window releases cannot affect today's pool.
    db
      .prepare(
        `DELETE FROM project_data_archive_unused_reservations WHERE reservation_id IN
      (SELECT reservation_id FROM project_data_archive_unused_reservations WHERE window_started_at < ?
       ORDER BY window_started_at LIMIT ?)`
      )
      .bind(window - retentionMs, cleanupLimit),
  ]);
}
