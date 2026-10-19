/**
 * Shared session access grants: creating, renewing and ending them (DO migrations 064 and 065,
 * idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 *
 * The session owner is `chat_sessions.created_by_user_id`. A grant gives one other project
 * member owner-equivalent control of that one session for a chosen 5, 10, 30 or 60 minutes.
 * Everything here is authoritative ProjectData state: the API checks project membership and
 * the acknowledgment before calling in, and these functions re-check the session-level
 * authority against the same transaction that mutates it.
 *
 * Expected outcomes (not found, forbidden, limit) are returned as discriminated results rather
 * than thrown, because an error crossing the Durable Object RPC boundary keeps only its message.
 */
import {
  isSessionAccessDurationMinutes,
  isShareableChatSessionStatus,
  type SessionAccessRevokeReason,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { handleExpiredGrants } from './session-access-expiry';
import {
  cancelUndeliveredSenderPrompts,
  COUNT_ACTIVE_GRANTS_SQL,
  isExpired,
  LIST_UNREVOKED_CHILD_GRANTS_SQL,
  LIST_UNREVOKED_GRANTS_HELD_BY_SQL,
  mapGrant,
  MINUTE_MS,
  readActiveGrant,
  readUnrevokedGrant,
  resolveSessionAccess,
  SENDER_ACCESS_REVOKED_REASON,
  type SessionAccessGrantRecord,
} from './session-access-store';
import { generateId } from './types';

const log = createModuleLogger('project_data.session_access');

export {
  computeSessionAccessExpiryAlarmTime,
  type ExpiredSessionAccess,
  processExpiredSessionAccessGrants,
  type SenderAccessDenial,
  senderLacksSessionAccess,
} from './session-access-expiry';
export {
  labelUndeliveredPrompt,
  listActiveSessionAccessGrants,
  resolveSessionAccess,
  SENDER_ACCESS_EXPIRED_REASON,
  SENDER_ACCESS_REVOKED_REASON,
  type SenderAccessEndedReason,
  SESSION_ACCESS_EXPIRY_SWEEP_LIMIT,
  SESSION_WRITER_PROMPT_SOURCES,
  type SessionAccessGrantRecord,
  type SessionAccessResolution,
  type SessionAccessRole,
} from './session-access-store';

export interface CreateSessionAccessGrantInput {
  sessionId: string;
  granteeUserId: string;
  /** The verified actor creating the grant: the owner or an active grantee. */
  grantedByUserId: string;
  /** Required: 5, 10, 30 or 60 (`SESSION_ACCESS_DURATION_MINUTES`). */
  durationMinutes: number;
  maxActiveGrants: number;
  now?: number;
}

export type CreateSessionAccessGrantResult =
  // `created`: the person had no active access. `renewed`: the owner gave someone who still had
  // access a new end time. `existing`: a grantee re-shared with someone who already has access,
  // which changes nothing (only the owner renews).
  | { status: 'created' | 'renewed' | 'existing'; grant: SessionAccessGrantRecord }
  | { status: 'session_not_found' }
  | { status: 'forbidden'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'limit_exceeded'; limit: number };

export function createSessionAccessGrant(
  sql: SqlStorage,
  input: CreateSessionAccessGrantInput
): CreateSessionAccessGrantResult {
  const now = input.now ?? Date.now();
  const actor = resolveSessionAccess(sql, input.sessionId, input.grantedByUserId, now);
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
  // Also what stops anyone extending their own access: only someone else can share with you.
  if (input.granteeUserId === input.grantedByUserId) {
    return { status: 'invalid', reason: 'You cannot share a session with yourself' };
  }
  if (!isSessionAccessDurationMinutes(input.durationMinutes)) {
    return {
      status: 'invalid',
      reason: 'Choose how long access lasts: 5, 10, 30 or 60 minutes',
    };
  }

  // A grantee can pass control on, but never for longer than their own access lasts.
  const requestedExpiry = now + input.durationMinutes * MINUTE_MS;
  const expiresAt =
    actor.role === 'grantee' && actor.grant?.expiresAt != null
      ? Math.min(requestedExpiry, actor.grant.expiresAt)
      : requestedExpiry;

  const current = readUnrevokedGrant(sql, input.sessionId, input.granteeUserId);
  if (current && !isExpired(current, now)) {
    // Renewal is the owner's explicit decision; nothing renews on its own.
    if (actor.role !== 'owner') return { status: 'existing', grant: current };
    sql.exec(
      `UPDATE chat_session_access_grants
          SET expires_at = ?, duration_minutes = ?, granted_by_user_id = ?,
              parent_grant_id = NULL, expiry_handled_at = NULL
        WHERE id = ? AND revoked_at IS NULL`,
      expiresAt,
      input.durationMinutes,
      input.grantedByUserId,
      current.id
    );
    return { status: 'renewed', grant: requireActiveGrant(sql, input, now) };
  }

  const countRow = sql.exec(COUNT_ACTIVE_GRANTS_SQL, input.sessionId, now).toArray()[0];
  const activeCount = typeof countRow?.count === 'number' ? countRow.count : 0;
  if (activeCount >= input.maxActiveGrants) {
    return { status: 'limit_exceeded', limit: input.maxActiveGrants };
  }

  const parentGrantId = actor.role === 'grantee' ? (actor.grant?.id ?? null) : null;
  if (current) {
    // An expired grant still holds this person's row. Finish its cleanup first, so prompts
    // queued during the old grant are cancelled rather than revived, then start the new grant.
    handleExpiredGrants(sql, input.sessionId, [current], now);
    sql.exec(
      `UPDATE chat_session_access_grants
          SET granted_by_user_id = ?, parent_grant_id = ?, created_at = ?, expires_at = ?,
              duration_minutes = ?, expiry_handled_at = NULL
        WHERE id = ? AND revoked_at IS NULL`,
      input.grantedByUserId,
      parentGrantId,
      now,
      expiresAt,
      input.durationMinutes,
      current.id
    );
  } else {
    sql.exec(
      `INSERT INTO chat_session_access_grants
         (id, session_id, grantee_user_id, granted_by_user_id, parent_grant_id, created_at,
          expires_at, duration_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      generateId(),
      input.sessionId,
      input.granteeUserId,
      input.grantedByUserId,
      parentGrantId,
      now,
      expiresAt,
      input.durationMinutes
    );
  }
  return { status: 'created', grant: requireActiveGrant(sql, input, now) };
}

function requireActiveGrant(
  sql: SqlStorage,
  input: Pick<CreateSessionAccessGrantInput, 'sessionId' | 'granteeUserId'>,
  now: number
): SessionAccessGrantRecord {
  const grant = readActiveGrant(sql, input.sessionId, input.granteeUserId, now);
  if (!grant) throw new Error('Session access grant was not readable after it was written');
  return grant;
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
      const children = sql.exec(LIST_UNREVOKED_CHILD_GRANTS_SQL, grant.id).toArray();
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
  const cancelledDeliveryIds = cancelUndeliveredSenderPrompts(
    sql,
    sessionId,
    [...new Set(grants.map((grant) => grant.granteeUserId))],
    SENDER_ACCESS_REVOKED_REASON
  );
  return { revokedGrants: grants, cancelledDeliveryIds };
}

export function revokeSessionAccessGrant(
  sql: SqlStorage,
  input: RevokeSessionAccessGrantInput
): RevokeSessionAccessGrantResult {
  const actor = resolveSessionAccess(
    sql,
    input.sessionId,
    input.actorUserId,
    input.now ?? Date.now()
  );
  if (!actor.found) return { status: 'session_not_found' };
  const leaving = input.actorUserId === input.granteeUserId;
  if (actor.role === 'none' && !leaving) {
    return {
      status: 'forbidden',
      reason: 'Only people who control this session can remove access',
    };
  }
  const now = input.now ?? Date.now();
  // Revoking checks the actor against server time too, so an expired grantee cannot remove
  // anyone but themselves.
  const target = readActiveGrant(sql, input.sessionId, input.granteeUserId, now);
  if (!target) return { status: 'not_granted' };
  const revoked = revokeGrantTree(
    sql,
    input.sessionId,
    [target],
    leaving ? 'left' : 'revoked',
    input.actorUserId,
    now
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
  const held = sql.exec(LIST_UNREVOKED_GRANTS_HELD_BY_SQL, userId).toArray();
  const owned = sql
    .exec(
      `SELECT g.id, g.session_id, g.grantee_user_id, g.granted_by_user_id, g.parent_grant_id,
              g.created_at, g.expires_at, g.duration_minutes
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
