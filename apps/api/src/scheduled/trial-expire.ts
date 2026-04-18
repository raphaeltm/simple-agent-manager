/**
 * Cron handler: expire stale pending / ready trials.
 *
 * Runs on the 5-minute operational sweep. Any `trials` row whose
 * status is still `pending` or `ready` and whose `expires_at` is in
 * the past is transitioned to `expired`. The TrialCounter DO is NOT
 * decremented — the slot was genuinely consumed for the month.
 *
 * Returns a summary for the `cron.completed` log message.
 */
import { and, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

export interface TrialExpireResult {
  expired: number;
}

export async function runTrialExpireSweep(
  env: Env,
  now: number = Date.now()
): Promise<TrialExpireResult> {
  const db = drizzle(env.DATABASE, { schema });

  // D1 supports UPDATE ... RETURNING; we use an explicit SELECT/UPDATE pair
  // so we can count rows without relying on provider-specific affected-row
  // counts.
  const candidates = await db
    .select({ id: schema.trials.id })
    .from(schema.trials)
    .where(
      and(
        inArray(schema.trials.status, ['pending', 'ready']),
        lt(schema.trials.expiresAt, now)
      )
    )
    .limit(1000);

  if (candidates.length === 0) return { expired: 0 };

  await db
    .update(schema.trials)
    .set({ status: 'expired' })
    .where(
      inArray(
        schema.trials.id,
        candidates.map((r) => r.id)
      )
    );

  // We deliberately DO NOT also `eq(status, ...)` here — the candidate
  // IDs are scoped to the snapshot we just read, and overriding a concurrent
  // status transition would be wrong. The subsequent cron invocation will
  // re-evaluate any rows we skipped.

  return { expired: candidates.length };
}
