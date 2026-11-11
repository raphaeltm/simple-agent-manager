import type { Context } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { getBetterAuthSecret } from '../lib/secrets';
import { errors } from '../middleware/error';
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
   * Fixed lifetime for this session, in seconds, applied to both the stored session and the
   * cookie. Omitted: BetterAuth's normal lifetime and API_TOKEN_SESSION_DURATION_SECONDS.
   * BetterAuth extends a session on refresh, so a caller that needs a hard cap must also
   * record it where the session.update hook in `auth.ts` can clamp to it.
   */
  ttlSeconds?: number;
}

export async function createSessionCookieForUser(
  env: Env,
  userId: string,
  options: SessionLifetimeOptions = {}
): Promise<CreatedSessionCookie> {
  const auth = await createAuth(env);
  const ctx = await auth.$context;
  const { ttlSeconds } = options;
  const session =
    ttlSeconds === undefined
      ? await ctx.internalAdapter.createSession(userId, false)
      : // overrideAll lets our expiresAt replace BetterAuth's default lifetime.
        await ctx.internalAdapter.createSession(
          userId,
          false,
          { expiresAt: new Date(Date.now() + ttlSeconds * 1000) },
          true
        );

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
    ttlSeconds ??
    (parseInt(env.API_TOKEN_SESSION_DURATION_SECONDS || '', 10) ||
      DEFAULT_SESSION_DURATION_SECONDS);
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

export async function getAuthenticatedUser(
  c: Context<{ Bindings: Env }>
): Promise<{ id: string; status?: string | null }> {
  const auth = await createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }
  assertUserNotSuspended(session.user);
  return session.user;
}

export async function buildSessionLoginResponse(
  env: Env,
  user: SessionFactoryUser
): Promise<Response> {
  return (await createSessionLogin(env, user)).response;
}

/** Sign `user` in: the approval gate, a BetterAuth session, and the login response. */
export async function createSessionLogin(
  env: Env,
  user: SessionFactoryUser,
  options: SessionLifetimeOptions = {}
): Promise<{ response: Response; session: CreatedSessionCookie }> {
  await assertUserCanCreateSession(env, user);
  const session = await createSessionCookieForUser(env, user.id, options);
  const { cookieHeader, sessionCookie } = session;
  const response = new Response(
    JSON.stringify({
      success: true,
      user: { id: user.id, email: user.email, name: user.name },
      sessionCookie,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader,
      },
    }
  );
  return { response, session };
}

export async function assertUserCanCreateSession(
  env: Env,
  user: SessionFactoryUser
): Promise<void> {
  await assertSessionUserApproved(env, user);
}
