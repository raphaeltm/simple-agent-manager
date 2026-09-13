import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
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
  const maxAttempts = parsePositiveInt(
    env.SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const terminal = isTerminalPostSleepCaptureError(error);
  const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: terminal ? TERMINAL_SESSION_SLEEP_STATUS : 'failed',
      // Repairable captures may retry beyond the ordinary attempt budget, but
      // must still yield their queue slot until the persisted retry deadline.
      sleepAfter: terminal
        ? null
        : sql`CASE WHEN ${schema.sessionSnapshots.sleepAttempts} >= ${maxAttempts}
        AND ${schema.sessionSnapshots.status} != 'degraded'
        AND ${schema.sessionSnapshots.captureGeneration} IS NULL
        THEN NULL ELSE ${retryAt} END`,
      sleepError: sessionLifecycleError(env, error),
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: now.toISOString(),
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
