import {
  ACP_SESSION_TERMINAL_STATUSES,
  type AcpSessionStatus,
  DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import { getNodeBackendBaseUrl } from './node-agent-readiness';
import { isRestorableSnapshot } from './session-snapshot-artifacts';
import type {
  RuntimeWorkspaceSnapshot,
  SessionResumabilitySnapshot,
  TaskLivenessNodeHealthProbeEnv,
  TaskLivenessNodeHealthProbeResult,
  TaskRuntimeLiveness,
  TaskRuntimeLivenessSignals,
  TaskSupersession,
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

/** True when a conclusive verdict was reached because the wake moved on. */
export function isSupersededTerminalReason(reason: string): boolean {
  return reason.endsWith(SUPERSEDED_TERMINAL_REASON_SUFFIX);
}

const ACTIVE_ACP_STATUSES = new Set<AcpSessionStatus>(['assigned', 'running']);
const TERMINAL_ACP_STATUSES = new Set<AcpSessionStatus>(ACP_SESSION_TERMINAL_STATUSES);
const INCONCLUSIVE_WORKSPACE_STATUSES = new Set(['creating', 'sleeping', 'recovery']);
const TERMINAL_CONTAINER_STATUSES = new Set(['stopping', 'stopped', 'expired', 'error']);
const TERMINAL_NODE_STATUSES = new Set(['stopped', 'deleted', 'destroyed', 'destroying', 'error']);
/** `session_snapshots.sleep_status` value meaning "asleep right now". */
const RESUMABLE_SLEEP_STATUS = 'sleeping';
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
 * death. Both liveness adapters must make the same bounded authority probe
 * before converting that stale signal into a terminal `node_not_live` verdict
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
      outcome: isNodeHealthProbeTimeout(err) ? 'timeout' : 'failed',
      timeoutMs,
      url,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * True when the session is currently asleep with a restorable, unexpired
 * snapshot. `.claude/rules/02` requires sleep to be classified inconclusive:
 * `NodeLifecycle` rewrites a slept workspace's `sleeping` status to `deleted`
 * five minutes after sleep, so workspace status alone cannot distinguish
 * "slept and restorable" from "destroyed".
 *
 * A user-initiated delete destroys the snapshot row entirely
 * (`session-snapshot-persistence.ts:deleteSessionSnapshotState`), so snapshot
 * presence — not a deletion-cause column — is the discriminator.
 *
 * Every condition below mirrors one the resumer already enforces, so this
 * predicate can never be looser than the gate that authorizes a real wake
 * (`.claude/rules/58`). Being *equal* rather than merely safe matters: a
 * snapshot the resumer would refuse must terminalize, or the task waits out the
 * full snapshot TTL for a wake that can never happen.
 */
export function isSessionResumable(
  snapshot: SessionResumabilitySnapshot | null,
  projectId: string,
  workspaceId: string,
  maxRecoveryAttempts: number,
  nowMs: number
): boolean {
  if (!snapshot) return false;
  // Defence in depth: the loader is already project+workspace scoped, so these
  // two re-checks are the in-memory half of the pair `.claude/rules/28` wants.
  if (snapshot.projectId !== projectId) return false;
  if (snapshot.workspaceId !== workspaceId) return false;
  if (snapshot.sleepingAt === null) return false;
  // A session that already woke clears both `sleeping_at` and `sleep_status`
  // (`markSessionSnapshotAwakeInPlace`, `completeSessionSnapshotRecovery`);
  // this is the belt-and-braces half of that pair.
  if (snapshot.sleepStatus !== RESUMABLE_SLEEP_STATUS) return false;
  // Mirrors `restorableSnapshotCondition()` in the claim's WHERE clause.
  if (!isRestorableSnapshot(snapshot.status, snapshot.degradation)) return false;
  // Mirrors `recovery_attempts < maxAttempts`. Once wake attempts are spent the
  // resumer refuses the claim, so preserving the task would strand it until the
  // snapshot TTL — the second bounded escape (`.claude/rules/47`).
  if (snapshot.recoveryAttempts >= maxRecoveryAttempts) return false;
  // An absent or unparseable expiry is treated as NOT resumable so a snapshot
  // can never make a task immortal (`.claude/rules/47` bounded escape path).
  if (snapshot.expiresAtMs === null) return false;
  return snapshot.expiresAtMs > nowMs;
}

/**
 * Whether a resumability lookup can still change the verdict. Adapters use this
 * to keep the extra D1 read off the hot path: it only fires for a workspace
 * that would otherwise be declared conclusively dead
 * (`.claude/rules/47` control-loop I/O budget).
 */
export function needsSessionResumabilityProbe(
  workspace: RuntimeWorkspaceSnapshot | null,
  workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome']
): workspace is RuntimeWorkspaceSnapshot & { chatSessionId: string } {
  return (
    workspaceProbeOutcome === 'ok' &&
    workspace !== null &&
    workspace.chatSessionId !== null &&
    workspace.status !== 'running' &&
    !INCONCLUSIVE_WORKSPACE_STATUSES.has(workspace.status)
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
    return (
      supersessionVerdict(signals, workspace, 'workspace_missing') ??
      result(workspace, {
        live: false,
        conclusive: true,
        reason: 'workspace_missing',
        activeAcpSessionId: null,
      })
    );
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
      isSessionResumable(
        signals.sessionResumability,
        signals.projectId,
        workspace.id,
        signals.resumabilityMaxRecoveryAttempts,
        signals.nowMs
      )
    ) {
      return result(workspace, {
        live: false,
        conclusive: false,
        reason: `workspace_${workspace.status}_snapshot_resumable`,
        activeAcpSessionId: null,
      });
    }
    // Supersession is checked last among the inconclusive escapes so a genuinely
    // restorable snapshot still reports the more specific `_snapshot_resumable`
    // reason, but before any conclusive-death return.
    return (
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
        conclusive: true,
        reason: 'node_not_live',
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

  if (signals.sessionWork?.active) {
    return result(workspace, {
      live: true,
      conclusive: true,
      reason: signals.sessionWork.reason,
      activeAcpSessionId: signals.sessionWork.activeAcpSessionId,
    });
  }

  const active = signals.acpSessions.find((session) => {
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
    (session) => session.workspaceId === workspace.id
  );
  const terminal = taskWorkspaceSessions.find((session) => TERMINAL_ACP_STATUSES.has(session.status));
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
      `SELECT w.id, w.status AS workspace_status, w.chat_session_id, w.node_id,
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
    nodeRuntime: row.node_runtime,
    nodeStatus: row.node_status,
    nodeHealthStatus: row.health_status,
    nodeHeartbeatAt: Number.isFinite(heartbeatAt) ? heartbeatAt : null,
    runningWorkspacesOnNode: row.running_workspaces_on_node ?? null,
  };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/**
 * Load the session sleep record used to tell "slept and restorable" apart from
 * "destroyed". Project- and workspace-scoped per `.claude/rules/11`;
 * `chat_session_id` is uniquely indexed so this is a point lookup.
 */
export async function loadSessionResumabilitySnapshot(
  db: D1Database,
  projectId: string,
  workspaceId: string,
  chatSessionId: string
): Promise<SessionResumabilitySnapshot | null> {
  const row = await db
    .prepare(
      `SELECT chat_session_id, project_id, workspace_id, sleeping_at, sleep_status, expires_at,
            status, degradation, recovery_attempts
     FROM session_snapshots
     WHERE chat_session_id = ? AND project_id = ? AND workspace_id = ?
     LIMIT 1`
    )
    .bind(chatSessionId, projectId, workspaceId)
    .first<{
      chat_session_id: string;
      project_id: string | null;
      workspace_id: string | null;
      sleeping_at: string | null;
      sleep_status: string | null;
      expires_at: string | null;
      status: string | null;
      degradation: string | null;
      recovery_attempts: number | null;
    }>();
  if (!row) return null;

  return {
    chatSessionId: row.chat_session_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    sleepingAt: parseTimestamp(row.sleeping_at),
    sleepStatus: row.sleep_status,
    expiresAtMs: parseTimestamp(row.expires_at),
    status: row.status,
    degradation: row.degradation,
    // NOT NULL DEFAULT 0 in schema; coalesce defensively so a null can never
    // read as "attempts remaining" via NaN comparison.
    recoveryAttempts: row.recovery_attempts ?? 0,
  };
}
