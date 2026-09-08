import type { Env } from '../env';

export const ARCHIVE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ARCHIVE_DEFAULT_DAILY_WRITE_BUDGET = 250_000;
export const ARCHIVE_DEFAULT_WRITE_FACTOR = 32;
export const ARCHIVE_WRITE_FIXED_RESERVATION = 1_000;
const FTS_BYTES_PER_UNIT = 512;

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid archive write budget configuration');
  return n;
}
export function archiveWriteBudgetConfig(env: Pick<Env,
  'PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET' | 'PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR'>) {
  return { allowance: positive(env.PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET, ARCHIVE_DEFAULT_DAILY_WRITE_BUDGET),
    factor: Math.max(1, positive(env.PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR, ARCHIVE_DEFAULT_WRITE_FACTOR)) };
}
export type ArchiveWriteReservation = { estimatedWrites: number; factor: number; maxMessages: number };

/** Indexed, session-scoped, capped inventory. Includes FTS text size as well as row count.
 * This is a conservative scheduling estimate, NOT a Cloudflare invoice ceiling.
 */
export function estimateArchiveWrites(sql: SqlStorage, sessionId: string, factor: number, maxMessages: number): number {
  const count = (table: string) => Number(sql.exec(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE session_id = ? LIMIT ?)`, sessionId, maxMessages + 1
  ).toArray()[0]?.n ?? 0);
  const raw = count('chat_messages');
  const tools = count('tool_payload_archives');
  const grouped = sql.exec(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM
    (SELECT length(CAST(content AS BLOB)) AS bytes FROM chat_messages_grouped WHERE session_id = ? LIMIT ?)`,
    sessionId, maxMessages + 1).toArray()[0];
  if (raw > maxMessages || tools > maxMessages || Number(grouped?.n) > maxMessages) return Number.MAX_SAFE_INTEGER;
  return ARCHIVE_WRITE_FIXED_RESERVATION + factor * (raw + tools + Number(grouped?.n ?? 0) + Math.ceil(Number(grouped?.bytes ?? 0) / FTS_BYTES_PER_UNIT));
}

/** One account-wide atomic reservation, shared by cron, canaries and retries. Never refunded:
 * an interrupted attempt may already have written data. A restart cannot refill today's pool.
 */
export async function reserveArchiveWrites(db: D1Database, estimatedWrites: number, allowance: number, now: number): Promise<boolean> {
  if (!Number.isSafeInteger(estimatedWrites) || estimatedWrites <= 0 || estimatedWrites > allowance) return false;
  const window = Math.floor(now / ARCHIVE_BUDGET_WINDOW_MS) * ARCHIVE_BUDGET_WINDOW_MS;
  const row = await db.prepare(`INSERT INTO project_data_archive_write_budget (id, window_started_at, reserved_writes)
    VALUES ('global', ?, ?)
    ON CONFLICT(id) DO UPDATE SET window_started_at = excluded.window_started_at,
      reserved_writes = CASE WHEN project_data_archive_write_budget.window_started_at < excluded.window_started_at
        THEN excluded.reserved_writes ELSE project_data_archive_write_budget.reserved_writes + excluded.reserved_writes END
    WHERE project_data_archive_write_budget.window_started_at <= excluded.window_started_at
      AND (CASE WHEN project_data_archive_write_budget.window_started_at < excluded.window_started_at
        THEN 0 ELSE project_data_archive_write_budget.reserved_writes END) + excluded.reserved_writes <= ?
    RETURNING reserved_writes`).bind(window, estimatedWrites, allowance).first();
  return row !== null;
}
