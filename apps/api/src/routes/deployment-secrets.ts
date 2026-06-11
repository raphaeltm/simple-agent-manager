/**
 * Deployment secret routes.
 *
 * Write-only API: set/overwrite, delete, list names only.
 * Secret values are never returned by any endpoint.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/secrets.
 * Auth: session cookie + project ownership.
 */

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import { encrypt } from '../services/encryption';

// =============================================================================
// Validation schemas
// =============================================================================

/** Secret name: alphanumeric, hyphens, underscores, 1-128 chars. */
const SECRET_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const SetSecretSchema = v.object({
  value: v.pipe(v.string('value is required'), v.minLength(1, 'value must not be empty')),
});

// =============================================================================
// Helpers
// =============================================================================

/** Load an environment row and verify it belongs to the project. */
async function requireOwnedEnvironment(
  db: ReturnType<typeof drizzle>,
  envId: string,
  projectId: string,
) {
  const rows = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw errors.notFound('Deployment environment');
  }
  return rows[0];
}

/** Update the secrets_updated_at timestamp on the environment row. */
async function touchSecretsTimestamp(
  db: ReturnType<typeof drizzle>,
  envId: string,
) {
  const now = new Date().toISOString();
  await db
    .update(schema.deploymentEnvironments)
    .set({ secretsUpdatedAt: now, updatedAt: now })
    .where(eq(schema.deploymentEnvironments.id, envId));
}

function getEncryptionKey(env: Env): string {
  return env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
}

// =============================================================================
// Routes
// =============================================================================

const deploymentSecretRoutes = new Hono<{ Bindings: Env }>();

/**
 * PUT /api/projects/:projectId/environments/:envId/secrets/:name
 * Set or overwrite a secret. Value is encrypted at rest.
 */
deploymentSecretRoutes.put(
  '/:projectId/environments/:envId/secrets/:name',
  requireAuth(),
  requireApproved(),
  jsonValidator(SetSecretSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const name = c.req.param('name');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    // Validate secret name format
    if (!SECRET_NAME_RE.test(name)) {
      throw errors.badRequest(
        'Secret name must be 1-128 alphanumeric, hyphen, or underscore characters',
      );
    }

    const { value } = c.req.valid('json');
    const encryptionKey = getEncryptionKey(c.env);
    const { ciphertext, iv } = await encrypt(value, encryptionKey);
    const now = new Date().toISOString();

    // Check if secret already exists (upsert)
    const existing = await db
      .select({ id: schema.deploymentSecrets.id })
      .from(schema.deploymentSecrets)
      .where(
        and(
          eq(schema.deploymentSecrets.environmentId, envId),
          eq(schema.deploymentSecrets.name, name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Overwrite existing secret
      await db
        .update(schema.deploymentSecrets)
        .set({
          encryptedValue: ciphertext,
          iv,
          updatedAt: now,
        })
        .where(eq(schema.deploymentSecrets.id, existing[0]!.id));
    } else {
      // Create new secret
      await db.insert(schema.deploymentSecrets).values({
        id: ulid(),
        environmentId: envId,
        name,
        encryptedValue: ciphertext,
        iv,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Mark environment as having updated secrets (stale config detection)
    await touchSecretsTimestamp(db, envId);

    return c.json(
      {
        name,
        created: existing.length === 0,
        updatedAt: now,
      },
      existing.length > 0 ? 200 : 201,
    );
  },
);

/**
 * DELETE /api/projects/:projectId/environments/:envId/secrets/:name
 * Delete a secret by name.
 */
deploymentSecretRoutes.delete(
  '/:projectId/environments/:envId/secrets/:name',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const name = c.req.param('name');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const existing = await db
      .select({ id: schema.deploymentSecrets.id })
      .from(schema.deploymentSecrets)
      .where(
        and(
          eq(schema.deploymentSecrets.environmentId, envId),
          eq(schema.deploymentSecrets.name, name),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw errors.notFound('Secret');
    }

    await db
      .delete(schema.deploymentSecrets)
      .where(eq(schema.deploymentSecrets.id, existing[0]!.id));

    // Mark environment as having updated secrets
    await touchSecretsTimestamp(db, envId);

    return c.json({ deleted: true });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/secrets
 * List secret names only — values are NEVER returned.
 */
deploymentSecretRoutes.get(
  '/:projectId/environments/:envId/secrets',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    const rows = await db
      .select({
        name: schema.deploymentSecrets.name,
        createdAt: schema.deploymentSecrets.createdAt,
        updatedAt: schema.deploymentSecrets.updatedAt,
      })
      .from(schema.deploymentSecrets)
      .where(eq(schema.deploymentSecrets.environmentId, envId))
      .orderBy(schema.deploymentSecrets.name);

    return c.json({ secrets: rows });
  },
);

export { deploymentSecretRoutes };
