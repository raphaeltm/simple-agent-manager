/**
 * Deployment node provisioning service.
 *
 * Provisions a node for a deployment environment when the first release is
 * submitted. Uses the authenticated user's cloud provider credentials via
 * the shared Provider interface (no provider-specific branches).
 */

import type { CredentialProvider } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, getDefaultLocationForProvider } from '@simple-agent-manager/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { createNodeRecord, provisionNode } from './nodes';

/** Default VM size for deployment nodes — apps are typically smaller than dev workspaces. */
export const DEPLOYMENT_DEFAULT_VM_SIZE = 'small';

export interface DeploymentNodeResult {
  nodeId: string;
  /** Promise that resolves when VM provisioning completes. Pass to waitUntil(). */
  provisioningPromise: Promise<void>;
}

/**
 * Create a deployment node record and start provisioning.
 *
 * Creates a node record with nodeRole='deployment', links the environment
 * to the node with placement constraints, and returns a promise for the
 * actual VM provisioning. The caller should pass provisioningPromise to
 * executionCtx.waitUntil() so the Worker keeps running while the VM boots.
 *
 * @returns Node result with ID and provisioning promise, or null on failure.
 */
export async function provisionDeploymentNode(
  envId: string,
  _projectId: string,
  userId: string,
  env: Env,
): Promise<DeploymentNodeResult | null> {
  const db = drizzle(env.DATABASE, { schema });

  // Resolve the user's active cloud provider credential to determine placement
  const userCreds = await db
    .select({
      provider: schema.credentials.provider,
    })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
        eq(schema.credentials.isActive, true),
      ),
    )
    .limit(1);

  // Fall back to platform credentials if no user credential
  let cloudProvider: CredentialProvider;
  if (userCreds.length > 0 && userCreds[0]) {
    cloudProvider = userCreds[0].provider as CredentialProvider;
  } else {
    const platformCreds = await db
      .select({ provider: schema.platformCredentials.provider })
      .from(schema.platformCredentials)
      .where(
        and(
          eq(schema.platformCredentials.credentialType, 'cloud-provider'),
          eq(schema.platformCredentials.isEnabled, true),
        ),
      )
      .limit(1);

    if (platformCreds.length === 0 || !platformCreds[0]?.provider) {
      log.error('deployment_provisioning.no_provider', { envId, userId });
      return null;
    }
    cloudProvider = platformCreds[0].provider as CredentialProvider;
  }

  const vmLocation = getDefaultLocationForProvider(cloudProvider) ?? DEFAULT_VM_LOCATION;

  // Create the node record with deployment role
  const node = await createNodeRecord(env, {
    userId,
    name: `deploy-${envId.slice(0, 8).toLowerCase()}`,
    vmSize: DEPLOYMENT_DEFAULT_VM_SIZE,
    vmLocation,
    heartbeatStaleAfterSeconds: 300,
    cloudProvider,
    nodeRole: 'deployment',
  });

  // Link the environment to the node with placement constraints.
  // Conditional update: only set nodeId if still NULL to prevent
  // concurrent releases from provisioning duplicate nodes.
  await db
    .update(schema.deploymentEnvironments)
    .set({
      nodeId: node.id,
      provider: cloudProvider,
      location: vmLocation,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        isNull(schema.deploymentEnvironments.nodeId),
      ),
    );

  log.info('deployment_provisioning.started', {
    nodeId: node.id,
    envId,
    provider: cloudProvider,
    location: vmLocation,
  });

  // Return the provisioning promise for the caller to pass to waitUntil()
  const provisioningPromise = provisionNode(
    node.id,
    env,
    undefined,
    undefined,
    { environmentId: envId },
  ).catch(async (err) => {
    log.error('deployment_provisioning.provision_failed', {
      nodeId: node.id,
      envId,
      ...serializeError(err),
    });

    // Roll back the environment→node linkage so subsequent releases can
    // re-trigger provisioning instead of being orphaned against a dead node.
    // Guard on nodeId = our node to avoid stomping a concurrent successful
    // re-provisioning that already wrote a different nodeId.
    try {
      await db
        .update(schema.deploymentEnvironments)
        .set({ nodeId: null, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.deploymentEnvironments.id, envId),
            eq(schema.deploymentEnvironments.nodeId, node.id),
          ),
        );
      log.info('deployment_provisioning.nodeId_rolled_back', { envId, nodeId: node.id });
    } catch (rollbackErr) {
      log.error('deployment_provisioning.nodeId_rollback_failed', {
        envId,
        nodeId: node.id,
        ...serializeError(rollbackErr),
      });
    }
  });

  return { nodeId: node.id, provisioningPromise };
}
