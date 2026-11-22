/**
 * The part of the heap-limit detector that `deploy/selfhost/celld/start.sh` depends on: celld's
 * refusal text, the event name, and the line the cron logs. Kept free of Worker-only imports so
 * the self-host live tests can drive the real emitter (scripts/selfhost/live/). The D1 record and
 * the wiring live in `isolate-heap-limit.ts`.
 */
import { log } from '@simple-agent-manager/worker-core';

/** celld's refusal (js/harness.js `toArray`): the condition itself, not a proxy for it. */
export const ISOLATE_HEAP_LIMIT_MARKER = 'over its V8 heap limit';

/** The event start.sh restarts celld on. Changing it breaks the box's recovery. */
export const ISOLATE_HEAP_LIMIT_EVENT = 'cron.isolate_heap_limit';

/** One sweep that threw this tick (`SweepIsolator.failures()`). */
export interface HeapLimitSweepFailure {
  sweep: string;
  error: string;
}

export interface IsolateHeapLimitReport {
  /** Sweeps that failed this tick with the heap refusal. */
  sweeps: string[];
  /** Consecutive operational ticks with at least one such failure, this one included. */
  consecutiveTicks: number;
}

let consecutiveTicks = 0;

/**
 * Count one operational tick and log it when any sweep hit the refusal. The count lives in module
 * scope on purpose: it is the state of the isolate that runs the cron, which is what is being
 * measured, and it resets on the first clean tick (`.claude/rules/61`).
 */
export function countIsolateHeapLimitTick(
  failures: readonly HeapLimitSweepFailure[]
): IsolateHeapLimitReport {
  const sweeps = failures
    .filter((failure) => failure.error.includes(ISOLATE_HEAP_LIMIT_MARKER))
    .map((failure) => failure.sweep);
  if (sweeps.length === 0) {
    consecutiveTicks = 0;
    return { sweeps, consecutiveTicks };
  }
  consecutiveTicks += 1;
  // One line, flat fields: start.sh matches the event name and reads consecutiveTicks from it.
  log.error(ISOLATE_HEAP_LIMIT_EVENT, { consecutiveTicks, sweepCount: sweeps.length, sweeps });
  return { sweeps, consecutiveTicks };
}

/** Test seam: a fresh isolate starts at zero. */
export function resetIsolateHeapLimitStateForTest(): void {
  consecutiveTicks = 0;
}
