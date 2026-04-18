/**
 * Cron handler: monthly rollover audit.
 *
 * Runs on the `TRIAL_CRON_ROLLOVER_CRON` schedule (default: first of
 * the month at 03:00 UTC). Two responsibilities:
 *
 *   1. Prune old counter rows from the TrialCounter DO's SQLite so the
 *      DO's storage footprint stays bounded. Retention is controlled by
 *      TRIAL_COUNTER_KEEP_MONTHS.
 *   2. Verify that the DO's current month key matches the Worker's
 *      current month key; log a warning otherwise (drift indicates a
 *      timezone misconfiguration — the cap would be mis-applied).
 *
 * Returns a summary for the `cron.completed` log message.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  currentMonthKey,
  getTrialCounterStub,
  resolveCounterKeepMonths,
  shiftMonthKey,
} from '../services/trial/helpers';

export interface TrialRolloverResult {
  monthKey: string;
  pruned: number;
}

interface CounterRpc {
  prune(keepMonthKey: string): Promise<number>;
  get(monthKey: string): Promise<{ monthKey: string; count: number }>;
}

export async function runTrialRolloverAudit(
  env: Env,
  now: number = Date.now()
): Promise<TrialRolloverResult> {
  const monthKey = currentMonthKey(now);
  const keepMonths = resolveCounterKeepMonths(env);
  // Keep `keepMonths` rows: the current month plus (keepMonths - 1) prior.
  // Prune everything strictly older than `oldestKept`.
  const oldestKept = shiftMonthKey(monthKey, -(keepMonths - 1));

  try {
    const stub = getTrialCounterStub(env) as unknown as CounterRpc;
    const pruned = await stub.prune(oldestKept);
    // Sanity check — fetch the current month; no action on mismatch, just log.
    const state = await stub.get(monthKey);
    if (state.monthKey !== monthKey) {
      log.warn('trial.rollover.monthKey_drift', {
        expected: monthKey,
        actual: state.monthKey,
      });
    }
    return { monthKey, pruned };
  } catch (err) {
    log.error('trial.rollover.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { monthKey, pruned: 0 };
  }
}
