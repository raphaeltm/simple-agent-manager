/**
 * Attention markers — durable state tracking which sessions need human or system action.
 *
 * Attention markers are separate from notifications (delivery/inbox artifacts)
 * and task lifecycle status. They represent current product state:
 * "this session needs attention right now."
 */
import { createModuleLogger } from '../../lib/logger';
import {
  parseAttentionExpiryRow,
  parseAttentionMarkerRow,
  parseAttentionSummaryRow,
} from './row-schemas';
import { generateId } from './types';

const log = createModuleLogger('attention');

// Default 2-hour expiry for human input requests
const DEFAULT_HUMAN_INPUT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface CreateAttentionMarkerOpts {
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  kind: string;
  source: string;
  sourceEventId?: string | null;
  sourceMessageId?: string | null;
  sourceNotificationId?: string | null;
  reason?: string | null;
  metadata?: string | null;
  expiresAt?: number | null;
}

export function createAttentionMarker(
  sql: SqlStorage,
  opts: CreateAttentionMarkerOpts,
): { id: string; createdAt: number; expiresAt: number | null } {
  const id = generateId();
  const now = Date.now();

  sql.exec(
    `INSERT INTO session_attention_markers
       (id, session_id, task_id, workspace_id, kind, source,
        source_event_id, source_message_id, source_notification_id,
        reason, metadata, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    opts.sessionId,
    opts.taskId ?? null,
    opts.workspaceId ?? null,
    opts.kind,
    opts.source,
    opts.sourceEventId ?? null,
    opts.sourceMessageId ?? null,
    opts.sourceNotificationId ?? null,
    opts.reason ?? null,
    opts.metadata ?? null,
    now,
    opts.expiresAt ?? null,
  );

  log.info('attention_marker.created', {
    id,
    sessionId: opts.sessionId,
    kind: opts.kind,
    source: opts.source,
    expiresAt: opts.expiresAt ?? null,
  });

  return { id, createdAt: now, expiresAt: opts.expiresAt ?? null };
}

/**
 * Resolve all active attention markers for a session.
 * Called when a human message arrives, indicating the human has responded.
 */
export function resolveAttentionMarkers(
  sql: SqlStorage,
  sessionId: string,
  resolvedByMessageId: string | null,
  actorType: string = 'human',
  reason: string = 'human_message',
): number {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE session_attention_markers
     SET resolved_at = ?, resolved_by_message_id = ?,
         resolved_by_actor_type = ?, resolved_reason = ?
     WHERE session_id = ? AND resolved_at IS NULL`,
    now,
    resolvedByMessageId,
    actorType,
    reason,
    sessionId,
  );

  if (cursor.rowsWritten > 0) {
    log.info('attention_markers.resolved', {
      sessionId,
      count: cursor.rowsWritten,
      actorType,
      reason,
    });
  }

  return cursor.rowsWritten;
}

/**
 * Resolve active attention markers of a specific kind for a session.
 * Used when system-owned markers can be satisfied by agent activity without
 * clearing human-owned markers like `needs_input`.
 */
export function resolveAttentionMarkersByKind(
  sql: SqlStorage,
  sessionId: string,
  kind: string,
  resolvedByMessageId: string | null,
  actorType: string,
  reason: string,
): number {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE session_attention_markers
     SET resolved_at = ?, resolved_by_message_id = ?,
         resolved_by_actor_type = ?, resolved_reason = ?
     WHERE session_id = ? AND kind = ? AND resolved_at IS NULL`,
    now,
    resolvedByMessageId,
    actorType,
    reason,
    sessionId,
    kind,
  );

  if (cursor.rowsWritten > 0) {
    log.info('attention_markers.resolved_by_kind', {
      sessionId,
      kind,
      count: cursor.rowsWritten,
      actorType,
      reason,
    });
  }

  return cursor.rowsWritten;
}

/**
 * Resolve a single attention marker by ID.
 * Used by the alarm handler to resolve only the specific expired marker,
 * without affecting other active markers on the same session.
 */
export function resolveAttentionMarkerById(
  sql: SqlStorage,
  markerId: string,
  actorType: string = 'system',
  reason: string = 'expired',
): number {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE session_attention_markers
     SET resolved_at = ?, resolved_by_actor_type = ?, resolved_reason = ?
     WHERE id = ? AND resolved_at IS NULL`,
    now,
    actorType,
    reason,
    markerId,
  );

  if (cursor.rowsWritten > 0) {
    log.info('attention_marker.resolved_by_id', {
      markerId,
      actorType,
      reason,
    });
  }

  return cursor.rowsWritten;
}

/**
 * List all active (unresolved) attention markers for a session.
 */
export function listActiveAttentionMarkers(
  sql: SqlStorage,
  sessionId: string,
) {
  const rows = sql
    .exec(
      `SELECT * FROM session_attention_markers
       WHERE session_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC`,
      sessionId,
    )
    .toArray();
  return rows.map((r) => parseAttentionMarkerRow(r));
}

/**
 * Get a lightweight attention summary for session list enrichment.
 * Returns the most recent active marker, or null if none.
 */
export function getAttentionSummary(
  sql: SqlStorage,
  sessionId: string,
): { kind: string; createdAt: number; expiresAt: number | null; reason: string | null } | null {
  const rows = sql
    .exec(
      `SELECT kind, created_at, expires_at, reason
       FROM session_attention_markers
       WHERE session_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      sessionId,
    )
    .toArray();
  if (rows.length === 0) return null;
  return parseAttentionSummaryRow(rows[0]);
}

/**
 * Get expired markers that are still active (unresolved).
 * Used by the alarm handler to process expiry.
 */
export function getExpiredMarkers(
  sql: SqlStorage,
  now: number = Date.now(),
) {
  const rows = sql
    .exec(
      `SELECT id, session_id, task_id, workspace_id, kind
       FROM session_attention_markers
       WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      now,
    )
    .toArray();
  return rows.map((r) => parseAttentionExpiryRow(r));
}

/**
 * Compute the earliest alarm time based on active attention marker expiry.
 * Returns null if no active markers have an expiry set.
 */
export function computeAttentionAlarmTime(sql: SqlStorage): number | null {
  const rows = sql
    .exec(
      `SELECT MIN(expires_at) as earliest
       FROM session_attention_markers
       WHERE resolved_at IS NULL AND expires_at IS NOT NULL`,
    )
    .toArray();
  const row = rows[0];
  if (!row || row.earliest === null || row.earliest === undefined) return null;
  return row.earliest as number;
}

/**
 * Compute the expiry time for a needs_input marker based on env config.
 */
export function computeHumanInputExpiry(
  humanInputTimeoutMs: string | undefined,
): number {
  const parsed = parseInt(humanInputTimeoutMs ?? '', 10);
  const timeoutMs = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_HUMAN_INPUT_TIMEOUT_MS;
  return Date.now() + timeoutMs;
}
