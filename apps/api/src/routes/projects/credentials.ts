/**
 * Project-scoped agent credentials (Phase 2 of multi-level config override system).
 *
 * Allows users to override user-level agent credentials (API keys and OAuth tokens)
 * on a per-project basis. Resolution order when a task runs:
 *
 *   1. Project-scoped credential (this file manages these)
 *   2. User-scoped credential (existing /api/credentials/agent)
 *   3. Platform credential
 *
 * Project membership/capabilities gate access, while credential rows remain
 * caller-scoped so members cannot read or modify another user's credential.
 */
import type {
  AgentCredentialInfo,
  AgentType,
  CreateCredentialRequest,
  CredentialKind,
  CredentialProvider,
  CredentialResponse,
  CredentialValidationStatus,
} from '@simple-agent-manager/shared';
import {
  CREDENTIAL_PROVIDERS,
  getAgentDefinition,
  isValidAgentType,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { maskCredential } from '../../lib/credential-mask';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { rateLimitCredentialUpdate } from '../../middleware/rate-limit';
import { CreateCredentialSchema, jsonValidator, SaveAgentCredentialSchema } from '../../schemas';
import { saveAgentCredentialForUser } from '../../services/agent-credential-save';
import { disconnectAgentCredentialFromCC } from '../../services/composable-credentials/agent-sync';
import {
  disconnectComputeCredentialFromCC,
  syncComputeCredentialToCC,
} from '../../services/composable-credentials/compute-sync';
import { decrypt, encrypt } from '../../services/encryption';
import { getTimeoutMs } from '../../services/fetch-timeout';
import { serializeCredentialToken } from '../../services/provider-credentials';
import {
  CredentialValidator,
  formatOnlyValidation,
  validateHetznerCredentialWithProvider,
  validateScalewayCredentialWithProvider,
  validateVultrCredentialWithProvider,
} from '../../services/validation';

const projectCredentialsRoutes = new Hono<{ Bindings: Env }>();

// Defence-in-depth: apply auth on the sub-router as well, so it remains safe
// if mounted independently (e.g., test harness). Parent `projectsRoutes` also
// applies these, but duplicated middleware is idempotent.
projectCredentialsRoutes.use('/*', requireAuth(), requireApproved());

function getAgentCredentialLabel(
  agentType: string,
  credentialKind: CredentialKind
): string | undefined {
  if (credentialKind !== 'oauth-token') return undefined;
  return agentType === 'openai-codex' ? 'Codex auth.json' : 'Pro/Max Subscription';
}

interface CloudCredentialFields {
  providerName: CredentialProvider;
  tokenToValidate: string;
}

function getCloudCredentialFields(body: CreateCredentialRequest): CloudCredentialFields {
  const providerName = body.provider;
  if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(providerName)) {
    throw errors.badRequest(
      `Unsupported provider: ${providerName}. Supported: ${CREDENTIAL_PROVIDERS.join(', ')}`
    );
  }

  if (providerName === 'hetzner') {
    if (!body.token) throw errors.badRequest('Token is required for Hetzner');
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
    if (!body.token) throw errors.badRequest('Token is required for Vultr');
    return {
      providerName,
      tokenToValidate: serializeCredentialToken(providerName, { token: body.token }),
    };
  }

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

/**
 * GET /api/projects/:id/credentials — list agent credentials scoped to this project.
 * Returns masked credentials with scope === 'project'.
 */
projectCredentialsRoutes.get('/:id/credentials', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:read');

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
        eq(schema.credentials.projectId, projectId),
        eq(schema.credentials.credentialType, 'agent-api-key')
      )
    );

  const credentials: AgentCredentialInfo[] = await Promise.all(
    creds
      .filter((cred) => cred.agentType != null)
      .map(async (cred) => {
        const plaintext = await decrypt(
          cred.encryptedToken,
          cred.iv,
          getCredentialEncryptionKey(c.env)
        );
        const maskedKey = maskCredential(plaintext);
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
          label:
            getAgentCredentialLabel(
              cred.agentType as AgentType,
              cred.credentialKind as CredentialKind
            ) ?? label,
          createdAt: cred.createdAt,
          updatedAt: cred.updatedAt,
          scope: 'project' as const,
          projectId,
        };
      })
  );

  return c.json({ credentials });
});

/**
 * PUT /api/projects/:id/cloud-credentials — save or update a project-scoped
 * cloud-provider credential override.
 */
projectCredentialsRoutes.put(
  '/:id/cloud-credentials',
  (c, next) => rateLimitCredentialUpdate(c.env)(c, next),
  jsonValidator(CreateCredentialSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'secret:write');

    const requestBody = c.req.valid('json');
    const { providerName, tokenToValidate: tokenToEncrypt } =
      getCloudCredentialFields(requestBody);
    const validation = await validateCloudCredentialRequest(requestBody, c.env);
    const { ciphertext, iv } = await encrypt(tokenToEncrypt, getCredentialEncryptionKey(c.env));

    const existing = await db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.projectId, projectId),
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
        .set({ encryptedToken: ciphertext, iv, isActive: true, updatedAt: now })
        .where(eq(schema.credentials.id, existingCred.id));

      await syncComputeCredentialToCC(c.env.DATABASE, {
        userId,
        projectId,
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

    const id = ulid();
    await db.insert(schema.credentials).values({
      id,
      userId,
      projectId,
      provider: providerName,
      credentialType: 'cloud-provider',
      isActive: true,
      encryptedToken: ciphertext,
      iv,
      createdAt: now,
      updatedAt: now,
    });

    await syncComputeCredentialToCC(c.env.DATABASE, {
      userId,
      projectId,
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
  }
);

/**
 * DELETE /api/projects/:id/cloud-credentials/:provider — remove a project
 * cloud-provider override. Missing legacy rows still disconnect CC-only rows.
 */
projectCredentialsRoutes.delete('/:id/cloud-credentials/:provider', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const provider = c.req.param('provider');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:write');

  if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) {
    throw errors.badRequest(
      `Unsupported provider: ${provider}. Supported: ${CREDENTIAL_PROVIDERS.join(', ')}`
    );
  }

  const providerName = provider as CredentialProvider;
  await db
    .delete(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.projectId, projectId),
        eq(schema.credentials.provider, providerName),
        eq(schema.credentials.credentialType, 'cloud-provider')
      )
    )
    .returning();

  await disconnectComputeCredentialFromCC(c.env.DATABASE, {
    userId,
    projectId,
    provider: providerName,
  });

  return c.json({ success: true });
});

/**
 * PUT /api/projects/:id/credentials — save or update a project-scoped agent credential.
 *
 * Rate-limited per-user (default 30/hour via rateLimitCredentialUpdate) to match the
 * user-scoped PUT protection — prevents spam encrypt+write operations (MEDIUM #7).
 */
projectCredentialsRoutes.put(
  '/:id/credentials',
  (c, next) => rateLimitCredentialUpdate(c.env)(c, next),
  jsonValidator(SaveAgentCredentialSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'secret:write');

    const body = c.req.valid('json');
    const credential = body.credential;
    const credentialKind = body.credentialKind || 'api-key';
    const autoActivate = body.autoActivate !== false;

    if (!isValidAgentType(body.agentType)) {
      throw errors.badRequest('Invalid agent type');
    }
    const agentDef = getAgentDefinition(body.agentType);
    if (!agentDef) {
      throw errors.badRequest('Unknown agent type');
    }

    const validation = CredentialValidator.validateCredential(
      credential,
      credentialKind,
      body.agentType
    );
    if (!validation.valid) {
      throw errors.badRequest(validation.error || 'Invalid credential format');
    }
    if (credentialKind === 'oauth-token' && !agentDef.oauthSupport) {
      throw errors.badRequest(`OAuth tokens are not supported for ${agentDef.name}`);
    }

    // Encrypt + persist (legacy credentials + cc_* dual-write) through the shared
    // single-writer service (rule 44) — same writer as the user-scoped route and
    // the guided setup-terminal capture path.
    const saveResult = await saveAgentCredentialForUser({
      env: c.env,
      userId,
      projectId,
      agentType: body.agentType,
      credentialKind,
      credential,
      provider: agentDef.provider,
      agentName: agentDef.name,
      autoActivate,
    });

    // Derive mask from the plaintext that was just encrypted — matches GET/list which
    // masks from decrypted plaintext (LOW #9 consistency).
    const maskedKey = maskCredential(credential);
    const response: AgentCredentialInfo = {
      agentType: body.agentType,
      provider: agentDef.provider,
      credentialKind,
      isActive: autoActivate,
      maskedKey,
      label: getAgentCredentialLabel(body.agentType, credentialKind),
      createdAt: saveResult.createdAt,
      updatedAt: saveResult.updatedAt,
      scope: 'project',
      projectId,
    };
    return c.json(response, saveResult.created ? 201 : 200);
  }
);

/**
 * DELETE /api/projects/:id/credentials/:agentType/:credentialKind — remove a project-scoped credential.
 */
projectCredentialsRoutes.delete('/:id/credentials/:agentType/:credentialKind', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const agentType = c.req.param('agentType');
  const credentialKind = c.req.param('credentialKind') as CredentialKind;
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:write');

  if (!isValidAgentType(agentType)) {
    throw errors.badRequest('Invalid agent type');
  }
  if (!['api-key', 'oauth-token'].includes(credentialKind)) {
    throw errors.badRequest('Invalid credential kind');
  }

  const result = await db
    .delete(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.projectId, projectId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, agentType),
        eq(schema.credentials.credentialKind, credentialKind)
      )
    )
    .returning();

  if (result.length === 0) {
    await disconnectAgentCredentialFromCC(c.env.DATABASE, {
      userId,
      projectId,
      agentType,
      credentialKind,
    });
    return c.json({ success: true, disconnected: true });
  }

  const deleted = result[0];
  if (!deleted || deleted.isActive) {
    await disconnectAgentCredentialFromCC(c.env.DATABASE, {
      userId,
      projectId,
      agentType,
    });
  } else {
    await disconnectAgentCredentialFromCC(c.env.DATABASE, {
      userId,
      projectId,
      agentType,
      credentialKind,
    });
  }

  return c.json({ success: true });
});

export { projectCredentialsRoutes };
