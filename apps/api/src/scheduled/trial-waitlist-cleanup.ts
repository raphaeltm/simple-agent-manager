/**
 * Cron handler: daily trial_waitlist purge.
 *
 * Runs on the `TRIAL_CRON_WAITLIST_CLEANUP` schedule (default: daily
 * at 04:00 UTC). Deletes rows whose `notified_at` is older than
 * `TRIAL_WAITLIST_PURGE_DAYS` (default: 30). Rows that have not yet
 * been notified are preserved regardless of age — the monthly
 * notifier cron will eventually flip `notified_at`.
 *
 * Returns a summary for the `cron.completed` log message.
 */
import { and, isNotNull, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { resolveWaitlistPurgeDays } from '../services/trial/helpers';

export interface TrialWaitlistCleanupResult {
  purged: number;
}

export async function runTrialWaitlistCleanup(
  env: Env,
  now: number = Date.now()
): Promise<TrialWaitlistCleanupResult> {
  const db = drizzle(env.DATABASE, { schema });
  const purgeDays = resolveWaitlistPurgeDays(env);
  const threshold = now - purgeDays * 24 * 60 * 60 * 1000;

  // Select first so we can report a precise count (D1 drivers vary on
  // affected-row reporting; counting IDs is reliable).
  const candidates = await db
    .select({ id: schema.trialWaitlist.id })
    .from(schema.trialWaitlist)
    .where(
      and(
        isNotNull(schema.trialWaitlist.notifiedAt),
        lt(schema.trialWaitlist.notifiedAt, threshold)
      )
    )
    .limit(5000);

  if (candidates.length === 0) return { purged: 0 };

  // Batch delete. `inArray` here would re-import; use a loop with a single
  // predicate on a stable boundary instead — simpler and avoids an extra
  // 5000-element IN list.
  await db
    .delete(schema.trialWaitlist)
    .where(
      and(
        isNotNull(schema.trialWaitlist.notifiedAt),
        lt(schema.trialWaitlist.notifiedAt, threshold)
      )
    );

  return { purged: candidates.length };
}
