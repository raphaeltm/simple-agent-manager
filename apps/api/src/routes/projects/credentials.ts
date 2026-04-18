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
 * Ownership is enforced via `requireOwnedProject` — users cannot see or modify
 * credentials attached to projects they do not own.
 */
import type { AgentCredentialInfo, AgentType, CredentialKind } from '@simple-agent-manager/shared';
import { getAgentDefinition, isValidAgentType } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { jsonValidator, SaveAgentCredentialSchema } from '../../schemas';
import { decrypt, encrypt } from '../../services/encryption';
import { CredentialValidator } from '../../services/validation';

const projectCredentialsRoutes = new Hono<{ Bindings: Env }>();

// Defence-in-depth: apply auth on the sub-router as well, so it remains safe
// if mounted independently (e.g., test harness). Parent `projectsRoutes` also
// applies these, but duplicated middleware is idempotent.
projectCredentialsRoutes.use('/*', requireAuth(), requireApproved());

/**
 * GET /api/projects/:id/credentials — list agent credentials scoped to this project.
 * Returns masked credentials with scope === 'project'.
 */
projectCredentialsRoutes.get('/:id/credentials', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

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
        const plaintext = await decrypt(cred.encryptedToken, cred.iv, getCredentialEncryptionKey(c.env));
        const maskedKey = `...${plaintext.slice(-4)}`;
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
          scope: 'project' as const,
          projectId,
        };
      })
  );

  return c.json({ credentials });
});

/**
 * PUT /api/projects/:id/credentials — save or update a project-scoped agent credential.
 */
projectCredentialsRoutes.put('/:id/credentials', jsonValidator(SaveAgentCredentialSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

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

  const validation = CredentialValidator.validateCredential(credential, credentialKind, body.agentType);
  if (!validation.valid) {
    throw errors.badRequest(validation.error || 'Invalid credential format');
  }
  if (credentialKind === 'oauth-token' && !agentDef.oauthSupport) {
    throw errors.badRequest(`OAuth tokens are not supported for ${agentDef.name}`);
  }

  const { ciphertext, iv } = await encrypt(credential, getCredentialEncryptionKey(c.env));

  // Look for an existing project-scoped credential with the same (agentType, credentialKind).
  const existing = await db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.projectId, projectId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        eq(schema.credentials.agentType, body.agentType),
        eq(schema.credentials.credentialKind, credentialKind)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  // When auto-activating, deactivate other project-scoped credentials for this agent.
  // User-scoped credentials are NOT affected — they remain active at user scope so
  // other projects can continue to inherit them.
  if (autoActivate) {
    await db
      .update(schema.credentials)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.projectId, projectId),
          eq(schema.credentials.credentialType, 'agent-api-key'),
          eq(schema.credentials.agentType, body.agentType)
        )
      );
  }

  const existingCred = existing[0];
  const maskedKey = `...${credential.slice(-4)}`;
  if (existingCred) {
    await db
      .update(schema.credentials)
      .set({
        encryptedToken: ciphertext,
        iv,
        isActive: autoActivate,
        updatedAt: now,
      })
      .where(eq(schema.credentials.id, existingCred.id));

    const response: AgentCredentialInfo = {
      agentType: body.agentType,
      provider: agentDef.provider,
      credentialKind,
      isActive: autoActivate,
      maskedKey,
      label: credentialKind === 'oauth-token' ? 'Pro/Max Subscription' : undefined,
      createdAt: existingCred.createdAt,
      updatedAt: now,
      scope: 'project',
      projectId,
    };
    return c.json(response);
  }

  const id = ulid();
  await db.insert(schema.credentials).values({
    id,
    userId,
    projectId,
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

  const response: AgentCredentialInfo = {
    agentType: body.agentType,
    provider: agentDef.provider,
    credentialKind,
    isActive: autoActivate,
    maskedKey,
    label: credentialKind === 'oauth-token' ? 'Pro/Max Subscription' : undefined,
    createdAt: now,
    updatedAt: now,
    scope: 'project',
    projectId,
  };
  return c.json(response, 201);
});

/**
 * DELETE /api/projects/:id/credentials/:agentType/:credentialKind — remove a project-scoped credential.
 */
projectCredentialsRoutes.delete('/:id/credentials/:agentType/:credentialKind', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const agentType = c.req.param('agentType');
  const credentialKind = c.req.param('credentialKind') as CredentialKind;
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

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
    throw errors.notFound('Credential');
  }

  return c.json({ success: true });
});

export { projectCredentialsRoutes };
