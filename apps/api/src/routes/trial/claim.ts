/**
 * POST /api/trial/claim — claim an anonymous trial project after GitHub OAuth.
 *
 * Flow:
 *  1. Require auth (session from BetterAuth cookie).
 *  2. Read + verify the HMAC-signed `sam_trial_claim` cookie.
 *  3. Verify the trial record exists, is unclaimed, and is not expired.
 *  4. Atomically re-parent `projects.user_id` from the sentinel anonymous user
 *     to the authenticated user — guarded by a `WHERE user_id = sentinel`
 *     precondition so a double-claim attempt cannot hijack a project that has
 *     already been taken.
 *  5. Clear the claim cookie (Max-Age=0).
 *  6. Mark the KV record as `claimed: true` (best-effort).
 */

import {
  TRIAL_ANONYMOUS_USER_ID,
  TRIAL_COOKIE_CLAIM_NAME,
  type TrialClaimResponse,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { clearClaimCookie, verifyClaimToken } from '../../services/trial/cookies';
import { markTrialClaimed, readTrial } from '../../services/trial/trial-store';

const claimRoutes = new Hono<{ Bindings: Env }>();

claimRoutes.post('/claim', requireAuth(), async (c) => {
  const userId = getUserId(c);

  const secret = c.env.TRIAL_CLAIM_TOKEN_SECRET;
  if (!secret) {
    log.error('trial_claim.secret_unset');
    throw errors.internal('Trial auth secret is not configured');
  }

  const cookieHeader = c.req.header('cookie') ?? '';
  const claimCookie = parseCookie(cookieHeader, TRIAL_COOKIE_CLAIM_NAME);
  if (!claimCookie) {
    throw errors.badRequest('Missing trial claim cookie');
  }

  const verified = await verifyClaimToken(claimCookie, secret);
  if (!verified.ok) {
    log.warn('trial_claim.cookie_rejected', { reason: verified.reason, userId });
    throw errors.badRequest(`Claim cookie rejected: ${verified.reason}`);
  }

  const { trialId, projectId } = verified.payload;

  // Trial record must still exist
  const record = await readTrial(c.env, trialId);
  if (!record) {
    throw errors.notFound('Trial');
  }
  if (record.projectId !== projectId) {
    // Cookie-embedded projectId disagrees with KV — reject to avoid confused-deputy.
    log.warn('trial_claim.projectid_mismatch', {
      trialId,
      cookieProjectId: projectId,
      recordProjectId: record.projectId,
    });
    throw errors.badRequest('Claim cookie does not match trial record');
  }
  if (record.claimed) {
    throw errors.conflict('Trial has already been claimed');
  }

  const db = drizzle(c.env.DATABASE, { schema });

  // Atomic re-parent — the AND clause is the precondition that protects against
  // double-claim / race conditions. If anyone else already re-parented this
  // project, `update()` returns 0 rows and we surface a 409.
  const anonymousUserId = c.env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
  const updateResult = await db
    .update(schema.projects)
    .set({ userId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.userId, anonymousUserId)
      )
    )
    .run();

  // D1 meta.changes: canonical way to detect how many rows the update hit
  const meta = (updateResult as unknown as { meta?: { changes?: number } }).meta;
  const changes = meta?.changes ?? 0;
  if (changes === 0) {
    // Project either doesn't exist or was already claimed by a different user
    log.warn('trial_claim.reparent_no_rows', { trialId, projectId, userId });
    throw errors.conflict('Trial project is no longer available to claim');
  }

  // Mark trial as claimed in KV (best-effort — the D1 write is the source of truth)
  try {
    await markTrialClaimed(c.env, trialId);
  } catch (err) {
    log.warn('trial_claim.mark_claimed_failed', {
      trialId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const claimedAt = Date.now();
  log.info('trial_claim.success', { trialId, projectId, userId, claimedAt });

  // Clear the claim cookie. Domain attribute MUST match what was set when the
  // cookie was issued (`.BASE_DOMAIN`), otherwise the browser treats them as
  // different cookies and the original is never deleted — enabling replay.
  const cookieDomain = c.env.BASE_DOMAIN ? `.${c.env.BASE_DOMAIN}` : undefined;
  const response: TrialClaimResponse = { projectId, claimedAt };
  c.header('Set-Cookie', clearClaimCookie({ domain: cookieDomain }));
  return c.json(response, 200);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCookie(header: string, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

export { claimRoutes };
