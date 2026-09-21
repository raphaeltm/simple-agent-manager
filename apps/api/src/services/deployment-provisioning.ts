/**
 * Deployment node provisioning service.
 *
 * Provisions a node for a deployment environment when the first release is
 * submitted. Uses the authenticated user's cloud provider credentials via
 * the shared Provider interface (no provider-specific branches).
 */

import type { NativeVMConfig } from '@simple-agent-manager/providers';
import type {
  CapacityPlacementSnapshot,
  CredentialProvider,
  CredentialSource,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { ulid } from '../lib/ulid';
import {
  placementProjectDefaultsFromRow,
  resolveCanonicalVmAllocationPlan,
} from './canonical-vm-allocation';
import {
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
  readEnvironmentNodeId,
} from './deployment-node-admission';
import { createNodeRecord, provisionNode } from './nodes';

export {
  claimDeploymentEnvironmentRelocation,
  completeDeploymentEnvironmentRelocation,
  DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
  restoreDeploymentEnvironmentRelocation,
} from './deployment-node-admission';
import type { TaskStartCapacityPoolSelection } from './placement-resolver';
import {
  assertDeploymentProvisioningAuthority,
  cleanupFreshProvisioningNode,
} from './provisioning-authority';

type VMArchitecture = NonNullable<NativeVMConfig['architecture']>;

/** Default VM size for deployment nodes — apps are typically smaller than dev workspaces. */
export const DEPLOYMENT_DEFAULT_VM_SIZE = 'small';

/**
 * VM size for deployment nodes that must run Docker Model Runner (compose
 * `provider:` model services). Model weights + the runner daemon need more RAM
 * than a plain app node, so these are sized up. Override via
 * env.DEPLOYMENT_MODEL_RUNNER_VM_SIZE.
 */
export const DEPLOYMENT_MODEL_RUNNER_VM_SIZE = 'medium';

export interface DeploymentNodeResult {
  nodeId: string;
  /** True when this call started a new VM provisioning flow. */
  provisioningStarted: boolean;
  /** Promise that resolves when VM provisioning completes. Pass to waitUntil(). */
  provisioningPromise: Promise<void>;
}

export interface DeploymentPlacement {
  projectId: string;
  provider: CredentialProvider;
  location: string;
  vmSize: string;
  credentialSource: CredentialSource;
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  placementCredentialSource: CredentialSource | null;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  providerInstanceType: string | null;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: VMArchitecture | null;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
  capacityPoolSelection: TaskStartCapacityPoolSelection | null;
  reservation: ResolvedResourceReservation;
}

async function rollbackEnvironmentNodeLink(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  envId: string,
  nodeId: string,
  releaseId?: string
): Promise<boolean> {
  if (releaseId && typeof env.DATABASE.prepare === 'function') {
    const result = await env.DATABASE.prepare(
      `UPDATE deployment_environments
          SET node_id = NULL, updated_at = ?
        WHERE id = ? AND node_id = ?
          AND ? = (
            SELECT latest.id FROM deployment_releases latest
            WHERE latest.environment_id = deployment_environments.id
            ORDER BY latest.version DESC
            LIMIT 1
          )`
    )
      .bind(new Date().toISOString(), envId, nodeId, releaseId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
  await db
    .update(schema.deploymentEnvironments)
    .set({ nodeId: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.nodeId, nodeId)
      )
    );
  return true;
}

async function assertFreshDeploymentProvisioningAuthority(input: {
  env: Env;
  envId: string;
  projectId: string;
  userId: string;
  nodeId: string;
  placement: DeploymentPlacement;
  nodeMode: 'shared' | 'exclusive';
  requiresVolumes: boolean;
  releaseId?: string;
}): Promise<void> {
  await assertDeploymentProvisioningAuthority(input.env, {
    environmentId: input.envId,
    projectId: input.projectId,
    userId: input.userId,
    nodeId: input.nodeId,
    provider: input.placement.provider,
    location: input.placement.location,
    providerInstanceType: input.placement.providerInstanceType,
    providerInstanceBootDiskSizeGb: input.placement.providerInstanceBootDiskSizeGb,
    providerInstanceImage: input.placement.providerInstanceImage,
    providerInstanceArchitecture: input.placement.providerInstanceArchitecture,
    nodeMode: input.nodeMode,
    requiresVolumes: input.requiresVolumes,
    releaseId: input.releaseId,
  });
}

async function failIfFreshDeploymentNodeNotProvisionable(
  env: Env,
  nodeId: string,
  userId: string
): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT status, error_message AS errorMessage
       FROM nodes
      WHERE id = ? AND user_id = ?
      LIMIT 1`
  )
    .bind(nodeId, userId)
    .first<{ status: string; errorMessage: string | null }>();
  if (!row) {
    throw new Error('Deployment node disappeared during provisioning');
  }
  if (row.status === 'error' || row.status === 'deleted' || row.status === 'stopped') {
    throw new Error(
      row.errorMessage || `Deployment node provisioning ended with status ${row.status}`
    );
  }
}

export async function resolveDeploymentPlacement(
  userId: string,
  env: Env,
  projectId?: string | null,
  options?: {
    vmSizeOverride?: string;
    vmLocationOverride?: string;
    providerOverride?: CredentialProvider;
    reservation?: ResolvedResourceReservation;
  }
): Promise<DeploymentPlacement | null> {
  const db = drizzle(env.DATABASE, { schema });
  if (!projectId) return null;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  if (!project) {
    log.error('deployment_provisioning.no_provider', {
      userId,
      projectId,
      provider: options?.providerOverride,
    });
    return null;
  }
  const defaultVmSize = env.DEPLOYMENT_DEFAULT_VM_SIZE?.trim() || DEPLOYMENT_DEFAULT_VM_SIZE;
  const allocation = await resolveCanonicalVmAllocationPlan(db, env, {
    entryPoint: 'deployment-provisioning',
    taskId: ulid(),
    userId,
    projectId,
    project: placementProjectDefaultsFromRow(project),
    explicit: {
      vmSize: options?.vmSizeOverride?.trim() || defaultVmSize,
      provider: options?.providerOverride ?? null,
      vmLocation: options?.vmLocationOverride?.trim() || null,
    },
    credentialProjectPolicy: 'current-project',
    taskModeDefault: 'task',
    workloadRole: 'deployment',
    resolvedReservationOverride: options?.reservation,
  });
  if ('error' in allocation) {
    log.error('deployment_provisioning.no_provider', {
      userId,
      projectId,
      provider: options?.providerOverride,
      reason: allocation.error,
    });
    return null;
  }

  return {
    projectId,
    provider: allocation.effectiveProvider,
    location: allocation.vmLocation,
    vmSize: allocation.vmSize,
    credentialSource: allocation.credentialAttributionSource,
    credentialAttributionUserId: allocation.credentialAttributionUserId,
    credentialAttributionProjectId: allocation.credentialAttributionProjectId,
    placementCredentialSource:
      allocation.capacityPlacementSnapshot?.placementCredentialSource ?? null,
    placementCredentialReference:
      allocation.capacityPlacementSnapshot?.placementCredentialReference ?? null,
    placementCredentialVersion:
      allocation.capacityPlacementSnapshot?.placementCredentialVersion ?? null,
    providerInstanceType: allocation.providerInstanceType,
    providerInstanceBootDiskSizeGb: allocation.providerInstanceBootDiskSizeGb,
    providerInstanceImage: allocation.providerInstanceImage,
    providerInstanceArchitecture: allocation.providerInstanceArchitecture,
    capacityPlacementSnapshot: allocation.capacityPlacementSnapshot,
    capacityPoolSelection: allocation.eligibleCapacityPoolSelection,
    reservation: allocation.placement.resolvedReservation,
  };
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
  options?: {
    vmSizeOverride?: string;
    vmLocationOverride?: string;
    providerOverride?: CredentialProvider;
    requiresVolumes?: boolean;
    reservation?: ResolvedResourceReservation;
    releaseId?: string;
  }
): Promise<DeploymentNodeResult | null> {
  const db = drizzle(env.DATABASE, { schema });

  const projectId = _projectId;
  const resolvedPlacement = await resolveDeploymentPlacement(userId, env, projectId, options);
  if (!resolvedPlacement) {
    log.error('deployment_provisioning.no_provider', { envId, userId });
    return null;
  }
  const requiresVolumes = options?.requiresVolumes ?? false;
  const placement = requiresVolumes
    ? {
        ...resolvedPlacement,
        reservation: { ...resolvedPlacement.reservation, exclusiveNode: true },
      }
    : resolvedPlacement;
  const nodeMode: 'shared' | 'exclusive' = requiresVolumes ? 'exclusive' : 'shared';

  const existingNode = await findDeploymentNodeWithCapacity(
    env,
    userId,
    placement,
    requiresVolumes
  );
  if (existingNode) {
    const linked = await linkEnvironmentToNode({
      env,
      db,
      envId,
      nodeId: existingNode.nodeId,
      placement: existingNode.placement,
      userId,
      expectedNodeStatus: 'running',
      nodeMode,
      releaseId: options?.releaseId,
    });
    if (linked) {
      log.info('deployment_provisioning.placed_existing_node', {
        nodeId: existingNode.nodeId,
        envId,
        provider: placement.provider,
        location: placement.location,
      });
      return {
        nodeId: existingNode.nodeId,
        provisioningStarted: false,
        provisioningPromise: Promise.resolve(),
      };
    }

    const currentNodeId = await readEnvironmentNodeId(db, envId);
    if (currentNodeId) {
      log.info('deployment_provisioning.concurrent_placement_won', {
        envId,
        selectedNodeId: existingNode.nodeId,
        currentNodeId,
      });
      return {
        nodeId: currentNodeId,
        provisioningStarted: false,
        provisioningPromise: Promise.resolve(),
      };
    }
  }

  // Create the node record with deployment role
  const node = await createNodeRecord(env, {
    userId,
    credentialAttributionUserId: placement.credentialAttributionUserId,
    credentialAttributionProjectId: placement.credentialAttributionProjectId,
    credentialAttributionSource: placement.credentialSource,
    name: `deploy-${envId.slice(0, 8).toLowerCase()}`,
    vmSize: placement.vmSize,
    vmLocation: placement.location,
    heartbeatStaleAfterSeconds: 300,
    cloudProvider: placement.provider,
    providerInstanceType: placement.providerInstanceType,
    providerInstanceBootDiskSizeGb: placement.providerInstanceBootDiskSizeGb,
    providerInstanceImage: placement.providerInstanceImage,
    providerInstanceArchitecture: placement.providerInstanceArchitecture,
    nodeRole: 'deployment',
    nodeMode,
    capacityPlacementSnapshot: placement.capacityPlacementSnapshot,
  });

  const linkedFreshNode = await linkEnvironmentToNode({
    env,
    db,
    envId,
    nodeId: node.id,
    placement,
    userId,
    expectedNodeStatus: 'creating',
    nodeMode,
    releaseId: options?.releaseId,
  });
  if (!linkedFreshNode) {
    await db
      .delete(schema.nodes)
      .where(
        and(
          eq(schema.nodes.id, node.id),
          eq(schema.nodes.userId, userId),
          ne(schema.nodes.status, 'running')
        )
      );

    const currentNodeId = await readEnvironmentNodeId(db, envId);
    if (currentNodeId) {
      log.info('deployment_provisioning.fresh_node_abandoned_after_race', {
        envId,
        abandonedNodeId: node.id,
        currentNodeId,
      });
      return {
        nodeId: currentNodeId,
        provisioningStarted: false,
        provisioningPromise: Promise.resolve(),
      };
    }

    return null;
  }

  log.info('deployment_provisioning.started', {
    nodeId: node.id,
    envId,
    provider: placement.provider,
    location: placement.location,
    nodeMode,
  });

  // Return the provisioning promise for the caller to pass to waitUntil()
  const assertExternalMutationAuthority = async () => {
    await assertFreshDeploymentProvisioningAuthority({
      env,
      envId,
      projectId,
      userId,
      nodeId: node.id,
      placement,
      nodeMode,
      requiresVolumes,
      releaseId: options?.releaseId,
    });
  };

  const provisioningPromise = (async () => {
    await provisionNode(
      node.id,
      env,
      undefined,
      {
        rethrowProviderError: true,
        authorityProjectId: projectId,
        assertExternalMutationAuthority,
      },
      {
        environmentId: envId,
        projectId,
      }
    );
    await assertExternalMutationAuthority();
    await failIfFreshDeploymentNodeNotProvisionable(env, node.id, userId);
  })().catch(async (err) => {
    log.error('deployment_provisioning.provision_failed', {
      nodeId: node.id,
      envId,
      ...serializeError(err),
    });

    // Roll back the environment→node linkage so subsequent releases can
    // re-trigger provisioning instead of being orphaned against a dead node.
    // Guard on nodeId = our node to avoid stomping a concurrent successful
    // re-provisioning that already wrote a different nodeId.
    let mayCleanupNode = false;
    try {
      const rolledBack = await rollbackEnvironmentNodeLink(
        db,
        env,
        envId,
        node.id,
        options?.releaseId
      );
      if (!rolledBack) {
        log.info('deployment_provisioning.cleanup_skipped_superseded_release', {
          envId,
          nodeId: node.id,
          releaseId: options?.releaseId ?? null,
        });
        throw err;
      }
      mayCleanupNode = true;
      log.info('deployment_provisioning.nodeId_rolled_back', { envId, nodeId: node.id });
    } catch (rollbackErr) {
      log.error('deployment_provisioning.nodeId_rollback_failed', {
        envId,
        nodeId: node.id,
        ...serializeError(rollbackErr),
      });
    }
    if (!mayCleanupNode) throw err;
    await cleanupFreshProvisioningNode(env, {
      nodeId: node.id,
      userId,
      nodeRole: 'deployment',
      reason: 'deployment_provisioning_failed',
    });
    throw err;
  });

  return { nodeId: node.id, provisioningStarted: true, provisioningPromise };
}
