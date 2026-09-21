import {
  DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS,
  DEFAULT_DEPLOYMENT_SERVICE_DISK_MB,
  DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB,
  type DeploymentManifest,
  resolveDeploymentManifestReservation,
  type ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { desc, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import type { ExecutionContext } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { collectSecretNames } from '../services/compose-renderer';
import {
  claimDeploymentEnvironmentRelocation,
  completeDeploymentEnvironmentRelocation,
  type DeploymentNodeResult,
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
  provisionDeploymentNode,
  resolveDeploymentPlacement,
  restoreDeploymentEnvironmentRelocation,
} from '../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  createMissingManifestVolumes,
  detachEnvironmentVolumes,
  listEnvironmentVolumes,
  markDeploymentReleaseVolumeAttachFailed,
} from '../services/deployment-volumes';
import { teardownDeploymentEnvironmentOnNode } from '../services/node-agent';
import { recordDeploymentReleaseLifecycleEventBestEffort } from '../services/project-lifecycle-events';

export type CreateDeploymentReleaseResult = {
  id: string;
  environmentId: string;
  version: number;
  status: 'created';
  createdBy: string;
  createdAt: string;
  nodeId: string | null;
};

export type CreateDeploymentReleaseError = {
  status: 400;
  body: { error: string; message: string; details?: Record<string, unknown> };
};

export type CreateDeploymentReleaseOutcome =
  | { success: true; body: CreateDeploymentReleaseResult }
  | { success: false; response: CreateDeploymentReleaseError };

type DeploymentReleaseDb = ReturnType<typeof drizzle>;
type ReleasePlacement = NonNullable<Awaited<ReturnType<typeof resolveDeploymentPlacement>>>;
type ProvisionDeploymentNodeOptions = NonNullable<Parameters<typeof provisionDeploymentNode>[4]>;

type VolumePreparationOutcome =
  | { success: true; placement: ReleasePlacement | null }
  | { success: false; response: CreateDeploymentReleaseError };

class RelocationClaimLostError extends Error {}

export class DeploymentPlacementCancelledError extends Error {}

function isPlacementCancellation(error: unknown): boolean {
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

export async function updateDeploymentEnvironmentForLatestRelease(params: {
  db: DeploymentReleaseDb;
  env: Env;
  environmentId: string;
  releaseId: string;
  requiresVolumes: boolean;
  updatedAt: string;
}): Promise<boolean> {
  if (typeof params.env.DATABASE.prepare !== 'function') {
    await params.db
      .update(schema.deploymentEnvironments)
      .set({ requiresVolumes: params.requiresVolumes, updatedAt: params.updatedAt })
      .where(eq(schema.deploymentEnvironments.id, params.environmentId));
    return true;
  }
  const result = await params.env.DATABASE.prepare(
    `UPDATE deployment_environments
        SET requires_volumes = ?, updated_at = ?
      WHERE id = ?
        AND ? = (
          SELECT latest.id FROM deployment_releases latest
          WHERE latest.environment_id = deployment_environments.id
          ORDER BY latest.version DESC
          LIMIT 1
        )`
  )
    .bind(params.requiresVolumes ? 1 : 0, params.updatedAt, params.environmentId, params.releaseId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function insertDeploymentReleaseWhilePlacementUnlocked(params: {
  db: DeploymentReleaseDb;
  env: Env;
  values: {
    id: string;
    environmentId: string;
    manifest: string;
    version: number;
    status: string;
    statusUpdatedAt: string;
    source?: string;
    createdBy: string;
    createdAt: string;
  };
}): Promise<boolean> {
  if (typeof params.env.DATABASE.prepare !== 'function') {
    await params.db.insert(schema.deploymentReleases).values(params.values);
    return true;
  }
  const result = await params.env.DATABASE.prepare(
    `INSERT INTO deployment_releases
       (id, environment_id, manifest, version, status, status_updated_at, source, created_by, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM deployment_environments de
        WHERE de.id = ?
          AND CASE
            WHEN json_valid(de.resolved_reservation_json)
            THEN COALESCE(json_extract(de.resolved_reservation_json, '$.samRelocationClaim'), 0)
            ELSE 0
          END = 0
      )`
  )
    .bind(
      params.values.id,
      params.values.environmentId,
      params.values.manifest,
      params.values.version,
      params.values.status,
      params.values.statusUpdatedAt,
      params.values.source ?? null,
      params.values.createdBy,
      params.values.createdAt,
      params.values.environmentId
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function validateManifestSecrets(
  db: DeploymentReleaseDb,
  manifest: DeploymentManifest,
  envId: string
): Promise<CreateDeploymentReleaseError | null> {
  const secretNames = collectSecretNames(manifest);
  if (secretNames.length === 0) {
    return null;
  }

  const existingSecrets = await db
    .select({ name: schema.deploymentSecrets.name })
    .from(schema.deploymentSecrets)
    .where(eq(schema.deploymentSecrets.environmentId, envId));

  const existingNames = new Set(existingSecrets.map((s) => s.name));
  const missing = secretNames.filter((n) => !existingNames.has(n));
  if (missing.length === 0) {
    return null;
  }

  return {
    status: 400,
    body: {
      error: 'MISSING_SECRETS',
      message: `Manifest references secrets that do not exist in this environment: ${missing.join(', ')}. Set these secrets before creating a release.`,
      details: { missingSecrets: missing },
    },
  };
}

async function prepareManifestVolumes(params: {
  db: DeploymentReleaseDb;
  manifest: DeploymentManifest;
  envId: string;
  projectId: string;
  userId: string;
  env: Env;
  requiresVolumes: boolean;
  reservation: ResolvedResourceReservation;
}): Promise<VolumePreparationOutcome> {
  const placement = await resolveDeploymentPlacement(params.userId, params.env, params.projectId, {
    reservation: params.reservation,
  });
  if (!placement) {
    return {
      success: false,
      response: {
        status: 400,
        body: {
          error: 'NO_CLOUD_PROVIDER',
          message:
            'No cloud provider credential found. Connect a cloud provider before deploying applications.',
        },
      },
    };
  }

  if (!params.requiresVolumes) {
    return { success: true, placement };
  }

  await createMissingManifestVolumes(params.db, params.env, params.userId, {
    environmentId: params.envId,
    manifest: params.manifest,
    location: placement.location,
    targetProvider: placement.provider,
  });

  return { success: true, placement };
}

async function readNextReleaseVersion(db: DeploymentReleaseDb, envId: string): Promise<number> {
  const latestRelease = await db
    .select({ version: schema.deploymentReleases.version })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, envId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  return (latestRelease[0]?.version ?? 0) + 1;
}

async function insertDeploymentRelease(params: {
  db: DeploymentReleaseDb;
  env: Env;
  manifest: DeploymentManifest;
  releaseId: string;
  envId: string;
  userId: string;
  version: number;
  requiresVolumes: boolean;
  now: string;
}): Promise<void> {
  try {
    const inserted = await insertDeploymentReleaseWhilePlacementUnlocked({
      db: params.db,
      env: params.env,
      values: {
        id: params.releaseId,
        environmentId: params.envId,
        manifest: JSON.stringify(params.manifest),
        version: params.version,
        status: 'created',
        statusUpdatedAt: params.now,
        createdBy: params.userId,
        createdAt: params.now,
      },
    });
    if (!inserted) {
      throw errors.conflict(
        'Another deployment placement operation is in progress. Please retry this release.'
      );
    }
    await updateDeploymentEnvironmentForLatestRelease({
      db: params.db,
      env: params.env,
      environmentId: params.envId,
      releaseId: params.releaseId,
      requiresVolumes: params.requiresVolumes,
      updatedAt: params.now,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw errors.conflict(
        `Version ${params.version} already exists for this environment. Please retry.`
      );
    }
    throw err;
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

export async function createDeploymentReleaseFromManifest(
  db: DeploymentReleaseDb,
  manifest: DeploymentManifest,
  params: {
    envId: string;
    projectId: string;
    userId: string;
    env: Env;
    executionCtx?: ExecutionContext;
  }
): Promise<CreateDeploymentReleaseOutcome> {
  const requiresVolumes = Object.keys(manifest.volumes).length > 0;
  const reservation = resolveDeploymentManifestReservation(manifest, params.envId, {
    cpuMillis: parsePositiveInt(
      params.env.DEPLOYMENT_DEFAULT_CPU_LIMIT_MILLIS,
      DEFAULT_DEPLOYMENT_SERVICE_CPU_MILLIS
    ),
    memoryMb: parsePositiveInt(
      params.env.DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB,
      DEFAULT_DEPLOYMENT_SERVICE_MEMORY_MB
    ),
    diskMb: parsePositiveInt(
      params.env.DEPLOYMENT_DEFAULT_ROOT_DISK_MB,
      DEFAULT_DEPLOYMENT_SERVICE_DISK_MB
    ),
  });
  const secretError = await validateManifestSecrets(db, manifest, params.envId);
  if (secretError) {
    return { success: false, response: secretError };
  }

  const nextVersion = await readNextReleaseVersion(db, params.envId);
  const id = ulid();
  const now = new Date().toISOString();

  const volumePreparation = await prepareManifestVolumes({
    db,
    manifest,
    envId: params.envId,
    projectId: params.projectId,
    userId: params.userId,
    env: params.env,
    requiresVolumes,
    reservation,
  });
  if (!volumePreparation.success) {
    return { success: false, response: volumePreparation.response };
  }

  await insertDeploymentRelease({
    db,
    env: params.env,
    manifest,
    releaseId: id,
    envId: params.envId,
    userId: params.userId,
    version: nextVersion,
    requiresVolumes,
    now,
  });

  const releaseCreatedEvent = recordDeploymentReleaseLifecycleEventBestEffort(params.env, {
    projectId: params.projectId,
    releaseId: id,
    environmentId: params.envId,
    status: 'created',
    version: nextVersion,
    source: 'deployment_release_submission.create',
    occurredAt: now,
  });
  if (params.executionCtx) {
    params.executionCtx.waitUntil(releaseCreatedEvent);
  } else {
    await releaseCreatedEvent;
  }

  let nodeId: string | null;
  try {
    nodeId = await placeReleaseOnDeploymentNode({
      db,
      env: params.env,
      envId: params.envId,
      projectId: params.projectId,
      userId: params.userId,
      releaseId: id,
      requiresVolumes,
      placement: volumePreparation.placement,
      reservation,
      executionCtx: params.executionCtx,
    });
  } catch (error) {
    if (!isPlacementCancellation(error)) throw error;
    nodeId = null;
  }

  return {
    success: true,
    body: {
      id,
      environmentId: params.envId,
      version: nextVersion,
      status: 'created',
      createdBy: params.userId,
      createdAt: now,
      nodeId,
    },
  };
}
