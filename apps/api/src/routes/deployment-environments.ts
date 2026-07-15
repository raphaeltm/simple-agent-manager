/**
 * Deployment environment routes.
 *
 * Scoped under /api/projects/:projectId/environments.
 * Auth: session cookie + active project membership/capabilities.
 */

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import {
  DEPLOYMENT_ENVIRONMENT_NAME_RE,
  encodeAllowedDeployProfileIds,
  uniqueDeployProfileIds,
  validateAllowedDeployProfiles,
} from '../services/deployment-control';
import { getEnvironmentPublicRouteTargets } from '../services/deployment-custom-domains';
import { buildDeploymentEnvironmentResponse } from '../services/deployment-environment-summary';
import { collectEnvironmentRouteHostnames } from '../services/deployment-routing';
import {
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
} from '../services/deployment-volumes';
import { cleanupAppRouteDNSRecords } from '../services/dns';
import {
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeContainersFromNode,
} from '../services/node-agent-diagnostics';
import { deleteNodeResources, retireDeletedDeploymentNodeRecord } from '../services/nodes';
import { registerDeploymentEnvironmentLifecycleRoutes } from './deployment-environment-lifecycle';

// =============================================================================
// Validation schemas (Valibot — matches project convention)
// =============================================================================

const CreateEnvironmentSchema = v.object({
  name: v.pipe(
    v.string('name is required'),
    v.regex(
      DEPLOYMENT_ENVIRONMENT_NAME_RE,
      'Name must be lowercase alphanumeric with optional hyphens, 1-63 chars'
    )
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

function parseLastMetrics(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type DeploymentDb = ReturnType<typeof drizzle<typeof schema>>;

async function requireDeploymentEnvironment(
  db: DeploymentDb,
  projectId: string,
  envId: string
): Promise<schema.DeploymentEnvironmentRow> {
  const rows = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId)
      )
    )
    .limit(1);

  const environment = rows[0];
  if (!environment) {
    throw errors.notFound('Deployment environment');
  }
  return environment;
}

function publicRouteId(service: string, port: number, routeIndex: number): string {
  return `${service}:${port}:${routeIndex}`;
}

/**
 * Result of resolving the deployment node backing an environment, used by the
 * node-proxy GET routes (logs/containers/metrics). Each route maps these
 * variants to its own response shape; the lookup and ownership checks are
 * shared here. Throws `notFound` when the environment itself does not exist.
 */
type ResolvedDeploymentNode =
  | { kind: 'no_node' }
  | {
      kind: 'unavailable';
      nodeId: string;
      reason: 'node_not_running' | 'node_not_found';
      lastMetrics: string | null;
    }
  | { kind: 'ready'; nodeId: string; lastMetrics: string | null };

async function resolveDeploymentNode(
  db: DeploymentDb,
  projectId: string,
  envId: string
): Promise<ResolvedDeploymentNode> {
  const envRows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      nodeId: schema.deploymentEnvironments.nodeId,
    })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.projectId, projectId)
      )
    )
    .limit(1);

  const environment = envRows[0];
  if (!environment) {
    throw errors.notFound('Deployment environment');
  }

  if (!environment.nodeId) {
    return { kind: 'no_node' };
  }

  const nodeRows = await db
    .select({
      id: schema.nodes.id,
      status: schema.nodes.status,
      lastMetrics: schema.nodes.lastMetrics,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, environment.nodeId))
    .limit(1);

  const node = nodeRows[0];
  if (!node || node.status !== 'running') {
    return {
      kind: 'unavailable',
      nodeId: environment.nodeId,
      reason: node ? 'node_not_running' : 'node_not_found',
      lastMetrics: node ? node.lastMetrics : null,
    };
  }

  return { kind: 'ready', nodeId: node.id, lastMetrics: node.lastMetrics };
}

type ReadyDeploymentNode = Extract<ResolvedDeploymentNode, { kind: 'ready' }>;
type NotReadyDeploymentNode = Exclude<ResolvedDeploymentNode, { kind: 'ready' }>;

/**
 * Shared driver for the node-proxy GET routes (logs/containers/metrics). Runs
 * the common ownership + node-resolution preamble, then delegates response
 * shaping to per-route builders. The not-ready, success, and error response
 * bodies differ per route, so each route supplies its own builders; the
 * preamble, error logging, and try/catch wrapping are shared here.
 */
async function handleNodeProxyRoute(
  c: Context<{ Bindings: Env }, '/:projectId/environments/:envId'>,
  event: string,
  builders: {
    notReady: (resolved: NotReadyDeploymentNode) => unknown;
    fetch: (nodeId: string, userId: string) => Promise<unknown>;
    onSuccess: (result: unknown, resolved: ReadyDeploymentNode) => unknown;
    onError: (resolved: ReadyDeploymentNode) => unknown;
  }
): Promise<Response> {
  const projectId = c.req.param('projectId');
  const envId = c.req.param('envId');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'deployment:read');

  const resolved = await resolveDeploymentNode(db, projectId, envId);
  if (resolved.kind !== 'ready') {
    return c.json(builders.notReady(resolved));
  }

  try {
    const result = await builders.fetch(resolved.nodeId, userId);
    return c.json(builders.onSuccess(result, resolved));
  } catch (err) {
    log.warn(event, {
      projectId,
      envId,
      nodeId: resolved.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(builders.onError(resolved));
  }
}

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
    await requireProjectCapability(db, projectId, userId, 'deployment:manage');

    const { name } = c.req.valid('json');
    const now = new Date().toISOString();

    // Check uniqueness (also enforced by DB unique index)
    const existing = await db
      .select({ id: schema.deploymentEnvironments.id })
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.projectId, projectId),
          eq(schema.deploymentEnvironments.name, name)
        )
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
      createdByUserId: userId,
      creationSource: 'user',
    });

    const [created] = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, id))
      .limit(1);

    return c.json(await buildDeploymentEnvironmentResponse(db, c.env, created!), 201);
  }
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
    await requireProjectAccess(db, projectId, userId);

    const rows = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.projectId, projectId))
      .orderBy(schema.deploymentEnvironments.createdAt);

    const environments = await Promise.all(
      rows.map((row) => buildDeploymentEnvironmentResponse(db, c.env, row))
    );

    return c.json({ environments });
  }
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
    await requireProjectAccess(db, projectId, userId);

    const environment = await requireDeploymentEnvironment(db, projectId, envId);

    return c.json(await buildDeploymentEnvironmentResponse(db, c.env, environment));
  }
);

/**
 * GET /api/projects/:projectId/environments/:envId/public-routes
 * List the current release's public route metadata for custom-domain attach.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments/:envId/public-routes',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'deployment:read');
    const environment = await requireDeploymentEnvironment(db, projectId, envId);
    const routesAreLive = environment.status === 'active' || environment.status === 'starting';

    const targets = await getEnvironmentPublicRouteTargets(db, c.env, envId);
    return c.json({
      environmentStatus: environment.status,
      routesAreLive,
      publicRoutes: targets.map((route, index) => ({
        id: publicRouteId(route.service, route.containerPort, index),
        service: route.service,
        port: route.containerPort,
        hostname: route.hostname,
        hostPort: route.hostPort,
        routeIndex: index,
        routesAreLive,
      })),
    });
  }
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
    await requireProjectCapability(db, projectId, userId, 'deployment:manage');

    const rows = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.id, envId),
          eq(schema.deploymentEnvironments.projectId, projectId)
        )
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
  }
);

registerDeploymentEnvironmentLifecycleRoutes(deploymentEnvironmentRoutes);

/**
 * GET /api/projects/:projectId/environments/:envId/logs
 * Read deployment-node logs via the existing node-agent log proxy.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments/:envId/logs',
  requireAuth(),
  requireApproved(),
  (c) =>
    handleNodeProxyRoute(c, 'deployment_environment.logs_unavailable', {
      notReady: (resolved) => ({
        entries: [],
        nextCursor: null,
        hasMore: false,
        source: 'deployment-node',
        nodeId: resolved.kind === 'unavailable' ? resolved.nodeId : null,
        unavailableReason: resolved.kind === 'no_node' ? 'no_deployment_node' : resolved.reason,
      }),
      fetch: (nodeId, userId) =>
        getNodeLogsFromNode(nodeId, c.env, userId, new URL(c.req.url).searchParams.toString()),
      onSuccess: (result, resolved) => ({
        ...(typeof result === 'object' && result !== null ? result : { entries: [] }),
        source: 'deployment-node',
        nodeId: resolved.nodeId,
      }),
      onError: (resolved) => ({
        entries: [],
        nextCursor: null,
        hasMore: false,
        source: 'deployment-node',
        nodeId: resolved.nodeId,
        unavailableReason: 'node_agent_unreachable',
      }),
    })
);

/**
 * GET /api/projects/:projectId/environments/:envId/containers
 * List deployment-node containers for log filtering.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments/:envId/containers',
  requireAuth(),
  requireApproved(),
  (c) =>
    handleNodeProxyRoute(c, 'deployment_environment.containers_unavailable', {
      notReady: (resolved) => ({
        containers: [],
        nodeId: resolved.kind === 'unavailable' ? resolved.nodeId : null,
        unavailableReason: resolved.kind === 'no_node' ? 'no_deployment_node' : resolved.reason,
      }),
      fetch: (nodeId, userId) => listNodeContainersFromNode(nodeId, c.env, userId),
      onSuccess: (result, resolved) => ({
        ...(typeof result === 'object' && result !== null ? result : { containers: [] }),
        nodeId: resolved.nodeId,
      }),
      onError: (resolved) => ({
        containers: [],
        nodeId: resolved.nodeId,
        unavailableReason: 'node_agent_unreachable',
      }),
    })
);

/**
 * GET /api/projects/:projectId/environments/:envId/metrics
 * Read deployment-node system and container metrics.
 */
deploymentEnvironmentRoutes.get(
  '/:projectId/environments/:envId/metrics',
  requireAuth(),
  requireApproved(),
  (c) =>
    handleNodeProxyRoute(c, 'deployment_environment.metrics_unavailable', {
      notReady: (resolved) => ({
        systemInfo: null,
        nodeId: resolved.kind === 'unavailable' ? resolved.nodeId : null,
        fallbackMetrics:
          resolved.kind === 'unavailable' ? parseLastMetrics(resolved.lastMetrics) : null,
        unavailableReason: resolved.kind === 'no_node' ? 'no_deployment_node' : resolved.reason,
      }),
      fetch: (nodeId, userId) => getNodeSystemInfoFromNode(nodeId, c.env, userId),
      onSuccess: (result, resolved) => ({
        systemInfo: result,
        nodeId: resolved.nodeId,
        fallbackMetrics: parseLastMetrics(resolved.lastMetrics),
      }),
      onError: (resolved) => ({
        systemInfo: null,
        nodeId: resolved.nodeId,
        fallbackMetrics: parseLastMetrics(resolved.lastMetrics),
        unavailableReason: 'node_agent_unreachable',
      }),
    })
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
    await requireProjectCapability(db, projectId, userId, 'deployment:manage');

    const envRows = await db
      .select()
      .from(schema.deploymentEnvironments)
      .where(
        and(
          eq(schema.deploymentEnvironments.id, envId),
          eq(schema.deploymentEnvironments.projectId, projectId)
        )
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
      }
    );

    const volumes = await listEnvironmentVolumes(db, envId);
    let volumesDetached = 0;
    let volumesDeleted = 0;

    const attachedServerIds = new Set<string>();
    for (const volume of volumes) {
      if (volume.attachedServerId) {
        attachedServerIds.add(volume.attachedServerId);
      }
    }

    if (volumes.length > 0 && environment.nodeId) {
      const nodeRows = await db
        .select({ providerInstanceId: schema.nodes.providerInstanceId })
        .from(schema.nodes)
        .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)))
        .limit(1);
      const providerInstanceId = nodeRows[0]?.providerInstanceId;

      if (providerInstanceId) {
        attachedServerIds.add(providerInstanceId);
      }
    }

    for (const serverId of attachedServerIds) {
      try {
        const detached = await detachEnvironmentVolumes(db, c.env, userId, envId, serverId);
        volumesDetached += detached.length;
      } catch (err) {
        throw errors.conflict(
          `Could not detach deployment volume(s): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const currentVolumes = await listEnvironmentVolumes(db, envId);
    for (const volume of currentVolumes) {
      try {
        await deleteEnvironmentVolume(db, c.env, userId, volume.id, envId, {
          allowLatestReleaseDeclaredVolume: true,
        });
        volumesDeleted += 1;
      } catch (err) {
        throw errors.conflict(
          `Could not delete deployment volume "${volume.name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    let nodeDeleted = false;
    let nodeCleanupWarnings: string[] = [];
    const dnsRecordsDeleted = await cleanupAppRouteDNSRecords(hostnames, c.env);

    // Cascade-delete releases, secrets, volumes, and routes via FK constraints.
    await db
      .delete(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, envId));

    if (environment.nodeId) {
      // Race-safe last-environment claim: only the worker that observes no
      // remaining placements can transition the node out of the scheduling pool.
      const claim = await c.env.DATABASE.prepare(
        `UPDATE nodes
         SET status = 'deleting', updated_at = ?
         WHERE id = ?
           AND user_id = ?
           AND node_role = 'deployment'
           AND status NOT IN ('deleting', 'deleted')
           AND NOT EXISTS (
             SELECT 1 FROM deployment_environments WHERE node_id = ?
           )`
      )
        .bind(new Date().toISOString(), environment.nodeId, userId, environment.nodeId)
        .run();

      if ((claim.meta?.changes ?? 0) > 0) {
        const cleanup = await deleteNodeResources(environment.nodeId, userId, c.env);
        nodeCleanupWarnings = cleanup.errors;

        if (cleanup.errors.length > 0) {
          await db
            .update(schema.nodes)
            .set({
              status: 'error',
              errorMessage: `Deployment node could not be fully deprovisioned: ${cleanup.errors.join('; ')}`,
              updatedAt: new Date().toISOString(),
            })
            .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)));
          throw errors.conflict(
            `Deployment node could not be fully deprovisioned: ${cleanup.errors.join('; ')}`
          );
        }

        await retireDeletedDeploymentNodeRecord(db, environment.nodeId, userId);
        nodeDeleted = cleanup.nodeFound;
      }
    }

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
  }
);

export { deploymentEnvironmentRoutes };
