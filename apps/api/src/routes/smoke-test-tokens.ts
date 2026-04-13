import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { createAuth } from '../auth';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { getBetterAuthSecret } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { rateLimit } from '../middleware/rate-limit';
import { jsonValidator, SmokeTestCreateSchema, SmokeTestRedeemSchema } from '../schemas';

/** Token prefix — identifiable if leaked, greppable in logs */
const TOKEN_PREFIX = 'sam_test_';

/** Number of random bytes for token generation (default: 32) */
const DEFAULT_TOKEN_BYTES = 32;

/** Maximum number of active tokens per user (default: 10) */
const DEFAULT_MAX_TOKENS_PER_USER = 10;

/** Maximum length for token name (default: 100) */
const DEFAULT_MAX_TOKEN_NAME_LENGTH = 100;

/** Default session duration for token-based login (7 days in seconds) */
const DEFAULT_SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 604800

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFeatureEnabled(env: Env): boolean {
  return env.SMOKE_TEST_AUTH_ENABLED === 'true';
}

/**
 * Generate a crypto-random token with the sam_test_ prefix.
 * Returns the raw token string (shown once to the user).
 */
function generateToken(tokenBytes: number): string {
  const bytes = new Uint8Array(tokenBytes);
  crypto.getRandomValues(bytes);
  // base64url encoding (no padding) — loop avoids stack overflow from spread on large arrays
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const base64url = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${base64url}`;
}

/**
 * SHA-256 hash of a raw token string. Returns hex-encoded hash.
 */
async function hashToken(rawToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const smokeTestTokenRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/auth/smoke-test-status
 * Public endpoint (no auth required) — returns whether the feature is enabled.
 * Used by the UI to conditionally show the token management section.
 */
smokeTestTokenRoutes.get('/smoke-test-status', async (c) => {
  return c.json({ enabled: isFeatureEnabled(c.env) });
});

/**
 * GET /api/auth/smoke-test-tokens
 * List all tokens for the authenticated user. Never returns the token hash.
 */
smokeTestTokenRoutes.get('/smoke-test-tokens', async (c) => {
  if (!isFeatureEnabled(c.env)) {
    throw errors.notFound('Not found');
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const tokens = await db
    .select({
      id: schema.smokeTestTokens.id,
      name: schema.smokeTestTokens.name,
      createdAt: schema.smokeTestTokens.createdAt,
      lastUsedAt: schema.smokeTestTokens.lastUsedAt,
      revokedAt: schema.smokeTestTokens.revokedAt,
    })
    .from(schema.smokeTestTokens)
    .where(eq(schema.smokeTestTokens.userId, session.user.id))
    .all();

  return c.json(tokens);
});

/**
 * POST /api/auth/smoke-test-tokens
 * Generate a new token. Returns the raw token once — it is never stored or returned again.
 * Body: { name: string }
 */
smokeTestTokenRoutes.post('/smoke-test-tokens', jsonValidator(SmokeTestCreateSchema), async (c) => {
  if (!isFeatureEnabled(c.env)) {
    throw errors.notFound('Not found');
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const body = c.req.valid('json');
  const maxNameLength = parseInt(c.env.MAX_SMOKE_TOKEN_NAME_LENGTH || '', 10) || DEFAULT_MAX_TOKEN_NAME_LENGTH;
  const name = (body.name || '').trim();
  if (!name || name.length > maxNameLength) {
    throw errors.badRequest(
      `Token name is required and must be ${maxNameLength} characters or fewer`
    );
  }

  // Check active token limit
  const maxTokens = parseInt(c.env.MAX_SMOKE_TOKENS_PER_USER || '', 10) || DEFAULT_MAX_TOKENS_PER_USER;
  const db = drizzle(c.env.DATABASE, { schema });
  const existing = await db
    .select({ id: schema.smokeTestTokens.id })
    .from(schema.smokeTestTokens)
    .where(
      and(
        eq(schema.smokeTestTokens.userId, session.user.id),
        isNull(schema.smokeTestTokens.revokedAt)
      )
    )
    .all();

  if (existing.length >= maxTokens) {
    throw errors.badRequest(
      `Maximum of ${maxTokens} active tokens per user. Revoke an existing token first.`
    );
  }

  const tokenBytes = parseInt(c.env.SMOKE_TOKEN_BYTES || '', 10) || DEFAULT_TOKEN_BYTES;
  const rawToken = generateToken(tokenBytes);
  const tokenHash = await hashToken(rawToken);
  const id = ulid();

  await db.insert(schema.smokeTestTokens).values({
    id,
    userId: session.user.id,
    tokenHash,
    name,
  });

  return c.json({ id, token: rawToken, name }, 201);
});

/**
 * DELETE /api/auth/smoke-test-tokens/:id
 * Revoke a token. Sets revoked_at timestamp. Must belong to the authenticated user.
 * Returns 404 for both missing tokens and tokens belonging to other users (prevents enumeration).
 */
smokeTestTokenRoutes.delete('/smoke-test-tokens/:id', async (c) => {
  if (!isFeatureEnabled(c.env)) {
    throw errors.notFound('Not found');
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const tokenId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  // Single UPDATE with ownership check — avoids info disclosure and extra round-trip
  const result = await db
    .update(schema.smokeTestTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.smokeTestTokens.id, tokenId),
        eq(schema.smokeTestTokens.userId, session.user.id)
      )
    );

  // D1 returns changes count; if 0, token not found or not owned by user
  if ((result as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw errors.notFound('Token not found');
  }

  return c.json({ success: true });
});

/** Default rate limit for token-login: 20 attempts per hour per IP */
const DEFAULT_RATE_LIMIT_TOKEN_LOGIN = 20;

/**
 * POST /api/auth/token-login
 * Login via smoke test token. No session auth required — the token IS the credential.
 * Creates a BetterAuth session and returns the session cookie.
 * Rate-limited by IP to prevent brute-force attempts.
 * Body: { token: string }
 *
 * NOTE: Session creation uses BetterAuth's internal adapter (`ctx.internalAdapter.createSession()`)
 * to ensure schema mapping (usePlural, field transforms) is handled correctly.
 * Cookie signing replicates BetterAuth's HMAC-SHA256 format with the `__Secure-` prefix for HTTPS.
 */
const tokenLoginRateLimit = rateLimit({
  limit: DEFAULT_RATE_LIMIT_TOKEN_LOGIN,
  keyPrefix: 'rl:token-login',
  useIp: true,
});

smokeTestTokenRoutes.post('/token-login', tokenLoginRateLimit, jsonValidator(SmokeTestRedeemSchema), async (c) => {
  if (!isFeatureEnabled(c.env)) {
    throw errors.notFound('Not found');
  }

  const body = c.req.valid('json');
  const rawToken = (body.token || '').trim();
  if (!rawToken) {
    throw errors.badRequest('Token is required');
  }

  if (!rawToken.startsWith(TOKEN_PREFIX)) {
    throw errors.unauthorized('Invalid token format');
  }

  const tokenHash = await hashToken(rawToken);
  const db = drizzle(c.env.DATABASE, { schema });

  const tokenRecord = await db
    .select()
    .from(schema.smokeTestTokens)
    .where(eq(schema.smokeTestTokens.tokenHash, tokenHash))
    .get();

  if (!tokenRecord) {
    throw errors.unauthorized('Invalid token');
  }

  if (tokenRecord.revokedAt) {
    throw errors.unauthorized('Token has been revoked');
  }

  // Update last_used_at
  await db
    .update(schema.smokeTestTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.smokeTestTokens.id, tokenRecord.id));

  // Look up user before creating session — needed for status check and response
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, tokenRecord.userId))
    .get();

  if (!user) {
    throw errors.unauthorized('Token owner not found');
  }

  // Block suspended/pending users — mirrors requireApproved() middleware logic.
  // Without this check, a previously issued token could bypass the approval gate.
  if (c.env.REQUIRE_APPROVAL === 'true') {
    const isAdmin = user.role === 'superadmin' || user.role === 'admin';
    if (user.status === 'suspended') {
      throw errors.forbidden('Your account has been suspended');
    }
    if (user.status !== 'active' && !isAdmin) {
      throw errors.forbidden('Your account is pending admin approval');
    }
  }

  // Create a session using BetterAuth's internal adapter (verified against v1.4.17).
  // Raw DB inserts bypass BetterAuth's schema mapping (usePlural, field transforms)
  // and produce sessions that getSession() cannot find. The internal adapter
  // handles all of this correctly.
  // NOTE: ipAddress/userAgent overrides are silently ignored because createSession
  // reads these from AsyncLocalStorage (populated only inside a BetterAuth request
  // handler). They are omitted here intentionally.
  const auth = createAuth(c.env);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(
    tokenRecord.userId,
    false, // dontRememberMe
  );

  if (!session) {
    throw errors.badRequest('Failed to create session');
  }

  // Set the session cookie matching BetterAuth's signed cookie format.
  // BetterAuth uses HMAC-SHA256 to sign cookie values: `value.base64(hmac(value, secret))`
  // then URL-encodes the result.
  const authSecret = getBetterAuthSecret(c.env);
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

  const baseDomain = c.env.BASE_DOMAIN;
  // Match BetterAuth's prefix logic: based on the configured baseURL (always HTTPS
  // in deployment), not the incoming request URL which may differ behind proxies.
  const isSecure = `https://api.${baseDomain}`.startsWith('https://');

  // BetterAuth adds a __Secure- prefix to cookie names when baseURL starts
  // with https:// (see cookies/index.ts createCookieGetter). Our cookie name
  // must match what getSession() expects.
  const cookieName = isSecure
    ? '__Secure-better-auth.session_token'
    : 'better-auth.session_token';
  // NOTE: SMOKE_TEST_SESSION_DURATION_SECONDS controls only the cookie Max-Age.
  // The server-side session expiry is determined by BetterAuth's session.expiresIn
  // config (default: 7 days), which matches DEFAULT_SESSION_DURATION_SECONDS.
  const sessionDurationSeconds =
    parseInt(c.env.SMOKE_TEST_SESSION_DURATION_SECONDS || '', 10) || DEFAULT_SESSION_DURATION_SECONDS;
  const cookieOptions = [
    `${cookieName}=${signedValue}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${sessionDurationSeconds}`,
    ...(isSecure ? [`Secure`, `Domain=.${baseDomain}`] : []),
  ].join('; ');

  return new Response(
    JSON.stringify({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieOptions,
      },
    }
  );
});

export { smokeTestTokenRoutes };
