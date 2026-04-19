/**
 * OAuth callback trial-claim hook.
 *
 * After BetterAuth handles a successful `GET /api/auth/callback/github`, this
 * hook inspects the request for a trial fingerprint cookie and — if the
 * fingerprint binds to an active unclaimed trial — issues a signed
 * `sam_trial_claim` cookie and rewrites the OAuth redirect to the trial's
 * claim landing page (`https://app.${BASE_DOMAIN}/try/:trialId?claim=1`).
 *
 * Nothing in BetterAuth's flow is mutated: we only mutate the Response it
 * returns. If the user is not mid-trial, the response is returned untouched.
 */

import { TRIAL_COOKIE_FINGERPRINT_NAME } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  buildClaimCookie,
  DEFAULT_TRIAL_CLAIM_TTL_MS,
  signClaimToken,
  type TrialClaimPayload,
  verifyFingerprint,
} from './cookies';
import { readTrialByFingerprint } from './trial-store';

const CALLBACK_PATH_SUFFIX = '/callback/github';

/**
 * Wrap a BetterAuth response. Returns the original Response if no trial
 * fingerprint is detected, or a cloned+modified response that sets the
 * claim cookie and redirects to the trial claim landing page.
 */
export async function maybeAttachTrialClaimCookie(
  env: Env,
  request: Request,
  response: Response
): Promise<Response> {
  // Only run on GitHub OAuth callback
  const url = new URL(request.url);
  if (!url.pathname.endsWith(CALLBACK_PATH_SUFFIX)) return response;

  // BetterAuth signals a successful OAuth callback by issuing a 302 redirect
  // (to the origin URL). We piggyback on that — on 4xx/5xx we leave the
  // response alone.
  if (response.status < 300 || response.status >= 400) return response;

  const secret = env.TRIAL_CLAIM_TOKEN_SECRET;
  if (!secret) return response;

  const cookieHeader = request.headers.get('cookie') ?? '';
  const fingerprintCookie = parseCookie(cookieHeader, TRIAL_COOKIE_FINGERPRINT_NAME);
  if (!fingerprintCookie) return response;

  const uuid = await verifyFingerprint(fingerprintCookie, secret);
  if (!uuid) return response;

  const record = await readTrialByFingerprint(env, uuid);
  if (!record || record.claimed) return response;
  if (record.expiresAt <= Date.now()) return response;

  // Build the claim cookie
  const now = Date.now();
  const payload: TrialClaimPayload = {
    trialId: record.trialId,
    projectId: record.projectId,
    issuedAt: now,
    expiresAt: now + DEFAULT_TRIAL_CLAIM_TTL_MS,
  };
  const token = await signClaimToken(payload, secret);
  const cookie = buildClaimCookie(token);

  // Rewrite the redirect Location to the app's claim landing page.
  const baseDomain = env.BASE_DOMAIN;
  const claimUrl = `https://app.${baseDomain}/try/${record.trialId}?claim=1`;

  // Copy existing headers, set/append Set-Cookie and overwrite Location.
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  headers.set('Location', claimUrl);

  log.info('trial_oauth_hook.claim_cookie_attached', {
    trialId: record.trialId,
    projectId: record.projectId,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
