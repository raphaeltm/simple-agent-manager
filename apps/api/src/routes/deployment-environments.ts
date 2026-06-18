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
import {
  encodeAllowedDeployProfileIds,
  uniqueDeployProfileIds,
  validateAllowedDeployProfiles,
} from '../services/deployment-control';
import { buildDeploymentEnvironmentResponse } from '../services/deployment-environment-summary';
import { collectEnvironmentRouteHostnames } from '../services/deployment-routing';
import {
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
} from '../services/deployment-volumes';
import { cleanupAppRouteDNSRecords } from '../services/dns';
import { getNodeLogsFromNode } from '../services/node-agent';
import { deleteNodeResources } from '../services/nodes';

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

const UpdateEnvironmentPolicySchema = v.object({
  agentDeployEnabled: v.optional(v.boolean()),
  allowedDeployProfileIds: v.optional(v.nullable(v.array(v.string()))),
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

    const [created] = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, id))
      .limit(1);

    return c.json(await buildDeploymentEnvironmentResponse(db, c.env, created!), 201);
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

    const environments = await Promise.all(
      rows.map((row) => buildDeploymentEnvironmentResponse(db, c.env, row)),
    );

    return c.json({ environments });
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

    return c.json(await buildDeploymentEnvironmentResponse(db, c.env, rows[0]!));
  },
);

/**
 * PATCH /api/projects/:projectId/environments/:envId/policy
 * Update the user-controlled agent deployment policy for an environment.
 */
deploymentEnvironmentRoutes.patch(
  '/:projectId/environments/:envId/policy',
  requireAuth(),
  requireApproved(),
  jsonValidator(UpdateEnvironmentPolicySchema),
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

    const current = rows[0];
    if (!current) {
      throw errors.notFound('Deployment environment');
    }

    const body = c.req.valid('json');
    const now = new Date().toISOString();
    const updates: Partial<schema.NewDeploymentEnvironmentRow> = { updatedAt: now };

    if (body.agentDeployEnabled !== undefined) {
      updates.agentDeployEnabled = body.agentDeployEnabled;
      if (body.agentDeployEnabled) {
        updates.agentDeployEnabledBy = userId;
        updates.agentDeployEnabledAt = now;
      } else {
        updates.agentDeployDisabledAt = now;
      }
    }

    if (body.allowedDeployProfileIds !== undefined) {
      const allowedProfileIds = uniqueDeployProfileIds(body.allowedDeployProfileIds);
      try {
        await validateAllowedDeployProfiles(db, projectId, allowedProfileIds);
      } catch (err) {
        throw errors.badRequest(err instanceof Error ? err.message : String(err));
      }
      updates.allowedDeployProfileIdsJson = encodeAllowedDeployProfileIds(allowedProfileIds);
    }

    await db
      .update(schema.deploymentEnvironments)
      .set(updates)
      .where(eq(schema.deploymentEnvironments.id, envId));

    const [updated] = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, envId))
      .limit(1);

    log.info('deployment_environment.policy_updated', {
      projectId,
      envId,
      agentDeployEnabled: updated?.agentDeployEnabled,
      allowedProfileCount: uniqueDeployProfileIds(body.allowedDeployProfileIds).length,
    });

    return c.json(await buildDeploymentEnvironmentResponse(db, c.env, updated!));
  },
);

/**
 * GET /api/projects/:projectId/environments/:envId/logs
 * Read deployment-node logs via the existing node-agent log proxy.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments/:envId/logs',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const envRows = await db
      .select({
        id: schema.deploymentEnvironments.id,
        nodeId: schema.deploymentEnvironments.nodeId,
      })
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.id, envId),
          eq(schema.deploymentEnvironments.projectId, projectId),
        ),
      )
      .limit(1);

    const environment = envRows[0];
    if (!environment) {
      throw errors.notFound('Deployment environment');
    }

    if (!environment.nodeId) {
      return c.json({
        entries: [],
        nextCursor: null,
        hasMore: false,
        source: 'deployment-node',
        nodeId: null,
        unavailableReason: 'no_deployment_node',
      });
    }

    const nodeRows = await db
      .select({ id: schema.nodes.id, status: schema.nodes.status })
      .from(schema.nodes)
      .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)))
      .limit(1);

    const node = nodeRows[0];
    if (!node || node.status !== 'running') {
      return c.json({
        entries: [],
        nextCursor: null,
        hasMore: false,
        source: 'deployment-node',
        nodeId: environment.nodeId,
        unavailableReason: node ? 'node_not_running' : 'node_not_found',
      });
    }

    const queryString = new URL(c.req.url).searchParams.toString();
    try {
      const result = await getNodeLogsFromNode(node.id, c.env, userId, queryString);
      return c.json({
        ...(typeof result === 'object' && result !== null ? result : { entries: [] }),
        source: 'deployment-node',
        nodeId: node.id,
      });
    } catch (err) {
      log.warn('deployment_environment.logs_unavailable', {
        projectId,
        envId,
        nodeId: node.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({
        entries: [],
        nextCursor: null,
        hasMore: false,
        source: 'deployment-node',
        nodeId: node.id,
        unavailableReason: 'node_agent_unreachable',
      });
    }
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
      .select()
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
    const environment = envRows[0]!;

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

    const volumes = await listEnvironmentVolumes(db, envId);
    let volumesDetached = 0;
    let volumesDeleted = 0;

    if (volumes.length > 0 && environment.nodeId) {
      const nodeRows = await db
        .select({ providerInstanceId: schema.nodes.providerInstanceId })
        .from(schema.nodes)
        .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)))
        .limit(1);
      const providerInstanceId = nodeRows[0]?.providerInstanceId;

      if (providerInstanceId) {
        try {
          const detached = await detachEnvironmentVolumes(
            db,
            c.env,
            userId,
            envId,
            providerInstanceId,
          );
          volumesDetached = detached.length;
        } catch (err) {
          throw errors.conflict(
            `Could not detach deployment volume(s): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const currentVolumes = await listEnvironmentVolumes(db, envId);
    for (const volume of currentVolumes) {
      try {
        await deleteEnvironmentVolume(db, c.env, userId, volume.id, envId);
        volumesDeleted += 1;
      } catch (err) {
        throw errors.conflict(
          `Could not delete deployment volume "${volume.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let nodeDeleted = false;
    let nodeCleanupWarnings: string[] = [];
    if (environment.nodeId) {
      const cleanup = await deleteNodeResources(environment.nodeId, userId, c.env);
      nodeCleanupWarnings = cleanup.errors;

      if (cleanup.errors.length > 0) {
        throw errors.conflict(
          `Deployment node could not be fully deprovisioned: ${cleanup.errors.join('; ')}`,
        );
      }

      await db
        .delete(schema.nodes)
        .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)));
      nodeDeleted = cleanup.nodeFound;
    }

    const dnsRecordsDeleted = await cleanupAppRouteDNSRecords(hostnames, c.env);

    // Cascade-delete releases, secrets, volumes, and routes via FK constraints.
    await db
      .delete(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, envId));

    log.info('deployment_environment.deleted', {
      projectId,
      envId,
      nodeId: environment.nodeId,
      nodeDeleted,
      releaseCount: releases.length,
      volumesDetached,
      volumesDeleted,
      dnsRecordsDeleted,
    });

    return c.json({
      id: envId,
      deleted: true,
      nodeId: environment.nodeId,
      nodeDeleted,
      volumesDetached,
      volumesDeleted,
      dnsRecordsDeleted,
      warnings: nodeCleanupWarnings,
    });
  },
);

export { deploymentEnvironmentRoutes };
