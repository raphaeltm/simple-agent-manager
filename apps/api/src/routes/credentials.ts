import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Env } from '../index';
import { requireAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { encrypt, decrypt } from '../services/encryption';
import { validateHetznerToken } from '../services/hetzner';
import * as schema from '../db/schema';
import type { CredentialResponse } from '@simple-agent-manager/shared';

const credentialsRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
credentialsRoutes.use('*', requireAuth());

/**
 * GET /api/credentials - List all credentials for the current user
 */
credentialsRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const creds = await db
    .select({
      id: schema.credentials.id,
      provider: schema.credentials.provider,
      createdAt: schema.credentials.createdAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.userId, userId));

  const response: CredentialResponse[] = creds.map((cred) => ({
    id: cred.id,
    provider: cred.provider as 'hetzner',
    connected: true,
    createdAt: cred.createdAt,
  }));

  return c.json(response);
});

/**
 * POST /api/credentials - Create or update a credential
 */
credentialsRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = await c.req.json<{ provider: string; token: string }>();

  if (!body.provider || !body.token) {
    throw errors.badRequest('Provider and token are required');
  }

  if (body.provider !== 'hetzner') {
    throw errors.badRequest('Only hetzner provider is supported');
  }

  // Validate the token
  try {
    await validateHetznerToken(body.token);
  } catch (err) {
    throw errors.badRequest(err instanceof Error ? err.message : 'Invalid token');
  }

  // Encrypt the token
  const { ciphertext, iv } = await encrypt(body.token, c.env.ENCRYPTION_KEY);

  // Check if credential already exists
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, body.provider)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  const existingCred = existing[0];
  if (existingCred) {
    // Update existing credential
    await db
      .update(schema.credentials)
      .set({
        encryptedToken: ciphertext,
        iv,
        updatedAt: now,
      })
      .where(eq(schema.credentials.id, existingCred.id));

    const response: CredentialResponse = {
      id: existingCred.id,
      provider: body.provider as 'hetzner',
      connected: true,
      createdAt: existingCred.createdAt,
    };

    return c.json(response);
  }

  // Create new credential
  const id = ulid();
  await db.insert(schema.credentials).values({
    id,
    userId,
    provider: body.provider,
    encryptedToken: ciphertext,
    iv,
    createdAt: now,
    updatedAt: now,
  });

  const response: CredentialResponse = {
    id,
    provider: body.provider as 'hetzner',
    connected: true,
    createdAt: now,
  };

  return c.json(response, 201);
});

/**
 * DELETE /api/credentials/:provider - Delete a credential
 */
credentialsRoutes.delete('/:provider', async (c) => {
  const userId = getUserId(c);
  const provider = c.req.param('provider');
  const db = drizzle(c.env.DATABASE, { schema });

  const result = await db
    .delete(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, provider)
      )
    )
    .returning();

  if (result.length === 0) {
    throw errors.notFound('Credential');
  }

  return c.json({ success: true });
});

/**
 * Helper function to get decrypted credential for internal use.
 */
export async function getDecryptedCredential(
  db: ReturnType<typeof drizzle>,
  userId: string,
  provider: string,
  encryptionKey: string
): Promise<string | null> {
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, provider)
      )
    )
    .limit(1);

  const foundCred = creds[0];
  if (!foundCred) {
    return null;
  }

  return decrypt(foundCred.encryptedToken, foundCred.iv, encryptionKey);
}

export { credentialsRoutes };
