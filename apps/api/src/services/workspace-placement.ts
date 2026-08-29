import type {
  CapacityPlacementSnapshot,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';

import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';

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
  const capacityPredicate = buildCapacityPlacementPredicate(input);
  const result = await database
    .prepare(
      `INSERT INTO workspaces
         (id, node_id, project_id, user_id, installation_id, name, display_name,
          normalized_display_name, repository, branch, status, vm_size, vm_location,
          workspace_profile, devcontainer_config_name, agent_profile_hint,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
          ?, ?
       FROM nodes n
       WHERE n.id = ?
         AND n.user_id = ?
         AND n.status = 'running'
         AND n.node_role = 'workspace'
         ${capacityPredicate.sql}
         AND (
           SELECT COUNT(*)
           FROM workspaces active
           WHERE active.node_id = n.id
             AND active.status IN ('running', 'creating', 'recovery')
         ) < ?`
    )
    .bind(
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
      input.createdAt,
      input.nodeId,
      input.userId,
      ...capacityPredicate.binds,
      maxWorkspaces
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
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
    binds: [snapshot.capacityPoolId, snapshot.capacitySourceId, ...(concretePredicate?.binds ?? [])],
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
