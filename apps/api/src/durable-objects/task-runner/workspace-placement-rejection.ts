/**
 * What the TaskRunner does when the final atomic workspace reservation
 * (`reserveWorkspacePlacement`) refuses the node it selected.
 *
 * A refusal is normally a lost race: another run took the capacity, so the task
 * goes back to node selection. But a refusal that repeats on every cycle means the
 * node can never admit this request. Before the cap, a freshly provisioned node
 * that its own task could not fit was re-adopted from `tasks.auto_provisioned_node_id`
 * every ~6 s until the 15-minute provisioning timeout (2026-11-05 staging). The cap
 * fails the task fast instead, with the refusal reasons, and keeps the node on the
 * run so failure cleanup hands a node this task provisioned to the warm pool.
 *
 * One refusal is not a capacity verdict at all: a startup-backlog conflict, where the node's
 * startup queue grew after this run ranked it above another admitted node
 * (`resolveStartupBacklogGuard`). Those replan freshly without spending the rejection budget,
 * and after a bounded number the next reservation drops only the backlog guard.
 */
import { log } from '../../lib/logger';
import { resolveAdminSetting } from '../../services/admin-settings-resolution';
import {
  isNodePastLifetimeAdmissionCutoff,
  LIFETIME_ADMISSION_CUTOFF_REASON,
} from '../../services/node-lifetime-admission';
import { releaseVmProvisioningLease } from '../../services/vm-admission-control';
import {
  evaluateWorkspaceReservationCapacity,
  loadActiveWorkspaceReservationUsage,
  type PlacementAdmissionPolicy,
  trustedWorkspaceNodeCapacityColumnsSql,
  type WorkspaceResourceNode,
} from '../../services/workspace-resource-capacity';
import { getTaskReservation } from './node-selection-shared';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Prefix of the placement-diagnostics note this module owns; replaced on each refusal. */
export const WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX = 'Workspace placement refused';
export const STARTUP_BACKLOG_CONFLICT_REASON =
  'node startup queue grew after it was ranked above another admitted node';
const UNEXPLAINED_REFUSAL_REASON =
  'final reservation refused although advisory capacity admitted the node (a concurrent placement or a placement-authority change won)';

interface PlacementRefusal {
  reasons: string[];
  /**
   * Capacity still admits the run; only the startup-backlog guard refused it. Fairness, not
   * evidence that the node cannot fit.
   */
  backlogConflict: boolean;
}

/**
 * The startup-backlog guard for a reservation on `nodeId`: the backlog observed when the node was
 * ranked above an alternative, or null for no guard. After
 * `operations.workspacePlacementBacklogConflictRetries` consecutive conflicts the guard is dropped,
 * so a run that keeps losing the race to the shortest queue still places. Every capacity,
 * telemetry and authority guard stays in the reservation SQL either way.
 */
export async function resolveStartupBacklogGuard(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string
): Promise<number | null> {
  const ranked = state.stepResults.rankedStartupBacklog;
  if (!ranked || ranked.nodeId !== nodeId) return null;
  const conflicts = state.startupBacklogConflicts ?? 0;
  if (conflicts > 0) {
    const maxConflicts = Number(
      await resolveAdminSetting(rc.env, 'operations.workspacePlacementBacklogConflictRetries')
    );
    if (conflicts >= maxConflicts) return null;
  }
  return ranked.backlog;
}

/**
 * Handle a refused reservation on `nodeId`. Returns after scheduling the replan;
 * throws a permanent error when the refusal is final (specified node, or the cap).
 */
export async function handleWorkspacePlacementRefused(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string,
  admissionPolicy: PlacementAdmissionPolicy,
  maxStartupBacklog: number | null
): Promise<void> {
  await rc.assertRecoveryAuthority(state);
  const refusal = await diagnoseWorkspacePlacementRefusal(
    state,
    rc,
    nodeId,
    admissionPolicy,
    maxStartupBacklog
  );
  // A backlog conflict says nothing about whether the node fits: it only means a shorter
  // queue may now be elsewhere. It must not spend the budget that fails the task.
  const rejections = refusal.backlogConflict
    ? (state.workspacePlacementRejections ?? 0)
    : (state.workspacePlacementRejections ?? 0) + 1;
  state.workspacePlacementRejections = rejections;
  state.startupBacklogConflicts = refusal.backlogConflict
    ? (state.startupBacklogConflicts ?? 0) + 1
    : (state.startupBacklogConflicts ?? 0);
  const maxRejections = Number(
    await resolveAdminSetting(rc.env, 'operations.workspacePlacementMaxRejections')
  );
  const note = `${WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX} by node ${nodeId} (${rejections}/${maxRejections} consecutive): ${refusal.reasons.join('; ')}`;
  await persistPlacementDiagnostics(state, rc, {
    selectedNodeId: null,
    revalidatedAgainstCurrentAuthority: false,
    notes: [
      ...(state.stepResults.placementDiagnostics?.notes ?? []).filter(
        (existing) => !existing.startsWith(WORKSPACE_PLACEMENT_REFUSED_NOTE_PREFIX)
      ),
      note,
    ],
  });
  log.warn('task_runner_do.workspace_placement_lost', {
    taskId: state.taskId,
    nodeId,
    reasons: refusal.reasons,
    rejections,
    maxRejections,
    backlogConflict: refusal.backlogConflict,
    startupBacklogConflicts: state.startupBacklogConflicts,
    autoProvisioned: state.stepResults.autoProvisioned,
    cpuShareBudgetPercent: admissionPolicy.cpuShareBudgetPercent,
    hostMemoryReserveMb: admissionPolicy.hostMemoryReserveMb,
    diskPressureThresholdPercent: admissionPolicy.diskPressureThresholdPercent,
    preferredNode: state.config.preferredNodeId === nodeId,
  });

  if (state.config.preferredNodeId === nodeId) {
    const pastCutoff = refusal.reasons.includes(LIFETIME_ADMISSION_CUTOFF_REASON);
    throw Object.assign(
      new Error(
        pastCutoff
          ? `Specified node: ${LIFETIME_ADMISSION_CUTOFF_REASON}`
          : 'Specified node lost capacity or became unavailable before workspace creation'
      ),
      { permanent: true }
    );
  }

  if (rejections >= maxRejections) {
    // Keep stepResults.nodeId/autoProvisioned: cleanupOnFailure warm-hands-off a node this
    // task provisioned and leaves a reused node alone.
    throw Object.assign(
      new Error(
        `Workspace placement was refused ${rejections} times in a row; node ${nodeId} cannot admit this task: ${refusal.reasons.join('; ')}`
      ),
      { permanent: true }
    );
  }

  state.stepResults.nodeId = null;
  state.stepResults.autoProvisioned = false;
  state.stepResults.provisionedVmSize = null;
  state.stepResults.capacityPlacementSnapshot = null;
  state.stepResults.rankedStartupBacklog = null;
  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'workspace_placement_lost'
  );
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
  await rc.advanceToStep(state, 'node_selection');
}

/**
 * Re-run the shared capacity evaluator on the node the final reservation refused, so the
 * failure names the condition instead of "placement lost". Diagnostic only: the atomic SQL
 * already decided, and it applies the same accounting (`workspace-admission-sql.ts`).
 */
async function diagnoseWorkspacePlacementRefusal(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string,
  policy: PlacementAdmissionPolicy,
  maxStartupBacklog: number | null
): Promise<PlacementRefusal> {
  const node = await rc.env.DATABASE.prepare(
    `SELECT id, status, ${trustedWorkspaceNodeCapacityColumnsSql()},
       last_metrics AS lastMetrics, last_heartbeat_at AS lastHeartbeatAt
     FROM nodes WHERE id = ? AND user_id = ?`
  )
    .bind(nodeId, state.userId)
    .first<WorkspaceResourceNode & { status: string }>();
  if (!node) return { reasons: ['node no longer exists'], backlogConflict: false };
  if (node.status !== 'running') {
    return { reasons: [`node is ${node.status}, not running`], backlogConflict: false };
  }
  const usage = await loadActiveWorkspaceReservationUsage(rc.env.DATABASE, [nodeId]);
  const nodeUsage = usage.get(nodeId);
  const evaluation = evaluateWorkspaceReservationCapacity(
    node,
    nodeUsage,
    getTaskReservation(state),
    policy
  );
  const reasons = [...evaluation.reasons];
  if (
    await isNodePastLifetimeAdmissionCutoff(
      rc.env.DATABASE,
      nodeId,
      policy.lifetimeAdmissionCutoffAgeMs
    )
  ) {
    reasons.push(LIFETIME_ADMISSION_CUTOFF_REASON);
  }
  const startupBacklog = nodeUsage?.startupBacklog ?? 0;
  if (reasons.length === 0 && maxStartupBacklog !== null && startupBacklog > maxStartupBacklog) {
    return {
      reasons: [
        `${STARTUP_BACKLOG_CONFLICT_REASON} (${maxStartupBacklog} when ranked, ${startupBacklog} now)`,
      ],
      backlogConflict: true,
    };
  }
  if (reasons.length === 0) reasons.push(UNEXPLAINED_REFUSAL_REASON);
  return { reasons, backlogConflict: false };
}
