import * as defaults from '@simple-agent-manager/shared';

import { ProjectEventValidationError } from './project-events-contracts';

export interface ProjectEventScheduleEnv {
  PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES?: string;
  PROJECT_EVENT_SCHEDULE_MAX_WATCHES?: string;
  PROJECT_EVENT_SCHEDULE_MAX_RETAINED_SCHEDULES?: string;
  PROJECT_EVENT_SCHEDULE_MAX_RETAINED_WATCHES?: string;
  MAX_TASK_MESSAGE_LENGTH?: string;
  RESERVED_TASK_BRANCH_NAME_SEED_MAX_LENGTH?: string;
  RESERVED_TASK_SOURCE_DISPLAY_NAME_MAX_LENGTH?: string;
  PROJECT_EVENT_SCHEDULE_PROMPT_MAX_BYTES?: string;
  PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS?: string;
  PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS?: string;
  PROJECT_EVENT_SCHEDULE_DELIVERY_TTL_MS?: string;
  PROJECT_EVENT_SCHEDULE_SWEEP_BATCH_SIZE?: string;
  PROJECT_EVENT_SCHEDULE_CLAIM_LEASE_MS?: string;
  PROJECT_EVENT_SCHEDULE_RETRY_BASE_MS?: string;
  PROJECT_EVENT_SCHEDULE_MAX_ATTEMPTS?: string;
  PROJECT_EVENT_SCHEDULE_MAX_DEFERRAL_MS?: string;
  PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS?: string;
  PROJECT_EVENT_WATCH_MAX_EXECUTIONS?: string;
  PROJECT_EVENT_WATCH_MAX_CONCURRENT?: string;
}

export interface ProjectEventScheduleLimits {
  maxSchedules: number;
  maxWatches: number;
  maxRetainedSchedules: number;
  maxRetainedWatches: number;
  taskPromptMaxLength: number;
  taskLabelMaxLength: number;
  promptBytes: number;
  maxHorizonMs: number;
  lateGraceMs: number;
  deliveryTtlMs: number;
  sweepBatchSize: number;
  claimLeaseMs: number;
  retryBaseMs: number;
  maxAttempts: number;
  maxDeferralMs: number;
  watchCooldownMinMs: number;
  watchMaxExecutions: number;
  watchMaxConcurrent: number;
}

export function scheduleLimits(env: ProjectEventScheduleEnv): ProjectEventScheduleLimits {
  const positive = (key: keyof ProjectEventScheduleEnv, fallback: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ProjectEventValidationError(`${key} must be a positive safe integer`);
    }
    return value;
  };
  // Match the existing reserved-task adapter's environment parsing exactly.
  const reservedLimit = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxRetainedSchedules: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_RETAINED_SCHEDULES',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_RETAINED_SCHEDULES
    ),
    maxRetainedWatches: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_RETAINED_WATCHES',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_RETAINED_WATCHES
    ),
    taskPromptMaxLength: reservedLimit(
      env.MAX_TASK_MESSAGE_LENGTH,
      defaults.DEFAULT_RESERVED_TASK_PROMPT_MAX_LENGTH
    ),
    taskLabelMaxLength: Math.min(
      reservedLimit(
        env.RESERVED_TASK_BRANCH_NAME_SEED_MAX_LENGTH,
        defaults.DEFAULT_RESERVED_TASK_BRANCH_NAME_SEED_MAX_LENGTH
      ),
      reservedLimit(
        env.RESERVED_TASK_SOURCE_DISPLAY_NAME_MAX_LENGTH,
        defaults.DEFAULT_RESERVED_TASK_SOURCE_DISPLAY_NAME_MAX_LENGTH
      )
    ),
    maxSchedules: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_SCHEDULES
    ),
    maxWatches: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_WATCHES',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_WATCHES
    ),
    promptBytes: positive(
      'PROJECT_EVENT_SCHEDULE_PROMPT_MAX_BYTES',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_PROMPT_MAX_BYTES
    ),
    maxHorizonMs: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS
    ),
    lateGraceMs: positive(
      'PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS
    ),
    deliveryTtlMs: positive(
      'PROJECT_EVENT_SCHEDULE_DELIVERY_TTL_MS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_DELIVERY_TTL_MS
    ),
    sweepBatchSize: positive(
      'PROJECT_EVENT_SCHEDULE_SWEEP_BATCH_SIZE',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_SWEEP_BATCH_SIZE
    ),
    claimLeaseMs: positive(
      'PROJECT_EVENT_SCHEDULE_CLAIM_LEASE_MS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_CLAIM_LEASE_MS
    ),
    retryBaseMs: positive(
      'PROJECT_EVENT_SCHEDULE_RETRY_BASE_MS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_RETRY_BASE_MS
    ),
    maxAttempts: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_ATTEMPTS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_ATTEMPTS
    ),
    maxDeferralMs: positive(
      'PROJECT_EVENT_SCHEDULE_MAX_DEFERRAL_MS',
      defaults.DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_DEFERRAL_MS
    ),
    watchCooldownMinMs: positive(
      'PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS',
      defaults.DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS
    ),
    watchMaxExecutions: positive(
      'PROJECT_EVENT_WATCH_MAX_EXECUTIONS',
      defaults.DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS
    ),
    watchMaxConcurrent: positive(
      'PROJECT_EVENT_WATCH_MAX_CONCURRENT',
      defaults.DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT
    ),
  };
}

/** Preserve the full schedule reason while deriving valid task presentation labels. */
export function boundedScheduleTaskLabel(env: ProjectEventScheduleEnv, label: string): string {
  return label.trim().slice(0, scheduleLimits(env).taskLabelMaxLength);
}
