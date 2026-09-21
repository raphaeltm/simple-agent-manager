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
import { createNodeRecord, provisionNode } from './nodes';
import { buildPlacementAuthoritySqlPredicate } from './placement-authority';
import {
  resolveReusableNodeCapacitySnapshot,
  type CapacityAwareNodePlacementRow,
  type TaskStartCapacityPoolSelection,
} from './placement-resolver';
import {
  assertDeploymentProvisioningAuthority,
  cleanupFreshProvisioningNode,
} from './provisioning-authority';
import {
  aggregateWorkspaceReservationRows,
  evaluateWorkspaceReservationCapacity,
  resolveTrustedWorkspaceNodeCapacity,
  resolveWorkspaceAdmissionPolicy,
  trustedWorkspaceNodeCapacityColumnsSql,
  type WorkspaceResourceNode,
} from './workspace-resource-capacity';

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

/** Default maximum number of deployment environments placed on one deployment node. */
export const DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE = 5;

export interface DeploymentNodeResult {
  nodeId: string;
  /** True when this call started a new VM provisioning flow. */
  provisioningStarted: boolean;
  /** Promise that resolves when VM provisioning completes. Pass to waitUntil(). */
  provisioningPromise: Promise<void>;
}

interface DeploymentPlacement {
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

interface DeploymentNodeCandidate extends CapacityAwareNodePlacementRow, WorkspaceResourceNode {
  id: string;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: VMArchitecture | null;
}

interface DeploymentNodeMatch {
  nodeId: string;
  placement: DeploymentPlacement;
}

interface LinkEnvironmentToNodeOptions {
  env: Env;
  db: ReturnType<typeof drizzle>;
  envId: string;
  nodeId: string;
  placement: DeploymentPlacement;
  userId: string;
  expectedNodeStatus: 'creating' | 'running';
  nodeMode: 'shared' | 'exclusive';
}

/** Native identity is independent of the historical vm_size label. The shared
 * authority predicate additionally pins the current pool candidate and role. */
function deploymentNativeIdentityPredicate(placement: DeploymentPlacement) {
  return {
    sql: `AND n.provider_instance_type = ?
          AND n.provider_instance_boot_disk_size_gb IS ?
          AND n.provider_instance_image IS ?
          AND n.provider_instance_architecture IS ?`,
    binds: [
      placement.providerInstanceType,
      placement.providerInstanceBootDiskSizeGb,
      placement.providerInstanceImage,
      placement.providerInstanceArchitecture,
    ],
  };
}

export async function findDeploymentNodeWithCapacity(
  env: Env,
  userId: string,
  placement: DeploymentPlacement,
  requiresVolumes: boolean,
  options: { nodeId?: string; excludeEnvironmentId?: string } = {}
): Promise<DeploymentNodeMatch | null> {
  if (requiresVolumes || placement.reservation.exclusiveNode) {
    return null;
  }
  if (typeof env.DATABASE.prepare !== 'function') {
    return null;
  }
  const policy = resolveWorkspaceAdmissionPolicy(env);
  const nodes = await env.DATABASE.prepare(
    `SELECT n.id,
            n.vm_size AS vmSize,
            n.vm_location AS vmLocation,
            n.cloud_provider AS cloudProvider,
            n.capacity_pool_id AS capacityPoolId,
            n.capacity_pool_scope AS capacityPoolScope,
            n.capacity_pool_revision AS capacityPoolRevision,
            n.capacity_source_id AS capacitySourceId,
            n.capacity_pool_candidate_id AS capacityPoolCandidateId,
            n.placement_credential_source AS placementCredentialSource,
            n.placement_credential_reference AS placementCredentialReference,
            n.placement_credential_version AS placementCredentialVersion,
            n.capacity_pool_project_id AS capacityPoolProjectId,
            n.workload_role AS workloadRole,
            ${trustedWorkspaceNodeCapacityColumnsSql('n')},
            n.provider_instance_type AS providerInstanceType,
            n.provider_instance_vcpu_count AS providerInstanceVcpuCount,
            n.provider_instance_memory_mb AS providerInstanceMemoryMb,
            n.provider_instance_disk_gb AS providerInstanceDiskGb,
            n.provider_instance_boot_disk_size_gb AS providerInstanceBootDiskSizeGb,
            n.provider_instance_image AS providerInstanceImage,
            n.provider_instance_architecture AS providerInstanceArchitecture,
            n.provider_instance_price_display AS providerInstancePriceDisplay,
            n.provider_instance_price_currency AS providerInstancePriceCurrency,
            n.provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
            n.provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
            n.placement_explanation_json AS placementExplanationJson,
            n.last_metrics AS lastMetrics,
            n.last_heartbeat_at AS lastHeartbeatAt
     FROM nodes n
     WHERE n.user_id = ?
       AND n.status = 'running'
       AND n.health_status != 'unhealthy'
       AND n.node_role = 'deployment'
       AND COALESCE(n.node_mode, 'shared') = 'shared'
       AND n.cloud_provider = ?
       ${options.nodeId ? 'AND n.id = ?' : ''}
     ORDER BY n.id`
  )
    .bind(userId, placement.provider, ...(options.nodeId ? [options.nodeId] : []))
    .all<DeploymentNodeCandidate>();

  const candidates = nodes.results ?? [];
  if (candidates.length === 0) return null;

  const nodeIds = candidates.map((node) => node.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const counts = await env.DATABASE.prepare(
    `SELECT id, node_id AS nodeId, resolved_reservation_json AS resolvedReservationJson
     FROM deployment_environments
     WHERE node_id IN (${placeholders})`
  )
    .bind(...nodeIds)
    .all<{ id: string; nodeId: string; resolvedReservationJson: string | null }>();
  const rowsByNode = new Map<string, Array<{ resolvedReservationJson: string | null }>>();
  for (const row of counts.results ?? []) {
    if (row.id === options.excludeEnvironmentId) continue;
    const rows = rowsByNode.get(row.nodeId) ?? [];
    rows.push({ resolvedReservationJson: row.resolvedReservationJson });
    rowsByNode.set(row.nodeId, rows);
  }

  const scored = candidates.flatMap((node) => {
    const capacityPlacementSnapshot = resolveReusableNodeCapacitySnapshot({
      selection: placement.capacityPoolSelection,
      node,
      projectId: placement.projectId,
      requestedVmSize: placement.vmSize,
      requestedReservation: placement.reservation,
    });
    if (capacityPlacementSnapshot === undefined) return [];
    if (
      placement.capacityPoolSelection === null &&
      !directDeploymentNodeMatchesPlacement(node, placement)
    ) {
      return [];
    }

    const usage = aggregateWorkspaceReservationRows(rowsByNode.get(node.id) ?? []);
    const decision = evaluateWorkspaceReservationCapacity(
      node,
      usage,
      placement.reservation,
      policy
    );
    if (!decision.admitted) return [];

    const trusted = resolveTrustedWorkspaceNodeCapacity(node);
    const remainingCpu =
      trusted.vcpuCount === null
        ? Number.MAX_SAFE_INTEGER
        : trusted.vcpuCount * 1_000 - usage.cpuMillis - placement.reservation.cpuMillis;
    const remainingMemory =
      trusted.memoryMb === null
        ? Number.MAX_SAFE_INTEGER
        : trusted.memoryMb -
          policy.hostMemoryReserveMb -
          usage.memoryMb -
          placement.reservation.memoryMb;
    return [
      {
        nodeId: node.id,
        remainingCpu,
        remainingMemory,
        placement: deploymentPlacementForNode(placement, node, capacityPlacementSnapshot),
      },
    ];
  });

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    return (
      a.remainingMemory - b.remainingMemory ||
      a.remainingCpu - b.remainingCpu ||
      a.nodeId.localeCompare(b.nodeId)
    );
  });

  const selected = scored[0];
  return selected ? { nodeId: selected.nodeId, placement: selected.placement } : null;
}

function directDeploymentNodeMatchesPlacement(
  node: DeploymentNodeCandidate,
  placement: DeploymentPlacement
): boolean {
  return (
    node.vmLocation === placement.location &&
    node.providerInstanceType === placement.providerInstanceType &&
    node.providerInstanceBootDiskSizeGb === placement.providerInstanceBootDiskSizeGb &&
    node.providerInstanceImage === placement.providerInstanceImage &&
    node.providerInstanceArchitecture === placement.providerInstanceArchitecture
  );
}

function deploymentPlacementForNode(
  request: DeploymentPlacement,
  node: DeploymentNodeCandidate,
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null
): DeploymentPlacement {
  return {
    ...request,
    location: node.vmLocation ?? request.location,
    vmSize: node.vmSize ?? request.vmSize,
    providerInstanceType: node.providerInstanceType ?? null,
    providerInstanceBootDiskSizeGb: node.providerInstanceBootDiskSizeGb,
    providerInstanceImage: node.providerInstanceImage,
    providerInstanceArchitecture: node.providerInstanceArchitecture,
    capacityPlacementSnapshot,
  };
}

async function readEnvironmentNodeId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  envId: string
): Promise<string | null> {
  const rows = await db
    .select({ nodeId: schema.deploymentEnvironments.nodeId })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, envId))
    .limit(1);
  return rows[0]?.nodeId ?? null;
}

export async function linkEnvironmentToNode(opts: LinkEnvironmentToNodeOptions): Promise<boolean> {
  const { env, envId, nodeId, placement, userId, expectedNodeStatus, nodeMode } = opts;
  if (typeof env.DATABASE.prepare !== 'function') return false;
  if ((nodeMode === 'exclusive') !== placement.reservation.exclusiveNode) return false;

  const authority = buildPlacementAuthoritySqlPredicate({
    nodeAlias: 'n',
    userId,
    projectId: placement.projectId,
    nodeRole: 'deployment',
    workloadRole: 'deployment',
    capacityPlacementSnapshot: placement.capacityPlacementSnapshot,
    requireProjectMembership: true,
  });
  const nativeIdentity = deploymentNativeIdentityPredicate(placement);
  const policy = resolveWorkspaceAdmissionPolicy(env);
  const reservation = placement.reservation;
  const reservationJson = JSON.stringify(reservation);
  const otherReservationsSql = `
    SELECT occupied.resolved_reservation_json
    FROM deployment_environments occupied
    WHERE occupied.node_id = n.id AND occupied.id != de.id`;
  const validReservationSql = `(resolved_reservation_json IS NOT NULL
    AND json_valid(resolved_reservation_json)
    AND json_extract(resolved_reservation_json, '$.version') IN (1, 2, 3)
    AND json_type(resolved_reservation_json, '$.cpuMillis') = 'integer'
    AND json_extract(resolved_reservation_json, '$.cpuMillis') > 0
    AND json_type(resolved_reservation_json, '$.memoryMb') = 'integer'
    AND json_extract(resolved_reservation_json, '$.memoryMb') > 0
    AND json_type(resolved_reservation_json, '$.diskMb') = 'integer'
    AND json_extract(resolved_reservation_json, '$.diskMb') >= 0
    AND json_type(resolved_reservation_json, '$.exclusiveNode') IN ('true', 'false'))`;
  const runningCapacitySql = `
       AND n.provider_instance_id IS NOT NULL
       AND n.observed_hardware_source = 'observed'
       AND n.observed_provider_instance_vcpu_count > 0
       AND n.observed_provider_instance_memory_mb > 0
       AND n.observed_provider_instance_disk_gb > 0
       AND NOT EXISTS (
         SELECT 1 FROM (${otherReservationsSql}) existing
         WHERE NOT ${validReservationSql}
       )
       AND NOT EXISTS (
         SELECT 1 FROM (${otherReservationsSql}) existing
         WHERE json_extract(resolved_reservation_json, '$.exclusiveNode') = 1
       )
       AND COALESCE((
         SELECT SUM(json_extract(resolved_reservation_json, '$.cpuMillis'))
         FROM (${otherReservationsSql}) existing
       ), 0) + ? <= (n.observed_provider_instance_vcpu_count * 1000 * ? / 100)
       AND COALESCE((
         SELECT SUM(json_extract(resolved_reservation_json, '$.memoryMb'))
         FROM (${otherReservationsSql}) existing
       ), 0) + ? <= (n.observed_provider_instance_memory_mb - ?)
       AND COALESCE((
         SELECT SUM(json_extract(resolved_reservation_json, '$.diskMb'))
         FROM (${otherReservationsSql}) existing
       ), 0) + ? <= (n.observed_provider_instance_disk_gb * 1024)
       AND (
         NOT EXISTS (SELECT 1 FROM (${otherReservationsSql}) existing)
         OR (
           n.last_metrics IS NOT NULL
           AND json_valid(n.last_metrics)
           AND n.last_heartbeat_at >= ?
           AND n.last_heartbeat_at <= ?
           AND COALESCE(json_extract(n.last_metrics, '$.version'), 1) = 1
           AND json_type(n.last_metrics, '$.cpuLoadAvg1') IN ('integer', 'real')
           AND json_extract(n.last_metrics, '$.cpuLoadAvg1') >= 0
           AND (json_extract(n.last_metrics, '$.cpuLoadAvg1') * 100.0 /
                n.observed_provider_instance_vcpu_count) < ?
           AND json_type(n.last_metrics, '$.memoryPercent') IN ('integer', 'real')
           AND json_extract(n.last_metrics, '$.memoryPercent') BETWEEN 0 AND 100
           AND json_type(n.last_metrics, '$.diskPercent') IN ('integer', 'real')
           AND json_extract(n.last_metrics, '$.diskPercent') >= 0
           AND json_extract(n.last_metrics, '$.diskPercent') < ?
           AND (
             json_type(n.last_metrics, '$.creatingWorkspaces') IS NULL
             OR (
               json_type(n.last_metrics, '$.creatingWorkspaces') = 'integer'
               AND json_extract(n.last_metrics, '$.creatingWorkspaces') >= 0
             )
           )
         )
       )`;
  const creatingCapacitySql = `
       AND NOT EXISTS (SELECT 1 FROM (${otherReservationsSql}) existing)
       AND n.provider_instance_vcpu_count * 1000 >= ?
       AND n.provider_instance_memory_mb - ? >= ?
       AND (n.provider_instance_disk_gb IS NULL OR n.provider_instance_disk_gb * 1024 >= ?)`;
  const now = new Date();
  const capacitySql = expectedNodeStatus === 'running' ? runningCapacitySql : creatingCapacitySql;
  const capacityBinds =
    expectedNodeStatus === 'running'
      ? [
          reservation.cpuMillis,
          policy.cpuShareBudgetPercent,
          reservation.memoryMb,
          policy.hostMemoryReserveMb,
          reservation.diskMb,
          new Date(now.getTime() - policy.metricsTtlMs).toISOString(),
          now.toISOString(),
          policy.cpuThresholdPercent,
          policy.diskPressureThresholdPercent,
        ]
      : [
          reservation.cpuMillis,
          policy.hostMemoryReserveMb,
          reservation.memoryMb,
          reservation.diskMb,
        ];
  const result = await env.DATABASE.prepare(
    `UPDATE deployment_environments AS de
     SET node_id = ?, provider = ?, location = ?, resolved_reservation_json = ?, updated_at = ?
     FROM nodes n
     WHERE de.id = ?
       AND (de.node_id IS NULL OR de.node_id = n.id)
       AND n.id = ?
       AND n.user_id = ?
       AND n.status = ?
       AND n.node_role = 'deployment'
       AND n.cloud_provider = ?
       AND n.vm_location = ?
       ${nativeIdentity.sql}
       AND COALESCE(n.node_mode, 'shared') = ?
       AND (
         COALESCE(n.node_mode, 'shared') = 'shared'
         OR NOT EXISTS (
           SELECT 1 FROM deployment_environments existing
           WHERE existing.node_id = n.id
         )
       )
       ${capacitySql}
       ${authority.sql}`
  )
    .bind(
      nodeId,
      placement.provider,
      placement.location,
      reservationJson,
      new Date().toISOString(),
      envId,
      nodeId,
      userId,
      expectedNodeStatus,
      placement.provider,
      placement.location,
      ...nativeIdentity.binds,
      nodeMode,
      ...capacityBinds,
      ...authority.binds
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function rollbackEnvironmentNodeLink(
  db: ReturnType<typeof drizzle<typeof schema>>,
  envId: string,
  nodeId: string
): Promise<void> {
  await db
    .update(schema.deploymentEnvironments)
    .set({ nodeId: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.deploymentEnvironments.id, envId),
        eq(schema.deploymentEnvironments.nodeId, nodeId)
      )
    );
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
      nodeMode: 'shared',
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
    try {
      await rollbackEnvironmentNodeLink(db, envId, node.id);
      log.info('deployment_provisioning.nodeId_rolled_back', { envId, nodeId: node.id });
    } catch (rollbackErr) {
      log.error('deployment_provisioning.nodeId_rollback_failed', {
        envId,
        nodeId: node.id,
        ...serializeError(rollbackErr),
      });
    }
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
