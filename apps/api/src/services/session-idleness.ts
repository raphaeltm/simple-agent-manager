import { parsePositiveInt } from '../lib/route-helpers';
import { isSleepPreservedTerminalTaskStatus } from './sleep-preserved-task-status';

export const DEFAULT_HARNESS_BACKGROUND_WORK_LEASE_MS = 5 * 60 * 1000;

/**
 * Absolute ceiling on how long harness-owned background work may defer sleep,
 * measured from the last real session work (including lifecycle progress),
 * never from the last heartbeat.
 *
 * The sliding lease alone is renewable forever: the VM agent re-reports the
 * active snapshot every `ActivityRereportInterval`, and each report refreshes
 * `runtimeWorkUpdatedAt`. An adapter faithfully re-reporting a STALE task set —
 * the canonical case being an abandoned detached dev server that stays in a
 * runtime-work set — would therefore pin compute awake indefinitely. Long-lived
 * background work may deliberately keep a session awake, but only for this
 * bounded interval after real work; heartbeat reports cannot renew it.
 *
 * NOTE: `runtimeWorkProgressAt` is ONE clock for the reporter's whole tracked
 * set, so this ceiling can only bound a set that stops progressing as a whole.
 * A single stale entry mixed in with live ones keeps re-stamping it and never
 * expires. Reporters are therefore responsible for evicting entries they can no
 * longer vouch for — see `reconcileHarnessWorkAtPromptTurnEnd` (ACP tool calls)
 * and the `background_tasks_changed` wholesale replace (Claude) in
 * `packages/vm-agent/internal/acp/session_host_harness_work.go`.
 */
export const DEFAULT_HARNESS_BACKGROUND_WORK_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * Default for `operations.sessionStaleTurnNoWorkMinutes`: how long an open turn on a running task
 * may go without real work before it stops keeping the session awake. Longer than a Claude Code
 * foreground Bash call (capped at 10 min); background tasks and Codex/OpenCode tool calls hold
 * the session through the harness lease instead.
 */
export const DEFAULT_SESSION_STALE_TURN_NO_WORK_MINUTES = 30;

export interface HarnessWorkConfig {
  leaseMs: number;
  maxDurationMs: number;
}

export interface SessionIdlenessActivityState {
  activity?: string | null;
  /** Last-REPORT clock: same-turn re-reports move it. Never an idleness anchor on its own. */
  activityAt?: number | null;
  promptStartedAt?: number | null;
  /** Last real-work clock (`project-data/session-work-clock.ts`). */
  workAt?: number | null;
  /** The VM's own latest turn start; grows only when a new prompt starts. */
  reportedPromptStartedAt?: number | null;
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
  | 'completed_prompt_stale'
  | 'prompt_turn_stale';

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

  // Bound protection by real work across both foreground turns and harness
  // progress. A partial/older reporter without a progress field still has the
  // persisted work clock; heartbeat receipt must never renew this ceiling.
  const progressAnchor = sessionWorkAnchor(state);
  if (progressAnchor === null) return null;
  const ceiling = progressAnchor + maxDurationMs;
  if (ceiling <= now.getTime()) return null;

  return new Date(Math.min(expiresAt, ceiling));
}

/**
 * When the session last did real work. `workAt` is the work clock; rows written before
 * it existed fall back to the turn start or harness progress, then the last report
 * only when no real-work anchor exists. Harness progress counts as work too.
 */
export function sessionWorkAnchor(state: SessionIdlenessActivityState | null): number | null {
  if (!state) return null;
  const positive = (value: number | null | undefined): number | null =>
    typeof value === 'number' && value > 0 ? value : null;
  const work = positive(state.workAt) ?? positive(state.promptStartedAt);
  const progress = positive(state.runtimeWorkProgressAt);
  if (work === null) return progress ?? positive(state.activityAt);
  return progress === null ? work : Math.max(work, progress);
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
 * Sleep and completed/failed-task ledger cleanup use this predicate. Converting the remaining shutdown
 * timers (ProjectData idle cleanup, workspace idle timeout) onto it is tracked
 * as a follow-up in idea `01M08VJDHK3MNYMZCQF5AJC17P`; they still use
 * schedule/workspace-activity candidate selection plus `classifyTaskRuntimeLiveness()`.
 */
export function classifySessionIdleness(input: {
  taskStatus: string | null;
  taskCompletedAt?: string | null;
  state: SessionIdlenessActivityState | null;
  now: Date;
  idleAfterMs: number;
  harnessWorkConfig: HarnessWorkConfig;
  policy: SessionIdlenessPolicy;
  /**
   * How long an open turn on a non-terminal task may go without real work before it no longer
   * counts as one (`operations.sessionStaleTurnNoWorkMinutes`). Omitted or null: unbounded.
   */
  staleTurnMs?: number | null;
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

  // Terminal tasks whose conversation is kept by sleep (completed, and failed —
  // see `SLEEP_PRESERVED_TERMINAL_TASK_STATUSES`) can retain a stale `prompting`
  // transition forever. Treat that state as idle only after the normal idle
  // interval has elapsed, so a final response is preserved but old terminal
  // sessions cannot strand compute.
  const sleepPreservedTerminalTask = isSleepPreservedTerminalTaskStatus(input.taskStatus);
  if (sleepPreservedTerminalTask && activity !== 'idle') {
    // complete_task runs inside the prompt: an hours-old prompting transition
    // does not mean the response following that tool has already drained. The
    // drain follows real work for a failed task too: an agent still working after
    // the failure would otherwise be slept mid-turn, and `sleepWorkspaceSession`
    // aborts on every work change, spending the retry budget.
    //
    // The anchor is the WORK clock, never `activityAt`: the VM agent re-reports an
    // open turn every minute and each report moves `activityAt`, so a turn that never
    // returns would keep the drain open forever (.claude/rules/53). Persisted
    // messages move the work clock, so an agent still writing after complete_task
    // keeps draining.
    const completedAt = Date.parse(input.taskCompletedAt ?? '');
    const drainAnchor = Math.max(
      sessionWorkAnchor(input.state) ?? 0,
      Number.isFinite(completedAt) ? completedAt : 0
    );
    if (!drainAnchor) {
      return {
        idle: false,
        conclusive: false,
        reason: 'prompt_turn_unknown',
        activity,
      };
    }
    // Silence is bounded by the idle interval. A Claude Code foreground Bash call is capped
    // at 10 min (SAM does not raise BASH_MAX_TIMEOUT_MS), background tasks and Codex /
    // OpenCode tool calls hold the session as harness work, and the sleep keeps a snapshot.
    const eligibleAt = drainAnchor + input.idleAfterMs;
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
    // A turn that never returns keeps reporting `prompting` (production 2026-11-04: a
    // conversation's turn ran 9h54m with no output, idea 01M6K6QTEE7T9KNYB7317D7Y8E). The VM's
    // own SessionHost confirms it, so the stale-activity probe cannot end it either. Bound it by
    // the WORK clock, which same-turn re-reports and probe confirmations do not move: no message
    // and no harness progress for the bound means nothing is coming back (policy d08d64dc). A
    // fresh harness lease already returned above, so live background work is never cut short.
    const workAnchor = sessionWorkAnchor(input.state);
    if (input.staleTurnMs && input.staleTurnMs > 0 && workAnchor !== null) {
      const silenceMs =
        input.policy === 'idle-interval-elapsed'
          ? Math.max(input.staleTurnMs, input.idleAfterMs)
          : input.staleTurnMs;
      if (workAnchor + silenceMs <= input.now.getTime()) {
        return { idle: true, conclusive: true, reason: 'prompt_turn_stale', activity };
      }
    }
    return {
      idle: false,
      conclusive: true,
      reason: 'prompt_turn_active',
      activity,
    };
  }

  // The prompt turn has ended and no runtime work holds a lease. That is the
  // whole safety question, so a teardown gate or an explicit user-initiated
  // sleep stops here. A sleep-preserved terminal task is also always
  // immediately reclaimable. `cancelled` is not: its runtime is torn down
  // directly by the terminal cleanup, never slept.
  if (input.policy === 'prompt-turn-ended' || sleepPreservedTerminalTask) {
    return {
      idle: true,
      conclusive: true,
      reason: 'idle',
      activity,
    };
  }

  // Automatic sleep additionally waits out the idle interval. A missing
  // work anchor means we cannot tell how long the session has been idle, so
  // the unattended scheduler declines to reclaim it (a user can still sleep it
  // explicitly, which takes the `prompt-turn-ended` branch above).
  // Same-state reports renew liveness, never the unattended idle deadline.
  const workAnchor = sessionWorkAnchor(input.state);
  const idleEligibleAt = workAnchor === null ? null : workAnchor + input.idleAfterMs;
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
