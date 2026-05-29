import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import { createAuth } from '../auth';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { rateLimit } from '../middleware/rate-limit';
import { ApiTokenCreateSchema, ApiTokenRedeemSchema,jsonValidator } from '../schemas';
import { assertUserCanCreateSession, createSessionCookieForUser } from '../services/session-factory';

const TOKEN_PREFIX = 'sam_pat_';
const LEGACY_TOKEN_PREFIX = 'sam_test_';
const DEFAULT_TOKEN_BYTES = 32;
const DEFAULT_MAX_TOKENS_PER_USER = 10;
const DEFAULT_MAX_TOKEN_NAME_LENGTH = 100;
const DEFAULT_RATE_LIMIT_TOKEN_LOGIN = 20;

function generateToken(tokenBytes: number): string {
  const bytes = new Uint8Array(tokenBytes);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  const base64url = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${base64url}`;
}

async function hashToken(rawToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hasSupportedTokenPrefix(rawToken: string): boolean {
  return rawToken.startsWith(TOKEN_PREFIX) || rawToken.startsWith(LEGACY_TOKEN_PREFIX);
}

const tokenLoginRateLimit = rateLimit({
  limit: DEFAULT_RATE_LIMIT_TOKEN_LOGIN,
  keyPrefix: 'rl:token-login',
  useIp: true,
});

const apiTokenRoutes = new Hono<{ Bindings: Env }>();

apiTokenRoutes.get('/api-tokens', async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const tokens = await db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      createdAt: schema.apiTokens.createdAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      revokedAt: schema.apiTokens.revokedAt,
    })
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.userId, session.user.id))
    .all();

  return c.json(tokens);
});

apiTokenRoutes.post('/api-tokens', jsonValidator(ApiTokenCreateSchema), async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const body = c.req.valid('json');
  const maxNameLength = parseInt(c.env.MAX_API_TOKEN_NAME_LENGTH || '', 10) || DEFAULT_MAX_TOKEN_NAME_LENGTH;
  const name = (body.name || '').trim();
  if (!name || name.length > maxNameLength) {
    throw errors.badRequest(`Token name is required and must be ${maxNameLength} characters or fewer`);
  }

  const maxTokens = parseInt(c.env.MAX_API_TOKENS_PER_USER || '', 10) || DEFAULT_MAX_TOKENS_PER_USER;
  const db = drizzle(c.env.DATABASE, { schema });
  const existing = await db
    .select({ id: schema.apiTokens.id })
    .from(schema.apiTokens)
    .where(
      and(
        eq(schema.apiTokens.userId, session.user.id),
        isNull(schema.apiTokens.revokedAt)
      )
    )
    .all();

  if (existing.length >= maxTokens) {
    throw errors.badRequest(
      `Maximum of ${maxTokens} active tokens per user. Revoke an existing token first.`
    );
  }

  const tokenBytes = parseInt(c.env.API_TOKEN_BYTES || '', 10) || DEFAULT_TOKEN_BYTES;
  const rawToken = generateToken(tokenBytes);
  const tokenHash = await hashToken(rawToken);
  const id = ulid();

  await db.insert(schema.apiTokens).values({
    id,
    userId: session.user.id,
    tokenHash,
    name,
  });

  return c.json({ id, token: rawToken, name }, 201);
});

apiTokenRoutes.delete('/api-tokens/:id', async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw errors.unauthorized('Not authenticated');
  }

  const tokenId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const result = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiTokens.id, tokenId),
        eq(schema.apiTokens.userId, session.user.id)
      )
    );

  if ((result as { meta?: { changes?: number } }).meta?.changes === 0) {
    throw errors.notFound('Token not found');
  }

  return c.json({ success: true });
});

apiTokenRoutes.post('/token-login', tokenLoginRateLimit, jsonValidator(ApiTokenRedeemSchema), async (c) => {
  const body = c.req.valid('json');
  const rawToken = (body.token || '').trim();
  if (!rawToken) {
    throw errors.badRequest('Token is required');
  }

  if (!hasSupportedTokenPrefix(rawToken)) {
    throw errors.unauthorized('Invalid token format');
  }

  const tokenHash = await hashToken(rawToken);
  const db = drizzle(c.env.DATABASE, { schema });

  const tokenRecord = await db
    .select()
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.tokenHash, tokenHash))
    .get();

  if (!tokenRecord) {
    throw errors.unauthorized('Invalid token');
  }

  if (tokenRecord.revokedAt) {
    throw errors.unauthorized('Token has been revoked');
  }

  await db
    .update(schema.apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiTokens.id, tokenRecord.id));

  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, tokenRecord.userId))
    .get();

  if (!user) {
    throw errors.unauthorized('Token owner not found');
  }

  assertUserCanCreateSession(c.env, user);
  const { cookieHeader, sessionCookie } = await createSessionCookieForUser(c.env, tokenRecord.userId);

  return new Response(
    JSON.stringify({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
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
});

export { apiTokenRoutes, hashToken };
