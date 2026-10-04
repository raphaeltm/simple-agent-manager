import { ACP_SESSION_TERMINAL_STATUSES, type AcpSessionStatus } from '@simple-agent-manager/shared';

import { isVmNodeHeartbeatStale, TERMINAL_NODE_STATUSES } from './task-runtime-liveness-node-probe';
import {
  INCONCLUSIVE_WORKSPACE_STATUSES,
  isSessionResumable,
} from './task-runtime-liveness-recoverability';
import type {
  RuntimeWorkspaceSnapshot,
  TaskRuntimeLiveness,
  TaskRuntimeLivenessSignals,
} from './task-runtime-liveness-types';

export type {
  ContainerLifecycleSnapshot,
  NodeHealthProbeOutcome,
  ResumabilityProbeOutcome,
  RuntimeAcpSessionSnapshot,
  RuntimeProbeOutcome,
  RuntimeSessionWorkSnapshot,
  RuntimeWorkspaceSnapshot,
  SessionResumabilitySnapshot,
  SupersessionProbeOutcome,
  TaskAcpLivenessSignals,
  TaskLivenessNodeHealthProbeEnv,
  TaskLivenessNodeHealthProbeResult,
  TaskRuntimeLiveness,
  TaskRuntimeLivenessSignals,
  TaskSupersession,
} from './task-runtime-liveness-types';

/**
 * Reason suffix marking a conclusive verdict that is a *supersession* rather
 * than a runtime death. Terminal writers key on this to record the benign
 * cancellation status instead of `failed`.
 */
export const SUPERSEDED_TERMINAL_REASON_SUFFIX = '_superseded_by_completed_wake';

export {
  classifyTaskRuntimeDelivery,
  type TaskRuntimeDeliveryDisposition,
} from './task-runtime-liveness-delivery';
export {
  getTaskLivenessNodeHealthProbeTimeoutMs,
  needsNodeHealthProbe,
  probeNodeHealthForTaskLiveness,
} from './task-runtime-liveness-node-probe';
export {
  isSessionResumable,
  needsSessionResumabilityProbe,
  needsTaskSupersessionProbe,
} from './task-runtime-liveness-recoverability';

/** True when a conclusive verdict was reached because the wake moved on. */
export function isSupersededTerminalReason(reason: string): boolean {
  return reason.endsWith(SUPERSEDED_TERMINAL_REASON_SUFFIX);
}

const ACTIVE_ACP_STATUSES = new Set<AcpSessionStatus>(['assigned', 'running']);
const TERMINAL_ACP_STATUSES = new Set<AcpSessionStatus>(ACP_SESSION_TERMINAL_STATUSES);
const TERMINAL_CONTAINER_STATUSES = new Set(['stopping', 'stopped', 'expired', 'error']);

/**
 * A task whose conversation has been handed to a live successor is superseded,
 * not dead. Returns the inconclusive verdict that must pre-empt any
 * conclusive-death return, or null when supersession cannot explain the state.
 *
 * This is the `.claude/rules/58` pairing for task lineage: the resumer
 * (`claimSessionSnapshotRecovery` via `sourceTaskGuardCondition`) requires the
 * source task to be NON-terminal, so failing a superseded predecessor does not
 * merely mislabel it — it permanently revokes the guarded/parent wake path for
 * that conversation.
 */
function supersessionVerdict(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reasonPrefix: string
): TaskRuntimeLiveness | null {
  if (signals.supersessionProbeOutcome === 'error') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_supersession_unknown`,
      activeAcpSessionId: null,
    });
  }
  if (signals.supersession === 'live') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_superseded_by_live_wake`,
      activeAcpSessionId: null,
    });
  }
  if (signals.supersession === 'terminal') {
    // Bounded escape (`.claude/rules/47`): the conversation is over, so the task
    // must leave the candidate set. But it ended by supersession, not runtime
    // death, so the verdict carries the marker that makes terminal writers record
    // a benign cancellation instead of a failure.
    //
    // Safe with respect to the wake path: a superseded predecessor always has a
    // NULL `chat_session_id` (the handoff's stmt 2 clears it), and `terminal`
    // means no live recovery owner exists — so both branches of
    // `sourceTaskGuardCondition`'s OR are already false and the guarded wake was
    // failing for this task regardless of its status.
    return result(workspace, {
      live: false,
      conclusive: true,
      reason: `${reasonPrefix}${SUPERSEDED_TERMINAL_REASON_SUFFIX}`,
      activeAcpSessionId: null,
    });
  }
  return null;
}

/**
 * A conversation that is asleep, or on its way to sleep, is not dead — even when
 * every workspace/node signal says it is, because sleeping is exactly what
 * deletes those rows.
 *
 * This is the `.claude/rules/58` pairing for the sleep lifecycle, and it is keyed
 * on the TASK's `chat_session_id` rather than the workspace's, so it still fires
 * for the three shapes that make `sessionResumability` unreachable: a NULL
 * `tasks.workspace_id`, a NULL `workspaces.chat_session_id` after a wake handoff,
 * and a snapshot row whose own `workspace_id` is NULL. The adapters resolve it
 * through `loadTaskSleepPreservation`, which reuses the resumer's own
 * `restorableOrInFlightSleepSnapshotPredicateSql` verbatim.
 *
 * Returns the inconclusive verdict that must pre-empt a conclusive-death return,
 * or null when sleep cannot explain the state. Both outcomes are bounded — see
 * `loadTaskSleepPreservation` — so this can never make a task immortal.
 */
function sessionSleepVerdict(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reasonPrefix: string
): TaskRuntimeLiveness | null {
  if (signals.taskSessionSleep === 'unknown') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_session_sleep_unknown`,
      activeAcpSessionId: null,
    });
  }
  if (signals.taskSessionSleep === 'preserve') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_session_sleeping`,
      activeAcpSessionId: null,
    });
  }
  return null;
}

/**
 * The ONE way to build a conclusive "this runtime is dead" verdict.
 *
 * Routing every such return through here is what makes the sleep escape hold by
 * construction: the first cut of this fix guarded only `workspace_missing` and
 * `workspace_<status>`, leaving `node_not_live`, `cf_container_<terminal>` and
 * `task_acp_session_terminal` unguarded — all three reachable while
 * `workspaces.status` still reads `running`, which is precisely the window
 * between a node being destroyed for sleep and the workspace row catching up
 * (the five-minute gap in the `.claude/rules/58` incident). Production carried
 * that shape: `node_not_live` with a `scheduled` snapshot, twice in 30 days.
 *
 * The SUPERSESSION half is deliberately inert at those same three sites, and that
 * is not an oversight: they sit downstream of the `workspace.status !== 'running'`
 * early return, while `needsTaskSupersessionProbe` fires only for the opposite
 * condition — so `signals.supersession` is always its `'none'` default there.
 * Nor could a real superseded task reach them: the wake handoff nulls
 * `workspaces.chat_session_id`, so it exits earlier and inconclusively at
 * `workspace_runtime_identity_incomplete`. It is kept uniform here as
 * defence-in-depth against that invariant changing; do not spend time trying to
 * write a test that proves it discriminating at those three sites.
 */
function conclusiveDeath(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reason: string,
  activeAcpSessionId: string | null = null
): TaskRuntimeLiveness {
  return (
    sessionSleepVerdict(signals, workspace, reason) ??
    supersessionVerdict(signals, workspace, reason) ??
    result(workspace, { live: false, conclusive: true, reason, activeAcpSessionId })
  );
}

/**
 * Whether a conclusive-death verdict was reached without the task-scoped sleep
 * signal ever being loaded. Adapters use this to pay for the lookup only for a
 * candidate they are otherwise about to terminalize (`.claude/rules/47`,
 * `.claude/rules/58` requirement 6) — the same classify → probe → re-classify
 * shape as `needsNodeHealthProbe`.
 *
 * It fires precisely on the three conclusive-death paths reachable while
 * `workspaces.status` still reads `running` — `node_not_live`,
 * `cf_container_<terminal>` and `task_acp_session_terminal` — because
 * `needsTaskSupersessionProbe` and `needsSessionResumabilityProbe` both decline
 * for a running workspace, leaving both escapes unpopulated there.
 */
export function needsDeferredSessionSleepProbe(
  liveness: TaskRuntimeLiveness,
  signals: TaskRuntimeLivenessSignals
): boolean {
  if (signals.taskSessionSleep !== 'not_run') return false;
  if (!liveness.conclusive || liveness.live) return false;
  // A supersession is already a benign, correctly-labelled ending; re-probing
  // would only preserve a task whose conversation demonstrably moved on.
  return !isSupersededTerminalReason(liveness.reason);
}

function result(
  workspace: RuntimeWorkspaceSnapshot | null,
  values: Omit<TaskRuntimeLiveness, 'workspaceStatus' | 'nodeId'>
): TaskRuntimeLiveness {
  return {
    ...values,
    workspaceStatus: workspace?.status ?? null,
    nodeId: workspace?.nodeId ?? null,
    ...(workspace?.nodeId && workspace.userId
      ? { deliveryTarget: { nodeId: workspace.nodeId, userId: workspace.userId } }
      : {}),
  };
}

/**
 * Pure task-runtime classifier shared by scheduled recovery and ProjectData's
 * local idle-cleanup adapter. Activity silence is never runtime-death evidence,
 * but fresh ProjectData prompt/runtime-work state is positive liveness evidence.
 */
export function classifyTaskRuntimeLiveness(
  signals: TaskRuntimeLivenessSignals
): TaskRuntimeLiveness {
  const workspace = signals.workspace;
  if (signals.workspaceProbeOutcome !== 'ok') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: 'task_liveness_unknown',
      activeAcpSessionId: null,
    });
  }
  if (!signals.taskWorkspaceId || !workspace) {
    // There is no workspace row to hang a resumability probe off, so the
    // task-scoped sleep lookup is the ONLY thing standing between a slept
    // conversation and a `failed` verdict on this branch. Four production
    // terminalizations in the 2026-09-07..14 window landed here with a `sleeping`
    // snapshot (`.claude/rules/58`).
    return conclusiveDeath(signals, workspace, 'workspace_missing');
  }

  if (signals.expectedChatSessionId && workspace.chatSessionId !== signals.expectedChatSessionId) {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: 'workspace_chat_session_mismatch',
      activeAcpSessionId: null,
    });
  }

  if (INCONCLUSIVE_WORKSPACE_STATUSES.has(workspace.status)) {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `workspace_${workspace.status}_resumable`,
      activeAcpSessionId: null,
    });
  }

  if (workspace.status !== 'running') {
    // Sleep is not death. A slept session keeps a restorable `session_snapshots`
    // row that `session-recovery.ts` can wake even when the workspace row reads
    // `deleted`, so terminalizing here would destroy recoverable work.
    if (signals.resumabilityProbeOutcome === 'error') {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: `workspace_${workspace.status}_resumability_unknown`,
        activeAcpSessionId: null,
      });
    }
    if (
      isSessionResumable(signals.sessionResumability, signals.projectId, workspace.id, {
        maxRecoveryAttempts: signals.resumabilityMaxRecoveryAttempts,
        recoveryAttemptDecayMs: signals.resumabilityRecoveryAttemptDecayMs,
        nowMs: signals.nowMs,
      })
    ) {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: `workspace_${workspace.status}_snapshot_resumable`,
        activeAcpSessionId: null,
      });
    }
    // Second-chance sleep escape, after `_snapshot_resumable` so the more
    // specific reason still wins when the workspace-scoped probe DID run. It
    // catches the cases that probe structurally cannot see — a NULL
    // `workspaces.chat_session_id`, or a snapshot whose `workspace_id` does not
    // match this incarnation (`.claude/rules/63`).
    //
    // Supersession stays last among the inconclusive escapes, but still before
    // any conclusive-death return.
    return conclusiveDeath(signals, workspace, `workspace_${workspace.status}`);
  }

  if (!workspace.chatSessionId || !workspace.nodeId) {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: 'workspace_runtime_identity_incomplete',
      activeAcpSessionId: null,
    });
  }

  if (workspace.nodeRuntime === 'cf-container') {
    if (signals.containerProbeOutcome === 'timeout') {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: 'cf_container_lifecycle_timeout',
        activeAcpSessionId: null,
      });
    }
    if (signals.containerProbeOutcome !== 'ok' || !signals.containerLifecycle) {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: 'cf_container_lifecycle_unknown',
        activeAcpSessionId: null,
      });
    }

    const lifecycleStatus = signals.containerLifecycle.status;
    if (lifecycleStatus && TERMINAL_CONTAINER_STATUSES.has(lifecycleStatus)) {
      return conclusiveDeath(signals, workspace, `cf_container_${lifecycleStatus}`);
    }
    if (lifecycleStatus === 'running' && signals.containerLifecycle.activeWorkStatus === 'active') {
      return result(workspace, {
        live: true,
        conclusive: true,
        reason: 'cf_container_active_work',
        activeAcpSessionId: null,
      });
    }
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `cf_container_${lifecycleStatus ?? 'unknown'}_resumable`,
      activeAcpSessionId: null,
    });
  }

  if (workspace.nodeStatus && TERMINAL_NODE_STATUSES.has(workspace.nodeStatus)) {
    return conclusiveDeath(signals, workspace, 'node_not_live');
  }

  const nodeHeartbeatStale = isVmNodeHeartbeatStale(
    workspace,
    signals.nowMs,
    signals.heartbeatStaleMs
  );
  if (nodeHeartbeatStale) {
    if (signals.nodeHealthProbeOutcome === 'failed') {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: 'node_health_probe_failed',
        activeAcpSessionId: null,
      });
    }
    if (signals.nodeHealthProbeOutcome === 'timeout') {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: 'node_health_probe_timeout',
        activeAcpSessionId: null,
      });
    }
    if (signals.nodeHealthProbeOutcome === 'error') {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: 'node_health_probe_error',
        activeAcpSessionId: null,
      });
    }
    if (signals.nodeHealthProbeOutcome !== 'ok') {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason:
          (workspace.runningWorkspacesOnNode ?? 0) > 0
            ? 'node_heartbeat_stale_running_workspaces'
            : 'node_heartbeat_stale_probe_required',
        activeAcpSessionId: null,
      });
    }
    // The stale D1 node fields have been contradicted by the runtime authority.
    // Continue to the task-scoped ACP check; node health alone is not proof the
    // specific task is still live.
  }

  if (signals.acpProbeOutcome === 'timeout') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: 'task_liveness_timeout',
      activeAcpSessionId: null,
    });
  }
  if (signals.acpProbeOutcome !== 'ok') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: 'task_liveness_unknown',
      activeAcpSessionId: null,
    });
  }

  if (
    signals.sessionWork?.active &&
    (!signals.expectedAcpSessionId ||
      signals.sessionWork.activeAcpSessionId === signals.expectedAcpSessionId)
  ) {
    return result(workspace, {
      live: true,
      conclusive: true,
      reason: signals.sessionWork.reason,
      activeAcpSessionId: signals.sessionWork.activeAcpSessionId,
    });
  }

  const active = signals.acpSessions.find((session) => {
    if (signals.expectedAcpSessionId && session.id !== signals.expectedAcpSessionId) return false;
    if (!ACTIVE_ACP_STATUSES.has(session.status) || session.workspaceId !== workspace.id) {
      return false;
    }
    const heartbeatAt =
      session.lastHeartbeatAt ?? session.updatedAt ?? session.startedAt ?? session.createdAt;
    return Number.isFinite(heartbeatAt) && signals.nowMs - heartbeatAt <= signals.heartbeatStaleMs;
  });
  if (active) {
    return result(workspace, {
      live: true,
      conclusive: true,
      reason: 'task_acp_session_live',
      activeAcpSessionId: active.id,
    });
  }

  const taskWorkspaceSessions = signals.acpSessions.filter(
    (session) =>
      session.workspaceId === workspace.id &&
      (!signals.expectedAcpSessionId || session.id === signals.expectedAcpSessionId)
  );
  const terminal = taskWorkspaceSessions.find((session) =>
    TERMINAL_ACP_STATUSES.has(session.status)
  );
  if (terminal) {
    return conclusiveDeath(signals, workspace, 'task_acp_session_terminal', terminal.id);
  }

  const hasStaleActiveProjectDataSession = taskWorkspaceSessions.some((session) =>
    ACTIVE_ACP_STATUSES.has(session.status)
  );
  return result(workspace, {
    live: false,
    conclusive: false,
    reason:
      taskWorkspaceSessions.length === 0
        ? 'task_acp_session_missing'
        : hasStaleActiveProjectDataSession
          ? 'task_acp_session_stale'
          : 'task_acp_session_suspect',
    activeAcpSessionId: null,
  });
}

export {
  loadRuntimeWorkspaceSnapshot,
  loadSessionResumabilitySnapshot,
  loadTaskSupersession,
} from './task-runtime-liveness-loaders';
