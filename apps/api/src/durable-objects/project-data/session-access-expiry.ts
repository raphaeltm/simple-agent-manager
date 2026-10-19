/**
 * Shared session access: what happens when a grant's time is up, and the delivery-time fence.
 *
 * Access already ended when `expires_at` passed (every check reads server time). The sweep
 * here only makes queued work and open clients catch up: it cancels the expired grantees'
 * undelivered prompts and marks the expiry handled. The fence refuses any queued prompt whose
 * sender no longer controls the session, whichever way their access ended.
 */
import { createModuleLogger } from '../../lib/logger';
import {
  cancelUndeliveredSenderPrompts,
  DUE_EXPIRED_GRANTS_SQL,
  mapGrant,
  NEXT_UNHANDLED_EXPIRY_SQL,
  readUnrevokedGrant,
  resolveSessionAccess,
  SENDER_ACCESS_EXPIRED_REASON,
  SENDER_ACCESS_REVOKED_REASON,
  type SenderAccessEndedReason,
  SESSION_ACCESS_EXPIRY_SWEEP_LIMIT,
  SESSION_WRITER_PROMPT_SOURCES,
  type SessionAccessGrantRecord,
} from './session-access-store';

const log = createModuleLogger('project_data.session_access');

export interface ExpiredSessionAccess {
  sessionId: string;
  expiredGrants: SessionAccessGrantRecord[];
  cancelledDeliveryIds: string[];
}

/**
 * Cleanup for grants that have expired: cancel the grantees' undelivered prompts in that
 * session and record that the expiry was handled. Access already ended when `expires_at`
 * passed; this only makes queued work and open clients catch up.
 */
export function handleExpiredGrants(
  sql: SqlStorage,
  sessionId: string,
  grants: SessionAccessGrantRecord[],
  now: number
): string[] {
  const cancelled = cancelUndeliveredSenderPrompts(
    sql,
    sessionId,
    [...new Set(grants.map((grant) => grant.granteeUserId))],
    SENDER_ACCESS_EXPIRED_REASON
  );
  for (const grant of grants) {
    sql.exec(
      `UPDATE chat_session_access_grants SET expiry_handled_at = ?
        WHERE id = ? AND revoked_at IS NULL AND expiry_handled_at IS NULL`,
      now,
      grant.id
    );
  }
  return cancelled;
}

/** The alarm sweep: handle every grant that expired by `now`, at most `limit` per pass. */
export function processExpiredSessionAccessGrants(
  sql: SqlStorage,
  now: number = Date.now(),
  limit: number = SESSION_ACCESS_EXPIRY_SWEEP_LIMIT
): ExpiredSessionAccess[] {
  const bySession = new Map<string, SessionAccessGrantRecord[]>();
  for (const row of sql.exec(DUE_EXPIRED_GRANTS_SQL, now, limit).toArray()) {
    try {
      const grant = mapGrant(row);
      bySession.set(grant.sessionId, [...(bySession.get(grant.sessionId) ?? []), grant]);
    } catch (err) {
      // A row that cannot be parsed must still leave the candidate set (.claude/rules/47).
      const id = typeof row.id === 'string' ? row.id : null;
      log.error('session_access.expired_row_skipped', {
        rowId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      if (id) {
        sql.exec(
          'UPDATE chat_session_access_grants SET expiry_handled_at = ? WHERE id = ?',
          now,
          id
        );
      }
    }
  }
  const results: ExpiredSessionAccess[] = [];
  for (const [sessionId, grants] of bySession) {
    const cancelledDeliveryIds = handleExpiredGrants(sql, sessionId, grants, now);
    results.push({ sessionId, expiredGrants: grants, cancelledDeliveryIds });
  }
  return results;
}

/** When the expiry sweep next has work, from the same rows it selects. */
export function computeSessionAccessExpiryAlarmTime(sql: SqlStorage): number | null {
  const row = sql.exec(NEXT_UNHANDLED_EXPIRY_SQL).toArray()[0];
  return typeof row?.due === 'number' ? row.due : null;
}

export interface SenderAccessDenial {
  error: string;
  /** Set when the sender once had access here, so the transcript row can say why. */
  deliveryCancelled: SenderAccessEndedReason | null;
}

/**
 * Delivery-time fence for prompts a human session writer originated. Returns why the sender is
 * neither the session owner nor an active grantee at server time `now`, so the runner fails the
 * delivery before any side effect. Other prompt sources are unaffected.
 */
export function senderLacksSessionAccess(
  sql: SqlStorage,
  delivery: {
    targetSessionId: string;
    senderType: string;
    senderId: string | null;
    sourceKind: string;
  },
  now: number = Date.now()
): SenderAccessDenial | null {
  if (!(SESSION_WRITER_PROMPT_SOURCES as readonly string[]).includes(delivery.sourceKind)) {
    return null;
  }
  if (delivery.senderType !== 'human') return null;
  if (!delivery.senderId) {
    return { error: 'Prompt sender identity is missing', deliveryCancelled: null };
  }
  const access = resolveSessionAccess(sql, delivery.targetSessionId, delivery.senderId, now);
  if (!access.found) return { error: 'Target session no longer exists', deliveryCancelled: null };
  if (access.role !== 'none') return null;
  if (readUnrevokedGrant(sql, delivery.targetSessionId, delivery.senderId)) {
    return {
      error: "The sender's access to this session expired",
      deliveryCancelled: SENDER_ACCESS_EXPIRED_REASON,
    };
  }
  const everGranted =
    sql
      .exec(
        `SELECT 1 FROM chat_session_access_grants
          WHERE session_id = ? AND grantee_user_id = ? LIMIT 1`,
        delivery.targetSessionId,
        delivery.senderId
      )
      .toArray().length > 0;
  return {
    error: 'The sender no longer has access to this session',
    // Someone who never had access here gets no "access was removed" label.
    deliveryCancelled: everGranted ? SENDER_ACCESS_REVOKED_REASON : null,
  };
}
