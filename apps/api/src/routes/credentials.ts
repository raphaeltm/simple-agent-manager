// FILE SIZE EXCEPTION: Credential routes + CC resolver integration — splitting would break the tightly coupled resolution chain. See .claude/rules/18-file-size-limits.md
import type {
  AgentCredentialInfo,
  AgentType,
  CreateCredentialRequest,
  CredentialKind,
  CredentialProvider,
  CredentialResponse,
  CredentialSource,
  CredentialValidationStatus,
  Dialect,
} from '@simple-agent-manager/shared';
import {
  CREDENTIAL_PROVIDERS,
  DIALECT_VALUES,
  getAgentDefinition,
  isValidAgentType,
} from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { maskCredential } from '../lib/credential-mask';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { saveAgentCredentialForUser } from '../services/agent-credential-save';
import { rateLimitCredentialUpdate } from '../middleware/rate-limit';
import {
  CreateCredentialSchema,
  CredentialKindBodySchema,
  jsonValidator,
  SaveAgentCredentialSchema,
} from '../schemas';
import {
  disconnectAgentCredentialFromCC,
  syncAgentCredentialToCC,
} from '../services/composable-credentials/agent-sync';
import {
  disconnectComputeCredentialFromCC,
  syncComputeCredentialToCC,
} from '../services/composable-credentials/compute-sync';
import { lazyBackfillIfNeeded } from '../services/composable-credentials/lazy-backfill';
import { resolveForConsumer } from '../services/composable-credentials/resolve';
import { decrypt, encrypt } from '../services/encryption';
import { getTimeoutMs } from '../services/fetch-timeout';
import { deleteUserGcpCredential, replaceUserGcpCredential } from '../services/gcp-credential-store';
import { clearGcpAccessTokenCache } from '../services/gcp-sts';
import { getPlatformAgentCredential } from '../services/platform-credentials';
import {
  parseGcpCredential,
  serializeCredentialToken,
  toGcpCredentialMetadata,
} from '../services/provider-credentials';
import {
  CredentialValidator,
  formatOnlyValidation,
  validateAgentApiKeyCredentialWithProvider,
  validateHetznerCredentialWithProvider,
  validateScalewayCredentialWithProvider,
  validateVultrCredentialWithProvider,
} from '../services/validation';

const credentialsRoutes = new Hono<{ Bindings: Env }>();

interface CloudCredentialFields {
  providerName: CredentialProvider;
  tokenToValidate: string;
}

function getCloudCredentialFields(body: CreateCredentialRequest): CloudCredentialFields {
  const providerName = body.provider;

  if (!providerName) {
    throw errors.badRequest('Provider is required');
  }

  if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(providerName)) {
    throw errors.badRequest(
      `Unsupported provider: ${providerName}. Supported: ${CREDENTIAL_PROVIDERS.join(', ')}`
    );
  }

  if (providerName === 'hetzner') {
    if (!body.token) {
      throw errors.badRequest('Token is required for Hetzner');
    }
    return {
      providerName,
      tokenToValidate: serializeCredentialToken(providerName, { token: body.token }),
    };
  }

  if (providerName === 'scaleway') {
    if (!body.secretKey || !body.projectId) {
      throw errors.badRequest('secretKey and projectId are required for Scaleway');
    }
    return {
      providerName,
      tokenToValidate: serializeCredentialToken(providerName, {
        secretKey: body.secretKey,
        projectId: body.projectId,
      }),
    };
  }

  if (providerName === 'vultr') {
    if (!body.token) {
      throw errors.badRequest('Token is required for Vultr');
    }
    return {
      providerName,
      tokenToValidate: serializeCredentialToken(providerName, { token: body.token }),
    };
  }

  if (providerName === 'gcp') {
    if (
      !body.gcpProjectId ||
      !body.gcpProjectNumber ||
      !body.serviceAccountEmail ||
      !body.wifPoolId ||
      !body.wifProviderId ||
      !body.defaultZone
    ) {
      throw errors.badRequest(
        'gcpProjectId, gcpProjectNumber, serviceAccountEmail, wifPoolId, wifProviderId, and defaultZone are required for GCP'
      );
    }
    return {
      providerName,
      tokenToValidate: serializeCredentialToken(providerName, {
        gcpProjectId: body.gcpProjectId,
        gcpProjectNumber: body.gcpProjectNumber,
        serviceAccountEmail: body.serviceAccountEmail,
        wifPoolId: body.wifPoolId,
        wifProviderId: body.wifProviderId,
        defaultZone: body.defaultZone,
      }),
    };
  }

  throw errors.badRequest(`Unsupported provider: ${providerName}`);
}

const DEFAULT_SAVE_VALIDATION_TIMEOUT_MS = 8000;

function getSaveValidationTimeoutMs(env: Env): number {
  return getTimeoutMs(
    env.AGENT_CREDENTIAL_VALIDATION_TIMEOUT_MS,
    DEFAULT_SAVE_VALIDATION_TIMEOUT_MS
  );
}

async function validateCloudCredentialRequest(
  body: CreateCredentialRequest,
  env: Env
): Promise<CredentialValidationStatus> {
  if (body.provider === 'hetzner') {
    return validateHetznerCredentialWithProvider(body.token, {
      timeoutMs: getSaveValidationTimeoutMs(env),
    });
  }

  if (body.provider === 'scaleway') {
    return validateScalewayCredentialWithProvider(body.secretKey, body.projectId, {
      timeoutMs: getSaveValidationTimeoutMs(env),
    });
  }

  if (body.provider === 'vultr') {
    return validateVultrCredentialWithProvider(body.token, {
      timeoutMs: getSaveValidationTimeoutMs(env),
    });
  }

  return formatOnlyValidation(
    'GCP credential metadata accepted. Live validation runs during Google setup.'
  );
}

function rejectInvalidCredentialValidation(validation: CredentialValidationStatus): void {
  if (!validation.valid) {
    throw errors.badRequest(validation.error ?? validation.message);
  }
}

function logCredentialValidationWarning(
  scope: 'cloud' | 'agent',
  providerName: string,
  validation: CredentialValidationStatus
): void {
  if (validation.valid) return;
  log.warn('credentials.validation_warning', {
    scope,
    providerName,
    status: validation.status,
    error: validation.error ?? validation.message,
  });
}

function getAgentCredentialLabel(
  agentType: string,
  credentialKind: CredentialKind
): string | undefined {
  if (credentialKind !== 'oauth-token') return undefined;
  return agentType === 'openai-codex' ? 'Codex auth.json' : 'Pro/Max Subscription';
}

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
      encryptedToken: schema.credentials.encryptedToken,
      iv: schema.credentials.iv,
      createdAt: schema.credentials.createdAt,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        isNull(schema.credentials.projectId)
      )
    );

  const encryptionKey = getCredentialEncryptionKey(c.env);
  const response: CredentialResponse[] = await Promise.all(creds.map(async (cred) => {
    const base: CredentialResponse = {
      id: cred.id,
      provider: cred.provider as CredentialProvider,
      connected: true,
      createdAt: cred.createdAt,
    };
    if (cred.provider !== 'gcp') return base;
    try {
      const plaintext = await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
      return { ...base, gcp: toGcpCredentialMetadata(parseGcpCredential(plaintext)) };
    } catch (err) {
      log.error('credentials.gcp_metadata_unreadable', {
        credentialId: cred.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return base;
    }
  }));

  return c.json(response);
});

/**
 * POST /api/credentials/validate - Validate a cloud-provider credential without saving it
 */
credentialsRoutes.post('/validate', jsonValidator(CreateCredentialSchema), async (c) => {
  const body = c.req.valid('json');
  const { providerName } = getCloudCredentialFields(body);
  const validation = await validateCloudCredentialRequest(body, c.env);
  rejectInvalidCredentialValidation(validation);

  return c.json({
    provider: providerName,
    ...validation,
  });
});

/**
 * POST /api/credentials - Create or update a credential
 */
credentialsRoutes.post('/', jsonValidator(CreateCredentialSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const requestBody = c.req.valid('json');
  const { providerName, tokenToValidate: tokenToEncrypt } = getCloudCredentialFields(requestBody);
  const validation = await validateCloudCredentialRequest(requestBody, c.env);
  logCredentialValidationWarning('cloud', providerName, validation);

  if (providerName === 'gcp') {
    const credential = parseGcpCredential(tokenToEncrypt);
    const [existing] = await db
      .select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'gcp'),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        isNull(schema.credentials.projectId),
      ))
      .limit(1);
    const stored = await replaceUserGcpCredential(c.env, userId, credential);
    const response: CredentialResponse = {
      id: stored.id,
      provider: 'gcp',
      connected: true,
      createdAt: stored.createdAt,
      validation,
      gcp: toGcpCredentialMetadata(credential),
    };
    return existing ? c.json(response) : c.json(response, 201);
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
        eq(schema.credentials.credentialType, 'cloud-provider'),
        isNull(schema.credentials.projectId)
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

    await syncComputeCredentialToCC(c.env.DATABASE, {
      userId,
      provider: providerName,
      encryptedToken: ciphertext,
      iv,
    });

    const response: CredentialResponse = {
      id: existingCred.id,
      provider: providerName,
      connected: true,
      createdAt: existingCred.createdAt,
      validation,
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

  await syncComputeCredentialToCC(c.env.DATABASE, {
    userId,
    provider: providerName,
    encryptedToken: ciphertext,
    iv,
  });

  const response: CredentialResponse = {
    id,
    provider: providerName,
    connected: true,
    createdAt: now,
    validation,
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

  if (provider === 'gcp') {
    const [stored] = await db
      .select({ encryptedToken: schema.credentials.encryptedToken, iv: schema.credentials.iv })
      .from(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'gcp'),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        isNull(schema.credentials.projectId),
      ))
      .limit(1);
    if (!stored) throw errors.notFound('Credential');

    let credential;
    try {
      const plaintext = await decrypt(
        stored.encryptedToken,
        stored.iv,
        getCredentialEncryptionKey(c.env),
      );
      credential = parseGcpCredential(plaintext);
    } catch (err) {
      log.error('credentials.gcp_disconnect_parse_failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await deleteUserGcpCredential(c.env, userId);
    if (credential) {
      try {
        await clearGcpAccessTokenCache(c.env, userId, credential);
      } catch (err) {
        log.warn('credentials.gcp_disconnect_cache_cleanup_failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return c.json({ success: true });
  }

  const result = await db
    .delete(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, provider),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        isNull(schema.credentials.projectId)
      )
    )
    .returning();

  if (result.length === 0) {
    throw errors.notFound('Credential');
  }

  if ((CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) {
    await disconnectComputeCredentialFromCC(c.env.DATABASE, {
      userId,
      provider: provider as CredentialProvider,
    });
  }

  return c.json({ success: true });
});

// =============================================================================
// Agent API Key Endpoints
// =============================================================================

/**
 * POST /api/credentials/agent/validate - Validate an agent credential without saving it
 */
credentialsRoutes.post('/agent/validate', jsonValidator(SaveAgentCredentialSchema), async (c) => {
  const body = c.req.valid('json');
  const credentialKind = body.credentialKind || 'api-key';

  if (!isValidAgentType(body.agentType)) {
    throw errors.badRequest('Invalid agent type');
  }

  const agentDef = getAgentDefinition(body.agentType);
  if (!agentDef) {
    throw errors.badRequest('Unknown agent type');
  }

  const validation = CredentialValidator.validateCredential(
    body.credential,
    credentialKind,
    body.agentType
  );
  if (!validation.valid) {
    throw errors.badRequest(validation.error || 'Invalid credential format');
  }

  if (credentialKind === 'oauth-token') {
    if (!agentDef.oauthSupport) {
      throw errors.badRequest(`OAuth tokens are not supported for ${agentDef.name}`);
    }
    return c.json({
      valid: true,
      agentType: body.agentType,
      validationMode: 'format',
      message: `${agentDef.name} OAuth credential format looks valid.`,
    });
  }

  const result = await validateAgentApiKeyCredentialWithProvider(body.agentType, body.credential, {
    timeoutMs: getSaveValidationTimeoutMs(c.env),
  });
  rejectInvalidCredentialValidation(result);
  return c.json({ agentType: body.agentType, ...result });
});

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
        // Decrypt to get last 4 chars for masking (guards short credentials via maskCredential)
        const plaintext = await decrypt(
          cred.encryptedToken,
          cred.iv,
          getCredentialEncryptionKey(c.env)
        );
        const maskedKey = maskCredential(plaintext);

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
 *
 * Rate-limited per-user (default 30/hour via rateLimitCredentialUpdate) to prevent
 * an authenticated user from spamming encrypt+write operations.
 */
credentialsRoutes.put(
  '/agent',
  (c, next) => rateLimitCredentialUpdate(c.env)(c, next),
  jsonValidator(SaveAgentCredentialSchema),
  async (c) => {
    const userId = getUserId(c);

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
    const validation = CredentialValidator.validateCredential(
      credential,
      credentialKind,
      body.agentType
    );
    if (!validation.valid) {
      throw errors.badRequest(validation.error || 'Invalid credential format');
    }

    // Check if OAuth is supported for this agent
    if (credentialKind === 'oauth-token' && !agentDef.oauthSupport) {
      throw errors.badRequest(`OAuth tokens are not supported for ${agentDef.name}`);
    }

    const providerValidation =
      credentialKind === 'api-key'
        ? await validateAgentApiKeyCredentialWithProvider(body.agentType, credential, {
            timeoutMs: getSaveValidationTimeoutMs(c.env),
          })
        : formatOnlyValidation(`${agentDef.name} OAuth credential format looks valid.`);
    logCredentialValidationWarning('agent', agentDef.provider, providerValidation);

    // Encrypt + persist (legacy credentials + cc_* dual-write) through the shared
    // single-writer service — also used by the project-scoped route and the guided
    // setup-terminal capture path, so all writers keep the two credential
    // representations in sync (rule 44).
    const saveResult = await saveAgentCredentialForUser({
      env: c.env,
      userId,
      agentType: body.agentType,
      credentialKind,
      credential,
      provider: agentDef.provider,
      agentName: agentDef.name,
      autoActivate,
    });

    const maskedKey = maskCredential(credential);
    const response: AgentCredentialInfo = {
      agentType: body.agentType,
      provider: agentDef.provider,
      credentialKind,
      isActive: autoActivate,
      maskedKey,
      validation: providerValidation,
      label: getAgentCredentialLabel(body.agentType, credentialKind),
      createdAt: saveResult.createdAt,
      updatedAt: saveResult.updatedAt,
    };

    return c.json(response, saveResult.created ? 201 : 200);
  }
);

/**
 * POST /api/credentials/agent/:agentType/toggle - Toggle active credential
 *
 * Uses D1 batch to atomically deactivate all credentials then activate the
 * target, preventing race conditions where concurrent requests could leave
 * multiple credentials active or none active.
 */
credentialsRoutes.post(
  '/agent/:agentType/toggle',
  jsonValidator(CredentialKindBodySchema),
  async (c) => {
    const userId = getUserId(c);
    const agentType = c.req.param('agentType');
    const db = drizzle(c.env.DATABASE, { schema });

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

    const agentDef = getAgentDefinition(agentType);
    if (agentDef) {
      const [activated] = await db
        .select()
        .from(schema.credentials)
        .where(
          and(
            eq(schema.credentials.userId, userId),
            isNull(schema.credentials.projectId),
            eq(schema.credentials.credentialType, 'agent-api-key'),
            eq(schema.credentials.agentType, agentType),
            eq(schema.credentials.credentialKind, body.credentialKind),
            eq(schema.credentials.isActive, true)
          )
        )
        .limit(1);

      if (activated) {
        await syncAgentCredentialToCC(c.env.DATABASE, {
          userId,
          agentType,
          credentialKind: body.credentialKind,
          encryptedToken: activated.encryptedToken,
          iv: activated.iv,
          agentName: agentDef.name,
          isActive: true,
        });
      }
    }

    return c.json({ success: true, activated: body.credentialKind });
  }
);

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
    await disconnectAgentCredentialFromCC(c.env.DATABASE, {
      userId,
      agentType,
      credentialKind,
    });
    return c.json({ success: true, disconnected: true });
  }

  // Delete the credential
  await db.delete(schema.credentials).where(eq(schema.credentials.id, toDelete.id));

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

      const agentDef = getAgentDefinition(agentType);
      if (agentDef && remaining[0].credentialKind) {
        await syncAgentCredentialToCC(c.env.DATABASE, {
          userId,
          agentType,
          credentialKind: remaining[0].credentialKind as CredentialKind,
          encryptedToken: remaining[0].encryptedToken,
          iv: remaining[0].iv,
          agentName: agentDef.name,
          isActive: true,
        });
      }
    } else {
      await disconnectAgentCredentialFromCC(c.env.DATABASE, { userId, agentType });
    }
  } else {
    await disconnectAgentCredentialFromCC(c.env.DATABASE, {
      userId,
      agentType,
      credentialKind,
    });
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

  await disconnectAgentCredentialFromCC(c.env.DATABASE, { userId, agentType });

  return c.json({ success: true });
});

/**
 * Helper function to get a decrypted agent credential for internal use.
 * Returns the active credential (API key or OAuth token) and its type.
 *
 * Resolution order (composable-credentials PRIMARY, old path FALLBACK):
 *   1. CC resolver: project-attachment → user-attachment → platform default
 *   2. If cc_* tables are empty for user, lazy-backfill from legacy tables, retry
 *   3. If CC still returns null, fall back to legacy single-table lookup
 *
 * Rule 28: an inactive project-scoped attachment halts resolution.
 */
export async function getDecryptedAgentKey(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null
): Promise<{
  credential: string;
  credentialKind: CredentialKind;
  credentialSource: CredentialSource;
  baseUrl?: string;
  providerDialect?: Dialect;
} | null> {
  // --- Primary path: composable-credentials resolver -------------------------
  const ccResult = await resolveAgentKeyViaCC(db, userId, agentType, encryptionKey, projectId);
  if (ccResult !== undefined) return ccResult;

  // --- Fallback: legacy single-table lookup ----------------------------------
  return resolveAgentKeyLegacy(db, userId, agentType, encryptionKey, projectId);
}

/**
 * Try composable-credentials resolution with lazy backfill.
 * Returns:
 *   - the resolved credential (or null for Rule 28 halt) when CC has data
 *   - `undefined` when CC has no data and fallback should be attempted
 */
async function resolveAgentKeyViaCC(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null
): Promise<
  | {
      credential: string;
      credentialKind: CredentialKind;
      credentialSource: CredentialSource;
      baseUrl?: string;
      providerDialect?: Dialect;
    }
  | null
  | undefined
> {
  const consumer = { kind: 'agent' as const, agentType };

  // First attempt with current cc_* data
  let resolved = await resolveForConsumer(db, userId, encryptionKey, consumer, projectId);

  // A platform-tier first resolution must NOT pre-empt lazy backfill + the user's own
  // (higher-precedence) credentials. If the user's agent credential still lives only in the
  // legacy tables and a matching ENABLED platform default exists, the first resolve returns
  // the platform default (Tier 3) and the original `if (!resolved)` guard skipped backfill —
  // leaving cc_* empty, skipping the legacy fallback, and 404ing the user's own credential at
  // the VM agent for non-'sam' provider modes. Treat a platform-only hit like a miss: backfill
  // migrates the user's legacy credential into a Tier 1/2 attachment that out-precedes the
  // platform default on re-resolution.
  const platformOnly =
    resolved !== null && (resolved.source === 'platform' || resolved.source === 'platform-proxy');

  if (!resolved || platformOnly) {
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    if (didBackfill) {
      const reResolved = await resolveForConsumer(db, userId, encryptionKey, consumer, projectId);
      if (platformOnly) {
        // cc_* is now authoritative for this user. Commit to the re-resolved result —
        // including a Rule 28 null halt (inactive project attachment) — rather than the
        // platform default we started with. Do not fall back to legacy after backfill.
        return reResolved ? mapResolvedToLegacy(reResolved) : null;
      }
      // First resolution was a genuine miss — preserve original null-path semantics.
      resolved = reResolved;
    } else if (!resolved) {
      // cc_* tables already had data but no match — this is a definitive "no credential"
      // from the CC model. However, the user may have legacy data that wasn't backfilled
      // for this specific consumer (e.g. cloud-provider credentials used as agent fallback).
      // Let the legacy path handle those edge cases.
      return undefined;
    }
    // else: platformOnly && !didBackfill — cc_* already reflects this user, so the platform
    // default is authoritative. Fall through and return it.
  }

  if (!resolved) return undefined;

  return mapResolvedToLegacy(resolved);
}

/**
 * Map a CC ResolvedEnvironment to the legacy getDecryptedAgentKey return shape.
 */
function mapResolvedToLegacy(
  resolved: NonNullable<Awaited<ReturnType<typeof resolveForConsumer>>>
): {
  credential: string;
  credentialKind: CredentialKind;
  credentialSource: CredentialSource;
  baseUrl?: string;
  providerDialect?: Dialect;
} | null {
  // Platform proxy — no raw credential to return
  if (resolved.source === 'platform-proxy' || !resolved.credential) {
    return null;
  }

  const secret = resolved.credential.secret;
  let credential = '';
  let credentialKind: CredentialKind = 'api-key';

  switch (secret.kind) {
    case 'api-key':
      credential = secret.apiKey;
      credentialKind = 'api-key';
      break;
    case 'oauth-token':
      credential = secret.token;
      credentialKind = 'oauth-token';
      break;
    case 'auth-json':
      credential = secret.authJson;
      if (resolved.consumer.kind !== 'agent' || resolved.consumer.agentType !== 'openai-codex') {
        return null;
      }
      // auth-json is a file-style credential (Codex ~/.codex/auth.json), so
      // preserve the VM agent's auth-file injection path rather than treating
      // the JSON blob as an API key env var.
      credentialKind = 'oauth-token';
      break;
    case 'openai-compatible':
      credential = secret.apiKey;
      credentialKind = 'api-key';
      break;
    case 'cloud-provider':
      // Agent consumers should not receive cloud-provider secrets
      return null;
  }

  const credentialSource = mapSourceToLegacy(resolved.source);
  const settings = resolved.configuration?.settings ?? {};
  const settingsBaseUrl = typeof settings.baseUrl === 'string' && settings.baseUrl.trim() !== ''
    ? settings.baseUrl.trim()
    : undefined;
  const providerDialect = readProviderDialect(settings.dialect)
    ?? (secret.kind === 'openai-compatible' ? 'openai-compatible' : undefined);
  const baseUrl = settingsBaseUrl
    ?? (secret.kind === 'openai-compatible' && secret.baseUrl ? secret.baseUrl : undefined);

  return {
    credential,
    credentialKind,
    credentialSource,
    ...(baseUrl ? { baseUrl } : {}),
    ...(providerDialect ? { providerDialect } : {}),
  };
}

function readProviderDialect(value: unknown): Dialect | undefined {
  return typeof value === 'string' && (DIALECT_VALUES as readonly string[]).includes(value)
    ? value as Dialect
    : undefined;
}

function mapSourceToLegacy(source: string): CredentialSource {
  switch (source) {
    case 'project-attachment':
      return 'project';
    case 'user-attachment':
      return 'user';
    default:
      return 'platform';
  }
}

/**
 * Legacy single-table credential resolution (fallback when CC has no data).
 * Preserves the original Rule 28 invariant.
 */
async function resolveAgentKeyLegacy(
  db: ReturnType<typeof drizzle>,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId?: string | null
): Promise<{
  credential: string;
  credentialKind: CredentialKind;
  credentialSource: CredentialSource;
} | null> {
  // 1. Project-scoped credential (Rule 28: inactive blocks fallthrough)
  if (projectId) {
    const projectCreds = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.projectId, projectId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, agentType)
        )
      )
      .limit(1);

    const projectCred = projectCreds[0];
    if (projectCred) {
      if (projectCred.isActive) {
        const credential = await decrypt(projectCred.encryptedToken, projectCred.iv, encryptionKey);
        return {
          credential,
          credentialKind: projectCred.credentialKind as CredentialKind,
          credentialSource: 'project',
        };
      }
      return null;
    }
  }

  // 2. User-scoped credential
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

  // 3. Platform credential
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
