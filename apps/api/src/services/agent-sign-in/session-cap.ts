/**
 * The hard lifetime of an agent sign-in session (`sessions.hard_expires_at`, migration 0234).
 *
 * BetterAuth refreshes a session whenever `expiresAt - expiresIn + updateAge <= now`, which is
 * always true for a session shorter than six days, so an agent session would be extended to the
 * normal seven days on its first use. The cap is stored on the session row itself, so:
 *
 * - `clampSessionRefresh` (auth.ts `session.update.before`) lowers the refresh's new expiry to
 *   the cap inside BetterAuth's own UPDATE: no extra query, no second write, nothing to fail
 *   between the extension and the clamp.
 * - `isPastHardExpiry` lets the auth middleware refuse a capped session past its cap even if a
 *   refresh ever escaped the clamp, at no I/O cost (the column comes back with the session).
 * - `isAgentSignInSession` marks the session so credential-minting routes can refuse it, since a
 *   one-hour session that can mint a personal access token is not a one-hour session.
 */

/** Session field name, as configured in `session.additionalFields` (auth.ts). */
export const HARD_EXPIRES_AT_FIELD = 'hardExpiresAt';

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The session's hard expiry in ms, or null for an ordinary session. */
export function sessionHardExpiry(session: unknown): number | null {
  if (!session || typeof session !== 'object') return null;
  return toEpochMs((session as Record<string, unknown>)[HARD_EXPIRES_AT_FIELD]);
}

export function isAgentSignInSession(session: unknown): boolean {
  return sessionHardExpiry(session) !== null;
}

export function isPastHardExpiry(session: unknown, nowMs = Date.now()): boolean {
  const cap = sessionHardExpiry(session);
  return cap !== null && nowMs >= cap;
}

/**
 * BetterAuth `session.update.before`: if this update moves `expiresAt` and the session being
 * updated is capped, keep the new expiry at or below the cap. BetterAuth's refresh (the only
 * path that writes `expiresAt` after creation) sets `ctx.context.session` to the session it is
 * refreshing before it updates.
 */
export function clampSessionRefresh(
  data: Record<string, unknown>,
  ctx: unknown
): { data: Record<string, unknown> } | undefined {
  const next = toEpochMs(data.expiresAt);
  if (next === null) return undefined;
  const current = (ctx as { context?: { session?: { session?: unknown } | null } } | null)?.context
    ?.session?.session;
  const cap = sessionHardExpiry(current);
  if (cap === null || next <= cap) return undefined;
  return { data: { ...data, expiresAt: new Date(cap) } };
}
