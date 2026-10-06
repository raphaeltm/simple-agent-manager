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
  linkEnvironmentToLegacyNode,
  linkEnvironmentToNode,
  provisionDeploymentNode,
  restoreDeploymentEnvironmentRelocation,
} from '../services/deployment-provisioning';
import { markDeploymentReleasePlacementFailed } from '../services/deployment-release-failure';
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
type BeforeExternalMutation = () => Promise<void>;

interface PlaceReleaseOnDeploymentNodeParams {
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
  beforeExternalMutation?: BeforeExternalMutation;
}
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

async function clearSharedNodeForVolumeRelease(params: {
  db: DeploymentReleaseDb;
  env: Env;
  userId: string;
  envId: string;
  nodeId: string | null;
  requiresVolumes: boolean;
  placement: ReleasePlacement | null;
  reservation: ResolvedResourceReservation;
  expectedReservationJson: string | null;
  releaseId: string;
  beforeExternalMutation?: BeforeExternalMutation;
}): Promise<string | null> {
  if (!params.requiresVolumes || !params.nodeId) {
    return params.nodeId;
  }

  const nodeRows = await params.db
    .select({ nodeMode: schema.nodes.nodeMode })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, params.nodeId))
    .limit(1);

  if (nodeRows[0]?.nodeMode === 'exclusive') {
    return params.nodeId;
  }

  if (!params.placement) {
    throw new RelocationClaimLostError('Deployment placement is unavailable for volume migration');
  }
  await params.beforeExternalMutation?.();
  await assertLatestDeploymentRelease(params.env, params.envId, params.releaseId);
  const relocationClaim = await claimDeploymentEnvironmentRelocation({
    env: params.env,
    envId: params.envId,
    nodeId: params.nodeId,
    userId: params.userId,
    placement: params.placement,
    expectedReservationJson: params.expectedReservationJson,
    reservation: params.reservation,
    releaseId: params.releaseId,
  });
  if (!relocationClaim) {
    throw new RelocationClaimLostError(
      'Deployment placement changed during volume migration; retry the release'
    );
  }
  try {
    await stopRuntimeBeforeNodeMove({
      db: params.db,
      env: params.env,
      userId: params.userId,
      envId: params.envId,
      nodeId: params.nodeId,
      beforeExternalMutation: params.beforeExternalMutation,
    });
    await params.beforeExternalMutation?.();
    const cleared = await completeDeploymentEnvironmentRelocation({
      env: params.env,
      envId: params.envId,
      nodeId: params.nodeId,
      claimJson: relocationClaim,
      releaseId: params.releaseId,
    });
    if (!cleared) {
      await params.beforeExternalMutation?.();
      throw new Error('Deployment relocation claim was lost before volume migration completed');
    }
  } catch (error) {
    await restoreDeploymentEnvironmentRelocation({
      env: params.env,
      envId: params.envId,
      nodeId: params.nodeId,
      claimJson: relocationClaim,
      reservationJson: params.expectedReservationJson,
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

async function reserveExistingNodeForRelease(params: {
  release: PlaceReleaseOnDeploymentNodeParams;
  nodeId: string;
  expectedReservationJson: string | null;
  beforeExternalMutation: BeforeExternalMutation;
}): Promise<boolean> {
  if (!params.release.placement) return true;
  await params.beforeExternalMutation();
  const nodeMode = params.release.requiresVolumes ? 'exclusive' : 'shared';
  const currentNode = await findDeploymentNodeWithCapacity(
    params.release.env,
    params.release.userId,
    params.release.placement,
    params.release.requiresVolumes,
    {
      nodeId: params.nodeId,
      excludeEnvironmentId: params.release.envId,
      nodeMode,
    }
  );
  if (currentNode?.nodeId !== params.nodeId) return false;
  return linkEnvironmentToNode({
    env: params.release.env,
    db: params.release.db,
    envId: params.release.envId,
    nodeId: params.nodeId,
    placement: currentNode.placement,
    userId: params.release.userId,
    expectedNodeStatus: 'running',
    nodeMode,
    expectedReservationJson: params.expectedReservationJson,
    releaseId: params.release.releaseId,
  });
}

async function relocateSharedNodeForRelease(params: {
  release: PlaceReleaseOnDeploymentNodeParams & { placement: ReleasePlacement };
  nodeId: string;
  expectedReservationJson: string | null;
  beforeExternalMutation: BeforeExternalMutation;
}): Promise<string | null> {
  const { release } = params;
  const relocationClaim = await claimDeploymentEnvironmentRelocation({
    env: release.env,
    envId: release.envId,
    nodeId: params.nodeId,
    userId: release.userId,
    placement: release.placement,
    expectedReservationJson: params.expectedReservationJson,
    reservation: release.reservation,
    releaseId: release.releaseId,
  });
  if (!relocationClaim) {
    await params.beforeExternalMutation();
    await markDeploymentReleasePlacementFailed(
      release.db,
      release.env,
      release.envId,
      release.releaseId,
      'Deployment placement changed during release admission; retry the release',
      false
    );
    return null;
  }
  try {
    await stopRuntimeBeforeNodeMove({
      db: release.db,
      env: release.env,
      userId: release.userId,
      envId: release.envId,
      nodeId: params.nodeId,
      beforeExternalMutation: params.beforeExternalMutation,
    });
    await params.beforeExternalMutation();
    const cleared = await completeDeploymentEnvironmentRelocation({
      env: release.env,
      envId: release.envId,
      nodeId: params.nodeId,
      claimJson: relocationClaim,
      releaseId: release.releaseId,
    });
    if (!cleared) {
      await params.beforeExternalMutation();
      throw new Error('Deployment relocation claim was lost before placement completed');
    }
  } catch (err) {
    await restoreDeploymentEnvironmentRelocation({
      env: release.env,
      envId: release.envId,
      nodeId: params.nodeId,
      claimJson: relocationClaim,
      reservationJson: params.expectedReservationJson,
    });
    if (!isPlacementCancellation(err)) {
      await markDeploymentReleasePlacementFailed(
        release.db,
        release.env,
        release.envId,
        release.releaseId,
        err
      );
    }
    throw err;
  }
  return provisionNodeForRelease({
    ...release,
    beforeExternalMutation: params.beforeExternalMutation,
  });
}

async function handleExistingNodeReservationFailure(params: {
  release: PlaceReleaseOnDeploymentNodeParams;
  nodeId: string;
  expectedReservationJson: string | null;
  beforeExternalMutation: BeforeExternalMutation;
}): Promise<string | null> {
  await params.beforeExternalMutation();
  if (!params.release.requiresVolumes && params.release.placement) {
    return relocateSharedNodeForRelease({
      ...params,
      release: { ...params.release, placement: params.release.placement },
    });
  }
  await markDeploymentReleasePlacementFailed(
    params.release.db,
    params.release.env,
    params.release.envId,
    params.release.releaseId,
    'Existing exclusive deployment node cannot admit the declared resource reservation'
  );
  return null;
}

export async function placeReleaseOnDeploymentNode(
  params: PlaceReleaseOnDeploymentNodeParams
): Promise<string | null> {
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
    nodeId = await clearSharedNodeForVolumeRelease({
      db: params.db,
      env: params.env,
      userId: params.userId,
      envId: params.envId,
      nodeId: runtime.nodeId,
      requiresVolumes: params.requiresVolumes,
      placement: params.placement,
      reservation: params.reservation,
      expectedReservationJson: runtime.resolvedReservationJson,
      releaseId: params.releaseId,
      beforeExternalMutation: assertPlacementCurrent,
    });
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

  const reserved = await reserveExistingNodeForRelease({
    release: params,
    nodeId,
    expectedReservationJson: runtime.resolvedReservationJson,
    beforeExternalMutation: assertPlacementCurrent,
  });
  let adoptedLegacyNode = false;
  if (!reserved) {
    // Pre-node-pool deployment nodes carry no pooled placement identity and no
    // trusted observed hardware, so capacity-aware admission can never readmit
    // them. An environment already running on one keeps deploying there.
    await assertPlacementCurrent();
    adoptedLegacyNode = await linkEnvironmentToLegacyNode({
      env: params.env,
      envId: params.envId,
      nodeId,
      userId: params.userId,
      releaseId: params.releaseId,
      requiresVolumes: params.requiresVolumes,
      reservation: params.reservation,
      expectedReservationJson: runtime.resolvedReservationJson,
    });
    if (!adoptedLegacyNode) {
      return handleExistingNodeReservationFailure({
        release: params,
        nodeId,
        expectedReservationJson: runtime.resolvedReservationJson,
        beforeExternalMutation: assertPlacementCurrent,
      });
    }
  }

  if (params.requiresVolumes && adoptedLegacyNode) {
    // A legacy node has `workload_role` NULL, which `buildPlacementAuthoritySqlPredicate`
    // can never match, so `claimDeploymentEnvironmentRelocation` cannot issue the claim
    // `attachVolumesForRelease` needs. Legacy adoption instead relies on the volumes that
    // are already attached to the node's provider instance — exactly what the heartbeat's
    // `deploymentVolumesReadyForNode` gate checks before advertising the release.
    log.info('deployment_release.legacy_node_volume_attach_skipped', {
      envId: params.envId,
      nodeId,
      releaseId: params.releaseId,
    });
  } else if (params.requiresVolumes) {
    await attachVolumesToExistingNode({
      ...params,
      beforeExternalMutation: assertPlacementCurrent,
    });
  }
  return nodeId;
}
