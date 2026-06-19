/**
 * Deployment node provisioning service.
 *
 * Provisions a node for a deployment environment when the first release is
 * submitted. Uses the authenticated user's cloud provider credentials via
 * the shared Provider interface (no provider-specific branches).
 */

import type { CredentialProvider } from '@simple-agent-manager/shared';
import {
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
  DEFAULT_VM_LOCATION,
  getDefaultLocationForProvider,
} from '@simple-agent-manager/shared';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { createNodeRecord, provisionNode } from './nodes';

/** Default VM size for deployment nodes — apps are typically smaller than dev workspaces. */
export const DEPLOYMENT_DEFAULT_VM_SIZE = 'small';

/** Default maximum number of deployment environments placed on one deployment node. */
export const DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE = 5;

export interface DeploymentNodeResult {
  nodeId: string;
  /** Promise that resolves when VM provisioning completes. Pass to waitUntil(). */
  provisioningPromise: Promise<void>;
}

interface DeploymentPlacement {
  provider: CredentialProvider;
  location: string;
  vmSize: string;
}

interface DeploymentNodeCandidate {
  id: string;
  vm_size: string;
  vm_location: string;
  last_metrics: string | null;
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMetrics(value: string | null): { cpuLoadAvg1?: number; memoryPercent?: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function findDeploymentNodeWithCapacity(
  env: Env,
  userId: string,
  placement: DeploymentPlacement,
): Promise<string | null> {
  if (typeof env.DATABASE.prepare !== 'function') {
    return null;
  }
  const maxEnvironments = parseEnvInt(
    env.MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
    DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
  );
  const cpuThreshold = parseEnvInt(
    env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
    DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  );
  const memThreshold = parseEnvInt(
    env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
    DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
  );

  const nodes = await env.DATABASE.prepare(
    `SELECT id, vm_size, vm_location, last_metrics
     FROM nodes
     WHERE user_id = ?
       AND status = 'running'
       AND health_status != 'unhealthy'
       AND node_role = 'deployment'
       AND cloud_provider = ?
       AND vm_location = ?
       AND vm_size = ?`
  )
    .bind(userId, placement.provider, placement.location, placement.vmSize)
    .all<DeploymentNodeCandidate>();

  const candidates = nodes.results ?? [];
  if (candidates.length === 0) return null;

  const nodeIds = candidates.map((node) => node.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const counts = await env.DATABASE.prepare(
    `SELECT node_id, COUNT(*) AS c
     FROM deployment_environments
     WHERE node_id IN (${placeholders})
     GROUP BY node_id`
  )
    .bind(...nodeIds)
    .all<{ node_id: string; c: number }>();
  const countByNode = new Map((counts.results ?? []).map((row) => [row.node_id, row.c]));

  const scored = candidates
    .filter((node) => (countByNode.get(node.id) ?? 0) < maxEnvironments)
    .map((node) => {
      const metrics = parseMetrics(node.last_metrics);
      if (!metrics) {
        return { id: node.id, vmSize: node.vm_size, vmLocation: node.vm_location, score: null };
      }
      const cpu = metrics.cpuLoadAvg1 ?? 0;
      const mem = metrics.memoryPercent ?? 0;
      if (cpu >= cpuThreshold || mem >= memThreshold) return null;
      return {
        id: node.id,
        vmSize: node.vm_size,
        vmLocation: node.vm_location,
        score: cpu * 0.4 + mem * 0.6,
      };
    })
    .filter((node): node is { id: string; vmSize: string; vmLocation: string; score: number | null } => node !== null);

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    const aLoc = a.vmLocation === placement.location ? 1 : 0;
    const bLoc = b.vmLocation === placement.location ? 1 : 0;
    if (aLoc !== bLoc) return bLoc - aLoc;
    const aSize = a.vmSize === placement.vmSize ? 1 : 0;
    const bSize = b.vmSize === placement.vmSize ? 1 : 0;
    if (aSize !== bSize) return bSize - aSize;
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return a.score - b.score;
  });

  return scored[0]?.id ?? null;
}

async function readEnvironmentNodeId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  envId: string,
): Promise<string | null> {
  const rows = await db
    .select({ nodeId: schema.deploymentEnvironments.nodeId })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, envId))
    .limit(1);
  return rows[0]?.nodeId ?? null;
}

async function linkEnvironmentToNode(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  envId: string,
  nodeId: string,
  placement: DeploymentPlacement,
): Promise<boolean> {
  if (typeof env.DATABASE.prepare === 'function') {
    const result = await env.DATABASE.prepare(
      `UPDATE deployment_environments
       SET node_id = ?, provider = ?, location = ?, updated_at = ?
       WHERE id = ? AND node_id IS NULL`
    )
      .bind(nodeId, placement.provider, placement.location, new Date().toISOString(), envId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  await db
    .update(schema.deploymentEnvironments)
    .set({
      nodeId,
      provider: placement.provider,
      location: placement.location,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        isNull(schema.deploymentEnvironments.nodeId),
      ),
    );

  return true;
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
  const placement: DeploymentPlacement = {
    provider: cloudProvider,
    location: vmLocation,
    vmSize: DEPLOYMENT_DEFAULT_VM_SIZE,
  };

  const existingNodeId = await findDeploymentNodeWithCapacity(env, userId, placement);
  if (existingNodeId) {
    const linked = await linkEnvironmentToNode(env, db, envId, existingNodeId, placement);
    if (linked) {
      log.info('deployment_provisioning.placed_existing_node', {
        nodeId: existingNodeId,
        envId,
        provider: cloudProvider,
        location: vmLocation,
      });
      return { nodeId: existingNodeId, provisioningPromise: Promise.resolve() };
    }

    const currentNodeId = await readEnvironmentNodeId(db, envId);
    if (currentNodeId) {
      log.info('deployment_provisioning.concurrent_placement_won', {
        envId,
        selectedNodeId: existingNodeId,
        currentNodeId,
      });
      return { nodeId: currentNodeId, provisioningPromise: Promise.resolve() };
    }
  }

  // Create the node record with deployment role
  const node = await createNodeRecord(env, {
    userId,
    name: `deploy-${envId.slice(0, 8).toLowerCase()}`,
    vmSize: placement.vmSize,
    vmLocation,
    heartbeatStaleAfterSeconds: 300,
    cloudProvider,
    nodeRole: 'deployment',
  });

  const linkedFreshNode = await linkEnvironmentToNode(env, db, envId, node.id, placement);
  if (!linkedFreshNode) {
    await db
      .delete(schema.nodes)
      .where(and(eq(schema.nodes.id, node.id), eq(schema.nodes.userId, userId), ne(schema.nodes.status, 'running')));

    const currentNodeId = await readEnvironmentNodeId(db, envId);
    if (currentNodeId) {
      log.info('deployment_provisioning.fresh_node_abandoned_after_race', {
        envId,
        abandonedNodeId: node.id,
        currentNodeId,
      });
      return { nodeId: currentNodeId, provisioningPromise: Promise.resolve() };
    }

    return null;
  }

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
