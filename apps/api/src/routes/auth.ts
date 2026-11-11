import type { Context } from 'hono';
import { Hono } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { expectJsonRecord, maybeJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { isAgentSignInSession, isPastHardExpiry } from '../services/agent-sign-in/session-cap';
import {
  assertCodeAttemptBudget,
  EMAIL_CODE_SIGN_IN_PATH,
  emailCodeRedemptionAllowed,
  isClosedEmailOtpPath,
  rateLimitSignInCodes,
  SEND_CODE_PATH,
  withinEmailBudget,
} from '../services/email-sign-in';
import { readAuthSession } from '../services/read-auth-session';
import { assertUserNotSuspended } from '../services/signup-approval';

const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/auth/me - Get current authenticated user
 * Returns user profile with GitHub info
 */
authRoutes.get('/me', async (c) => {
  const auth = await createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });

  if (!session?.user || isPastHardExpiry(session.session)) {
    throw errors.unauthorized('Not authenticated');
  }

  assertUserNotSuspended(session.user);
  const user = expectJsonRecord(session.user, 'auth.me.session.user');
  return c.json({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    avatarUrl: session.user.image,
    role: typeof user.role === 'string' ? user.role : 'user',
    status: typeof user.status === 'string' ? user.status : 'active',
    createdAt: session.user.createdAt,
  });
});

/**
 * BetterAuth handler - handles all auth routes:
 * - GET /api/auth/sign-in/social - Start GitHub OAuth
 * - GET /api/auth/callback/github - GitHub OAuth callback
 * - POST /api/auth/sign-out - Sign out
 * - GET /api/auth/session - Get current session
 */
authRoutes.get('/get-session', (c) => readAuthSession(c.env, c.req.raw));

// Email sign-in codes cost an email each, and each redemption is a guess: limit both per IP
// before BetterAuth sees them, and guesses also per address.
authRoutes.post(SEND_CODE_PATH, rateLimitSignInCodes('email-sign-in-ip'));
authRoutes.post(SEND_CODE_PATH, async (c, next) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  const email = maybeJsonRecord(body)?.email;
  // Past the address's hourly budget, answer as usual without letting BetterAuth mint a new
  // code: that would invalidate the last one the owner was actually emailed.
  if (typeof email === 'string' && !(await withinEmailBudget(c.env, email))) {
    log.warn('email_sign_in.code_not_sent', { reason: 'email_rate_limited' });
    return c.json({ success: true });
  }
  return next();
});
authRoutes.post(EMAIL_CODE_SIGN_IN_PATH, rateLimitSignInCodes('email-sign-in-redeem-ip'));
authRoutes.post(EMAIL_CODE_SIGN_IN_PATH, async (c, next) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  const email = maybeJsonRecord(body)?.email;
  // Guesses for one address are capped across all IPs, for every address alike.
  if (typeof email === 'string') await assertCodeAttemptBudget(c.env, email);
  // Same answer as a wrong code, so this reveals nothing the code check would not.
  if (typeof email !== 'string' || !(await emailCodeRedemptionAllowed(c.env, email))) {
    return c.json({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  }
  await next();
  // BetterAuth answers 403 TOO_MANY_ATTEMPTS once a code has taken its guesses, which only an
  // eligible address can reach. Answer exactly like a wrong code so the lockout cannot be used
  // to tell which addresses have accounts; the lockout itself still holds.
  if (c.res.status === 403) {
    c.res = c.json({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  }
});

authRoutes.on(['GET', 'POST'], '/*', async (c) => {
  // SAM has no passwords: the plugin's reset, verification and email-change routes stay closed.
  if (isClosedEmailOtpPath(new URL(c.req.url).pathname)) throw errors.notFound('Route');
  try {
    const auth = await createAuth(c.env, { waitUntil: executionWaitUntil(c) });
    if (await isAgentSessionChangingAccount(auth, c.req.raw)) {
      log.warn('agent_sign_in.auth_action_refused', {
        path: new URL(c.req.url).pathname,
        action: 'rejected',
      });
      return c.json(
        { error: 'FORBIDDEN', message: 'Agent sign-in sessions can only sign out here' },
        403
      );
    }
    const response = await auth.handler(withoutSessionCookieCache(c.req.raw));

    // Log auth error metadata only. BetterAuth response bodies may include
    // upstream OAuth data or request-specific values that do not belong in
    // normal Worker logs.
    if (response.status >= 400) {
      log.error('auth.better_auth_error', {
        status: response.status,
        statusText: response.statusText || undefined,
      });
    }
    return response;
  } catch (err) {
    log.error('auth.better_auth_exception', serializeError(err));
    return c.json({ error: 'AUTH_ERROR', message: 'Internal auth error' }, 500);
  }
});

/**
 * BetterAuth endpoints an agent sign-in session may use: read its own session, sign out. The
 * reads are answered before this check (GET /get-session has its own route above).
 */
const AGENT_SESSION_AUTH_ENDPOINTS = new Set(['/api/auth/get-session', '/api/auth/sign-out']);

/**
 * Whether this BetterAuth request is made with an agent sign-in session and is not one of the
 * endpoints above. Linking a social account, for one, would give the agent's operator a lasting
 * way into the target account, and listing sessions would expose the account's other sessions.
 *
 * The session is resolved by BetterAuth itself, never by inspecting the Cookie header: BetterAuth's
 * cookie parser accepts forms a substring check would miss (whitespace before `=`, for one), so
 * any shortcut here would be a second, looser parser in front of the real one. A request without
 * a session cookie costs nothing extra (BetterAuth returns before touching the database); the app
 * polls GET /get-session, which has its own route above.
 */
async function isAgentSessionChangingAccount(
  auth: Awaited<ReturnType<typeof createAuth>>,
  request: Request
): Promise<boolean> {
  if (AGENT_SESSION_AUTH_ENDPOINTS.has(new URL(request.url).pathname)) return false;
  const current = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  return isAgentSignInSession(current?.session);
}

/** BetterAuth's signed session cache cookie (`session_data`, possibly chunked as `.0`, `.1`). */
const SESSION_CACHE_COOKIE = /(^|\.)session_data(\.\d+)?$/;

/**
 * The request without BetterAuth's session cache cookie, so the handler reads the session from
 * the database, as `isAgentSessionChangingAccount` does. Otherwise the gate and the handler could
 * disagree: a session deleted by sign-out or the documented revocation is absent for the gate
 * (so it is not refused as an agent session) while the handler still accepts its cached copy for
 * up to the cache's maxAge, long enough to link a social account. These endpoints are rare (the
 * app polls GET /get-session, which has its own route), so the extra read costs little.
 */
function withoutSessionCookieCache(request: Request): Request {
  const cookie = request.headers.get('cookie');
  if (!cookie) return request;
  const pairs = cookie.split(';');
  const kept = pairs.filter(
    (pair) => !SESSION_CACHE_COOKIE.test((pair.split('=', 1)[0] ?? '').trim())
  );
  if (kept.length === pairs.length) return request;
  const headers = new Headers(request.headers);
  if (kept.length) headers.set('cookie', kept.join(';'));
  else headers.delete('cookie');
  return new Request(request, { headers });
}

/** The request's waitUntil, when the runtime provides one (Workers do; unit-test apps do not). */
function executionWaitUntil(c: Context): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

export { authRoutes };
