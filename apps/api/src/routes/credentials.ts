import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { ulid } from '../lib/ulid';
import type { Env } from '../index';
import { requireAuth, requireApproved, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { encrypt, decrypt } from '../services/encryption';
import { validateHetznerToken } from '../services/hetzner';
import { CredentialValidator } from '../services/validation';
import * as schema from '../db/schema';
import type { CredentialResponse, AgentCredentialInfo, SaveAgentCredentialRequest, CredentialKind, AgentType } from '@simple-agent-manager/shared';
import { isValidAgentType, getAgentDefinition } from '@simple-agent-manager/shared';

const credentialsRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
credentialsRoutes.use('*', requireAuth(), requireApproved());

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
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider')
      )
    );

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
  // Note: We sanitize error messages to avoid leaking details about the Hetzner API
  try {
    await validateHetznerToken(body.token);
  } catch (err) {
    // Log the actual error for debugging, but return a generic message to the user
    console.error('Hetzner token validation failed:', err instanceof Error ? err.message : err);
    throw errors.badRequest('Invalid or unauthorized Hetzner API token');
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

// =============================================================================
// Agent API Key Endpoints
// =============================================================================

/**
 * GET /api/credentials/agent - List agent API key and OAuth credentials (masked)
 */
credentialsRoutes.get('/agent', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const creds = await db
    .select({
      agentType: schema.credentials.agentType,
      provider: schema.credentials.provider,
      credentialKind: schema.credentials.credentialKind,
      isActive: schema.credentials.isActive,
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
      createdAt: schema.credentials.createdAt,
      updatedAt: schema.credentials.updatedAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key')
      )
    );

  const credentials: AgentCredentialInfo[] = await Promise.all(
    creds
      .filter((cred) => cred.agentType != null)
      .map(async (cred) => {
        // Decrypt to get last 4 chars for masking
        const plaintext = await decrypt(cred.encryptedToken, cred.iv, c.env.ENCRYPTION_KEY);
        const maskedKey = `...${plaintext.slice(-4)}`;

        // Determine label based on credential kind
        let label: string | undefined;
        if (cred.credentialKind === 'oauth-token' && cred.agentType) {
          const agentDef = getAgentDefinition(cred.agentType as AgentType);
          if (agentDef?.id === 'claude-code') {
            label = 'Pro/Max Subscription';
          }
        }

        return {
          agentType: cred.agentType as AgentCredentialInfo['agentType'],
          provider: cred.provider as AgentCredentialInfo['provider'],
          credentialKind: cred.credentialKind as CredentialKind,
          isActive: cred.isActive,
          maskedKey,
          label,
          createdAt: cred.createdAt,
          updatedAt: cred.updatedAt,
        };
      })
  );

  return c.json({ credentials });
});

/**
 * PUT /api/credentials/agent - Save or update an agent API key or OAuth token
 */
credentialsRoutes.put('/agent', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = await c.req.json<SaveAgentCredentialRequest>();

  const credential = body.credential;
  const credentialKind = body.credentialKind || 'api-key';
  const autoActivate = body.autoActivate !== false; // Default true

  if (!body.agentType || !credential) {
    throw errors.badRequest('agentType and credential are required');
  }

  if (!isValidAgentType(body.agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  const agentDef = getAgentDefinition(body.agentType);
  if (!agentDef) {
    throw errors.badRequest('Unknown agent type');
  }

  // Validate credential format
  const validation = CredentialValidator.validateCredential(credential, credentialKind);
  if (!validation.valid) {
    throw errors.badRequest(validation.error || 'Invalid credential format');
  }

  // Check if OAuth is supported for this agent
  if (credentialKind === 'oauth-token' && !agentDef.oauthSupport) {
    throw errors.badRequest(`OAuth tokens are not supported for ${agentDef.name}`);
  }

  // Encrypt the credential
  const { ciphertext, iv } = await encrypt(credential, c.env.ENCRYPTION_KEY);

  // Check if a credential of this type already exists
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, body.agentType),
        eq(schema.credentials.credentialKind, credentialKind)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  // If auto-activating, deactivate other credentials for this agent
  if (autoActivate) {
    await db
      .update(schema.credentials)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, body.agentType)
        )
      );
  }

  const existingCred = existing[0];
  if (existingCred) {
    // Update existing credential
    await db
      .update(schema.credentials)
      .set({
        encryptedToken: ciphertext,
        iv,
        isActive: autoActivate,
        updatedAt: now,
      })
      .where(eq(schema.credentials.id, existingCred.id));

    const maskedKey = `...${credential.slice(-4)}`;
    const response: AgentCredentialInfo = {
      agentType: body.agentType,
      provider: agentDef.provider,
      credentialKind,
      isActive: autoActivate,
      maskedKey,
      label: credentialKind === 'oauth-token' ? 'Pro/Max Subscription' : undefined,
      createdAt: existingCred.createdAt,
      updatedAt: now,
    };

    return c.json(response);
  }

  // Create new credential
  const id = ulid();
  await db.insert(schema.credentials).values({
    id,
    userId,
    provider: agentDef.provider,
    credentialType: 'agent-api-key',
    agentType: body.agentType,
    credentialKind,
    isActive: autoActivate,
    encryptedToken: ciphertext,
    iv,
    createdAt: now,
    updatedAt: now,
  });

  const maskedKey = `...${credential.slice(-4)}`;
  const response: AgentCredentialInfo = {
    agentType: body.agentType,
    provider: agentDef.provider,
    credentialKind,
    isActive: autoActivate,
    maskedKey,
    label: credentialKind === 'oauth-token' ? 'Pro/Max Subscription' : undefined,
    createdAt: now,
    updatedAt: now,
  };

  return c.json(response, 201);
});

/**
 * POST /api/credentials/agent/:agentType/toggle - Toggle active credential
 *
 * Uses D1 batch to atomically deactivate all credentials then activate the
 * target, preventing race conditions where concurrent requests could leave
 * multiple credentials active or none active.
 */
credentialsRoutes.post('/agent/:agentType/toggle', async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  const body = await c.req.json<{ credentialKind: CredentialKind }>();

  if (!body.credentialKind || !['api-key', 'oauth-token'].includes(body.credentialKind)) {
    throw errors.badRequest('Invalid credential kind');
  }

  const now = new Date().toISOString();

  // Use D1 batch for atomic multi-statement execution.
  // Both statements execute in a single implicit transaction,
  // preventing race conditions between deactivate and activate.
  const deactivateStmt = c.env.DATABASE.prepare(
    `UPDATE credentials SET is_active = 0
     WHERE user_id = ? AND credential_type = 'agent-api-key' AND agent_type = ?`
  ).bind(userId, agentType);

  const activateStmt = c.env.DATABASE.prepare(
    `UPDATE credentials SET is_active = 1, updated_at = ?
     WHERE user_id = ? AND credential_type = 'agent-api-key'
       AND agent_type = ? AND credential_kind = ?`
  ).bind(now, userId, agentType, body.credentialKind);

  const batchResults = await c.env.DATABASE.batch([deactivateStmt, activateStmt]);
  const activateResult = batchResults[1];

  if (!activateResult?.meta.changes || activateResult.meta.changes === 0) {
    throw errors.notFound(`No ${body.credentialKind} found for ${agentType}`);
  }

  return c.json({ success: true, activated: body.credentialKind });
});

/**
 * DELETE /api/credentials/agent/:agentType/:credentialKind - Remove specific credential
 */
credentialsRoutes.delete('/agent/:agentType/:credentialKind', async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');
  const credentialKind = c.req.param('credentialKind') as CredentialKind;
  const db = drizzle(c.env.DATABASE, { schema });

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  if (!['api-key', 'oauth-token'].includes(credentialKind)) {
    throw errors.badRequest('Invalid credential kind');
  }

  // Check if this is the active credential
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType),
        eq(schema.credentials.credentialKind, credentialKind)
      )
    )
    .limit(1);

  const toDelete = existing[0];
  if (!toDelete) {
    throw errors.notFound('Credential not found');
  }

  // Delete the credential
  await db
    .delete(schema.credentials)
    .where(eq(schema.credentials.id, toDelete.id));

  // If it was active, auto-activate another credential if available
  if (toDelete.isActive) {
    const remaining = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, agentType)
        )
      )
      .limit(1);

    if (remaining.length > 0 && remaining[0]) {
      await db
        .update(schema.credentials)
        .set({ isActive: true, updatedAt: new Date().toISOString() })
        .where(eq(schema.credentials.id, remaining[0].id));
    }
  }

  return c.json({ success: true });
});

/**
 * DELETE /api/credentials/agent/:agentType - Remove all agent credentials
 */
credentialsRoutes.delete('/agent/:agentType', async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  const result = await db
    .delete(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType)
      )
    )
    .returning();

  if (result.length === 0) {
    throw errors.notFound('Agent credential');
  }

  return c.json({ success: true });
});

/**
 * Helper function to get a decrypted agent credential for internal use.
 * Returns the active credential (API key or OAuth token) and its type.
 */
export async function getDecryptedAgentKey(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string
): Promise<{ credential: string; credentialKind: CredentialKind } | null> {
  const creds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType),
        eq(schema.credentials.isActive, true)
      )
    )
    .limit(1);

  const foundCred = creds[0];
  if (!foundCred) {
    return null;
  }

  const credential = await decrypt(foundCred.encryptedToken, foundCred.iv, encryptionKey);
  return {
    credential,
    credentialKind: foundCred.credentialKind as CredentialKind,
  };
}

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
