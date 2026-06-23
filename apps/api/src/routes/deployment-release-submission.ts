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
import { provisionDeploymentNode } from '../services/deployment-provisioning';

export type CreateDeploymentReleaseResult = {
  id: string;
  environmentId: string;
  version: number;
  status: 'created';
  createdBy: string;
  createdAt: string;
  nodeId: string | null;
};

export type CreateDeploymentReleaseError =
  | { status: 400; body: { error: string; message: string; details?: Record<string, unknown> } };

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
  },
): Promise<CreateDeploymentReleaseOutcome> {
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
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw errors.conflict(
        `Version ${nextVersion} already exists for this environment. Please retry.`,
      );
    }
    throw err;
  }

  const envRow = await db
    .select({ nodeId: schema.deploymentEnvironments.nodeId })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, params.envId))
    .limit(1);

  let nodeId: string | null = envRow[0]?.nodeId ?? null;

  if (!nodeId) {
    try {
      const result = await provisionDeploymentNode(
        params.envId,
        params.projectId,
        params.userId,
        params.env,
      );
      if (result) {
        nodeId = result.nodeId;
        try {
          params.executionCtx?.waitUntil(result.provisioningPromise);
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
