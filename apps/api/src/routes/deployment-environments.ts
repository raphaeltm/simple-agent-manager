/**
 * Deployment environment routes.
 *
 * Scoped under /api/projects/:projectId/environments.
 * Auth: session cookie + project ownership.
 */

import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';
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
import { getEnvironmentPublicRouteTargets } from '../services/deployment-custom-domains';
import { buildDeploymentEnvironmentResponse } from '../services/deployment-environment-summary';
import { provisionDeploymentNode } from '../services/deployment-provisioning';
import { collectEnvironmentRouteHostnames } from '../services/deployment-routing';
import {
  attachEnvironmentVolumesToLinkedNode,
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
} from '../services/deployment-volumes';
import { cleanupAppRouteDNSRecords } from '../services/dns';
import {
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeContainersFromNode,
  teardownDeploymentEnvironmentOnNode,
} from '../services/node-agent';
import { deleteNodeResources } from '../services/nodes';

// =============================================================================
// Validation schemas (Valibot — matches project convention)
// =============================================================================

/** Environment name: lowercase alphanumeric + hyphens, 1-63 chars. */
const ENV_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const CreateEnvironmentSchema = v.object({
  name: v.pipe(
    v.string('name is required'),
    v.regex(ENV_NAME_RE, 'Name must be lowercase alphanumeric with optional hyphens, 1-63 chars')
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
  envId: string,
  userId: string
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
    .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)))
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

interface LastNodeCleanupResult {
  nodeDeleted: boolean;
  warnings: string[];
}

interface VolumePlacementConstraint {
  provider: CredentialProvider;
  location: string;
}

async function cleanupDeploymentNodeIfUnassigned(
  db: DeploymentDb,
  env: Env,
  userId: string,
  nodeId: string | null
): Promise<LastNodeCleanupResult> {
  if (!nodeId) {
    return { nodeDeleted: false, warnings: [] };
  }

  const claim = await env.DATABASE.prepare(
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
    .bind(new Date().toISOString(), nodeId, userId, nodeId)
    .run();

  if ((claim.meta?.changes ?? 0) === 0) {
    return { nodeDeleted: false, warnings: [] };
  }

  const cleanup = await deleteNodeResources(nodeId, userId, env);
  if (cleanup.errors.length > 0) {
    await db
      .update(schema.nodes)
      .set({
        status: 'error',
        errorMessage: `Deployment node could not be fully deprovisioned: ${cleanup.errors.join('; ')}`,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)));
    return { nodeDeleted: false, warnings: cleanup.errors };
  }

  await db
    .delete(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)));
  return { nodeDeleted: cleanup.nodeFound, warnings: [] };
}

function resolveVolumePlacementConstraint(
  volumes: schema.DeploymentVolumeRow[]
): VolumePlacementConstraint | null {
  const first = volumes[0];
  if (!first) return null;

  for (const volume of volumes) {
    if (volume.providerName !== first.providerName || volume.location !== first.location) {
      throw errors.conflict(
        'Deployment environment volumes must all use the same provider and location before the environment can be started.'
      );
    }
  }

  return {
    provider: first.providerName as CredentialProvider,
    location: first.location,
  };
}

async function markEnvironmentStartFailed(
  db: DeploymentDb,
  envId: string,
  error: unknown
): Promise<void> {
  await db
    .update(schema.deploymentEnvironments)
    .set({
      status: 'error',
      observedStatus: 'failed',
      observedErrorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.deploymentEnvironments.id, envId));
}

async function finishEnvironmentStart(
  db: DeploymentDb,
  env: Env,
  userId: string,
  envId: string,
  nodeId: string,
  shouldAttachVolumes: boolean,
  provisioningPromise: Promise<void>
): Promise<void> {
  try {
    await provisioningPromise;

    const currentRows = await db
      .select({ nodeId: schema.deploymentEnvironments.nodeId })
      .from(schema.deploymentEnvironments)
      .where(eq(schema.deploymentEnvironments.id, envId))
      .limit(1);
    if (currentRows[0]?.nodeId !== nodeId) {
      throw new Error('Deployment node provisioning did not complete for this environment');
    }

    if (shouldAttachVolumes) {
      await attachEnvironmentVolumesToLinkedNode(db, env, userId, envId);
    }
  } catch (err) {
    log.error('deployment_environment.start_failed', {
      envId,
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markEnvironmentStartFailed(db, envId, err);
    throw err;
  }
}

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
  await requireOwnedProject(db, projectId, userId);

  const resolved = await resolveDeploymentNode(db, projectId, envId, userId);
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
    await requireOwnedProject(db, projectId, userId);

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
    await requireOwnedProject(db, projectId, userId);

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
    await requireOwnedProject(db, projectId, userId);
    await requireDeploymentEnvironment(db, projectId, envId);

    const targets = await getEnvironmentPublicRouteTargets(db, c.env, envId);
    return c.json({
      publicRoutes: targets.map((route, index) => ({
        id: publicRouteId(route.service, route.containerPort, index),
        service: route.service,
        port: route.containerPort,
        hostname: route.hostname,
        hostPort: route.hostPort,
        routeIndex: index,
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
    await requireOwnedProject(db, projectId, userId);

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

/**
 * POST /api/projects/:projectId/environments/:envId/stop
 *
 * Non-destructively down a deployment environment. This removes running
 * containers/routes, detaches provider volumes, clears the node placement, and
 * preserves releases, config, custom domains, and volume records for a later
 * start.
 */
deploymentEnvironmentRoutes.post(
  '/:projectId/environments/:envId/stop',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const environment = await requireDeploymentEnvironment(db, projectId, envId);
    if (environment.status === 'stopped') {
      return c.json({
        environment: await buildDeploymentEnvironmentResponse(db, c.env, environment),
        lifecycle: {
          stopped: true,
          alreadyStopped: true,
          nodeId: environment.nodeId,
          nodeDeleted: false,
          volumesDetached: 0,
          warnings: [],
        },
      });
    }
    if (environment.status === 'stopping' || environment.status === 'starting') {
      throw errors.conflict(
        `Deployment environment is already ${environment.status}; wait for that lifecycle operation to finish.`
      );
    }

    const now = new Date().toISOString();
    await db
      .update(schema.deploymentEnvironments)
      .set({ status: 'stopping', updatedAt: now })
      .where(eq(schema.deploymentEnvironments.id, envId));

    let providerInstanceId: string | null = null;
    let nodeStatus: string | null = null;
    const warnings: string[] = [];

    if (environment.nodeId) {
      const nodeRows = await db
        .select({
          id: schema.nodes.id,
          status: schema.nodes.status,
          providerInstanceId: schema.nodes.providerInstanceId,
        })
        .from(schema.nodes)
        .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)))
        .limit(1);
      const node = nodeRows[0];
      if (node) {
        nodeStatus = node.status;
        providerInstanceId = node.providerInstanceId ?? null;
        if (node.status === 'running') {
          try {
            await teardownDeploymentEnvironmentOnNode(node.id, envId, c.env, userId);
          } catch (err) {
            await db
              .update(schema.deploymentEnvironments)
              .set({
                status: 'error',
                observedStatus: 'failed',
                observedErrorMessage: `Stop failed while tearing down the deployment node: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.deploymentEnvironments.id, envId));
            throw errors.conflict(
              `Could not stop deployment environment on node: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        } else {
          warnings.push(`Deployment node was ${node.status}; skipped live container teardown.`);
        }
      } else {
        warnings.push('Deployment node record was not found; skipped live container teardown.');
      }
    }

    let volumesDetached = 0;
    const volumes = await listEnvironmentVolumes(db, envId);
    const attachedServerIds = new Set<string>();
    for (const volume of volumes) {
      if (volume.attachedServerId) {
        attachedServerIds.add(volume.attachedServerId);
      }
    }
    if (providerInstanceId) {
      attachedServerIds.add(providerInstanceId);
    }

    for (const serverId of attachedServerIds) {
      try {
        const detached = await detachEnvironmentVolumes(db, c.env, userId, envId, serverId);
        volumesDetached += detached.length;
      } catch (err) {
        await db
          .update(schema.deploymentEnvironments)
          .set({
            status: 'error',
            observedStatus: 'failed',
            observedErrorMessage: `Stop failed while detaching deployment volumes: ${
              err instanceof Error ? err.message : String(err)
            }`,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.deploymentEnvironments.id, envId));
        throw errors.conflict(
          `Could not detach deployment volume(s): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    await db
      .update(schema.deploymentEnvironments)
      .set({
        status: 'stopped',
        nodeId: null,
        observedAppliedSeq: null,
        observedStatus: 'stopped',
        observedErrorMessage: null,
        observedServicesJson: '[]',
        observedDeployStatusJson: null,
        observedDiskTelemetryJson: null,
        observedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.deploymentEnvironments.id, envId));

    const nodeCleanup = await cleanupDeploymentNodeIfUnassigned(
      db,
      c.env,
      userId,
      environment.nodeId
    );
    warnings.push(...nodeCleanup.warnings);

    const updated = await requireDeploymentEnvironment(db, projectId, envId);
    log.info('deployment_environment.stopped', {
      projectId,
      envId,
      nodeId: environment.nodeId,
      nodeStatus,
      nodeDeleted: nodeCleanup.nodeDeleted,
      volumesDetached,
      warningCount: warnings.length,
    });

    return c.json({
      environment: await buildDeploymentEnvironmentResponse(db, c.env, updated),
      lifecycle: {
        stopped: true,
        alreadyStopped: false,
        nodeId: environment.nodeId,
        nodeDeleted: nodeCleanup.nodeDeleted,
        volumesDetached,
        warnings,
      },
    });
  }
);

/**
 * POST /api/projects/:projectId/environments/:envId/start
 *
 * Re-provisions or selects a deployment node, reattaches preserved volumes, and
 * lets heartbeat reapply the latest release.
 */
deploymentEnvironmentRoutes.post(
  '/:projectId/environments/:envId/start',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = c.req.param('projectId');
    const envId = c.req.param('envId');
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    await requireOwnedProject(db, projectId, userId);

    const environment = await requireDeploymentEnvironment(db, projectId, envId);
    if (environment.status === 'active') {
      return c.json({
        environment: await buildDeploymentEnvironmentResponse(db, c.env, environment),
        lifecycle: {
          started: true,
          alreadyActive: true,
          nodeId: environment.nodeId,
          provisioningStarted: false,
          volumesAttachScheduled: false,
        },
      });
    }
    if (environment.status === 'starting') {
      return c.json({
        environment: await buildDeploymentEnvironmentResponse(db, c.env, environment),
        lifecycle: {
          started: true,
          alreadyActive: false,
          nodeId: environment.nodeId,
          provisioningStarted: false,
          volumesAttachScheduled: false,
        },
      });
    }
    if (environment.status === 'stopping') {
      throw errors.conflict(
        'Deployment environment is stopping; wait for stop to finish before starting it.'
      );
    }
    if (environment.status !== 'stopped' && environment.status !== 'error') {
      throw errors.conflict(
        `Deployment environment cannot be started from status "${environment.status}".`
      );
    }
    if (environment.nodeId) {
      throw errors.conflict(
        'Deployment environment is still linked to a node. Stop it before starting it again.'
      );
    }

    const latestRows = await db
      .select({ id: schema.deploymentReleases.id, version: schema.deploymentReleases.version })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, envId))
      .orderBy(desc(schema.deploymentReleases.version))
      .limit(1);
    const latestRelease = latestRows[0];
    if (!latestRelease) {
      throw errors.conflict(
        'Deployment environment has no release to start. Publish a release first.'
      );
    }

    const volumes = await listEnvironmentVolumes(db, envId);
    const volumePlacement = resolveVolumePlacementConstraint(volumes);
    const requiresVolumes = environment.requiresVolumes || volumes.length > 0;

    await db
      .update(schema.deploymentEnvironments)
      .set({
        status: 'starting',
        observedStatus: null,
        observedErrorMessage: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.deploymentEnvironments.id, envId));
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'created' })
      .where(eq(schema.deploymentReleases.id, latestRelease.id));

    const result = await provisionDeploymentNode(envId, projectId, userId, c.env, {
      requiresVolumes,
      providerOverride: volumePlacement?.provider,
      vmLocationOverride: volumePlacement?.location,
    });
    if (!result) {
      await markEnvironmentStartFailed(
        db,
        envId,
        'No cloud provider credential was available to start this deployment environment'
      );
      throw errors.conflict('Could not provision a deployment node for this environment.');
    }

    if (result.provisioningStarted) {
      const finishPromise = finishEnvironmentStart(
        db,
        c.env,
        userId,
        envId,
        result.nodeId,
        volumes.length > 0,
        result.provisioningPromise
      ).catch(() => undefined);
      try {
        c.executionCtx.waitUntil(finishPromise);
      } catch {
        // Tests may not provide an ExecutionContext; keep the promise observed.
      }
    } else {
      try {
        await finishEnvironmentStart(
          db,
          c.env,
          userId,
          envId,
          result.nodeId,
          volumes.length > 0,
          result.provisioningPromise
        );
      } catch (err) {
        throw errors.conflict(
          `Could not start deployment environment: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const updated = await requireDeploymentEnvironment(db, projectId, envId);
    log.info('deployment_environment.started', {
      projectId,
      envId,
      nodeId: result.nodeId,
      provisioningStarted: result.provisioningStarted,
      volumeCount: volumes.length,
      latestReleaseVersion: latestRelease.version,
    });

    return c.json({
      environment: await buildDeploymentEnvironmentResponse(db, c.env, updated),
      lifecycle: {
        started: true,
        alreadyActive: false,
        nodeId: result.nodeId,
        provisioningStarted: result.provisioningStarted,
        volumesAttachScheduled: volumes.length > 0 && result.provisioningStarted,
        latestReleaseVersion: latestRelease.version,
      },
    });
  }
);

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
    await requireOwnedProject(db, projectId, userId);

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
            providerInstanceId
          );
          volumesDetached = detached.length;
        } catch (err) {
          throw errors.conflict(
            `Could not detach deployment volume(s): ${err instanceof Error ? err.message : String(err)}`
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

        await db
          .delete(schema.nodes)
          .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)));
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
