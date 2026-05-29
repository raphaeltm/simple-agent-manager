import { createAuth } from '../auth';
import type { Env } from '../env';
import { getBetterAuthSecret } from '../lib/secrets';
import { errors } from '../middleware/error';

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
}

export async function createSessionCookieForUser(
  env: Env,
  userId: string,
): Promise<CreatedSessionCookie> {
  const auth = createAuth(env);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(
    userId,
    false,
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
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(session.token),
  );
  const base64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const signedValue = encodeURIComponent(`${session.token}.${base64Sig}`);

  const baseDomain = env.BASE_DOMAIN;
  const isSecure = `https://api.${baseDomain}`.startsWith('https://');
  const cookieName = isSecure
    ? '__Secure-better-auth.session_token'
    : 'better-auth.session_token';
  const sessionDurationSeconds =
    parseInt(env.API_TOKEN_SESSION_DURATION_SECONDS || '', 10) || DEFAULT_SESSION_DURATION_SECONDS;
  const sessionCookie = `${cookieName}=${signedValue}`;
  const cookieHeader = [
    sessionCookie,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${sessionDurationSeconds}`,
    ...(isSecure ? [`Secure`, `Domain=.${baseDomain}`] : []),
  ].join('; ');

  return { cookieHeader, sessionCookie };
}

export function assertUserCanCreateSession(env: Env, user: SessionFactoryUser): void {
  if (env.REQUIRE_APPROVAL !== 'true') {
    return;
  }

  const isAdmin = user.role === 'superadmin' || user.role === 'admin';
  if (user.status === 'suspended') {
    throw errors.forbidden('Your account has been suspended');
  }
  if (user.status !== 'active' && !isAdmin) {
    throw errors.forbidden('Your account is pending admin approval');
  }
}
