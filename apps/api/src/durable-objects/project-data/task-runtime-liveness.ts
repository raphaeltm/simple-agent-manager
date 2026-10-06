import {
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS,
  DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import {
  sessionRecoveryAttemptDecayMs,
  sessionRecoveryMaxAttempts,
} from '../../services/session-snapshot-recovery-budget';
import {
  classifyTaskRuntimeLiveness,
  isSessionResumable,
  loadRuntimeWorkspaceSnapshot,
  loadSessionResumabilitySnapshot,
  loadTaskSupersession,
  needsDeferredSessionSleepProbe,
  needsNodeHealthProbe,
  needsSessionResumabilityProbe,
  needsTaskSupersessionProbe,
  probeNodeHealthForTaskLiveness,
  type TaskRuntimeLiveness,
  type TaskRuntimeLivenessSignals,
} from '../../services/task-runtime-liveness';
import { loadTaskSleepPreservation } from '../../services/task-sleep-preservation';
import { inspectVmAgentContainerLifecycle } from '../../services/vm-agent-container';
import { readTaskAcpLivenessSignals } from './task-acp-liveness-signals';
import type { Env } from './types';

export { readTaskAcpLivenessSignals } from './task-acp-liveness-signals';

const log = createModuleLogger('idle_cleanup_liveness');

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * ProjectData-side adapter for the shared task runtime classifier. ACP state is
 * read directly from this DO's SQLite storage, never through self-RPC.
 */

/**
 * Public entry point, mirroring the cron adapter exactly (`.claude/rules/61`).
 * Classifies once, then pays for one indexed `session_snapshots` lookup and
 * re-classifies only when the verdict is a conclusive death reached without the
 * task-scoped sleep signal — the `node_not_live`, `cf_container_<terminal>` and
 * `task_acp_session_terminal` paths, reachable while `workspaces.status` still
 * reads `running`.
 */
export async function getLocalTaskRuntimeLiveness(
  sql: SqlStorage,
  env: Env,
  task: {
    taskId: string;
    projectId: string;
    workspaceId: string | null;
    chatSessionId?: string | null;
    acpSessionId?: string | null;
  }
): Promise<TaskRuntimeLiveness> {
  const { liveness, signals } = await classifyLocalTaskRuntime(sql, env, task);
  if (!needsDeferredSessionSleepProbe(liveness, signals)) return liveness;

  const preservation = await loadTaskSleepPreservation(env.DATABASE, env, {
    id: task.taskId,
    projectId: task.projectId,
    chatSessionId: task.chatSessionId ?? signals.workspace?.chatSessionId ?? null,
  });
  if (preservation.outcome === 'not_run' || preservation.outcome === 'none') return liveness;
  log.info('preserved_sleeping', {
    taskId: task.taskId,
    projectId: task.projectId,
    workspaceId: task.workspaceId,
    livenessReason: liveness.reason,
    sleepStatus: preservation.sleepStatus,
    expiresAt: preservation.expiresAt,
    source: 'deferred_liveness',
    outcome: preservation.outcome,
    action: 'preserved',
  });
  return classifyTaskRuntimeLiveness({ ...signals, taskSessionSleep: preservation.outcome });
}
async function classifyLocalTaskRuntime(
  sql: SqlStorage,
  env: Env,
  task: {
    taskId: string;
    projectId: string;
    workspaceId: string | null;
    chatSessionId?: string | null;
    acpSessionId?: string | null;
  }
): Promise<{ liveness: TaskRuntimeLiveness; signals: TaskRuntimeLivenessSignals }> {
  /** Pair every verdict with the signals that produced it, for the deferred re-probe. */
  const finish = (signals: TaskRuntimeLivenessSignals) => ({
    liveness: classifyTaskRuntimeLiveness(signals),
    signals,
  });
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
  const maxRecoveryAttempts = sessionRecoveryMaxAttempts(env);
  const recoveryAttemptDecayMs = sessionRecoveryAttemptDecayMs(env);
  let resumabilityProbeOutcome: TaskRuntimeLivenessSignals['resumabilityProbeOutcome'] = 'not_run';
  let sessionResumability: TaskRuntimeLivenessSignals['sessionResumability'] = null;
  /** True when resumability alone already yields an inconclusive verdict. */
  let resumabilityResolvedInconclusive = false;
  const workspaceChatMatches =
    !task.chatSessionId || !workspace || workspace.chatSessionId === task.chatSessionId;
  if (workspaceChatMatches && needsSessionResumabilityProbe(workspace, workspaceProbeOutcome)) {
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
        { maxRecoveryAttempts, recoveryAttemptDecayMs, nowMs }
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

  // Task-scoped sleep guard — the same shared predicate the cron sweep uses, so
  // the two terminalization runtimes cannot disagree about whether a slept
  // conversation is recoverable (`.claude/rules/61`).
  let taskSessionSleep: TaskRuntimeLivenessSignals['taskSessionSleep'] = 'not_run';
  if (
    workspaceChatMatches &&
    !resumabilityResolvedInconclusive &&
    needsTaskSupersessionProbe(workspace, workspaceProbeOutcome)
  ) {
    const preservation = await loadTaskSleepPreservation(env.DATABASE, env, {
      id: task.taskId,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId ?? workspace?.chatSessionId ?? null,
    });
    taskSessionSleep = preservation.outcome;
    if (preservation.outcome === 'preserve') {
      log.info('preserved_sleeping', {
        taskId: task.taskId,
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        sleepStatus: preservation.sleepStatus,
        expiresAt: preservation.expiresAt,
        action: 'preserved',
      });
    }
  }

  // Tighter hot-path gate than the resumability probe (`.claude/rules/47`): skipped
  // entirely when the snapshot already proved the session resumable, because the
  // classifier returns `_snapshot_resumable` before it ever consults supersession.
  // Also skipped once sleep alone resolved the verdict, for the same reason.
  let supersessionProbeOutcome: TaskRuntimeLivenessSignals['supersessionProbeOutcome'] = 'not_run';
  let supersession: TaskRuntimeLivenessSignals['supersession'] = 'none';
  if (
    workspaceChatMatches &&
    !resumabilityResolvedInconclusive &&
    taskSessionSleep !== 'preserve' &&
    taskSessionSleep !== 'unknown' &&
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
    expectedChatSessionId: task.chatSessionId,
    expectedAcpSessionId: task.acpSessionId,
    workspace,
    workspaceProbeOutcome,
    supersessionProbeOutcome,
    supersession,
    taskSessionSleep,
    nowMs,
    heartbeatStaleMs: staleMs,
    acpProbeOutcome: 'not_run',
    nodeHealthProbeOutcome: 'not_run',
    acpSessions: [],
    sessionWork: null,
    containerProbeOutcome: 'not_run',
    containerLifecycle: null,
    resumabilityProbeOutcome,
    sessionResumability,
    resumabilityMaxRecoveryAttempts: maxRecoveryAttempts,
    resumabilityRecoveryAttemptDecayMs: recoveryAttemptDecayMs,
  };
  let initialClassification = classifyTaskRuntimeLiveness(livenessSignals);
  if (!workspaceChatMatches) return { liveness: initialClassification, signals: livenessSignals };
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
        action: 'preserved',
        error: probe.error,
      });
    }
    livenessSignals = {
      ...livenessSignals,
      nodeHealthProbeOutcome: probe.outcome,
    };
    initialClassification = classifyTaskRuntimeLiveness(livenessSignals);
    if (probe.outcome !== 'ok') {
      return { liveness: initialClassification, signals: livenessSignals };
    }
  }
  if (
    !workspace ||
    workspace.status !== 'running' ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    (workspace.nodeRuntime !== 'cf-container' && initialClassification.conclusive)
  ) {
    return { liveness: initialClassification, signals: livenessSignals };
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
        return finish({
          ...livenessSignals,
          containerProbeOutcome: 'timeout',
        });
      }
      return finish({
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
      return finish({
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
    const probe = readTaskAcpLivenessSignals(sql, env, {
      chatSessionId: workspace.chatSessionId,
      workspaceId: workspace.id,
      limit,
      nowMs,
    });
    return finish({
      ...livenessSignals,
      acpProbeOutcome: 'ok',
      acpSessions: probe.sessions,
      sessionWork: probe.sessionWork,
      workEvidence: probe.workEvidence,
    });
  } catch (err) {
    log.warn('local_acp_read_failed', {
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      chatSessionId: workspace.chatSessionId,
      action: 'preserved',
      error: err instanceof Error ? err.message : String(err),
    });
    return finish({
      ...livenessSignals,
      acpProbeOutcome: 'error',
    });
  }
}
