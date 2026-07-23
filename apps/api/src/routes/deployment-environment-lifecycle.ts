/**
 * Deployment environment lifecycle routes.
 *
 * Stop/start preserves environment configuration, releases, custom domains, and
 * provider volumes while tearing down or restoring the runtime node placement.
 */

import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { buildDeploymentEnvironmentResponse } from '../services/deployment-environment-summary';
import { provisionDeploymentNode } from '../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
} from '../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../services/node-agent';
import { deleteNodeResources, retireDeletedDeploymentNodeRecord } from '../services/nodes';

type DeploymentDb = ReturnType<typeof drizzle<typeof schema>>;

interface LastNodeCleanupResult {
  nodeDeleted: boolean;
  warnings: string[];
}

interface VolumePlacementConstraint {
  provider: CredentialProvider;
  location: string;
}

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

async function cleanupDeploymentNodeIfUnassigned(
  db: DeploymentDb,
  env: Env,
  userId: string,
  nodeId: string | null
): Promise<LastNodeCleanupResult> {
  if (!nodeId) {
    return { nodeDeleted: false, warnings: [] };
  }
  if (typeof env.DATABASE.prepare !== 'function') {
    return { nodeDeleted: false, warnings: [] };
  }

  const claim = await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = 'deleting', updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND node_role = 'deployment'
       AND node_class != 'user-owned'
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

  await retireDeletedDeploymentNodeRecord(db, nodeId, userId);
  return { nodeDeleted: cleanup.nodeFound, warnings: [] };
}

export function resolveVolumePlacementConstraint(
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
  error: unknown,
  opts: { nodeId?: string; latestReleaseId?: string } = {}
): Promise<void> {
  const updates: Partial<schema.NewDeploymentEnvironmentRow> = {
    status: 'error',
    observedStatus: 'failed',
    observedErrorMessage: lifecycleErrorMessage(error),
    updatedAt: new Date().toISOString(),
  };
  if (opts.nodeId !== undefined) {
    updates.nodeId = null;
  }

  await db
    .update(schema.deploymentEnvironments)
    .set(updates)
    .where(eq(schema.deploymentEnvironments.id, envId));
  if (opts.latestReleaseId) {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'failed' })
      .where(eq(schema.deploymentReleases.id, opts.latestReleaseId));
  }
}

async function readLifecycleNode(
  db: DeploymentDb,
  userId: string,
  nodeId: string
): Promise<{ providerInstanceId: string | null } | null> {
  const rows = await db
    .select({ providerInstanceId: schema.nodes.providerInstanceId })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function cleanupFailedEnvironmentStart(params: {
  db: DeploymentDb;
  env: Env;
  userId: string;
  envId: string;
  nodeId: string;
  latestReleaseId: string;
  error: unknown;
}): Promise<void> {
  const { db, env, userId, envId, nodeId, latestReleaseId, error } = params;
  const node = await readLifecycleNode(db, userId, nodeId);
  const volumes = await listEnvironmentVolumes(db, envId);
  const serverIds = collectAttachedServerIds(volumes, node?.providerInstanceId ?? null);

  for (const serverId of serverIds) {
    try {
      await detachEnvironmentVolumes(db, env, userId, envId, serverId);
    } catch (detachErr) {
      log.warn('deployment_environment.start_failed_volume_detach_failed', {
        envId,
        nodeId,
        serverId,
        error: lifecycleErrorMessage(detachErr),
      });
    }
  }

  await markEnvironmentStartFailed(db, envId, error, { nodeId, latestReleaseId });
  await cleanupDeploymentNodeIfUnassigned(db, env, userId, nodeId);
}

async function finishEnvironmentStart(
  db: DeploymentDb,
  env: Env,
  userId: string,
  envId: string,
  nodeId: string,
  latestReleaseId: string,
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
    try {
      await cleanupFailedEnvironmentStart({
        db,
        env,
        userId,
        envId,
        nodeId,
        latestReleaseId,
        error: err,
      });
    } catch (cleanupErr) {
      log.error('deployment_environment.start_failed_cleanup_failed', {
        envId,
        nodeId,
        error: lifecycleErrorMessage(cleanupErr),
      });
      await markEnvironmentStartFailed(db, envId, err, { nodeId, latestReleaseId });
    }
    throw err;
  }
}

function lifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markEnvironmentStopFailed(
  db: DeploymentDb,
  envId: string,
  observedErrorMessage: string
): Promise<void> {
  await db
    .update(schema.deploymentEnvironments)
    .set({
      status: 'error',
      observedStatus: 'failed',
      observedErrorMessage,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.deploymentEnvironments.id, envId));
}

async function teardownLinkedDeploymentNode(
  db: DeploymentDb,
  env: Env,
  userId: string,
  envId: string,
  nodeId: string | null,
  opts: { requireLiveTeardownBeforeDetach?: boolean } = {}
): Promise<{ providerInstanceId: string | null; nodeStatus: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  if (!nodeId) {
    if (opts.requireLiveTeardownBeforeDetach) {
      warnings.push('No deployment node is linked; detaching stale provider volumes only.');
    }
    return { providerInstanceId: null, nodeStatus: null, warnings };
  }

  const nodeRows = await db
    .select({
      id: schema.nodes.id,
      status: schema.nodes.status,
      providerInstanceId: schema.nodes.providerInstanceId,
    })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);
  const node = nodeRows[0];
  if (!node) {
    if (opts.requireLiveTeardownBeforeDetach) {
      await markEnvironmentStopFailed(
        db,
        envId,
        'Stop failed because the linked deployment node record was not found; refusing to detach volumes without live teardown.'
      );
      throw errors.conflict(
        'Cannot safely stop deployment environment: linked deployment node record was not found, so volumes were not detached.'
      );
    }
    warnings.push('Deployment node record was not found; skipped live container teardown.');
    return { providerInstanceId: null, nodeStatus: null, warnings };
  }

  if (node.status !== 'running') {
    if (opts.requireLiveTeardownBeforeDetach) {
      await markEnvironmentStopFailed(
        db,
        envId,
        `Stop failed because the deployment node was ${node.status}; refusing to detach volumes without live teardown.`
      );
      throw errors.conflict(
        `Cannot safely stop deployment environment: deployment node is ${node.status}, so volumes were not detached.`
      );
    }
    warnings.push(`Deployment node was ${node.status}; skipped live container teardown.`);
    return {
      providerInstanceId: node.providerInstanceId ?? null,
      nodeStatus: node.status,
      warnings,
    };
  }

  try {
    await teardownDeploymentEnvironmentOnNode(node.id, envId, env, userId);
    return {
      providerInstanceId: node.providerInstanceId ?? null,
      nodeStatus: node.status,
      warnings,
    };
  } catch (err) {
    const message = lifecycleErrorMessage(err);
    await markEnvironmentStopFailed(
      db,
      envId,
      `Stop failed while tearing down the deployment node: ${message}`
    );
    throw errors.conflict(`Could not stop deployment environment on node: ${message}`);
  }
}

function collectAttachedServerIds(
  volumes: schema.DeploymentVolumeRow[],
  providerInstanceId: string | null
): string[] {
  const attachedServerIds = new Set<string>();
  for (const volume of volumes) {
    if (volume.attachedServerId) {
      attachedServerIds.add(volume.attachedServerId);
    }
  }
  if (providerInstanceId) {
    attachedServerIds.add(providerInstanceId);
  }
  return [...attachedServerIds];
}

function hasAttachedVolumes(volumes: schema.DeploymentVolumeRow[]): boolean {
  return volumes.some((volume) => Boolean(volume.attachedServerId));
}

async function detachVolumesForEnvironmentStop(
  db: DeploymentDb,
  env: Env,
  userId: string,
  envId: string,
  serverIds: string[]
): Promise<number> {
  let volumesDetached = 0;
  for (const serverId of serverIds) {
    try {
      const detached = await detachEnvironmentVolumes(db, env, userId, envId, serverId);
      volumesDetached += detached.length;
    } catch (err) {
      const message = lifecycleErrorMessage(err);
      await markEnvironmentStopFailed(
        db,
        envId,
        `Stop failed while detaching deployment volumes: ${message}`
      );
      throw errors.conflict(`Could not detach deployment volume(s): ${message}`);
    }
  }
  return volumesDetached;
}

async function markEnvironmentStopped(db: DeploymentDb, envId: string): Promise<void> {
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
}

async function stopDeploymentEnvironment(params: {
  db: DeploymentDb;
  env: Env;
  userId: string;
  projectId: string;
  envId: string;
}) {
  const { db, env, userId, projectId, envId } = params;
  const environment = await requireDeploymentEnvironment(db, projectId, envId);
  if (environment.status === 'stopped') {
    return {
      environment: await buildDeploymentEnvironmentResponse(db, env, environment),
      lifecycle: {
        stopped: true,
        alreadyStopped: true,
        nodeId: environment.nodeId,
        nodeDeleted: false,
        volumesDetached: 0,
        warnings: [],
      },
    };
  }
  if (environment.status === 'stopping' || environment.status === 'starting') {
    throw errors.conflict(
      `Deployment environment is already ${environment.status}; wait for that lifecycle operation to finish.`
    );
  }

  const volumes = await listEnvironmentVolumes(db, envId);
  const attachedVolumes = hasAttachedVolumes(volumes);

  await db
    .update(schema.deploymentEnvironments)
    .set({ status: 'stopping', updatedAt: new Date().toISOString() })
    .where(eq(schema.deploymentEnvironments.id, envId));

  const teardown = await teardownLinkedDeploymentNode(db, env, userId, envId, environment.nodeId, {
    requireLiveTeardownBeforeDetach: attachedVolumes,
  });
  const volumesDetached = await detachVolumesForEnvironmentStop(
    db,
    env,
    userId,
    envId,
    collectAttachedServerIds(volumes, teardown.providerInstanceId)
  );

  await markEnvironmentStopped(db, envId);

  const nodeCleanup = await cleanupDeploymentNodeIfUnassigned(db, env, userId, environment.nodeId);
  const warnings = [...teardown.warnings, ...nodeCleanup.warnings];
  const updated = await requireDeploymentEnvironment(db, projectId, envId);
  log.info('deployment_environment.stopped', {
    projectId,
    envId,
    nodeId: environment.nodeId,
    nodeStatus: teardown.nodeStatus,
    nodeDeleted: nodeCleanup.nodeDeleted,
    volumesDetached,
    warningCount: warnings.length,
  });

  return {
    environment: await buildDeploymentEnvironmentResponse(db, env, updated),
    lifecycle: {
      stopped: true,
      alreadyStopped: false,
      nodeId: environment.nodeId,
      nodeDeleted: nodeCleanup.nodeDeleted,
      volumesDetached,
      warnings,
    },
  };
}

async function readLatestRelease(db: DeploymentDb, envId: string) {
  const latestRows = await db
    .select({ id: schema.deploymentReleases.id, version: schema.deploymentReleases.version })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, envId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);
  return latestRows[0] ?? null;
}

function assertEnvironmentCanStart(environment: schema.DeploymentEnvironmentRow): void {
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
}

async function markEnvironmentStarting(
  db: DeploymentDb,
  envId: string,
  latestReleaseId: string
): Promise<void> {
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
    .where(eq(schema.deploymentReleases.id, latestReleaseId));
}

async function finishProvisionedEnvironmentStart(params: {
  db: DeploymentDb;
  env: Env;
  userId: string;
  envId: string;
  nodeId: string;
  latestReleaseId: string;
  shouldAttachVolumes: boolean;
  provisioningStarted: boolean;
  provisioningPromise: Promise<void>;
  executionCtx: Pick<ExecutionContext, 'waitUntil'>;
}): Promise<void> {
  const finishPromise = finishEnvironmentStart(
    params.db,
    params.env,
    params.userId,
    params.envId,
    params.nodeId,
    params.latestReleaseId,
    params.shouldAttachVolumes,
    params.provisioningPromise
  );

  if (params.provisioningStarted) {
    try {
      params.executionCtx.waitUntil(finishPromise.catch(() => undefined));
    } catch {
      // Tests may not provide an ExecutionContext; keep the promise observed.
    }
    return;
  }

  try {
    await finishPromise;
  } catch (err) {
    throw errors.conflict(`Could not start deployment environment: ${lifecycleErrorMessage(err)}`);
  }
}

async function startDeploymentEnvironment(params: {
  db: DeploymentDb;
  env: Env;
  userId: string;
  projectId: string;
  envId: string;
  executionCtx: Pick<ExecutionContext, 'waitUntil'>;
}) {
  const { db, env, userId, projectId, envId } = params;
  const environment = await requireDeploymentEnvironment(db, projectId, envId);
  if (environment.status === 'active' || environment.status === 'starting') {
    return {
      environment: await buildDeploymentEnvironmentResponse(db, env, environment),
      lifecycle: {
        started: true,
        alreadyActive: environment.status === 'active',
        nodeId: environment.nodeId,
        provisioningStarted: false,
        volumesAttachScheduled: false,
      },
    };
  }

  assertEnvironmentCanStart(environment);
  const latestRelease = await readLatestRelease(db, envId);
  if (!latestRelease) {
    throw errors.conflict(
      'Deployment environment has no release to start. Publish a release first.'
    );
  }

  const volumes = await listEnvironmentVolumes(db, envId);
  if (environment.requiresVolumes && volumes.length === 0) {
    throw errors.conflict(
      'Deployment environment requires persistent volumes, but no volume records exist. Restore or recreate the declared volumes before starting.'
    );
  }
  const volumePlacement = resolveVolumePlacementConstraint(volumes);
  const requiresVolumes = environment.requiresVolumes || volumes.length > 0;

  await markEnvironmentStarting(db, envId, latestRelease.id);

  const result = await provisionDeploymentNode(envId, projectId, userId, env, {
    requiresVolumes,
    providerOverride: volumePlacement?.provider,
    vmLocationOverride: volumePlacement?.location,
  });
  if (!result) {
    await markEnvironmentStartFailed(
      db,
      envId,
      'No cloud provider credential was available to start this deployment environment',
      { latestReleaseId: latestRelease.id }
    );
    throw errors.conflict('Could not provision a deployment node for this environment.');
  }

  await finishProvisionedEnvironmentStart({
    db,
    env,
    userId,
    envId,
    nodeId: result.nodeId,
    latestReleaseId: latestRelease.id,
    shouldAttachVolumes: volumes.length > 0,
    provisioningStarted: result.provisioningStarted,
    provisioningPromise: result.provisioningPromise,
    executionCtx: params.executionCtx,
  });

  const updated = await requireDeploymentEnvironment(db, projectId, envId);
  log.info('deployment_environment.started', {
    projectId,
    envId,
    nodeId: result.nodeId,
    provisioningStarted: result.provisioningStarted,
    volumeCount: volumes.length,
    latestReleaseVersion: latestRelease.version,
  });

  return {
    environment: await buildDeploymentEnvironmentResponse(db, env, updated),
    lifecycle: {
      started: true,
      alreadyActive: false,
      nodeId: result.nodeId,
      provisioningStarted: result.provisioningStarted,
      volumesAttachScheduled: volumes.length > 0 && result.provisioningStarted,
      latestReleaseVersion: latestRelease.version,
    },
  };
}

export function registerDeploymentEnvironmentLifecycleRoutes(
  deploymentEnvironmentRoutes: Hono<{ Bindings: Env }>
): void {
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
      await requireProjectCapability(db, projectId, userId, 'deployment:manage');
      const result = await stopDeploymentEnvironment({
        db,
        env: c.env,
        userId,
        projectId,
        envId,
      });
      return c.json(result);
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
      await requireProjectCapability(db, projectId, userId, 'deployment:manage');
      let executionCtx: Pick<ExecutionContext, 'waitUntil'>;
      try {
        executionCtx = c.executionCtx;
      } catch {
        executionCtx = { waitUntil: () => undefined };
      }
      const result = await startDeploymentEnvironment({
        db,
        env: c.env,
        userId,
        projectId,
        envId,
        executionCtx,
      });
      return c.json(result);
    }
  );
}
