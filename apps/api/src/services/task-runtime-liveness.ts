import type { AcpSessionStatus } from '@simple-agent-manager/shared';

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

export interface TaskRuntimeLivenessSignals {
  taskWorkspaceId: string | null;
  workspace: RuntimeWorkspaceSnapshot | null;
  workspaceProbeOutcome: 'ok' | 'error' | 'unknown';
  nowMs: number;
  heartbeatStaleMs: number;
  acpProbeOutcome: RuntimeProbeOutcome;
  acpSessions: RuntimeAcpSessionSnapshot[];
  containerProbeOutcome: RuntimeProbeOutcome;
  containerLifecycle: ContainerLifecycleSnapshot | null;
}

const ACTIVE_ACP_STATUSES = new Set<AcpSessionStatus>(['assigned', 'running']);
const INCONCLUSIVE_WORKSPACE_STATUSES = new Set(['creating', 'sleeping', 'recovery']);
const TERMINAL_CONTAINER_STATUSES = new Set(['stopping', 'stopped', 'expired', 'error']);

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
