import {
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS,
  DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS } from '../../services/session-snapshot-artifacts';
import {
  classifyTaskRuntimeLiveness,
  isSessionResumable,
  loadRuntimeWorkspaceSnapshot,
  loadSessionResumabilitySnapshot,
  loadTaskSupersession,
  needsNodeHealthProbe,
  needsSessionResumabilityProbe,
  needsTaskSupersessionProbe,
  probeNodeHealthForTaskLiveness,
  type RuntimeAcpSessionSnapshot,
  type TaskRuntimeLiveness,
  type TaskRuntimeLivenessSignals,
} from '../../services/task-runtime-liveness';
import { inspectVmAgentContainerLifecycle } from '../../services/vm-agent-container';
import { listAcpSessions } from './acp-sessions';
import type { Env } from './types';

const log = createModuleLogger('idle_cleanup_liveness');

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * ProjectData-side adapter for the shared task runtime classifier. ACP state is
 * read directly from this DO's SQLite storage, never through self-RPC.
 */
export async function getLocalTaskRuntimeLiveness(
  sql: SqlStorage,
  env: Env,
  task: { taskId: string; projectId: string; workspaceId: string | null }
): Promise<TaskRuntimeLiveness> {
  const staleMs =
    positiveInt(env.NODE_HEARTBEAT_STALE_SECONDS, DEFAULT_NODE_HEARTBEAT_STALE_SECONDS) * 1000;
  let workspace: Awaited<ReturnType<typeof loadRuntimeWorkspaceSnapshot>> = null;
  let workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome'] = 'ok';
  if (task.workspaceId) {
    try {
      workspace = await loadRuntimeWorkspaceSnapshot(
        env.DATABASE,
        task.projectId,
        task.workspaceId
      );
    } catch (err) {
      workspaceProbeOutcome = 'error';
      log.warn('workspace_query_failed', {
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        action: 'preserved',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Only probed for a workspace that would otherwise be declared conclusively
  // dead, keeping this off the alarm's hot path (`.claude/rules/47`).
  const nowMs = Date.now();
  const maxRecoveryAttempts = positiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
  let resumabilityProbeOutcome: TaskRuntimeLivenessSignals['resumabilityProbeOutcome'] = 'not_run';
  let sessionResumability: TaskRuntimeLivenessSignals['sessionResumability'] = null;
  /** True when resumability alone already yields an inconclusive verdict. */
  let resumabilityResolvedInconclusive = false;
  if (needsSessionResumabilityProbe(workspace, workspaceProbeOutcome)) {
    try {
      sessionResumability = await loadSessionResumabilitySnapshot(
        env.DATABASE,
        task.projectId,
        workspace.id,
        workspace.chatSessionId
      );
      resumabilityProbeOutcome = 'ok';
      resumabilityResolvedInconclusive = isSessionResumable(
        sessionResumability,
        task.projectId,
        workspace.id,
        maxRecoveryAttempts,
        nowMs
      );
    } catch (err) {
      resumabilityProbeOutcome = 'error';
      resumabilityResolvedInconclusive = true;
      log.warn('session_resumability_query_failed', {
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        action: 'preserved',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Tighter hot-path gate than the resumability probe (`.claude/rules/47`): skipped
  // entirely when the snapshot already proved the session resumable, because the
  // classifier returns `_snapshot_resumable` before it ever consults supersession.
  let supersessionProbeOutcome: TaskRuntimeLivenessSignals['supersessionProbeOutcome'] = 'not_run';
  let supersession: TaskRuntimeLivenessSignals['supersession'] = 'none';
  if (
    !resumabilityResolvedInconclusive &&
    needsTaskSupersessionProbe(workspace, workspaceProbeOutcome)
  ) {
    try {
      supersession = await loadTaskSupersession(env.DATABASE, task.projectId, task.taskId);
      supersessionProbeOutcome = 'ok';
    } catch (err) {
      supersessionProbeOutcome = 'error';
      log.warn('task_supersession_query_failed', {
        taskId: task.taskId,
        projectId: task.projectId,
        action: 'preserved',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let livenessSignals: TaskRuntimeLivenessSignals = {
    projectId: task.projectId,
    taskWorkspaceId: task.workspaceId,
    workspace,
    workspaceProbeOutcome,
    supersessionProbeOutcome,
    supersession,
    nowMs,
    heartbeatStaleMs: staleMs,
    acpProbeOutcome: 'not_run',
    nodeHealthProbeOutcome: 'not_run',
    acpSessions: [],
    containerProbeOutcome: 'not_run',
    containerLifecycle: null,
    resumabilityProbeOutcome,
    sessionResumability,
    resumabilityMaxRecoveryAttempts: maxRecoveryAttempts,
  };
  let initialClassification = classifyTaskRuntimeLiveness(livenessSignals);
  if (needsNodeHealthProbe(livenessSignals) && livenessSignals.workspace?.nodeId) {
    const nodeId = livenessSignals.workspace.nodeId;
    const probe = await probeNodeHealthForTaskLiveness(env, nodeId);
    if (probe.outcome !== 'ok') {
      log.warn('node_health_probe_unhealthy', {
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        nodeId,
        outcome: probe.outcome,
        status: probe.status,
        timeoutMs: probe.timeoutMs,
        action: probe.outcome === 'failed' ? 'terminal_candidate' : 'preserved',
        error: probe.error,
      });
    }
    livenessSignals = {
      ...livenessSignals,
      nodeHealthProbeOutcome: probe.outcome,
    };
    initialClassification = classifyTaskRuntimeLiveness(livenessSignals);
    if (probe.outcome !== 'ok') {
      return initialClassification;
    }
  }
  if (
    !workspace ||
    workspace.status !== 'running' ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    (workspace.nodeRuntime !== 'cf-container' && initialClassification.conclusive)
  ) {
    return initialClassification;
  }

  if (workspace.nodeRuntime === 'cf-container') {
    const probeTimeoutMs = positiveInt(
      env.TASK_LIVENESS_PROBE_TIMEOUT_MS,
      DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS
    );
    const timeout = Symbol('idle_cleanup_container_probe_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = await Promise.race([
        inspectVmAgentContainerLifecycle(env as unknown as WorkerEnv, workspace.nodeId),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), probeTimeoutMs);
        }),
      ]);
      if (probe === timeout) {
        log.warn('container_probe_timeout', {
          projectId: task.projectId,
          workspaceId: task.workspaceId,
          probeTimeoutMs,
          action: 'preserved',
        });
        return classifyTaskRuntimeLiveness({
          ...livenessSignals,
          containerProbeOutcome: 'timeout',
        });
      }
      return classifyTaskRuntimeLiveness({
        ...livenessSignals,
        containerProbeOutcome: 'ok',
        containerLifecycle: probe,
      });
    } catch (err) {
      log.warn('container_probe_failed', {
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        action: 'preserved',
        error: err instanceof Error ? err.message : String(err),
      });
      return classifyTaskRuntimeLiveness({
        ...livenessSignals,
        containerProbeOutcome: 'error',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  try {
    const limit = positiveInt(
      env.TASK_LIVENESS_MAX_ACP_SESSIONS,
      DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS
    );
    const { sessions } = listAcpSessions(sql, {
      chatSessionId: workspace.chatSessionId,
      limit,
    });
    return classifyTaskRuntimeLiveness({
      ...livenessSignals,
      acpProbeOutcome: 'ok',
      acpSessions: sessions as RuntimeAcpSessionSnapshot[],
    });
  } catch (err) {
    log.warn('local_acp_read_failed', {
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      chatSessionId: workspace.chatSessionId,
      action: 'preserved',
      error: err instanceof Error ? err.message : String(err),
    });
    return classifyTaskRuntimeLiveness({
      ...livenessSignals,
      acpProbeOutcome: 'error',
    });
  }
}
