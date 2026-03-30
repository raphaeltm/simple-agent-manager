import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, isNull } from 'drizzle-orm';
import { ulid } from '../lib/ulid';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { createAuth } from '../auth';
import { errors } from '../middleware/error';
import { rateLimit } from '../middleware/rate-limit';

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
smokeTestTokenRoutes.post('/smoke-test-tokens', async (c) => {
  if (!isFeatureEnabled(c.env)) {
    throw errors.notFound('Not found');
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const body = await c.req.json<{ name?: string }>();
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
 * NOTE: Session creation bypasses BetterAuth's session lifecycle (direct DB insert).
 * BetterAuth does not expose a programmatic session creation API suitable for token-based login.
 * If the sessions table schema changes (new required columns), this path must be updated.
 * The unit tests verify that sessions created here are compatible with the current schema.
 */
const tokenLoginRateLimit = rateLimit({
  limit: DEFAULT_RATE_LIMIT_TOKEN_LOGIN,
  keyPrefix: 'rl:token-login',
  useIp: true,
});

smokeTestTokenRoutes.post('/token-login', tokenLoginRateLimit, async (c) => {
  if (!isFeatureEnabled(c.env)) {
    throw errors.notFound('Not found');
  }

  const body = await c.req.json<{ token?: string }>();
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

  // Parallelize last_used_at update and user lookup — independent D1 queries
  const [, user] = await Promise.all([
    db
      .update(schema.smokeTestTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.smokeTestTokens.id, tokenRecord.id)),
    db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, tokenRecord.userId))
      .get(),
  ]);

  if (!user) {
    throw errors.unauthorized('Token owner not found');
  }

  // Create a session directly in the BetterAuth sessions table.
  // This produces the same cookie as the OAuth callback would.
  const sessionDurationSeconds =
    parseInt(c.env.SMOKE_TEST_SESSION_DURATION_SECONDS || '', 10) || DEFAULT_SESSION_DURATION_SECONDS;
  const sessionToken = crypto.randomUUID();
  const sessionId = ulid();
  const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000);

  await db.insert(schema.sessions).values({
    id: sessionId,
    token: sessionToken,
    userId: user.id,
    expiresAt,
    ipAddress: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null,
    userAgent: c.req.header('user-agent') || null,
  });

  // Set the session cookie matching BetterAuth's format
  const isSecure = c.req.url.startsWith('https');
  const baseDomain = c.env.BASE_DOMAIN;

  // BetterAuth uses "better-auth.session_token" as the cookie name
  const cookieName = 'better-auth.session_token';
  const cookieValue = sessionToken;
  const cookieOptions = [
    `${cookieName}=${cookieValue}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
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
