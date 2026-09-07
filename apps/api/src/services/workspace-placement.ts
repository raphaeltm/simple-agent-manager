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
  chatSessionId?: string | null;
  vmSize: VMSize;
  vmLocation: VMLocation;
  workspaceProfile: WorkspaceProfile;
  devcontainerConfigName: string | null;
  agentProfileHint: string | null;
  capacityPlacementSnapshot?: CapacityPlacementSnapshot | null;
  taskLifecycleGuard?: WorkspacePlacementTaskLifecycleGuard | null;
  createdAt: string;
}

export interface WorkspacePlacementTaskLifecycleGuard {
  taskId: string;
  projectId: string;
  userId: string;
  chatSessionId: string | null;
  requireChatSessionMatch?: boolean;
  reservedIntentFingerprint?: string | null;
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
  const taskLifecyclePredicate = buildTaskLifecyclePlacementPredicate(input.taskLifecycleGuard);
  const result = await database
    .prepare(
      `INSERT INTO workspaces
         (id, node_id, project_id, user_id, installation_id, name, display_name,
          normalized_display_name, repository, branch, chat_session_id, status, vm_size, vm_location,
          workspace_profile, devcontainer_config_name, agent_profile_hint,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
          created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
          ?, ?
       FROM nodes n
       WHERE n.id = ?
         AND n.user_id = ?
         AND n.status = 'running'
         AND n.node_role = 'workspace'
         ${capacityPredicate.sql}
         ${taskLifecyclePredicate.sql}
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
      input.chatSessionId ?? null,
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
      ...taskLifecyclePredicate.binds,
      maxWorkspaces
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

function buildTaskLifecyclePlacementPredicate(
  guard: WorkspacePlacementTaskLifecycleGuard | null | undefined
): {
  sql: string;
  binds: Array<string | number | null>;
} {
  if (!guard) return { sql: '', binds: [] };

  const requireChatSessionMatch = guard.requireChatSessionMatch === true ? 1 : 0;
  const reservedIntentFingerprint = guard.reservedIntentFingerprint ?? null;
  return {
    sql: `AND EXISTS (
           SELECT 1
             FROM tasks guarded_task
            WHERE guarded_task.id = ?
              AND guarded_task.project_id = ?
              AND guarded_task.user_id = ?
              AND guarded_task.status = 'queued'
              AND guarded_task.workspace_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM reserved_task_session_revocations guarded_revocation
                 WHERE guarded_revocation.project_id = guarded_task.project_id
                   AND guarded_revocation.chat_session_id = guarded_task.chat_session_id
              )
              AND (? IS NULL OR ? = 0 OR guarded_task.chat_session_id = ?)
              AND (
                ? IS NULL
                OR EXISTS (
                  SELECT 1
                    FROM task_submission_checkpoints guarded_checkpoint
                   WHERE guarded_checkpoint.task_id = guarded_task.id
                     AND guarded_checkpoint.intent_fingerprint = ?
                     AND guarded_checkpoint.chat_session_id = ?
                )
              )
         )`,
    binds: [
      guard.taskId,
      guard.projectId,
      guard.userId,
      guard.chatSessionId,
      requireChatSessionMatch,
      guard.chatSessionId,
      reservedIntentFingerprint,
      reservedIntentFingerprint,
      guard.chatSessionId,
    ],
  };
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
