/**
 * Reconciliation threshold/config accessors — env-configurable timing knobs
 * for task-mode inactivity reconciliation (see reconciliation.ts).
 *
 * Extracted from reconciliation.ts to keep that file under the file-size
 * ratchet (.claude/rules/18-file-size-limits.md). Pure extraction — no
 * behavior change. These are stateless env-parsing accessors; they hold no
 * Durable Object state and do not participate in locking or async
 * prerequisite capture.
 */
import {
  DEFAULT_SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS,
  DEFAULT_SESSION_ACTIVITY_PROBE_MAX_CANDIDATES,
  DEFAULT_SESSION_ACTIVITY_PROBE_TIMEOUT_MS,
  DEFAULT_TASK_RECONCILIATION_IDLE_MS,
  DEFAULT_TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_TASK_RECONCILIATION_MIN_ALARM_DELAY_MS,
  DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS,
  DEFAULT_TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS,
  DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS,
  DEFAULT_TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS,
  DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS,
} from '@simple-agent-manager/shared';

import type { Env as DOEnv } from './types';

export const DEFAULT_TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS =
  DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS;

function envNumber(env: DOEnv, key: string, fallback: number): number {
  const value = Number.parseInt(
    (env as unknown as Record<string, string | undefined>)[key] ?? '',
    10
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function reconciliationIdleMs(env: DOEnv): number {
  return envNumber(env, 'TASK_RECONCILIATION_IDLE_MS', DEFAULT_TASK_RECONCILIATION_IDLE_MS);
}

export function reconciliationDeadlineMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_RESPONSE_DEADLINE_MS',
    DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS
  );
}

export function promptSoftStallMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS',
    DEFAULT_TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS
  );
}

export function promptHardStallMs(env: DOEnv): number {
  const softMs = promptSoftStallMs(env);
  const hardMs = envNumber(
    env,
    'TASK_RECONCILIATION_PROMPT_HARD_STALL_MS',
    DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS
  );
  return Math.max(hardMs, softMs);
}

export function activeWorkHardStallMs(env: DOEnv): number {
  const deadlineMs = reconciliationDeadlineMs(env);
  const hardMs = envNumber(
    env,
    'TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS',
    DEFAULT_TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS
  );
  return Math.max(hardMs, deadlineMs);
}

export function minReconciliationAlarmDelayMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_MIN_ALARM_DELAY_MS',
    DEFAULT_TASK_RECONCILIATION_MIN_ALARM_DELAY_MS
  );
}

export function maxCandidatesPerSweep(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP',
    DEFAULT_TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP
  );
}

export function nodeHeartbeatStaleMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS',
    DEFAULT_TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS
  );
}

export function reconciliationNodeCallTimeoutMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS',
    DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS
  );
}

/**
 * Timeout for the vm-agent session-activity probe. Background control-loop
 * budget, deliberately far below the interactive node-agent timeout (rule 47).
 */
export function sessionActivityProbeTimeoutMs(env: DOEnv): number {
  return envNumber(
    env,
    'SESSION_ACTIVITY_PROBE_TIMEOUT_MS',
    DEFAULT_SESSION_ACTIVITY_PROBE_TIMEOUT_MS
  );
}

/** Consecutive unreachable probes after which the target is treated as dead. */
export function sessionActivityProbeMaxAttempts(env: DOEnv): number {
  return envNumber(
    env,
    'SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS',
    DEFAULT_SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS
  );
}

/** Maximum stale-activity candidates probed in a single alarm pass. */
export function sessionActivityProbeMaxCandidates(env: DOEnv): number {
  return envNumber(
    env,
    'SESSION_ACTIVITY_PROBE_MAX_CANDIDATES',
    DEFAULT_SESSION_ACTIVITY_PROBE_MAX_CANDIDATES
  );
}
