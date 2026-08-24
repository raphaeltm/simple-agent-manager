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
 *
 * NOTE: `runtimeWorkProgressAt` is ONE clock for the reporter's whole tracked
 * set, so this ceiling can only bound a set that stops progressing as a whole.
 * A single stale entry mixed in with live ones keeps re-stamping it and never
 * expires. Reporters are therefore responsible for evicting entries they can no
 * longer vouch for — see `reconcileHarnessWorkAtPromptTurnEnd` (ACP tool calls)
 * and the `background_tasks_changed` wholesale replace (Claude) in
 * `packages/vm-agent/internal/acp/session_host_harness_work.go`.
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

export type SessionIdlenessReason =
  | 'idle'
  | 'runtime_work_lease_active'
  | 'prompt_turn_active'
  | 'prompt_turn_unknown'
  | 'idle_interval_pending'
  | 'completed_prompt_stale';

/**
 * The two different questions callers ask of the same idleness evidence.
 *
 * `prompt-turn-ended` is the SAFETY question — "has the agent handed control
 * back, and is nothing it started still in flight?". It is what a teardown gate
 * needs, and what an explicit user-initiated sleep needs. It deliberately does
 * NOT wait out the automatic idle interval: a user pressing Sleep right after
 * their agent finishes must not be told to come back in 15 minutes.
 *
 * `idle-interval-elapsed` adds the automatic-sleep SCHEDULING policy on top —
 * "…and has the session been idle long enough that we should reclaim it on our
 * own initiative?". Only the unattended sleep scheduler asks this.
 */
export type SessionIdlenessPolicy = 'prompt-turn-ended' | 'idle-interval-elapsed';

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

/**
 * Single predicate for "has this session handed control back and is nothing it
 * started still in flight?", plus the automatic-sleep scheduling policy layered
 * on top of it (see `SessionIdlenessPolicy`).
 *
 * Child tasks and durable subtask waits are deliberately NOT inputs. A parent
 * blocked on `wait_for_subtasks` ends its turn and is woken durably by the
 * ProjectData parent-wake delivery path when its children finish, so keeping it
 * awake merely to hold a place in the lineage burns compute for no benefit.
 *
 * Only the sleep reader calls this today. Converting the remaining shutdown
 * timers (ProjectData idle cleanup, workspace idle timeout) onto it is tracked
 * as a follow-up in idea `01M08VJDHK3MNYMZCQF5AJC17P`; they still use
 * schedule/workspace-activity candidate selection plus `classifyTaskRuntimeLiveness()`.
 */
export function classifySessionIdleness(input: {
  taskStatus: string | null;
  state: SessionIdlenessActivityState | null;
  now: Date;
  idleAfterMs: number;
  harnessWorkConfig: HarnessWorkConfig;
  policy: SessionIdlenessPolicy;
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

  // The prompt turn has ended and no runtime work holds a lease. That is the
  // whole safety question, so a teardown gate or an explicit user-initiated
  // sleep stops here. A terminal task is also always immediately reclaimable.
  if (input.policy === 'prompt-turn-ended' || input.taskStatus === 'completed') {
    return {
      idle: true,
      conclusive: true,
      reason: 'idle',
      activity,
    };
  }

  // Automatic sleep additionally waits out the idle interval. A missing
  // `activityAt` means we cannot tell how long the session has been idle, so
  // the unattended scheduler declines to reclaim it (a user can still sleep it
  // explicitly, which takes the `prompt-turn-ended` branch above).
  const idleEligibleAt = activityAt === null ? null : activityAt + input.idleAfterMs;
  if (idleEligibleAt === null || idleEligibleAt > input.now.getTime()) {
    return {
      idle: false,
      conclusive: true,
      reason: 'idle_interval_pending',
      activity,
      retryAt: idleEligibleAt === null ? undefined : new Date(idleEligibleAt),
    };
  }

  // `awaiting_followup` is an execution step, not a terminal task status. Once
  // the prompt turn is idle and no runtime work is in flight, it is eligible
  // just like other non-terminal states after the configured idle interval.
  return {
    idle: true,
    conclusive: true,
    reason: 'idle',
    activity,
  };
}
