import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import type { TerminalTokenPayload } from './jwt';
import { assertUserAllowedBySignupApproval, isSignupApprovalRequired } from './signup-approval';

function sessionExpiryMs(value: Date | number | string): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  return new Date(value).getTime();
}

/**
 * Bind browser terminal-token liveness to the BetterAuth session that minted it.
 *
 * Terminal JWTs still carry their normal expiry for VM-agent compatibility, but
 * browser-origin workspace proxy access is privileged enough that the Worker must
 * also prove the minting session is still live. Logout deletes/invalidates the
 * BetterAuth session row, so a captured token fails closed on the next upgrade.
 */
export async function assertTerminalTokenSessionLive(
  env: Env,
  payload: TerminalTokenPayload
): Promise<void> {
  if (!payload.sessionToken) {
    log.warn('terminal_token.session_missing', {
      workspaceId: payload.workspace,
      userId: payload.subject,
      action: 'rejected',
    });
    throw new Error('Terminal token is not bound to an auth session');
  }

  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      sessionId: schema.sessions.id,
      userId: schema.sessions.userId,
      expiresAt: schema.sessions.expiresAt,
      userRole: schema.users.role,
      userStatus: schema.users.status,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.sessions.token, payload.sessionToken),
        eq(schema.sessions.userId, payload.subject)
      )
    )
    .get();

  if (!row) {
    log.warn('terminal_token.session_not_found', {
      workspaceId: payload.workspace,
      userId: payload.subject,
      action: 'rejected',
    });
    throw new Error('Terminal token auth session is not live');
  }

  const expiresAt = sessionExpiryMs(row.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    log.warn('terminal_token.session_expired', {
      workspaceId: payload.workspace,
      userId: payload.subject,
      expiresAt,
      action: 'rejected',
    });
    throw new Error('Terminal token auth session expired');
  }

  assertUserAllowedBySignupApproval(await isSignupApprovalRequired(env), {
    role: row.userRole,
    status: row.userStatus,
  });
}
