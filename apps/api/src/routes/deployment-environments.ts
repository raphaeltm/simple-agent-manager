/**
 * Deployment environment routes.
 *
 * Scoped under /api/projects/:projectId/environments.
 * Auth: session cookie + project ownership.
 */

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import { collectEnvironmentRouteHostnames } from '../services/deployment-routing';
import { cleanupAppRouteDNSRecords } from '../services/dns';

// =============================================================================
// Validation schemas (Valibot — matches project convention)
// =============================================================================

/** Environment name: lowercase alphanumeric + hyphens, 1-63 chars. */
const ENV_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const CreateEnvironmentSchema = v.object({
  name: v.pipe(
    v.string('name is required'),
    v.regex(ENV_NAME_RE, 'Name must be lowercase alphanumeric with optional hyphens, 1-63 chars'),
  ),
});

// =============================================================================
// Routes
// =============================================================================

const deploymentEnvironmentRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/projects/:projectId/environments
 * Create a deployment environment.
 */
deploymentEnvironmentRoutes.post(
  '/:projectId/environments',
  requireAuth(),
  requireApproved(),
  jsonValidator(CreateEnvironmentSchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const { name } = c.req.valid('json');
    const now = new Date().toISOString();

    // Check uniqueness (also enforced by DB unique index)
    const existing = await db
      .select({ id: schema.deploymentEnvironments.id })
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.projectId, projectId),
          eq(schema.deploymentEnvironments.name, name),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw errors.conflict(`Environment "${name}" already exists in this project`);
    }

    const id = ulid();
    await db.insert(schema.deploymentEnvironments).values({
      id,
      projectId,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    return c.json(
      {
        id,
        projectId,
        name,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      201,
    );
  },
);

/**
 * GET /api/projects/:projectId/environments
 * List deployment environments for a project.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const rows = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.projectId, projectId))
      .orderBy(schema.deploymentEnvironments.createdAt);

    return c.json({ environments: rows });
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId
 * Get a single deployment environment.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments/:envId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

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

    return c.json(rows[0]);
  },
);

/**
 * DELETE /api/projects/:projectId/environments/:envId
 *
 * Tear down a deployment environment. Deprovisions the grey-cloud app-route
 * DNS records the environment's releases created, then deletes the environment
 * row — the foreign keys cascade-delete its releases, secrets, volumes, and
 * routes. DNS cleanup runs before the row delete so the manifests are still
 * available to reconstruct the route hostnames; it is idempotent and tolerant
 * of already-deleted records.
 */
deploymentEnvironmentRoutes.delete(
  '/:projectId/environments/:envId',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const envRows = await db
      .select({ id: schema.deploymentEnvironments.id })
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.id, envId),
          eq(schema.deploymentEnvironments.projectId, projectId),
        ),
      )
      .limit(1);

    if (envRows.length === 0) {
      throw errors.notFound('Deployment environment');
    }

    // Reconstruct app-route hostnames from each release's manifest before the
    // cascade delete removes the rows.
    const releases = await db
      .select({ manifest: schema.deploymentReleases.manifest })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envId));

    const hostnames = collectEnvironmentRouteHostnames(
      releases.map((r) => r.manifest),
      {
        environmentId: envId,
        baseDomain: c.env.BASE_DOMAIN,
        routePortBase: c.env.DEPLOYMENT_ROUTE_PORT_BASE,
        routePortSpan: c.env.DEPLOYMENT_ROUTE_PORT_SPAN,
      },
    );

    const dnsRecordsDeleted = await cleanupAppRouteDNSRecords(hostnames, c.env);

    // Cascade-delete releases, secrets, volumes, and routes via FK constraints.
    await db
      .delete(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, envId));

    log.info('deployment_environment.deleted', {
      projectId,
      envId,
      releaseCount: releases.length,
      dnsRecordsDeleted,
    });

    return c.json({ id: envId, deleted: true, dnsRecordsDeleted });
  },
);

export { deploymentEnvironmentRoutes };
