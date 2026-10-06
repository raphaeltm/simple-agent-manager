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
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { collectSecretNames } from '../services/compose-renderer';
import { resolveDeploymentPlacement } from '../services/deployment-provisioning';
import { createMissingManifestVolumes } from '../services/deployment-volumes';
import { recordDeploymentReleaseLifecycleEventBestEffort } from '../services/project-lifecycle-events';
import {
  isPlacementCancellation,
  placeReleaseOnDeploymentNode,
} from './deployment-release-placement';

export {
  DeploymentPlacementCancelledError,
  placeReleaseOnDeploymentNode,
} from './deployment-release-placement';

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
type VolumePreparationOutcome =
  | { success: true; placement: ReleasePlacement | null }
  | { success: false; response: CreateDeploymentReleaseError };

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
