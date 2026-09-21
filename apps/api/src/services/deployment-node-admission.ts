import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { parsePositiveInt } from '../lib/route-helpers';
import type { DeploymentPlacement } from './deployment-provisioning';
import { buildPlacementAuthoritySqlPredicate } from './placement-authority';
import {
  type CapacityAwareNodePlacementRow,
  resolveReusableNodeCapacitySnapshot,
} from './placement-resolver';
import {
  aggregateWorkspaceReservationRows,
  evaluateWorkspaceReservationCapacity,
  resolveTrustedWorkspaceNodeCapacity,
  resolveWorkspaceAdmissionPolicy,
  RESOURCE_REQUIREMENTS_SOURCE_SQL,
  trustedWorkspaceNodeCapacityColumnsSql,
  type WorkspaceResourceNode,
} from './workspace-resource-capacity';

/** Default maximum number of deployment environments placed on one deployment node. */
export const DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE = 5;
const DEPLOYMENT_RELOCATION_CLAIM_FIELD = 'samRelocationClaim';

interface DeploymentNodeCandidate extends CapacityAwareNodePlacementRow, WorkspaceResourceNode {
  id: string;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: DeploymentPlacement['providerInstanceArchitecture'];
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
  /** CAS guard used when replacing an existing environment reservation. */
  expectedReservationJson?: string | null;
  /** When set, admission succeeds only while this remains the newest release. */
  releaseId?: string;
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
  options: {
    nodeId?: string;
    excludeEnvironmentId?: string;
    nodeMode?: 'shared' | 'exclusive';
  } = {}
): Promise<DeploymentNodeMatch | null> {
  const nodeMode = options.nodeMode ?? 'shared';
  if ((requiresVolumes || placement.reservation.exclusiveNode) && nodeMode !== 'exclusive') {
    return null;
  }
  if (nodeMode === 'exclusive' && !options.nodeId) return null;
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
       AND COALESCE(n.node_mode, 'shared') = ?
       AND n.cloud_provider = ?
       ${options.nodeId ? 'AND n.id = ?' : ''}
     ORDER BY n.id`
  )
    .bind(userId, nodeMode, placement.provider, ...(options.nodeId ? [options.nodeId] : []))
    .all<DeploymentNodeCandidate>();

  const candidates = nodes.results ?? [];
  if (candidates.length === 0) return null;

  const nodeIds = candidates.map((node) => node.id);
  const reservationRows: Array<{
    id: string;
    nodeId: string;
    resolvedReservationJson: string | null;
  }> = [];
  for (let offset = 0; offset < nodeIds.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const chunk = nodeIds.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DATABASE.prepare(
      `SELECT id, node_id AS nodeId, resolved_reservation_json AS resolvedReservationJson
       FROM deployment_environments
       WHERE node_id IN (${placeholders})`
    )
      .bind(...chunk)
      .all<{ id: string; nodeId: string; resolvedReservationJson: string | null }>();
    reservationRows.push(...(rows.results ?? []));
  }
  const rowsByNode = new Map<string, Array<{ resolvedReservationJson: string | null }>>();
  for (const row of reservationRows) {
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
    const maxEnvironments =
      nodeMode === 'exclusive'
        ? 1
        : parsePositiveInt(
            env.MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
            DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE
          );
    if (usage.activeCount >= maxEnvironments) return [];
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

export async function readEnvironmentNodeId(
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
  const hasExpectedReservation = Object.hasOwn(opts, 'expectedReservationJson');
  const hasReleaseFence = typeof opts.releaseId === 'string';
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
    AND json_type(resolved_reservation_json, '$.exclusiveNode') IN ('true', 'false')
    AND json_type(resolved_reservation_json, '$.source') = 'text'
    AND json_extract(resolved_reservation_json, '$.source') IN (${RESOURCE_REQUIREMENTS_SOURCE_SQL})
    AND (
      (
        json_extract(resolved_reservation_json, '$.version') IN (1, 2)
        AND json_type(resolved_reservation_json, '$.maxCoTenants') = 'integer'
        AND json_extract(resolved_reservation_json, '$.maxCoTenants') > 0
      )
      OR (
        json_extract(resolved_reservation_json, '$.version') = 3
        AND (
          json_type(resolved_reservation_json, '$.maxCoTenants') IS NULL
          OR (
            json_type(resolved_reservation_json, '$.maxCoTenants') = 'integer'
            AND json_extract(resolved_reservation_json, '$.maxCoTenants') > 0
          )
        )
      )
    ))`;
  const maxEnvironments =
    nodeMode === 'exclusive'
      ? 1
      : parsePositiveInt(
          env.MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE,
          DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE
        );
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
    `WITH authorized_node AS MATERIALIZED (
       SELECT n.id
       FROM nodes n
       WHERE n.id = ?
       ${authority.sql}
     )
     UPDATE deployment_environments AS de
     SET node_id = ?, provider = ?, location = ?, resolved_reservation_json = ?, updated_at = ?
     FROM nodes n
     JOIN authorized_node authorized ON authorized.id = n.id
     WHERE de.id = ?
       ${
         hasReleaseFence
           ? `AND ? = (
         SELECT latest.id FROM deployment_releases latest
         WHERE latest.environment_id = de.id
         ORDER BY latest.version DESC
         LIMIT 1
       )`
           : ''
       }
       ${hasExpectedReservation ? 'AND de.resolved_reservation_json IS ?' : ''}
       AND CASE
         WHEN json_valid(de.resolved_reservation_json)
         THEN COALESCE(json_extract(de.resolved_reservation_json, '$.${DEPLOYMENT_RELOCATION_CLAIM_FIELD}'), 0)
         ELSE 0
       END = 0
       AND (de.node_id IS NULL OR de.node_id = n.id)
       AND n.id = ?
       AND n.status = ?
       AND n.node_role = 'deployment'
       AND n.cloud_provider = ?
       AND n.vm_location = ?
       ${nativeIdentity.sql}
       AND COALESCE(n.node_mode, 'shared') = ?
       AND (SELECT COUNT(*) FROM (${otherReservationsSql}) existing) < ?
       AND (
         COALESCE(n.node_mode, 'shared') = 'shared'
         OR NOT EXISTS (SELECT 1 FROM (${otherReservationsSql}) existing)
       )
       ${capacitySql}`
  )
    .bind(
      nodeId,
      ...authority.binds,
      nodeId,
      placement.provider,
      placement.location,
      reservationJson,
      new Date().toISOString(),
      envId,
      ...(hasReleaseFence ? [opts.releaseId] : []),
      ...(hasExpectedReservation ? [opts.expectedReservationJson ?? null] : []),
      nodeId,
      expectedNodeStatus,
      placement.provider,
      placement.location,
      ...nativeIdentity.binds,
      nodeMode,
      maxEnvironments,
      ...capacityBinds
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Fence a shared environment before external teardown. The exclusive marker
 * keeps the old node unavailable to co-tenants while teardown is in flight,
 * and the old reservation comparison prevents a stale release from claiming a
 * placement already updated by a concurrent release.
 */
export async function claimDeploymentEnvironmentRelocation(params: {
  env: Env;
  envId: string;
  nodeId: string;
  userId: string;
  placement: DeploymentPlacement;
  expectedReservationJson: string | null;
  reservation: ResolvedResourceReservation;
  releaseId?: string;
}): Promise<string | null> {
  const authority = buildPlacementAuthoritySqlPredicate({
    nodeAlias: 'n',
    userId: params.userId,
    projectId: params.placement.projectId,
    nodeRole: 'deployment',
    workloadRole: 'deployment',
    capacityPlacementSnapshot: params.placement.capacityPlacementSnapshot,
    requireProjectMembership: true,
  });
  const claimJson = JSON.stringify({
    ...params.reservation,
    [DEPLOYMENT_RELOCATION_CLAIM_FIELD]: true,
    exclusiveNode: true,
    diagnostics: [
      ...(params.reservation.diagnostics ?? []),
      'deployment-environment-relocation-claim',
    ],
  });
  const claimed = await params.env.DATABASE.prepare(
    `UPDATE deployment_environments AS de
        SET resolved_reservation_json = ?, updated_at = ?
       FROM nodes n
      WHERE de.id = ?
        ${
          params.releaseId
            ? `AND ? = (
          SELECT latest.id FROM deployment_releases latest
          WHERE latest.environment_id = de.id
          ORDER BY latest.version DESC
          LIMIT 1
        )`
            : ''
        }
        AND de.node_id = ? AND de.resolved_reservation_json IS ?
        AND n.id = de.node_id
        AND CASE
          WHEN json_valid(de.resolved_reservation_json)
          THEN COALESCE(json_extract(de.resolved_reservation_json, '$.${DEPLOYMENT_RELOCATION_CLAIM_FIELD}'), 0)
          ELSE 0
        END = 0
        ${authority.sql}
      RETURNING id`
  )
    .bind(
      claimJson,
      new Date().toISOString(),
      params.envId,
      ...(params.releaseId ? [params.releaseId] : []),
      params.nodeId,
      params.expectedReservationJson,
      ...authority.binds
    )
    .first<{ id: string }>();
  return claimed ? claimJson : null;
}

export async function completeDeploymentEnvironmentRelocation(params: {
  env: Env;
  envId: string;
  nodeId: string;
  claimJson: string;
  releaseId?: string;
}): Promise<boolean> {
  const result = await params.env.DATABASE.prepare(
    `UPDATE deployment_environments
        SET node_id = NULL, resolved_reservation_json = NULL, updated_at = ?
      WHERE id = ?
        ${
          params.releaseId
            ? `AND ? = (
          SELECT latest.id FROM deployment_releases latest
          WHERE latest.environment_id = deployment_environments.id
          ORDER BY latest.version DESC
          LIMIT 1
        )`
            : ''
        }
        AND node_id = ? AND resolved_reservation_json = ?`
  )
    .bind(
      new Date().toISOString(),
      params.envId,
      ...(params.releaseId ? [params.releaseId] : []),
      params.nodeId,
      params.claimJson
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function restoreDeploymentEnvironmentRelocation(params: {
  env: Env;
  envId: string;
  nodeId: string;
  claimJson: string;
  reservationJson: string | null;
}): Promise<void> {
  await params.env.DATABASE.prepare(
    `UPDATE deployment_environments
        SET resolved_reservation_json = ?, updated_at = ?
      WHERE id = ? AND node_id = ? AND resolved_reservation_json = ?`
  )
    .bind(
      params.reservationJson,
      new Date().toISOString(),
      params.envId,
      params.nodeId,
      params.claimJson
    )
    .run();
}
