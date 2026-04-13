import { createProvider } from '@simple-agent-manager/providers';
import type { AgentType, CredentialProvider, PlatformCredentialResponse } from '@simple-agent-manager/shared';
import { CREDENTIAL_PROVIDERS, isValidAgentType } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { CreatePlatformCredentialSchema, jsonValidator,UpdatePlatformCredentialSchema } from '../schemas';
import { decrypt, encrypt } from '../services/encryption';
import { buildProviderConfig } from '../services/provider-credentials';
import { CredentialValidator } from '../services/validation';

const adminPlatformCredentialRoutes = new Hono<{ Bindings: Env }>();

adminPlatformCredentialRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * GET /api/admin/platform-credentials — list all platform credentials
 */
adminPlatformCredentialRoutes.get('/', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  const rows = await db.select().from(schema.platformCredentials);

  const credentials: PlatformCredentialResponse[] = rows.map((row) => ({
    id: row.id,
    credentialType: row.credentialType as PlatformCredentialResponse['credentialType'],
    provider: row.provider as CredentialProvider | null,
    agentType: row.agentType,
    credentialKind: row.credentialKind as PlatformCredentialResponse['credentialKind'],
    label: row.label,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  return c.json({ credentials });
});

/**
 * POST /api/admin/platform-credentials — create a platform credential
 */
adminPlatformCredentialRoutes.post('/', jsonValidator(CreatePlatformCredentialSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  // Validate type-specific fields
  if (body.credentialType === 'cloud-provider') {
    if (!body.provider) {
      throw errors.badRequest('provider is required for cloud-provider credentials');
    }
    if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(body.provider)) {
      throw errors.badRequest(`Unsupported provider: ${body.provider}`);
    }
  } else if (body.credentialType === 'agent-api-key') {
    if (!body.agentType) {
      throw errors.badRequest('agentType is required for agent-api-key credentials');
    }
    if (!isValidAgentType(body.agentType)) {
      throw errors.badRequest(`Invalid agent type: ${body.agentType}`);
    }
  }

  const credentialKind = body.credentialKind ?? 'api-key';

  // Validate the credential
  if (body.credentialType === 'cloud-provider' && body.provider && body.provider !== 'gcp') {
    try {
      const providerConfig = buildProviderConfig(body.provider as CredentialProvider, body.credential);
      const provider = createProvider(providerConfig);
      await provider.validateToken();
    } catch (err) {
      log.error('platform_credentials.cloud_validation_failed', {
        provider: body.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      throw errors.badRequest(`Invalid or unauthorized ${body.provider} credentials`);
    }
  } else if (body.credentialType === 'agent-api-key') {
    const validation = CredentialValidator.validateCredential(
      body.credential,
      credentialKind as 'api-key' | 'oauth-token',
      body.agentType as AgentType | undefined,
    );
    if (!validation.valid) {
      throw errors.badRequest(validation.error || 'Invalid credential format');
    }
  }

  // Encrypt and store
  const encryptionKey = getCredentialEncryptionKey(c.env);
  const { ciphertext, iv } = await encrypt(body.credential, encryptionKey);
  const now = new Date().toISOString();
  const id = ulid();

  await db.insert(schema.platformCredentials).values({
    id,
    credentialType: body.credentialType,
    provider: body.provider ?? null,
    agentType: body.agentType ?? null,
    credentialKind: credentialKind,
    label: body.label,
    encryptedToken: ciphertext,
    iv,
    isEnabled: true,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  const response: PlatformCredentialResponse = {
    id,
    credentialType: body.credentialType,
    provider: (body.provider as CredentialProvider) ?? null,
    agentType: body.agentType ?? null,
    credentialKind: credentialKind as PlatformCredentialResponse['credentialKind'],
    label: body.label,
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  };

  return c.json(response, 201);
});

/**
 * PATCH /api/admin/platform-credentials/:id — update label or enable/disable
 */
adminPlatformCredentialRoutes.patch('/:id', jsonValidator(UpdatePlatformCredentialSchema), async (c) => {
  const credentialId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');

  const existing = await db
    .select()
    .from(schema.platformCredentials)
    .where(eq(schema.platformCredentials.id, credentialId))
    .limit(1);

  if (!existing[0]) {
    throw errors.notFound('Platform credential');
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.label !== undefined) {
    updates.label = body.label;
  }
  if (body.isEnabled !== undefined) {
    updates.isEnabled = body.isEnabled;
  }

  await db
    .update(schema.platformCredentials)
    .set(updates)
    .where(eq(schema.platformCredentials.id, credentialId));

  const updated = await db
    .select()
    .from(schema.platformCredentials)
    .where(eq(schema.platformCredentials.id, credentialId))
    .limit(1);

  const row = updated[0]!;
  const response: PlatformCredentialResponse = {
    id: row.id,
    credentialType: row.credentialType as PlatformCredentialResponse['credentialType'],
    provider: row.provider as CredentialProvider | null,
    agentType: row.agentType,
    credentialKind: row.credentialKind as PlatformCredentialResponse['credentialKind'],
    label: row.label,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  return c.json(response);
});

/**
 * DELETE /api/admin/platform-credentials/:id — remove a platform credential
 */
adminPlatformCredentialRoutes.delete('/:id', async (c) => {
  const credentialId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const result = await db
    .delete(schema.platformCredentials)
    .where(eq(schema.platformCredentials.id, credentialId))
    .returning();

  if (result.length === 0) {
    throw errors.notFound('Platform credential');
  }

  return c.json({ success: true });
});

/**
 * GET /api/admin/platform-credentials/:id/masked-value — get masked credential value (last 4 chars)
 */
adminPlatformCredentialRoutes.get('/:id/masked-value', async (c) => {
  const credentialId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const rows = await db
    .select()
    .from(schema.platformCredentials)
    .where(eq(schema.platformCredentials.id, credentialId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw errors.notFound('Platform credential');
  }

  const encryptionKey = getCredentialEncryptionKey(c.env);
  const plaintext = await decrypt(row.encryptedToken, row.iv, encryptionKey);
  const maskedKey = `...${plaintext.slice(-4)}`;

  return c.json({ maskedKey });
});

export { adminPlatformCredentialRoutes };
