import type { Context } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { getBetterAuthSecret } from '../lib/secrets';
import { errors } from '../middleware/error';
import {
  HARD_EXPIRES_AT_FIELD,
  isAgentSignInSession,
  isPastHardExpiry,
} from './agent-sign-in/session-cap';
import { assertSessionUserApproved, assertUserNotSuspended } from './signup-approval';

const DEFAULT_SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;

export interface SessionFactoryUser {
  id: string;
  email: string;
  name: string | null;
  role?: string | null;
  status?: string | null;
}

export interface CreatedSessionCookie {
  cookieHeader: string;
  sessionCookie: string;
  sessionId: string;
  expiresAt: Date;
}

export interface SessionLifetimeOptions {
  /**
   * Fixed expiry for this session, applied to both the stored session and the cookie.
   * Omitted: BetterAuth's normal lifetime and API_TOKEN_SESSION_DURATION_SECONDS.
   * The lifetime is also stored as the session's hard expiry, which BetterAuth's refresh cannot
   * extend and which marks the session as an agent sign-in session
   * (`services/agent-sign-in/session-cap.ts`).
   */
  expiresAt?: Date;
}

export async function createSessionCookieForUser(
  env: Env,
  userId: string,
  options: SessionLifetimeOptions = {}
): Promise<CreatedSessionCookie> {
  const auth = await createAuth(env);
  const ctx = await auth.$context;
  const { expiresAt } = options;
  const session =
    expiresAt === undefined
      ? await ctx.internalAdapter.createSession(userId, false)
      : await createCappedSession(ctx, userId, expiresAt);

  if (!session) {
    throw errors.badRequest('Failed to create session');
  }

  const authSecret = getBetterAuthSecret(env);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session.token));
  const base64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const signedValue = encodeURIComponent(`${session.token}.${base64Sig}`);

  const baseDomain = env.BASE_DOMAIN;
  const isSecure = `https://api.${baseDomain}`.startsWith('https://');
  const cookieName = isSecure ? '__Secure-better-auth.session_token' : 'better-auth.session_token';
  const sessionDurationSeconds =
    expiresAt !== undefined
      ? Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))
      : parseInt(env.API_TOKEN_SESSION_DURATION_SECONDS || '', 10) ||
        DEFAULT_SESSION_DURATION_SECONDS;
  const sessionCookie = `${cookieName}=${signedValue}`;
  const cookieHeader = [
    sessionCookie,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${sessionDurationSeconds}`,
    ...(isSecure ? [`Secure`, `Domain=.${baseDomain}`] : []),
  ].join('; ');

  return { cookieHeader, sessionCookie, sessionId: session.id, expiresAt: session.expiresAt };
}

async function createCappedSession(
  ctx: Awaited<Awaited<ReturnType<typeof createAuth>>['$context']>,
  userId: string,
  expiresAt: Date
) {
  // overrideAll lets these fields replace BetterAuth's default lifetime.
  return ctx.internalAdapter.createSession(
    userId,
    false,
    { expiresAt, [HARD_EXPIRES_AT_FIELD]: expiresAt },
    true
  );
}

/**
 * The signed-in user, for routes that grant a credential to another client (device-flow
 * approval). Refuses an agent sign-in session: it must not mint a credential that outlives it.
 */
export async function getAuthenticatedUser(
  c: Context<{ Bindings: Env }>
): Promise<{ id: string; status?: string | null }> {
  const auth = await createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  if (!session?.user || isPastHardExpiry(session.session)) {
    throw errors.unauthorized('Not authenticated');
  }
  assertUserNotSuspended(session.user);
  if (isAgentSignInSession(session.session)) {
    throw errors.forbidden('Agent sign-in sessions cannot create credentials');
  }
  return session.user;
}

export async function buildSessionLoginResponse(
  env: Env,
  user: SessionFactoryUser
): Promise<Response> {
  await assertUserCanCreateSession(env, user);
  return sessionLoginResponse(user, await createSessionCookieForUser(env, user.id));
}

/** The login response for a session already created for `user`: JSON plus Set-Cookie. */
export function sessionLoginResponse(
  user: SessionFactoryUser,
  session: CreatedSessionCookie
): Response {
  return new Response(
    JSON.stringify({
      success: true,
      user: { id: user.id, email: user.email, name: user.name },
      sessionCookie: session.sessionCookie,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': session.cookieHeader,
      },
    }
  );
}

export async function assertUserCanCreateSession(
  env: Env,
  user: SessionFactoryUser
): Promise<void> {
  await assertSessionUserApproved(env, user);
}
