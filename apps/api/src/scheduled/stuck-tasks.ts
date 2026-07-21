/**
 * Stuck Task Recovery — detects and fails tasks stuck in transient states.
 *
 * Checks for tasks in 'queued', 'delegated', or 'in_progress' that have been
 * in that state longer than their configured timeout. Transitions them to 'failed'
 * with a descriptive error message including the execution step where they stalled.
 *
 * Called from the cron handler alongside node cleanup.
 *
 * TDF-2 compatibility: The TaskRunner DO manages orchestration via alarms and
 * updates `execution_step` + `updated_at` on each step progression in D1.
 * This cron serves as the outer safety net — if the DO dies or its alarms
 * stop firing, the task's `updated_at` will eventually exceed the timeout
 * thresholds and the cron will fail it. The DO uses optimistic locking
 * (`WHERE status = X`) to detect cron intervention and abort gracefully.
 *
 * TDF-7: Enhanced with OBSERVABILITY_DATABASE recording, diagnostic context
 * capture (workspace/node status at recovery time), and TaskRunner DO health
 * checks for post-TDF-2 defense-in-depth.
 *
 * FILE SIZE EXCEPTION: Scheduled recovery currently combines timeout,
 * heartbeat, cleanup, and compaction-loop safeguards; split in a focused
 * follow-up.
 */
import {
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_STUCK_TASK_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_STUCK_TASK_SCAN_CURSOR_KV_KEY,
  DEFAULT_TASK_DO_MISMATCH_GRACE_MS,
  DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS,
  DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS,
  DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS,
  DEFAULT_TASK_RUN_HARD_TIMEOUT_MS,
  DEFAULT_TASK_RUN_MAX_EXECUTION_MS,
  DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS,
  DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { TaskRunner } from '../durable-objects/task-runner';
import { classifyVmAgentContainerLiveness } from '../durable-objects/vm-agent-container-lifecycle';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { persistError } from '../services/observability';
import * as projectDataService from '../services/project-data';
import { cleanupTaskRun } from '../services/task-runner';
import { syncTriggerExecutionStatus } from '../services/trigger-execution-sync';
import { inspectVmAgentContainerLifecycle } from '../services/vm-agent-container';
import {
  type CompactionLoopRecovery,
  detectTaskCompactionLoop,
} from './claude-code-compaction-loop';

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Human-readable descriptions for execution steps */
const STEP_DESCRIPTIONS: Record<string, string> = {
  node_selection: 'selecting a node',
  node_provisioning: 'provisioning a new node',
  node_agent_ready: 'waiting for node agent to start',
  workspace_creation: 'creating workspace on node',
  workspace_dispatch: 'starting workspace on node',
  workspace_ready: 'waiting for workspace to become ready',
  agent_session: 'creating agent session',
  running: 'running (agent active)',
};

function describeStep(step: string | null): string {
  if (!step) return '';
  return STEP_DESCRIPTIONS[step] ?? step;
}

export interface StuckTaskResult {
  failedQueued: number;
  failedDelegated: number;
  failedInProgress: number;
  failedCompactionLoops: number;
  heartbeatSkipped: number;
  doHealthChecked: number;
  doHealthMissing: number;
  doHealthErrors: number;
  deadRuntimeReconciled: number;
  candidatesScanned: number;
  candidateCursorLoaded: boolean;
  candidateCursorWrapped: boolean;
  candidateCursorErrors: number;
  errors: number;
}

export interface StuckTaskCandidate {
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  execution_step: string | null;
  updated_at: string;
  started_at: string | null;
  workspace_id: string | null;
  auto_provisioned_node_id: string | null;
}

export interface StuckTaskScanCursor {
  updatedAt: string;
  taskId: string;
}

export interface StuckTaskCandidateSelection {
  tasks: StuckTaskCandidate[];
  nextCursor: StuckTaskScanCursor | null;
  cursorLoaded: boolean;
  wrapped: boolean;
  cursorErrors: number;
}

export interface TaskRunnerProbeResult {
  outcome: 'ok' | 'missing' | 'timeout' | 'error';
  status: {
    completed: boolean;
    currentStep: string;
    retryCount: number;
    lastStepAt: number;
  } | null;
  error: string | null;
  durationMs: number;
}

/**
 * Diagnostic context captured at recovery time for a stuck task.
 * Recorded in the OBSERVABILITY_DATABASE to enable post-mortem analysis
 * without manual investigation.
 */
export interface RecoveryDiagnostics {
  taskId: string;
  taskStatus: string;
  executionStep: string | null;
  elapsedMs: number;
  reason: string;
  workspaceId: string | null;
  workspaceStatus: string | null;
  nodeId: string | null;
  nodeStatus: string | null;
  nodeHealthStatus: string | null;
  autoProvisionedNodeId: string | null;
  doState: {
    outcome: TaskRunnerProbeResult['outcome'];
    exists: boolean;
    completed: boolean | null;
    currentStep: string | null;
    retryCount: number | null;
    lastStepAt: number | null;
    error: string | null;
  } | null;
}

export interface TaskRuntimeLiveness {
  live: boolean;
  conclusive: boolean;
  reason: string;
  workspaceStatus: string | null;
  nodeId: string | null;
  activeAcpSessionId: string | null;
}

export type TaskReconciliationDecision =
  | 'not_active'
  | 'within_grace'
  | 'reconcile_dead_runtime'
  | 'preserve_live_runtime'
  | 'preserve_inconclusive_runtime'
  | 'observe_orchestration';

export interface TaskReconciliationDiagnostics {
  taskId: string;
  status: string;
  executionStep: string | null;
  workspaceId: string | null;
  elapsedMs: number;
  eligibilityThresholdMs: number;
  eligible: boolean;
  decision: TaskReconciliationDecision;
  liveness: TaskRuntimeLiveness | null;
  taskRunner: TaskRunnerProbeResult;
  candidateScan: {
    limit: number;
    selectedCount: number;
    selected: boolean;
    position: number | null;
    cursorLoaded: boolean;
    wrapped: boolean;
    cursorErrors: number;
  };
}

// 'running' is always a live-candidate. 'recovery' is a live-candidate ONLY for
// VM runtimes: the VM /ready callback path transiently marks a workspace
// 'recovery' while the agent reconnects, and such workspaces must still fall
// through to the node-heartbeat staleness + ACP-session liveness checks below
// (pre-PR behavior). For cf-container (Instant) runtimes, 'recovery'/'sleeping'
// are instead handled by the resumable short-circuit, which defers to the
// authoritative DO lifecycle probe.
const LIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery']);
// Resumable statuses short-circuit to an inconclusive result ONLY for
// cf-container runtimes. Gating on node_runtime keeps VM 'recovery'/'sleeping'
// workspaces on a dead node conclusively reconcilable instead of stranding them.
const RESUMABLE_WORKSPACE_STATUSES = new Set(['sleeping', 'recovery']);
const ACTIVE_ACP_STATUSES = new Set(['assigned', 'running']);

function stuckTaskScanCursorKey(env: Env): string {
  return env.STUCK_TASK_SCAN_CURSOR_KV_KEY?.trim() || DEFAULT_STUCK_TASK_SCAN_CURSOR_KV_KEY;
}

function parseStuckTaskScanCursor(raw: string | null): StuckTaskScanCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StuckTaskScanCursor>;
    if (
      typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.taskId !== 'string' ||
      parsed.taskId.length === 0 ||
      parsed.taskId.length > 128
    ) {
      return null;
    }
    return { updatedAt: parsed.updatedAt, taskId: parsed.taskId };
  } catch {
    return null;
  }
}

const STUCK_TASK_CANDIDATE_COLUMNS = `id, project_id, user_id, status, execution_step, updated_at, started_at,
       workspace_id, auto_provisioned_node_id`;

/**
 * Select one bounded, fair page of active tasks. A KV cursor prevents old live
 * or inconclusive rows from permanently starving later dead rows. The first
 * cursorless page starts at the newest active rows, then subsequent sweeps
 * continue in ascending order and wrap at the end.
 */
export async function selectStuckTaskCandidates(
  env: Env,
  maxCandidates: number
): Promise<StuckTaskCandidateSelection> {
  const key = stuckTaskScanCursorKey(env);
  let cursor: StuckTaskScanCursor | null = null;
  let cursorLoaded = false;
  let cursorErrors = 0;

  try {
    const rawCursor = await env.KV.get(key);
    cursor = parseStuckTaskScanCursor(rawCursor);
    cursorLoaded = cursor !== null;
    if (rawCursor && !cursor) {
      cursorErrors++;
      log.warn('stuck_task.invalid_scan_cursor', { key });
    }
  } catch (err) {
    cursorErrors++;
    log.warn('stuck_task.scan_cursor_read_failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let tasks: StuckTaskCandidate[];
  if (cursor) {
    const forward = await env.DATABASE.prepare(
      `SELECT ${STUCK_TASK_CANDIDATE_COLUMNS}
       FROM tasks
       WHERE status IN ('queued', 'delegated', 'in_progress')
         AND (updated_at > ? OR (updated_at = ? AND id > ?))
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`
    )
      .bind(cursor.updatedAt, cursor.updatedAt, cursor.taskId, maxCandidates)
      .all<StuckTaskCandidate>();
    tasks = forward.results;
  } else {
    // On rollout (or after a deliberately cleared cursor), examine the newest
    // bounded page first so a fresh dead-runtime mismatch is not delayed behind
    // a historical backlog. The persisted cursor makes later pages fair.
    const newest = await env.DATABASE.prepare(
      `SELECT ${STUCK_TASK_CANDIDATE_COLUMNS}
       FROM (
         SELECT ${STUCK_TASK_CANDIDATE_COLUMNS}
         FROM tasks
         WHERE status IN ('queued', 'delegated', 'in_progress')
         ORDER BY updated_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY updated_at ASC, id ASC`
    )
      .bind(maxCandidates)
      .all<StuckTaskCandidate>();
    tasks = newest.results;
  }

  let wrapped = false;
  if (cursor && tasks.length < maxCandidates) {
    const remaining = maxCandidates - tasks.length;
    const wrap = await env.DATABASE.prepare(
      `SELECT ${STUCK_TASK_CANDIDATE_COLUMNS}
       FROM tasks
       WHERE status IN ('queued', 'delegated', 'in_progress')
         AND (updated_at < ? OR (updated_at = ? AND id <= ?))
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`
    )
      .bind(cursor.updatedAt, cursor.updatedAt, cursor.taskId, remaining)
      .all<StuckTaskCandidate>();
    if (wrap.results.length > 0) {
      wrapped = true;
      tasks.push(...wrap.results);
    }
  }

  const last = tasks.at(-1);
  return {
    tasks,
    nextCursor: last ? { updatedAt: last.updated_at, taskId: last.id } : null,
    cursorLoaded,
    wrapped,
    cursorErrors,
  };
}

export async function persistStuckTaskScanCursor(
  env: Env,
  cursor: StuckTaskScanCursor
): Promise<boolean> {
  const key = stuckTaskScanCursorKey(env);
  try {
    await env.KV.put(key, JSON.stringify(cursor));
    return true;
  } catch (err) {
    log.warn('stuck_task.scan_cursor_write_failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Bound and classify the cross-DO status RPC used by reconciliation diagnostics. */
export async function probeTaskRunnerStatus(
  env: Env,
  taskId: string
): Promise<TaskRunnerProbeResult> {
  const startedAt = Date.now();
  const probeTimeoutMs = parseMs(
    env.TASK_LIVENESS_PROBE_TIMEOUT_MS,
    DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS
  );
  const timeout = Symbol('task_runner_probe_timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const doId = env.TASK_RUNNER.idFromName(taskId);
    const stub = env.TASK_RUNNER.get(doId) as DurableObjectStub<TaskRunner>;
    const result = await Promise.race([
      stub.getStatus(),
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), probeTimeoutMs);
      }),
    ]);

    if (result === timeout) {
      log.warn('stuck_task.task_runner_probe_timeout', { taskId, probeTimeoutMs });
      return {
        outcome: 'timeout',
        status: null,
        error: `TaskRunner status probe exceeded ${probeTimeoutMs}ms`,
        durationMs: Date.now() - startedAt,
      };
    }

    if (!result) {
      log.warn('stuck_task.task_runner_state_missing', { taskId });
      return {
        outcome: 'missing',
        status: null,
        error: null,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      outcome: 'ok',
      status: {
        completed: result.completed,
        currentStep: result.currentStep,
        retryCount: result.retryCount,
        lastStepAt: result.lastStepAt,
      },
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('stuck_task.task_runner_probe_failed', { taskId, error });
    return {
      outcome: 'error',
      status: null,
      error,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Prove task-scoped liveness. A shared-node heartbeat is never sufficient. */
export async function getTaskRuntimeLiveness(
  env: Env,
  task: { project_id: string; workspace_id: string | null }
): Promise<TaskRuntimeLiveness> {
  const dead = (
    reason: string,
    workspaceStatus: string | null,
    nodeId: string | null
  ): TaskRuntimeLiveness => ({
    live: false,
    conclusive: true,
    reason,
    workspaceStatus,
    nodeId,
    activeAcpSessionId: null,
  });
  if (!task.workspace_id) return dead('workspace_missing', null, null);

  const row = await env.DATABASE.prepare(
    `SELECT w.status AS workspace_status, w.chat_session_id, w.node_id,
            n.status AS node_status, n.health_status, n.last_heartbeat_at,
            n.runtime AS node_runtime
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.id = ?
     LIMIT 1`
  )
    .bind(task.workspace_id)
    .first<{
      workspace_status: string;
      chat_session_id: string | null;
      node_id: string | null;
      node_status: string | null;
      health_status: string | null;
      last_heartbeat_at: string | null;
      node_runtime: string | null;
    }>();

  if (!row) return dead('workspace_missing', null, null);
  if (row.node_runtime === 'cf-container' && RESUMABLE_WORKSPACE_STATUSES.has(row.workspace_status)) {
    return {
      live: false,
      conclusive: false,
      reason: `workspace_${row.workspace_status}_resumable`,
      workspaceStatus: row.workspace_status,
      nodeId: row.node_id,
      activeAcpSessionId: null,
    };
  }
  if (!LIVE_WORKSPACE_STATUSES.has(row.workspace_status)) {
    return dead(`workspace_${row.workspace_status}`, row.workspace_status, row.node_id);
  }
  if (!row.chat_session_id || !row.node_id) {
    return {
      live: false,
      conclusive: false,
      reason: 'workspace_runtime_identity_incomplete',
      workspaceStatus: row.workspace_status,
      nodeId: row.node_id,
      activeAcpSessionId: null,
    };
  }

  const probeTimeoutMs = parseMs(
    env.TASK_LIVENESS_PROBE_TIMEOUT_MS,
    DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS
  );
  if (row.node_runtime === 'cf-container') {
    const TIMEOUT = Symbol('container_lifecycle_probe_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = await Promise.race([
        inspectVmAgentContainerLifecycle(env, row.node_id),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), probeTimeoutMs);
        }),
      ]);
      if (probe === TIMEOUT) {
        return {
          live: false,
          conclusive: false,
          reason: 'cf_container_lifecycle_timeout',
          workspaceStatus: row.workspace_status,
          nodeId: row.node_id,
          activeAcpSessionId: null,
        };
      }
      const classification = classifyVmAgentContainerLiveness(probe);
      return {
        ...classification,
        workspaceStatus: row.workspace_status,
        nodeId: row.node_id,
        activeAcpSessionId: null,
      };
    } catch (err) {
      log.warn('stuck_task.container_lifecycle_probe_failed', {
        workspaceId: task.workspace_id,
        nodeId: row.node_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        live: false,
        conclusive: false,
        reason: 'cf_container_lifecycle_unknown',
        workspaceStatus: row.workspace_status,
        nodeId: row.node_id,
        activeAcpSessionId: null,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const staleSeconds =
    parseInt(env.NODE_HEARTBEAT_STALE_SECONDS || '', 10) || DEFAULT_NODE_HEARTBEAT_STALE_SECONDS;
  const staleMs = staleSeconds * 1000;
  const nodeHeartbeatAt = row.last_heartbeat_at
    ? new Date(row.last_heartbeat_at).getTime()
    : Number.NaN;
  if (
    row.node_status !== 'running' ||
    row.health_status !== 'healthy' ||
    !Number.isFinite(nodeHeartbeatAt) ||
    Date.now() - nodeHeartbeatAt > staleMs
  ) {
    return dead('node_not_live', row.workspace_status, row.node_id);
  }

  try {
    const limit = parseMs(
      env.TASK_LIVENESS_MAX_ACP_SESSIONS,
      DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS
    );
    // Bound the ProjectData DO probe so a slow/unresponsive DO cannot stall the
    // control-loop sweep (rule 47). A timeout is inconclusive, never fatal.
    const TIMEOUT = Symbol('liveness_probe_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = await Promise.race([
      projectDataService.listAcpSessions(env, task.project_id, {
        chatSessionId: row.chat_session_id,
        limit,
      }),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), probeTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (probe === TIMEOUT) {
      log.warn('stuck_task.liveness_probe_timeout', {
        workspaceId: task.workspace_id,
        probeTimeoutMs,
      });
      return {
        live: false,
        conclusive: false,
        reason: 'task_liveness_timeout',
        workspaceStatus: row.workspace_status,
        nodeId: row.node_id,
        activeAcpSessionId: null,
      };
    }
    const { sessions } = probe;
    const active = sessions.find((session) => {
      if (!ACTIVE_ACP_STATUSES.has(session.status) || session.workspaceId !== task.workspace_id)
        return false;
      const heartbeatAt =
        session.lastHeartbeatAt ?? session.updatedAt ?? session.startedAt ?? session.createdAt;
      return Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= staleMs;
    });
    if (active) {
      return {
        live: true,
        conclusive: true,
        reason: 'task_acp_session_live',
        workspaceStatus: row.workspace_status,
        nodeId: row.node_id,
        activeAcpSessionId: active.id,
      };
    }
    return dead('task_acp_session_not_live', row.workspace_status, row.node_id);
  } catch (err) {
    log.warn('stuck_task.liveness_probe_failed', {
      workspaceId: task.workspace_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      live: false,
      conclusive: false,
      reason: 'task_liveness_unknown',
      workspaceStatus: row.workspace_status,
      nodeId: row.node_id,
      activeAcpSessionId: null,
    };
  }
}

/**
 * Explain the evidence the scheduled reconciler would use for one task.
 * This helper is deliberately read-only so superadmins can inspect live state
 * without mutating D1 or either Durable Object.
 */
export async function getTaskReconciliationDiagnostics(
  env: Env,
  taskId: string
): Promise<TaskReconciliationDiagnostics | null> {
  const task = await env.DATABASE.prepare(
    `SELECT id, project_id, status, execution_step, started_at, updated_at, workspace_id
     FROM tasks
     WHERE id = ?
     LIMIT 1`
  )
    .bind(taskId)
    .first<{
      id: string;
      project_id: string;
      status: string;
      execution_step: string | null;
      started_at: string | null;
      updated_at: string;
      workspace_id: string | null;
    }>();

  if (!task) return null;

  const now = Date.now();
  const updatedAt = new Date(task.updated_at).getTime();
  const elapsedMs = now - updatedAt;
  const mismatchGraceMs = parseMs(env.TASK_DO_MISMATCH_GRACE_MS, DEFAULT_TASK_DO_MISMATCH_GRACE_MS);
  const queuedTimeoutMs = parseMs(
    env.TASK_STUCK_QUEUED_TIMEOUT_MS,
    DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS
  );
  const delegatedTimeoutMs = parseMs(
    env.TASK_STUCK_DELEGATED_TIMEOUT_MS,
    DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS
  );
  const maxExecutionMs = parseMs(env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS);
  const maxCandidates = parseMs(
    env.STUCK_TASK_MAX_CANDIDATES_PER_SWEEP,
    DEFAULT_STUCK_TASK_MAX_CANDIDATES_PER_SWEEP
  );

  let timeForCheck = elapsedMs;
  let halfThreshold = mismatchGraceMs;
  if (task.status === 'queued') {
    halfThreshold = queuedTimeoutMs / 2;
  } else if (task.status === 'delegated') {
    halfThreshold = delegatedTimeoutMs / 2;
  } else if (task.status === 'in_progress') {
    const startedAt = task.started_at ? new Date(task.started_at).getTime() : updatedAt;
    timeForCheck = now - startedAt;
    halfThreshold = maxExecutionMs / 2;
  }

  const eligibilityThresholdMs = Math.min(halfThreshold, mismatchGraceMs);
  const active = ['queued', 'delegated', 'in_progress'].includes(task.status);
  const eligible = active && timeForCheck > eligibilityThresholdMs;
  const [taskRunner, liveness, candidateSelection] = await Promise.all([
    probeTaskRunnerStatus(env, task.id),
    task.status === 'in_progress' ? getTaskRuntimeLiveness(env, task) : Promise.resolve(null),
    selectStuckTaskCandidates(env, maxCandidates),
  ]);
  const candidateIndex = candidateSelection.tasks.findIndex(
    (candidate) => candidate.id === task.id
  );

  let decision: TaskReconciliationDecision;
  if (!active) {
    decision = 'not_active';
  } else if (!eligible) {
    decision = 'within_grace';
  } else if (liveness?.conclusive && !liveness.live) {
    decision = 'reconcile_dead_runtime';
  } else if (liveness?.live) {
    decision = 'preserve_live_runtime';
  } else if (task.status === 'in_progress') {
    decision = 'preserve_inconclusive_runtime';
  } else {
    decision = 'observe_orchestration';
  }

  return {
    taskId: task.id,
    status: task.status,
    executionStep: task.execution_step,
    workspaceId: task.workspace_id,
    elapsedMs: timeForCheck,
    eligibilityThresholdMs,
    eligible,
    decision,
    liveness,
    taskRunner,
    candidateScan: {
      limit: maxCandidates,
      selectedCount: candidateSelection.tasks.length,
      selected: candidateIndex >= 0,
      position: candidateIndex >= 0 ? candidateIndex + 1 : null,
      cursorLoaded: candidateSelection.cursorLoaded,
      wrapped: candidateSelection.wrapped,
      cursorErrors: candidateSelection.cursorErrors,
    },
  };
}

/**
 * Query diagnostic context for a stuck task — workspace status, node status,
 * and TaskRunner DO state. Best-effort: returns whatever context is available.
 */
export async function gatherDiagnostics(
  env: Env,
  task: {
    id: string;
    status: string;
    execution_step: string | null;
    workspace_id: string | null;
    auto_provisioned_node_id: string | null;
  },
  elapsedMs: number,
  reason: string,
  taskRunnerProbe?: TaskRunnerProbeResult
): Promise<RecoveryDiagnostics> {
  const diagnostics: RecoveryDiagnostics = {
    taskId: task.id,
    taskStatus: task.status,
    executionStep: task.execution_step,
    elapsedMs,
    reason,
    workspaceId: task.workspace_id,
    workspaceStatus: null,
    nodeId: null,
    nodeStatus: null,
    nodeHealthStatus: null,
    autoProvisionedNodeId: task.auto_provisioned_node_id,
    doState: null,
  };

  // Query workspace status
  if (task.workspace_id) {
    try {
      const wsResult = await env.DATABASE.prepare(
        `SELECT id, node_id, status FROM workspaces WHERE id = ?`
      )
        .bind(task.workspace_id)
        .first<{ id: string; node_id: string | null; status: string }>();

      if (wsResult) {
        diagnostics.workspaceStatus = wsResult.status;
        diagnostics.nodeId = wsResult.node_id;
      }
    } catch {
      // Best-effort
    }
  }

  // Query node status (use workspace's node if available, else auto-provisioned node)
  const nodeIdToCheck = diagnostics.nodeId ?? task.auto_provisioned_node_id;
  if (nodeIdToCheck) {
    try {
      const nodeResult = await env.DATABASE.prepare(
        `SELECT id, status, health_status FROM nodes WHERE id = ?`
      )
        .bind(nodeIdToCheck)
        .first<{ id: string; status: string; health_status: string | null }>();

      if (nodeResult) {
        diagnostics.nodeId = nodeResult.id;
        diagnostics.nodeStatus = nodeResult.status;
        diagnostics.nodeHealthStatus = nodeResult.health_status;
      }
    } catch {
      // Best-effort
    }
  }

  const probe = taskRunnerProbe ?? (await probeTaskRunnerStatus(env, task.id));
  diagnostics.doState = {
    outcome: probe.outcome,
    exists: probe.outcome === 'ok',
    completed: probe.status?.completed ?? null,
    currentStep: probe.status?.currentStep ?? null,
    retryCount: probe.status?.retryCount ?? null,
    lastStepAt: probe.status?.lastStepAt ?? null,
    error: probe.error,
  };

  return diagnostics;
}

export async function recoverStuckTasks(env: Env): Promise<StuckTaskResult> {
  const now = new Date();
  const result: StuckTaskResult = {
    failedQueued: 0,
    failedDelegated: 0,
    failedInProgress: 0,
    failedCompactionLoops: 0,
    heartbeatSkipped: 0,
    doHealthChecked: 0,
    doHealthMissing: 0,
    doHealthErrors: 0,
    deadRuntimeReconciled: 0,
    candidatesScanned: 0,
    candidateCursorLoaded: false,
    candidateCursorWrapped: false,
    candidateCursorErrors: 0,
    errors: 0,
  };

  const queuedTimeoutMs = parseMs(
    env.TASK_STUCK_QUEUED_TIMEOUT_MS,
    DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS
  );
  const delegatedTimeoutMs = parseMs(
    env.TASK_STUCK_DELEGATED_TIMEOUT_MS,
    DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS
  );
  const maxExecutionMs = parseMs(env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS);
  const hardTimeoutMs = parseMs(env.TASK_RUN_HARD_TIMEOUT_MS, DEFAULT_TASK_RUN_HARD_TIMEOUT_MS);
  const absoluteCeilingMs = parseMs(
    env.TASK_RUN_ABSOLUTE_CEILING_MS,
    DEFAULT_TASK_RUN_ABSOLUTE_CEILING_MS
  );
  const mismatchGraceMs = parseMs(env.TASK_DO_MISMATCH_GRACE_MS, DEFAULT_TASK_DO_MISMATCH_GRACE_MS);
  const maxCandidates = parseMs(
    env.STUCK_TASK_MAX_CANDIDATES_PER_SWEEP,
    DEFAULT_STUCK_TASK_MAX_CANDIDATES_PER_SWEEP
  );

  if (hardTimeoutMs <= maxExecutionMs) {
    log.warn('stuck_task.misconfigured_hard_timeout', {
      hardTimeoutMs,
      maxExecutionMs,
      message:
        'TASK_RUN_HARD_TIMEOUT_MS is <= TASK_RUN_MAX_EXECUTION_MS — heartbeat grace window is effectively zero',
    });
  }

  if (absoluteCeilingMs <= hardTimeoutMs) {
    log.warn('stuck_task.misconfigured_absolute_ceiling', {
      absoluteCeilingMs,
      hardTimeoutMs,
    });
  }

  const candidateSelection = await selectStuckTaskCandidates(env, maxCandidates);
  result.candidatesScanned = candidateSelection.tasks.length;
  result.candidateCursorLoaded = candidateSelection.cursorLoaded;
  result.candidateCursorWrapped = candidateSelection.wrapped;
  result.candidateCursorErrors = candidateSelection.cursorErrors;

  const db = drizzle(env.DATABASE, { schema });

  for (const task of candidateSelection.tasks) {
    const updatedAt = new Date(task.updated_at).getTime();
    const elapsedMs = now.getTime() - updatedAt;
    let isStuck = false;
    let reason = '';
    let compactionLoopRecovery: CompactionLoopRecovery | null = null;
    let deadRuntimeRecovery = false;

    const stepInfo = task.execution_step ? ` Last step: ${describeStep(task.execution_step)}.` : '';

    try {
      compactionLoopRecovery = await detectTaskCompactionLoop(env, task);
      if (compactionLoopRecovery) {
        isStuck = true;
        reason =
          `Claude Code compaction loop detected: ${compactionLoopRecovery.evidence.markerPairs} ` +
          `recent Compacting marker pairs in the last ${compactionLoopRecovery.evidence.windowMessages} ` +
          `messages (threshold: ${compactionLoopRecovery.evidence.minPairs}). Stopping the task to prevent duplicate token spend.`;
      }
    } catch (err) {
      log.warn('stuck_task.compaction_loop_detection_failed', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: `Compaction-loop detection failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          recoveryType: 'claude_code_compaction_loop_detection_failure',
          taskId: task.id,
          taskStatus: task.status,
          executionStep: task.execution_step,
        },
        userId: task.user_id,
        workspaceId: task.workspace_id,
      });
    }

    // Compute task-scoped liveness at most once per candidate: both the
    // in_progress timeout gate and the DO-completed mismatch gate below may need
    // it, and each probe is a bounded ProjectData DO call (rule 47 — I/O budget).
    let cachedLiveness: TaskRuntimeLiveness | null = null;
    const probeLiveness = async (): Promise<TaskRuntimeLiveness> => {
      cachedLiveness ??= await getTaskRuntimeLiveness(env, task);
      return cachedLiveness;
    };
    let cachedTaskRunnerProbe: TaskRunnerProbeResult | null = null;
    const probeTaskRunner = async (): Promise<TaskRunnerProbeResult> => {
      if (!cachedTaskRunnerProbe) {
        cachedTaskRunnerProbe = await probeTaskRunnerStatus(env, task.id);
        result.doHealthChecked++;
        if (cachedTaskRunnerProbe.outcome === 'missing') result.doHealthMissing++;
        if (
          cachedTaskRunnerProbe.outcome === 'error' ||
          cachedTaskRunnerProbe.outcome === 'timeout'
        ) {
          result.doHealthErrors++;
        }
      }
      return cachedTaskRunnerProbe;
    };

    if (!isStuck) {
      switch (task.status) {
        case 'queued':
          if (elapsedMs > queuedTimeoutMs) {
            isStuck = true;
            reason = `Task stuck in 'queued' for ${Math.round(elapsedMs / 1000)}s (threshold: ${Math.round(queuedTimeoutMs / 1000)}s).${stepInfo} Node provisioning may have failed silently.`;
          }
          break;
        case 'delegated':
          if (elapsedMs > delegatedTimeoutMs) {
            isStuck = true;
            reason = `Task stuck in 'delegated' for ${Math.round(elapsedMs / 1000)}s (threshold: ${Math.round(delegatedTimeoutMs / 1000)}s).${stepInfo} Workspace may have failed to start.`;
          }
          break;
        case 'in_progress': {
          // A task-mode task legitimately paused at execution_step
          // 'awaiting_followup' keeps status 'in_progress'; it is protected here
          // by the same liveness gate (a live workspace/agent is never failed).
          const startedAt = task.started_at ? new Date(task.started_at).getTime() : updatedAt;
          const executionMs = now.getTime() - startedAt;
          if (executionMs > maxExecutionMs) {
            if (executionMs > absoluteCeilingMs) {
              isStuck = true;
              reason = `Task exceeded the absolute runaway-cost ceiling of ${Math.round(absoluteCeilingMs / 60000)} minutes; live-runtime tasks are bounded to prevent unbounded compute.${stepInfo}`;
              break;
            }
            const liveness = await probeLiveness();
            if (liveness.live || !liveness.conclusive) {
              if (liveness.live) {
                log.info('stuck_task.skipped_active_heartbeat', {
                  taskId: task.id,
                  nodeId: liveness.nodeId,
                  activeAcpSessionId: liveness.activeAcpSessionId,
                  executionMs,
                  maxExecutionMs,
                  hardTimeoutMs,
                });

                await persistError(env.OBSERVABILITY_DATABASE, {
                  source: 'api',
                  level: 'info',
                  message: `Skipped stuck task recovery: VM agent heartbeat is recent (task running ${Math.round(executionMs / 60000)} min, hard timeout at ${Math.round(hardTimeoutMs / 60000)} min)`,
                  context: {
                    recoveryType: 'stuck_task_heartbeat_skip',
                    taskId: task.id,
                    nodeId: liveness.nodeId,
                    activeAcpSessionId: liveness.activeAcpSessionId,
                    executionMs,
                    maxExecutionMs,
                    hardTimeoutMs,
                  },
                  userId: task.user_id,
                  nodeId: liveness.nodeId,
                });
                result.heartbeatSkipped++;
              }
              break;
            }
            isStuck = true;
            const threshold = executionMs > hardTimeoutMs ? hardTimeoutMs : maxExecutionMs;
            reason = `Task runtime is no longer live after ${Math.round(threshold / 60000)} minutes. Last liveness result: ${liveness.reason}.${stepInfo}`;
          }
          break;
        }
      }
    }

    // For non-stuck tasks, check DO health as defense-in-depth (TDF-7).
    // If the task has been sitting for at least half its threshold time,
    // proactively verify the DO is still alive and making progress.
    if (!isStuck) {
      // Use the correct time base per status:
      // - queued/delegated: elapsedMs (time since last updated_at)
      // - in_progress: executionMs (time since started_at, consistent with stuck detection)
      let timeForCheck = elapsedMs;
      let halfThreshold: number;
      if (task.status === 'queued') {
        halfThreshold = queuedTimeoutMs / 2;
      } else if (task.status === 'delegated') {
        halfThreshold = delegatedTimeoutMs / 2;
      } else {
        // in_progress — use started_at for consistent time base
        const startedAt = task.started_at ? new Date(task.started_at).getTime() : updatedAt;
        timeForCheck = now.getTime() - startedAt;
        halfThreshold = maxExecutionMs / 2;
      }

      if (timeForCheck > Math.min(halfThreshold, mismatchGraceMs)) {
        const doProbe = await probeTaskRunner();
        const doStatus = doProbe.status;
        const liveness = task.status === 'in_progress' ? await probeLiveness() : null;

        // TaskRunner.completed means orchestration handed off successfully, not
        // that the agent later finalized D1. Conclusive task-scoped runtime death
        // is therefore authoritative after the mismatch grace; the DO RPC remains
        // best-effort diagnostic evidence and cannot strand an immortal row.
        if (liveness?.conclusive && !liveness.live) {
          isStuck = true;
          deadRuntimeRecovery = true;
          reason = `Task runtime is conclusively gone after reconciliation grace (${liveness.reason}).`;
          log.warn('stuck_task.dead_runtime_reconciliation', {
            taskId: task.id,
            taskStatus: task.status,
            executionStep: task.execution_step,
            livenessReason: liveness.reason,
            taskRunnerProbeOutcome: doProbe.outcome,
            taskRunnerCompleted: doStatus?.completed ?? null,
            timeForCheck,
          });
        }

        if (doStatus?.completed) {
          // Reconcile only with conclusive dead-runtime evidence. Live or unknown
          // task-scoped runtime state remains active and is logged for investigation.
          // Deduplicate the persisted mismatch signal independently of reconciliation.
          log.warn('stuck_task.do_completed_but_task_active', {
            taskId: task.id,
            taskStatus: task.status,
            doCurrentStep: doStatus.currentStep,
            doRetryCount: doStatus.retryCount,
          });

          // Deduplicate: only persist if no recent mismatch record exists for this task
          const recentMismatch = await env.OBSERVABILITY_DATABASE.prepare(
            `SELECT id FROM platform_errors
               WHERE context LIKE ? AND timestamp > ?
               LIMIT 1`
          )
            .bind(`%do_task_status_mismatch%${task.id}%`, Date.now() - 30 * 60 * 1000)
            .first();

          if (!recentMismatch) {
            await persistError(env.OBSERVABILITY_DATABASE, {
              source: 'api',
              level: 'warn',
              message: `TaskRunner DO completed but task still in '${task.status}' — possible D1 update failure`,
              context: {
                recoveryType: 'do_task_status_mismatch',
                taskId: task.id,
                taskStatus: task.status,
                executionStep: task.execution_step,
                doCurrentStep: doStatus.currentStep,
                doRetryCount: doStatus.retryCount,
                timeForCheck,
                taskRunnerProbeOutcome: doProbe.outcome,
                livenessReason: liveness?.reason ?? null,
              },
              userId: task.user_id,
            });
          }
        }
      }
      if (!isStuck) continue;
    }

    try {
      // Gather diagnostic context before recovery
      const diagnosticElapsedMs =
        task.status === 'in_progress' && task.started_at
          ? now.getTime() - new Date(task.started_at).getTime()
          : elapsedMs;
      const diagnostics = await gatherDiagnostics(
        env,
        task,
        diagnosticElapsedMs,
        reason,
        cachedTaskRunnerProbe ?? undefined
      );

      log.warn('stuck_task.recovering', {
        taskId: task.id,
        projectId: task.project_id,
        userId: task.user_id,
        status: task.status,
        executionStep: task.execution_step,
        elapsedMs: diagnosticElapsedMs,
        reason,
        recoveryType: compactionLoopRecovery ? 'claude_code_compaction_loop' : 'stuck_task',
        compactionLoop: compactionLoopRecovery?.evidence,
        workspaceStatus: diagnostics.workspaceStatus,
        nodeStatus: diagnostics.nodeStatus,
        doState: diagnostics.doState,
      });

      // Record recovery in OBSERVABILITY_DATABASE for admin visibility (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: reason,
        context: {
          ...(compactionLoopRecovery
            ? { recoveryType: 'claude_code_compaction_loop' }
            : { recoveryType: 'stuck_task' }),
          taskStatus: task.status,
          executionStep: task.execution_step,
          elapsedMs: diagnosticElapsedMs,
          compactionLoop: compactionLoopRecovery
            ? {
                sessionId: compactionLoopRecovery.sessionId,
                agentSessionId: compactionLoopRecovery.agentSessionId,
                recentMessageLimit: compactionLoopRecovery.recentMessageLimit,
                evidence: compactionLoopRecovery.evidence,
              }
            : null,
          workspaceId: diagnostics.workspaceId,
          workspaceStatus: diagnostics.workspaceStatus,
          nodeId: diagnostics.nodeId,
          nodeStatus: diagnostics.nodeStatus,
          nodeHealthStatus: diagnostics.nodeHealthStatus,
          autoProvisionedNodeId: diagnostics.autoProvisionedNodeId,
          doState: diagnostics.doState,
        },
        userId: task.user_id,
        nodeId: diagnostics.nodeId,
        workspaceId: diagnostics.workspaceId,
      });

      const nowIso = now.toISOString();
      // Use optimistic locking: only fail the task if it's still in the
      // same status we observed. This prevents TOCTOU races with the
      // TaskRunner DO which may have advanced the task in between our
      // SELECT and this UPDATE.
      const updateResult = await env.DATABASE.prepare(
        `UPDATE tasks SET status = 'failed', execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`
      )
        .bind(reason, nowIso, nowIso, task.id, task.status)
        .run();

      if (!updateResult.meta.changes || updateResult.meta.changes === 0) {
        // Task was advanced by the DO between our SELECT and UPDATE — skip
        log.info('stuck_task.skipped_optimistic_lock', {
          taskId: task.id,
          expectedStatus: task.status,
        });
        continue;
      }

      await db.insert(schema.taskStatusEvents).values({
        id: ulid(),
        taskId: task.id,
        fromStatus: task.status as 'queued' | 'delegated' | 'in_progress',
        toStatus: 'failed',
        actorType: 'system',
        actorId: null,
        reason,
        createdAt: nowIso,
      });

      // Sync trigger execution status (best-effort) — without this, cron triggers
      // with skipIfRunning=true permanently stop firing because the execution stays 'running'.
      await syncTriggerExecutionStatus(env.DATABASE, task.id, 'failed', reason);

      if (compactionLoopRecovery?.sessionId) {
        try {
          await projectDataService.failSession(
            env,
            task.project_id,
            compactionLoopRecovery.sessionId,
            reason
          );
        } catch (sessionErr) {
          log.warn('stuck_task.compaction_loop_session_fail_failed', {
            taskId: task.id,
            sessionId: compactionLoopRecovery.sessionId,
            error: sessionErr instanceof Error ? sessionErr.message : String(sessionErr),
          });
        }
      }

      // Best-effort cleanup: stop workspace and mark auto-provisioned node as warm.
      // cleanupTaskRun reads the task's workspaceId and autoProvisionedNodeId from DB.
      try {
        await cleanupTaskRun(task.id, env);
      } catch (cleanupErr) {
        log.error('stuck_task.cleanup_failed', {
          taskId: task.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });

        // Record cleanup failure in OBSERVABILITY_DATABASE (TDF-7)
        await persistError(env.OBSERVABILITY_DATABASE, {
          source: 'api',
          level: 'error',
          message: `Stuck task cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          stack: cleanupErr instanceof Error ? cleanupErr.stack : undefined,
          context: {
            recoveryType: 'stuck_task_cleanup_failure',
            taskId: task.id,
            taskStatus: task.status,
            executionStep: task.execution_step,
          },
          userId: task.user_id,
          nodeId: diagnostics.nodeId,
          workspaceId: diagnostics.workspaceId,
        });
      }

      switch (task.status) {
        case 'queued':
          result.failedQueued++;
          break;
        case 'delegated':
          result.failedDelegated++;
          break;
        case 'in_progress':
          result.failedInProgress++;
          if (deadRuntimeRecovery) result.deadRuntimeReconciled++;
          if (compactionLoopRecovery) result.failedCompactionLoops++;
          break;
      }
    } catch (err) {
      log.error('stuck_task.recovery_failed', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });

      // Record recovery failure in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'error',
        message: `Stuck task recovery failed: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          recoveryType: 'stuck_task_recovery_failure',
          taskId: task.id,
          taskStatus: task.status,
          executionStep: task.execution_step,
        },
        userId: task.user_id,
      });

      result.errors++;
    }
  }

  if (
    candidateSelection.nextCursor &&
    !(await persistStuckTaskScanCursor(env, candidateSelection.nextCursor))
  ) {
    result.candidateCursorErrors++;
  }

  return result;
}
