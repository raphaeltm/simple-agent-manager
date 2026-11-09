import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';

import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
  capacityPlacementSnapshotSqlValues,
} from './capacity-placement-snapshot';
import type { PlacementAuthorityNodeClass } from './placement-authority';
import {
  buildWorkspaceAdmissionSql,
  workspaceAdmissionEligibilitySql,
} from './workspace-admission-sql';
import {
  isResolvedResourceReservation,
  type PlacementAdmissionPolicy,
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
  chatSessionId?: string | null;
  vmSize: VMSize;
  vmLocation: VMLocation;
  workspaceProfile: WorkspaceProfile;
  devcontainerConfigName: string | null;
  agentProfileHint: string | null;
  resourceRequirementsJson?: string | null;
  capacityPlacementSnapshot?: CapacityPlacementSnapshot | null;
  taskLifecycleGuard?: WorkspacePlacementTaskLifecycleGuard | null;
  authorityNodeClass?: PlacementAuthorityNodeClass;
  resolvedReservation?: ResolvedResourceReservation | null;
  /**
   * Fairness guard for ranked placement: the node's startup backlog (`creating` workspaces) the
   * caller observed when it chose this node over a less-queued alternative. The reservation is
   * refused when the backlog has since grown, so a burst that ranked the same node first spreads
   * out instead of queueing behind itself. Null or absent means no fairness guard (pins, warm
   * claims, a single candidate, or the bounded fallback); every capacity guard applies either way.
   */
  maxStartupBacklog?: number | null;
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
  policy: PlacementAdmissionPolicy
): Promise<boolean> {
  if (
    input.resolvedReservation !== undefined &&
    !isResolvedResourceReservation(input.resolvedReservation)
  ) {
    return false;
  }
  const admission = buildWorkspaceAdmissionSql(input, policy, policy.lifetimeAdmissionCutoffAgeMs);
  const taskLifecyclePredicate = buildTaskLifecyclePlacementPredicate(input.taskLifecycleGuard);
  const result = await database
    .prepare(
      `${admission.sql}
       INSERT INTO workspaces
         (id, node_id, project_id, user_id, installation_id, name, display_name,
          normalized_display_name, repository, branch, chat_session_id, status, vm_size, vm_location,
          workspace_profile, devcontainer_config_name, agent_profile_hint,
          resource_requirements_json,
          resolved_reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
          created_at, updated_at)
       -- vm_location is where the workspace actually runs: ranking can choose a node outside the
       -- requested (default) location, and a later wake prefers this value.
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, COALESCE(n.vm_location, ?), ?, ?, ?,
          ?,
          requested.reservation_json,
          ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
          ?, ?
       FROM node_scope n, requested_reservation requested, active_reservations active, admission_policy policy
         WHERE ${workspaceAdmissionEligibilitySql()}
         AND (? IS NULL OR active.startup_backlog <= ?)
         ${taskLifecyclePredicate.sql}`
    )
    .bind(
      ...admission.binds,
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
      input.resourceRequirementsJson ?? null,
      ...capacityPlacementSnapshotSqlValues(input.capacityPlacementSnapshot),
      input.createdAt,
      input.createdAt,
      input.maxStartupBacklog ?? null,
      input.maxStartupBacklog ?? null,
      ...taskLifecyclePredicate.binds
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
  policy: PlacementAdmissionPolicy
): Promise<boolean> {
  if (
    input.resolvedReservation !== undefined &&
    !isResolvedResourceReservation(input.resolvedReservation)
  ) {
    return false;
  }
  const admission = buildWorkspaceAdmissionSql(input, policy, policy.lifetimeAdmissionCutoffAgeMs);
  const result = await database
    .prepare(
      `${admission.sql},
       eligible AS (
         SELECT 1 AS ok
         FROM node_scope n, requested_reservation requested, active_reservations active, admission_policy policy
         WHERE ${workspaceAdmissionEligibilitySql()}
       )
       UPDATE workspaces
       SET node_id = ?,
           status = 'creating',
           vm_size = ?,
           vm_location = COALESCE((SELECT vm_location FROM node_scope), ?),
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
      ...admission.binds,
      input.nodeId,
      input.vmSize,
      input.vmLocation,
      input.workspaceProfile,
      input.devcontainerConfigName,
      input.agentProfileHint,
      input.resourceRequirementsJson ?? null,
      admission.requestedReservationJson,
      ...capacityPlacementSnapshotSqlValues(input.capacityPlacementSnapshot),
      admission.admissionNow,
      input.id,
      input.userId,
      input.projectId
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export type WorkspaceRestartPlacementInput = Pick<
  WorkspacePlacementInput,
  | 'id'
  | 'nodeId'
  | 'projectId'
  | 'userId'
  | 'resolvedReservation'
  | 'capacityPlacementSnapshot'
  | 'authorityNodeClass'
> & {
  chatSessionId: string | null;
  evictionGeneration: string;
  expectedEvictionGeneration: string | null;
  expectedStatus?: 'evicted' | 'stopped' | 'error';
};

/** Inactive workspaces released their reservation; restarting must reacquire it. */
export async function reserveWorkspaceRestart(
  database: D1Database,
  input: WorkspaceRestartPlacementInput,
  policy: WorkspaceAdmissionPolicy
): Promise<boolean> {
  if (!isResolvedResourceReservation(input.resolvedReservation)) return false;
  const admission = buildWorkspaceAdmissionSql(
    input,
    policy,
    // A restart keeps the workspace on its own node; refusing it would strand the workspace.
    null
  );
  const result = await database
    .prepare(
      `${admission.sql}, eligible AS (
       SELECT 1 FROM node_scope n, requested_reservation requested,
         active_reservations active, admission_policy policy
       WHERE ${workspaceAdmissionEligibilitySql()}
     )
     UPDATE workspaces SET status = 'creating', error_message = NULL, updated_at = ?,
       eviction_generation = ?, eviction_finalized_at = NULL, stop_runtime_confirmed_at = NULL
     WHERE id = ? AND node_id = ? AND user_id = ? AND project_id = ?
       AND chat_session_id IS ? AND status = ?
       AND eviction_generation IS ?
       AND (status != 'evicted' OR eviction_finalized_at IS NOT NULL)
       AND resolved_reservation_json = ? AND runtime_deletion_confirmed_at IS NULL
       AND EXISTS (SELECT 1 FROM eligible)`
    )
    .bind(
      ...admission.binds,
      admission.admissionNow,
      input.evictionGeneration,
      input.id,
      input.nodeId,
      input.userId,
      input.projectId,
      input.chatSessionId,
      input.expectedStatus ?? 'evicted',
      input.expectedEvictionGeneration,
      admission.requestedReservationJson
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Shared admission reads and parameter ordering for atomic workspace mutations. */

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
