/**
 * Shared session access grants: storage and reads (DO migrations 064 and 065, idea
 * 01M59MYE4GY91BWTE8TZF1ZB5D). The row shape, the SQL, the access resolution every check uses,
 * and the queued-prompt cancellation that ending access performs. Writes that create or end
 * grants live in ./session-access; expiry cleanup and the delivery fence in
 * ./session-access-expiry.
 *
 * Expiry is computed, never written: a grant is active while `revoked_at IS NULL AND
 * expires_at > now`, read against server time on every check, so authorization never depends
 * on when an alarm fires or what a browser timer shows.
 */
import * as v from 'valibot';

import { createModuleLogger } from '../../lib/logger';
import { parseRow } from './row-schemas';

const log = createModuleLogger('project_data.session_access');

/** Prompt sources a human session writer can originate; only these are sender-fenced. */
export const SESSION_WRITER_PROMPT_SOURCES = ['user_followup', 'comment_directive'] as const;

/** Terminal reason recorded on a queued delivery cancelled because its sender lost access. */
export const SENDER_ACCESS_REVOKED_REASON = 'sender_access_revoked';
/** Terminal reason recorded on a queued delivery cancelled because its sender's access expired. */
export const SENDER_ACCESS_EXPIRED_REASON = 'sender_access_expired';
export type SenderAccessEndedReason =
  typeof SENDER_ACCESS_REVOKED_REASON | typeof SENDER_ACCESS_EXPIRED_REASON;
/** The error a delivery records when its sender's access ended, by reason. */
export const SENDER_ACCESS_ENDED_ERRORS: Record<SenderAccessEndedReason, string> = {
  [SENDER_ACCESS_REVOKED_REASON]: 'The sender no longer has access to this session',
  [SENDER_ACCESS_EXPIRED_REASON]: "The sender's access to this session expired",
};

/**
 * Most expired grants the alarm sweep handles in one pass. A safety bound, not a tunable: each
 * one costs a few local statements, and any left over keep the section due for the next alarm.
 */
export const SESSION_ACCESS_EXPIRY_SWEEP_LIMIT = 200;

const GrantRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  grantee_user_id: v.string(),
  granted_by_user_id: v.string(),
  parent_grant_id: v.nullable(v.string()),
  created_at: v.number(),
  // NULL only on grants from before migration 065, which count as expired (fail closed).
  expires_at: v.nullable(v.number()),
  duration_minutes: v.nullable(v.number()),
});

export interface SessionAccessGrantRecord {
  id: string;
  sessionId: string;
  granteeUserId: string;
  grantedByUserId: string;
  parentGrantId: string | null;
  createdAt: number;
  /** Null only on grants from before expiry existed; such a grant is never active. */
  expiresAt: number | null;
  durationMinutes: number | null;
}

export type SessionAccessRole = 'owner' | 'grantee' | 'none';

export interface SessionAccessResolution {
  /** False when the session does not exist in this project. */
  found: boolean;
  ownerUserId: string | null;
  sessionStatus: string | null;
  role: SessionAccessRole;
  /** The caller's own active grant when `role === 'grantee'`. */
  grant: SessionAccessGrantRecord | null;
}

export const MINUTE_MS = 60_000;

const GRANT_COLUMNS =
  'id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at, expires_at, duration_minutes';

// Whole statements built once at module load from the static column list, so no caller value
// ever reaches SQL text (the same pattern as CLAIM_DUE_PROMPT_DELIVERIES_SQL).
//
// "Active" means unrevoked AND unexpired against the `now` the caller binds. "Unrevoked" rows
// may have expired: they still hold the one-row-per-person slot of the unique index, so a
// regrant reuses that row, and revocation cascades still reach them.
const READ_ACTIVE_GRANT_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE session_id = ? AND grantee_user_id = ? AND revoked_at IS NULL AND expires_at > ?
  LIMIT 1`;
const READ_UNREVOKED_GRANT_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE session_id = ? AND grantee_user_id = ? AND revoked_at IS NULL
  LIMIT 1`;
const LIST_ACTIVE_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?
  ORDER BY created_at ASC, id ASC`;
export const COUNT_ACTIVE_GRANTS_SQL = `SELECT COUNT(*) AS count FROM chat_session_access_grants
  WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?`;
export const LIST_UNREVOKED_CHILD_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE parent_grant_id = ? AND revoked_at IS NULL`;
export const LIST_UNREVOKED_GRANTS_HELD_BY_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE grantee_user_id = ? AND revoked_at IS NULL`;
// The expiry sweep's candidates and its schedule read the same predicate (.claude/rules/47):
// every row the sweep examines leaves the set by getting `expiry_handled_at`.
export const DUE_EXPIRED_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE revoked_at IS NULL AND expiry_handled_at IS NULL
    AND (expires_at IS NULL OR expires_at <= ?)
  ORDER BY expires_at ASC, id ASC
  LIMIT ?`;
export const NEXT_UNHANDLED_EXPIRY_SQL = `SELECT MIN(COALESCE(expires_at, 0)) AS due
  FROM chat_session_access_grants
  WHERE revoked_at IS NULL AND expiry_handled_at IS NULL`;

export function mapGrant(row: unknown): SessionAccessGrantRecord {
  const r = parseRow(GrantRowSchema, row, 'session_access_grant');
  return {
    id: r.id,
    sessionId: r.session_id,
    granteeUserId: r.grantee_user_id,
    grantedByUserId: r.granted_by_user_id,
    parentGrantId: r.parent_grant_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    durationMinutes: r.duration_minutes,
  };
}

function readSessionOwner(
  sql: SqlStorage,
  sessionId: string
): { ownerUserId: string | null; status: string } | null {
  const row = sql
    .exec('SELECT created_by_user_id, status FROM chat_sessions WHERE id = ? LIMIT 1', sessionId)
    .toArray()[0];
  if (!row) return null;
  return {
    ownerUserId:
      typeof row.created_by_user_id === 'string' && row.created_by_user_id.length > 0
        ? row.created_by_user_id
        : null,
    status: typeof row.status === 'string' ? row.status : 'unknown',
  };
}

function readGrant(
  sql: SqlStorage,
  query: string,
  sessionId: string,
  granteeUserId: string,
  ...binds: number[]
): SessionAccessGrantRecord | null {
  const row = sql.exec(query, sessionId, granteeUserId, ...binds).toArray()[0];
  if (!row) return null;
  try {
    return mapGrant(row);
  } catch (err) {
    // A malformed row can never authorize anyone (fail closed), but it must not 500 the
    // owner's own session either (.claude/rules/50).
    log.error('session_access.grant_row_invalid', {
      sessionId,
      granteeUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** `granteeUserId`'s grant on `sessionId` if it is unrevoked and unexpired at `now`. */
export function readActiveGrant(
  sql: SqlStorage,
  sessionId: string,
  granteeUserId: string,
  now: number
): SessionAccessGrantRecord | null {
  return readGrant(sql, READ_ACTIVE_GRANT_SQL, sessionId, granteeUserId, now);
}

/** The person's unrevoked grant row, expired or not (it holds their unique-index slot). */
export function readUnrevokedGrant(
  sql: SqlStorage,
  sessionId: string,
  granteeUserId: string
): SessionAccessGrantRecord | null {
  return readGrant(sql, READ_UNREVOKED_GRANT_SQL, sessionId, granteeUserId);
}

export function isExpired(grant: SessionAccessGrantRecord, now: number): boolean {
  return grant.expiresAt === null || grant.expiresAt <= now;
}

/**
 * Resolve what `userId` may do in `sessionId` at server time `now`. Owner wins over any stale
 * grant row; an expired grant resolves exactly like no grant.
 */
export function resolveSessionAccess(
  sql: SqlStorage,
  sessionId: string,
  userId: string,
  now: number = Date.now()
): SessionAccessResolution {
  const session = readSessionOwner(sql, sessionId);
  if (!session) {
    return { found: false, ownerUserId: null, sessionStatus: null, role: 'none', grant: null };
  }
  if (session.ownerUserId && session.ownerUserId === userId) {
    return {
      found: true,
      ownerUserId: session.ownerUserId,
      sessionStatus: session.status,
      role: 'owner',
      grant: null,
    };
  }
  // A session without a recorded owner (legacy/system rows) can never be shared: there is no
  // person whose consent a grant would represent.
  const grant = session.ownerUserId ? readActiveGrant(sql, sessionId, userId, now) : null;
  return {
    found: true,
    ownerUserId: session.ownerUserId,
    sessionStatus: session.status,
    role: grant ? 'grantee' : 'none',
    grant,
  };
}

export function listActiveSessionAccessGrants(
  sql: SqlStorage,
  sessionId: string,
  now: number = Date.now()
): SessionAccessGrantRecord[] {
  const rows = sql.exec(LIST_ACTIVE_GRANTS_SQL, sessionId, now).toArray();
  const grants: SessionAccessGrantRecord[] = [];
  for (const row of rows) {
    try {
      grants.push(mapGrant(row));
    } catch (err) {
      log.error('session_access.grant_row_skipped', {
        sessionId,
        rowId: typeof row.id === 'string' ? row.id : null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return grants;
}

/**
 * Fail every queued or not-yet-submitted prompt delivery that `senderUserIds` originated for
 * `sessionId`. A delivery already submitting (it may have reached the agent) is left alone:
 * a sent prompt cannot be taken back. The transcript row is labelled so it no longer reads as
 * delivered.
 */
export function cancelUndeliveredSenderPrompts(
  sql: SqlStorage,
  sessionId: string,
  senderUserIds: string[],
  reason: SenderAccessEndedReason
): string[] {
  if (senderUserIds.length === 0) return [];
  // Both lists are bound as JSON arrays (`json_each`), so the statement text is fixed and its
  // bind count does not grow with the number of revoked people.
  const rows = sql
    .exec(
      `UPDATE session_inbox
          SET delivery_state = 'failed',
              terminal_reason = ?,
              last_error = ?,
              next_attempt_at = NULL,
              attempt_started_at = NULL
        WHERE target_session_id = ?
          AND sender_type = 'human'
          AND sender_id IN (SELECT value FROM json_each(?))
          AND source_kind IN (SELECT value FROM json_each(?))
          AND (
            delivery_state IN ('queued', 'retry_wait')
            OR (delivery_state = 'delivering' AND prompt_delivery_phase = 'preparing')
          )
        RETURNING id, prompt_message_id`,
      reason,
      SENDER_ACCESS_ENDED_ERRORS[reason],
      sessionId,
      JSON.stringify(senderUserIds),
      JSON.stringify(SESSION_WRITER_PROMPT_SOURCES)
    )
    .toArray();
  const deliveryIds: string[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    deliveryIds.push(row.id);
    if (typeof row.prompt_message_id === 'string') {
      labelUndeliveredPrompt(sql, sessionId, row.prompt_message_id, reason);
    }
  }
  if (deliveryIds.length > 0) {
    sql.exec(
      `DELETE FROM prompt_delivery_target_backoff
        WHERE target_session_id = ?
          AND NOT EXISTS (SELECT 1 FROM session_inbox INDEXED BY idx_inbox_active_target_head
            WHERE target_session_id = ?
              AND delivery_state IN ('queued', 'retry_wait', 'delivering'))`,
      sessionId,
      sessionId
    );
  }
  return deliveryIds;
}

/**
 * Mark a transcript row as never delivered, so it no longer reads as something the agent got.
 * Used when a sender's access ends while their prompt is queued, and by the delivery fence.
 */
export function labelUndeliveredPrompt(
  sql: SqlStorage,
  sessionId: string,
  promptMessageId: string,
  reason: SenderAccessEndedReason
): void {
  sql.exec(
    `UPDATE chat_messages
        SET tool_metadata = json_set(COALESCE(tool_metadata, '{}'), '$.deliveryCancelled', ?)
      WHERE id = ? AND session_id = ? AND json_valid(COALESCE(tool_metadata, '{}'))`,
    reason,
    promptMessageId,
    sessionId
  );
}
