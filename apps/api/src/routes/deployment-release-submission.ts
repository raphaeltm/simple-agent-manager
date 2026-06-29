import type { DeploymentManifest } from '@simple-agent-manager/shared';
import { desc, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import type { ExecutionContext } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { collectSecretNames } from '../services/compose-renderer';
import {
  type DeploymentNodeResult,
  provisionDeploymentNode,
  resolveDeploymentPlacement,
} from '../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  createMissingManifestVolumes,
  markDeploymentReleaseVolumeAttachFailed,
} from '../services/deployment-volumes';

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
  userId: string;
  env: Env;
  requiresVolumes: boolean;
}): Promise<VolumePreparationOutcome> {
  if (!params.requiresVolumes) {
    return { success: true, placement: null };
  }

  const placement = await resolveDeploymentPlacement(params.userId, params.env);
  if (!placement) {
    return {
      success: false,
      response: {
        status: 400,
        body: {
          error: 'NO_CLOUD_PROVIDER',
          message:
            'No cloud provider credential found. Connect a cloud provider before deploying volumes.',
        },
      },
    };
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
  manifest: DeploymentManifest;
  releaseId: string;
  envId: string;
  userId: string;
  version: number;
  requiresVolumes: boolean;
  now: string;
}): Promise<void> {
  try {
    await params.db.insert(schema.deploymentReleases).values({
      id: params.releaseId,
      environmentId: params.envId,
      manifest: JSON.stringify(params.manifest),
      version: params.version,
      status: 'created',
      createdBy: params.userId,
      createdAt: params.now,
    });
    await params.db
      .update(schema.deploymentEnvironments)
      .set({
        requiresVolumes: params.requiresVolumes,
        updatedAt: params.now,
      })
      .where(eq(schema.deploymentEnvironments.id, params.envId));
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
): Promise<{ nodeId: string | null; status: string | null }> {
  const envRow = await db
    .select({
      nodeId: schema.deploymentEnvironments.nodeId,
      status: schema.deploymentEnvironments.status,
    })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, envId))
    .limit(1);

  return {
    nodeId: envRow[0]?.nodeId ?? null,
    status: envRow[0]?.status ?? null,
  };
}

async function clearSharedNodeForVolumeRelease(
  db: DeploymentReleaseDb,
  envId: string,
  nodeId: string | null,
  requiresVolumes: boolean
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

  await db
    .update(schema.deploymentEnvironments)
    .set({ nodeId: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.deploymentEnvironments.id, envId));
  return null;
}

function buildProvisionOptions(
  placement: ReleasePlacement | null,
  requiresVolumes: boolean
): ProvisionDeploymentNodeOptions {
  const options: ProvisionDeploymentNodeOptions = { requiresVolumes };
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
}): Promise<void> {
  try {
    await attachEnvironmentVolumesToLinkedNode(params.db, params.env, params.userId, params.envId);
  } catch (err) {
    await markDeploymentReleaseVolumeAttachFailed(params.db, params.envId, params.releaseId, err);
    throw err;
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
  executionCtx?: ExecutionContext;
}): void {
  if (!params.executionCtx) {
    return;
  }

  const provisioningPromise = params.requiresVolumes
    ? params.result.provisioningPromise.then(() =>
        attachVolumesForRelease({
          db: params.db,
          env: params.env,
          userId: params.userId,
          envId: params.envId,
          releaseId: params.releaseId,
        })
      )
    : params.result.provisioningPromise;
  params.executionCtx.waitUntil(provisioningPromise.catch(() => undefined));
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
  executionCtx?: ExecutionContext;
}): Promise<string | null> {
  try {
    const result = await provisionDeploymentNode(
      params.envId,
      params.projectId,
      params.userId,
      params.env,
      buildProvisionOptions(params.placement, params.requiresVolumes)
    );
    if (!result) {
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
    return null;
  }
}

async function attachVolumesToExistingNode(params: {
  db: DeploymentReleaseDb;
  env: Env;
  userId: string;
  envId: string;
  releaseId: string;
  executionCtx?: ExecutionContext;
}): Promise<void> {
  const attachPromise = attachVolumesForRelease(params);
  params.executionCtx?.waitUntil(attachPromise);
  await attachPromise.catch((err) => {
    log.error('deployment_release.volume_attach_failed', {
      envId: params.envId,
      releaseId: params.releaseId,
      ...serializeError(err),
    });
  });
}

async function placeReleaseOnDeploymentNode(params: {
  db: DeploymentReleaseDb;
  env: Env;
  envId: string;
  projectId: string;
  userId: string;
  releaseId: string;
  requiresVolumes: boolean;
  placement: ReleasePlacement | null;
  executionCtx?: ExecutionContext;
}): Promise<string | null> {
  const runtime = await readEnvironmentRuntimeState(params.db, params.envId);
  const nodeId = await clearSharedNodeForVolumeRelease(
    params.db,
    params.envId,
    runtime.nodeId,
    params.requiresVolumes
  );

  const shouldProvision = runtime.status !== 'stopped' && runtime.status !== 'stopping';
  if (!shouldProvision) {
    log.info('deployment_release.provisioning_skipped_environment_stopped', {
      envId: params.envId,
      releaseId: params.releaseId,
      environmentStatus: runtime.status,
    });
    return nodeId;
  }

  if (!nodeId) {
    return provisionNodeForRelease(params);
  }

  if (params.requiresVolumes) {
    await attachVolumesToExistingNode(params);
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
    userId: params.userId,
    env: params.env,
    requiresVolumes,
  });
  if (!volumePreparation.success) {
    return { success: false, response: volumePreparation.response };
  }

  await insertDeploymentRelease({
    db,
    manifest,
    releaseId: id,
    envId: params.envId,
    userId: params.userId,
    version: nextVersion,
    requiresVolumes,
    now,
  });

  const nodeId = await placeReleaseOnDeploymentNode({
    db,
    env: params.env,
    envId: params.envId,
    projectId: params.projectId,
    userId: params.userId,
    releaseId: id,
    requiresVolumes,
    placement: volumePreparation.placement,
    executionCtx: params.executionCtx,
  });

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
