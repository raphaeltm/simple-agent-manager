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
  DEFAULT_HUMAN_INPUT_UNDELIVERED_GRACE_MS,
} from '@simple-agent-manager/shared';
import { createModuleLogger } from '@simple-agent-manager/worker-core';
import { parseJsonRecord } from '@simple-agent-manager/worker-core';

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
  // Counted from RETURNING: Durable Object `rowsWritten` also counts index entries.
  const count = sql
    .exec(
      `UPDATE session_attention_markers
       SET resolved_at = ?, resolved_by_message_id = ?,
           resolved_by_actor_type = ?, resolved_reason = ?
       WHERE session_id = ? AND resolved_at IS NULL
       RETURNING id`,
      now,
      resolvedByMessageId,
      actorType,
      reason,
      sessionId
    )
    .toArray().length;

  if (count > 0) {
    log.info('attention_markers.resolved', { sessionId, count, actorType, reason });
  }

  return count;
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
  const count = sql
    .exec(
      `UPDATE session_attention_markers
       SET resolved_at = ?, resolved_by_message_id = ?,
           resolved_by_actor_type = ?, resolved_reason = ?
       WHERE session_id = ? AND kind = ? AND resolved_at IS NULL
       RETURNING id`,
      now,
      resolvedByMessageId,
      actorType,
      reason,
      sessionId,
      kind
    )
    .toArray().length;

  if (count > 0) {
    log.info('attention_markers.resolved_by_kind', { sessionId, kind, count, actorType, reason });
  }

  return count;
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
  const count = sql
    .exec(
      `UPDATE session_attention_markers
       SET resolved_at = ?, resolved_by_actor_type = ?, resolved_reason = ?
       WHERE id = ? AND resolved_at IS NULL
       RETURNING id`,
      now,
      actorType,
      reason,
      markerId
    )
    .toArray().length;

  if (count > 0) {
    log.info('attention_marker.resolved_by_id', { markerId, actorType, reason });
  }

  return count;
}


export type PrepareAttentionAnswerResult =
  | { status: 'ready' }
  | { status: 'not_found' }
  | { status: 'unsupported_source'; source: string }
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
/**
 * Staged value of an inbox archive claim (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9). It shares the answer
 * claim column so an answer and an archive exclude each other through one compare-and-set; the
 * NUL prefix keeps it out of reach of a typed or agent-offered answer.
 */
export const ATTENTION_ARCHIVE_CLAIM = '\u0000sam:inbox-archived';

/** `answer` stages the person's answer; `archive` stages the inbox archive claim instead. */
export type AttentionClaimMode = 'answer' | 'archive';

function claimValue(mode: AttentionClaimMode, answer: string): string {
  return mode === 'archive' ? ATTENTION_ARCHIVE_CLAIM : answer;
}

export function prepareAttentionAnswer(
  sql: SqlStorage,
  sessionId: string,
  markerId: string,
  rawAnswer: string,
  mode: AttentionClaimMode = 'answer'
): PrepareAttentionAnswerResult {
  const answer = claimValue(mode, rawAnswer);
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
  if (marker.source === 'acp_interaction') {
    return { status: 'unsupported_source', source: marker.source };
  }
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
  if (mode === 'answer') {
    if (answer.startsWith('\u0000')) return { status: 'invalid_option', options };
    if (options.length > 0 && !options.includes(answer)) {
      return { status: 'invalid_option', options };
    }
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
  rawAnswer: string,
  mode: AttentionClaimMode = 'answer'
): number {
  const answer = claimValue(mode, rawAnswer);
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
  rawAnswer: string,
  mode: AttentionClaimMode = 'answer'
): number {
  const now = Date.now();
  const staged = claimValue(mode, rawAnswer);
  // An archived question records no answer: the person chose not to act.
  return sql
    .exec(
      `UPDATE session_attention_markers
       SET resolved_at = ?, resolved_by_actor_type = 'human',
           resolved_reason = ?, resolved_answer = ?
       WHERE id = ? AND session_id = ? AND kind = 'needs_input'
         AND resolved_at IS NULL AND resolved_answer = ?
       RETURNING id`,
      now,
      mode === 'archive' ? 'archived' : 'structured_answer',
      mode === 'archive' ? null : staged,
      markerId,
      sessionId,
      staged
    )
    .toArray().length;
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
/** Canonical question, including settled requests. Both IDs scope the lookup. */
export function getAttentionMarker(sql: SqlStorage, sessionId: string, markerId: string) {
  const row = sql
    .exec(
      'SELECT * FROM session_attention_markers WHERE session_id = ? AND id = ? LIMIT 1',
      sessionId,
      markerId
    )
    .toArray()[0];
  return row ? parseAttentionMarkerRow(row) : null;
}

export function listActiveAttentionMarkers(sql: SqlStorage, sessionId: string) {
  const rows = sql
    .exec(
      `SELECT * FROM session_attention_markers
       WHERE session_id = ? AND resolved_at IS NULL
       ORDER BY created_at DESC`,
      sessionId
    )
    .toArray();
  const markers: ReturnType<typeof parseAttentionMarkerRow>[] = [];
  for (const row of rows) {
    try {
      markers.push(parseAttentionMarkerRow(row));
    } catch (error) {
      // One malformed marker must not hide the session's other open questions (rule 50).
      log.warn('attention_marker.list_row_skipped', {
        sessionId,
        markerId: typeof row.id === 'string' ? row.id : null,
        error: String(error),
      });
    }
  }
  return markers;
}

/** Cheap watchdog guard; the attention expiry owner handles elapsed deadlines. */
export function hasPendingHumanInput(
  sql: SqlStorage,
  sessionId: string,
  taskId: string,
  now: number
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM session_attention_markers
     WHERE session_id = ? AND resolved_at IS NULL AND kind = 'needs_input'
       AND (task_id IS NULL OR task_id = ?)
       AND expires_at > ?
     LIMIT 1`,
        sessionId,
        taskId,
        now
      )
      .toArray().length > 0
  );
}

/**
 * Get a lightweight attention summary for session list enrichment.
 * Returns one active marker, or null if none: the newest question for a person (`needs_input`)
 * when there is one, otherwise the newest marker of any kind. A later system marker such as
 * `wake_failed` must not hide a question the agent is still waiting on.
 */
export function getAttentionSummary(
  sql: SqlStorage,
  sessionId: string
): {
  markerId: string;
  kind: string;
  /** `request_human_input`, `acp_interaction`, or another producer; null on legacy rows. */
  source: string | null;
  createdAt: number;
  expiresAt: number | null;
  reason: string | null;
  options: string[];
  /** The `request_human_input` category, when recorded. */
  category: string | null;
  /** For a mirrored runtime interaction: its id and kind (`permission`, `form`, `url`). */
  interactionId: string | null;
  interactionKind: string | null;
} | null {
  const rows = sql
    .exec(
      `SELECT id, kind, source, created_at, expires_at, reason, metadata
       FROM session_attention_markers
       WHERE session_id = ? AND resolved_at IS NULL
       ORDER BY CASE WHEN kind = 'needs_input' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
      sessionId
    )
    .toArray();
  if (rows.length === 0) return null;
  const summary = parseAttentionSummaryRow(rows[0]);
  const { metadata, ...publicSummary } = summary;
  // The inbox reads these from `session_summaries.attention_json` (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9).
  return {
    ...publicSummary,
    options: parseAttentionOptions(metadata),
    ...attentionSummaryMetadataFields(metadata),
  };
}

/** Metadata fields the inbox needs; a malformed blob yields nulls, never a throw. */
function attentionSummaryMetadataFields(metadata: string | null): {
  category: string | null;
  interactionId: string | null;
  interactionKind: string | null;
} {
  const empty = { category: null, interactionId: null, interactionKind: null };
  if (!metadata) return empty;
  try {
    const record = parseJsonRecord(metadata, 'attention.metadata');
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return {
      category: text(record.category),
      interactionId: text(record.interactionId),
      interactionKind: record.source === 'acp_interaction' ? text(record.kind) : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Get expired markers that are still active (unresolved).
 * Used by the alarm handler to process expiry.
 */
export function getExpiredMarkers(sql: SqlStorage, now: number = Date.now()) {
  const rows = sql
    .exec(
      `SELECT id, session_id, task_id, workspace_id, kind, source,
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
      `SELECT id, session_id, task_id, workspace_id, kind, source,
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
