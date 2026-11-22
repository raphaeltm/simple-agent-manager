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
 * This module therefore uses no KV. Each operational tick `isolate-heap-limit-core.ts` counts
 * sweeps that failed with celld's refusal and the consecutive ticks with such a failure, and logs
 * the line start.sh reads; this file adds the platform_errors record (D1, which still answers).
 *
 * Recovery is the box's: `deploy/selfhost/celld/start.sh` reads celld's output and restarts celld
 * once `consecutiveTicks` reaches SAM_CELLD_HEAP_RESTART_TICKS. On Cloudflare the refusal text
 * never occurs, so nothing here fires.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { persistError } from '../services/observability';
import { countIsolateHeapLimitTick, type IsolateHeapLimitReport } from './isolate-heap-limit-core';
import type { SweepFailure } from './sweep-isolation';

export {
  ISOLATE_HEAP_LIMIT_EVENT,
  ISOLATE_HEAP_LIMIT_MARKER,
  type IsolateHeapLimitReport,
  resetIsolateHeapLimitStateForTest,
} from './isolate-heap-limit-core';

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
  const report = countIsolateHeapLimitTick(failures);
  if (report.sweeps.length === 0) return report;
  const { sweeps, consecutiveTicks } = report;
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
  return report;
}
