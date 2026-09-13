import {
  ACP_SESSION_TERMINAL_STATUSES,
  type AcpSessionStatus,
  DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import { getNodeBackendBaseUrl } from './node-agent-readiness';
import { classifySessionWakeability } from './session-wakeability';
import type {
  RuntimeWorkspaceSnapshot,
  SessionResumabilitySnapshot,
  TaskLivenessNodeHealthProbeEnv,
  TaskLivenessNodeHealthProbeResult,
  TaskRuntimeLiveness,
  TaskRuntimeLivenessSignals,
  TaskSupersession,
} from './task-runtime-liveness-types';

export {
  classifySessionWakeability,
  loadSessionWakeabilitySnapshot,
} from './session-wakeability';
export type { SessionWakeability } from './session-wakeability';

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

const PROBEABLE_DELIVERY_REASONS = new Set([
  'task_acp_session_missing',
  'task_acp_session_stale',
  'task_acp_session_suspect',
]);

export type TaskRuntimeDeliveryDisposition =
  | { kind: 'deliverable'; target: { nodeId: string; userId: string } }
  | { kind: 'terminal'; reason: string; nodeId: string | null }
  | { kind: 'inconclusive'; reason: string };

/**
 * Convert the shared task-runtime verdict into a reconciliation delivery gate.
 *
 * Task-scoped ACP absence/staleness is allowed to make one bounded delivery
 * attempt: acceptance is positive reachability evidence, while timeout/error is
 * still inconclusive. Every other uncertain verdict stays deferred. Keeping
 * this adapter beside the classifier prevents reconciliation from growing a
 * second D1-heartbeat death policy.
 */
export function classifyTaskRuntimeDelivery(
  liveness: TaskRuntimeLiveness
): TaskRuntimeDeliveryDisposition {
  if (liveness.conclusive && !liveness.live) {
    return { kind: 'terminal', reason: liveness.reason, nodeId: liveness.nodeId };
  }

  const target = liveness.deliveryTarget;
  if (
    target &&
    (liveness.live || (!liveness.conclusive && PROBEABLE_DELIVERY_REASONS.has(liveness.reason)))
  ) {
    return { kind: 'deliverable', target };
  }

  return { kind: 'inconclusive', reason: liveness.reason };
}

/** True when a conclusive verdict was reached because the wake moved on. */
export function isSupersededTerminalReason(reason: string): boolean {
  return reason.endsWith(SUPERSEDED_TERMINAL_REASON_SUFFIX);
}

const ACTIVE_ACP_STATUSES = new Set<AcpSessionStatus>(['assigned', 'running']);
const TERMINAL_ACP_STATUSES = new Set<AcpSessionStatus>(ACP_SESSION_TERMINAL_STATUSES);
const INCONCLUSIVE_WORKSPACE_STATUSES = new Set(['creating', 'sleeping', 'recovery']);
const TERMINAL_CONTAINER_STATUSES = new Set(['stopping', 'stopped', 'expired', 'error']);
const TERMINAL_NODE_STATUSES = new Set(['stopped', 'deleted', 'destroyed', 'destroying', 'error']);
const MAX_TASK_SUPERSESSION_CHAIN_DEPTH = 32;

export function getTaskLivenessNodeHealthProbeTimeoutMs(
  env: Pick<TaskLivenessNodeHealthProbeEnv, 'TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS'>
): number {
  return getTimeoutMs(
    env.TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS,
    DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS
  );
}

function isVmNodeHeartbeatStale(
  workspace: RuntimeWorkspaceSnapshot,
  nowMs: number,
  heartbeatStaleMs: number
): boolean {
  return (
    workspace.nodeHealthStatus !== 'healthy' ||
    workspace.nodeHeartbeatAt === null ||
    nowMs - workspace.nodeHeartbeatAt > heartbeatStaleMs
  );
}

/**
 * A stale D1 heartbeat/health field is a weak self-signal, not proof of VM
 * death. Both liveness adapters make the same bounded authority probe, but a
 * failed request still cannot manufacture terminal ownership evidence
 * (`.claude/rules/61`).
 */
export function needsNodeHealthProbe(signals: TaskRuntimeLivenessSignals): boolean {
  const workspace = signals.workspace;
  if (signals.workspaceProbeOutcome !== 'ok') return false;
  if (!signals.taskWorkspaceId || !workspace) return false;
  if (workspace.status !== 'running') return false;
  if (workspace.nodeRuntime === 'cf-container') return false;
  if (!workspace.nodeId) return false;
  if (workspace.nodeStatus && TERMINAL_NODE_STATUSES.has(workspace.nodeStatus)) return false;
  if (signals.nodeHealthProbeOutcome !== 'not_run') return false;
  return isVmNodeHeartbeatStale(workspace, signals.nowMs, signals.heartbeatStaleMs);
}

function isNodeHealthProbeTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.message.startsWith('Request timed out after ');
}

export async function probeNodeHealthForTaskLiveness(
  env: TaskLivenessNodeHealthProbeEnv,
  nodeId: string
): Promise<TaskLivenessNodeHealthProbeResult> {
  const timeoutMs = getTaskLivenessNodeHealthProbeTimeoutMs(env);
  if (!env.BASE_DOMAIN) {
    return {
      outcome: 'error',
      timeoutMs,
      url: null,
      status: null,
      error: 'BASE_DOMAIN is not configured',
    };
  }

  const url = `${getNodeBackendBaseUrl(nodeId, {
    BASE_DOMAIN: env.BASE_DOMAIN,
    VM_AGENT_PROTOCOL: env.VM_AGENT_PROTOCOL,
    VM_AGENT_PORT: env.VM_AGENT_PORT,
  })}/health`;

  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    return {
      outcome: response.ok ? 'ok' : 'failed',
      timeoutMs,
      url,
      status: response.status,
      error: null,
    };
  } catch (err) {
    return {
      outcome: isNodeHealthProbeTimeout(err) ? 'timeout' : 'error',
      timeoutMs,
      url,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Whether the sleeping-session record can still authorize a wake.
 *
 * `.claude/rules/02` requires sleep to be classified inconclusive: `NodeLifecycle`
 * rewrites a slept workspace's `sleeping` status to `deleted` five minutes after
 * sleep, and the workspace row is eventually removed outright, so workspace state
 * alone cannot distinguish "slept and restorable" from "destroyed".
 *
 * The predicate itself lives in `session-wakeability.ts` beside the loader that
 * reads the resumer's own record; this wrapper only decides what the *task*
 * verdict should be. `retry_pending` and `resumable` are both inconclusive here —
 * the difference is diagnostic, so an operator reading `liveness.reason` can tell
 * "asleep and claimable" from "asleep, waiting out a wake-retry window".
 */
export function isSessionResumable(
  snapshot: SessionResumabilitySnapshot | null,
  scope: { projectId: string; chatSessionId: string },
  budget: { maxRecoveryAttempts: number; recoveryAttemptDecayMs: number; nowMs: number }
): boolean {
  return classifySessionWakeability(snapshot, scope, budget).kind !== 'unwakeable';
}

/**
 * Whether a wakeability lookup can still change the verdict. Adapters use this
 * to keep the extra D1 read off the hot path: it only fires for a task that
 * would otherwise be declared conclusively dead
 * (`.claude/rules/47` control-loop I/O budget).
 *
 * Deliberately NOT gated on a workspace row existing, nor on
 * `workspace.chatSessionId`. Deleting a slept workspace nulls
 * `tasks.workspace_id` and, via `ON DELETE SET NULL`,
 * `session_snapshots.workspace_id` — so gating on either would blind this probe
 * to exactly the population it exists to protect (`.claude/rules/63`). This is
 * the same correction already documented on `needsTaskSupersessionProbe`.
 * `chatSessionId` is the task's own canonical binding, which is what the resumer
 * claims on.
 */
export function needsSessionResumabilityProbe(signals: {
  workspace: RuntimeWorkspaceSnapshot | null;
  workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome'];
  chatSessionId: string | null;
}): signals is typeof signals & { chatSessionId: string } {
  if (signals.workspaceProbeOutcome !== 'ok') return false;
  if (!signals.chatSessionId) return false;
  if (signals.workspace === null) return true;
  return (
    signals.workspace.status !== 'running' &&
    !INCONCLUSIVE_WORKSPACE_STATUSES.has(signals.workspace.status)
  );
}

/**
 * Whether a supersession lookup can still change the verdict. Like
 * `needsSessionResumabilityProbe` this keeps the extra D1 read off the hot path
 * by firing only for a task that would otherwise be declared conclusively dead
 * (`.claude/rules/47` control-loop I/O budget).
 *
 * Deliberately NOT gated on `workspace.chatSessionId`. A wake handoff nulls that
 * exact column (`session-recovery.ts:createRecoveryTask` stmt 3), so gating on it
 * would blind this probe to precisely the population it exists to protect — the
 * mistake that made the resumability probe unreachable for superseded tasks
 * (`.claude/rules/63`). A null workspace is probed too: the task id, not the
 * workspace, is what identifies the recovery family.
 */
export function needsTaskSupersessionProbe(
  workspace: RuntimeWorkspaceSnapshot | null,
  workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome']
): boolean {
  if (workspaceProbeOutcome !== 'ok') return false;
  if (workspace === null) return true;
  return workspace.status !== 'running' && !INCONCLUSIVE_WORKSPACE_STATUSES.has(workspace.status);
}

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
/**
 * A task whose conversation is still asleep-and-wakeable is not dead. Returns
 * the inconclusive verdict that must pre-empt any conclusive-death return, or
 * null when the sleeping-session record cannot explain the state.
 *
 * This is the `.claude/rules/58` pairing: `classifySessionWakeability` reads the
 * record `claimSessionSnapshotRecovery` claims against, so the destroyer and the
 * resumer cannot disagree about whether the conversation can still be woken.
 * A failed lookup withholds the terminal verdict (req 4) — the destructive
 * action is the irreversible one.
 */
function sessionWakeVerdict(
  signals: TaskRuntimeLivenessSignals,
  workspace: RuntimeWorkspaceSnapshot | null,
  reasonPrefix: string
): TaskRuntimeLiveness | null {
  if (signals.resumabilityProbeOutcome === 'error') {
    return result(workspace, {
      live: false,
      conclusive: false,
      reason: `${reasonPrefix}_resumability_unknown`,
      activeAcpSessionId: null,
    });
  }
  if (!signals.chatSessionId) return null;
  const wakeability = classifySessionWakeability(
    signals.sessionResumability,
    { projectId: signals.projectId, chatSessionId: signals.chatSessionId },
    {
      maxRecoveryAttempts: signals.resumabilityMaxRecoveryAttempts,
      recoveryAttemptDecayMs: signals.resumabilityRecoveryAttemptDecayMs,
      nowMs: signals.nowMs,
    }
  );
  if (wakeability.kind === 'unwakeable') return null;
  return result(workspace, {
    live: false,
    conclusive: false,
    reason:
      wakeability.kind === 'resumable'
        ? `${reasonPrefix}_snapshot_resumable`
        : `${reasonPrefix}_wake_retry_pending`,
    activeAcpSessionId: null,
  });
}

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
    // A slept conversation whose workspace row was deleted outright reaches here
    // with `taskWorkspaceId` already nulled, so this branch — not the
    // `status !== 'running'` one below — is where production's sleeping sessions
    // were being declared dead (`sam-prod`, 2026-09-13). The wake record is
    // chat-session-keyed and survives that deletion, so it is still readable.
    return (
      sessionWakeVerdict(signals, workspace, 'workspace_missing') ??
      supersessionVerdict(signals, workspace, 'workspace_missing') ??
      result(workspace, {
        live: false,
        conclusive: true,
        reason: 'workspace_missing',
        activeAcpSessionId: null,
      })
    );
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
    // Supersession is checked last among the inconclusive escapes so a genuinely
    // restorable snapshot still reports the more specific `_snapshot_resumable`
    // reason, but before any conclusive-death return.
    return (
      sessionWakeVerdict(signals, workspace, `workspace_${workspace.status}`) ??
      supersessionVerdict(signals, workspace, `workspace_${workspace.status}`) ??
      result(workspace, {
        live: false,
        conclusive: true,
        reason: `workspace_${workspace.status}`,
        activeAcpSessionId: null,
      })
    );
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
      return result(workspace, {
        live: false,
        conclusive: true,
        reason: `cf_container_${lifecycleStatus}`,
        activeAcpSessionId: null,
      });
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
    return result(workspace, {
      live: false,
      conclusive: true,
      reason: 'node_not_live',
      activeAcpSessionId: null,
    });
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
    return result(workspace, {
      live: false,
      conclusive: true,
      reason: 'task_acp_session_terminal',
      activeAcpSessionId: terminal.id,
    });
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

/** Load the D1-owned workspace/node snapshot used by both liveness adapters. */
export async function loadRuntimeWorkspaceSnapshot(
  db: D1Database,
  projectId: string,
  workspaceId: string
): Promise<RuntimeWorkspaceSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT w.id, w.status AS workspace_status, w.chat_session_id, w.node_id, w.user_id,
            n.status AS node_status, n.health_status, n.last_heartbeat_at,
            n.runtime AS node_runtime,
            (SELECT COUNT(*) FROM workspaces nw WHERE nw.node_id = w.node_id AND nw.status = 'running') AS running_workspaces_on_node
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.id = ? AND w.project_id = ?
     LIMIT 1`
    )
    .bind(workspaceId, projectId)
    .first<{
      id?: string;
      workspace_status: string;
      chat_session_id: string | null;
      node_id: string | null;
      user_id: string | null;
      node_status: string | null;
      health_status: string | null;
      last_heartbeat_at: string | null;
      node_runtime: string | null;
      running_workspaces_on_node: number | null;
    }>();
  if (!row) return null;

  const heartbeatAt = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : Number.NaN;
  return {
    id: row.id ?? workspaceId,
    status: row.workspace_status,
    chatSessionId: row.chat_session_id,
    nodeId: row.node_id,
    userId: row.user_id,
    nodeRuntime: row.node_runtime,
    nodeStatus: row.node_status,
    nodeHealthStatus: row.health_status,
    nodeHeartbeatAt: Number.isFinite(heartbeatAt) ? heartbeatAt : null,
    runningWorkspacesOnNode: row.running_workspaces_on_node ?? null,
  };
}

/**
 * Follow the exact persisted ownership handoff marker to decide whether this
 * task has been superseded. This deliberately does not infer from family
 * topology: guarded parent wakes can create depth-2+ chains, and the marker on
 * each predecessor is the only durable "who replaced me" edge.
 *
 * Project-scoped per `.claude/rules/11`.
 */
export async function loadTaskSupersession(
  db: D1Database,
  projectId: string,
  taskId: string
): Promise<TaskSupersession> {
  // Bounded recursive walk (`.claude/rules/47`): this function is only called
  // for tasks already about to receive a terminal verdict, and the recursion is
  // capped so a corrupt cycle cannot make the sweep unbounded.
  const row = await db
    .prepare(
      `WITH RECURSIVE supersession_chain(id, status, superseded_by_task_id, depth) AS (
          SELECT id, status, superseded_by_task_id, 0
            FROM tasks
           WHERE id = ? AND project_id = ?
          UNION ALL
          SELECT successor.id, successor.status, successor.superseded_by_task_id, chain.depth + 1
            FROM supersession_chain chain
            JOIN tasks successor
              ON successor.id = chain.superseded_by_task_id
             AND successor.project_id = ?
           WHERE chain.superseded_by_task_id IS NOT NULL
             AND chain.depth < ?
        )
        SELECT id, status, depth
          FROM supersession_chain
         WHERE depth > 0
         ORDER BY depth DESC
         LIMIT 1`
    )
    .bind(taskId, projectId, projectId, MAX_TASK_SUPERSESSION_CHAIN_DEPTH)
    .first<{ id: string; status: string; depth: number }>();
  if (!row) return 'none';

  // Before the exact successor has accepted runtime ownership, preserve the
  // predecessor. Once the exact successor is `in_progress` or later, the
  // predecessor can leave the sweep candidate set via a benign cancellation; the
  // guard predicates are marker-aware and still authorize the live chain.
  return row.status === 'queued' || row.status === 'delegated' ? 'live' : 'terminal';
}

