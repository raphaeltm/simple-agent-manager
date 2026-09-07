import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { resolveResourceReservation } from '@simple-agent-manager/shared';

import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import { buildPlacementAuthoritySqlPredicate } from './placement-authority';
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
  resourceRequirementsJson?: string | null;
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
  const capacityPredicate = buildPlacementAuthoritySqlPredicate({
    userId: input.userId,
    projectId: input.projectId,
    nodeRole: 'workspace',
    workloadRole: 'workspace',
    capacityPlacementSnapshot: input.capacityPlacementSnapshot ?? null,
    requireProjectMembership: true,
  });
  const requestedReservationJson = JSON.stringify(resolvedReservation);
  const admissionNow = new Date().toISOString();
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
             WHEN n.last_metrics IS NOT NULL AND NOT json_valid(n.last_metrics)
             THEN 1
             ELSE 0
           END AS metrics_malformed,
           CASE
             WHEN n.last_heartbeat_at IS NOT NULL
             THEN CAST((julianday(?) - julianday(n.last_heartbeat_at)) * 86400000 AS INTEGER)
             ELSE NULL
           END AS metrics_age_ms,
           CASE
             WHEN n.provider_instance_id IS NOT NULL
              AND typeof(n.observed_provider_instance_vcpu_count) = 'integer'
              AND n.observed_provider_instance_vcpu_count > 0
             THEN n.observed_provider_instance_vcpu_count
             ELSE NULL
           END AS trusted_provider_instance_vcpu_count,
           CASE
             WHEN n.provider_instance_id IS NOT NULL
              AND typeof(n.observed_provider_instance_memory_mb) = 'integer'
              AND n.observed_provider_instance_memory_mb > 0
             THEN n.observed_provider_instance_memory_mb
             ELSE NULL
           END AS trusted_provider_instance_memory_mb,
           CASE
             WHEN n.provider_instance_id IS NOT NULL
              AND typeof(n.observed_provider_instance_disk_gb) = 'integer'
              AND n.observed_provider_instance_disk_gb > 0
             THEN n.observed_provider_instance_disk_gb
             ELSE NULL
           END AS trusted_provider_instance_disk_gb
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
          resource_requirements_json,
          resolved_reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?,
          ?,
          requested.reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
          ?, ?
       FROM node_scope n, requested_reservation requested, active_reservations active, admission_policy policy
         WHERE active.active_count < policy.max_workspaces
         AND active.active_count < requested.max_co_tenants
         AND (active.min_max_co_tenants IS NULL OR active.active_count < active.min_max_co_tenants)
         AND active.exclusive_count = 0
         AND (requested.exclusive_node = 0 OR active.active_count = 0)
         AND ${trustedHardwareCapacitySql()}
         AND ${finalMeasuredPressurePredicateSql()}
         AND (
           (
             active.active_count = 0
             AND (n.trusted_provider_instance_vcpu_count * 1000 * policy.cpu_share_budget_percent) / 100
               >= requested.cpu_millis
             AND n.trusted_provider_instance_memory_mb - policy.host_memory_reserve_mb
               >= requested.memory_mb
             AND n.trusted_provider_instance_disk_gb * 1024 >= requested.disk_mb
           )
           OR (
             active.active_count > 0
             AND active.invalid_count = 0
             AND ((active.cpu_millis + requested.cpu_millis)
               <= (n.trusted_provider_instance_vcpu_count * 1000 * policy.cpu_share_budget_percent) / 100)
             AND ((active.memory_mb + requested.memory_mb)
               <= n.trusted_provider_instance_memory_mb - policy.host_memory_reserve_mb)
             AND ((active.disk_mb + requested.disk_mb) <= n.trusted_provider_instance_disk_gb * 1024)
           )
         )`
    )
    .bind(
      admissionNow,
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
      input.resourceRequirementsJson ?? null,
      ...capacityPlacementSnapshotSqlValues(input.capacityPlacementSnapshot),
      input.createdAt,
      input.createdAt
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Atomically attach a previously-created placeholder workspace to a running VM.
 *
 * Direct workspace creation can create the chat/session shell before a new VM has
 * provider-observed hardware. This update is the final admission point: it binds
 * the workspace to a node only if the node still has current placement authority
 * and enough trusted capacity at the moment the workload would be dispatched.
 */
export async function attachPrecreatedWorkspacePlacement(
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
  const capacityPredicate = buildPlacementAuthoritySqlPredicate({
    userId: input.userId,
    projectId: input.projectId,
    nodeRole: 'workspace',
    workloadRole: 'workspace',
    capacityPlacementSnapshot: input.capacityPlacementSnapshot ?? null,
    requireProjectMembership: true,
  });
  const requestedReservationJson = JSON.stringify(resolvedReservation);
  const admissionNow = new Date().toISOString();
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
             WHEN n.last_metrics IS NOT NULL AND NOT json_valid(n.last_metrics)
             THEN 1
             ELSE 0
           END AS metrics_malformed,
           CASE
             WHEN n.last_heartbeat_at IS NOT NULL
             THEN CAST((julianday(?) - julianday(n.last_heartbeat_at)) * 86400000 AS INTEGER)
             ELSE NULL
           END AS metrics_age_ms,
           CASE
             WHEN n.provider_instance_id IS NOT NULL
              AND typeof(n.observed_provider_instance_vcpu_count) = 'integer'
              AND n.observed_provider_instance_vcpu_count > 0
             THEN n.observed_provider_instance_vcpu_count
             ELSE NULL
           END AS trusted_provider_instance_vcpu_count,
           CASE
             WHEN n.provider_instance_id IS NOT NULL
              AND typeof(n.observed_provider_instance_memory_mb) = 'integer'
              AND n.observed_provider_instance_memory_mb > 0
             THEN n.observed_provider_instance_memory_mb
             ELSE NULL
           END AS trusted_provider_instance_memory_mb,
           CASE
             WHEN n.provider_instance_id IS NOT NULL
              AND typeof(n.observed_provider_instance_disk_gb) = 'integer'
              AND n.observed_provider_instance_disk_gb > 0
             THEN n.observed_provider_instance_disk_gb
             ELSE NULL
           END AS trusted_provider_instance_disk_gb
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
       ),
       eligible AS (
         SELECT 1 AS ok
         FROM node_scope n, requested_reservation requested, active_reservations active, admission_policy policy
         WHERE active.active_count < policy.max_workspaces
         AND active.active_count < requested.max_co_tenants
         AND (active.min_max_co_tenants IS NULL OR active.active_count < active.min_max_co_tenants)
         AND active.exclusive_count = 0
         AND (requested.exclusive_node = 0 OR active.active_count = 0)
         AND ${trustedHardwareCapacitySql()}
         AND ${finalMeasuredPressurePredicateSql()}
         AND (
           (
             active.active_count = 0
             AND (n.trusted_provider_instance_vcpu_count * 1000 * policy.cpu_share_budget_percent) / 100
               >= requested.cpu_millis
             AND n.trusted_provider_instance_memory_mb - policy.host_memory_reserve_mb
               >= requested.memory_mb
             AND n.trusted_provider_instance_disk_gb * 1024 >= requested.disk_mb
           )
           OR (
             active.active_count > 0
             AND active.invalid_count = 0
             AND ((active.cpu_millis + requested.cpu_millis)
               <= (n.trusted_provider_instance_vcpu_count * 1000 * policy.cpu_share_budget_percent) / 100)
             AND ((active.memory_mb + requested.memory_mb)
               <= n.trusted_provider_instance_memory_mb - policy.host_memory_reserve_mb)
             AND ((active.disk_mb + requested.disk_mb) <= n.trusted_provider_instance_disk_gb * 1024)
           )
         )
       )
       UPDATE workspaces
       SET node_id = ?,
           status = 'creating',
           vm_size = ?,
           vm_location = ?,
           workspace_profile = ?,
           devcontainer_config_name = ?,
           agent_profile_hint = ?,
           resource_requirements_json = ?,
           resolved_reservation_json = ?,
           ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS},
           updated_at = ?
       WHERE id = ?
         AND user_id = ?
         AND project_id = ?
         AND node_id IS NULL
         AND status IN ('pending', 'creating')
         AND EXISTS (SELECT 1 FROM eligible)`
    )
    .bind(
      admissionNow,
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
      input.nodeId,
      input.vmSize,
      input.vmLocation,
      input.workspaceProfile,
      input.devcontainerConfigName,
      input.agentProfileHint,
      input.resourceRequirementsJson ?? null,
      requestedReservationJson,
      ...capacityPlacementSnapshotSqlValues(input.capacityPlacementSnapshot),
      admissionNow,
      input.id,
      input.userId,
      input.projectId
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
        AND CAST(json_extract(n.metrics_json, '$.version') AS INTEGER) = 1
      )
    ))`;
}

function freshMetricsSql(): string {
  return `(n.metrics_age_ms IS NOT NULL
    AND n.metrics_age_ms >= 0
    AND n.metrics_age_ms <= policy.metrics_ttl_ms)`;
}

function trustedHardwareCapacitySql(): string {
  return `(n.trusted_provider_instance_vcpu_count IS NOT NULL
    AND n.trusted_provider_instance_memory_mb IS NOT NULL
    AND n.trusted_provider_instance_disk_gb IS NOT NULL)`;
}

function finalMeasuredPressurePredicateSql(): string {
  return `(
    (active.active_count = 0 AND n.metrics_json IS NULL AND n.metrics_malformed = 0)
    OR (
      n.metrics_json IS NOT NULL
      AND n.metrics_malformed = 0
      AND ${supportedMetricsVersionSql()}
      AND ${freshMetricsSql()}
      AND ${validCpuLoadAvg1Sql()}
      AND ${validMemoryPercentSql()}
      AND ${validDiskPercentSql()}
      AND ${validCreatingWorkspacesSql()}
      AND COALESCE(CAST(json_extract(n.metrics_json, '$.creatingWorkspaces') AS INTEGER), 0) = 0
      AND (
        ((CAST(json_extract(n.metrics_json, '$.cpuLoadAvg1') AS REAL) / n.trusted_provider_instance_vcpu_count) * 100)
          < policy.cpu_threshold_percent
      )
      AND CAST(json_extract(n.metrics_json, '$.memoryPercent') AS REAL)
        < policy.memory_threshold_percent
      AND CAST(json_extract(n.metrics_json, '$.diskPercent') AS REAL)
        < policy.disk_pressure_threshold_percent
    )
  )`;
}
