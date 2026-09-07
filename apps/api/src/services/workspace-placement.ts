import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { resolveResourceReservation } from '@simple-agent-manager/shared';

import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import {
  ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL,
  DEFAULT_WORKSPACE_ADMISSION_CPU_SCORE_WEIGHT_PERCENT,
  DEFAULT_WORKSPACE_ADMISSION_CPU_SHARE_BUDGET_PERCENT,
  DEFAULT_WORKSPACE_ADMISSION_DISK_PRESSURE_THRESHOLD_PERCENT,
  DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
  DEFAULT_WORKSPACE_ADMISSION_MEMORY_SCORE_WEIGHT_PERCENT,
  DEFAULT_WORKSPACE_ADMISSION_METRICS_TTL_MS,
  isResolvedResourceReservation,
  RESOURCE_REQUIREMENTS_SOURCE_SQL,
  type WorkspaceAdmissionPolicy,
} from './workspace-resource-capacity';

export interface WorkspacePlacementInput {
  id: string;
  nodeId: string;
  projectId: string;
  userId: string;
  installationId: string;
  name: string;
  displayName: string;
  normalizedDisplayName: string;
  repository: string;
  branch: string;
  vmSize: VMSize;
  vmLocation: VMLocation;
  workspaceProfile: WorkspaceProfile;
  devcontainerConfigName: string | null;
  agentProfileHint: string | null;
  capacityPlacementSnapshot?: CapacityPlacementSnapshot | null;
  resolvedReservation?: ResolvedResourceReservation | null;
  createdAt: string;
}

/**
 * Atomically reserve one workspace slot and create its durable `creating` row.
 *
 * Node selection is advisory: another TaskRunner or cleanup loop can change D1
 * before workspace creation. Keeping the node-state and capacity predicates in
 * the INSERT makes that final placement decision one D1 statement. Concurrent
 * inserts cannot both consume the same final slot, and a cleanup claim that wins
 * first changes the node out of `running`, causing this operation to return false.
 */
export async function reserveWorkspacePlacement(
  database: D1Database,
  input: WorkspacePlacementInput,
  policyOrMaxWorkspaces: WorkspaceAdmissionPolicy | number
): Promise<boolean> {
  if (
    input.resolvedReservation !== undefined &&
    !isResolvedResourceReservation(input.resolvedReservation)
  ) {
    return false;
  }
  const resolvedReservation =
    input.resolvedReservation ??
    resolveResourceReservation({}, { projectId: input.projectId, userId: input.userId });
  const policy =
    typeof policyOrMaxWorkspaces === 'number'
      ? legacyWorkspaceAdmissionPolicy(policyOrMaxWorkspaces)
      : policyOrMaxWorkspaces;
  const capacityPredicate = buildCapacityPlacementPredicate(input);
  const requestedReservationJson = JSON.stringify(resolvedReservation);
  const result = await database
    .prepare(
      `WITH
       node_scope AS (
         SELECT
           n.*,
           CASE
             WHEN n.last_metrics IS NOT NULL AND json_valid(n.last_metrics)
             THEN n.last_metrics
             ELSE NULL
           END AS metrics_json,
           CASE
             WHEN n.last_heartbeat_at IS NOT NULL
             THEN CAST((julianday(?) - julianday(n.last_heartbeat_at)) * 86400000 AS INTEGER)
             ELSE NULL
           END AS metrics_age_ms
         FROM nodes n
         WHERE n.id = ?
           AND n.user_id = ?
           AND n.status = 'running'
           AND n.node_role = 'workspace'
           ${capacityPredicate.sql}
       ),
       requested_reservation AS (
         SELECT
           ? AS reservation_json,
           ? AS cpu_millis,
           ? AS memory_mb,
           ? AS disk_mb,
           ? AS exclusive_node,
           ? AS max_co_tenants
       ),
       admission_policy AS (
         SELECT
           ? AS max_workspaces,
           ? AS cpu_share_budget_percent,
           ? AS host_memory_reserve_mb,
           ? AS disk_pressure_threshold_percent,
           ? AS metrics_ttl_ms,
           ? AS cpu_threshold_percent,
           ? AS memory_threshold_percent
       ),
       active_reservations AS (
         SELECT
           COUNT(w.id) AS active_count,
           COALESCE(SUM(CASE
             WHEN w.id IS NULL THEN 0
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')} THEN 0
             ELSE 1 END), 0) AS invalid_count,
           COALESCE(SUM(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
              AND json_extract(w.resolved_reservation_json, '$.exclusiveNode')
             THEN 1 ELSE 0 END), 0) AS exclusive_count,
           MIN(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
             THEN CAST(json_extract(w.resolved_reservation_json, '$.maxCoTenants') AS INTEGER)
             ELSE NULL END) AS min_max_co_tenants,
           COALESCE(SUM(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
             THEN CAST(json_extract(w.resolved_reservation_json, '$.cpuMillis') AS INTEGER)
             ELSE 0 END), 0) AS cpu_millis,
           COALESCE(SUM(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
             THEN CAST(json_extract(w.resolved_reservation_json, '$.memoryMb') AS INTEGER)
             ELSE 0 END), 0) AS memory_mb,
           COALESCE(SUM(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
             THEN CAST(json_extract(w.resolved_reservation_json, '$.diskMb') AS INTEGER)
             ELSE 0 END), 0) AS disk_mb
         FROM node_scope n
         LEFT JOIN workspaces w
           ON w.node_id = n.id
          AND w.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
       )
       INSERT INTO workspaces
         (id, node_id, project_id, user_id, installation_id, name, display_name,
          normalized_display_name, repository, branch, status, vm_size, vm_location,
          workspace_profile, devcontainer_config_name, agent_profile_hint,
          resolved_reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?,
          requested.reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
          ?, ?
       FROM node_scope n, requested_reservation requested, active_reservations active, admission_policy policy
         WHERE active.active_count < policy.max_workspaces
         AND active.active_count < requested.max_co_tenants
         AND (active.min_max_co_tenants IS NULL OR active.active_count < active.min_max_co_tenants)
         AND active.exclusive_count = 0
         AND (requested.exclusive_node = 0 OR active.active_count = 0)
         AND ${validOrUnknownHardwareCapacitySql()}
         AND ${finalMeasuredPressurePredicateSql()}
         AND (
           (
             active.active_count = 0
             AND (n.provider_instance_vcpu_count IS NULL
               OR (n.provider_instance_vcpu_count * 1000 * policy.cpu_share_budget_percent) / 100
                 >= requested.cpu_millis)
             AND (n.provider_instance_memory_mb IS NULL
               OR n.provider_instance_memory_mb - policy.host_memory_reserve_mb >= requested.memory_mb)
             AND (n.provider_instance_disk_gb IS NULL
               OR n.provider_instance_disk_gb * 1024 >= requested.disk_mb)
           )
           OR (
             active.active_count > 0
             AND active.invalid_count = 0
             AND n.provider_instance_vcpu_count IS NOT NULL
             AND n.provider_instance_memory_mb IS NOT NULL
             AND n.provider_instance_disk_gb IS NOT NULL
             AND ((active.cpu_millis + requested.cpu_millis)
               <= (n.provider_instance_vcpu_count * 1000 * policy.cpu_share_budget_percent) / 100)
             AND ((active.memory_mb + requested.memory_mb)
               <= n.provider_instance_memory_mb - policy.host_memory_reserve_mb)
             AND ((active.disk_mb + requested.disk_mb) <= n.provider_instance_disk_gb * 1024)
           )
         )`
    )
    .bind(
      input.createdAt,
      input.nodeId,
      input.userId,
      ...capacityPredicate.binds,
      requestedReservationJson,
      resolvedReservation.cpuMillis,
      resolvedReservation.memoryMb,
      resolvedReservation.diskMb,
      resolvedReservation.exclusiveNode ? 1 : 0,
      resolvedReservation.maxCoTenants,
      policy.maxWorkspaces,
      policy.cpuShareBudgetPercent,
      policy.hostMemoryReserveMb,
      policy.diskPressureThresholdPercent,
      policy.metricsTtlMs,
      policy.cpuThresholdPercent,
      policy.memoryThresholdPercent,
      input.id,
      input.nodeId,
      input.projectId,
      input.userId,
      input.installationId,
      input.name,
      input.displayName,
      input.normalizedDisplayName,
      input.repository,
      input.branch,
      input.vmSize,
      input.vmLocation,
      input.workspaceProfile,
      input.devcontainerConfigName,
      input.agentProfileHint,
      ...capacityPlacementSnapshotSqlValues(input.capacityPlacementSnapshot),
      input.createdAt,
      input.createdAt
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

function legacyWorkspaceAdmissionPolicy(maxWorkspaces: number): WorkspaceAdmissionPolicy {
  return {
    maxWorkspaces,
    cpuShareBudgetPercent: DEFAULT_WORKSPACE_ADMISSION_CPU_SHARE_BUDGET_PERCENT,
    hostMemoryReserveMb: DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
    diskPressureThresholdPercent: DEFAULT_WORKSPACE_ADMISSION_DISK_PRESSURE_THRESHOLD_PERCENT,
    metricsTtlMs: DEFAULT_WORKSPACE_ADMISSION_METRICS_TTL_MS,
    cpuThresholdPercent: 50,
    memoryThresholdPercent: 50,
    cpuScoreWeightPercent: DEFAULT_WORKSPACE_ADMISSION_CPU_SCORE_WEIGHT_PERCENT,
    memoryScoreWeightPercent: DEFAULT_WORKSPACE_ADMISSION_MEMORY_SCORE_WEIGHT_PERCENT,
  };
}

function validReservationJsonSql(expression: string): string {
  return `(json_valid(${expression})
    AND json_type(${expression}, '$.version') = 'integer'
    AND json_extract(${expression}, '$.version') IN (1, 2)
    AND json_type(${expression}, '$.cpuMillis') = 'integer'
    AND json_extract(${expression}, '$.cpuMillis') > 0
    AND json_type(${expression}, '$.memoryMb') = 'integer'
    AND json_extract(${expression}, '$.memoryMb') > 0
    AND json_type(${expression}, '$.diskMb') = 'integer'
    AND json_extract(${expression}, '$.diskMb') >= 0
    AND json_type(${expression}, '$.maxCoTenants') = 'integer'
    AND json_extract(${expression}, '$.maxCoTenants') > 0
    AND json_type(${expression}, '$.exclusiveNode') IN ('true', 'false')
    AND json_type(${expression}, '$.source') = 'text'
    AND json_type(${expression}, '$.sourceId') = 'text'
    AND json_extract(${expression}, '$.source') IN (${RESOURCE_REQUIREMENTS_SOURCE_SQL}))`;
}

function validDiskPercentSql(): string {
  return `(n.metrics_json IS NOT NULL
    AND json_type(n.metrics_json, '$.diskPercent') IN ('integer', 'real')
    AND CAST(json_extract(n.metrics_json, '$.diskPercent') AS REAL) >= 0
    AND CAST(json_extract(n.metrics_json, '$.diskPercent') AS REAL) <= 100)`;
}

function validCpuLoadAvg1Sql(): string {
  return `(n.metrics_json IS NOT NULL
    AND json_type(n.metrics_json, '$.cpuLoadAvg1') IN ('integer', 'real')
    AND CAST(json_extract(n.metrics_json, '$.cpuLoadAvg1') AS REAL) >= 0)`;
}

function validMemoryPercentSql(): string {
  return `(n.metrics_json IS NOT NULL
    AND json_type(n.metrics_json, '$.memoryPercent') IN ('integer', 'real')
    AND CAST(json_extract(n.metrics_json, '$.memoryPercent') AS REAL) >= 0
    AND CAST(json_extract(n.metrics_json, '$.memoryPercent') AS REAL) <= 100)`;
}

function validCreatingWorkspacesSql(): string {
  return `(n.metrics_json IS NOT NULL
    AND (
      json_type(n.metrics_json, '$.creatingWorkspaces') IS NULL
      OR (
        json_type(n.metrics_json, '$.creatingWorkspaces') = 'integer'
        AND CAST(json_extract(n.metrics_json, '$.creatingWorkspaces') AS INTEGER) >= 0
      )
    ))`;
}

function supportedMetricsVersionSql(): string {
  return `(n.metrics_json IS NOT NULL
    AND (
      json_type(n.metrics_json, '$.version') IS NULL
      OR (
        json_type(n.metrics_json, '$.version') = 'integer'
        AND CAST(json_extract(n.metrics_json, '$.version') AS INTEGER) <= 1
      )
    ))`;
}

function freshMetricsSql(): string {
  return `(n.metrics_age_ms IS NOT NULL
    AND n.metrics_age_ms >= 0
    AND n.metrics_age_ms <= policy.metrics_ttl_ms)`;
}

function validOrUnknownHardwareCapacitySql(): string {
  return `((n.provider_instance_vcpu_count IS NULL
      OR (typeof(n.provider_instance_vcpu_count) = 'integer' AND n.provider_instance_vcpu_count > 0))
    AND (n.provider_instance_memory_mb IS NULL
      OR (typeof(n.provider_instance_memory_mb) = 'integer' AND n.provider_instance_memory_mb > 0))
    AND (n.provider_instance_disk_gb IS NULL
      OR (typeof(n.provider_instance_disk_gb) = 'integer' AND n.provider_instance_disk_gb > 0)))`;
}

function finalMeasuredPressurePredicateSql(): string {
  return `(
    (active.active_count = 0 AND n.metrics_json IS NULL)
    OR (
      n.metrics_json IS NOT NULL
      AND ${supportedMetricsVersionSql()}
      AND ${freshMetricsSql()}
      AND ${validCpuLoadAvg1Sql()}
      AND ${validMemoryPercentSql()}
      AND ${validDiskPercentSql()}
      AND ${validCreatingWorkspacesSql()}
      AND COALESCE(CAST(json_extract(n.metrics_json, '$.creatingWorkspaces') AS INTEGER), 0) = 0
      AND (
        (active.active_count = 0 AND n.provider_instance_vcpu_count IS NULL)
        OR (
          n.provider_instance_vcpu_count IS NOT NULL
          AND n.provider_instance_vcpu_count > 0
          AND ((CAST(json_extract(n.metrics_json, '$.cpuLoadAvg1') AS REAL) / n.provider_instance_vcpu_count) * 100)
            < policy.cpu_threshold_percent
        )
      )
      AND CAST(json_extract(n.metrics_json, '$.memoryPercent') AS REAL)
        < policy.memory_threshold_percent
      AND CAST(json_extract(n.metrics_json, '$.diskPercent') AS REAL)
        < policy.disk_pressure_threshold_percent
    )
  )`;
}

function buildCapacityPlacementPredicate(input: WorkspacePlacementInput): {
  sql: string;
  binds: Array<string | number | null>;
} {
  const snapshot = input.capacityPlacementSnapshot ?? null;
  const concretePredicate = snapshot ? buildConcretePlacementPredicate(snapshot) : null;
  if (!snapshot?.capacityPoolId) {
    return {
      sql: `AND (
        n.capacity_pool_scope IS NULL
        OR n.capacity_pool_scope != 'project'
      )`,
      binds: [],
    };
  }

  if (!snapshot.capacitySourceId) {
    const canUseLegacyNode = snapshot.capacityPoolScope !== 'project';
    return {
      sql: canUseLegacyNode ? `AND n.capacity_pool_id IS NULL` : `AND 0 = 1`,
      binds: [],
    };
  }

  if (snapshot.capacityPoolScope === 'project') {
    return {
      sql: `AND n.capacity_pool_scope = 'project'
        AND n.capacity_pool_id = ?
        AND n.capacity_source_id = ?
        AND n.capacity_pool_project_id = ?
        ${concretePredicate?.sql ?? ''}`,
      binds: [
        snapshot.capacityPoolId,
        snapshot.capacitySourceId,
        input.projectId,
        ...(concretePredicate?.binds ?? []),
      ],
    };
  }

  return {
    sql: `AND (n.capacity_pool_scope IS NULL OR n.capacity_pool_scope != 'project')
      AND n.capacity_pool_id = ?
      AND n.capacity_source_id = ?
      ${concretePredicate?.sql ?? ''}`,
    binds: [
      snapshot.capacityPoolId,
      snapshot.capacitySourceId,
      ...(concretePredicate?.binds ?? []),
    ],
  };
}

function buildConcretePlacementPredicate(snapshot: CapacityPlacementSnapshot): {
  sql: string;
  binds: Array<string | number | null>;
} {
  const clauses: string[] = [];
  const binds: Array<string | number | null> = [];

  if (snapshot.capacityPoolCandidateId) {
    clauses.push('(n.capacity_pool_candidate_id IS NULL OR n.capacity_pool_candidate_id = ?)');
    binds.push(snapshot.capacityPoolCandidateId);
  }

  if (snapshot.providerInstanceType) {
    clauses.push('(n.provider_instance_type IS NULL OR n.provider_instance_type = ?)');
    binds.push(snapshot.providerInstanceType);
  }

  return {
    sql: clauses.length ? `AND ${clauses.join('\n        AND ')}` : '',
    binds,
  };
}
