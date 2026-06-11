/**
 * Deployment release routes.
 *
 * Scoped under /api/projects/:projectId/environments/:envId/releases.
 * Auth: session cookie + project ownership.
 */

import { validateManifest } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { collectSecretNames, renderCompose } from '../services/compose-renderer';
import { decrypt } from '../services/encryption';

// =============================================================================
// Helpers
// =============================================================================

/** Max single-service constraint for slice 2. */
export const MAX_SERVICES_SLICE_2 = 1;

/**
 * Validate a manifest against slice 2 constraints.
 * Returns null if valid, or an error response object if invalid.
 */
export function validateSlice2Constraints(manifest: {
  services: Record<string, { env: Record<string, unknown> }>;
}): { error: string; message: string } | null {
  // Enforce single-service constraint
  const serviceCount = Object.keys(manifest.services).length;
  if (serviceCount > MAX_SERVICES_SLICE_2) {
    return {
      error: 'MULTI_SERVICE_NOT_SUPPORTED',
      message: `Multi-service manifests are not yet supported. This manifest defines ${serviceCount} services, but only ${MAX_SERVICES_SLICE_2} is allowed. Multi-service support arrives in a future update.`,
    };
  }

  return null;
}

/**
 * Load an environment row and verify it belongs to the project.
 */
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

/**
 * Load a release row and verify it belongs to the environment.
 */
async function requireOwnedRelease(
  db: ReturnType<typeof drizzle>,
  releaseId: string,
  envId: string,
) {
  const rows = await db
    .select()
    .from(schema.deploymentReleases)
    .where(
      and(
        eq(schema.deploymentReleases.id, releaseId),
        eq(schema.deploymentReleases.environmentId, envId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw errors.notFound('Deployment release');
  }
  return rows[0]!;
}

function getEncryptionKey(env: Env): string {
  return env.CREDENTIAL_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
}

/**
 * Load and decrypt secrets for an environment.
 * Returns a map of secret name → decrypted value.
 */
async function loadResolvedSecrets(
  db: ReturnType<typeof drizzle>,
  envId: string,
  secretNames: string[],
  encryptionKey: string,
): Promise<Record<string, string>> {
  if (secretNames.length === 0) return {};

  const rows = await db
    .select({
      name: schema.deploymentSecrets.name,
      encryptedValue: schema.deploymentSecrets.encryptedValue,
      iv: schema.deploymentSecrets.iv,
    })
    .from(schema.deploymentSecrets)
    .where(eq(schema.deploymentSecrets.environmentId, envId));

  const resolved: Record<string, string> = {};
  for (const row of rows) {
    if (secretNames.includes(row.name)) {
      resolved[row.name] = await decrypt(row.encryptedValue, row.iv, encryptionKey);
    }
  }
  return resolved;
}

// =============================================================================
// Routes
// =============================================================================

const deploymentReleaseRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments/:envId/releases
 * Submit a manifest to create a new release.
 *
 * The request body IS the raw manifest JSON.
 * Validated via validateManifest() from @simple-agent-manager/shared.
 * Single-service constraint enforced for slice 2.
 * Secret references are stored by name in the manifest (values never persisted).
 */
deploymentReleaseRoutes.post(
  '/:projectId/environments/:envId/releases',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);

    // Parse body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw errors.badRequest('Invalid JSON in request body');
    }

    // Phase 1: Validate manifest (schema + cross-references)
    const result = validateManifest(body);
    if (!result.success) {
      return c.json(
        {
          error: 'MANIFEST_VALIDATION_FAILED',
          message: 'Manifest validation failed',
          details: { errors: result.errors },
        },
        400,
      );
    }

    const manifest = result.manifest;

    // Phase 2: Enforce slice 2 constraints (single-service)
    const constraintError = validateSlice2Constraints(manifest);
    if (constraintError) {
      return c.json(constraintError, 400);
    }

    // Validate that all referenced secrets exist in the environment
    const secretNames = collectSecretNames(manifest);
    if (secretNames.length > 0) {
      const existingSecrets = await db
        .select({ name: schema.deploymentSecrets.name })
        .from(schema.deploymentSecrets)
        .where(eq(schema.deploymentSecrets.environmentId, envId));

      const existingNames = new Set(existingSecrets.map((s) => s.name));
      const missing = secretNames.filter((n) => !existingNames.has(n));

      if (missing.length > 0) {
        return c.json(
          {
            error: 'MISSING_SECRETS',
            message: `Manifest references secrets that do not exist in this environment: ${missing.join(', ')}. Set these secrets before creating a release.`,
            details: { missingSecrets: missing },
          },
          400,
        );
      }
    }

    // Determine next version number
    const latestRelease = await db
      .select({ version: schema.deploymentReleases.version })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envId))
      .orderBy(desc(schema.deploymentReleases.version))
      .limit(1);

    const nextVersion = (latestRelease[0]?.version ?? 0) + 1;

    // Insert release — manifest stores secret REFERENCES (names only), never values
    const id = ulid();
    const now = new Date().toISOString();

    try {
      await db.insert(schema.deploymentReleases).values({
        id,
        environmentId: envId,
        manifest: JSON.stringify(manifest),
        version: nextVersion,
        status: 'created',
        createdBy: userId,
        createdAt: now,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        throw errors.conflict(
          `Version ${nextVersion} already exists for this environment. Please retry.`,
        );
      }
      throw err;
    }

    return c.json(
      {
        id,
        environmentId: envId,
        version: nextVersion,
        status: 'created',
        createdBy: userId,
        createdAt: now,
      },
      201,
    );
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/releases
 * List releases for an environment (newest first).
 */
deploymentReleaseRoutes.get(
  '/:projectId/environments/:envId/releases',
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
        id: schema.deploymentReleases.id,
        environmentId: schema.deploymentReleases.environmentId,
        version: schema.deploymentReleases.version,
        status: schema.deploymentReleases.status,
        createdBy: schema.deploymentReleases.createdBy,
        createdAt: schema.deploymentReleases.createdAt,
      })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envId))
      .orderBy(desc(schema.deploymentReleases.version));

    return c.json({ releases: rows });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/releases/:releaseId
 * Get a single release including the stored manifest.
 */
deploymentReleaseRoutes.get(
  '/:projectId/environments/:envId/releases/:releaseId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const releaseId = c.req.param('releaseId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);
    const row = await requireOwnedRelease(db, releaseId, envId);

    return c.json({
      ...row,
      manifest: JSON.parse(row.manifest),
    });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/releases/:releaseId/compose
 * Render and return the Compose YAML for a release.
 * Resolves secret references at render time — values are decrypted from D1
 * and injected into the rendered Compose but never stored in the release record.
 */
deploymentReleaseRoutes.get(
  '/:projectId/environments/:envId/releases/:releaseId/compose',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const releaseId = c.req.param('releaseId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);
    await requireOwnedEnvironment(db, envId, projectId);
    const row = await requireOwnedRelease(db, releaseId, envId);

    const manifest = JSON.parse(row.manifest);

    // Resolve secret references at render time
    const secretNames = collectSecretNames(manifest);
    const resolvedSecrets = await loadResolvedSecrets(
      db,
      envId,
      secretNames,
      getEncryptionKey(c.env),
    );

    const composeYaml = renderCompose(manifest, {
      environmentId: envId,
      releaseId,
      resolvedSecrets,
    });

    return c.text(composeYaml, 200, {
      'Content-Type': 'text/yaml; charset=utf-8',
    });
  },
);

export { deploymentReleaseRoutes };
