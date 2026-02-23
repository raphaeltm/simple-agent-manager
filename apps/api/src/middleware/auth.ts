import type { Context, Next, MiddlewareHandler } from 'hono';
import { createAuth } from '../auth';
import { AppError, errors } from './error';
import type { Env } from '../index';
import type { UserRole, UserStatus } from '@simple-agent-manager/shared';

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
 * Authentication middleware.
 * Validates session and adds user info to context.
 * Throws 401 if not authenticated.
 */
export function requireAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const auth = createAuth(c.env);
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session?.user) {
      throw errors.unauthorized('Authentication required');
    }

    c.set('auth', {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
        avatarUrl: session.user.image ?? null,
        role: ((session.user as Record<string, unknown>).role as UserRole) ?? 'user',
        status: ((session.user as Record<string, unknown>).status as UserStatus) ?? 'active',
      },
      session: {
        id: session.session.id,
        expiresAt: session.session.expiresAt,
      },
    });

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
      const auth = createAuth(c.env);
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });

      if (session?.user) {
        c.set('auth', {
          user: {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name ?? null,
            avatarUrl: session.user.image ?? null,
            role: ((session.user as Record<string, unknown>).role as UserRole) ?? 'user',
            status: ((session.user as Record<string, unknown>).status as UserStatus) ?? 'active',
          },
          session: {
            id: session.session.id,
            expiresAt: session.session.expiresAt,
          },
        });
      }
    } catch {
      // Ignore errors in optional auth
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
    if (c.env.REQUIRE_APPROVAL !== 'true') {
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

    if (auth.user.status === 'suspended') {
      throw errors.forbidden('Your account has been suspended');
    }

    // Default: pending
    throw new AppError(403, 'APPROVAL_REQUIRED', 'Your account is pending admin approval');
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
