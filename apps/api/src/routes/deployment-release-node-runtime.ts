/**
 * Environment runtime reads and the stop-before-move step of release placement
 * (`deployment-release-placement.ts`), kept apart so that file stays under the size limit.
 */
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import { createDeploymentProviderPort } from '../app-deployment-ports/providers';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { DEPLOYMENT_RELOCATION_CLAIM_FIELD } from '../services/deployment-environment-state';
import { detachEnvironmentVolumes, listEnvironmentVolumes } from '../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../services/node-agent';

type DeploymentReleaseDb = ReturnType<typeof drizzle>;

export async function readEnvironmentRuntimeState(
  db: DeploymentReleaseDb,
  envId: string
): Promise<{
  nodeId: string | null;
  status: string | null;
  resolvedReservationJson: string | null;
}> {
  const envRow = await db
    .select({
      nodeId: schema.deploymentEnvironments.nodeId,
      status: schema.deploymentEnvironments.status,
      resolvedReservationJson: schema.deploymentEnvironments.resolvedReservationJson,
    })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, envId))
    .limit(1);

  return {
    nodeId: envRow[0]?.nodeId ?? null,
    status: envRow[0]?.status ?? null,
    resolvedReservationJson: envRow[0]?.resolvedReservationJson ?? null,
  };
}

export function hasDeploymentPlacementClaim(reservationJson: string | null): boolean {
  if (!reservationJson) return false;
  try {
    const parsed: unknown = JSON.parse(reservationJson);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      Reflect.get(parsed, DEPLOYMENT_RELOCATION_CLAIM_FIELD) === true
    );
  } catch {
    return false;
  }
}

export async function stopRuntimeBeforeNodeMove(params: {
  db: DeploymentReleaseDb;
  env: Env;
  envId: string;
  userId: string;
  nodeId: string;
  beforeExternalMutation?: () => Promise<void>;
}): Promise<void> {
  const nodeRows = await params.db
    .select({
      status: schema.nodes.status,
      providerInstanceId: schema.nodes.providerInstanceId,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, params.nodeId))
    .limit(1);
  const node = nodeRows[0];
  if (node?.status === 'running') {
    await params.beforeExternalMutation?.();
    await teardownDeploymentEnvironmentOnNode(
      params.nodeId,
      params.envId,
      params.env,
      params.userId
    );
  }

  const volumes = await listEnvironmentVolumes(params.db, params.envId);
  const attachedServerIds = new Set<string>();
  for (const volume of volumes) {
    if (volume.attachedServerId) {
      attachedServerIds.add(volume.attachedServerId);
    }
  }
  if (node?.providerInstanceId) {
    attachedServerIds.add(node.providerInstanceId);
  }
  for (const serverId of attachedServerIds) {
    await params.beforeExternalMutation?.();
    await detachEnvironmentVolumes(
      params.db,
      createDeploymentProviderPort(params.env),
      params.userId,
      params.envId,
      serverId
    );
  }
}
