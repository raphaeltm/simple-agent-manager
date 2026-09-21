import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import type { ExecutionContext } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import {
  claimDeploymentEnvironmentRelocation,
  completeDeploymentEnvironmentRelocation,
  type DeploymentNodeResult,
  type DeploymentPlacement,
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
  provisionDeploymentNode,
  restoreDeploymentEnvironmentRelocation,
} from '../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
  markDeploymentReleaseVolumeAttachFailed,
} from '../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../services/node-agent';

type DeploymentReleaseDb = ReturnType<typeof drizzle>;
type ReleasePlacement = DeploymentPlacement;
type ProvisionDeploymentNodeOptions = NonNullable<Parameters<typeof provisionDeploymentNode>[4]>;
class RelocationClaimLostError extends Error {}

export class DeploymentPlacementCancelledError extends Error {}

export function isPlacementCancellation(error: unknown): boolean {
  return (
    error instanceof DeploymentPlacementCancelledError ||
    (error instanceof Error &&
      (error.name === 'AppError' || error.name === 'ProvisioningAuthorityError'))
  );
}

async function assertLatestDeploymentRelease(
  env: Env,
  environmentId: string,
  releaseId: string
): Promise<void> {
  if (typeof env.DATABASE.prepare !== 'function') return;
  const latest = await env.DATABASE.prepare(
    `SELECT id
       FROM deployment_releases
      WHERE environment_id = ?
      ORDER BY version DESC
      LIMIT 1`
  )
    .bind(environmentId)
    .first<{ id: string }>();
  if (latest?.id !== releaseId) {
    throw new DeploymentPlacementCancelledError(
      'A newer deployment release superseded this placement attempt'
    );
  }
}

async function persistStoppedReservationForLatestRelease(params: {
  db: DeploymentReleaseDb;
  env: Env;
  environmentId: string;
  releaseId: string;
  reservation: ResolvedResourceReservation;
}): Promise<void> {
  if (typeof params.env.DATABASE.prepare !== 'function') {
    await params.db
      .update(schema.deploymentEnvironments)
      .set({
        resolvedReservationJson: JSON.stringify(params.reservation),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.deploymentEnvironments.id, params.environmentId));
    return;
  }
  const result = await params.env.DATABASE.prepare(
    `UPDATE deployment_environments
        SET resolved_reservation_json = ?, updated_at = ?
      WHERE id = ? AND node_id IS NULL
        AND ? = (
          SELECT latest.id FROM deployment_releases latest
          WHERE latest.environment_id = deployment_environments.id
          ORDER BY latest.version DESC
          LIMIT 1
        )`
  )
    .bind(
      JSON.stringify(params.reservation),
      new Date().toISOString(),
      params.environmentId,
      params.releaseId
    )
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    await assertLatestDeploymentRelease(params.env, params.environmentId, params.releaseId);
  }
}
async function readEnvironmentRuntimeState(
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

async function markDeploymentReleasePlacementFailed(
  db: DeploymentReleaseDb,
  env: Env,
  environmentId: string,
  releaseId: string,
  error: unknown,
  updateEnvironment = true
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  await db
    .update(schema.deploymentReleases)
    .set({ status: 'failed', statusUpdatedAt: now })
    .where(eq(schema.deploymentReleases.id, releaseId));
  if (updateEnvironment) {
    if (typeof env.DATABASE.prepare === 'function') {
      await env.DATABASE.prepare(
        `UPDATE deployment_environments
            SET status = 'error', observed_status = 'failed',
                observed_error_message = ?, updated_at = ?
          WHERE id = ?
            AND ? = (
              SELECT latest.id FROM deployment_releases latest
              WHERE latest.environment_id = deployment_environments.id
              ORDER BY latest.version DESC
              LIMIT 1
            )`
      )
        .bind(`Deployment node placement failed: ${message}`, now, environmentId, releaseId)
        .run();
    } else {
      await db
        .update(schema.deploymentEnvironments)
        .set({
          status: 'error',
          observedStatus: 'failed',
          observedErrorMessage: `Deployment node placement failed: ${message}`,
          updatedAt: now,
        })
        .where(eq(schema.deploymentEnvironments.id, environmentId));
    }
  }
}

function hasDeploymentPlacementClaim(reservationJson: string | null): boolean {
  if (!reservationJson) return false;
  try {
    const parsed: unknown = JSON.parse(reservationJson);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'samRelocationClaim' in parsed &&
      parsed.samRelocationClaim === true
    );
  } catch {
    return false;
  }
}

async function stopRuntimeBeforeNodeMove(params: {
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
    await detachEnvironmentVolumes(params.db, params.env, params.userId, params.envId, serverId);
  }
}

async function clearSharedNodeForVolumeRelease(
  db: DeploymentReleaseDb,
  env: Env,
  userId: string,
  envId: string,
  nodeId: string | null,
  requiresVolumes: boolean,
  placement: ReleasePlacement | null,
  reservation: ResolvedResourceReservation,
  expectedReservationJson: string | null,
  releaseId: string,
  beforeExternalMutation?: () => Promise<void>
): Promise<string | null> {
  if (!requiresVolumes || !nodeId) {
    return nodeId;
  }

  const nodeRows = await db
    .select({ nodeMode: schema.nodes.nodeMode })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  if (nodeRows[0]?.nodeMode === 'exclusive') {
    return nodeId;
  }

  if (!placement) {
    throw new RelocationClaimLostError('Deployment placement is unavailable for volume migration');
  }
  await beforeExternalMutation?.();
  await assertLatestDeploymentRelease(env, envId, releaseId);
  const relocationClaim = await claimDeploymentEnvironmentRelocation({
    env,
    envId,
    nodeId,
    userId,
    placement,
    expectedReservationJson,
    reservation,
    releaseId,
  });
  if (!relocationClaim) {
    throw new RelocationClaimLostError(
      'Deployment placement changed during volume migration; retry the release'
    );
  }
  try {
    await stopRuntimeBeforeNodeMove({
      db,
      env,
      userId,
      envId,
      nodeId,
      beforeExternalMutation,
    });
    await beforeExternalMutation?.();
    const cleared = await completeDeploymentEnvironmentRelocation({
      env,
      envId,
      nodeId,
      claimJson: relocationClaim,
      releaseId,
    });
    if (!cleared) {
      await beforeExternalMutation?.();
      throw new Error('Deployment relocation claim was lost before volume migration completed');
    }
  } catch (error) {
    await restoreDeploymentEnvironmentRelocation({
      env,
      envId,
      nodeId,
      claimJson: relocationClaim,
      reservationJson: expectedReservationJson,
    });
    throw error;
  }
  return null;
}

function buildProvisionOptions(
  placement: ReleasePlacement | null,
  requiresVolumes: boolean,
  reservation: ResolvedResourceReservation
): ProvisionDeploymentNodeOptions {
  const options: ProvisionDeploymentNodeOptions = { requiresVolumes, reservation };
  if (placement) {
    options.providerOverride = placement.provider;
    options.vmLocationOverride = placement.location;
    options.vmSizeOverride = placement.vmSize;
  }
  return options;
}

async function attachVolumesForRelease(params: {
  db: DeploymentReleaseDb;
  env: Env;
  userId: string;
  envId: string;
  releaseId: string;
  placement: ReleasePlacement | null;
  reservation: ResolvedResourceReservation;
  beforeExternalMutation?: () => Promise<void>;
}): Promise<void> {
  await params.beforeExternalMutation?.();
  if (!params.placement) {
    throw new RelocationClaimLostError('Deployment placement is unavailable for volume attachment');
  }
  const runtime = await readEnvironmentRuntimeState(params.db, params.envId);
  if (!runtime.nodeId) {
    throw new RelocationClaimLostError('Deployment node is unavailable for volume attachment');
  }
  const expectedReservationJson = JSON.stringify(params.reservation);
  const claimJson = await claimDeploymentEnvironmentRelocation({
    env: params.env,
    envId: params.envId,
    nodeId: runtime.nodeId,
    userId: params.userId,
    placement: params.placement,
    expectedReservationJson,
    reservation: params.reservation,
    releaseId: params.releaseId,
  });
  if (!claimJson) {
    await params.beforeExternalMutation?.();
    throw new RelocationClaimLostError('Deployment placement changed before volume attachment');
  }
  const assertAttachmentCurrent = async () => {
    await params.beforeExternalMutation?.();
    if (typeof params.env.DATABASE.prepare !== 'function') return;
    const current = await params.env.DATABASE.prepare(
      `SELECT 1 AS ok
         FROM deployment_environments de
         JOIN nodes n ON n.id = de.node_id
        WHERE de.id = ? AND de.node_id = ?
          AND de.resolved_reservation_json = ?
          AND de.requires_volumes = 1
          AND n.node_role = 'deployment'
          AND n.node_mode = 'exclusive'
          AND ? = (
            SELECT latest.id FROM deployment_releases latest
            WHERE latest.environment_id = de.id
            ORDER BY latest.version DESC
            LIMIT 1
          )
        LIMIT 1`
    )
      .bind(params.envId, runtime.nodeId, claimJson, params.releaseId)
      .first<{ ok: number }>();
    if (!current) {
      throw new DeploymentPlacementCancelledError(
        'Deployment placement changed during volume attachment'
      );
    }
  };
  try {
    await attachEnvironmentVolumesToLinkedNode(params.db, params.env, params.userId, params.envId, {
      assertExternalMutationAuthority: assertAttachmentCurrent,
    });
  } catch (err) {
    if (!isPlacementCancellation(err)) {
      await markDeploymentReleaseVolumeAttachFailed(
        params.db,
        params.envId,
        params.releaseId,
        err,
        params.env
      );
    }
    throw err;
  } finally {
    await restoreDeploymentEnvironmentRelocation({
      env: params.env,
      envId: params.envId,
      nodeId: runtime.nodeId,
      claimJson,
      reservationJson: expectedReservationJson,
    });
  }
}

function observeProvisioningResult(params: {
  result: DeploymentNodeResult;
  requiresVolumes: boolean;
  db: DeploymentReleaseDb;
  env: Env;
  userId: string;
  envId: string;
  releaseId: string;
  placement: ReleasePlacement | null;
  reservation: ResolvedResourceReservation;
  executionCtx?: ExecutionContext;
  beforeExternalMutation?: () => Promise<void>;
}): void {
  if (!params.executionCtx) {
    return;
  }

  const provisioningPromise = params.result.provisioningPromise.catch(async (err) => {
    if (!isPlacementCancellation(err)) {
      await markDeploymentReleasePlacementFailed(
        params.db,
        params.env,
        params.envId,
        params.releaseId,
        err
      );
    }
    throw err;
  });
  const finishPromise = params.requiresVolumes
    ? provisioningPromise.then(() =>
        attachVolumesForRelease({
          db: params.db,
          env: params.env,
          userId: params.userId,
          envId: params.envId,
          releaseId: params.releaseId,
          placement: params.placement,
          reservation: params.reservation,
          beforeExternalMutation: params.beforeExternalMutation,
        })
      )
    : provisioningPromise;
  params.executionCtx.waitUntil(finishPromise.catch(() => undefined));
}

async function provisionNodeForRelease(params: {
  db: DeploymentReleaseDb;
  env: Env;
  envId: string;
  projectId: string;
  userId: string;
  releaseId: string;
  requiresVolumes: boolean;
  placement: ReleasePlacement | null;
  reservation: ResolvedResourceReservation;
  executionCtx?: ExecutionContext;
  beforeExternalMutation?: () => Promise<void>;
}): Promise<string | null> {
  await params.beforeExternalMutation?.();
  try {
    const result = await provisionDeploymentNode(
      params.envId,
      params.projectId,
      params.userId,
      params.env,
      {
        ...buildProvisionOptions(params.placement, params.requiresVolumes, params.reservation),
        releaseId: params.releaseId,
      }
    );
    if (!result) {
      await params.beforeExternalMutation?.();
      await markDeploymentReleasePlacementFailed(
        params.db,
        params.env,
        params.envId,
        params.releaseId,
        'No deployment node could be provisioned'
      );
      return null;
    }
    observeProvisioningResult({ ...params, result });
    return result.nodeId;
  } catch (err) {
    log.error('deployment_release.provisioning_trigger_failed', {
      envId: params.envId,
      releaseId: params.releaseId,
      ...serializeError(err),
    });
    if (isPlacementCancellation(err)) throw err;
    await markDeploymentReleasePlacementFailed(
      params.db,
      params.env,
      params.envId,
      params.releaseId,
      err
    );
    return null;
  }
}

async function attachVolumesToExistingNode(params: {
  db: DeploymentReleaseDb;
  env: Env;
  userId: string;
  envId: string;
  releaseId: string;
  placement: ReleasePlacement | null;
  reservation: ResolvedResourceReservation;
  executionCtx?: ExecutionContext;
  beforeExternalMutation?: () => Promise<void>;
}): Promise<void> {
  const attachPromise = attachVolumesForRelease(params);
  params.executionCtx?.waitUntil(attachPromise);
  await attachPromise.catch((err) => {
    log.error('deployment_release.volume_attach_failed', {
      envId: params.envId,
      releaseId: params.releaseId,
      ...serializeError(err),
    });
    if (isPlacementCancellation(err)) throw err;
  });
}

export async function placeReleaseOnDeploymentNode(params: {
  db: DeploymentReleaseDb;
  env: Env;
  envId: string;
  projectId: string;
  userId: string;
  releaseId: string;
  requiresVolumes: boolean;
  placement: ReleasePlacement | null;
  reservation: ResolvedResourceReservation;
  executionCtx?: ExecutionContext;
  beforeExternalMutation?: () => Promise<void>;
}): Promise<string | null> {
  const runtime = await readEnvironmentRuntimeState(params.db, params.envId);
  const assertPlacementCurrent = async () => {
    await params.beforeExternalMutation?.();
    await assertLatestDeploymentRelease(params.env, params.envId, params.releaseId);
  };
  await assertPlacementCurrent();
  if (hasDeploymentPlacementClaim(runtime.resolvedReservationJson)) {
    throw new DeploymentPlacementCancelledError(
      'Another deployment placement operation is still in progress; retry this release'
    );
  }
  let nodeId: string | null;
  try {
    nodeId = await clearSharedNodeForVolumeRelease(
      params.db,
      params.env,
      params.userId,
      params.envId,
      runtime.nodeId,
      params.requiresVolumes,
      params.placement,
      params.reservation,
      runtime.resolvedReservationJson,
      params.releaseId,
      assertPlacementCurrent
    );
  } catch (err) {
    if (!isPlacementCancellation(err)) {
      await markDeploymentReleasePlacementFailed(
        params.db,
        params.env,
        params.envId,
        params.releaseId,
        err,
        !(err instanceof RelocationClaimLostError)
      );
    }
    throw err;
  }

  const shouldProvision = runtime.status !== 'stopped' && runtime.status !== 'stopping';
  if (!shouldProvision) {
    if (!nodeId) {
      await assertPlacementCurrent();
      await persistStoppedReservationForLatestRelease({
        db: params.db,
        env: params.env,
        environmentId: params.envId,
        releaseId: params.releaseId,
        reservation: params.reservation,
      });
    }
    log.info('deployment_release.provisioning_skipped_environment_stopped', {
      envId: params.envId,
      releaseId: params.releaseId,
      environmentStatus: runtime.status,
    });
    return nodeId;
  }

  if (!nodeId) {
    return provisionNodeForRelease({ ...params, beforeExternalMutation: assertPlacementCurrent });
  }

  if (params.placement) {
    await assertPlacementCurrent();
    const nodeMode = params.requiresVolumes ? 'exclusive' : 'shared';
    const currentNode = await findDeploymentNodeWithCapacity(
      params.env,
      params.userId,
      params.placement,
      params.requiresVolumes,
      { nodeId, excludeEnvironmentId: params.envId, nodeMode }
    );
    const reserved =
      currentNode?.nodeId === nodeId &&
      (await linkEnvironmentToNode({
        env: params.env,
        db: params.db,
        envId: params.envId,
        nodeId,
        placement: currentNode.placement,
        userId: params.userId,
        expectedNodeStatus: 'running',
        nodeMode,
        expectedReservationJson: runtime.resolvedReservationJson,
        releaseId: params.releaseId,
      }));
    if (!reserved) {
      await assertPlacementCurrent();
      if (!params.requiresVolumes) {
        const relocationClaim = await claimDeploymentEnvironmentRelocation({
          env: params.env,
          envId: params.envId,
          nodeId,
          userId: params.userId,
          placement: params.placement,
          expectedReservationJson: runtime.resolvedReservationJson,
          reservation: params.reservation,
          releaseId: params.releaseId,
        });
        if (!relocationClaim) {
          await assertPlacementCurrent();
          await markDeploymentReleasePlacementFailed(
            params.db,
            params.env,
            params.envId,
            params.releaseId,
            'Deployment placement changed during release admission; retry the release',
            false
          );
          return null;
        }
        try {
          await stopRuntimeBeforeNodeMove({
            db: params.db,
            env: params.env,
            userId: params.userId,
            envId: params.envId,
            nodeId,
            beforeExternalMutation: assertPlacementCurrent,
          });
          await assertPlacementCurrent();
          const cleared = await completeDeploymentEnvironmentRelocation({
            env: params.env,
            envId: params.envId,
            nodeId,
            claimJson: relocationClaim,
            releaseId: params.releaseId,
          });
          if (!cleared) {
            await assertPlacementCurrent();
            throw new Error('Deployment relocation claim was lost before placement completed');
          }
        } catch (err) {
          await restoreDeploymentEnvironmentRelocation({
            env: params.env,
            envId: params.envId,
            nodeId,
            claimJson: relocationClaim,
            reservationJson: runtime.resolvedReservationJson,
          });
          if (!isPlacementCancellation(err)) {
            await markDeploymentReleasePlacementFailed(
              params.db,
              params.env,
              params.envId,
              params.releaseId,
              err
            );
          }
          throw err;
        }
        return provisionNodeForRelease({
          ...params,
          beforeExternalMutation: assertPlacementCurrent,
        });
      }
      await assertPlacementCurrent();
      await markDeploymentReleasePlacementFailed(
        params.db,
        params.env,
        params.envId,
        params.releaseId,
        'Existing exclusive deployment node cannot admit the declared resource reservation'
      );
      return null;
    }
  }

  if (params.requiresVolumes) {
    await attachVolumesToExistingNode({
      ...params,
      beforeExternalMutation: assertPlacementCurrent,
    });
  }
  return nodeId;
}
