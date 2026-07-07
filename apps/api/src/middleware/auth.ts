import type { UserRole, UserStatus } from '@simple-agent-manager/shared';
import type { Context, MiddlewareHandler,Next } from 'hono';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord } from '../lib/runtime-validation';
import { assertUserAllowedBySignupApproval, isSignupApprovalRequired } from '../services/signup-approval';
import { errors } from './error';

/**
 * Extended context with authenticated user.
 */
export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    role: UserRole;
    status: UserStatus;
  };
  session: {
    id: string;
    expiresAt: Date;
  };
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Resolve the status of an authenticated session user.
 *
 * `'system'` is the status of internal sentinel rows (e.g. system_anonymous_trials,
 * seeded by migration 0043). It is an input:false additionalField — only migrations
 * ever write it — so a real, OAuth-authenticated request must never carry it. If we
 * see it on a live session it is an anomaly (a sentinel row was somehow logged in, or
 * a row was mislabeled), so we log it and fall back to the least-privileged status
 * rather than silently coercing it to 'active' and granting access.
 */
function resolveSessionStatus(rawStatus: unknown, userId: string): UserStatus {
  if (typeof rawStatus !== 'string') {
    return 'active';
  }
  if (rawStatus === 'system') {
    log.warn('auth.system_status_anomaly', { userId });
    return 'pending';
  }
  return rawStatus as UserStatus;
}

type AuthSession = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof createAuth>>['api']['getSession']>>
>;

/**
 * Project a validated BetterAuth session onto the request `auth` context shape.
 * Shared by requireAuth and optionalAuth so the role/status resolution lives in
 * exactly one place.
 */
function buildAuthContext(session: AuthSession): AuthContext {
  const sessionUser = expectJsonRecord(session.user, 'auth.session.user');
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
      avatarUrl: session.user.image ?? null,
      role: (typeof sessionUser.role === 'string' ? sessionUser.role : 'user') as UserRole,
      status: resolveSessionStatus(sessionUser.status, session.user.id),
    },
    session: {
      id: session.session.id,
      expiresAt: session.session.expiresAt,
    },
  };
}

/**
 * Authentication middleware.
 * Validates session and adds user info to context.
 * Throws 401 if not authenticated.
 */
export function requireAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const auth = await createAuth(c.env);
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session?.user) {
      throw errors.unauthorized('Authentication required');
    }

    c.set('auth', buildAuthContext(session));

    await next();
  };
}

/**
 * Optional authentication middleware.
 * If session exists, adds user info to context.
 * Does not throw if not authenticated.
 */
export function optionalAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    try {
      const auth = await createAuth(c.env);
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });

      if (session?.user) {
        c.set('auth', buildAuthContext(session));
      }
    } catch (e) {
      log.warn('optional_auth.check_failed', { error: String(e) });
    }

    await next();
  };
}

/**
 * Approval middleware.
 * When REQUIRE_APPROVAL is enabled, blocks users whose status is not 'active'.
 * Admins and superadmins always pass through.
 * Must be used AFTER requireAuth().
 */
export function requireApproved(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (!(await isSignupApprovalRequired(c.env))) {
      await next();
      return;
    }

    const auth = c.get('auth');
    if (!auth) {
      throw errors.unauthorized('Authentication required');
    }

    // Admins and superadmins always pass through
    if (auth.user.role === 'superadmin' || auth.user.role === 'admin') {
      await next();
      return;
    }

    if (auth.user.status === 'active') {
      await next();
      return;
    }

    assertUserAllowedBySignupApproval(true, auth.user);
    await next();
  };
}

/**
 * Superadmin middleware.
 * Requires the user to have the 'superadmin' role.
 * Must be used AFTER requireAuth().
 */
export function requireSuperadmin(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const auth = c.get('auth');
    if (!auth) {
      throw errors.unauthorized('Authentication required');
    }

    if (auth.user.role !== 'superadmin') {
      throw errors.forbidden('Superadmin access required');
    }

    await next();
  };
}

/**
 * Helper to get authenticated user from context.
 * Throws if not authenticated.
 */
export function getAuth(c: Context): AuthContext {
  const auth = c.get('auth');
  if (!auth) {
    throw errors.unauthorized('Authentication required');
  }
  return auth;
}

/**
 * Helper to get user ID from context.
 * Throws if not authenticated.
 */
export function getUserId(c: Context): string {
  return getAuth(c).user.id;
}
