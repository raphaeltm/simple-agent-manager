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
import { requireOwnedProject } from '../middleware/project-auth';
import { buildDeploymentEnvironmentResponse } from '../services/deployment-environment-summary';
import { provisionDeploymentNode } from '../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
} from '../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../services/node-agent';
import { deleteNodeResources } from '../services/nodes';

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
}
