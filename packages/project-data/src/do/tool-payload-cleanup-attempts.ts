import type { ToolPayloadCleanupCursor } from './tool-payload-cleanup-candidates';

const MAX_TOOL_PAYLOAD_CLEANUP_ERROR_LENGTH = 500;

export const TOOL_PAYLOAD_CLEANUP_RETRYABLE_STATUS = 'retryable_failure';
export const TOOL_PAYLOAD_CLEANUP_TERMINAL_STATUSES = [
  'no_reclaimable_payload',
  'invalid_metadata',
  'oversized',
] as const;

export type ToolPayloadCleanupTerminalStatus =
  (typeof TOOL_PAYLOAD_CLEANUP_TERMINAL_STATUSES)[number];

export type ToolPayloadCleanupAttemptStatus =
  | ToolPayloadCleanupTerminalStatus
  | typeof TOOL_PAYLOAD_CLEANUP_RETRYABLE_STATUS;

function truncateAttemptError(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= MAX_TOOL_PAYLOAD_CLEANUP_ERROR_LENGTH
    ? value
    : value.slice(0, MAX_TOOL_PAYLOAD_CLEANUP_ERROR_LENGTH);
}

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function recordToolPayloadCleanupAttempt(
  sql: SqlStorage,
  candidate: ToolPayloadCleanupCursor,
  status: ToolPayloadCleanupAttemptStatus,
  attemptedAt: number,
  errorMessage: string | null,
  nextAttemptAt: number | null = null
): void {
  sql.exec(
    `INSERT INTO tool_payload_cleanup_attempts (
       message_id,
       status,
       failure_count,
       next_attempt_at,
       last_attempt_at,
       last_error,
       message_created_at,
       message_sequence
     )
     VALUES (?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       status = excluded.status,
       failure_count = tool_payload_cleanup_attempts.failure_count + 1,
       next_attempt_at = excluded.next_attempt_at,
       last_attempt_at = excluded.last_attempt_at,
       last_error = excluded.last_error,
       message_created_at = excluded.message_created_at,
       message_sequence = excluded.message_sequence`,
    candidate.messageId,
    status,
    nextAttemptAt,
    attemptedAt,
    truncateAttemptError(errorMessage),
    candidate.createdAt,
    candidate.sequence
  );
}

export function clearToolPayloadCleanupAttempt(sql: SqlStorage, messageId: string): void {
  sql.exec('DELETE FROM tool_payload_cleanup_attempts WHERE message_id = ?', messageId);
}

export function readNextToolPayloadCleanupRetryAt(
  sql: SqlStorage,
  afterMs: number
): number | null {
  const rows = sql
    .exec(
      `SELECT MIN(next_attempt_at) AS next_attempt_at
       FROM tool_payload_cleanup_attempts
       WHERE status = ?
         AND next_attempt_at IS NOT NULL
         AND next_attempt_at > ?`,
      TOOL_PAYLOAD_CLEANUP_RETRYABLE_STATUS,
      afterMs
    )
    .raw();
  const firstRow = rows.next().value;
  return firstRow === undefined ? null : rawNumber(firstRow[0]);
}
