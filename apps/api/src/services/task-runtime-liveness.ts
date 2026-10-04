import { ACP_SESSION_TERMINAL_STATUSES, type AcpSessionStatus } from '@simple-agent-manager/shared';

import { isVmNodeHeartbeatStale, TERMINAL_NODE_STATUSES } from './task-runtime-liveness-node-probe';
import {
  INCONCLUSIVE_WORKSPACE_STATUSES,
  isSessionResumable,
} from './task-runtime-liveness-recoverability';
import type {
  TaskRuntimeLiveness,
  TaskRuntimeLivenessSignals,
} from './task-runtime-liveness-types';
import { conclusiveDeath, livenessResult as result } from './task-runtime-liveness-verdicts';

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
export {
  isSupersededTerminalReason,
  needsDeferredSessionSleepProbe,
  SUPERSEDED_TERMINAL_REASON_SUFFIX,
} from './task-runtime-liveness-verdicts';

const ACTIVE_ACP_STATUSES = new Set<AcpSessionStatus>(['assigned', 'running']);
const TERMINAL_ACP_STATUSES = new Set<AcpSessionStatus>(ACP_SESSION_TERMINAL_STATUSES);
const TERMINAL_CONTAINER_STATUSES = new Set(['stopping', 'stopped', 'expired', 'error']);

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
