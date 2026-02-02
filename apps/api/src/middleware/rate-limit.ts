/**
 * Rate Limiting Middleware
 *
 * Provides configurable rate limiting using Cloudflare KV.
 * All limits are configurable via environment variables per constitution principle XI.
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../index';
import { AppError } from './error';

/**
 * Rate limit configuration.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed within the time window */
  limit: number;
  /** Time window in seconds (default: 3600 = 1 hour) */
  windowSeconds?: number;
  /** Key prefix for KV storage */
  keyPrefix: string;
  /** Whether to use IP-based limiting (for unauthenticated endpoints) */
  useIp?: boolean;
}

/**
 * Default rate limits (per hour).
 * These values are used when environment variables are not set.
 */
export const DEFAULT_RATE_LIMITS = {
  WORKSPACE_CREATE: 10,
  TERMINAL_TOKEN: 60,
  CREDENTIAL_UPDATE: 5,
  ANONYMOUS: 100,
} as const;

/** Default time window (1 hour in seconds) */
const DEFAULT_WINDOW_SECONDS = 3600;

/**
 * KV entry for rate limit tracking.
 */
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Get rate limit from environment variable with fallback to default.
 */
export function getRateLimit(env: Env, key: keyof typeof DEFAULT_RATE_LIMITS): number {
  const envKey = `RATE_LIMIT_${key}` as keyof Env;
  const envValue = env[envKey] as string | undefined;
  return envValue ? parseInt(envValue, 10) : DEFAULT_RATE_LIMITS[key];
}

/**
 * Get the client IP address from the request.
 */
function getClientIp(c: Context): string {
  const cfIp = c.req.header('CF-Connecting-IP');
  if (cfIp) return cfIp;

  const xForwardedFor = c.req.header('X-Forwarded-For');
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(',')[0];
    return firstIp ? firstIp.trim() : 'unknown';
  }

  return 'unknown';
}

/**
 * Create a rate limit key for KV storage.
 */
function createRateLimitKey(prefix: string, identifier: string, windowStart: number): string {
  return `ratelimit:${prefix}:${identifier}:${windowStart}`;
}

/**
 * Calculate the current window start timestamp.
 */
function getCurrentWindowStart(windowSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / windowSeconds) * windowSeconds;
}

/**
 * Check and update rate limit.
 */
async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const windowStart = getCurrentWindowStart(windowSeconds);
  const resetAt = windowStart + windowSeconds;

  const existing = await kv.get<RateLimitEntry>(key, 'json');

  if (!existing || existing.windowStart !== windowStart) {
    const entry: RateLimitEntry = { count: 1, windowStart };
    await kv.put(key, JSON.stringify(entry), {
      expirationTtl: windowSeconds + 60,
    });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  const newCount = existing.count + 1;
  const allowed = newCount <= limit;
  const remaining = Math.max(0, limit - newCount);

  const entry: RateLimitEntry = { count: newCount, windowStart };
  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: windowSeconds + 60,
  });

  return { allowed, remaining, resetAt };
}

/**
 * Rate limit error with Retry-After header support.
 */
export class RateLimitError extends AppError {
  public retryAfter: number;

  constructor(retryAfter: number) {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.');
    this.retryAfter = retryAfter;
  }
}

/**
 * Rate limiting middleware.
 */
export function rateLimit(config: RateLimitConfig): MiddlewareHandler<{ Bindings: Env }> {
  const windowSeconds = config.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    let identifier: string;

    if (config.useIp) {
      identifier = getClientIp(c);
    } else {
      const auth = c.get('auth');
      if (!auth?.user?.id) {
        console.warn('Rate limit middleware applied to unauthenticated request without useIp');
        return next();
      }
      identifier = auth.user.id;
    }

    const windowStart = getCurrentWindowStart(windowSeconds);
    const key = createRateLimitKey(config.keyPrefix, identifier, windowStart);

    const { allowed, remaining, resetAt } = await checkRateLimit(
      c.env.KV,
      key,
      config.limit,
      windowSeconds
    );

    c.header('X-RateLimit-Limit', config.limit.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', resetAt.toString());

    if (!allowed) {
      const retryAfter = resetAt - Math.floor(Date.now() / 1000);
      c.header('Retry-After', Math.max(1, retryAfter).toString());
      throw new RateLimitError(retryAfter);
    }

    return next();
  };
}

/**
 * Rate limit middleware for workspace creation.
 * Default: 10 requests per hour per user.
 */
export function rateLimitWorkspaceCreate(env: Env): MiddlewareHandler<{ Bindings: Env }> {
  return rateLimit({
    limit: getRateLimit(env, 'WORKSPACE_CREATE'),
    keyPrefix: 'workspace-create',
  });
}

/**
 * Rate limit middleware for terminal token generation.
 * Default: 60 requests per hour per user.
 */
export function rateLimitTerminalToken(env: Env): MiddlewareHandler<{ Bindings: Env }> {
  return rateLimit({
    limit: getRateLimit(env, 'TERMINAL_TOKEN'),
    keyPrefix: 'terminal-token',
  });
}

/**
 * Rate limit middleware for credential updates.
 * Default: 5 requests per hour per user.
 */
export function rateLimitCredentialUpdate(env: Env): MiddlewareHandler<{ Bindings: Env }> {
  return rateLimit({
    limit: getRateLimit(env, 'CREDENTIAL_UPDATE'),
    keyPrefix: 'credential-update',
  });
}

/**
 * Rate limit middleware for anonymous/unauthenticated endpoints.
 * Default: 100 requests per hour per IP.
 */
export function rateLimitAnonymous(env: Env): MiddlewareHandler<{ Bindings: Env }> {
  return rateLimit({
    limit: getRateLimit(env, 'ANONYMOUS'),
    keyPrefix: 'anonymous',
    useIp: true,
  });
}
