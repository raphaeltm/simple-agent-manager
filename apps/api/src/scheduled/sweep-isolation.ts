/**
 * Per-sweep error isolation for the scheduled cron handler.
 *
 * The 5-minute operational cron runs a dozen independent sweeps in sequence.
 * Before this module they were a flat list of bare `await`s, so the FIRST sweep
 * to throw silently suppressed every sweep after it — the handler unwound and
 * `cron.completed` never logged.
 *
 * That is not hypothetical. On 2026-08-05T20:25Z `runNodeCleanupSweep` began
 * failing in production and took the entire back half of the sweep with it:
 * node reaping, observability purge, trigger-execution cleanup, session-task
 * repair, setup-session sweep, compose-artifact cleanup, compute-usage cleanup,
 * trial expiry — and `runCronTriggerSweep`, so 21 active USER cron triggers
 * stopped firing for ~13 hours. Nodes accumulated until the shared Hetzner
 * account hit its server limit and staging deploys began failing with 403.
 *
 * An earlier change noticed the fragility and worked around it by REORDERING
 * one sweep ("Recover stuck tasks first so unrelated cleanup failures cannot
 * suppress lifecycle repair") rather than isolating them. Reordering only
 * protects whatever happens to run first; this module protects all of them.
 *
 * Contract: a sweep that throws is contained, recorded, and reported — it never
 * prevents another sweep from running.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { persistError } from '../services/observability';

export interface SweepFailure {
  sweep: string;
  error: string;
}

export interface SweepIsolator {
  /**
   * Run one sweep with its failure contained.
   *
   * Returns the sweep's result, or `undefined` when it threw. Callers treat
   * `undefined` as "no data from this sweep this tick" — it is deliberately not
   * a zero-valued result object, so a failed sweep is never mistaken in logs or
   * metrics for a sweep that ran and found nothing.
   */
  isolate<T>(sweep: string, fn: () => Promise<T>): Promise<T | undefined>;
  /** Names of sweeps that threw during this cron invocation, in failure order. */
  failedSweeps(): string[];
  /** Structured failures for this cron invocation. */
  failures(): SweepFailure[];
}

type IsolatorEnv = Pick<
  Env,
  | 'OBSERVABILITY_DATABASE'
  | 'OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_STACK_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH'
>;

export function createSweepIsolator(env: IsolatorEnv): SweepIsolator {
  const failures: SweepFailure[] = [];

  return {
    async isolate<T>(sweep: string, fn: () => Promise<T>): Promise<T | undefined> {
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ sweep, error: message });

        log.error('cron.sweep_failed', {
          sweep,
          error: message,
          stack: err instanceof Error ? err.stack : undefined,
        });

        // Durable record so a repeat of the 2026-08-05 outage is visible in
        // /admin/errors instead of only as an absence of downstream effects.
        // persistError is internally guarded, but this must not throw under any
        // circumstance — a failure to RECORD a failure must not abort the cron.
        try {
          await persistError(env.OBSERVABILITY_DATABASE, {
            source: 'api',
            level: 'error',
            message: `Scheduled sweep "${sweep}" failed: ${message}`,
            stack: err instanceof Error ? err.stack : undefined,
            context: { recoveryType: 'cron_sweep_failure', sweep },
          }, env);
        } catch (persistErr) {
          log.error('cron.sweep_failure_persist_failed', {
            sweep,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
        }

        return undefined;
      }
    },

    failedSweeps(): string[] {
      return failures.map((f) => f.sweep);
    },

    failures(): SweepFailure[] {
      return [...failures];
    },
  };
}
