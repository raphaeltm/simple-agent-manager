import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { sleepWorkspaceSession } from '../services/session-sleep';
import {
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS,
  failSessionSnapshotSleepBeforeTeardown,
  sessionLifecycleError,
} from '../services/session-snapshots';

export const DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE = 10;
export const DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS = 3;

export interface SessionSleepSweepStats {
  selected: number;
  claimed: number;
  slept: number;
  failed: number;
  exhausted: number;
}

/**
 * Claim and sleep a bounded page of idle sessions. The claim is a D1 CAS so
 * overlapping cron invocations cannot tear down the same runtime twice.
 */
export async function runSessionSleepSweep(
  env: Env,
  now = new Date()
): Promise<SessionSleepSweepStats> {
  const db = drizzle(env.DATABASE, { schema });
  const batchSize = parsePositiveInt(
    env.SESSION_SLEEP_SWEEP_BATCH_SIZE,
    DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE
  );
  const maxAttempts = parsePositiveInt(
    env.SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const stats: SessionSleepSweepStats = {
    selected: 0,
    claimed: 0,
    slept: 0,
    failed: 0,
    exhausted: 0,
  };

  const candidates = await db
    .select({
      snapshotId: schema.sessionSnapshots.id,
      workspaceId: schema.sessionSnapshots.workspaceId,
      userId: schema.sessionSnapshots.userId,
      chatSessionId: schema.sessionSnapshots.chatSessionId,
      sleepAttempts: schema.sessionSnapshots.sleepAttempts,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepAfter: schema.sessionSnapshots.sleepAfter,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none'),
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          and(
            inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed']),
            lte(schema.sessionSnapshots.sleepAfter, now.toISOString())
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
            or(
              isNull(schema.sessionSnapshots.sleepClaimedAt),
              lte(
                schema.sessionSnapshots.sleepClaimedAt,
                new Date(
                  now.getTime() -
                    parsePositiveInt(
                      (env as Env & { SESSION_SLEEP_CLAIM_LEASE_MS?: string })
                        .SESSION_SLEEP_CLAIM_LEASE_MS,
                      DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
                    )
                ).toISOString()
              )
            )
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
            or(
              lte(schema.sessionSnapshots.sleepAfter, now.toISOString()),
              isNull(schema.sessionSnapshots.sleepClaimedAt),
              lte(
                schema.sessionSnapshots.sleepClaimedAt,
                new Date(
                  now.getTime() -
                    parsePositiveInt(
                      (env as Env & { SESSION_SLEEP_CLAIM_LEASE_MS?: string })
                        .SESSION_SLEEP_CLAIM_LEASE_MS,
                      DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
                    )
                ).toISOString()
              )
            )
          )
        )
      )
    )
    .orderBy(schema.sessionSnapshots.sleepAfter, schema.sessionSnapshots.id)
    .limit(batchSize);
  stats.selected = candidates.length;

  for (const candidate of candidates) {
    if (
      !candidate.workspaceId ||
      (candidate.sleepStatus !== 'stopping' && candidate.sleepAttempts >= maxAttempts)
    ) {
      await db
        .update(schema.sessionSnapshots)
        .set({
          sleepStatus: 'failed',
          sleepAfter: null,
          sleepError: candidate.workspaceId
            ? 'Automatic sleep retry budget exhausted'
            : 'Snapshot has no source workspace',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.sessionSnapshots.id, candidate.snapshotId));
      stats.exhausted++;
      continue;
    }
    const claimId = crypto.randomUUID();
    const claim = await claimSessionSnapshotSleep(db, env, {
      chatSessionId: candidate.chatSessionId,
      claimId,
      now,
    });
    if (claim.status !== 'claimed') continue;
    stats.claimed++;

    try {
      await sleepWorkspaceSession(env, {
        workspaceId: candidate.workspaceId,
        userId: candidate.userId,
        reason: 'Idle timeout elapsed',
        sleepClaimId: claimId,
      });
      stats.slept++;
    } catch (error) {
      const attempts = candidate.sleepAttempts + 1;
      const exhausted = attempts >= maxAttempts;
      await failSessionSnapshotSleepBeforeTeardown(
        db,
        env,
        candidate.chatSessionId,
        claimId,
        sessionLifecycleError(env, error)
      );
      stats.failed++;
      if (exhausted) stats.exhausted++;
      log.warn('session_sleep_sweep.failed', {
        snapshotId: candidate.snapshotId,
        workspaceId: candidate.workspaceId,
        chatSessionId: candidate.chatSessionId,
        attempts,
        exhausted,
        error: sessionLifecycleError(env, error),
      });
    }
  }

  return stats;
}
