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
  type TaskExecutionStep,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

const DEFAULT_INSTANT_START_STALE_TIMEOUT_MS = 10 * 60 * 1000;

import * as schema from '../db/schema';
import type { TaskRunner } from '../durable-objects/task-runner';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import { persistError } from '../services/observability';
import * as projectDataService from '../services/project-data';
import { DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS } from '../services/session-snapshot-artifacts';
import { cleanupTaskRun } from '../services/task-runner';
import {
  classifyTaskRuntimeLiveness,
  isSessionResumable,
  isSupersededTerminalReason,
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
  type TaskSupersession,
} from '../services/task-runtime-liveness';
import { syncTriggerExecutionStatus } from '../services/trigger-execution-sync';
import {
  cancelVmTaskAdmission,
  getVmAdmissionDiagnostics,
  isActiveVmAdmissionState,
} from '../services/vm-admission-control';
import { inspectVmAgentContainerLifecycle } from '../services/vm-agent-container';
import {
  type CompactionLoopRecovery,
  detectTaskCompactionLoop,
} from './claude-code-compaction-loop';

/**
 * Recorded instead of a runtime-death message when a task ended because its
 * conversation moved on to a wake successor (`.claude/rules/66`).
 */
const SUPERSEDED_TERMINATION_MESSAGE =
  'Superseded by a later session wake; the conversation continued in a replacement ' +
  'task and has since ended.';
const TASK_RUNNER_NORMAL_HANDOFF_STEP: TaskExecutionStep = 'running';
const TASK_RUNNER_MISMATCH_RECOVERY_TYPE = 'do_task_status_mismatch';

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
  waiting_for_node_capacity: 'waiting for VM capacity',
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

function isNormalCompletedTaskRunnerHandoff(
  task: StuckTaskCandidate,
  doStatus: NonNullable<TaskRunnerProbeResult['status']>
): boolean {
  return task.status === 'in_progress' && doStatus.currentStep === TASK_RUNNER_NORMAL_HANDOFF_STEP;
}

function taskRunnerMismatchKind(
  task: StuckTaskCandidate,
  doStatus: NonNullable<TaskRunnerProbeResult['status']>
): 'completed_handoff_missing_in_d1' | 'completed_before_running_handoff' {
  return doStatus.currentStep === TASK_RUNNER_NORMAL_HANDOFF_STEP && task.status !== 'in_progress'
    ? 'completed_handoff_missing_in_d1'
    : 'completed_before_running_handoff';
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
  chat_session_id: string | null;
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
  admission: {
    admission: Record<string, unknown> | null;
    lease: Record<string, unknown> | null;
    providerCapacity: Record<string, unknown> | null;
  } | null;
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

export type { TaskRuntimeLiveness } from '../services/task-runtime-liveness';

export type TaskReconciliationDecision =
  | 'not_active'
  | 'within_grace'
  | 'reconcile_dead_runtime'
  | 'preserve_live_runtime'
  | 'preserve_inconclusive_runtime'
  | 'preserve_admission_wait'
  | 'fail_admission_expired'
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
  admission: Awaited<ReturnType<typeof getVmAdmissionDiagnostics>> | null;
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

function stuckTaskScanCursorKey(env: Env): string {
  return env.STUCK_TASK_SCAN_CURSOR_KV_KEY?.trim() || DEFAULT_STUCK_TASK_SCAN_CURSOR_KV_KEY;
}

function parseStuckTaskScanCursor(raw: string | null): StuckTaskScanCursor | null {
  if (!raw) return null;
  try {
    const parsedRaw = JSON.parse(raw) as unknown;
    const parsed = maybeJsonRecord(parsedRaw);
    if (
      !parsed ||
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
       workspace_id, auto_provisioned_node_id, chat_session_id`;

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
  task: { id: string; project_id: string; workspace_id: string | null }
): Promise<TaskRuntimeLiveness> {
  const probeTimeoutMs = parseMs(
    env.TASK_LIVENESS_PROBE_TIMEOUT_MS,
    DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS
  );
  const staleSeconds =
    parseInt(env.NODE_HEARTBEAT_STALE_SECONDS || '', 10) || DEFAULT_NODE_HEARTBEAT_STALE_SECONDS;
  let workspace: Awaited<ReturnType<typeof loadRuntimeWorkspaceSnapshot>> = null;
  let workspaceProbeOutcome: TaskRuntimeLivenessSignals['workspaceProbeOutcome'] = 'ok';
  if (task.workspace_id) {
    try {
      workspace = await loadRuntimeWorkspaceSnapshot(
        env.DATABASE,
        task.project_id,
        task.workspace_id
      );
    } catch (err) {
      workspaceProbeOutcome = 'error';
      log.warn('stuck_task.workspace_liveness_query_failed', {
        workspaceId: task.workspace_id,
        projectId: task.project_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Only probed for a workspace that would otherwise be declared conclusively
  // dead, so the sweep pays one extra point lookup only when it is about to
  // terminalize a task (`.claude/rules/47`).
  const nowMs = Date.now();
  const maxRecoveryAttempts = parsePositiveInt(
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
        task.project_id,
        workspace.id,
        workspace.chatSessionId
      );
      resumabilityProbeOutcome = 'ok';
      resumabilityResolvedInconclusive = isSessionResumable(
        sessionResumability,
        task.project_id,
        workspace.id,
        maxRecoveryAttempts,
        nowMs
      );
    } catch (err) {
      resumabilityProbeOutcome = 'error';
      resumabilityResolvedInconclusive = true;
      log.warn('stuck_task.session_resumability_query_failed', {
        workspaceId: task.workspace_id,
        projectId: task.project_id,
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
      supersession = await loadTaskSupersession(env.DATABASE, task.project_id, task.id);
      supersessionProbeOutcome = 'ok';
    } catch (err) {
      supersessionProbeOutcome = 'error';
      log.warn('stuck_task.task_supersession_query_failed', {
        taskId: task.id,
        projectId: task.project_id,
        action: 'preserved',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let livenessSignals: TaskRuntimeLivenessSignals = {
    projectId: task.project_id,
    taskWorkspaceId: task.workspace_id,
    workspace,
    workspaceProbeOutcome,
    supersessionProbeOutcome,
    supersession,
    nowMs,
    heartbeatStaleMs: staleSeconds * 1000,
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
      log.warn('stuck_task.node_health_probe_unhealthy', {
        workspaceId: task.workspace_id,
        nodeId,
        outcome: probe.outcome,
        status: probe.status,
        timeoutMs: probe.timeoutMs,
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
    const TIMEOUT = Symbol('container_lifecycle_probe_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = await Promise.race([
        inspectVmAgentContainerLifecycle(env, workspace.nodeId),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), probeTimeoutMs);
        }),
      ]);
      if (probe === TIMEOUT) {
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
      log.warn('stuck_task.container_lifecycle_probe_failed', {
        workspaceId: task.workspace_id,
        nodeId: workspace.nodeId,
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
    const limit = parseMs(
      env.TASK_LIVENESS_MAX_ACP_SESSIONS,
      DEFAULT_TASK_LIVENESS_MAX_ACP_SESSIONS
    );
    // Bound the ProjectData DO probe so a slow/unresponsive DO cannot stall the
    // control-loop sweep (rule 47). A timeout is inconclusive, never fatal.
    const TIMEOUT = Symbol('liveness_probe_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = await Promise.race([
      projectDataService.getTaskAcpLivenessSignals(env, task.project_id, {
        chatSessionId: workspace.chatSessionId,
        workspaceId: workspace.id,
        limit,
        nowMs,
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
      return classifyTaskRuntimeLiveness({
        ...livenessSignals,
        acpProbeOutcome: 'timeout',
      });
    }
    return classifyTaskRuntimeLiveness({
      ...livenessSignals,
      acpProbeOutcome: 'ok',
      acpSessions: probe.sessions as RuntimeAcpSessionSnapshot[],
      sessionWork: probe.sessionWork,
    });
  } catch (err) {
    log.warn('stuck_task.liveness_probe_failed', {
      workspaceId: task.workspace_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return classifyTaskRuntimeLiveness({
      ...livenessSignals,
      acpProbeOutcome: 'error',
    });
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
  const instantStartStaleTimeoutMs = parseMs(
    env.INSTANT_START_STALE_TIMEOUT_MS,
    DEFAULT_INSTANT_START_STALE_TIMEOUT_MS
  );
  const maxExecutionMs = parseMs(env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS);
  const maxCandidates = parseMs(
    env.STUCK_TASK_MAX_CANDIDATES_PER_SWEEP,
    DEFAULT_STUCK_TASK_MAX_CANDIDATES_PER_SWEEP
  );

  let timeForCheck = elapsedMs;
  let halfThreshold = mismatchGraceMs;
  if (task.status === 'queued') {
    halfThreshold =
      task.execution_step === 'instant_persistence'
        ? instantStartStaleTimeoutMs / 2
        : queuedTimeoutMs / 2;
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
  const admission =
    task.status === 'queued' && task.execution_step === 'waiting_for_node_capacity'
      ? await getVmAdmissionDiagnostics(env, task.id)
      : null;
  const candidateIndex = candidateSelection.tasks.findIndex(
    (candidate) => candidate.id === task.id
  );

  let decision: TaskReconciliationDecision;
  if (!active) {
    decision = 'not_active';
  } else if (
    task.status === 'queued' &&
    task.execution_step === 'waiting_for_node_capacity' &&
    admission?.admission &&
    isActiveVmAdmissionState(String(admission.admission.state ?? ''))
  ) {
    const waitDeadlineAt =
      typeof admission.admission.wait_deadline_at === 'string'
        ? Date.parse(admission.admission.wait_deadline_at)
        : NaN;
    decision =
      Number.isFinite(waitDeadlineAt) && waitDeadlineAt <= now
        ? 'fail_admission_expired'
        : 'preserve_admission_wait';
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
    admission,
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
    admission: null,
    doState: null,
  };

  if (task.execution_step === 'waiting_for_node_capacity') {
    try {
      diagnostics.admission = await getVmAdmissionDiagnostics(env, task.id);
    } catch (err) {
      log.warn('stuck_task.admission_diagnostics_failed', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
  const instantStartStaleTimeoutMs = parseMs(
    env.INSTANT_START_STALE_TIMEOUT_MS,
    DEFAULT_INSTANT_START_STALE_TIMEOUT_MS
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
    /** Benign supersession termination — recorded as `cancelled`, never `failed`. */
    let supersededTermination = false;
    /**
     * The ONE place a conclusive verdict becomes a terminal reason. Every branch
     * that can terminalize a task routes through here, so a supersession can
     * never be recorded as a failure by a branch that simply forgot to ask —
     * which is exactly how the first cut of this fix missed the two timeout
     * branches below (`.claude/rules/66` requirement 3).
     */
    const terminalReasonFor = (
      liveness: TaskRuntimeLiveness,
      deadRuntimeReason: string
    ): string => {
      if (isSupersededTerminalReason(liveness.reason)) {
        supersededTermination = true;
        return SUPERSEDED_TERMINATION_MESSAGE;
      }
      return deadRuntimeReason;
    };
    let admissionSnapshot: Awaited<ReturnType<typeof getVmAdmissionDiagnostics>> | null = null;

    const stepInfo = task.execution_step ? ` Last step: ${describeStep(task.execution_step)}.` : '';

    if (task.status === 'queued' && task.execution_step === 'waiting_for_node_capacity') {
      admissionSnapshot = await getVmAdmissionDiagnostics(env, task.id);
      const admission = admissionSnapshot.admission;
      if (admission && isActiveVmAdmissionState(String(admission.state ?? ''))) {
        const waitDeadlineAt =
          typeof admission.wait_deadline_at === 'string'
            ? Date.parse(admission.wait_deadline_at)
            : NaN;
        if (Number.isFinite(waitDeadlineAt) && waitDeadlineAt <= now.getTime()) {
          isStuck = true;
          reason = `Task exceeded VM admission wait deadline.${stepInfo} Last admission reason: ${String(admission.reason ?? 'unknown')}.`;
        } else {
          log.info('stuck_task.preserved_admission_wait', {
            taskId: task.id,
            reason: admission.reason ?? null,
            nextRetryAt: admission.next_retry_at ?? null,
            waitDeadlineAt: admission.wait_deadline_at ?? null,
          });
          continue;
        }
      }
    }

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
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
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
          taskId: task.id,
          sessionId: task.chat_session_id,
        },
        env
      );
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
          if (
            task.execution_step === 'instant_persistence' &&
            elapsedMs > instantStartStaleTimeoutMs
          ) {
            isStuck = true;
            reason = `Instant session start accepted but still queued for ${Math.round(elapsedMs / 1000)}s (threshold: ${Math.round(instantStartStaleTimeoutMs / 1000)}s).${stepInfo} Background container launch may not have completed.`;
          } else if (elapsedMs > queuedTimeoutMs) {
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
              // The ceiling is a cost backstop: it still terminalizes unconditionally
              // and deliberately does NOT pay for a full liveness probe (no ACP /
              // container round-trips — a property pinned by
              // stuck-tasks.test.ts "without probing liveness"). But a superseded
              // predecessor holds no compute at all, so it must not be recorded as a
              // runaway failure. One cheap indexed lookup, reached only by 24h+ tasks,
              // buys the correct label without reintroducing the expensive probe.
              let ceilingSupersession: TaskSupersession = 'none';
              try {
                ceilingSupersession = await loadTaskSupersession(
                  env.DATABASE,
                  task.project_id,
                  task.id
                );
              } catch (err) {
                log.warn('stuck_task.ceiling_supersession_query_failed', {
                  taskId: task.id,
                  projectId: task.project_id,
                  action: 'labelled_as_runaway',
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              if (ceilingSupersession === 'live') {
                // Preserve, do NOT terminalize. A superseded predecessor holds no
                // compute at all — its workspace is already deleted — so the cost
                // ceiling has nothing to bound here. Worse, `cancelled` is a member
                // of TERMINAL_TASK_STATUSES, so terminalizing would revoke the
                // recovery guard its LIVE successor still depends on, and
                // `abortRevokedSourceTaskWake` turns that into stopping a running
                // container. `'live'` is inconclusive everywhere else in the system
                // and must be inconclusive here too.
                // Bounded escape (`.claude/rules/47`): once the successor ends this
                // reads `'terminal'` on the next tick and the task is cancelled.
                log.info('stuck_task.ceiling_preserved_superseded', {
                  taskId: task.id,
                  projectId: task.project_id,
                  executionMs,
                  action: 'preserved',
                });
                break;
              }
              isStuck = true;
              if (ceilingSupersession === 'terminal') {
                supersededTermination = true;
                reason = SUPERSEDED_TERMINATION_MESSAGE;
              } else {
                reason = `Task exceeded the absolute runaway-cost ceiling of ${Math.round(absoluteCeilingMs / 60000)} minutes; live-runtime tasks are bounded to prevent unbounded compute.${stepInfo}`;
              }
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

                await persistError(
                  env.OBSERVABILITY_DATABASE,
                  {
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
                    taskId: task.id,
                    sessionId: task.chat_session_id,
                  },
                  env
                );
                result.heartbeatSkipped++;
              }
              break;
            }
            isStuck = true;
            const threshold = executionMs > hardTimeoutMs ? hardTimeoutMs : maxExecutionMs;
            reason = terminalReasonFor(
              liveness,
              `Task runtime is no longer live after ${Math.round(threshold / 60000)} minutes. Last liveness result: ${liveness.reason}.${stepInfo}`
            );
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
          reason = terminalReasonFor(
            liveness,
            `Task runtime is conclusively gone after reconciliation grace (${liveness.reason}).`
          );
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

        if (doStatus?.completed && !isStuck) {
          if (isNormalCompletedTaskRunnerHandoff(task, doStatus)) {
            // `transitionToInProgress` deliberately stores TaskRunner
            // `completed=true` at the successful handoff boundary while the D1 task
            // remains active until an explicit agent/user terminal path. This is
            // normal lifecycle bookkeeping, not D1 drift; production evidence on
            // 2026-08-24 showed these rows were live, restorable, or live-superseded.
            log.info('stuck_task.do_completed_handoff_active', {
              taskId: task.id,
              taskStatus: task.status,
              executionStep: task.execution_step,
              doCurrentStep: doStatus.currentStep,
              doRetryCount: doStatus.retryCount,
              livenessReason: liveness?.reason ?? null,
              action: 'observed_normal_handoff',
            });
          } else {
            const mismatchKind = taskRunnerMismatchKind(task, doStatus);
            log.warn('stuck_task.do_completed_active_state_mismatch', {
              taskId: task.id,
              taskStatus: task.status,
              executionStep: task.execution_step,
              doCurrentStep: doStatus.currentStep,
              doRetryCount: doStatus.retryCount,
              mismatchKind,
            });

            // One durable diagnostic per task is enough. Repeating the same
            // preserved candidate every 30 minutes caused the production noise that
            // hid the real state: normal handoff and resumable/superseded sessions.
            const existingMismatch = await env.OBSERVABILITY_DATABASE.prepare(
              `SELECT id FROM platform_errors
                 WHERE task_id = ? AND context LIKE ?
                 LIMIT 1`
            )
              .bind(task.id, `%${TASK_RUNNER_MISMATCH_RECOVERY_TYPE}%`)
              .first();

            if (!existingMismatch) {
              await persistError(
                env.OBSERVABILITY_DATABASE,
                {
                  source: 'api',
                  level: 'warn',
                  message:
                    `TaskRunner DO reports completed at '${doStatus.currentStep}' while ` +
                    `task remains '${task.status}' — active state mismatch before normal handoff convergence`,
                  context: {
                    recoveryType: TASK_RUNNER_MISMATCH_RECOVERY_TYPE,
                    mismatchKind,
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
                  taskId: task.id,
                  sessionId: task.chat_session_id,
                },
                env
              );
            }
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
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
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
            admission: diagnostics.admission ?? admissionSnapshot,
            doState: diagnostics.doState,
          },
          userId: task.user_id,
          nodeId: diagnostics.nodeId,
          workspaceId: diagnostics.workspaceId,
          taskId: task.id,
          sessionId: task.chat_session_id,
        },
        env
      );

      const nowIso = now.toISOString();
      // Use optimistic locking: only fail the task if it's still in the
      // same status we observed. This prevents TOCTOU races with the
      // TaskRunner DO which may have advanced the task in between our
      // SELECT and this UPDATE.
      const terminalStatus: 'failed' | 'cancelled' = supersededTermination ? 'cancelled' : 'failed';
      const updateResult = await env.DATABASE.prepare(
        `UPDATE tasks SET status = ?, execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = ?
           AND NOT EXISTS (
             SELECT 1 FROM tasks succ
              WHERE succ.project_id = tasks.project_id
                AND succ.id <> tasks.id
                AND succ.triggered_by = 'session-recovery'
                AND succ.created_at > tasks.created_at
                AND succ.status NOT IN ('completed', 'failed', 'cancelled')
                AND (
                  succ.id = COALESCE(tasks.recovery_source_task_id, tasks.id)
                  OR succ.recovery_source_task_id = COALESCE(tasks.recovery_source_task_id, tasks.id)
                )
           )`
      )
        .bind(terminalStatus, reason, nowIso, nowIso, task.id, task.status)
        .run();

      if (!updateResult.meta.changes || updateResult.meta.changes === 0) {
        let liveSupersessionAtWrite = false;
        try {
          liveSupersessionAtWrite =
            (await loadTaskSupersession(env.DATABASE, task.project_id, task.id)) === 'live';
        } catch (err) {
          log.warn('stuck_task.supersession_guard_diagnosis_failed', {
            taskId: task.id,
            projectId: task.project_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (liveSupersessionAtWrite) {
          log.info('stuck_task.skipped_supersession_guard', {
            taskId: task.id,
            projectId: task.project_id,
            expectedStatus: task.status,
          });
        } else {
          // Task was advanced by the DO between our SELECT and UPDATE — skip
          log.info('stuck_task.skipped_optimistic_lock', {
            taskId: task.id,
            expectedStatus: task.status,
          });
        }
        continue;
      }

      await db.insert(schema.taskStatusEvents).values({
        id: ulid(),
        taskId: task.id,
        fromStatus: task.status as 'queued' | 'delegated' | 'in_progress',
        toStatus: terminalStatus,
        actorType: 'system',
        actorId: null,
        reason,
        createdAt: nowIso,
      });

      // Sync trigger execution status (best-effort) — without this, cron triggers
      // with skipIfRunning=true permanently stop firing because the execution stays 'running'.
      await syncTriggerExecutionStatus(env.DATABASE, task.id, terminalStatus, reason);
      await cancelVmTaskAdmission(
        env,
        task.id,
        supersededTermination ? 'task_cancelled' : 'task_failed'
      );

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
        await persistError(
          env.OBSERVABILITY_DATABASE,
          {
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
            taskId: task.id,
            sessionId: task.chat_session_id,
          },
          env
        );
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
      await persistError(
        env.OBSERVABILITY_DATABASE,
        {
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
          taskId: task.id,
          sessionId: task.chat_session_id,
        },
        env
      );

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
