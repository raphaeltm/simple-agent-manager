/**
 * The shared admission SQL of the atomic workspace mutations in `workspace-placement.ts`:
 * the node scope, the requested and active reservations, and the eligibility predicate.
 * Split out of `workspace-placement.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { resolveResourceReservation } from '@simple-agent-manager/shared';

import {
  type WorkspaceAdmissionPolicy,
} from '../scheduler-core';
import { lifetimeAdmissionCutoffSql } from './node-lifetime-admission';
import { buildPlacementAuthoritySqlPredicate } from './placement-authority';
import type { WorkspacePlacementInput } from './workspace-placement';
import {
  ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL,
  RESOURCE_REQUIREMENTS_SOURCE_SQL,
} from './workspace-reservation-usage';

/** Shared admission reads and parameter ordering for both atomic workspace mutations. */
export function buildWorkspaceAdmissionSql(
  input: Pick<
    WorkspacePlacementInput,
    | 'nodeId'
    | 'projectId'
    | 'userId'
    | 'resolvedReservation'
    | 'capacityPlacementSnapshot'
    | 'authorityNodeClass'
  >,
  policy: WorkspaceAdmissionPolicy,
  /**
   * Node age past which a new placement is refused (`node-lifetime-admission.ts`). Null for a
   * restart, which keeps a workspace on its own node, or when the cutoff is disabled.
   */
  lifetimeAdmissionCutoffAgeMs: number | null
): {
  sql: string;
  binds: Array<string | number | null>;
  requestedReservationJson: string;
  admissionNow: string;
} {
  const resolvedReservation =
    input.resolvedReservation ??
    resolveResourceReservation({}, { projectId: input.projectId, userId: input.userId });
  const capacityPredicate = buildPlacementAuthoritySqlPredicate({
    userId: input.userId,
    projectId: input.projectId,
    nodeRole: 'workspace',
    workloadRole: 'workspace',
    nodeClass: input.authorityNodeClass ?? 'managed',
    capacityPlacementSnapshot: input.capacityPlacementSnapshot ?? null,
    requireProjectMembership: true,
  });
  const requestedReservationJson = JSON.stringify(resolvedReservation);
  const admissionAt = new Date();
  const admissionNow = admissionAt.toISOString();
  const lifetimeCutoff = lifetimeAdmissionCutoffSql('n', lifetimeAdmissionCutoffAgeMs, admissionAt);
  return {
    requestedReservationJson,
    admissionNow,
    sql: `WITH
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
              WHEN (n.provider_instance_id IS NOT NULL OR n.node_class = 'user-owned')
               AND n.observed_hardware_source = 'observed'
               AND typeof(n.observed_provider_instance_vcpu_count) = 'integer'
               AND n.observed_provider_instance_vcpu_count > 0
             THEN n.observed_provider_instance_vcpu_count
             ELSE NULL
           END AS trusted_provider_instance_vcpu_count,
           CASE
              WHEN (n.provider_instance_id IS NOT NULL OR n.node_class = 'user-owned')
               AND n.observed_hardware_source = 'observed'
               AND typeof(n.observed_provider_instance_memory_mb) = 'integer'
               AND n.observed_provider_instance_memory_mb > 0
             THEN n.observed_provider_instance_memory_mb
             ELSE NULL
           END AS trusted_provider_instance_memory_mb,
           CASE
              WHEN (n.provider_instance_id IS NOT NULL OR n.node_class = 'user-owned')
               AND n.observed_hardware_source = 'observed'
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
           ${lifetimeCutoff.sql}
       ),
       requested_reservation AS (
         SELECT
           ? AS reservation_json,
           ? AS cpu_millis,
           ? AS memory_mb,
           ? AS disk_mb,
           ? AS exclusive_node
       ),
       admission_policy AS (
         SELECT
           ? AS cpu_share_budget_percent,
           ? AS host_memory_reserve_mb,
           ? AS disk_pressure_threshold_percent,
           ? AS metrics_ttl_ms,
           ? AS cpu_threshold_percent
       ),
       active_reservations AS (
         SELECT
           COUNT(w.id) AS active_count,
           COALESCE(SUM(CASE WHEN w.status = 'creating' THEN 1 ELSE 0 END), 0) AS startup_backlog,
           COALESCE(SUM(CASE
             WHEN w.id IS NULL THEN 0
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')} THEN 0
             ELSE 1 END), 0) AS invalid_count,
           COALESCE(SUM(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
              AND json_extract(w.resolved_reservation_json, '$.exclusiveNode')
             THEN 1 ELSE 0 END), 0) AS exclusive_count,
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
             ELSE 0 END), 0) AS disk_mb,
           COALESCE(SUM(CASE
             WHEN ${validReservationJsonSql('w.resolved_reservation_json')}
             THEN ${observedWorkspaceMemoryCreditSql()} ELSE 0 END), 0) AS observed_memory_credit_mb
         FROM node_scope n, admission_policy policy
         LEFT JOIN workspaces w
           ON w.node_id = n.id
          AND w.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
       )`,
    binds: [
      admissionNow,
      input.nodeId,
      input.userId,
      ...capacityPredicate.binds,
      ...lifetimeCutoff.binds,
      requestedReservationJson,
      resolvedReservation.cpuMillis,
      resolvedReservation.memoryMb,
      resolvedReservation.diskMb,
      resolvedReservation.exclusiveNode ? 1 : 0,
      policy.cpuShareBudgetPercent,
      policy.hostMemoryReserveMb,
      policy.diskPressureThresholdPercent,
      policy.metricsTtlMs,
      policy.cpuThresholdPercent,
    ],
  };
}

export function workspaceAdmissionEligibilitySql(): string {
  return `active.exclusive_count = 0
         AND (requested.exclusive_node = 0 OR active.active_count = 0)
         AND ${trustedHardwareCapacitySql()}
         AND ${finalMeasuredPressurePredicateSql()}
         AND (n.metrics_json IS NULL OR (
           ${measuredHostOverheadMbSql()} + active.memory_mb + requested.memory_mb
             <= n.trusted_provider_instance_memory_mb
         ))
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
         )`;
}

/**
 * SQL twin of `measuredHostOverheadMb` (`scheduler-core/workspace-resource-capacity.ts`): the host reserve, or the
 * measured use no workspace observation explains when that is larger. Charging measured use on top
 * of the reserve counted host overhead twice; see the evaluator for the condition this encodes.
 */
function measuredHostOverheadMbSql(): string {
  const measured = `(n.trusted_provider_instance_memory_mb *
    CAST(json_extract(n.metrics_json, '$.memoryPercent') AS REAL) / 100.0)`;
  return `MAX(policy.host_memory_reserve_mb,
    ${measured} - MIN(active.observed_memory_credit_mb, ${measured}))`;
}

/** Match the advisory evaluator's credit; creating/recovery rows always retain
 * their entire reservation, including simultaneous claims on one heartbeat. */
function observedWorkspaceMemoryCreditSql(): string {
  const observations = `CASE WHEN json_type(n.metrics_json, '$.workspaceMemory') = 'array'
    THEN json_extract(n.metrics_json, '$.workspaceMemory') ELSE '[]' END`;
  const metric = `CASE WHEN metric.type = 'object' THEN metric.value ELSE '{}' END`;
  return `(CASE WHEN w.status = 'running' AND (
    SELECT COUNT(*) FROM json_each(${observations}) metric
    WHERE metric.type = 'object' AND json_extract(${metric}, '$.workspaceId') = w.id
  ) = 1 THEN COALESCE((
    SELECT MIN(CAST(json_extract(w.resolved_reservation_json, '$.memoryMb') AS REAL),
      CAST(json_extract(${metric}, '$.memoryUsageBytes') AS REAL) / 1048576.0)
    FROM json_each(${observations}) metric
    WHERE metric.type = 'object'
      AND json_extract(${metric}, '$.workspaceId') = w.id
      AND json_type(${metric}, '$.memoryUsageBytes') IN ('integer', 'real')
      AND CAST(json_extract(${metric}, '$.memoryUsageBytes') AS REAL) >= 0
      AND CAST(json_extract(${metric}, '$.memoryUsageBytes') AS REAL) <= ${Number.MAX_VALUE}
      AND json_type(${metric}, '$.collectedAt') = 'text'
      AND julianday(json_extract(${metric}, '$.collectedAt')) >= julianday(w.updated_at)
      AND julianday(json_extract(${metric}, '$.collectedAt')) <= julianday(n.last_heartbeat_at)
      AND (julianday(n.last_heartbeat_at) - julianday(json_extract(${metric}, '$.collectedAt'))) * 86400000
        <= policy.metrics_ttl_ms
  ), 0) ELSE 0 END)`;
}

function validReservationJsonSql(expression: string): string {
  return `(json_valid(${expression})
    AND json_type(${expression}, '$.version') = 'integer'
    AND json_extract(${expression}, '$.version') IN (1, 2, 3)
    AND json_type(${expression}, '$.cpuMillis') = 'integer'
    AND json_extract(${expression}, '$.cpuMillis') > 0
    AND json_type(${expression}, '$.memoryMb') = 'integer'
    AND json_extract(${expression}, '$.memoryMb') > 0
    AND json_type(${expression}, '$.diskMb') = 'integer'
    AND json_extract(${expression}, '$.diskMb') >= 0
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
      -- CPU is compressible: bootstrap load must not veto the first reservation.
      -- Read occupancy in this claim so a concurrent co-tenant cannot bypass it.
      AND (active.active_count = 0 OR (
        ((CAST(json_extract(n.metrics_json, '$.cpuLoadAvg1') AS REAL) / n.trusted_provider_instance_vcpu_count) * 100)
          < policy.cpu_threshold_percent
      ))
      AND CAST(json_extract(n.metrics_json, '$.diskPercent') AS REAL)
        < policy.disk_pressure_threshold_percent
    )
  )`;
}

/**
 * The exact node columns `resolveTrustedWorkspaceNodeCapacity` reads, as an
 * aliased SQL projection. Every node query whose rows feed capacity evaluation
 * or legacy-adoption evaluation must include this fragment: a projection that
 * omits it makes `providerInstanceId`/`observedHardwareSource` undefined, so
 * every node resolves to "no trusted observed hardware" and is silently rejected
 * — advisory selection then disagrees with the final admission SQL, which reads
 * the same columns directly off the row.
 */
export function trustedWorkspaceNodeCapacityColumnsSql(alias = ''): string {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Unsafe SQL alias: ${alias}`);
  }
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}node_class AS nodeClass,
       ${prefix}node_role AS nodeRole,
       ${prefix}provider_instance_id AS providerInstanceId,
       ${prefix}observed_provider_instance_type AS observedProviderInstanceType,
       ${prefix}observed_provider_instance_vcpu_count AS observedProviderInstanceVcpuCount,
       ${prefix}observed_provider_instance_memory_mb AS observedProviderInstanceMemoryMb,
       ${prefix}observed_provider_instance_disk_gb AS observedProviderInstanceDiskGb,
       ${prefix}observed_hardware_source AS observedHardwareSource`;
}

/** Row shape produced by `trustedWorkspaceNodeCapacityColumnsSql`. */
export interface TrustedWorkspaceNodeCapacityRow {
  nodeRole?: string | null;
  nodeClass: string | null;
  providerInstanceId: string | null;
  observedProviderInstanceType: string | null;
  observedProviderInstanceVcpuCount: number | null;
  observedProviderInstanceMemoryMb: number | null;
  observedProviderInstanceDiskGb: number | null;
  observedHardwareSource: string | null;
}
