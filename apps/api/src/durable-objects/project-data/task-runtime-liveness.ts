import {
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS,
  DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import {
  classifyTaskRuntimeLiveness,
  loadRuntimeWorkspaceSnapshot,
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
  task: { projectId: string; workspaceId: string | null }
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

  const baseSignals: TaskRuntimeLivenessSignals = {
    taskWorkspaceId: task.workspaceId,
    workspace,
    workspaceProbeOutcome,
    nowMs: Date.now(),
    heartbeatStaleMs: staleMs,
    acpProbeOutcome: 'not_run',
    acpSessions: [],
    containerProbeOutcome: 'not_run',
    containerLifecycle: null,
  };
  const initialClassification = classifyTaskRuntimeLiveness(baseSignals);
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
          ...baseSignals,
          containerProbeOutcome: 'timeout',
        });
      }
      return classifyTaskRuntimeLiveness({
        ...baseSignals,
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
        ...baseSignals,
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
      ...baseSignals,
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
      ...baseSignals,
      acpProbeOutcome: 'error',
    });
  }
}
