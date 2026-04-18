import { createProvider } from '@simple-agent-manager/providers';
import type { AgentCredentialInfo, AgentType, CredentialKind, CredentialProvider, CredentialResponse, CredentialSource } from '@simple-agent-manager/shared';
import { CREDENTIAL_PROVIDERS, getAgentDefinition, isValidAgentType } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { getUserId,requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { CreateCredentialSchema, CredentialKindBodySchema,jsonValidator, SaveAgentCredentialSchema } from '../schemas';
import { decrypt, encrypt } from '../services/encryption';
import { getPlatformAgentCredential } from '../services/platform-credentials';
import { buildProviderConfig, serializeCredentialToken } from '../services/provider-credentials';
import { CredentialValidator } from '../services/validation';

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
    provider: cred.provider as CredentialProvider,
    connected: true,
    createdAt: cred.createdAt,
  }));

  return c.json(response);
});

/**
 * POST /api/credentials - Create or update a credential
 */
credentialsRoutes.post('/', jsonValidator(CreateCredentialSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = c.req.valid('json');
  const providerName = body.provider;

  // Validate required fields per provider
  if (!providerName) {
    throw errors.badRequest('Provider is required');
  }

  if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(providerName)) {
    throw errors.badRequest(`Unsupported provider: ${providerName}. Supported: ${CREDENTIAL_PROVIDERS.join(', ')}`);
  }

  // Extract and serialize the credential token based on provider type
  let credentialFields: Record<string, string>;
  if (providerName === 'hetzner') {
    const hetznerBody = body as { provider: 'hetzner'; token: string };
    if (!hetznerBody.token) {
      throw errors.badRequest('Token is required for Hetzner');
    }
    credentialFields = { token: hetznerBody.token };
  } else if (providerName === 'scaleway') {
    const scalewayBody = body as { provider: 'scaleway'; secretKey: string; projectId: string };
    if (!scalewayBody.secretKey || !scalewayBody.projectId) {
      throw errors.badRequest('secretKey and projectId are required for Scaleway');
    }
    credentialFields = { secretKey: scalewayBody.secretKey, projectId: scalewayBody.projectId };
  } else if (providerName === 'gcp') {
    // GCP credentials are created via the /api/gcp/setup flow, not directly via POST /api/credentials.
    // This branch handles programmatic credential creation (e.g., for testing or migration).
    const gcpBody = body as { provider: 'gcp'; gcpProjectId: string; gcpProjectNumber: string; serviceAccountEmail: string; wifPoolId: string; wifProviderId: string; defaultZone: string };
    if (!gcpBody.gcpProjectId || !gcpBody.gcpProjectNumber || !gcpBody.serviceAccountEmail || !gcpBody.wifPoolId || !gcpBody.wifProviderId || !gcpBody.defaultZone) {
      throw errors.badRequest('gcpProjectId, gcpProjectNumber, serviceAccountEmail, wifPoolId, wifProviderId, and defaultZone are required for GCP');
    }
    credentialFields = {
      gcpProjectId: gcpBody.gcpProjectId,
      gcpProjectNumber: gcpBody.gcpProjectNumber,
      serviceAccountEmail: gcpBody.serviceAccountEmail,
      wifPoolId: gcpBody.wifPoolId,
      wifProviderId: gcpBody.wifProviderId,
      defaultZone: gcpBody.defaultZone,
    };
  } else {
    throw errors.badRequest(`Unsupported provider: ${providerName}`);
  }

  const tokenToEncrypt = serializeCredentialToken(providerName, credentialFields);

  // Validate the credentials by building a ProviderConfig and calling validateToken().
  // GCP credentials are metadata (not API tokens) — validation is done during /api/gcp/setup.
  // Note: buildProviderConfig accepts the pre-encryption serialized token here — this is
  // safe because serialize → build is a documented round-trip (see provider-credentials tests).
  if (providerName !== 'gcp') {
    try {
      const providerConfig = buildProviderConfig(providerName, tokenToEncrypt);
      const provider = createProvider(providerConfig);
      await provider.validateToken();
    } catch (err) {
      log.error('credentials.validation_failed', { providerName, error: err instanceof Error ? err.message : String(err) });
      throw errors.badRequest(`Invalid or unauthorized ${providerName} credentials`);
    }
  }

  // Encrypt the serialized credential token
  const { ciphertext, iv } = await encrypt(tokenToEncrypt, getCredentialEncryptionKey(c.env));

  // Check if credential already exists for this provider
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, providerName),
        eq(schema.credentials.credentialType, 'cloud-provider')
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  const existingCred = existing[0];
  if (existingCred) {
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
      provider: providerName,
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
    provider: providerName,
    credentialType: 'cloud-provider',
    encryptedToken: ciphertext,
    iv,
    createdAt: now,
    updatedAt: now,
  });

  const response: CredentialResponse = {
    id,
    provider: providerName,
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
        eq(schema.credentials.provider, provider),
        eq(schema.credentials.credentialType, 'cloud-provider')
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
        isNull(schema.credentials.projectId),
        eq(schema.credentials.credentialType, 'agent-api-key')
      )
    );

  const credentials: AgentCredentialInfo[] = await Promise.all(
    creds
      .filter((cred) => cred.agentType != null)
      .map(async (cred) => {
        // Decrypt to get last 4 chars for masking
        const plaintext = await decrypt(cred.encryptedToken, cred.iv, getCredentialEncryptionKey(c.env));
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
credentialsRoutes.put('/agent', jsonValidator(SaveAgentCredentialSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const body = c.req.valid('json');

  const credential = body.credential;
  const credentialKind = body.credentialKind || 'api-key';
  const autoActivate = body.autoActivate !== false; // Default true

  if (!isValidAgentType(body.agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  const agentDef = getAgentDefinition(body.agentType);
  if (!agentDef) {
    throw errors.badRequest('Unknown agent type');
  }

  // Validate credential format (agent-aware for OpenAI Codex auth.json)
  const validation = CredentialValidator.validateCredential(credential, credentialKind, body.agentType);
  if (!validation.valid) {
    throw errors.badRequest(validation.error || 'Invalid credential format');
  }

  // Check if OAuth is supported for this agent
  if (credentialKind === 'oauth-token' && !agentDef.oauthSupport) {
    throw errors.badRequest(`OAuth tokens are not supported for ${agentDef.name}`);
  }

  // Encrypt the credential
  const { ciphertext, iv } = await encrypt(credential, getCredentialEncryptionKey(c.env));

  // Check if a credential of this type already exists (user-scoped only — project_id IS NULL)
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        isNull(schema.credentials.projectId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, body.agentType),
        eq(schema.credentials.credentialKind, credentialKind)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  // If auto-activating, deactivate other user-scoped credentials for this agent.
  // Project-scoped rows (project_id IS NOT NULL) are deliberately untouched to preserve
  // per-project overrides.
  if (autoActivate) {
    await db
      .update(schema.credentials)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.credentials.userId, userId),
          isNull(schema.credentials.projectId),
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
credentialsRoutes.post('/agent/:agentType/toggle', jsonValidator(CredentialKindBodySchema), async (c) => {
  const userId = getUserId(c);
  const agentType = c.req.param('agentType');

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  const body = c.req.valid('json');

  const now = new Date().toISOString();

  // Use D1 batch for atomic multi-statement execution.
  // Both statements execute in a single implicit transaction,
  // preventing race conditions between deactivate and activate.
  // Scope guards (project_id IS NULL) prevent toggling user-scoped credentials from
  // touching project-scoped overrides.
  const deactivateStmt = c.env.DATABASE.prepare(
    `UPDATE credentials SET is_active = 0
     WHERE user_id = ? AND project_id IS NULL
       AND credential_type = 'agent-api-key' AND agent_type = ?`
  ).bind(userId, agentType);

  const activateStmt = c.env.DATABASE.prepare(
    `UPDATE credentials SET is_active = 1, updated_at = ?
     WHERE user_id = ? AND project_id IS NULL
       AND credential_type = 'agent-api-key'
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

  // Check if this is the active credential (user-scoped only — project_id IS NULL)
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        isNull(schema.credentials.projectId),
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

  // If it was active, auto-activate another user-scoped credential (not project-scoped)
  if (toDelete.isActive) {
    const remaining = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          isNull(schema.credentials.projectId),
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

  // User-scoped only — does not cascade-delete project-scoped overrides.
  const result = await db
    .delete(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        isNull(schema.credentials.projectId),
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
 *
 * Resolution order:
 *   1. Project-scoped credential (when projectId is provided)
 *   2. User-scoped credential
 *   3. Platform credential
 */
export async function getDecryptedAgentKey(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null
): Promise<{ credential: string; credentialKind: CredentialKind; credentialSource: CredentialSource } | null> {
  // 1. Try project-scoped credential first (most specific)
  if (projectId) {
    const projectCreds = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.projectId, projectId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, agentType),
          eq(schema.credentials.isActive, true)
        )
      )
      .limit(1);

    const projectCred = projectCreds[0];
    if (projectCred) {
      const credential = await decrypt(projectCred.encryptedToken, projectCred.iv, encryptionKey);
      return {
        credential,
        credentialKind: projectCred.credentialKind as CredentialKind,
        credentialSource: 'project',
      };
    }
  }

  // 2. Fall back to user-scoped credential (project_id IS NULL)
  const userCreds = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        isNull(schema.credentials.projectId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType),
        eq(schema.credentials.isActive, true)
      )
    )
    .limit(1);

  const foundCred = userCreds[0];
  if (foundCred) {
    const credential = await decrypt(foundCred.encryptedToken, foundCred.iv, encryptionKey);
    return {
      credential,
      credentialKind: foundCred.credentialKind as CredentialKind,
      credentialSource: 'user',
    };
  }

  // 3. Fall back to platform credential
  const platformCred = await getPlatformAgentCredential(db, agentType, encryptionKey);
  if (platformCred) {
    return {
      credential: platformCred.credential,
      credentialKind: platformCred.credentialKind as CredentialKind,
      credentialSource: 'platform',
    };
  }

  return null;
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
        eq(schema.credentials.provider, provider),
        eq(schema.credentials.credentialType, 'cloud-provider')
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
