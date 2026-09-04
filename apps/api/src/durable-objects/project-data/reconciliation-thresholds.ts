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
  DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS,
  DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS,
  DEFAULT_TASK_RECONCILIATION_CANDIDATE_LEASE_MS,
  DEFAULT_TASK_RECONCILIATION_IDLE_MS,
  DEFAULT_TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_TASK_RECONCILIATION_MIN_ALARM_DELAY_MS,
  DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS,
  DEFAULT_TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS,
  DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS,
  DEFAULT_TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS,
  DEFAULT_TASK_RECONCILIATION_QUARANTINE_MS,
  DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS,
} from '@simple-agent-manager/shared';

import type { Env as DOEnv } from './types';

export const DEFAULT_TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS =
  DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS;

// Capability negotiation, prompt submission, and (after a lost response)
// receipt lookup are the versioned delivery protocol's bounded remote calls.
const RECONCILIATION_PROMPT_DELIVERY_MAX_NODE_CALLS = 3;

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

export function reconciliationNodeCallTimeoutMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS',
    DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS
  );
}

export function reconciliationCandidateLeaseMs(env: DOEnv): number {
  const configuredLeaseMs = envNumber(
    env,
    'TASK_RECONCILIATION_CANDIDATE_LEASE_MS',
    DEFAULT_TASK_RECONCILIATION_CANDIDATE_LEASE_MS
  );
  // Cover both probe boundaries conservatively. They are mutually exclusive in
  // today's runtime adapter, but summing them keeps the claim safe if a future
  // classifier legitimately chains both before attempting delivery.
  const livenessProbeMs =
    envNumber(
      env,
      'TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS',
      DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS
    ) + envNumber(env, 'TASK_LIVENESS_PROBE_TIMEOUT_MS', DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS);
  const minimumSafeLeaseMs =
    livenessProbeMs +
    RECONCILIATION_PROMPT_DELIVERY_MAX_NODE_CALLS * reconciliationNodeCallTimeoutMs(env) +
    minReconciliationAlarmDelayMs(env);
  return Math.max(configuredLeaseMs, minimumSafeLeaseMs);
}

export function reconciliationProbeMaxAttempts(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS',
    DEFAULT_TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS
  );
}

export function reconciliationQuarantineMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_QUARANTINE_MS',
    DEFAULT_TASK_RECONCILIATION_QUARANTINE_MS
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

/** Consecutive unreachable probes before the stale mirror is quarantined. */
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
