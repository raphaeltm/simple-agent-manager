/**
 * Shared session access grants (DO migration 064, idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 *
 * The session owner is `chat_sessions.created_by_user_id`. A grant gives one other project
 * member owner-equivalent control of that one session until it is revoked. Everything here is
 * authoritative ProjectData state: the API checks project membership, repository access and
 * the acknowledgment before calling in, and these functions re-check the session-level
 * authority against the same transaction that mutates it.
 *
 * Expected outcomes (not found, forbidden, limit) are returned as discriminated results rather
 * than thrown, because an error crossing the Durable Object RPC boundary keeps only its message.
 */
import {
  isShareableChatSessionStatus,
  type SessionAccessRevokeReason,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { createModuleLogger } from '../../lib/logger';
import { parseRow } from './row-schemas';
import { generateId } from './types';

const log = createModuleLogger('project_data.session_access');

/** Prompt sources a human session writer can originate; only these are sender-fenced. */
export const SESSION_WRITER_PROMPT_SOURCES = ['user_followup', 'comment_directive'] as const;

/** Terminal reason recorded on a queued delivery cancelled because its sender lost access. */
export const SENDER_ACCESS_REVOKED_REASON = 'sender_access_revoked';

const GrantRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  grantee_user_id: v.string(),
  granted_by_user_id: v.string(),
  parent_grant_id: v.nullable(v.string()),
  created_at: v.number(),
});

export interface SessionAccessGrantRecord {
  id: string;
  sessionId: string;
  granteeUserId: string;
  grantedByUserId: string;
  parentGrantId: string | null;
  createdAt: number;
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

const GRANT_COLUMNS =
  'id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at';

// Whole statements built once at module load from the static column list, so no caller value
// ever reaches SQL text (the same pattern as CLAIM_DUE_PROMPT_DELIVERIES_SQL).
const READ_ACTIVE_GRANT_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE session_id = ? AND grantee_user_id = ? AND revoked_at IS NULL
  LIMIT 1`;
const LIST_ACTIVE_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE session_id = ? AND revoked_at IS NULL
  ORDER BY created_at ASC, id ASC`;
const LIST_ACTIVE_CHILD_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE parent_grant_id = ? AND revoked_at IS NULL`;
const LIST_ACTIVE_GRANTS_HELD_BY_SQL = `SELECT ${GRANT_COLUMNS} FROM chat_session_access_grants
  WHERE grantee_user_id = ? AND revoked_at IS NULL`;

function mapGrant(row: unknown): SessionAccessGrantRecord {
  const r = parseRow(GrantRowSchema, row, 'session_access_grant');
  return {
    id: r.id,
    sessionId: r.session_id,
    granteeUserId: r.grantee_user_id,
    grantedByUserId: r.granted_by_user_id,
    parentGrantId: r.parent_grant_id,
    createdAt: r.created_at,
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

function readActiveGrant(
  sql: SqlStorage,
  sessionId: string,
  granteeUserId: string
): SessionAccessGrantRecord | null {
  const row = sql.exec(READ_ACTIVE_GRANT_SQL, sessionId, granteeUserId).toArray()[0];
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

/** Resolve what `userId` may do in `sessionId`. Owner wins over any stale grant row. */
export function resolveSessionAccess(
  sql: SqlStorage,
  sessionId: string,
  userId: string
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
  const grant = session.ownerUserId ? readActiveGrant(sql, sessionId, userId) : null;
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
  sessionId: string
): SessionAccessGrantRecord[] {
  const rows = sql.exec(LIST_ACTIVE_GRANTS_SQL, sessionId).toArray();
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

export interface CreateSessionAccessGrantInput {
  sessionId: string;
  granteeUserId: string;
  /** The verified actor creating the grant: the owner or an active grantee. */
  grantedByUserId: string;
  maxActiveGrants: number;
  now?: number;
}

export type CreateSessionAccessGrantResult =
  | { status: 'created' | 'existing'; grant: SessionAccessGrantRecord }
  | { status: 'session_not_found' }
  | { status: 'forbidden'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'limit_exceeded'; limit: number };

export function createSessionAccessGrant(
  sql: SqlStorage,
  input: CreateSessionAccessGrantInput
): CreateSessionAccessGrantResult {
  const actor = resolveSessionAccess(sql, input.sessionId, input.grantedByUserId);
  if (!actor.found) return { status: 'session_not_found' };
  if (actor.role === 'none') {
    return { status: 'forbidden', reason: 'Only people who control this session can share it' };
  }
  if (!actor.ownerUserId) {
    return { status: 'invalid', reason: 'This session has no owner to share on behalf of' };
  }
  if (!isShareableChatSessionStatus(actor.sessionStatus)) {
    return { status: 'invalid', reason: 'This chat has ended, so it can no longer be shared' };
  }
  if (input.granteeUserId === actor.ownerUserId) {
    return { status: 'invalid', reason: 'The session owner already controls this session' };
  }
  if (input.granteeUserId === input.grantedByUserId) {
    return { status: 'invalid', reason: 'You cannot share a session with yourself' };
  }

  const existing = readActiveGrant(sql, input.sessionId, input.granteeUserId);
  if (existing) return { status: 'existing', grant: existing };

  const countRow = sql
    .exec(
      `SELECT COUNT(*) AS count FROM chat_session_access_grants
        WHERE session_id = ? AND revoked_at IS NULL`,
      input.sessionId
    )
    .toArray()[0];
  const activeCount = typeof countRow?.count === 'number' ? countRow.count : 0;
  if (activeCount >= input.maxActiveGrants) {
    return { status: 'limit_exceeded', limit: input.maxActiveGrants };
  }

  const id = generateId();
  const now = input.now ?? Date.now();
  sql.exec(
    `INSERT INTO chat_session_access_grants
       (id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.sessionId,
    input.granteeUserId,
    input.grantedByUserId,
    actor.role === 'grantee' ? (actor.grant?.id ?? null) : null,
    now
  );
  const grant = readActiveGrant(sql, input.sessionId, input.granteeUserId);
  if (!grant) throw new Error('Session access grant was not readable after insert');
  return { status: 'created', grant };
}

export interface RevokeSessionAccessGrantInput {
  sessionId: string;
  granteeUserId: string;
  /** The verified actor revoking: a session writer, or the grantee leaving. */
  actorUserId: string;
  now?: number;
}

export interface RevokedSessionAccess {
  revokedGrants: SessionAccessGrantRecord[];
  cancelledDeliveryIds: string[];
}

export type RevokeSessionAccessGrantResult =
  | ({ status: 'revoked' } & RevokedSessionAccess)
  | { status: 'not_granted' }
  | { status: 'session_not_found' }
  | { status: 'forbidden'; reason: string };

/**
 * Collect `rootGrantIds` plus every active grant issued (transitively) by those grantees.
 * Bounded by the active-grant cap per session, so the walk terminates quickly.
 */
function collectGrantsWithDescendants(
  sql: SqlStorage,
  roots: SessionAccessGrantRecord[]
): SessionAccessGrantRecord[] {
  const collected = new Map<string, SessionAccessGrantRecord>();
  let frontier = roots;
  while (frontier.length > 0) {
    const next: SessionAccessGrantRecord[] = [];
    for (const grant of frontier) {
      if (collected.has(grant.id)) continue;
      collected.set(grant.id, grant);
      const children = sql.exec(LIST_ACTIVE_CHILD_GRANTS_SQL, grant.id).toArray();
      for (const child of children) {
        try {
          const mapped = mapGrant(child);
          if (!collected.has(mapped.id)) next.push(mapped);
        } catch (err) {
          log.error('session_access.descendant_row_skipped', {
            parentGrantId: grant.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    frontier = next;
  }
  return [...collected.values()];
}

/**
 * Fail every queued or not-yet-submitted prompt delivery that `senderUserIds` originated for
 * `sessionId`. A delivery already submitting (it may have reached the agent) is left alone:
 * a sent prompt cannot be taken back. The transcript row is labelled so it no longer reads as
 * delivered.
 */
function cancelUndeliveredSenderPrompts(
  sql: SqlStorage,
  sessionId: string,
  senderUserIds: string[]
): string[] {
  if (senderUserIds.length === 0) return [];
  // Both lists are bound as JSON arrays (`json_each`), so the statement text is fixed and its
  // bind count does not grow with the number of revoked people.
  const rows = sql
    .exec(
      `UPDATE session_inbox
          SET delivery_state = 'failed',
              terminal_reason = ?,
              last_error = 'The sender no longer has access to this session',
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
      SENDER_ACCESS_REVOKED_REASON,
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
      sql.exec(
        `UPDATE chat_messages
            SET tool_metadata = json_set(COALESCE(tool_metadata, '{}'), '$.deliveryCancelled', ?)
          WHERE id = ? AND session_id = ? AND json_valid(COALESCE(tool_metadata, '{}'))`,
        SENDER_ACCESS_REVOKED_REASON,
        row.prompt_message_id,
        sessionId
      );
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

function markRevoked(
  sql: SqlStorage,
  grants: SessionAccessGrantRecord[],
  rootGrantIds: ReadonlySet<string>,
  rootReason: SessionAccessRevokeReason,
  actorUserId: string | null,
  now: number
): void {
  for (const grant of grants) {
    sql.exec(
      `UPDATE chat_session_access_grants
          SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
      now,
      actorUserId,
      rootGrantIds.has(grant.id) ? rootReason : 'cascade',
      grant.id
    );
  }
}

function revokeGrantTree(
  sql: SqlStorage,
  sessionId: string,
  roots: SessionAccessGrantRecord[],
  reason: SessionAccessRevokeReason,
  actorUserId: string | null,
  now: number
): RevokedSessionAccess {
  const grants = collectGrantsWithDescendants(sql, roots);
  markRevoked(sql, grants, new Set(roots.map((grant) => grant.id)), reason, actorUserId, now);
  const cancelledDeliveryIds = cancelUndeliveredSenderPrompts(sql, sessionId, [
    ...new Set(grants.map((grant) => grant.granteeUserId)),
  ]);
  return { revokedGrants: grants, cancelledDeliveryIds };
}

export function revokeSessionAccessGrant(
  sql: SqlStorage,
  input: RevokeSessionAccessGrantInput
): RevokeSessionAccessGrantResult {
  const actor = resolveSessionAccess(sql, input.sessionId, input.actorUserId);
  if (!actor.found) return { status: 'session_not_found' };
  const leaving = input.actorUserId === input.granteeUserId;
  if (actor.role === 'none' && !leaving) {
    return {
      status: 'forbidden',
      reason: 'Only people who control this session can remove access',
    };
  }
  const target = readActiveGrant(sql, input.sessionId, input.granteeUserId);
  if (!target) return { status: 'not_granted' };
  const revoked = revokeGrantTree(
    sql,
    input.sessionId,
    [target],
    leaving ? 'left' : 'revoked',
    input.actorUserId,
    input.now ?? Date.now()
  );
  return { status: 'revoked', ...revoked };
}

export interface RevokedSessionAccessForUser {
  sessionId: string;
  revokedGrants: SessionAccessGrantRecord[];
  cancelledDeliveryIds: string[];
}

/**
 * Membership ended for `userId`: revoke every grant they hold (`member_removed`) and every
 * grant on sessions they own (`owner_removed`), cascading to downstream grants.
 */
export function revokeSessionAccessForDepartedMember(
  sql: SqlStorage,
  userId: string,
  now = Date.now()
): RevokedSessionAccessForUser[] {
  const held = sql.exec(LIST_ACTIVE_GRANTS_HELD_BY_SQL, userId).toArray();
  const owned = sql
    .exec(
      `SELECT g.id, g.session_id, g.grantee_user_id, g.granted_by_user_id, g.parent_grant_id,
              g.created_at
         FROM chat_session_access_grants g
         JOIN chat_sessions s ON s.id = g.session_id
        WHERE s.created_by_user_id = ? AND g.revoked_at IS NULL AND g.parent_grant_id IS NULL`,
      userId
    )
    .toArray();

  const bySession = new Map<
    string,
    { held: SessionAccessGrantRecord[]; owned: SessionAccessGrantRecord[] }
  >();
  const add = (rows: unknown[], key: 'held' | 'owned') => {
    for (const row of rows) {
      try {
        const grant = mapGrant(row);
        const entry = bySession.get(grant.sessionId) ?? { held: [], owned: [] };
        entry[key].push(grant);
        bySession.set(grant.sessionId, entry);
      } catch (err) {
        log.error('session_access.departed_member_row_skipped', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  add(held, 'held');
  add(owned, 'owned');

  const results: RevokedSessionAccessForUser[] = [];
  for (const [sessionId, entry] of bySession) {
    const revokedGrants: SessionAccessGrantRecord[] = [];
    const cancelledDeliveryIds: string[] = [];
    if (entry.owned.length > 0) {
      const revoked = revokeGrantTree(sql, sessionId, entry.owned, 'owner_removed', null, now);
      revokedGrants.push(...revoked.revokedGrants);
      cancelledDeliveryIds.push(...revoked.cancelledDeliveryIds);
    }
    // Grants already revoked by the owner_removed pass are skipped by markRevoked's predicate.
    const stillHeld = entry.held.filter(
      (grant) => !revokedGrants.some((revoked) => revoked.id === grant.id)
    );
    if (stillHeld.length > 0) {
      const revoked = revokeGrantTree(sql, sessionId, stillHeld, 'member_removed', null, now);
      revokedGrants.push(...revoked.revokedGrants);
      cancelledDeliveryIds.push(...revoked.cancelledDeliveryIds);
    }
    if (revokedGrants.length > 0) results.push({ sessionId, revokedGrants, cancelledDeliveryIds });
  }
  return results;
}

/**
 * Delivery-time fence for prompts a human session writer originated. Returns a reason when
 * the sender is neither the session owner nor an active grantee, so the runner fails the
 * delivery before any side effect. Other prompt sources are unaffected.
 */
export function senderLacksSessionAccess(
  sql: SqlStorage,
  delivery: {
    targetSessionId: string;
    senderType: string;
    senderId: string | null;
    sourceKind: string;
  }
): string | null {
  if (!(SESSION_WRITER_PROMPT_SOURCES as readonly string[]).includes(delivery.sourceKind)) {
    return null;
  }
  if (delivery.senderType !== 'human') return null;
  if (!delivery.senderId) return 'Prompt sender identity is missing';
  const access = resolveSessionAccess(sql, delivery.targetSessionId, delivery.senderId);
  if (!access.found) return 'Target session no longer exists';
  if (access.role === 'none') return 'The sender no longer has access to this session';
  return null;
}
