import type { AcpSessionStatus } from '@simple-agent-manager/shared';

import { isRestorableSnapshot } from './session-snapshot-artifacts';

export interface TaskRuntimeLiveness {
  live: boolean;
  conclusive: boolean;
  reason: string;
  workspaceStatus: string | null;
  nodeId: string | null;
  activeAcpSessionId: string | null;
}

export type RuntimeProbeOutcome = 'ok' | 'timeout' | 'error' | 'unknown' | 'not_run';

export interface RuntimeWorkspaceSnapshot {
  id: string;
  status: string;
  chatSessionId: string | null;
  nodeId: string | null;
  nodeRuntime: string | null;
  nodeStatus: string | null;
  nodeHealthStatus: string | null;
  nodeHeartbeatAt: number | null;
}

export interface RuntimeAcpSessionSnapshot {
  id: string;
  status: AcpSessionStatus;
  workspaceId: string | null;
  lastHeartbeatAt: number | null;
  updatedAt: number;
  startedAt: number | null;
  createdAt: number;
}

export interface ContainerLifecycleSnapshot {
  status: string | null;
  activeWorkStatus: string | null;
}

/**
 * The `session_snapshots` sleep record — the authoritative answer to "can this
 * session still be restored?". Deliberately mirrors the gate the resumer
 * actually applies, so the classifier and the resumer cannot disagree about
 * what "gone" means (`.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`).
 *
 * The resume path is two functions, and this type carries the inputs to both:
 *  - `session-recovery.ts:loadRecoveryContext` — requires `workspaceId`,
 *    a matching `projectId`, and `sleepingAt`.
 *  - `session-snapshot-recovery-lifecycle.ts:claimSessionSnapshotRecovery` —
 *    the function that actually authorizes a wake. It additionally requires a
 *    restorable `status`/`degradation` pair, an unexpired `expires_at`, and
 *    `recovery_attempts < SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`.
 */
export interface SessionResumabilitySnapshot {
  chatSessionId: string;
  projectId: string | null;
  workspaceId: string | null;
  /** ms epoch; null when the session was never slept. */
  sleepingAt: number | null;
  sleepStatus: string | null;
  /** ms epoch; null when absent or unparseable. */
  expiresAtMs: number | null;
  status: string | null;
  degradation: string | null;
  recoveryAttempts: number;
}

export type ResumabilityProbeOutcome = 'ok' | 'error' | 'not_run';

export interface TaskRuntimeLivenessSignals {
  /** The task's project — re-checked against the snapshot row in memory. */
  projectId: string;
  taskWorkspaceId: string | null;
  workspace: RuntimeWorkspaceSnapshot | null;
  workspaceProbeOutcome: 'ok' | 'error' | 'unknown';
  nowMs: number;
  heartbeatStaleMs: number;
  acpProbeOutcome: RuntimeProbeOutcome;
  acpSessions: RuntimeAcpSessionSnapshot[];
  containerProbeOutcome: RuntimeProbeOutcome;
  containerLifecycle: ContainerLifecycleSnapshot | null;
  /**
   * `not_run` preserves the pre-resumability behaviour for callers that cannot
   * reach D1; `error` withholds a conclusive-death verdict because the
   * alternative is terminalizing a session that may still be restorable.
   */
  resumabilityProbeOutcome: ResumabilityProbeOutcome;
  sessionResumability: SessionResumabilitySnapshot | null;
  /**
   * `SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS` as the resumer resolves it, so the
   * classifier applies the same wake-attempt ceiling the claim does.
   */
  resumabilityMaxRecoveryAttempts: number;
}

const ACTIVE_ACP_STATUSES = new Set<AcpSessionStatus>(['assigned', 'running']);
const INCONCLUSIVE_WORKSPACE_STATUSES = new Set(['creating', 'sleeping', 'recovery']);
const TERMINAL_CONTAINER_STATUSES = new Set(['stopping', 'stopped', 'expired', 'error']);
/** `session_snapshots.sleep_status` value meaning "asleep right now". */
const RESUMABLE_SLEEP_STATUS = 'sleeping';

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
function isSessionResumable(
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
 * local idle-cleanup adapter. Activity timestamps are deliberately absent:
 * chat or terminal silence is never runtime-death evidence.
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
    return result(workspace, {
      live: false,
      conclusive: true,
      reason: 'workspace_missing',
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
    return result(workspace, {
      live: false,
      conclusive: true,
      reason: `workspace_${workspace.status}`,
      activeAcpSessionId: null,
    });
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

  if (
    workspace.nodeStatus !== 'running' ||
    workspace.nodeHealthStatus !== 'healthy' ||
    workspace.nodeHeartbeatAt === null ||
    signals.nowMs - workspace.nodeHeartbeatAt > signals.heartbeatStaleMs
  ) {
    return result(workspace, {
      live: false,
      conclusive: true,
      reason: 'node_not_live',
      activeAcpSessionId: null,
    });
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

  return result(workspace, {
    live: false,
    conclusive: true,
    reason: 'task_acp_session_not_live',
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
            n.runtime AS node_runtime
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
  };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
