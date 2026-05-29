import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { rateLimit } from '../middleware/rate-limit';
import { ApiTokenCreateSchema, ApiTokenRedeemSchema,jsonValidator } from '../schemas';
import { buildSessionLoginResponse, getAuthenticatedUser } from '../services/session-factory';

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
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `${TOKEN_PREFIX}${base64url}`;
}

async function hmacToken(rawToken: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawToken));
  return Array.from(new Uint8Array(sig))
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
  const user = await getAuthenticatedUser(c);

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
    .where(eq(schema.apiTokens.userId, user.id))
    .all();

  return c.json(tokens);
});

apiTokenRoutes.post('/api-tokens', jsonValidator(ApiTokenCreateSchema), async (c) => {
  const user = await getAuthenticatedUser(c);

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
        eq(schema.apiTokens.userId, user.id),
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
  const tokenHash = await hmacToken(rawToken, c.env.ENCRYPTION_KEY);
  const id = ulid();

  await db.insert(schema.apiTokens).values({
    id,
    userId: user.id,
    tokenHash,
    name,
  });

  return c.json({ id, token: rawToken, name }, 201);
});

apiTokenRoutes.delete('/api-tokens/:id', async (c) => {
  const user = await getAuthenticatedUser(c);

  const tokenId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const result = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiTokens.id, tokenId),
        eq(schema.apiTokens.userId, user.id)
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

  const tokenHash = await hmacToken(rawToken, c.env.ENCRYPTION_KEY);
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

  return buildSessionLoginResponse(c.env, user);
});

export { apiTokenRoutes, hmacToken };
