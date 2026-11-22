/**
 * Detect a runtime isolate that is stuck over its V8 heap limit, from the sweeps' own failures.
 *
 * On a self-hosted box (celld 0.6.3) one cell isolate holds the scheduled handler, the KV
 * namespace, the D1 databases and the Durable Objects, and it is never retired while it holds a
 * cell. Once its heap passes the limit, celld refuses to materialise SQL result sets in it until
 * used heap falls under 75% of the limit. SAM's bundle alone keeps the idle heap near that line
 * at the default 128 MB, so the refusal can last until the process restarts: on 2026-11-21 every
 * KV read from the cron failed for 33 hours (idea 01M7W6ZTZETXE75N8NRKR3R0CF). Failed-sweep
 * notifications read KV too, so nothing told anyone.
 *
 * This module therefore uses no KV. Each operational tick it counts sweeps that failed with
 * celld's refusal, keeps a count of consecutive ticks with such a failure, and records every
 * affected tick in log + platform_errors (D1, which still answers). The count lives in module
 * scope on purpose: it is the state of the isolate that runs the cron, which is exactly what is
 * being measured, and it resets on the first clean tick (`.claude/rules/61`).
 *
 * Recovery is the box's: `deploy/selfhost/celld/start.sh` reads celld's output and restarts celld
 * once `consecutiveTicks` reaches SAM_CELLD_HEAP_RESTART_TICKS. On Cloudflare the refusal text
 * never occurs, so nothing here fires.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { persistError } from '../services/observability';
import type { SweepFailure } from './sweep-isolation';

/** celld's refusal (js/harness.js `toArray`): the condition itself, not a proxy for it. */
export const ISOLATE_HEAP_LIMIT_MARKER = 'over its V8 heap limit';

/** The event start.sh restarts celld on. Changing it breaks the box's recovery. */
export const ISOLATE_HEAP_LIMIT_EVENT = 'cron.isolate_heap_limit';

let consecutiveTicks = 0;

export interface IsolateHeapLimitReport {
  /** Sweeps that failed this tick with the heap refusal. */
  sweeps: string[];
  /** Consecutive operational ticks with at least one such failure, this one included. */
  consecutiveTicks: number;
}

type HeapLimitEnv = Pick<
  Env,
  | 'OBSERVABILITY_DATABASE'
  | 'OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_STACK_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH'
>;

/** Call once per operational tick, after every sweep has run. Never throws. */
export async function reportIsolateHeapLimitFailures(
  env: HeapLimitEnv,
  failures: readonly SweepFailure[]
): Promise<IsolateHeapLimitReport> {
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
  try {
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message:
          `The isolate running scheduled work is over its V8 heap limit: ${sweeps.length} ` +
          `sweep(s) failed on ${consecutiveTicks} consecutive tick(s). On a self-hosted box ` +
          'celld restarts after SAM_CELLD_HEAP_RESTART_TICKS such ticks.',
        context: { recoveryType: 'isolate_heap_limit', consecutiveTicks, sweeps },
      },
      env
    );
  } catch (err) {
    log.error('cron.isolate_heap_limit_persist_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { sweeps, consecutiveTicks };
}

/** Test seam: a fresh isolate starts at zero. */
export function resetIsolateHeapLimitStateForTest(): void {
  consecutiveTicks = 0;
}
