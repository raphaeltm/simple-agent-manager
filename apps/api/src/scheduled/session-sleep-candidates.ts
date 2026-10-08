/**
 * Candidate selection for the session-sleep sweep (`runSessionSleepSweep`). Split out
 * of `session-sleep.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { sessionSleepInFlightMaxAgeMs } from '../services/session-snapshot-sleep-predicate';
import { DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS } from '../services/session-snapshots';

function claimLeaseCutoff(env: Env, now: Date): string {
  return new Date(
    now.getTime() -
      parsePositiveInt(
        (env as Env & { SESSION_SLEEP_CLAIM_LEASE_MS?: string }).SESSION_SLEEP_CLAIM_LEASE_MS,
        DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
      )
  ).toISOString();
}

/**
 * Due sleep intents. A failed attempt always carries a retry deadline inside a bounded
 * episode, so no clause selects a failure regardless of attempts any more: the former
 * "repairable capture" clause is what let a permanently degraded session retry forever.
 */
export function selectSweepCandidates(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  now: Date,
  batchSize: number,
  maxAttempts: number
) {
  const nowIso = now.toISOString();
  const staleClaim = claimLeaseCutoff(env, now);
  const snapshots = schema.sessionSnapshots;
  return db
    .select({
      snapshotId: snapshots.id,
      workspaceId: snapshots.workspaceId,
      userId: snapshots.userId,
      chatSessionId: snapshots.chatSessionId,
      sleepAttempts: snapshots.sleepAttempts,
      sleepStatus: snapshots.sleepStatus,
      sleepAfter: snapshots.sleepAfter,
      sleepClaimId: snapshots.sleepClaimId,
      sleepClaimedAt: snapshots.sleepClaimedAt,
      sleepError: snapshots.sleepError,
      sleepEpisodeStartedAt: snapshots.sleepEpisodeStartedAt,
      sleepEpisodeFailures: snapshots.sleepEpisodeFailures,
      updatedAt: snapshots.updatedAt,
      status: snapshots.status,
      captureGeneration: snapshots.captureGeneration,
      workspaceStatus: schema.workspaces.status,
    })
    .from(snapshots)
    .leftJoin(schema.workspaces, eq(schema.workspaces.id, snapshots.workspaceId))
    .where(
      and(
        inArray(snapshots.status, ['pending', 'available', 'degraded', 'failed']),
        isNull(snapshots.sleepingAt),
        or(
          and(
            inArray(snapshots.sleepStatus, ['scheduled', 'failed']),
            lte(snapshots.sleepAfter, nowIso)
          ),
          // Legacy rows exhausted before bounded episodes existed: re-armed only by
          // raising `SESSION_SLEEP_MAX_ATTEMPTS`.
          and(
            eq(snapshots.sleepStatus, 'failed'),
            isNull(snapshots.sleepAfter),
            lt(snapshots.sleepAttempts, maxAttempts)
          ),
          and(
            eq(snapshots.sleepStatus, 'preparing'),
            or(isNull(snapshots.sleepClaimedAt), lte(snapshots.sleepClaimedAt, staleClaim))
          ),
          and(
            eq(snapshots.sleepStatus, 'stopping'),
            // Past this immutable age, lifecycle repair owns convergence.
            gt(
              sql`COALESCE(${snapshots.sleepStoppingSince}, ${snapshots.sleepClaimedAt}, ${snapshots.updatedAt}, ${snapshots.createdAt})`,
              new Date(now.getTime() - sessionSleepInFlightMaxAgeMs(env)).toISOString()
            ),
            or(
              lte(snapshots.sleepAfter, nowIso),
              isNull(snapshots.sleepClaimedAt),
              lte(snapshots.sleepClaimedAt, staleClaim)
            )
          )
        )
      )
    )
    .orderBy(snapshots.sleepAfter, snapshots.id)
    .limit(batchSize);
}
