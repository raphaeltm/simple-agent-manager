import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  sessionLifecycleError,
} from './session-snapshot-artifacts';

export const TERMINAL_SESSION_SLEEP_STATUS = 'terminal_failed';

function isTerminalPostSleepCaptureError(error: string): boolean {
  return (
    error.includes(
      'resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)'
    ) || error.includes('Workspace cannot sleep from status stopped')
  );
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Record a failed sleep attempt that never crossed the point of no return.
 *
 * Every failure counts against the bounded episode (`session-sleep-episode.ts`) and keeps
 * a due retry: the sweep then either retries, falls back to a transcript-and-Git sleep, or
 * ends the episode blocked. A degraded capture or a capture still in flight is no longer
 * exempt from the budget — that exemption is what let a permanently degraded session
 * retry every few minutes forever. The terminal post-capture errors (the workspace was
 * stopped underneath the sleep) still end the episode at once.
 */
export async function failSessionSnapshotSleepBeforeTeardown(
  db: Db,
  env: Env,
  chatSessionId: string,
  claimId: string,
  error: string,
  now = new Date()
): Promise<boolean> {
  const retryDelayMs = parsePositiveInt(
    env.SESSION_SLEEP_RETRY_DELAY_MS,
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
  );
  const terminal = isTerminalPostSleepCaptureError(error);
  const nowIso = now.toISOString();
  const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: terminal ? TERMINAL_SESSION_SLEEP_STATUS : 'failed',
      sleepAfter: terminal ? null : retryAt,
      sleepError: sessionLifecycleError(env, error),
      sleepEpisodeFailures: sql`COALESCE(${schema.sessionSnapshots.sleepEpisodeFailures}, 0) + 1`,
      // A claim always stamps the episode start; the fallbacks cover rows claimed by a
      // deployment that predates the column.
      sleepEpisodeStartedAt: sql`COALESCE(${schema.sessionSnapshots.sleepEpisodeStartedAt}, ${schema.sessionSnapshots.sleepClaimedAt}, ${nowIso})`,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
        eq(schema.sessionSnapshots.sleepClaimId, claimId)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}
