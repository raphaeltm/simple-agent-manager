import {
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS,
  DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import {
  getFreshHarnessWorkLeaseExpiry,
  parseHarnessWorkConfig,
} from '../../services/session-idleness';
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
  type RuntimeSessionWorkSnapshot,
  type TaskAcpLivenessSignals,
  type TaskRuntimeLiveness,
  type TaskRuntimeLivenessSignals,
} from '../../services/task-runtime-liveness';
import { inspectVmAgentContainerLifecycle } from '../../services/vm-agent-container';
import { listAcpSessions } from './acp-sessions';
import { parseActivityStaleThreshold, WORKING_ACTIVITIES } from './session-state';
import type { Env } from './types';

const log = createModuleLogger('idle_cleanup_liveness');

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function freshNumber(value: unknown, floor: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) return null;
  return value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maxFreshEvidence(floor: number, ...values: unknown[]): number | null {
  const freshValues = values
    .map((value) => freshNumber(value, floor))
    .filter((value): value is number => value !== null);
  return freshValues.length > 0 ? Math.max(...freshValues) : null;
}

function isWorkingActivityName(value: unknown): boolean {
  return typeof value === 'string' && (WORKING_ACTIVITIES as readonly string[]).includes(value);
}

function readTaskSessionWork(
  sql: SqlStorage,
  env: Env,
  opts: { chatSessionId: string; workspaceId: string; limit: number; nowMs: number }
): RuntimeSessionWorkSnapshot | null {
  const rows = sql
    .exec(
      `SELECT acp.id AS acp_session_id,
              ss.activity AS activity,
              ss.activity_at AS activity_at,
              ss.prompt_started_at AS prompt_started_at,
              ss.runtime_work_state AS runtime_work_state,
              ss.runtime_work_updated_at AS runtime_work_updated_at,
              ss.runtime_work_progress_at AS runtime_work_progress_at
       FROM acp_sessions acp
       LEFT JOIN session_state ss ON ss.session_id = acp.id
       WHERE acp.chat_session_id = ?
         AND acp.workspace_id = ?
         AND acp.status IN ('assigned', 'running')
       ORDER BY COALESCE(acp.started_at, acp.assigned_at, acp.updated_at, acp.created_at) DESC
       LIMIT ?`,
      opts.chatSessionId,
      opts.workspaceId,
      opts.limit
    )
    .toArray();

  const activityFloor =
    opts.nowMs - parseActivityStaleThreshold(env.SESSION_ACTIVITY_STALE_THRESHOLD_MS);
  const harnessWorkConfig = parseHarnessWorkConfig(env);
  const now = new Date(opts.nowMs);

  for (const row of rows) {
    const activeAcpSessionId = typeof row.acp_session_id === 'string' ? row.acp_session_id : null;
    if (!activeAcpSessionId) continue;

    if (
      isWorkingActivityName(row.activity) &&
      maxFreshEvidence(activityFloor, row.prompt_started_at, row.activity_at) !== null
    ) {
      return {
        active: true,
        activeAcpSessionId,
        reason: 'task_prompt_turn_active',
      };
    }

    const runtimeWorkLeaseExpiry = getFreshHarnessWorkLeaseExpiry(
      {
        runtimeWorkState:
          typeof row.runtime_work_state === 'string' ? row.runtime_work_state : null,
        runtimeWorkUpdatedAt: numberOrNull(row.runtime_work_updated_at),
        runtimeWorkProgressAt: numberOrNull(row.runtime_work_progress_at),
      },
      now,
      harnessWorkConfig.leaseMs,
      harnessWorkConfig.maxDurationMs
    );
    if (runtimeWorkLeaseExpiry) {
      return {
        active: true,
        activeAcpSessionId,
        reason: 'task_runtime_work_active',
      };
    }
  }

  return null;
}

export function readTaskAcpLivenessSignals(
  sql: SqlStorage,
  env: Env,
  opts: { chatSessionId: string; workspaceId: string; limit: number; nowMs?: number }
): TaskAcpLivenessSignals {
  const { sessions, total } = listAcpSessions(sql, {
    chatSessionId: opts.chatSessionId,
    limit: opts.limit,
  });
  const nowMs = opts.nowMs ?? Date.now();
  return {
    sessions: sessions as RuntimeAcpSessionSnapshot[],
    total,
    sessionWork: readTaskSessionWork(sql, env, {
      chatSessionId: opts.chatSessionId,
      workspaceId: opts.workspaceId,
      limit: opts.limit,
      nowMs,
    }),
  };
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
    sessionWork: null,
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
    const probe = readTaskAcpLivenessSignals(sql, env, {
      chatSessionId: workspace.chatSessionId,
      workspaceId: workspace.id,
      limit,
      nowMs,
    });
    return classifyTaskRuntimeLiveness({
      ...livenessSignals,
      acpProbeOutcome: 'ok',
      acpSessions: probe.sessions,
      sessionWork: probe.sessionWork,
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
