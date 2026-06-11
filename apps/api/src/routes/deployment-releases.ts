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
import { renderCompose } from '../services/compose-renderer';

// =============================================================================
// Helpers
// =============================================================================

/** Max single-service constraint for slice 2. */
const MAX_SERVICES_SLICE_2 = 1;

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
 * Secret references rejected (secret store deferred to later slice).
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

    // Phase 2: Enforce single-service constraint (slice 2)
    const serviceCount = Object.keys(manifest.services).length;
    if (serviceCount > MAX_SERVICES_SLICE_2) {
      return c.json(
        {
          error: 'MULTI_SERVICE_NOT_SUPPORTED',
          message: `Multi-service manifests are not yet supported. This manifest defines ${serviceCount} services, but only ${MAX_SERVICES_SLICE_2} is allowed. Multi-service support arrives in a future update.`,
        },
        400,
      );
    }

    // Phase 3: Reject secret references (secret store not yet implemented)
    for (const [svcName, svc] of Object.entries(manifest.services)) {
      for (const [envKey, envVal] of Object.entries(svc.env)) {
        if (typeof envVal === 'object' && envVal !== null && 'secret' in envVal) {
          return c.json(
            {
              error: 'SECRETS_NOT_SUPPORTED',
              message: `Secret references are not yet supported. Service "${svcName}" env var "${envKey}" references secret "${envVal.secret}". Use a literal string value instead, or wait for secret management in a future update.`,
            },
            400,
          );
        }
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

    // Insert release
    const id = ulid();
    const now = new Date().toISOString();

    await db.insert(schema.deploymentReleases).values({
      id,
      environmentId: envId,
      manifest: JSON.stringify(manifest),
      version: nextVersion,
      status: 'created',
      createdBy: userId,
      createdAt: now,
    });

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

    const row = rows[0]!;
    return c.json({
      ...row,
      manifest: JSON.parse(row.manifest),
    });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/releases/:releaseId/compose
 * Render and return the Compose YAML for a release.
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

    const manifest = JSON.parse(rows[0]!.manifest);
    const composeYaml = renderCompose(manifest, {
      environmentId: envId,
      releaseId,
    });

    return c.text(composeYaml, 200, {
      'Content-Type': 'text/yaml; charset=utf-8',
    });
  },
);

export { deploymentReleaseRoutes };
