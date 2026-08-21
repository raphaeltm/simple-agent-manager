import { parsePositiveInt } from '../lib/route-helpers';

export const DEFAULT_HARNESS_BACKGROUND_WORK_LEASE_MS = 5 * 60 * 1000;

/**
 * Absolute ceiling on how long harness-owned background work may defer sleep,
 * measured from the last real lifecycle PROGRESS edge (not from the last
 * heartbeat).
 *
 * The sliding lease alone is renewable forever: the VM agent re-reports the
 * active snapshot every `ActivityRereportInterval`, and each report refreshes
 * `runtimeWorkUpdatedAt`. An adapter faithfully re-reporting a STALE task set —
 * the canonical case being an abandoned detached dev server that stays in a
 * runtime-work set — would therefore pin compute awake indefinitely. That
 * contradicts the canonical definition of idleness: only work still expected to
 * return to the agent pins compute.
 */
export const DEFAULT_HARNESS_BACKGROUND_WORK_MAX_DURATION_MS = 30 * 60 * 1000;

export interface HarnessWorkConfig {
  leaseMs: number;
  maxDurationMs: number;
}

export interface SessionIdlenessActivityState {
  activity?: string | null;
  activityAt?: number | null;
  runtimeWorkState?: string | null;
  runtimeWorkCount?: number | null;
  runtimeWorkSource?: string | null;
  runtimeWorkUpdatedAt?: number | null;
  runtimeWorkProgressAt?: number | null;
}

export interface SessionChildWorkSignal {
  outcome: 'ok' | 'unknown' | 'not_checked';
  activeChildTaskCount?: number;
  errorMessage?: string;
}

export type SessionIdlenessReason =
  | 'idle'
  | 'runtime_work_lease_active'
  | 'child_work_active'
  | 'child_work_unknown'
  | 'prompt_turn_active'
  | 'prompt_turn_unknown'
  | 'idle_interval_pending'
  | 'completed_prompt_stale';

export interface SessionIdlenessClassification {
  idle: boolean;
  conclusive: boolean;
  reason: SessionIdlenessReason;
  activity: string | null;
  retryAt?: Date;
}

export function parseHarnessWorkConfig(env: {
  HARNESS_BACKGROUND_WORK_LEASE_MS?: string;
  HARNESS_BACKGROUND_WORK_MAX_DURATION_MS?: string;
}): HarnessWorkConfig {
  return {
    leaseMs: parsePositiveInt(
      env.HARNESS_BACKGROUND_WORK_LEASE_MS,
      DEFAULT_HARNESS_BACKGROUND_WORK_LEASE_MS
    ),
    maxDurationMs: parsePositiveInt(
      env.HARNESS_BACKGROUND_WORK_MAX_DURATION_MS,
      DEFAULT_HARNESS_BACKGROUND_WORK_MAX_DURATION_MS
    ),
  };
}

export function isHarnessWorkLeaseActive(
  state: SessionIdlenessActivityState | null,
  now: Date,
  config: HarnessWorkConfig
): boolean {
  return getFreshHarnessWorkLeaseExpiry(state, now, config.leaseMs, config.maxDurationMs) !== null;
}

export function getFreshHarnessWorkLeaseExpiry(
  state: SessionIdlenessActivityState | null,
  now: Date,
  leaseMs: number,
  maxDurationMs: number
): Date | null {
  if (!state || !['active', 'settling'].includes(state.runtimeWorkState ?? '')) return null;
  if (!state.runtimeWorkUpdatedAt || state.runtimeWorkUpdatedAt <= 0) return null;
  const expiresAt = state.runtimeWorkUpdatedAt + leaseMs;
  if (expiresAt <= now.getTime()) return null;

  // Absolute ceiling anchored on the PROGRESS clock, which only advances on real
  // harness lifecycle edges/progress — never on the periodic heartbeat re-report
  // that refreshes `runtimeWorkUpdatedAt`. Work that has stopped progressing
  // therefore releases the session even while the adapter keeps reporting it.
  // Falls back to the heartbeat clock when no progress timestamp was reported,
  // which is the conservative direction (sleep sooner, never later).
  const progressAnchor =
    state.runtimeWorkProgressAt && state.runtimeWorkProgressAt > 0
      ? state.runtimeWorkProgressAt
      : state.runtimeWorkUpdatedAt;
  const ceiling = progressAnchor + maxDurationMs;
  if (ceiling <= now.getTime()) return null;

  return new Date(Math.min(expiresAt, ceiling));
}

export function classifySessionIdleness(input: {
  taskStatus: string | null;
  taskExecutionStep?: string | null;
  state: SessionIdlenessActivityState | null;
  now: Date;
  idleAfterMs: number;
  harnessWorkConfig: HarnessWorkConfig;
  childWork?: SessionChildWorkSignal;
}): SessionIdlenessClassification {
  const activity = input.state?.activity ?? null;

  const runtimeWorkLeaseExpiry = getFreshHarnessWorkLeaseExpiry(
    input.state,
    input.now,
    input.harnessWorkConfig.leaseMs,
    input.harnessWorkConfig.maxDurationMs
  );
  if (runtimeWorkLeaseExpiry) {
    return {
      idle: false,
      conclusive: true,
      reason: 'runtime_work_lease_active',
      activity,
      retryAt: runtimeWorkLeaseExpiry,
    };
  }

  const childWork = input.childWork ?? { outcome: 'not_checked' };
  if (childWork.outcome === 'unknown') {
    return {
      idle: false,
      conclusive: false,
      reason: 'child_work_unknown',
      activity,
    };
  }
  if ((childWork.activeChildTaskCount ?? 0) > 0) {
    return {
      idle: false,
      conclusive: true,
      reason: 'child_work_active',
      activity,
    };
  }

  if (!input.state) {
    return {
      idle: false,
      conclusive: false,
      reason: 'prompt_turn_unknown',
      activity: null,
    };
  }

  const activityAt =
    typeof input.state.activityAt === 'number' && input.state.activityAt > 0
      ? input.state.activityAt
      : null;

  // Terminal tasks can retain a stale `prompting` transition forever. Treat
  // that state as idle only after the normal idle interval has elapsed, so a
  // final response is preserved but old terminal sessions cannot strand compute.
  if (input.taskStatus === 'completed' && activity !== 'idle') {
    if (!activityAt) {
      return {
        idle: false,
        conclusive: false,
        reason: 'prompt_turn_unknown',
        activity,
      };
    }
    const eligibleAt = activityAt + input.idleAfterMs;
    if (eligibleAt > input.now.getTime()) {
      return {
        idle: false,
        conclusive: true,
        reason: 'prompt_turn_active',
        activity,
        retryAt: new Date(eligibleAt),
      };
    }
    return {
      idle: true,
      conclusive: true,
      reason: 'completed_prompt_stale',
      activity,
    };
  }

  if (activity !== 'idle') {
    return {
      idle: false,
      conclusive: true,
      reason: 'prompt_turn_active',
      activity,
    };
  }

  if (input.taskStatus === 'completed') {
    return {
      idle: true,
      conclusive: true,
      reason: 'idle',
      activity,
    };
  }

  if (!activityAt) {
    return {
      idle: false,
      conclusive: false,
      reason: 'prompt_turn_unknown',
      activity,
    };
  }

  const idleEligibleAt = activityAt + input.idleAfterMs;
  if (idleEligibleAt > input.now.getTime()) {
    return {
      idle: false,
      conclusive: true,
      reason: 'idle_interval_pending',
      activity,
      retryAt: new Date(idleEligibleAt),
    };
  }

  // `awaiting_followup` is an execution step, not a terminal task status. Once
  // the prompt turn is idle and no tool/subtask work is in flight, it is eligible
  // just like other non-terminal states after the configured idle interval.
  return {
    idle: true,
    conclusive: true,
    reason: 'idle',
    activity,
  };
}

const ACTIVE_CHILD_TASK_STATUSES = [
  'ready',
  'queued',
  'delegated',
  'in_progress',
  // Historical rows and some query surfaces have treated this execution step as
  // a task status. Keep it as an active compatibility value.
  'awaiting_followup',
] as const;

export async function loadActiveChildTaskIdlenessSignal(
  db: D1Database,
  input: { projectId: string; parentTaskId: string | null | undefined }
): Promise<SessionChildWorkSignal> {
  if (!input.parentTaskId) return { outcome: 'not_checked' };

  try {
    const placeholders = ACTIVE_CHILD_TASK_STATUSES.map(() => '?').join(', ');
    const child = await db
      .prepare(
        `SELECT id
         FROM tasks
         WHERE project_id = ?
           AND parent_task_id = ?
           AND status IN (${placeholders})
         LIMIT 1`
      )
      .bind(input.projectId, input.parentTaskId, ...ACTIVE_CHILD_TASK_STATUSES)
      .first<{ id: string }>();
    return { outcome: 'ok', activeChildTaskCount: child?.id ? 1 : 0 };
  } catch (error) {
    return {
      outcome: 'unknown',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
