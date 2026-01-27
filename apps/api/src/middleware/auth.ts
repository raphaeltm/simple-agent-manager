import type { Context, Next, MiddlewareHandler } from 'hono';
import { createAuth } from '../auth';
import { errors } from './error';
import type { Env } from '../index';

/**
 * Extended context with authenticated user.
 */
export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
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
