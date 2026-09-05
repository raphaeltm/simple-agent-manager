import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';

import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import {
  ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL,
  isResolvedResourceReservation,
  RESOURCE_REQUIREMENTS_SOURCE_SQL,
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
  resolvedReservation: ResolvedResourceReservation;
  capacityPlacementSnapshot?: CapacityPlacementSnapshot | null;
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
  maxWorkspaces: number
): Promise<boolean> {
  if (
    !isResolvedResourceReservation(input.resolvedReservation) ||
    !Number.isInteger(maxWorkspaces) ||
    maxWorkspaces <= 0
  ) {
    return false;
  }
  const capacityPredicate = buildCapacityPlacementPredicate(input);
  const reservationJson = JSON.stringify(input.resolvedReservation);
  const result = await database
    .prepare(
      `WITH requested_reservation AS (
         SELECT ? AS cpu_millis,
                ? AS memory_mb,
                ? AS disk_mb,
                ? AS exclusive_node,
                ? AS max_co_tenants
       ), active_reservation_json AS (
         SELECT CASE
                  WHEN active.resolved_reservation_json IS NOT NULL
                       AND json_valid(active.resolved_reservation_json)
                    THEN active.resolved_reservation_json
                  ELSE '{}'
                END AS reservation_json
         FROM workspaces active
         WHERE active.node_id = ?
           AND active.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
       ), validated_active_reservations AS (
         SELECT reservation_json,
                CASE WHEN ${validReservationJsonSql('reservation_json')} THEN 1 ELSE 0 END AS valid
         FROM active_reservation_json
       ), active_reservations AS (
         SELECT COUNT(*) AS active_count,
                COALESCE(SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END), 0) AS invalid_count,
                COALESCE(SUM(CASE WHEN valid = 1
                  THEN json_extract(reservation_json, '$.cpuMillis') ELSE 0 END), 0) AS cpu_millis,
                COALESCE(SUM(CASE WHEN valid = 1
                  THEN json_extract(reservation_json, '$.memoryMb') ELSE 0 END), 0) AS memory_mb,
                COALESCE(SUM(CASE WHEN valid = 1
                  THEN json_extract(reservation_json, '$.diskMb') ELSE 0 END), 0) AS disk_mb,
                COALESCE(SUM(CASE WHEN valid = 1
                  THEN json_extract(reservation_json, '$.exclusiveNode') ELSE 0 END), 0) AS exclusive_count,
                MIN(CASE WHEN valid = 1
                  THEN json_extract(reservation_json, '$.maxCoTenants') END) AS minimum_max_co_tenants
         FROM validated_active_reservations
       )
       INSERT INTO workspaces
         (id, node_id, project_id, user_id, installation_id, name, display_name,
          normalized_display_name, repository, branch, status, vm_size, vm_location,
          workspace_profile, devcontainer_config_name, agent_profile_hint,
          resolved_reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?,
          ?,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
          ?, ?
       FROM nodes n, requested_reservation requested, active_reservations active
       WHERE n.id = ?
         AND n.user_id = ?
         AND n.status = 'running'
         AND n.node_role = 'workspace'
         ${capacityPredicate.sql}
         AND active.active_count < ?
         AND active.active_count + 1 <= requested.max_co_tenants
         AND (
           active.minimum_max_co_tenants IS NULL
           OR active.active_count + 1 <= active.minimum_max_co_tenants
         )
         AND (requested.exclusive_node = 0 OR active.active_count = 0)
         AND active.exclusive_count = 0
         AND (
           (
             active.active_count = 0
             AND (${unknownOrFitsSql('n.provider_instance_vcpu_count', 'requested.cpu_millis', 1_000)})
             AND (${unknownOrFitsSql('n.provider_instance_memory_mb', 'requested.memory_mb', 1)})
             AND (${unknownOrFitsSql('n.provider_instance_disk_gb', 'requested.disk_mb', 1_024)})
           )
           OR (
             active.active_count > 0
             AND active.invalid_count = 0
             AND ${knownCapacitySql('n.provider_instance_vcpu_count')}
             AND ${knownCapacitySql('n.provider_instance_memory_mb')}
             AND ${knownCapacitySql('n.provider_instance_disk_gb')}
             AND active.cpu_millis + requested.cpu_millis
               <= n.provider_instance_vcpu_count * 1000
             AND active.memory_mb + requested.memory_mb
               <= n.provider_instance_memory_mb
             AND active.disk_mb + requested.disk_mb
               <= n.provider_instance_disk_gb * 1024
           )
         )`
    )
    .bind(
      input.resolvedReservation.cpuMillis,
      input.resolvedReservation.memoryMb,
      input.resolvedReservation.diskMb,
      input.resolvedReservation.exclusiveNode ? 1 : 0,
      input.resolvedReservation.maxCoTenants,
      input.nodeId,
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
      reservationJson,
      ...capacityPlacementSnapshotSqlValues(input.capacityPlacementSnapshot),
      input.createdAt,
      input.createdAt,
      input.nodeId,
      input.userId,
      ...capacityPredicate.binds,
      maxWorkspaces
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

function validReservationJsonSql(column: string): string {
  return `json_type(${column}, '$.cpuMillis') = 'integer'
    AND json_extract(${column}, '$.cpuMillis') > 0
    AND json_type(${column}, '$.memoryMb') = 'integer'
    AND json_extract(${column}, '$.memoryMb') > 0
    AND json_type(${column}, '$.diskMb') = 'integer'
    AND json_extract(${column}, '$.diskMb') > 0
    AND json_type(${column}, '$.exclusiveNode') IN ('true', 'false')
    AND json_type(${column}, '$.maxCoTenants') = 'integer'
    AND json_extract(${column}, '$.maxCoTenants') > 0
    AND json_type(${column}, '$.source') = 'text'
    AND json_extract(${column}, '$.source') IN (${RESOURCE_REQUIREMENTS_SOURCE_SQL})
    AND json_type(${column}, '$.sourceId') = 'text'
    AND json_type(${column}, '$.version') = 'integer'
    AND json_extract(${column}, '$.version') > 0`;
}

function knownCapacitySql(column: string): string {
  return `typeof(${column}) = 'integer' AND ${column} > 0`;
}

function unknownOrFitsSql(column: string, requestColumn: string, multiplier: number): string {
  return `NOT (${knownCapacitySql(column)}) OR ${requestColumn} <= ${column} * ${multiplier}`;
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
