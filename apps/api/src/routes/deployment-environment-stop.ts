/**
 * Stopping a deployment environment: tear down its containers on the linked node, detach its
 * provider volumes, and record the result. Split from `deployment-environment-lifecycle.ts`
 * (file size limit), which keeps the stop and start orchestration and the routes.
 *
 * Every stop failure message starts with `DEPLOYMENT_STOP_ERROR_PREFIX`, which the
 * Deployments page reads to tell a pause that didn't finish from a start that didn't.
 */
import { DEPLOYMENT_STOP_ERROR_PREFIX } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { detachEnvironmentVolumes } from '../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../services/node-agent';

export type DeploymentDb = ReturnType<typeof drizzle<typeof schema>>;

export function lifecycleErrorMessage(error: unknown): string {
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

export async function teardownLinkedDeploymentNode(
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
        `${DEPLOYMENT_STOP_ERROR_PREFIX} because the linked deployment node record was not found; refusing to detach volumes without live teardown.`
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
        `${DEPLOYMENT_STOP_ERROR_PREFIX} because the deployment node was ${node.status}; refusing to detach volumes without live teardown.`
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
      `${DEPLOYMENT_STOP_ERROR_PREFIX} while tearing down the deployment node: ${message}`
    );
    throw errors.conflict(`Could not stop deployment environment on node: ${message}`);
  }
}

export function collectAttachedServerIds(
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

export function hasAttachedVolumes(volumes: schema.DeploymentVolumeRow[]): boolean {
  return volumes.some((volume) => Boolean(volume.attachedServerId));
}

export async function detachVolumesForEnvironmentStop(
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
        `${DEPLOYMENT_STOP_ERROR_PREFIX} while detaching deployment volumes: ${message}`
      );
      throw errors.conflict(`Could not detach deployment volume(s): ${message}`);
    }
  }
  return volumesDetached;
}

export async function markEnvironmentStopped(db: DeploymentDb, envId: string): Promise<void> {
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
