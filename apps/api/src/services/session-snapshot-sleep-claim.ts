/**
 * The sleep claim: the D1 compare-and-set that hands one owner a session's sleep
 * attempt (`preparing`) or the roll-forward of an interrupted teardown
 * (`stopping`). Split out of `session-snapshot-sleep-lifecycle.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { blockedSleepEpisodeSql } from './session-sleep-episode';
import {
  DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
  type SessionSnapshotSleepClaim,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SnapshotLeaseEnv = Env & {
  SESSION_SLEEP_CLAIM_LEASE_MS?: string;
  SESSION_SLEEP_MAX_ATTEMPTS?: string;
};

function sessionSleepClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
  );
}

export async function claimSessionSnapshotSleep(
  db: Db,
  env: Env,
  input: {
    chatSessionId: string;
    claimId: string;
    now?: Date;
    /**
     * Claim now, whatever the retry schedule says: an explicit sleep, or the Instant
     * container's own idle sleep.
     */
    force?: boolean;
    /**
     * A person asked for this sleep. Only such a claim may reopen an episode that ended
     * blocked, and it starts a fresh one. Every automatic claim, including the Instant
     * container's idle sleep (`VmAgentContainer.markRuntimeSleeping`), leaves a blocked
     * episode for the person to act on (`session-sleep-episode.ts`).
     */
    reopenBlockedEpisode?: boolean;
  }
): Promise<SessionSnapshotSleepClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - sessionSleepClaimLeaseMs(env)).toISOString();
  const maxAttempts = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const snapshots = schema.sessionSnapshots;
  const blockedEpisode = sql`${sql.raw(blockedSleepEpisodeSql('session_snapshots'))}`;
  const dueCondition = input.force
    ? or(
        isNull(snapshots.sleepStatus),
        inArray(snapshots.sleepStatus, ['scheduled', 'failed']),
        input.reopenBlockedEpisode ? blockedEpisode : undefined
      )
    : or(
        and(
          inArray(snapshots.sleepStatus, ['scheduled', 'failed']),
          lte(snapshots.sleepAfter, nowIso)
        ),
        // Legacy rows exhausted before the bounded episode existed stay re-armable by
        // raising `SESSION_SLEEP_MAX_ATTEMPTS`.
        and(
          eq(snapshots.sleepStatus, 'failed'),
          isNull(snapshots.sleepAfter),
          lt(snapshots.sleepAttempts, maxAttempts)
        )
      );
  // A final verified snapshot is produced inside sleepWorkspaceSession. Pending,
  // degraded, and failed captures must therefore remain claimable; requiring an
  // already-perfect snapshot here strands precisely the sessions the final
  // capture is meant to repair. Explicit sleep may also replace expired state.
  // How many failures the episode may spend is decided by the caller from the
  // persisted episode (`sessionSleepEpisodePhase`), not by this claim.
  const claimableSnapshotCondition = inArray(
    snapshots.status,
    input.force
      ? ['pending', 'available', 'degraded', 'failed', 'expired']
      : ['pending', 'available', 'degraded', 'failed']
  );
  const staleClaim = and(
    eq(snapshots.sleepStatus, 'preparing'),
    or(isNull(snapshots.sleepClaimedAt), lte(snapshots.sleepClaimedAt, staleBefore))
  );
  const result = await db
    .update(snapshots)
    .set({
      sleepStatus: 'preparing',
      sleepAfter: null,
      sleepClaimId: input.claimId,
      sleepClaimedAt: nowIso,
      sleepAttempts: sql`${snapshots.sleepAttempts} + 1`,
      sleepError: null,
      // The episode clock starts at the first claim and is never moved by a later one.
      // SQLite evaluates SET expressions against the row as it was before this update.
      sleepEpisodeStartedAt: sql`CASE WHEN ${blockedEpisode} THEN ${nowIso}
        ELSE COALESCE(${snapshots.sleepEpisodeStartedAt}, ${nowIso}) END`,
      // Re-claiming a stale `preparing` claim means the previous attempt never reported
      // back (a crashed or killed Worker): it counts as a failed attempt, so a crash loop
      // spends the same bounded budget as a reported failure.
      sleepEpisodeFailures: sql`CASE WHEN ${blockedEpisode} THEN 0
        WHEN ${snapshots.sleepStatus} = 'preparing' THEN COALESCE(${snapshots.sleepEpisodeFailures}, 0) + 1
        ELSE COALESCE(${snapshots.sleepEpisodeFailures}, 0) END`,
      sleepFallbackJson: sql`CASE WHEN ${blockedEpisode} THEN NULL
        ELSE ${snapshots.sleepFallbackJson} END`,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(snapshots.chatSessionId, input.chatSessionId),
        claimableSnapshotCondition,
        isNull(snapshots.sleepingAt),
        or(dueCondition, staleClaim)
      )
    );
  if ((result.meta.changes ?? 0) > 0) {
    return { status: 'claimed', claimId: input.claimId, phase: 'preparing' };
  }

  // `stopping` is the point of no return: a crashed owner is reclaimed and
  // rolled forward without consuming the pre-teardown retry budget.
  const stopping = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepClaimId: input.claimId,
      sleepClaimedAt: nowIso,
      sleepStoppingSince: sql`COALESCE(${schema.sessionSnapshots.sleepStoppingSince}, ${schema.sessionSnapshots.sleepClaimedAt}, ${schema.sessionSnapshots.updatedAt}, ${schema.sessionSnapshots.createdAt}, ${nowIso})`,
      sleepAfter: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
        or(
          lte(schema.sessionSnapshots.sleepAfter, nowIso),
          isNull(schema.sessionSnapshots.sleepClaimedAt),
          lte(schema.sessionSnapshots.sleepClaimedAt, staleBefore)
        )
      )
    );
  if ((stopping.meta.changes ?? 0) > 0) {
    return { status: 'claimed', claimId: input.claimId, phase: 'stopping' };
  }

  const snapshot = await db
    .select({
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepClaimId: schema.sessionSnapshots.sleepClaimId,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .get();
  if (snapshot?.sleepClaimId === input.claimId && snapshot.sleepStatus === 'preparing') {
    return { status: 'claimed', claimId: input.claimId, phase: 'preparing' };
  }
  if (snapshot?.sleepClaimId === input.claimId && snapshot.sleepStatus === 'stopping') {
    return { status: 'claimed', claimId: input.claimId, phase: 'stopping' };
  }
  const reason = !snapshot
    ? 'snapshot_missing'
    : snapshot.sleepingAt
      ? 'already_sleeping'
      : snapshot.status !== 'available' && snapshot.status !== 'degraded'
        ? 'snapshot_not_complete'
        : 'sleep_claim_unavailable';
  return { status: 'unavailable', reason };
}
