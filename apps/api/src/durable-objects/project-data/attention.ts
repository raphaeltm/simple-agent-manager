/**
 * Attention markers — durable state tracking which sessions need human or system action.
 *
 * Attention markers are separate from notifications (delivery/inbox artifacts)
 * and task lifecycle status. They represent current product state:
 * "this session needs attention right now."
 */
import {
  DEFAULT_HUMAN_INPUT_ESCALATION_FRACTIONS,
  DEFAULT_HUMAN_INPUT_MAX_WAIT_MS,
  DEFAULT_HUMAN_INPUT_TIMEOUT_MS,
  DEFAULT_HUMAN_INPUT_UNDELIVERED_GRACE_MS,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { parseJsonRecord } from '../../lib/runtime-validation';
import {
  parseAttentionExpiryRow,
  parseAttentionMarkerRow,
  parseAttentionSummaryRow,
} from './row-schemas';
import { generateId } from './types';

const log = createModuleLogger('attention');

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
  notificationUserId?: string | null;
  nextEscalationAt?: number | null;
  maxExpiresAt?: number | null;
}

export function createAttentionMarker(
  sql: SqlStorage,
  opts: CreateAttentionMarkerOpts
): { id: string; createdAt: number; expiresAt: number | null } {
  const id = generateId();
  const now = Date.now();

  sql.exec(
    `INSERT INTO session_attention_markers
       (id, session_id, task_id, workspace_id, kind, source,
        source_event_id, source_message_id, source_notification_id,
        reason, metadata, created_at, expires_at, notification_user_id,
        next_escalation_at, max_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    opts.notificationUserId ?? null,
    opts.nextEscalationAt ?? null,
    opts.maxExpiresAt ?? null
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
  reason: string = 'human_message'
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
    sessionId
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
  reason: string
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
    kind
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
  reason: string = 'expired'
): number {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE session_attention_markers
     SET resolved_at = ?, resolved_by_actor_type = ?, resolved_reason = ?
     WHERE id = ? AND resolved_at IS NULL`,
    now,
    actorType,
    reason,
    markerId
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

export function linkAttentionNotification(
  sql: SqlStorage,
  markerId: string,
  notificationUserId: string,
  notificationId: string
): boolean {
  return (
    sql.exec(
      `UPDATE session_attention_markers
     SET notification_user_id = ?, source_notification_id = ?
     WHERE id = ? AND resolved_at IS NULL`,
      notificationUserId,
      notificationId,
      markerId
    ).rowsWritten > 0
  );
}

export type PrepareAttentionAnswerResult =
  | { status: 'ready' }
  | { status: 'not_found' }
  | { status: 'already_resolved'; answer: string | null }
  | { status: 'in_flight'; answer: string }
  | { status: 'conflicting_answer'; answer: string }
  | { status: 'invalid_option'; options: string[] };

/**
 * Validate and durably stage a structured answer before it is sent to the
 * agent. Staging first preserves the user's choice if normal chat persistence
 * wins the race and resolves the marker through the existing human-message
 * path.
 */
export function prepareAttentionAnswer(
  sql: SqlStorage,
  sessionId: string,
  markerId: string,
  answer: string
): PrepareAttentionAnswerResult {
  const rows = sql
    .exec(
      `SELECT * FROM session_attention_markers
     WHERE id = ? AND session_id = ? AND kind = 'needs_input'
     LIMIT 1`,
      markerId,
      sessionId
    )
    .toArray();
  if (rows.length === 0) return { status: 'not_found' };

  const marker = parseAttentionMarkerRow(rows[0]);
  if (marker.resolvedAt !== null) {
    return { status: 'already_resolved', answer: marker.resolvedAnswer };
  }

  // A staged answer is an atomic delivery claim. Durable Object RPCs execute
  // serially, so only the request that observes NULL may forward to the agent.
  // Same-answer replays wait for that request; conflicting devices are rejected.
  if (marker.resolvedAnswer !== null) {
    return marker.resolvedAnswer === answer
      ? { status: 'in_flight', answer }
      : { status: 'conflicting_answer', answer: marker.resolvedAnswer };
  }

  const options = parseAttentionOptions(marker.metadata);
  if (options.length > 0 && !options.includes(answer)) {
    return { status: 'invalid_option', options };
  }

  const claimed = sql.exec(
    `UPDATE session_attention_markers
     SET resolved_answer = ?
     WHERE id = ? AND session_id = ? AND resolved_at IS NULL AND resolved_answer IS NULL`,
    answer,
    markerId,
    sessionId
  );
  return claimed.rowsWritten > 0 ? { status: 'ready' } : { status: 'in_flight', answer };
}

/** Release only the matching staged claim when forwarding did not reach the agent. */
export function releaseAttentionAnswer(
  sql: SqlStorage,
  sessionId: string,
  markerId: string,
  answer: string
): number {
  return sql.exec(
    `UPDATE session_attention_markers
     SET resolved_answer = NULL
     WHERE id = ? AND session_id = ? AND kind = 'needs_input'
       AND resolved_at IS NULL AND resolved_answer = ?`,
    markerId,
    sessionId,
    answer
  ).rowsWritten;
}

/** Finalize a staged structured answer after the prompt reaches the agent. */
export function completeAttentionAnswer(
  sql: SqlStorage,
  sessionId: string,
  markerId: string,
  answer: string
): number {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE session_attention_markers
     SET resolved_at = ?, resolved_by_actor_type = 'human',
         resolved_reason = 'structured_answer', resolved_answer = ?
     WHERE id = ? AND session_id = ? AND kind = 'needs_input'
       AND resolved_at IS NULL AND resolved_answer = ?`,
    now,
    answer,
    markerId,
    sessionId,
    answer
  );
  return cursor.rowsWritten;
}

export function parseAttentionOptions(metadata: string | null): string[] {
  if (!metadata) return [];
  try {
    const options = parseJsonRecord(metadata, 'attention.metadata').options;
    return Array.isArray(options)
      ? options.filter((option): option is string => typeof option === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * List all active (unresolved) attention markers for a session.
 */
export function listActiveAttentionMarkers(sql: SqlStorage, sessionId: string) {
  const rows = sql
    .exec(
      `SELECT * FROM session_attention_markers
       WHERE session_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC`,
      sessionId
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
  sessionId: string
): {
  markerId: string;
  kind: string;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
  options: string[];
} | null {
  const rows = sql
    .exec(
      `SELECT id, kind, created_at, expires_at, reason, metadata
       FROM session_attention_markers
       WHERE session_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      sessionId
    )
    .toArray();
  if (rows.length === 0) return null;
  const summary = parseAttentionSummaryRow(rows[0]);
  const { metadata, ...publicSummary } = summary;
  return { ...publicSummary, options: parseAttentionOptions(metadata) };
}

/**
 * Get expired markers that are still active (unresolved).
 * Used by the alarm handler to process expiry.
 */
export function getExpiredMarkers(sql: SqlStorage, now: number = Date.now()) {
  const rows = sql
    .exec(
      `SELECT id, session_id, task_id, workspace_id, kind,
              source_notification_id, notification_user_id, created_at,
              expires_at, next_escalation_at, escalation_count, max_expires_at
       FROM session_attention_markers
       WHERE resolved_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      now
    )
    .toArray();
  return rows.map((r) => parseAttentionExpiryRow(r));
}

/** Needs-input markers whose next reminder is due before their terminal deadline. */
export function getDueAttentionEscalations(sql: SqlStorage, now: number = Date.now()) {
  const rows = sql
    .exec(
      `SELECT id, session_id, task_id, workspace_id, kind,
            source_notification_id, notification_user_id, created_at,
            expires_at, next_escalation_at, escalation_count, max_expires_at
     FROM session_attention_markers
     WHERE resolved_at IS NULL
       AND kind = 'needs_input'
       AND next_escalation_at IS NOT NULL
       AND next_escalation_at <= ?
       AND (expires_at IS NULL OR expires_at > ?)`,
      now,
      now
    )
    .toArray();
  return rows.map((row) => parseAttentionExpiryRow(row));
}

export function parseHumanInputEscalationFractions(value?: string): number[] {
  const parsed = (value ?? DEFAULT_HUMAN_INPUT_ESCALATION_FRACTIONS)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((fraction) => Number.isFinite(fraction) && fraction > 0 && fraction < 1);
  return [...new Set(parsed)].sort((left, right) => left - right);
}

export function advanceAttentionEscalation(
  sql: SqlStorage,
  marker: ReturnType<typeof getDueAttentionEscalations>[number],
  escalationFractions: string | undefined
): void {
  const fractions = parseHumanInputEscalationFractions(escalationFractions);
  const nextCount = marker.escalationCount + 1;
  const nextFraction = fractions[nextCount] ?? null;
  const initialWindow = Math.max(0, (marker.expiresAt ?? marker.createdAt) - marker.createdAt);
  const nextEscalationAt =
    nextFraction === null ? null : marker.createdAt + Math.round(initialWindow * nextFraction);
  sql.exec(
    `UPDATE session_attention_markers
     SET escalation_count = ?, next_escalation_at = ?
     WHERE id = ? AND resolved_at IS NULL`,
    nextCount,
    nextEscalationAt,
    marker.id
  );
}

export function extendAttentionExpiry(sql: SqlStorage, markerId: string, expiresAt: number): void {
  sql.exec(
    `UPDATE session_attention_markers
     SET expires_at = ?, next_escalation_at = NULL
     WHERE id = ? AND resolved_at IS NULL`,
    expiresAt,
    markerId
  );
}

/**
 * Compute the earliest alarm time based on active attention marker expiry.
 * Returns null if no active markers have an expiry set.
 */
export function computeAttentionAlarmTime(sql: SqlStorage): number | null {
  const rows = sql
    .exec(
      `SELECT MIN(deadline) as earliest FROM (
         SELECT expires_at AS deadline
         FROM session_attention_markers
         WHERE resolved_at IS NULL AND expires_at IS NOT NULL
         UNION ALL
         SELECT next_escalation_at AS deadline
         FROM session_attention_markers
         WHERE resolved_at IS NULL AND next_escalation_at IS NOT NULL
       )`
    )
    .toArray();
  const row = rows[0];
  if (row?.earliest === null || row?.earliest === undefined) return null;
  return row.earliest as number;
}

/**
 * Compute the expiry time for a needs_input marker based on env config.
 */
export function computeHumanInputExpiry(humanInputTimeoutMs: string | undefined): number {
  const parsed = Number.parseInt(humanInputTimeoutMs ?? '', 10);
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HUMAN_INPUT_TIMEOUT_MS;
  return Date.now() + timeoutMs;
}

export function computeHumanInputSchedule(
  env: {
    HUMAN_INPUT_TIMEOUT_MS?: string;
    HUMAN_INPUT_ESCALATION_FRACTIONS?: string;
    HUMAN_INPUT_MAX_WAIT_MS?: string;
  },
  now: number = Date.now()
): { expiresAt: number; nextEscalationAt: number | null; maxExpiresAt: number } {
  const timeout = positiveEnvNumber(env.HUMAN_INPUT_TIMEOUT_MS, DEFAULT_HUMAN_INPUT_TIMEOUT_MS);
  const maxWait = Math.max(
    timeout,
    positiveEnvNumber(env.HUMAN_INPUT_MAX_WAIT_MS, DEFAULT_HUMAN_INPUT_MAX_WAIT_MS)
  );
  const firstFraction =
    parseHumanInputEscalationFractions(env.HUMAN_INPUT_ESCALATION_FRACTIONS)[0] ?? null;
  return {
    expiresAt: now + timeout,
    nextEscalationAt: firstFraction === null ? null : now + Math.round(timeout * firstFraction),
    maxExpiresAt: now + maxWait,
  };
}

export function humanInputUndeliveredGraceMs(value?: string): number {
  return positiveEnvNumber(value, DEFAULT_HUMAN_INPUT_UNDELIVERED_GRACE_MS);
}

export function humanInputMaxWaitMs(value?: string): number {
  return positiveEnvNumber(value, DEFAULT_HUMAN_INPUT_MAX_WAIT_MS);
}

function positiveEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
