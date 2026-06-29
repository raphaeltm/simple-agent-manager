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
  provisionDeploymentNode,
  resolveDeploymentPlacement,
} from '../services/deployment-provisioning';
import {
  attachEnvironmentVolumesToLinkedNode,
  createMissingManifestVolumes,
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

export async function createDeploymentReleaseFromManifest(
  db: ReturnType<typeof drizzle>,
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
  const secretNames = collectSecretNames(manifest);
  if (secretNames.length > 0) {
    const existingSecrets = await db
      .select({ name: schema.deploymentSecrets.name })
      .from(schema.deploymentSecrets)
      .where(eq(schema.deploymentSecrets.environmentId, params.envId));

    const existingNames = new Set(existingSecrets.map((s) => s.name));
    const missing = secretNames.filter((n) => !existingNames.has(n));

    if (missing.length > 0) {
      return {
        success: false,
        response: {
          status: 400,
          body: {
            error: 'MISSING_SECRETS',
            message: `Manifest references secrets that do not exist in this environment: ${missing.join(', ')}. Set these secrets before creating a release.`,
            details: { missingSecrets: missing },
          },
        },
      };
    }
  }

  const latestRelease = await db
    .select({ version: schema.deploymentReleases.version })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, params.envId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  const nextVersion = (latestRelease[0]?.version ?? 0) + 1;
  const id = ulid();
  const now = new Date().toISOString();

  const placement = requiresVolumes
    ? await resolveDeploymentPlacement(params.userId, params.env)
    : null;
  if (requiresVolumes && !placement) {
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

  if (requiresVolumes && placement) {
    await createMissingManifestVolumes(db, params.env, params.userId, {
      environmentId: params.envId,
      manifest,
      location: placement.location,
      targetProvider: placement.provider,
    });
  }

  try {
    await db.insert(schema.deploymentReleases).values({
      id,
      environmentId: params.envId,
      manifest: JSON.stringify(manifest),
      version: nextVersion,
      status: 'created',
      createdBy: params.userId,
      createdAt: now,
    });
    await db
      .update(schema.deploymentEnvironments)
      .set({
        requiresVolumes,
        updatedAt: now,
      })
      .where(eq(schema.deploymentEnvironments.id, params.envId));
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw errors.conflict(
        `Version ${nextVersion} already exists for this environment. Please retry.`
      );
    }
    throw err;
  }

  const envRow = await db
    .select({
      nodeId: schema.deploymentEnvironments.nodeId,
      status: schema.deploymentEnvironments.status,
    })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, params.envId))
    .limit(1);

  let nodeId: string | null = envRow[0]?.nodeId ?? null;
  const shouldProvision = envRow[0]?.status !== 'stopped' && envRow[0]?.status !== 'stopping';
  let currentNodeMode: string | null = null;
  if (requiresVolumes && nodeId) {
    const nodeRows = await db
      .select({ nodeMode: schema.nodes.nodeMode })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .limit(1);
    currentNodeMode = nodeRows[0]?.nodeMode ?? null;
  }
  if (requiresVolumes && nodeId && currentNodeMode !== 'exclusive') {
    await db
      .update(schema.deploymentEnvironments)
      .set({ nodeId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.deploymentEnvironments.id, params.envId));
    nodeId = null;
  }

  if (!shouldProvision) {
    log.info('deployment_release.provisioning_skipped_environment_stopped', {
      envId: params.envId,
      releaseId: id,
      environmentStatus: envRow[0]?.status ?? null,
    });
  } else if (!nodeId) {
    try {
      const result = await provisionDeploymentNode(
        params.envId,
        params.projectId,
        params.userId,
        params.env,
        {
          ...(placement
            ? {
                vmLocationOverride: placement.location,
                vmSizeOverride: placement.vmSize,
              }
            : {}),
          requiresVolumes,
        }
      );
      if (result) {
        nodeId = result.nodeId;
        try {
          const provisioningPromise = requiresVolumes
            ? result.provisioningPromise.then(() =>
                attachEnvironmentVolumesToLinkedNode(db, params.env, params.userId, params.envId)
              )
            : result.provisioningPromise;
          params.executionCtx?.waitUntil(provisioningPromise);
        } catch {
          // No execution context in tests.
        }
      }
    } catch (err) {
      log.error('deployment_release.provisioning_trigger_failed', {
        envId: params.envId,
        releaseId: id,
        ...serializeError(err),
      });
    }
  } else if (requiresVolumes) {
    try {
      const attachPromise = attachEnvironmentVolumesToLinkedNode(
        db,
        params.env,
        params.userId,
        params.envId
      );
      params.executionCtx?.waitUntil(attachPromise);
      await attachPromise;
    } catch (err) {
      log.error('deployment_release.volume_attach_failed', {
        envId: params.envId,
        releaseId: id,
        ...serializeError(err),
      });
    }
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
