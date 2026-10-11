import { log } from '../../lib/logger';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../services/capacity-placement-snapshot';
import {
  type CapacityPlacementSnapshotRow,
  toCapacityPlacementSnapshot,
} from '../../services/capacity-pools';
import { TaskRunnerStartGuardRevokedError } from '../../services/task-runner-start-guard';
import { releaseVmProvisioningLease } from '../../services/vm-admission-control';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Workspace statuses a task may claim; the claim SQL and its refusal reason share this list. */
const ALLOCATABLE_WORKSPACE_STATUSES: readonly string[] = ['creating', 'running', 'recovery'];
const ALLOCATABLE_WORKSPACE_STATUS_SQL = ALLOCATABLE_WORKSPACE_STATUSES.map(
  (status) => `'${status}'`
).join(', ');

export async function recoverWorkspaceFromD1(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  if (state.stepResults.workspaceId) return;

  const existingTask = await rc.env.DATABASE.prepare(
    `SELECT
       workspace_id AS workspaceId,
       status,
       capacity_pool_id AS capacityPoolId,
       capacity_pool_scope AS capacityPoolScope,
       capacity_pool_revision AS capacityPoolRevision,
       capacity_source_id AS capacitySourceId,
       capacity_source_generation AS capacitySourceGeneration,
       capacity_source_external_ref AS capacitySourceExternalRef,
       capacity_pool_candidate_id AS capacityPoolCandidateId,
       placement_credential_source AS placementCredentialSource,
       placement_credential_reference AS placementCredentialReference,
       placement_credential_version AS placementCredentialVersion,
       capacity_pool_project_id AS capacityPoolProjectId,
       workload_role AS workloadRole,
       provider_instance_type AS providerInstanceType,
       provider_instance_vcpu_count AS providerInstanceVcpuCount,
       provider_instance_memory_mb AS providerInstanceMemoryMb,
       provider_instance_disk_gb AS providerInstanceDiskGb,
       provider_instance_boot_disk_size_gb AS providerInstanceBootDiskSizeGb,
       provider_instance_image AS providerInstanceImage,
       provider_instance_architecture AS providerInstanceArchitecture,
       provider_instance_price_display AS providerInstancePriceDisplay,
       provider_instance_price_currency AS providerInstancePriceCurrency,
       provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
       provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
       placement_explanation_json AS placementExplanationJson
     FROM tasks WHERE id = ?`
  )
    .bind(state.taskId)
    .first<
      (CapacityPlacementSnapshotRow & { workspaceId: string | null; status: string }) | null
    >();

  if (!existingTask?.workspaceId) {
    await recoverWorkspaceAllocationBySession(state, rc);
    return;
  }

  state.stepResults.workspaceId = existingTask.workspaceId;
  if (state.stepResults.capacityPlacementSnapshot === undefined) {
    const snapshot = toCapacityPlacementSnapshot(existingTask);
    state.stepResults.capacityPlacementSnapshot = snapshot.capacityPoolId ? snapshot : null;
  }
  await rc.ctx.storage.put('state', state);

  log.info('task_runner_do.workspace_recovered_from_d1', {
    taskId: state.taskId,
    workspaceId: existingTask.workspaceId,
  });
}

async function recoverWorkspaceAllocationBySession(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const guard = state.config.startGuard;
  if (guard?.kind !== 'reserved_submission') return;

  const existingWorkspace = await rc.env.DATABASE.prepare(
    `SELECT
       id AS workspaceId,
       node_id AS nodeId,
       capacity_pool_id AS capacityPoolId,
       capacity_pool_scope AS capacityPoolScope,
       capacity_pool_revision AS capacityPoolRevision,
       capacity_source_id AS capacitySourceId,
       capacity_source_generation AS capacitySourceGeneration,
       capacity_source_external_ref AS capacitySourceExternalRef,
       capacity_pool_candidate_id AS capacityPoolCandidateId,
       placement_credential_source AS placementCredentialSource,
       placement_credential_reference AS placementCredentialReference,
       placement_credential_version AS placementCredentialVersion,
       capacity_pool_project_id AS capacityPoolProjectId,
       workload_role AS workloadRole,
       provider_instance_type AS providerInstanceType,
       provider_instance_vcpu_count AS providerInstanceVcpuCount,
       provider_instance_memory_mb AS providerInstanceMemoryMb,
       provider_instance_disk_gb AS providerInstanceDiskGb,
       provider_instance_boot_disk_size_gb AS providerInstanceBootDiskSizeGb,
       provider_instance_image AS providerInstanceImage,
       provider_instance_architecture AS providerInstanceArchitecture,
       provider_instance_price_display AS providerInstancePriceDisplay,
       provider_instance_price_currency AS providerInstancePriceCurrency,
       provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
       provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
       placement_explanation_json AS placementExplanationJson
     FROM workspaces
     WHERE project_id = ?
       AND user_id = ?
       AND chat_session_id = ?
       AND repository = ?
       AND status IN ('creating', 'running', 'recovery')
     ORDER BY created_at ASC
     LIMIT 1`
  )
    .bind(state.projectId, state.userId, guard.chatSessionId, state.config.repository)
    .first<CapacityPlacementSnapshotRow & { workspaceId: string; nodeId: string | null }>();

  if (!existingWorkspace?.workspaceId) return;

  state.stepResults.workspaceId = existingWorkspace.workspaceId;
  state.stepResults.nodeId = state.stepResults.nodeId ?? existingWorkspace.nodeId;
  if (state.stepResults.capacityPlacementSnapshot === undefined) {
    const snapshot = toCapacityPlacementSnapshot(existingWorkspace);
    state.stepResults.capacityPlacementSnapshot = snapshot.capacityPoolId ? snapshot : null;
  }
  await rc.ctx.storage.put('state', state);

  log.info('task_runner_do.workspace_recovered_from_session_allocation', {
    taskId: state.taskId,
    workspaceId: existingWorkspace.workspaceId,
  });
}

export async function claimWorkspaceAllocationForTask(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  now: string
): Promise<void> {
  const chatSessionId = state.stepResults.chatSessionId ?? state.config.chatSessionId ?? null;
  const guard =
    state.config.startGuard?.kind === 'reserved_submission' ? state.config.startGuard : null;
  const reservedIntentFingerprint = guard?.intentFingerprint ?? null;
  // Some ordinary starts only link their session in ensureSessionLinked after this
  // claim, so they may claim a task row that has none yet. Dispatched tasks carry it
  // from their INSERT; reserved submissions committed it with the checkpoint.
  const result = await rc.env.DATABASE.prepare(
    `UPDATE tasks
        SET workspace_id = ?, ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS}, updated_at = ?
      WHERE id = ?
        AND project_id = ?
        AND user_id = ?
        AND status = 'queued'
        AND workspace_id IS NULL
        AND (
          ? IS NULL OR chat_session_id = ?
          OR (? = 0 AND chat_session_id IS NULL)
        )
        AND EXISTS (
          SELECT 1
            FROM workspaces guarded_workspace
           WHERE guarded_workspace.id = ?
             AND guarded_workspace.project_id = tasks.project_id
             AND guarded_workspace.user_id = tasks.user_id
             AND (? IS NULL OR guarded_workspace.chat_session_id = ?)
             AND guarded_workspace.status IN (${ALLOCATABLE_WORKSPACE_STATUS_SQL})
        )
        AND NOT EXISTS (
          SELECT 1
            FROM reserved_task_session_revocations revoked_session
           WHERE revoked_session.project_id = tasks.project_id
             AND revoked_session.chat_session_id = tasks.chat_session_id
        )
        AND (
          ? IS NULL
          OR EXISTS (
            SELECT 1
              FROM task_submission_checkpoints guarded_checkpoint
             WHERE guarded_checkpoint.task_id = tasks.id
               AND guarded_checkpoint.intent_fingerprint = ?
               AND guarded_checkpoint.chat_session_id = ?
          )
        )`
  )
    .bind(
      workspaceId,
      ...capacityPlacementSnapshotSqlValues(state.stepResults.capacityPlacementSnapshot),
      now,
      state.taskId,
      state.projectId,
      state.userId,
      chatSessionId,
      chatSessionId,
      guard ? 1 : 0,
      workspaceId,
      chatSessionId,
      chatSessionId,
      reservedIntentFingerprint,
      reservedIntentFingerprint,
      chatSessionId
    )
    .run();

  if (result.meta.changes && result.meta.changes > 0) return;

  const winner = await rc.env.DATABASE.prepare(
    `SELECT t.project_id AS projectId, t.user_id AS userId, t.status, t.workspace_id AS workspaceId,
            t.chat_session_id AS taskChatSessionId, r.reason AS revocationReason,
            w.status AS workspaceStatus, w.chat_session_id AS workspaceChatSessionId,
            c.intent_fingerprint AS checkpointIntentFingerprint,
            c.chat_session_id AS checkpointChatSessionId
       FROM tasks t
       LEFT JOIN reserved_task_session_revocations r
         ON r.project_id = t.project_id
        AND r.chat_session_id = t.chat_session_id
       LEFT JOIN workspaces w
         ON w.id = ?
        AND w.project_id = t.project_id
        AND w.user_id = t.user_id
       LEFT JOIN task_submission_checkpoints c ON c.task_id = t.id
      WHERE t.id = ?
      LIMIT 1`
  )
    .bind(workspaceId, state.taskId)
    .first<WorkspaceClaimRow>();

  if (winner?.workspaceId === workspaceId) return;

  const reason = describeWorkspaceClaimRefusal(winner, {
    taskId: state.taskId,
    projectId: state.projectId,
    userId: state.userId,
    workspaceId,
    chatSessionId,
    reservedIntentFingerprint,
  });
  await tombstoneUndispatchedWorkspaceAllocation(state, rc, workspaceId, reason);
  state.stepResults.workspaceId = null;
  await rc.ctx.storage.put('state', state);
  // Every refusal means this start no longer owns the task: the allocation is
  // abandoned above and the start fails permanently; nothing retries it.
  throw new TaskRunnerStartGuardRevokedError(
    guard
      ? `Reserved task submission authority revoked before workspace assignment: ${reason}`
      : `Task start abandoned before workspace assignment: ${reason}`
  );
}

interface WorkspaceClaimRow {
  projectId: string;
  userId: string;
  status: string;
  workspaceId: string | null;
  taskChatSessionId: string | null;
  revocationReason: string | null;
  workspaceStatus: string | null;
  workspaceChatSessionId: string | null;
  checkpointIntentFingerprint: string | null;
  checkpointChatSessionId: string | null;
}

interface WorkspaceClaim {
  taskId: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  chatSessionId: string | null;
  reservedIntentFingerprint: string | null;
}

/**
 * Name the claim predicate the current rows fail: the task's own state first,
 * then its session, then the allocated workspace, then the reserved checkpoint.
 */
export function describeWorkspaceClaimRefusal(
  row: WorkspaceClaimRow | null,
  claim: WorkspaceClaim
): string {
  if (!row) return `task ${claim.taskId} no longer exists`;
  if (row.projectId !== claim.projectId || row.userId !== claim.userId) {
    return `task ${claim.taskId} now belongs to a different project or user`;
  }
  if (row.status !== 'queued') return `task is ${row.status}, not queued`;
  if (row.workspaceId) return `task is already assigned to workspace ${row.workspaceId}`;
  const reserved = claim.reservedIntentFingerprint !== null;
  if (
    claim.chatSessionId &&
    row.taskChatSessionId !== claim.chatSessionId &&
    (row.taskChatSessionId !== null || reserved)
  ) {
    return row.taskChatSessionId
      ? `task is bound to chat session ${row.taskChatSessionId}, not this start's session ${claim.chatSessionId}`
      : `task has no chat session; this start owns session ${claim.chatSessionId}`;
  }
  if (row.revocationReason) {
    return `chat session ${row.taskChatSessionId} was revoked (${row.revocationReason})`;
  }
  if (!row.workspaceStatus) return `workspace ${claim.workspaceId} no longer exists`;
  if (!ALLOCATABLE_WORKSPACE_STATUSES.includes(row.workspaceStatus)) {
    return `workspace ${claim.workspaceId} is ${row.workspaceStatus}`;
  }
  if (claim.chatSessionId && row.workspaceChatSessionId !== claim.chatSessionId) {
    return `workspace ${claim.workspaceId} is bound to chat session ${row.workspaceChatSessionId ?? 'none'}, not ${claim.chatSessionId}`;
  }
  if (
    reserved &&
    (row.checkpointIntentFingerprint !== claim.reservedIntentFingerprint ||
      row.checkpointChatSessionId !== claim.chatSessionId)
  ) {
    return `reserved submission checkpoint no longer matches this start`;
  }
  return `task ${claim.taskId} changed before workspace assignment`;
}

export async function recoverReservedWorkspaceAllocationForCleanup(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  if (state.stepResults.workspaceId) return;
  const guard = state.config.startGuard;
  if (guard?.kind !== 'reserved_submission') return;

  const workspace = await rc.env.DATABASE.prepare(
    `SELECT id, node_id AS nodeId
       FROM workspaces
      WHERE project_id = ?
        AND user_id = ?
        AND chat_session_id = ?
        AND repository = ?
        AND status IN ('creating', 'running', 'recovery')
      ORDER BY created_at ASC
      LIMIT 1`
  )
    .bind(state.projectId, state.userId, guard.chatSessionId, state.config.repository)
    .first<{ id: string; nodeId: string | null }>();

  if (!workspace) return;
  state.stepResults.workspaceId = workspace.id;
  state.stepResults.nodeId = state.stepResults.nodeId ?? workspace.nodeId;
  await rc.ctx.storage.put('state', state);

  log.info('task_runner_do.cleanup.workspace_recovered_from_reserved_session', {
    taskId: state.taskId,
    workspaceId: workspace.id,
  });
}

async function tombstoneUndispatchedWorkspaceAllocation(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  await rc.env.DATABASE.prepare(
    `UPDATE workspaces
        SET status = 'stopped', error_message = ?, updated_at = ?
      WHERE id = ?
        AND project_id = ?
        AND user_id = ?
        AND status = 'creating'
        AND dispatched_at IS NULL`
  )
    .bind(
      `Workspace allocation abandoned before dispatch: ${reason}`,
      now,
      workspaceId,
      state.projectId,
      state.userId
    )
    .run();

  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'workspace_assignment_revoked'
  );
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
}
